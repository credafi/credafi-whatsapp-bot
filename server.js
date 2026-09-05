const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const axios = require("axios");

const app = express();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const MENU_TEXT =
  "Welcome\nWhat do you want to do?\n" +
  "1. Check balance\n2. Fund wallet\n3. Send money\n4. Beneficiaries\n" +
  "5. Transaction history\n6. Account details\n7. Verify bank account\n" +
  "8. Verify identity\n9. Help";

// ---------------------------------------------------------------------
// PAYSTACK WEBHOOK (payments in)
// ---------------------------------------------------------------------
app.post("/api/paystack/webhook", express.raw({ type: "*/*" }), async (req, res) => {
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

      const { data: pending, error: pendingError } = await supabase
        .from("pending_payments").select("*").eq("reference", reference).single();

      console.log("PENDING PAYMENT LOOKUP:", { reference, pending, pendingError });

      if (pending && pending.status !== "success") {
        const identifier = pending.whatsapp_number;
        const wallet = await getOrCreateWallet(identifier);
        const newBalance = wallet.balance_kobo + amountKobo;

        await supabase.from("wallets").update({ balance_kobo: newBalance }).eq("whatsapp_number", identifier);
        await supabase.from("pending_payments").update({ status: "success" }).eq("reference", reference);
        await logTransaction(identifier, "fund", amountKobo, null, reference);

        await sendMessage(identifier, `Payment confirmed! N${(amountKobo / 100).toFixed(2)} has been added to your wallet.`);
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.log("PAYSTACK WEBHOOK ERROR:", err);
    res.sendStatus(500);
  }
});

app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
async function getOrCreateWallet(identifier) {
  const { data: wallet, error: findError } = await supabase
    .from("wallets").select("*").eq("whatsapp_number", identifier).maybeSingle();

  if (findError) console.log("WALLET LOOKUP ERROR:", findError);
  if (wallet) return wallet;

  const { data: newWallet, error: insertError } = await supabase
    .from("wallets").insert({ whatsapp_number: identifier, balance_kobo: 0 }).select().single();

  if (insertError) console.log("WALLET CREATE ERROR:", insertError);
  return newWallet || { whatsapp_number: identifier, balance_kobo: 0 };
}

async function logTransaction(identifier, type, amountKobo, counterparty, reference) {
  const { error } = await supabase.from("transactions").insert({
    whatsapp_number: identifier, type, amount: amountKobo, counterparty, reference,
  });
  console.log("TRANSACTION LOGGED:", { type, amountKobo, error });
}

async function setState(identifier, state) {
  await supabase.from("users").update({ conversation_state: state }).eq("whatsapp_number", identifier);
}

async function sendMessage(identifier, text) {
  if (identifier.startsWith("whatsapp:")) {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: identifier,
      body: text,
    });
  } else if (identifier.startsWith("telegram:")) {
    const chatId = identifier.split(":")[1];
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: text,
    });
  } else {
    console.log("SEND MESSAGE: unknown identifier format", identifier);
  }
}

async function getBankListText() {
  const banksResp = await axios.get("https://api.paystack.co/bank", {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
  });
  return banksResp.data.data.slice(0, 15).map(b => `${b.code} - ${b.name}`).join("\n");
}

async function resolveBankAccount(accountNumber, bankCode) {
  const resolveResp = await axios.get(
    `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );
  return resolveResp.data.data.account_name;
}

async function createTransferRecipient(accountName, accountNumber, bankCode) {
  const resp = await axios.post(
    "https://api.paystack.co/transferrecipient",
    { type: "nuban", name: accountName, account_number: accountNumber, bank_code: bankCode, currency: "NGN" },
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );
  return resp.data.data.recipient_code;
}

async function initiatePaystackTransfer(recipientCode, amountKobo, reason, reference) {
  const resp = await axios.post(
    "https://api.paystack.co/transfer",
    { source: "balance", amount: amountKobo, recipient: recipientCode, reason, reference },
    { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
  );
  return resp.data.data;
}

// ---------------------------------------------------------------------
// CORE MESSAGE HANDLER — shared by WhatsApp and Telegram
// ---------------------------------------------------------------------
async function handleIncomingMessage(from, incomingMessage) {
  let replyText = "";

  try {
    let { data: user, error: findError } = await supabase.from("users").select("*").eq("whatsapp_number", from).single();

    if (findError && findError.code !== "PGRST116") {
      console.log("USER LOOKUP ERROR:", findError);
      return "Something went wrong on our end. Please try again shortly.";
    }

    if (!user) {
      const { data: newUser } = await supabase
        .from("users").insert({ whatsapp_number: from, conversation_state: "awaiting_pin_setup" }).select().single();
      await getOrCreateWallet(from);
      user = newUser;
      return "Welcome to CredaFI! To get started, please set a 4-digit PIN to secure your account. Reply with 4 digits (e.g. 1234).";
    }

    const state = user.conversation_state || "";

    // ---------------- UNIVERSAL 'MENU' ESCAPE HATCH ----------------
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
        replyText = "That doesn't look like a valid PIN. Please reply with exactly 4 digits (e.g. 1234).";
      } else {
        await setState(from, `awaiting_pin_confirm:${incomingMessage}`);
        replyText = "Please re-enter your 4-digit PIN to confirm it.";
      }

    } else if (state.startsWith("awaiting_pin_confirm:")) {
      const pendingPin = state.split(":")[1];
      if (incomingMessage !== pendingPin) {
        await setState(from, "awaiting_pin_setup");
        replyText = "PINs didn't match. Reply with a new 4-digit PIN (e.g. 1234).";
      } else {
        const hashedPin = await bcrypt.hash(incomingMessage, 10);
        await supabase.from("users").update({ pin_hash: hashedPin, conversation_state: "main_menu" }).eq("whatsapp_number", from);
        await getOrCreateWallet(from);
        replyText = `Your PIN is set!\n\nHello 👋\n${MENU_TEXT}`;
      }

    // ---------------- MAIN MENU ----------------
    } else if (state === "main_menu") {
      if (incomingMessage === "1") {
        const wallet = await getOrCreateWallet(from);
        replyText = `Your balance is N${(wallet.balance_kobo / 100).toFixed(2)}`;

      } else if (incomingMessage === "2") {
        await setState(from, "awaiting_fund_amount");
        replyText = "How much would you like to fund your wallet with? Reply with an amount in Naira (e.g. 1000).";

      } else if (incomingMessage === "3") {
        const { data: beneficiaries } = await supabase.from("beneficiaries").select("*").eq("owner_whatsapp_number", from).limit(8);
        let msg = "Who are you sending to?\n";
        if (beneficiaries && beneficiaries.length > 0) {
          msg += beneficiaries.map((b, i) =>
            `${i + 1}. ${b.nickname} (${b.type === "bank" ? b.account_name : "CredaFI user"})`
          ).join("\n") + "\n\n";
          msg += "Reply with a number above, or:\n";
        }
        msg += "Reply 'bank' to send to a new bank account, or 'user' to send to a new CredaFI user.";
        await setState(from, "awaiting_send_recipient_choice");
        replyText = msg;

      } else if (incomingMessage === "4") {
        const { data: beneficiaries } = await supabase.from("beneficiaries").select("*").eq("owner_whatsapp_number", from);
        let msg = "Beneficiaries:\n";
        if (!beneficiaries || beneficiaries.length === 0) {
          msg += "(none saved yet)\n";
        } else {
          msg += beneficiaries.map((b, i) =>
            `${i + 1}. ${b.nickname} — ${b.type === "bank" ? `${b.account_name} (${b.account_number})` : "CredaFI user"}`
          ).join("\n") + "\n";
        }
        msg += "\nReply 'add' to save a new beneficiary, or 'menu' to go back.";
        await setState(from, "beneficiaries_menu");
        replyText = msg;

      } else if (incomingMessage === "5") {
        const { data: txns } = await supabase
          .from("transactions").select("*").eq("whatsapp_number", from).order("created_at", { ascending: false }).limit(5);
        if (!txns || txns.length === 0) {
          replyText = "No transactions yet.";
        } else {
          const lines = txns.map(t => {
            const sign = t.type === "send" ? "-" : "+";
            const date = new Date(t.created_at).toLocaleDateString();
            return `${sign}N${(t.amount / 100).toFixed(2)} (${t.type}) — ${date}`;
          });
          replyText = "Last transactions:\n" + lines.join("\n");
        }

      } else if (incomingMessage === "6") {
        const wallet = await getOrCreateWallet(from);
        replyText =
          `Account details:\nNumber: ${from.replace("whatsapp:", "").replace("telegram:", "")}\n` +
          `Name: ${user.full_name || "(not set)"}\n` +
          `Balance: N${(wallet.balance_kobo / 100).toFixed(2)}\n` +
          `Bank verified: ${user.bank_account_number ? `Yes (${user.bank_name}, ${user.account_name})` : "No"}\n` +
          `BVN verified: ${user.bvn_verified ? "Yes" : "No"}\n` +
          `NIN verified: ${user.nin_verified ? "Yes" : "No"}`;

      } else if (incomingMessage === "7") {
        await setState(from, "awaiting_bank_code");
        replyText = "Reply with your bank's code (e.g. 058 for GTBank, 044 for Access Bank). Reply 'banks' if you need the full list.";

      } else if (incomingMessage === "8") {
        if (!user.full_name) {
          await setState(from, "awaiting_full_name_for_identity");
          replyText = "Let's verify your identity. First, what's your full name (First Last), exactly as it appears on your BVN/NIN records?";
        } else {
          await setState(from, "awaiting_bvn");
          replyText = `Verifying as ${user.full_name}. Reply with your 11-digit BVN.`;
        }

      } else if (incomingMessage === "9") {
        replyText =
          "Help:\n1 Check balance\n2 Fund wallet\n3 Send money\n4 Beneficiaries\n" +
          "5 Transaction history\n6 Account details\n7 Verify bank account\n8 Verify identity\n\n" +
          "Reply 'menu' anytime to see this list again.";

      } else if (incomingMessage.toLowerCase() === "menu") {
        replyText = MENU_TEXT;
      } else {
        replyText = "Sorry, I didn't understand that. Reply 'menu' to see your options.";
      }

    // ---------------- BENEFICIARIES ----------------
    } else if (state === "beneficiaries_menu") {
      if (incomingMessage.toLowerCase() === "add") {
        await setState(from, "awaiting_beneficiary_type");
        replyText = "Reply 'bank' to save a bank account, or 'user' to save another CredaFI user.";
      } else if (incomingMessage.toLowerCase() === "menu") {
        await setState(from, "main_menu");
        replyText = MENU_TEXT;
      } else {
        replyText = "Reply 'add' to save a new beneficiary, or 'menu' to go back.";
      }

    } else if (state === "awaiting_beneficiary_type") {
      if (incomingMessage.toLowerCase() === "bank") {
        await setState(from, "awaiting_beneficiary_bank_code");
        replyText = "Reply with the bank code (e.g. 058 for GTBank, 044 for Access Bank). Reply 'banks' for the full list.";
      } else if (incomingMessage.toLowerCase() === "user") {
        await setState(from, "awaiting_beneficiary_number");
        replyText = "Reply with their WhatsApp number (e.g. 2348012345678), or their Telegram ID prefixed with 'tg' (e.g. tg123456789).";
      } else {
        replyText = "Please reply 'bank' or 'user'.";
      }

    } else if (state === "awaiting_beneficiary_bank_code") {
      if (incomingMessage.toLowerCase() === "banks") {
        try {
          replyText = `Common bank codes:\n${await getBankListText()}\n\n(Reply with a code when ready)`;
        } catch (err) {
          replyText = "Couldn't fetch the bank list right now. Please reply with your bank code directly.";
        }
      } else {
        await setState(from, `awaiting_beneficiary_account_number:${incomingMessage.trim()}`);
        replyText = "Now reply with the 10-digit account number.";
      }

    } else if (state.startsWith("awaiting_beneficiary_account_number:")) {
      const bankCode = state.split(":")[1];
      const accountNumber = incomingMessage.replace(/\D/g, "");
      try {
        const accountName = await resolveBankAccount(accountNumber, bankCode);
        await setState(from, `awaiting_beneficiary_bank_nickname:${bankCode}:${accountNumber}:${accountName}`);
        replyText = `Account name: ${accountName}. What nickname should we save this as? (e.g. Mum, Landlord)`;
      } catch (err) {
        console.log("BENEFICIARY BANK RESOLVE ERROR:", err.response ? err.response.data : err.message);
        await setState(from, "main_menu");
        replyText = "Couldn't verify that account. Double check the bank code and account number, then try again from the beneficiaries menu.";
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
      replyText = "Saved! Reply 'menu' to continue.";

    } else if (state === "awaiting_beneficiary_number") {
      let identifier;
      if (incomingMessage.toLowerCase().startsWith("tg")) {
        identifier = `telegram:${incomingMessage.replace(/\D/g, "")}`;
      } else {
        identifier = `whatsapp:+${incomingMessage.replace(/\D/g, "")}`;
      }
      const { data: existingUser } = await supabase.from("users").select("whatsapp_number").eq("whatsapp_number", identifier).single();
      if (!existingUser) {
        replyText = "That user isn't registered on CredaFI yet. Reply with a different WhatsApp number/Telegram ID, or 'menu' to cancel.";
      } else {
        await setState(from, `awaiting_beneficiary_nickname:${identifier}`);
        replyText = "What nickname should we save this as? (e.g. Mum, Landlord)";
      }

    } else if (state.startsWith("awaiting_beneficiary_nickname:")) {
      const identifier = state.split(":").slice(1).join(":");
      await supabase.from("beneficiaries").insert({
        owner_whatsapp_number: from, type: "internal", beneficiary_number: identifier, nickname: incomingMessage,
      });
      await setState(from, "main_menu");
      replyText = "Saved! Reply 'menu' to continue.";

    // ---------------- SEND MONEY ----------------
    } else if (state === "awaiting_send_recipient_choice") {
      const { data: beneficiaries } = await supabase.from("beneficiaries").select("*").eq("owner_whatsapp_number", from).limit(8);
      const selectionIndex = parseInt(incomingMessage, 10);

      if (
        beneficiaries && beneficiaries.length > 0 &&
        /^\d{1,2}$/.test(incomingMessage) &&
        selectionIndex >= 1 && selectionIndex <= beneficiaries.length
      ) {
        const chosen = beneficiaries[selectionIndex - 1];
        if (chosen.type === "bank") {
          await setState(from, `awaiting_send_amount:bank:saved:${chosen.id}`);
        } else {
          await setState(from, `awaiting_send_amount:internal:${chosen.beneficiary_number}`);
        }
        replyText = `Sending to ${chosen.nickname}. How much would you like to send? Reply with an amount in Naira (e.g. 500).`;

      } else if (incomingMessage.toLowerCase() === "bank") {
        await setState(from, "awaiting_send_bank_code");
        replyText = "Reply with the bank code (e.g. 058 for GTBank, 044 for Access Bank). Reply 'banks' for the full list.";

      } else if (incomingMessage.toLowerCase() === "user") {
        await setState(from, "awaiting_send_user_identifier");
        replyText = "Reply with their WhatsApp number (e.g. 2348012345678), or their Telegram ID prefixed with 'tg' (e.g. tg123456789).";

      } else {
        replyText = "Please reply with a number from the list, or 'bank'/'user'.";
      }

    } else if (state === "awaiting_send_bank_code") {
      if (incomingMessage.toLowerCase() === "banks") {
        try {
          replyText = `Common bank codes:\n${await getBankListText()}\n\n(Reply with a code when ready)`;
        } catch (err) {
          replyText = "Couldn't fetch the bank list right now. Please reply with your bank code directly.";
        }
      } else {
        await setState(from, `awaiting_send_account_number:${incomingMessage.trim()}`);
        replyText = "Now reply with the 10-digit account number.";
      }

    } else if (state.startsWith("awaiting_send_account_number:")) {
      const bankCode = state.split(":")[1];
      const accountNumber = incomingMessage.replace(/\D/g, "");
      try {
        const accountName = await resolveBankAccount(accountNumber, bankCode);
        await setState(from, `awaiting_send_amount:bank:new:${bankCode}:${accountNumber}:${accountName}`);
        replyText = `Account name: ${accountName}. How much would you like to send? Reply with an amount in Naira (e.g. 500).`;
      } catch (err) {
        console.log("SEND BANK RESOLVE ERROR:", err.response ? err.response.data : err.message);
        await setState(from, "main_menu");
        replyText = "Couldn't verify that account. Double check the bank code and account number, then try again from the menu.";
      }

    } else if (state === "awaiting_send_user_identifier") {
      let identifier;
      if (incomingMessage.toLowerCase().startsWith("tg")) {
        identifier = `telegram:${incomingMessage.replace(/\D/g, "")}`;
      } else {
        identifier = `whatsapp:+${incomingMessage.replace(/\D/g, "")}`;
      }
      if (identifier === from) {
        replyText = "You can't send money to yourself. Reply with a different identifier, or 'menu' to cancel.";
      } else {
        const { data: recipient } = await supabase.from("users").select("whatsapp_number").eq("whatsapp_number", identifier).single();
        if (!recipient) {
          replyText = "That user isn't registered on CredaFI yet. Reply with a different WhatsApp number/Telegram ID, or 'menu' to cancel.";
        } else {
          await setState(from, `awaiting_send_amount:internal:${identifier}`);
          replyText = "How much would you like to send? Reply with an amount in Naira (e.g. 500).";
        }
      }

    // Amount entry — shared by all three recipient types (saved bank, new bank, internal)
    } else if (state.startsWith("awaiting_send_amount:")) {
      const parts = state.split(":");
      const kind = parts[1]; // "bank" or "internal"
      const amountNaira = parseFloat(incomingMessage);

      if (isNaN(amountNaira) || amountNaira <= 0) {
        replyText = "That doesn't look like a valid amount. Reply with a number, e.g. 500.";
      } else {
        const amountKobo = Math.round(amountNaira * 100);
        const senderWallet = await getOrCreateWallet(from);
        if (senderWallet.balance_kobo < amountKobo) {
          replyText = `Insufficient balance. Current balance: N${(senderWallet.balance_kobo / 100).toFixed(2)}. Reply 'menu' to go back.`;
          await setState(from, "main_menu");
        } else {
          await setState(from, `awaiting_send_pin:${parts.slice(1).join(":")}:${amountKobo}`);
          replyText = `Enter your 4-digit PIN to confirm sending N${amountNaira.toFixed(2)}.`;
        }
      }

    // PIN confirmation — executes the actual transfer
    } else if (state.startsWith("awaiting_send_pin:")) {
      const parts = state.split(":");
      const kind = parts[1]; // "bank" or "internal"
      const pinMatches = user.pin_hash && (await bcrypt.compare(incomingMessage, user.pin_hash));

      if (!pinMatches) {
        await setState(from, "main_menu");
        replyText = "Incorrect PIN. Transfer cancelled. Reply 'menu' to try again.";
      } else {
        const senderWallet = await getOrCreateWallet(from);

        if (kind === "internal") {
          // parts: ["internal", identifier..., amountKobo] — identifier may itself contain ":" (e.g. telegram:123)
          const amountKobo = parseInt(parts[parts.length - 1], 10);
          const recipientNumber = parts.slice(2, parts.length - 1).join(":");

          if (senderWallet.balance_kobo < amountKobo) {
            replyText = "Insufficient balance. Transfer cancelled.";
          } else {
            const recipientWallet = await getOrCreateWallet(recipientNumber);
            await supabase.from("wallets").update({ balance_kobo: senderWallet.balance_kobo - amountKobo }).eq("whatsapp_number", from);
            await supabase.from("wallets").update({ balance_kobo: recipientWallet.balance_kobo + amountKobo }).eq("whatsapp_number", recipientNumber);
            await logTransaction(from, "send", amountKobo, recipientNumber, null);
            await logTransaction(recipientNumber, "receive", amountKobo, from, null);

            replyText = `N${(amountKobo / 100).toFixed(2)} sent successfully!`;
            await sendMessage(recipientNumber, `You've received N${(amountKobo / 100).toFixed(2)} on CredaFI!`);
          }
          await setState(from, "main_menu");

        } else if (kind === "bank") {
          const source = parts[2]; // "saved" or "new"
          const amountKobo = parseInt(parts[parts.length - 1], 10);

          if (senderWallet.balance_kobo < amountKobo) {
            replyText = "Insufficient balance. Transfer cancelled.";
            await setState(from, "main_menu");
          } else {
            try {
              let recipientCode, accountName, bankCode, accountNumber, beneficiaryId = null;

              if (source === "saved") {
                beneficiaryId = parts[3];
                const { data: beneficiary } = await supabase.from("beneficiaries").select("*").eq("id", beneficiaryId).single();
                bankCode = beneficiary.bank_code;
                accountNumber = beneficiary.account_number;
                accountName = beneficiary.account_name;
                recipientCode = beneficiary.paystack_recipient_code;

                if (!recipientCode) {
                  recipientCode = await createTransferRecipient(accountName, accountNumber, bankCode);
                  await supabase.from("beneficiaries").update({ paystack_recipient_code: recipientCode }).eq("id", beneficiaryId);
                }
              } else {
                // "new": parts = ["bank","new",bankCode,accountNumber,...accountNameParts,amountKobo]
                bankCode = parts[3];
                accountNumber = parts[4];
                accountName = parts.slice(5, parts.length - 1).join(":");
                recipientCode = await createTransferRecipient(accountName, accountNumber, bankCode);
              }

              const reference = `credafi_transfer_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
              const transferResult = await initiatePaystackTransfer(recipientCode, amountKobo, "CredaFI transfer", reference);

              await supabase.from("wallets").update({ balance_kobo: senderWallet.balance_kobo - amountKobo }).eq("whatsapp_number", from);
              await logTransaction(from, "send", amountKobo, accountName, reference);

              replyText = `N${(amountKobo / 100).toFixed(2)} sent to ${accountName}! Status: ${transferResult.status}.`;

              if (source === "new") {
                await setState(from, `awaiting_save_beneficiary:${bankCode}:${accountNumber}:${accountName}`);
                replyText += "\n\nSave this account as a beneficiary for next time? Reply 'yes' or 'menu' to finish.";
              } else {
                await setState(from, "main_menu");
              }
            } catch (err) {
              console.log("TRANSFER ERROR:", err.response ? err.response.data : err.message);
              await setState(from, "main_menu");
              replyText = "Something went wrong sending this transfer. Please try again shortly, or reply 'menu'.";
            }
          }
        }
      }

    } else if (state.startsWith("awaiting_save_beneficiary:")) {
      if (incomingMessage.toLowerCase() === "yes") {
        const [, bankCode, accountNumber, ...nameParts] = state.split(":");
        const accountName = nameParts.join(":");
        await setState(from, `awaiting_beneficiary_bank_nickname:${bankCode}:${accountNumber}:${accountName}`);
        replyText = "What nickname should we save this as? (e.g. Mum, Landlord)";
      } else {
        await setState(from, "main_menu");
        replyText = "Okay! Reply 'menu' to continue.";
      }

    // ---------------- FUND WALLET ----------------
    } else if (state === "awaiting_fund_amount") {
      const amountNaira = parseFloat(incomingMessage);
      if (isNaN(amountNaira) || amountNaira <= 0) {
        replyText = "That doesn't look like a valid amount. Reply with a number, e.g. 1000.";
      } else {
        const amountKobo = Math.round(amountNaira * 100);
        const reference = `credafi_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
        const digitsOnly = from.replace(/\D/g, "");
        try {
          const paystackResponse = await axios.post(
            "https://api.paystack.co/transaction/initialize",
            { email: `${digitsOnly}@credafi.ng`, amount: amountKobo, reference },
            { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
          );
          const authUrl = paystackResponse.data.data.authorization_url;
          const { error: pendingError } = await supabase
            .from("pending_payments")
            .insert({ whatsapp_number: from, reference, amount_kobo: amountKobo, status: "pending" });
          console.log("PENDING PAYMENT CREATED:", { pendingError });
          replyText = `Tap the link below to complete your payment of N${amountNaira.toFixed(2)}:\n${authUrl}`;
        } catch (err) {
          console.log("PAYSTACK INIT ERROR:", err.response ? err.response.data : err.message);
          replyText = "Something went wrong starting your payment. Please try again shortly.";
        }
        await setState(from, "main_menu");
      }

    // ---------------- VERIFY BANK ACCOUNT (user's own account) ----------------
    } else if (state === "awaiting_bank_code") {
      if (incomingMessage.toLowerCase() === "banks") {
        try {
          replyText = `Common bank codes:\n${await getBankListText()}\n\n(Reply with a code when ready)`;
        } catch (err) {
          replyText = "Couldn't fetch the bank list right now. Please reply with your bank code directly.";
        }
      } else {
        await setState(from, `awaiting_account_number:${incomingMessage.trim()}`);
        replyText = "Now reply with your 10-digit account number.";
      }

    } else if (state.startsWith("awaiting_account_number:")) {
      const bankCode = state.split(":")[1];
      const accountNumber = incomingMessage.replace(/\D/g, "");
      try {
        const accountName = await resolveBankAccount(accountNumber, bankCode);
        await supabase.from("users").update({
          bank_account_number: accountNumber, bank_code: bankCode, account_name: accountName,
        }).eq("whatsapp_number", from);
        await setState(from, "main_menu");
        replyText = `Verified! Account name: ${accountName}. Reply 'menu' to continue.`;
      } catch (err) {
        console.log("BANK RESOLVE ERROR:", err.response ? err.response.data : err.message);
        await setState(from, "main_menu");
        replyText = "Couldn't verify that account. Double check the bank code and account number, then try again from the menu.";
      }

    // ---------------- VERIFY IDENTITY ----------------
    } else if (state === "awaiting_full_name_for_identity") {
      const fullName = incomingMessage.trim();
      if (fullName.split(" ").length < 2) {
        replyText = "Please reply with both your first and last name (e.g. Ada Okafor).";
      } else {
        await supabase.from("users").update({ full_name: fullName }).eq("whatsapp_number", from);
        await setState(from, "awaiting_bvn");
        replyText = `Thanks, ${fullName}. Now reply with your 11-digit BVN.`;
      }

    } else if (state === "awaiting_bvn") {
      const bvn = incomingMessage.replace(/\D/g, "");
      if (bvn.length !== 11) {
        replyText = "BVN should be exactly 11 digits. Please try again.";
      } else {
        const [firstname, ...rest] = user.full_name.split(" ");
        const lastname = rest.join(" ");
        try {
          const tokenResp = await axios.post("https://api.qoreid.com/token", {
            clientId: process.env.QOREID_CLIENT_ID,
            secret: process.env.QOREID_CLIENT_SECRET,
          });
          const accessToken = tokenResp.data.accessToken;

          const verifyResp = await axios.post(
            `https://api.qoreid.com/v1/ng/identities/bvn-basic/${bvn}`,
            { firstname, lastname },
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          const matched = verifyResp.data.summary && verifyResp.data.summary.bvn_check
            ? verifyResp.data.summary.bvn_check.status === "EXACT_MATCH"
            : true;

          if (!matched) {
            replyText = "That BVN didn't match the name on file. Please double check and try again, or reply 'menu' to cancel.";
          } else {
            await supabase.from("users").update({ bvn_verified: true }).eq("whatsapp_number", from);
            await setState(from, "awaiting_nin");
            replyText = "BVN verified! Now reply with your 11-digit NIN.";
          }
        } catch (err) {
          console.log("BVN VERIFY ERROR:", err.response ? err.response.data : err.message);
          replyText = "We couldn't verify that BVN right now. Please check the number and try again, or reply 'menu' to cancel.";
        }
      }

    } else if (state === "awaiting_nin") {
      const nin = incomingMessage.replace(/\D/g, "");
      if (nin.length !== 11) {
        replyText = "NIN should be exactly 11 digits. Please try again.";
      } else {
        const [firstname, ...rest] = user.full_name.split(" ");
        const lastname = rest.join(" ");
        try {
          const tokenResp = await axios.post("https://api.qoreid.com/token", {
            clientId: process.env.QOREID_CLIENT_ID,
            secret: process.env.QOREID_CLIENT_SECRET,
          });
          const accessToken = tokenResp.data.accessToken;

          const verifyResp = await axios.post(
            `https://api.qoreid.com/v1/ng/identities/nin/${nin}`,
            { firstname, lastname },
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          const matched = verifyResp.data.summary && verifyResp.data.summary.nin_check
            ? verifyResp.data.summary.nin_check.status === "EXACT_MATCH"
            : true;

          if (!matched) {
            replyText = "That NIN didn't match the name on file. Please double check and try again, or reply 'menu' to cancel.";
          } else {
            await supabase.from("users").update({ nin_verified: true }).eq("whatsapp_number", from);
            await setState(from, "main_menu");
            replyText = "Identity verified! Reply 'menu' to continue.";
          }
        } catch (err) {
          console.log("NIN VERIFY ERROR:", err.response ? err.response.data : err.message);
          replyText = "We couldn't verify that NIN right now. Please check the number and try again, or reply 'menu' to cancel.";
        }
      }

    // ---------------- FALLBACK ----------------
    } else {
      await setState(from, "main_menu");
      replyText = MENU_TEXT;
    }
  } catch (err) {
    console.log("UNEXPECTED ERROR:", err);
    replyText = "Something went wrong. Please try again shortly.";
  }

  return replyText;
}

// ---------------------------------------------------------------------
// WHATSAPP ROUTE
// ---------------------------------------------------------------------
app.post("/api/whatsapp", async (req, res) => {
  const incomingMessage = (req.body.Body || "").trim();
  const from = req.body.From;

  const replyText = await handleIncomingMessage(from, incomingMessage);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(replyText);
  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

// ---------------------------------------------------------------------
// TELEGRAM ROUTE
// ---------------------------------------------------------------------
app.post("/api/telegram/webhook", express.json(), async (req, res) => {
  try {
    const update = req.body;

    if (!update.message || !update.message.text) {
      return res.sendStatus(200);
    }

    const chatId = update.message.chat.id;
    const from = `telegram:${chatId}`;
    const incomingMessage = update.message.text.trim();

    const replyText = await handleIncomingMessage(from, incomingMessage);

    await sendMessage(from, replyText);
    res.sendStatus(200);
  } catch (err) {
    console.log("TELEGRAM WEBHOOK ERROR:", err);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));