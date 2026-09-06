const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const axios = require("axios");
const { OpenAI, toFile } = require("openai");

const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MENU_TEXT =
  "Welcome\nWhat do you want to do?\n" +
  "1. Check balance\n" +
  "2. Fund wallet\n" +
  "3. Send money\n" +
  "4. Beneficiaries\n" +
  "5. Transaction history\n" +
  "6. Account details\n" +
  "7. Verify bank account\n" +
  "8. Verify identity\n9. Help\n10. Create invoice"; +

// ---------------------------------------------------------------------
// PAYSTACK WEBHOOK
// ---------------------------------------------------------------------
app.post(
  "/api/paystack/webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];

      const expectedHash = crypto
        .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
        .update(req.body)
        .digest("hex");

      if (signature !== expectedHash) {
        console.log("PAYSTACK WEBHOOK: invalid signature");
        return res.sendStatus(401);
      }

      const event = JSON.parse(req.body.toString());
      console.log("PAYSTACK WEBHOOK EVENT:", event.event);

      if (event.event === "charge.success") {
        const reference = event.data.reference;
        const amountKobo = event.data.amount;
        const { data: invoice, error: invoiceLookupError } = await supabase
  .from("invoices")
  .select("*")
  .eq("payment_reference", reference)
  .maybeSingle();

if (invoice && invoice.status !== "paid") {
  await supabase
    .from("invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
    })
    .eq("id", invoice.id);

  await logSecurityEvent(
    invoice.business_identifier,
    "invoice_paid",
    0,
    {
      invoice_number: invoice.invoice_number,
      payment_reference: reference,
      amount_kobo: amountKobo,
    }
  );

  await sendMessage(
    invoice.business_identifier,
    `Invoice paid!\n\nInvoice: ${invoice.invoice_number}\nCustomer: ${invoice.customer_name}\nAmount received: N${(
      amountKobo / 100
    ).toFixed(2)}`
  );

  return res.sendStatus(200);
}

        const { data: pending, error: pendingError } = await supabase
          .from("pending_payments")
          .select("*")
          .eq("reference", reference)
          .single();

        console.log("PENDING PAYMENT LOOKUP:", {
          reference,
          pending,
          pendingError,
        });

        if (pending && pending.status !== "success") {
          const identifier = pending.whatsapp_number;

          const wallet = await getOrCreateWallet(identifier);
          const newBalance = wallet.balance_kobo + amountKobo;

          await supabase
            .from("wallets")
            .update({ balance_kobo: newBalance })
            .eq("whatsapp_number", identifier);

          await supabase
            .from("pending_payments")
            .update({ status: "success" })
            .eq("reference", reference);

          await logTransaction(
            identifier,
            "fund",
            amountKobo,
            null,
            reference
          );

          await sendMessage(
            identifier,
            `Payment confirmed! N${(amountKobo / 100).toFixed(
              2
            )} has been added to your wallet.`
          );
        } else {
          // Not a wallet-funding payment — check whether it's an invoice payment instead.
          const { data: invoice, error: invoiceError } = await supabase
            .from("invoices")
            .select("*")
            .eq("reference", reference)
            .single();

          console.log("INVOICE LOOKUP:", { reference, invoice, invoiceError });

          if (invoice && invoice.status !== "success") {
            await supabase
              .from("invoices")
              .update({ status: "success" })
              .eq("reference", reference);

            await sendMessage(
              invoice.created_by,
              `Invoice paid! ${invoice.customer_name} paid N${(amountKobo / 100).toFixed(2)} for "${invoice.description}".`
            );

            await sendMessage(
              invoice.customer_number,
              `Payment received — thank you, ${invoice.customer_name}!`
            );
          }
        }
      }

      return res.sendStatus(200);
    } catch (err) {
      console.log(
        "PAYSTACK WEBHOOK ERROR:",
        err.response ? err.response.data : err.message
      );

      return res.sendStatus(500);
    }
  }
);

// ---------------------------------------------------------------------
// BODY PARSERS
// ---------------------------------------------------------------------
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------------------------------------------------------------------
// PIN SAFETY — voice notes can never be used to enter a PIN
// ---------------------------------------------------------------------
function isPinState(state) {
  return (
    state === "awaiting_pin_setup" ||
    state.startsWith("awaiting_pin_confirm:") ||
    state.startsWith("awaiting_send_pin:")
  );
}

// ---------------------------------------------------------------------
// VOICE + IMAGE HELPERS
// ---------------------------------------------------------------------
async function transcribeAudioBuffer(buffer, filename) {
  const file = await toFile(buffer, filename);
  const transcription = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
  });
  return transcription.text.trim();
}

async function analyzeImageBuffer(buffer, mimeType) {
  const base64Image = buffer.toString("base64");

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Describe what is in this image in 1-2 short sentences, then clearly list any text, numbers, account numbers, amounts, or names visible in it. Keep it concise, formatted for a WhatsApp/Telegram chat message.",
          },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64Image}` },
          },
        ],
      },
    ],
  });

  return response.choices[0].message.content;
}

async function downloadTwilioMedia(url) {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN,
    },
  });
  return Buffer.from(response.data);
}

async function downloadTelegramFile(fileId) {
  const fileInfoResp = await axios.get(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile`,
    { params: { file_id: fileId } }
  );
  const filePath = fileInfoResp.data.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
  return Buffer.from(response.data);
}

// ---------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------
async function getOrCreateWallet(identifier) {
  const { data: wallet, error: findError } = await supabase
    .from("wallets")
    .select("*")
    .eq("whatsapp_number", identifier)
    .maybeSingle();

  if (findError) {
    console.log("WALLET LOOKUP ERROR:", findError);
  }

  if (wallet) {
    return wallet;
  }

  const { data: newWallet, error: insertError } = await supabase
    .from("wallets")
    .insert({
      whatsapp_number: identifier,
      balance_kobo: 0,
    })
    .select()
    .single();

  if (insertError) {
    console.log("WALLET CREATE ERROR:", insertError);
  }

  return newWallet || {
    whatsapp_number: identifier,
    balance_kobo: 0,
  };
}

async function logTransaction(
  identifier,
  type,
  amountKobo,
  counterparty,
  reference,
  riskScore = 0,
  riskReason = null,
  status = "completed"
) {
  const { error } = await supabase.from("transactions").insert({
    whatsapp_number: identifier,
    type,
    amount: amountKobo,
    counterparty,
    reference,
    risk_score: riskScore,
    risk_reason: riskReason,
    status,
  });

  console.log("TRANSACTION LOGGED:", {
    type,
    amountKobo,
    riskScore,
    status,
    error,
  });
}

async function setState(identifier, state) {
  const { error } = await supabase
    .from("users")
    .update({ conversation_state: state })
    .eq("whatsapp_number", identifier);

  if (error) {
    console.log("STATE UPDATE ERROR:", error);
  }
}

async function sendMessage(identifier, text) {
  if (identifier.startsWith("whatsapp:")) {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: identifier,
      body: text,
    });

    return;
  }

  if (identifier.startsWith("telegram:")) {
    const chatId = identifier.replace("telegram:", "");

    const response = await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: chatId,
        text,
      }
    );

    console.log("TELEGRAM MESSAGE SENT:", {
      chatId,
      ok: response.data.ok,
    });

    return;
  }

  console.log("SEND MESSAGE: unknown identifier format:", identifier);
}

// FIX: scoped to Nigeria/NGN explicitly so bank codes match what
// /bank/resolve expects.
async function getBankListText() {
  const banksResp = await axios.get("https://api.paystack.co/bank?country=nigeria&currency=NGN", {
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    },
  });

  return banksResp.data.data
    .slice(0, 15)
    .map((bank) => `${bank.code} - ${bank.name}`)
    .join("\n");
}

async function resolveBankAccount(accountNumber, bankCode) {
  const resolveResp = await axios.get(
    `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    }
  );

  return resolveResp.data.data.account_name;
}

async function createTransferRecipient(accountName, accountNumber, bankCode) {
  const resp = await axios.post(
    "https://api.paystack.co/transferrecipient",
    {
      type: "nuban",
      name: accountName,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    }
  );

  return resp.data.data.recipient_code;
}

async function initiatePaystackTransfer(
  recipientCode,
  amountKobo,
  reason,
  reference
) {
  const resp = await axios.post(
    "https://api.paystack.co/transfer",
    {
      source: "balance",
      amount: amountKobo,
      recipient: recipientCode,
      reason,
      reference,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    }
  );

  return resp.data.data;
}
// ---------------------------------------------------------------------
// FRAUD / SECURITY HELPERS
// ---------------------------------------------------------------------
async function logSecurityEvent(identifier, eventType, riskScore, details = {}) {
  const { error } = await supabase.from("security_events").insert({
    user_identifier: identifier,
    event_type: eventType,
    risk_score: riskScore,
    details,
  });

  if (error) {
    console.log("SECURITY EVENT ERROR:", error);
  }
}

async function getFraudCheck(identifier, amountKobo, recipient) {
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("whatsapp_number", identifier)
    .single();

  if (userError || !user) {
    return {
      allowed: false,
      score: 100,
      reason: "User account could not be validated.",
    };
  }

  if (user.is_transfer_blocked) {
    return {
      allowed: false,
      score: 100,
      reason: "Transfers are blocked on this account.",
    };
  }

  let riskScore = 0;
  const reasons = [];

  // Per-transfer limit
  const perTransferLimit =
    user.per_transfer_limit_kobo || 2000000; // Default: ₦20,000

  if (amountKobo > perTransferLimit) {
    riskScore += 70;
    reasons.push(
      `Amount is above the per-transfer limit of ₦${(
        perTransferLimit / 100
      ).toFixed(2)}`
    );
  }

  // Higher risk if BVN/NIN have not yet been verified
  if (!user.bvn_verified || !user.nin_verified) {
    riskScore += 25;
    reasons.push("Identity verification is incomplete");
  }

  // Transfers made in the past 10 minutes
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data: recentTransactions, error: recentError } = await supabase
    .from("transactions")
    .select("id, amount, created_at")
    .eq("whatsapp_number", identifier)
    .eq("type", "send")
    .gte("created_at", tenMinutesAgo);

  if (!recentError && recentTransactions && recentTransactions.length >= 3) {
    riskScore += 50;
    reasons.push("More than 3 transfer attempts in 10 minutes");
  }

  // Daily outgoing transfer total
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: todayTransactions, error: dailyError } = await supabase
    .from("transactions")
    .select("amount")
    .eq("whatsapp_number", identifier)
    .eq("type", "send")
    .gte("created_at", todayStart.toISOString());

  const amountSentToday = dailyError
    ? 0
    : (todayTransactions || []).reduce(
        (sum, transaction) => sum + Number(transaction.amount || 0),
        0
      );

  const dailyLimit =
    user.daily_transfer_limit_kobo || 5000000; // Default: ₦50,000

  if (amountSentToday + amountKobo > dailyLimit) {
    riskScore += 80;
    reasons.push(
      `Amount exceeds the daily limit of ₦${(dailyLimit / 100).toFixed(2)}`
    );
  }

  // Large transfer to a new recipient
  if (amountKobo >= 1000000) {
    riskScore += 15;
    reasons.push("Large transfer amount");
  }

  const result = {
    allowed: riskScore < 70,
    score: riskScore,
    reason: reasons.join("; ") || "No fraud indicators detected",
    recipient,
  };

  await logSecurityEvent(
    identifier,
    result.allowed ? "transfer_fraud_check_passed" : "transfer_fraud_check_blocked",
    result.score,
    {
      amount_kobo: amountKobo,
      recipient,
      reason: result.reason,
    }
  );

  return result;
}

// ---------------------------------------------------------------------
// INVOICE HELPERS
// ---------------------------------------------------------------------
function makeInvoiceNumber() {
  return `INV-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function makeInvoiceReference() {
  return `credafi_invoice_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

async function createInvoicePaymentLink(
  businessIdentifier,
  customerName,
  customerPhone,
  amountKobo,
  description
) {
  const invoiceNumber = makeInvoiceNumber();
  const reference = makeInvoiceReference();

  const customerDigits = String(customerPhone || "").replace(/\D/g, "");
  const email = customerDigits
    ? `${customerDigits}@invoice.credafi.ng`
    : `${invoiceNumber.toLowerCase()}@invoice.credafi.ng`;

  const paystackResponse = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    {
      email,
      amount: amountKobo,
      reference,
      metadata: {
        type: "credafi_invoice",
        invoice_number: invoiceNumber,
        business_identifier: businessIdentifier,
        customer_name: customerName,
        customer_phone: customerPhone,
        description,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const paymentUrl = paystackResponse.data.data.authorization_url;

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      business_identifier: businessIdentifier,
      invoice_number: invoiceNumber,
      customer_name: customerName,
      customer_phone: customerPhone,
      description,
      amount_kobo: amountKobo,
      currency: "NGN",
      status: "sent",
      payment_reference: reference,
      payment_url: paymentUrl,
    })
    .select()
    .single();

  if (invoiceError) {
    console.log("INVOICE CREATE ERROR:", invoiceError);
    throw new Error("Could not save invoice.");
  }

  await logSecurityEvent(businessIdentifier, "invoice_created", 0, {
    invoice_number: invoiceNumber,
    amount_kobo: amountKobo,
    customer_name: customerName,
    payment_reference: reference,
  });

  return {
    invoice,
    invoiceNumber,
    reference,
    paymentUrl,
  };
}

async function getQoreIdAccessToken() {
  const tokenResp = await axios.post(
    "https://api.qoreid.com/token",
    {
      clientId: process.env.QOREID_CLIENT_ID,
      secret: process.env.QOREID_CLIENT_SECRET,
    },
    { headers: { "Content-Type": "application/json" } }
  );

  if (!tokenResp.data.accessToken) {
    throw new Error("QoreID did not return an access token.");
  }

  return tokenResp.data.accessToken;
}

// ---------------------------------------------------------------------
// FRAUD CONTROLS
// ---------------------------------------------------------------------
async function logSecurityEvent(identifier, eventType, details) {
  const { error } = await supabase.from("security_events").insert({
    whatsapp_number: identifier,
    event_type: eventType,
    details,
  });
  console.log("SECURITY EVENT LOGGED:", { eventType, error });
}

// Checks limits/blocks and flags high-risk transfers for manual review
// instead of letting them proceed. Called after PIN confirmation, before
// any money actually moves.
async function evaluateTransferRisk(identifier, user, amountKobo, recipientDescriptor) {
  if (user.is_transfer_blocked) {
    await logSecurityEvent(identifier, "blocked_attempt", `Account blocked. Attempted amount: ${amountKobo}`);
    return { blocked: true, reason: "Your account is currently restricted from sending money. Please contact support." };
  }

  if (user.per_transfer_limit_kobo && amountKobo > user.per_transfer_limit_kobo) {
    await logSecurityEvent(identifier, "blocked_attempt", `Exceeded per-transfer limit. Amount: ${amountKobo}, limit: ${user.per_transfer_limit_kobo}`);
    return { blocked: true, reason: `This exceeds your per-transfer limit of N${(user.per_transfer_limit_kobo / 100).toFixed(2)}.` };
  }

  if (user.daily_transfer_limit_kobo) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const { data: todaysSends } = await supabase
      .from("transactions")
      .select("amount")
      .eq("whatsapp_number", identifier)
      .eq("type", "send")
      .gte("created_at", startOfDay.toISOString());
    const todayTotal = (todaysSends || []).reduce((sum, t) => sum + t.amount, 0);
    if (todayTotal + amountKobo > user.daily_transfer_limit_kobo) {
      await logSecurityEvent(identifier, "blocked_attempt", `Exceeded daily limit. Today so far: ${todayTotal}, attempted: ${amountKobo}, limit: ${user.daily_transfer_limit_kobo}`);
      return { blocked: true, reason: `This would exceed your daily transfer limit of N${(user.daily_transfer_limit_kobo / 100).toFixed(2)}.` };
    }
  }

  let riskScore = 0;
  const reasons = [];

  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: recentSimilar } = await supabase
    .from("transactions")
    .select("*")
    .eq("whatsapp_number", identifier)
    .eq("type", "send")
    .eq("counterparty", recipientDescriptor)
    .eq("amount", amountKobo)
    .gte("created_at", tenMinAgo);
  if (recentSimilar && recentSimilar.length > 0) {
    riskScore += 50;
    reasons.push("Repeated identical transfer within 10 minutes");
  }

  if (amountKobo >= 50000000) { // N500,000+
    riskScore += 30;
    reasons.push("Large transfer amount");
  }

  const needsReview = riskScore >= 50;
  if (needsReview) {
    await logSecurityEvent(identifier, "flagged_for_review", `${reasons.join("; ")}. Amount: ${amountKobo}`);
  }

  return { blocked: false, needsReview, riskScore, riskReason: reasons.length ? reasons.join("; ") : null };
}

// ---------------------------------------------------------------------
// INVOICING
// ---------------------------------------------------------------------
async function createInvoicePaymentLink(customerNumber, amountKobo, reference) {
  const digitsOnly = customerNumber.replace(/\D/g, "");
  const resp = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    { email: `${digitsOnly}@credafi.ng`, amount: amountKobo, reference },
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );
  return resp.data.data.authorization_url;
}

// ---------------------------------------------------------------------
// CORE MESSAGE HANDLER
// ---------------------------------------------------------------------
async function handleIncomingMessage(from, incomingMessage, options = {}) {
  let replyText = "";

  try {
    let { data: user, error: findError } = await supabase
      .from("users")
      .select("*")
      .eq("whatsapp_number", from)
      .single();

    if (findError && findError.code !== "PGRST116") {
      console.log("USER LOOKUP ERROR:", findError);
      return "Something went wrong on our end. Please try again shortly.";
    }

    if (!user) {
      if (options.isVoice) {
        return "Welcome to CredaFI! To get started, please type a 4-digit PIN to secure your account (voice notes can't be used to set your PIN).";
      }

      const { data: newUser, error: createUserError } = await supabase
        .from("users")
        .insert({
          whatsapp_number: from,
          conversation_state: "awaiting_pin_setup",
        })
        .select()
        .single();

      if (createUserError) {
        console.log("USER CREATE ERROR:", createUserError);
        return "We could not create your account. Please try again.";
      }

      await getOrCreateWallet(from);

      return (
        "Welcome to CredaFI!\n\n" +
        "To get started, set a 4-digit PIN to secure your account.\n" +
        "Reply with 4 digits, for example: 1234"
      );
    }

    const state = user.conversation_state || "";

    if (options.isVoice && isPinState(state)) {
      return "For security, please type your 4-digit PIN instead of sending a voice note.";
    }

    if (
      incomingMessage.toLowerCase() === "menu" &&
      state !== "awaiting_pin_setup" &&
      !state.startsWith("awaiting_pin_confirm:")
    ) {
      await setState(from, "main_menu");
      return MENU_TEXT;
    }

    // ---------------- PIN SETUP ----------------
    if (state === "awaiting_pin_setup") {
      if (!/^\d{4}$/.test(incomingMessage)) {
        replyText =
          "That is not a valid PIN. Reply with exactly 4 digits, for example: 1234.";
      } else {
        await setState(from, `awaiting_pin_confirm:${incomingMessage}`);
        replyText = "Please enter your 4-digit PIN again to confirm it.";
      }
    } else if (state.startsWith("awaiting_pin_confirm:")) {
      const pendingPin = state.split(":")[1];

      if (incomingMessage !== pendingPin) {
        await setState(from, "awaiting_pin_setup");
        replyText =
          "PINs did not match. Reply with a new 4-digit PIN, for example: 1234.";
      } else {
        const hashedPin = await bcrypt.hash(incomingMessage, 10);

        await supabase
          .from("users")
          .update({
            pin_hash: hashedPin,
            conversation_state: "main_menu",
          })
          .eq("whatsapp_number", from);

        await getOrCreateWallet(from);

        replyText = `Your PIN is set!\n\nHello 👋\n${MENU_TEXT}`;
      }

      // ---------------- MAIN MENU ----------------
    } else if (state === "main_menu") {
      if (incomingMessage === "1") {
        const wallet = await getOrCreateWallet(from);
        replyText = `Your balance is N${(
          wallet.balance_kobo / 100
        ).toFixed(2)}`;
      } else if (incomingMessage === "2") {
        await setState(from, "awaiting_fund_amount");
        replyText =
          "How much would you like to fund your wallet with? Reply with an amount in Naira, for example: 1000.";
      } else if (incomingMessage === "3") {
        const { data: beneficiaries } = await supabase
          .from("beneficiaries")
          .select("*")
          .eq("owner_whatsapp_number", from)
          .limit(8);

        let msg = "Who are you sending money to?\n\n";

        if (beneficiaries && beneficiaries.length > 0) {
          msg += beneficiaries
            .map(
              (beneficiary, index) =>
                `${index + 1}. ${beneficiary.nickname} (${
                  beneficiary.type === "bank"
                    ? beneficiary.account_name
                    : "CredaFI user"
                })`
            )
            .join("\n");

          msg += "\n\nReply with a number above, or:\n";
        }

        msg +=
          "Reply 'bank' to send to a new bank account.\n" +
          "Reply 'user' to send to another CredaFI user.";

        await setState(from, "awaiting_send_recipient_choice");
        replyText = msg;
      } else if (incomingMessage === "4") {
        const { data: beneficiaries } = await supabase
          .from("beneficiaries")
          .select("*")
          .eq("owner_whatsapp_number", from);

        let msg = "Beneficiaries:\n";

        if (!beneficiaries || beneficiaries.length === 0) {
          msg += "(No saved beneficiaries yet)\n";
        } else {
          msg +=
            beneficiaries
              .map(
                (beneficiary, index) =>
                  `${index + 1}. ${beneficiary.nickname} — ${
                    beneficiary.type === "bank"
                      ? `${beneficiary.account_name} (${beneficiary.account_number})`
                      : "CredaFI user"
                  }`
              )
              .join("\n") + "\n";
        }

        msg += "\nReply 'add' to save a beneficiary, or 'menu' to go back.";

        await setState(from, "beneficiaries_menu");
        replyText = msg;
      } else if (incomingMessage === "5") {
        const { data: txns } = await supabase
          .from("transactions")
          .select("*")
          .eq("whatsapp_number", from)
          .order("created_at", { ascending: false })
          .limit(5);

        if (!txns || txns.length === 0) {
          replyText = "No transactions yet.";
        } else {
          const lines = txns.map((transaction) => {
            const sign = transaction.type === "send" ? "-" : "+";
            const date = new Date(
              transaction.created_at
            ).toLocaleDateString();

            return `${sign}N${(transaction.amount / 100).toFixed(
              2
            )} (${transaction.type}) — ${date}`;
          });

          replyText = `Last transactions:\n${lines.join("\n")}`;
        }
      } else if (incomingMessage === "6") {
        const wallet = await getOrCreateWallet(from);

        replyText =
          `Account details:\n` +
          `Number: ${from
            .replace("whatsapp:", "")
            .replace("telegram:", "")}\n` +
          `Name: ${user.full_name || "(not set)"}\n` +
          `Balance: N${(wallet.balance_kobo / 100).toFixed(2)}\n` +
          `Bank verified: ${
            user.bank_account_number
              ? `Yes (${user.account_name || "Verified"})`
              : "No"
          }\n` +
          `BVN verified: ${user.bvn_verified ? "Yes" : "No"}\n` +
          `NIN verified: ${user.nin_verified ? "Yes" : "No"}`;
      } else if (incomingMessage === "7") {
        await setState(from, "awaiting_bank_code");
        replyText =
          "Reply with your bank code.\n" +
          "Examples: 058 for GTBank, 044 for Access Bank.\n" +
          "Reply 'banks' to see common bank codes.";
      } else if (incomingMessage === "8") {
        if (!user.full_name) {
          await setState(from, "awaiting_full_name_for_identity");
          replyText =
            "Let's verify your identity.\n\n" +
            "Reply with your full name exactly as it appears on your BVN/NIN records.";
        } else {
          await setState(from, "awaiting_bvn");
          replyText = `Verifying as ${user.full_name}. Reply with your 11-digit BVN.`;
        }
      } else if (
  incomingMessage === "invoice" ||
  incomingMessage === "10"
) {
  await setState(from, "awaiting_invoice_customer_name");

  replyText =
    "Create invoice\n\n" +
    "What is the customer's name?\n" +
    "Reply 'menu' anytime to cancel."; else if (incomingMessage === "9") {
        replyText =
          "Help:\n" +
          "1. Check balance\n" +
          "2. Fund wallet\n" +
          "3. Send money\n" +
          "4. Beneficiaries\n" +
          "5. Transaction history\n" +
          "6. Account details\n" +
          "7. Verify bank account\n" +
          "8. Verify identity\n\n" +
          "Reply 'menu' at any time to return here. Reply 'invoice' to create a customer invoice.";
      } else if (incomingMessage.toLowerCase() === "invoice") {
        await setState(from, "awaiting_invoice_details");
        replyText =
          "Let's create an invoice. Reply in this exact format:\n" +
          "Customer name | Customer WhatsApp number | Amount in Naira | Description\n\n" +
          "Example:\nAda Okafor | 2348012345678 | 5000 | Payment for hair styling";
      } else {
        replyText = "Sorry, I did not understand that. Reply 'menu' for options.";
      }

      // ---------------- INVOICING ----------------
    } else if (state === "awaiting_invoice_details") {
      const parts = incomingMessage.split("|").map((p) => p.trim());

      if (parts.length !== 4) {
        replyText =
          "Please use the exact format:\nCustomer name | Customer WhatsApp number | Amount in Naira | Description";
      } else {
        const [customerName, customerNumberRaw, amountStr, description] = parts;
        const amountNaira = parseFloat(amountStr);
        const customerNumber = `whatsapp:+${customerNumberRaw.replace(/\D/g, "")}`;

        if (isNaN(amountNaira) || amountNaira <= 0) {
          replyText = "That amount doesn't look valid. Please try again with the full format.";
        } else {
          const amountKobo = Math.round(amountNaira * 100);
          const reference = `credafi_invoice_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

          try {
            const authUrl = await createInvoicePaymentLink(customerNumber, amountKobo, reference);

            await supabase.from("invoices").insert({
              created_by: from,
              customer_name: customerName,
              customer_number: customerNumber,
              amount_kobo: amountKobo,
              description,
              reference,
              status: "pending",
            });

            // Note: on WhatsApp sandbox, this only reaches numbers that have
            // joined your sandbox — a production sender doesn't have this limit.
            await sendMessage(
              customerNumber,
              `Hi ${customerName}, you have an invoice from CredaFI for N${amountNaira.toFixed(2)} (${description}).\nPay here: ${authUrl}`
            );

            replyText = `Invoice sent to ${customerName}! I'll let you know once it's paid.`;
          } catch (err) {
            console.log("INVOICE CREATE ERROR:", err.response ? err.response.data : err.message);
            replyText = "Something went wrong creating that invoice. Please try again.";
          }

          await setState(from, "main_menu");
        }
      }

      // ---------------- BENEFICIARIES ----------------
    } else if (state === "beneficiaries_menu") {
      if (incomingMessage.toLowerCase() === "add") {
        await setState(from, "awaiting_beneficiary_type");
        replyText =
          "Reply 'bank' to save a bank account, or 'user' to save another CredaFI user.";
      } else {
        replyText =
          "Reply 'add' to save a beneficiary, or reply 'menu' to go back.";
      }
    } else if (state === "awaiting_beneficiary_type") {
      if (incomingMessage.toLowerCase() === "bank") {
        await setState(from, "awaiting_beneficiary_bank_code");
        replyText =
          "Reply with the bank code, for example 058 for GTBank.\nReply 'banks' for common codes.";
      } else if (incomingMessage.toLowerCase() === "user") {
        await setState(from, "awaiting_beneficiary_number");
        replyText =
          "Reply with their WhatsApp number, for example: 2348012345678.\n\n" +
          "For a Telegram user, reply using tg followed by their Telegram chat ID, for example: tg123456789.";
      } else {
        replyText = "Please reply 'bank' or 'user'.";
      }
    } else if (state === "awaiting_beneficiary_bank_code") {
      if (incomingMessage.toLowerCase() === "banks") {
        try {
          replyText = `Common bank codes:\n${await getBankListText()}\n\nReply with a bank code when ready.`;
        } catch (err) {
          console.log("BANK LIST ERROR:", err.message);
          replyText =
            "Could not fetch bank codes now. Please reply with the bank code directly.";
        }
      } else {
        await setState(
          from,
          `awaiting_beneficiary_account_number:${incomingMessage.trim()}`
        );
        replyText = "Now reply with the 10-digit account number.";
      }
    } else if (state.startsWith("awaiting_beneficiary_account_number:")) {
      const bankCode = state.split(":")[1];
      const accountNumber = incomingMessage.replace(/\D/g, "");

      if (accountNumber.length !== 10) {
        replyText = "Account number must be exactly 10 digits. Try again.";
      } else {
        try {
          const accountName = await resolveBankAccount(accountNumber, bankCode);

          await setState(
            from,
            `awaiting_beneficiary_bank_nickname:${bankCode}:${accountNumber}:${accountName}`
          );

          replyText = `Account name: ${accountName}\nWhat nickname should we save it as? For example: Mum`;
        } catch (err) {
          console.log(
            "BENEFICIARY BANK RESOLVE ERROR:",
            err.response ? err.response.data : err.message
          );

          await setState(from, "main_menu");

          replyText =
            "Could not verify that account. Check the bank code and 10-digit account number, then try again.";
        }
      }
    } else if (state.startsWith("awaiting_beneficiary_bank_nickname:")) {
      const [, bankCode, accountNumber, ...nameParts] = state.split(":");
      const accountName = nameParts.join(":");

      await supabase.from("beneficiaries").insert({
        owner_whatsapp_number: from,
        type: "bank",
        bank_code: bankCode,
        account_number: accountNumber,
        account_name: accountName,
        nickname: incomingMessage,
      });

      await setState(from, "main_menu");
      replyText = "Beneficiary saved. Reply 'menu' to continue.";
    } else if (state === "awaiting_beneficiary_number") {
      let identifier;

      if (incomingMessage.toLowerCase().startsWith("tg")) {
        identifier = `telegram:${incomingMessage.replace(/\D/g, "")}`;
      } else {
        identifier = `whatsapp:+${incomingMessage.replace(/\D/g, "")}`;
      }

      const { data: existingUser } = await supabase
        .from("users")
        .select("whatsapp_number")
        .eq("whatsapp_number", identifier)
        .single();

      if (!existingUser) {
        replyText =
          "That user is not registered on CredaFI yet. Try a different WhatsApp number or Telegram ID, or reply 'menu' to cancel.";
      } else {
        await setState(from, `awaiting_beneficiary_nickname:${identifier}`);
        replyText =
          "What nickname should we save this person as? For example: Mum";
      }
    } else if (state.startsWith("awaiting_beneficiary_nickname:")) {
      const identifier = state.split(":").slice(1).join(":");

      await supabase.from("beneficiaries").insert({
        owner_whatsapp_number: from,
        type: "internal",
        beneficiary_number: identifier,
        nickname: incomingMessage,
      });

      await setState(from, "main_menu");
      replyText = "Beneficiary saved. Reply 'menu' to continue.";

      // ---------------- SEND MONEY ----------------
    } else if (state === "awaiting_send_recipient_choice") {
      const { data: beneficiaries } = await supabase
        .from("beneficiaries")
        .select("*")
        .eq("owner_whatsapp_number", from)
        .limit(8);

      const selectionIndex = parseInt(incomingMessage, 10);

      if (
        beneficiaries &&
        beneficiaries.length > 0 &&
        /^\d{1,2}$/.test(incomingMessage) &&
        selectionIndex >= 1 &&
        selectionIndex <= beneficiaries.length
      ) {
        const chosen = beneficiaries[selectionIndex - 1];

        if (chosen.type === "bank") {
          await setState(
            from,
            `awaiting_send_amount:bank:saved:${chosen.id}`
          );
        } else {
          await setState(
            from,
            `awaiting_send_amount:internal:${chosen.beneficiary_number}`
          );
        }

        replyText = `Sending to ${chosen.nickname}. How much would you like to send? Reply with an amount in Naira, for example: 500.`;
      } else if (incomingMessage.toLowerCase() === "bank") {
        await setState(from, "awaiting_send_bank_code");
        replyText =
          "Reply with the bank code, for example 058 for GTBank.\nReply 'banks' for common codes.";
      } else if (incomingMessage.toLowerCase() === "user") {
        await setState(from, "awaiting_send_user_identifier");
        replyText =
          "Reply with their WhatsApp number, for example: 2348012345678.\n\n" +
          "For Telegram users, reply with tg followed by their chat ID, for example: tg123456789.";
      } else {
        replyText =
          "Reply with a beneficiary number from the list, or reply 'bank' or 'user'.";
      }
    } else if (state === "awaiting_send_bank_code") {
      if (incomingMessage.toLowerCase() === "banks") {
        try {
          replyText = `Common bank codes:\n${await getBankListText()}\n\nReply with a bank code when ready.`;
        } catch (err) {
          console.log("BANK LIST ERROR:", err.message);
          replyText =
            "Could not fetch bank codes right now. Reply with the bank code directly.";
        }
      } else {
        await setState(
          from,
          `awaiting_send_account_number:${incomingMessage.trim()}`
        );

        replyText = "Now reply with the 10-digit account number.";
      }
    } else if (state.startsWith("awaiting_send_account_number:")) {
      const bankCode = state.split(":")[1];
      const accountNumber = incomingMessage.replace(/\D/g, "");

      if (accountNumber.length !== 10) {
        replyText = "Account number must be exactly 10 digits. Try again.";
      } else {
        try {
          const accountName = await resolveBankAccount(accountNumber, bankCode);

          await setState(
            from,
            `awaiting_send_amount:bank:new:${bankCode}:${accountNumber}:${accountName}`
          );

          replyText = `Account name: ${accountName}\nHow much would you like to send? Reply with an amount in Naira, for example: 500.`;
        } catch (err) {
          console.log(
            "SEND BANK RESOLVE ERROR:",
            err.response ? err.response.data : err.message
          );

          await setState(from, "main_menu");

          replyText =
            "Could not verify that account. Check the bank code and account number, then try again.";
        }
      }
    } else if (state === "awaiting_send_user_identifier") {
      let identifier;

      if (incomingMessage.toLowerCase().startsWith("tg")) {
        identifier = `telegram:${incomingMessage.replace(/\D/g, "")}`;
      } else {
        identifier = `whatsapp:+${incomingMessage.replace(/\D/g, "")}`;
      }

      if (identifier === from) {
        replyText =
          "You cannot send money to yourself. Try another user or reply 'menu' to cancel.";
      } else {
        const { data: recipient } = await supabase
          .from("users")
          .select("whatsapp_number")
          .eq("whatsapp_number", identifier)
          .single();

        if (!recipient) {
          replyText =
            "That user is not registered on CredaFI yet. Try a different WhatsApp number or Telegram ID.";
        } else {
          await setState(
            from,
            `awaiting_send_amount:internal:${identifier}`
          );

          replyText =
            "How much would you like to send? Reply with an amount in Naira, for example: 500.";
        }
      }
    } else if (state.startsWith("awaiting_send_amount:")) {
      const parts = state.split(":");
      const amountNaira = parseFloat(incomingMessage);

      if (isNaN(amountNaira) || amountNaira <= 0) {
        replyText =
          "That does not look like a valid amount. Reply with a number, for example: 500.";
      } else {
        const amountKobo = Math.round(amountNaira * 100);
        const senderWallet = await getOrCreateWallet(from);

        if (senderWallet.balance_kobo < amountKobo) {
          replyText = `Insufficient balance. Current balance: N${(
            senderWallet.balance_kobo / 100
          ).toFixed(2)}. Reply 'menu' to return.`;

          await setState(from, "main_menu");
        } else {
          await setState(
            from,
            `awaiting_send_pin:${parts.slice(1).join(":")}:${amountKobo}`
          );

          replyText = `Enter your 4-digit PIN to confirm sending N${amountNaira.toFixed(
            2
          )}.`;
        }
      }
    } else if (state.startsWith("awaiting_send_pin:")) {
      const parts = state.split(":");
      const kind = parts[1];

      const pinMatches =
        user.pin_hash && (await bcrypt.compare(incomingMessage, user.pin_hash));

      if (!pinMatches) {
        await setState(from, "main_menu");
        replyText = "Incorrect PIN. Transfer cancelled. Reply 'menu' to try again.";
      } else {
        const senderWallet = await getOrCreateWallet(from);

        if (kind === "internal") {
          const amountKobo = parseInt(parts[parts.length - 1], 10);
          const recipientNumber = parts.slice(2, parts.length - 1).join(":");

          if (senderWallet.balance_kobo < amountKobo) {
            replyText = "Insufficient balance. Transfer cancelled.";
          } else {
            const risk = await evaluateTransferRisk(from, user, amountKobo, recipientNumber);

            if (risk.blocked) {
              replyText = risk.reason;
            } else if (risk.needsReview) {
              await logTransaction(
                from, "send", amountKobo, recipientNumber, null,
                risk.riskScore, risk.riskReason, "pending_review"
              );
              replyText =
                "This transfer looks unusual, so it's been placed under review instead of sent immediately. We'll follow up shortly.";
            } else {
              const recipientWallet = await getOrCreateWallet(recipientNumber);

              await supabase
                .from("wallets")
                .update({
                  balance_kobo: senderWallet.balance_kobo - amountKobo,
                })
                .eq("whatsapp_number", from);

              await supabase
                .from("wallets")
                .update({
                  balance_kobo: recipientWallet.balance_kobo + amountKobo,
                })
                .eq("whatsapp_number", recipientNumber);

              await logTransaction(
                from, "send", amountKobo, recipientNumber, null,
                risk.riskScore, risk.riskReason
              );

              await logTransaction(
                recipientNumber,
                "receive",
                amountKobo,
                from,
                null
              );

              replyText = `N${(amountKobo / 100).toFixed(
                2
              )} sent successfully!`;

              await sendMessage(
                recipientNumber,
                `You've received N${(amountKobo / 100).toFixed(
                  2
                )} on CredaFI!`
              );
            }
          }

          await setState(from, "main_menu");
        } else if (kind === "bank") {
          const source = parts[2];
          const amountKobo = parseInt(parts[parts.length - 1], 10);

          if (senderWallet.balance_kobo < amountKobo) {
            await setState(from, "main_menu");
            replyText = "Insufficient balance. Transfer cancelled.";
          } else {
            let bankCode;
            let accountNumber;
            let accountName;
            let beneficiaryId = null;

            if (source === "saved") {
              beneficiaryId = parts[3];

              const { data: beneficiary, error: beneficiaryError } =
                await supabase
                  .from("beneficiaries")
                  .select("*")
                  .eq("id", beneficiaryId)
                  .single();

              if (beneficiaryError || !beneficiary) {
                await setState(from, "main_menu");
                replyText = "Saved beneficiary could not be found. Please try again.";
              } else {
                bankCode = beneficiary.bank_code;
                accountNumber = beneficiary.account_number;
                accountName = beneficiary.account_name;
              }
            } else {
              bankCode = parts[3];
              accountNumber = parts[4];
              accountName = parts.slice(5, parts.length - 1).join(":");
            }

            if (accountNumber) {
              const risk = await evaluateTransferRisk(from, user, amountKobo, accountNumber);

              if (risk.blocked) {
                replyText = risk.reason;
                await setState(from, "main_menu");
              } else if (risk.needsReview) {
                await logTransaction(
                  from, "send", amountKobo, accountName, null,
                  risk.riskScore, risk.riskReason, "pending_review"
                );
                replyText =
                  "This transfer looks unusual, so it's been placed under review instead of sent immediately. We'll follow up shortly.";
                await setState(from, "main_menu");
              } else {
                try {
                  let recipientCode;

                  if (source === "saved") {
                    const { data: beneficiary } = await supabase
                      .from("beneficiaries")
                      .select("paystack_recipient_code")
                      .eq("id", beneficiaryId)
                      .single();

                    recipientCode = beneficiary.paystack_recipient_code;

                    if (!recipientCode) {
                      recipientCode = await createTransferRecipient(
                        accountName,
                        accountNumber,
                        bankCode
                      );

                      await supabase
                        .from("beneficiaries")
                        .update({ paystack_recipient_code: recipientCode })
                        .eq("id", beneficiaryId);
                    }
                  } else {
                    recipientCode = await createTransferRecipient(
                      accountName,
                      accountNumber,
                      bankCode
                    );
                  }

                  const reference = `credafi_transfer_${Date.now()}_${Math.floor(
                    Math.random() * 10000
                  )}`;

                  const transferResult = await initiatePaystackTransfer(
                    recipientCode,
                    amountKobo,
                    "CredaFI transfer",
                    reference
                  );

                  await supabase
                    .from("wallets")
                    .update({
                      balance_kobo: senderWallet.balance_kobo - amountKobo,
                    })
                    .eq("whatsapp_number", from);

                  await logTransaction(
                    from, "send", amountKobo, accountName, reference,
                    risk.riskScore, risk.riskReason
                  );

                  replyText = `N${(amountKobo / 100).toFixed(
                    2
                  )} sent to ${accountName}. Status: ${transferResult.status}.`;

                  if (source === "new") {
                    await setState(
                      from,
                      `awaiting_save_beneficiary:${bankCode}:${accountNumber}:${accountName}`
                    );

                    replyText +=
                      "\n\nSave this account as a beneficiary? Reply 'yes' or 'menu'.";
                  } else {
                    await setState(from, "main_menu");
                  }
                } catch (err) {
                  console.log(
                    "TRANSFER ERROR:",
                    err.response ? err.response.data : err.message
                  );

                  await setState(from, "main_menu");

                  replyText =
                    "Something went wrong sending this transfer. Please try again later.";
                }
              }
            }
          }
        }
      }
    } else if (state.startsWith("awaiting_save_beneficiary:")) {
      if (incomingMessage.toLowerCase() === "yes") {
        const [, bankCode, accountNumber, ...nameParts] = state.split(":");
        const accountName = nameParts.join(":");

        await setState(
          from,
          `awaiting_beneficiary_bank_nickname:${bankCode}:${accountNumber}:${accountName}`
        );

        replyText =
          "What nickname should we save this account as? For example: Mum";
      } else {
        await setState(from, "main_menu");
        replyText = "Okay. Reply 'menu' to continue.";
      }

      // ---------------- FUND WALLET ----------------
    } else if (state === "awaiting_fund_amount") {
      const amountNaira = parseFloat(incomingMessage);

      if (isNaN(amountNaira) || amountNaira <= 0) {
        replyText =
          "That does not look like a valid amount. Reply with a number, for example: 1000.";
      } else {
        const amountKobo = Math.round(amountNaira * 100);
        const reference = `credafi_${Date.now()}_${Math.floor(
          Math.random() * 10000
        )}`;

        const digitsOnly = from.replace(/\D/g, "");

        try {
          const paystackResponse = await axios.post(
            "https://api.paystack.co/transaction/initialize",
            {
              email: `${digitsOnly}@credafi.ng`,
              amount: amountKobo,
              reference,
            },
            {
              headers: {
                Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
              },
            }
          );

          const authUrl = paystackResponse.data.data.authorization_url;

          const { error: pendingError } = await supabase
            .from("pending_payments")
            .insert({
              whatsapp_number: from,
              reference,
              amount_kobo: amountKobo,
              status: "pending",
            });

          console.log("PENDING PAYMENT CREATED:", { pendingError });

          replyText = `Tap this link to complete payment of N${amountNaira.toFixed(
            2
          )}:\n${authUrl}`;
        } catch (err) {
          console.log(
            "PAYSTACK INIT ERROR:",
            err.response ? err.response.data : err.message
          );

          replyText =
            "Something went wrong starting your payment. Please try again shortly.";
        }

        await setState(from, "main_menu");
      }

      // ---------------- VERIFY USER BANK ACCOUNT ----------------
    } else if (state === "awaiting_bank_code") {
      if (incomingMessage.toLowerCase() === "banks") {
        try {
          replyText = `Common bank codes:\n${await getBankListText()}\n\nReply with a bank code when ready.`;
        } catch (err) {
          console.log("BANK LIST ERROR:", err.message);
          replyText =
            "Could not fetch bank codes now. Reply with your bank code directly.";
        }
      } else {
        await setState(
          from,
          `awaiting_account_number:${incomingMessage.trim()}`
        );

        replyText = "Now reply with your 10-digit account number.";
      }
    } else if (state.startsWith("awaiting_account_number:")) {
      const bankCode = state.split(":")[1];
      const accountNumber = incomingMessage.replace(/\D/g, "");

      if (accountNumber.length !== 10) {
        replyText = "Account number must be exactly 10 digits. Try again.";
      } else {
        try {
          const accountName = await resolveBankAccount(accountNumber, bankCode);

          await supabase
            .from("users")
            .update({
              bank_account_number: accountNumber,
              bank_code: bankCode,
              account_name: accountName,
            })
            .eq("whatsapp_number", from);

          await setState(from, "main_menu");

          replyText = `Verified! Account name: ${accountName}. Reply 'menu' to continue.`;
        } catch (err) {
          console.log(
            "BANK RESOLVE ERROR:",
            err.response ? err.response.data : err.message
          );

          await setState(from, "main_menu");

          replyText =
            "Could not verify that account. Double-check the bank code and account number, then try again.";
        }
      }

      // ---------------- IDENTITY VERIFICATION ----------------
    } else if (state === "awaiting_full_name_for_identity") {
      const fullName = incomingMessage.trim();

      if (fullName.split(/\s+/).length < 2) {
        replyText =
          "Please reply with both your first and last name, for example: Ada Okafor.";
      } else {
        await supabase
          .from("users")
          .update({ full_name: fullName })
          .eq("whatsapp_number", from);

        await setState(from, "awaiting_bvn");

        replyText = `Thanks, ${fullName}. Now reply with your 11-digit BVN.`;
      }

      // ---------------- BVN — consent-based iGree flow ----------------
    } else if (state === "awaiting_bvn") {
      const bvn = incomingMessage.replace(/\D/g, "");

      if (bvn.length !== 11) {
        replyText = "BVN must be exactly 11 digits. Please try again.";
      } else {
        try {
          const accessToken = await getQoreIdAccessToken();

          const consentResp = await axios.get(
            `https://api.qoreid.com/v1/ng/identities/bvn-consent/${bvn}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          console.log("BVN CONSENT INITIATED:", consentResp.data);

          await setState(from, `awaiting_bvn_consent:${bvn}`);

          replyText =
            "To verify your BVN, please open this secure link and follow the steps (you'll confirm with an OTP sent to your BVN-linked phone number):\n\n" +
            `${consentResp.data.consentUrl}\n\n` +
            "Once you've completed it, reply 'done' here. If the link stops working, reply 'resend' for a fresh one.";
        } catch (err) {
          console.log(
            "BVN CONSENT ERROR:",
            err.response ? err.response.data : err.message
          );

          replyText =
            "We could not start BVN verification right now. Please try again later or reply 'menu' to cancel.";
        }
      }
    } else if (state.startsWith("awaiting_bvn_consent:")) {
      const bvn = state.split(":")[1];

      if (incomingMessage.toLowerCase() === "resend") {
        try {
          const accessToken = await getQoreIdAccessToken();

          const consentResp = await axios.get(
            `https://api.qoreid.com/v1/ng/identities/bvn-consent/${bvn}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          replyText = `Here's a fresh link:\n\n${consentResp.data.consentUrl}\n\nReply 'done' once you've completed it.`;
        } catch (err) {
          console.log(
            "BVN CONSENT RESEND ERROR:",
            err.response ? err.response.data : err.message
          );
          replyText = "Couldn't generate a new link right now. Please try again shortly.";
        }
      } else {
        try {
          const accessToken = await getQoreIdAccessToken();

          const checkResp = await axios.get(
            `https://api.qoreid.com/v1/ng/identities/bvn-consent/${bvn}`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          console.log("BVN CONSENT CHECK:", checkResp.data);

          if (checkResp.data.consentStatus === true) {
            await supabase
              .from("users")
              .update({ bvn_verified: true })
              .eq("whatsapp_number", from);

            await setState(from, "awaiting_nin");
            replyText = "BVN verified! Now reply with your 11-digit NIN.";
          } else {
            replyText =
              "It looks like consent hasn't been completed yet. Please open the link, complete the OTP step, then reply 'done' again. Reply 'resend' for a fresh link.";
          }
        } catch (err) {
          console.log(
            "BVN CONSENT CHECK ERROR:",
            err.response ? err.response.data : err.message
          );
          replyText = "Couldn't check your consent status right now. Please try again shortly.";
        }
      }
    } else if (state === "awaiting_nin") {
      const nin = incomingMessage.replace(/\D/g, "");

      if (nin.length !== 11) {
        replyText = "NIN must be exactly 11 digits. Please try again.";
      } else {
        const [firstname, ...rest] = user.full_name.split(" ");
        const lastname = rest.join(" ");

        try {
          const accessToken = await getQoreIdAccessToken();

          const verifyResp = await axios.post(
            `https://api.qoreid.com/v1/ng/identities/nin/${nin}`,
            {
              firstname,
              lastname,
            },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            }
          );

          const matched =
            verifyResp.data.summary && verifyResp.data.summary.nin_check
              ? verifyResp.data.summary.nin_check.status === "EXACT_MATCH"
              : true;

          if (!matched) {
            replyText =
              "That NIN does not match the name on file. Double-check it and try again.";
          } else {
            await supabase
              .from("users")
              .update({ nin_verified: true })
              .eq("whatsapp_number", from);

            await setState(from, "main_menu");

            replyText = "Identity verified! Reply 'menu' to continue.";
          }
        } catch (err) {
          console.log(
            "NIN VERIFY ERROR:",
            err.response ? err.response.data : err.message
          );

          replyText =
            "We could not verify that NIN right now. Please try again later or reply 'menu' to cancel.";
        }
      }
// ---------------- CREATE BUSINESS INVOICE ----------------
} else if (state === "awaiting_invoice_customer_name") {
  const customerName = incomingMessage.trim();

  if (customerName.length < 2) {
    replyText = "Please enter the customer's name.";
  } else {
    await setState(
      from,
      `awaiting_invoice_customer_phone:${customerName}`
    );

    replyText =
      "Enter the customer's WhatsApp/phone number.\n" +
      "Example: 2348012345678";
  }

} else if (state.startsWith("awaiting_invoice_customer_phone:")) {
  const customerName = state.split(":").slice(1).join(":");
  const customerPhone = incomingMessage.replace(/\D/g, "");

  if (customerPhone.length < 10) {
    replyText =
      "That phone number looks incomplete. Please enter a valid phone number.";
  } else {
    await setState(
      from,
      `awaiting_invoice_amount:${customerName}:${customerPhone}`
    );

    replyText =
      "What amount should the customer pay?\n" +
      "Reply with the amount in Naira, for example: 25000";
  }

} else if (state.startsWith("awaiting_invoice_amount:")) {
  const parts = state.split(":");
  const customerName = parts[1];
  const customerPhone = parts[2];
  const amountNaira = parseFloat(incomingMessage);

  if (isNaN(amountNaira) || amountNaira <= 0) {
    replyText =
      "Please enter a valid amount in Naira, for example: 25000.";
  } else {
    const amountKobo = Math.round(amountNaira * 100);

    await setState(
      from,
      `awaiting_invoice_description:${customerName}:${customerPhone}:${amountKobo}`
    );

    replyText =
      "What is this invoice for?\n" +
      "Example: Website design deposit";
  }

} else if (state.startsWith("awaiting_invoice_description:")) {
  const parts = state.split(":");
  const customerName = parts[1];
  const customerPhone = parts[2];
  const amountKobo = parseInt(parts[3], 10);
  const description = incomingMessage.trim();

  if (description.length < 2) {
    replyText = "Please enter a short description for the invoice.";
  } else {
    try {
      const result = await createInvoicePaymentLink(
        from,
        customerName,
        customerPhone,
        amountKobo,
        description
      );

      const customerIdentifier = customerPhone.startsWith("234")
        ? `whatsapp:+${customerPhone}`
        : `whatsapp:+${customerPhone.replace(/^0/, "234")}`;

      const invoiceMessage =
        `CredaFI Invoice ${result.invoiceNumber}\n\n` +
        `Hello ${customerName},\n` +
        `You have an invoice of N${(amountKobo / 100).toFixed(2)}.\n` +
        `For: ${description}\n\n` +
        `Pay securely here:\n${result.paymentUrl}`;

      try {
        await sendMessage(customerIdentifier, invoiceMessage);
      } catch (sendError) {
        console.log(
          "INVOICE CUSTOMER MESSAGE ERROR:",
          sendError.response ? sendError.response.data : sendError.message
        );
      }

      await setState(from, "main_menu");

      replyText =
        `Invoice created successfully.\n\n` +
        `Invoice number: ${result.invoiceNumber}\n` +
        `Customer: ${customerName}\n` +
        `Amount: N${(amountKobo / 100).toFixed(2)}\n\n` +
        `Payment link:\n${result.paymentUrl}\n\n` +
        `The link has also been sent to the customer where possible.`;
    } catch (err) {
      console.log(
        "INVOICE PAYMENT LINK ERROR:",
        err.response ? err.response.data : err.message
      );

      await setState(from, "main_menu");

      replyText =
        "Could not create the invoice right now. Please try again later.";
    }
  }
      // ---------------- FALLBACK ----------------
    } else {
      await setState(from, "main_menu");
      replyText = MENU_TEXT;
    }
  } catch (err) {
    console.log(
      "UNEXPECTED ERROR:",
      err.response ? err.response.data : err.message
    );

    replyText = "Something went wrong. Please try again shortly.";
  }

  return replyText;
}

// ---------------------------------------------------------------------
// WHATSAPP WEBHOOK
// ---------------------------------------------------------------------
app.post("/api/whatsapp", async (req, res) => {
  const from = req.body.From;
  const numMedia = parseInt(req.body.NumMedia || "0", 10);

  const twiml = new twilio.twiml.MessagingResponse();
  let replyText = "";

  try {
    if (numMedia > 0) {
      const mediaUrl = req.body.MediaUrl0;
      const contentType = req.body.MediaContentType0 || "";

      console.log("WHATSAPP MEDIA RECEIVED:", { contentType, mediaUrl });

      if (contentType.startsWith("audio")) {
        const buffer = await downloadTwilioMedia(mediaUrl);
        const transcribedText = await transcribeAudioBuffer(buffer, "voice.ogg");
        console.log("WHATSAPP VOICE TRANSCRIBED:", transcribedText);
        replyText = await handleIncomingMessage(from, transcribedText, {
          isVoice: true,
        });
      } else if (contentType.startsWith("image")) {
        const buffer = await downloadTwilioMedia(mediaUrl);
        const description = await analyzeImageBuffer(buffer, contentType);
        replyText = `Here's what I found in that image:\n\n${description}`;
      } else {
        replyText =
          "I can understand text, voice notes, and images right now.";
      }
    } else {
      const incomingMessage = (req.body.Body || "").trim();
      replyText = await handleIncomingMessage(from, incomingMessage);
    }
  } catch (err) {
    let errorDetail = err.message;

    if (err.response) {
      errorDetail = `status ${err.response.status}: `;
      if (Buffer.isBuffer(err.response.data)) {
        errorDetail += err.response.data.toString("utf-8");
      } else {
        errorDetail += JSON.stringify(err.response.data);
      }
    }

    console.log("WHATSAPP MEDIA ERROR:", errorDetail);
    replyText =
      "Sorry, I couldn't process that. Please try again, or type your message instead.";
  }

  twiml.message(replyText);
  res.set("Content-Type", "text/xml");
  return res.send(twiml.toString());
});

// ---------------------------------------------------------------------
// TELEGRAM WEBHOOK
// ---------------------------------------------------------------------
app.post("/api/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;

    console.log("TELEGRAM UPDATE:", JSON.stringify(update));

    if (!update.message) {
      return res.sendStatus(200);
    }

    const chatId = update.message.chat.id;
    const from = `telegram:${chatId}`;
    let replyText = "";

    if (update.message.voice) {
      const buffer = await downloadTelegramFile(update.message.voice.file_id);
      const transcribedText = await transcribeAudioBuffer(buffer, "voice.ogg");
      console.log("TELEGRAM VOICE TRANSCRIBED:", transcribedText);
      replyText = await handleIncomingMessage(from, transcribedText, {
        isVoice: true,
      });
    } else if (update.message.photo && update.message.photo.length > 0) {
      const largestPhoto =
        update.message.photo[update.message.photo.length - 1];
      const buffer = await downloadTelegramFile(largestPhoto.file_id);
      const description = await analyzeImageBuffer(buffer, "image/jpeg");
      replyText = `Here's what I found in that image:\n\n${description}`;
    } else if (update.message.text) {
      const incomingMessage = update.message.text.trim();

      console.log("TELEGRAM MESSAGE:", { chatId, incomingMessage });

      replyText = await handleIncomingMessage(from, incomingMessage);
    } else {
      await sendMessage(
        from,
        "I can understand text, voice notes, and images right now."
      );
      return res.sendStatus(200);
    }

    await sendMessage(from, replyText);

    return res.sendStatus(200);
  } catch (err) {
    console.log(
      "TELEGRAM WEBHOOK ERROR:",
      err.response ? err.response.data : err.message
    );

    return res.sendStatus(200);
  }
});

// ---------------------------------------------------------------------
// TELEGRAM TOKEN TEST ROUTE
// ---------------------------------------------------------------------
app.get("/api/telegram/test", async (req, res) => {
  try {
    const result = await axios.get(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`
    );

    return res.json({
      ok: true,
      bot: result.data.result,
    });
  } catch (err) {
    console.log(
      "TELEGRAM TOKEN TEST ERROR:",
      err.response ? err.response.data : err.message
    );

    return res.status(500).json({
      ok: false,
      error: err.response ? err.response.data : err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});