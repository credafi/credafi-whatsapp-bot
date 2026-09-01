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
  "CredAfri\nWhat do you want to do?\n" +
  "1. Check balance\n2. Fund wallet\n3. Send money\n4. Beneficiaries\n" +
  "5. Transaction history\n6. Account details\n7. Verify bank account\n" +
  "8. Verify identity\n9. Help";

// ---------------------------------------------------------------------
// PAYSTACK WEBHOOK — registered before express.urlencoded so we get the
// raw body needed to verify the signature.
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
        const whatsappNumber = pending.whatsapp_number;
        const wallet = await getOrCreateWallet(whatsappNumber);
        const newBalance = wallet.balance_kobo + amountKobo;

        await supabase.from("wallets").update({ balance_kobo: newBalance }).eq("whatsapp_number", whatsappNumber);
        await supabase.from("pending_payments").update({ status: "success" }).eq("reference", reference);
        await logTransaction(whatsappNumber, "fund", amountKobo, null, reference);

        await twilioClient.messages.create({
          from: process.env.TWILIO_WHATSAPP_NUMBER,
          to: whatsappNumber,
          body: `Payment confirmed! N${(amountKobo / 100).toFixed(2)} has been added to your wallet.`,
        });
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
async function getOrCreateWallet(whatsappNumber) {
  const { data: wallet, error: findError } = await supabase
    .from("wallets").select("*").eq("whatsapp_number", whatsappNumber).maybeSingle();

  if (findError) console.log("WALLET LOOKUP ERROR:", findError);
  if (wallet) return wallet;

  const { data: newWallet, error: insertError } = await supabase
    .from("wallets").insert({ whatsapp_number: whatsappNumber, balance_kobo: 0 }).select().single();

  if (insertError) console.log("WALLET CREATE ERROR:", insertError);
  return newWallet || { whatsapp_number: whatsappNumber, balance_kobo: 0 };
}

async function logTransaction(whatsappNumber, type, amountKobo, counterparty, reference) {
  const { error } = await supabase.from("transactions").insert({
    whatsapp_number: whatsappNumber, type, amount: amountKobo, counterparty, reference,
  });
  console.log("TRANSACTION LOGGED:", { type, amountKobo, error });
}

async function setState(whatsappNumber, state) {
  await supabase.from("users").update({ conversation_state: state }).eq("whatsapp_number", whatsappNumber);
}

app.post("/api/whatsapp", async (req, res) => {
  const incomingMessage = (req.body.Body || "").trim();
  const from = req.body.From;
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    let { data: user, error: findError } = await supabase.from("users").select("*").eq("whatsapp_number", from).single();

    if (findError && findError.code !== "PGRST116") {
      console.log("USER LOOKUP ERROR:", findError);
      twiml.message("Something went wrong on our end. Please try again shortly.");
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    if (!user) {
      const { data: newUser } = await supabase
        .from("users").insert({ whatsapp_number: from, conversation_state: "awaiting_pin_setup" }).select().single();
      await getOrCreateWallet(from);
      user = newUser;
      twiml.message("Welcome to CredAfri! To get started, please set a 4-digit PIN to secure your account. Reply with 4 digits (e.g. 1234).");
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    const state = user.conversation_state || "";

    // ---------------- UNIVERSAL 'MENU' ESCAPE HATCH ----------------
    // Typing 'menu' always cancels whatever flow you're mid-way through
    // and resets to the main menu — except during PIN setup/confirm,
    // since a PIN could legitimately contain digits that spell nothing here,
    // but we still don't want 'menu' hijacked as a PIN attempt either.
    if (
      incomingMessage.toLowerCase() === "menu" &&
      state !== "awaiting_pin_setup" &&
      !state.startsWith("awaiting_pin_confirm:")
    ) {
      await setState(from, "main_menu");
      twiml.message(MENU_TEXT);
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    // ---------------- PIN SETUP ----------------
    if (state === "awaiting_pin_setup") {
      if (!/^\d{4}$/.test(incomingMessage)) {
        twiml.message("That doesn't look like a valid PIN. Please reply with exactly 4 digits (e.g. 1234).");
      } else {
        await setState(from, `awaiting_pin_confirm:${incomingMessage}`);
        twiml.message("Please re-enter your 4-digit PIN to confirm it.");
      }

    } else if (state.startsWith("awaiting_pin_confirm:")) {
      const pendingPin = state.split(":")[1];
      if (incomingMessage !== pendingPin) {
        await setState(from, "awaiting_pin_setup");
        twiml.message("PINs didn't match. Reply with a new 4-digit PIN (e.g. 1234).");
      } else {
        const hashedPin = await bcrypt.hash(incomingMessage, 10);
        await supabase.from("users").update({ pin_hash: hashedPin, conversation_state: "main_menu" }).eq("whatsapp_number", from);
        await getOrCreateWallet(from);
        twiml.message(`Your PIN is set!\n\nHello 👋\n${MENU_TEXT}`);
      }

    // ---------------- MAIN MENU ----------------
    } else if (state === "main_menu") {
      if (incomingMessage === "1") {
        const wallet = await getOrCreateWallet(from);
        twiml.message(`Your balance is N${(wallet.balance_kobo / 100).toFixed(2)}`);

      } else if (incomingMessage === "2") {
        await setState(from, "awaiting_fund_amount");
        twiml.message("How much would you like to fund your wallet with? Reply with an amount in Naira (e.g. 1000).");

      } else if (incomingMessage === "3") {
        const { data: beneficiaries } = await supabase.from("beneficiaries").select("*").eq("owner_whatsapp_number", from).limit(5);
        let msg = "Who are you sending to? Reply with their WhatsApp number (e.g. 2348012345678).";
        if (beneficiaries && beneficiaries.length > 0) {
          msg += "\n\nOr reply with a saved beneficiary number:\n" +
            beneficiaries.map((b, i) => `${i + 1}. ${b.nickname || b.beneficiary_number}`).join("\n");
        }
        await setState(from, "awaiting_send_recipient");
        twiml.message(msg);

      } else if (incomingMessage === "4") {
        const { data: beneficiaries } = await supabase.from("beneficiaries").select("*").eq("owner_whatsapp_number", from);
        let msg = "Beneficiaries:\n";
        if (!beneficiaries || beneficiaries.length === 0) {
          msg += "(none saved yet)\n";
        } else {
          msg += beneficiaries.map((b, i) => `${i + 1}. ${b.nickname || ""} ${b.beneficiary_number}`).join("\n") + "\n";
        }
        msg += "\nReply 'add' to save a new beneficiary, or 'menu' to go back.";
        await setState(from, "beneficiaries_menu");
        twiml.message(msg);

      } else if (incomingMessage === "5") {
        const { data: txns } = await supabase
          .from("transactions").select("*").eq("whatsapp_number", from).order("created_at", { ascending: false }).limit(5);
        if (!txns || txns.length === 0) {
          twiml.message("No transactions yet.");
        } else {
          const lines = txns.map(t => {
            const sign = t.type === "send" ? "-" : "+";
            const date = new Date(t.created_at).toLocaleDateString();
            return `${sign}N${(t.amount / 100).toFixed(2)} (${t.type}) — ${date}`;
          });
          twiml.message("Last transactions:\n" + lines.join("\n"));
        }

      } else if (incomingMessage === "6") {
        const wallet = await getOrCreateWallet(from);
        twiml.message(
          `Account details:\nNumber: ${from.replace("whatsapp:", "")}\n` +
          `Name: ${user.full_name || "(not set)"}\n` +
          `Balance: N${(wallet.balance_kobo / 100).toFixed(2)}\n` +
          `Bank verified: ${user.bank_account_number ? `Yes (${user.bank_name}, ${user.account_name})` : "No"}\n` +
          `BVN verified: ${user.bvn_verified ? "Yes" : "No"}\n` +
          `NIN verified: ${user.nin_verified ? "Yes" : "No"}`
        );

      } else if (incomingMessage === "7") {
        await setState(from, "awaiting_bank_code");
        twiml.message("Reply with your bank's code (e.g. 058 for GTBank, 044 for Access Bank). Reply 'banks' if you need the full list.");

      } else if (incomingMessage === "8") {
        await setState(from, "awaiting_bvn");
        twiml.message("Let's verify your identity. Reply with your 11-digit BVN.");

      } else if (incomingMessage === "9") {
        twiml.message(
          "Help:\n1 Check balance\n2 Fund wallet\n3 Send money\n4 Beneficiaries\n" +
          "5 Transaction history\n6 Account details\n7 Verify bank account\n8 Verify identity\n\n" +
          "Reply 'menu' anytime to see this list again."
        );

      } else if (incomingMessage.toLowerCase() === "menu") {
        twiml.message(MENU_TEXT);
      } else {
        twiml.message("Sorry, I didn't understand that. Reply 'menu' to see your options.");
      }

    // ---------------- BENEFICIARIES ----------------
    } else if (state === "beneficiaries_menu") {
      if (incomingMessage.toLowerCase() === "add") {
        await setState(from, "awaiting_beneficiary_number");
        twiml.message("Reply with the WhatsApp number to save (e.g. 2348012345678).");
      } else if (incomingMessage.toLowerCase() === "menu") {
        await setState(from, "main_menu");
        twiml.message(MENU_TEXT);
      } else {
        twiml.message("Reply 'add' to save a new beneficiary, or 'menu' to go back.");
      }

    } else if (state === "awaiting_beneficiary_number") {
      const beneficiaryNumber = `whatsapp:+${incomingMessage.replace(/\D/g, "")}`;
      await setState(from, `awaiting_beneficiary_nickname:${beneficiaryNumber}`);
      twiml.message("What nickname should we save this as? (e.g. Mum, Landlord)");

    } else if (state.startsWith("awaiting_beneficiary_nickname:")) {
      const beneficiaryNumber = state.split(":").slice(1).join(":");
      await supabase.from("beneficiaries").insert({
        owner_whatsapp_number: from, beneficiary_number: beneficiaryNumber, nickname: incomingMessage,
      });
      await setState(from, "main_menu");
      twiml.message(`Saved! Reply 'menu' to continue.`);

    // ---------------- SEND MONEY ----------------
    } else if (state === "awaiting_send_recipient") {
      const { data: beneficiaries } = await supabase.from("beneficiaries").select("*").eq("owner_whatsapp_number", from);
      const selectionIndex = parseInt(incomingMessage, 10);
      let recipientNumber;

      if (
        beneficiaries && beneficiaries.length > 0 &&
        /^\d{1,2}$/.test(incomingMessage) &&
        selectionIndex >= 1 && selectionIndex <= beneficiaries.length
      ) {
        recipientNumber = beneficiaries[selectionIndex - 1].beneficiary_number;
      } else {
        const digitsOnly = incomingMessage.replace(/\D/g, "");
        recipientNumber = `whatsapp:+${digitsOnly}`;
      }

      if (recipientNumber === from) {
        twiml.message("You can't send money to yourself. Reply with a different number, or 'menu' to cancel.");
      } else {
        const { data: recipient } = await supabase.from("users").select("whatsapp_number").eq("whatsapp_number", recipientNumber).single();
        if (!recipient) {
          twiml.message("That number isn't a registered CredAfri user yet. Reply with a different number, or 'menu' to cancel.");
        } else {
          await setState(from, `awaiting_send_amount:${recipientNumber}`);
          twiml.message("How much would you like to send? Reply with an amount in Naira (e.g. 500).");
        }
      }

    } else if (state.startsWith("awaiting_send_amount:")) {
      const recipientNumber = state.split(":").slice(1).join(":");
      const amountNaira = parseFloat(incomingMessage);
      if (isNaN(amountNaira) || amountNaira <= 0) {
        twiml.message("That doesn't look like a valid amount. Reply with a number, e.g. 500.");
      } else {
        const amountKobo = Math.round(amountNaira * 100);
        const senderWallet = await getOrCreateWallet(from);
        if (senderWallet.balance_kobo < amountKobo) {
          twiml.message(`Insufficient balance. Current balance: N${(senderWallet.balance_kobo / 100).toFixed(2)}. Reply 'menu' to go back.`);
          await setState(from, "main_menu");
        } else {
          await setState(from, `awaiting_send_pin:${recipientNumber}:${amountKobo}`);
          twiml.message(`Enter your 4-digit PIN to confirm sending N${amountNaira.toFixed(2)}.`);
        }
      }

    } else if (state.startsWith("awaiting_send_pin:")) {
      const [, recipientNumber, amountKoboStr] = state.split(":");
      const amountKobo = parseInt(amountKoboStr, 10);
      const pinMatches = user.pin_hash && (await bcrypt.compare(incomingMessage, user.pin_hash));

      if (!pinMatches) {
        await setState(from, "main_menu");
        twiml.message("Incorrect PIN. Transfer cancelled. Reply 'menu' to try again.");
      } else {
        const senderWallet = await getOrCreateWallet(from);
        if (senderWallet.balance_kobo < amountKobo) {
          twiml.message("Insufficient balance. Transfer cancelled.");
        } else {
          const recipientWallet = await getOrCreateWallet(recipientNumber);
          await supabase.from("wallets").update({ balance_kobo: senderWallet.balance_kobo - amountKobo }).eq("whatsapp_number", from);
          await supabase.from("wallets").update({ balance_kobo: recipientWallet.balance_kobo + amountKobo }).eq("whatsapp_number", recipientNumber);
          await logTransaction(from, "send", amountKobo, recipientNumber, null);
          await logTransaction(recipientNumber, "receive", amountKobo, from, null);

          twiml.message(`N${(amountKobo / 100).toFixed(2)} sent successfully!`);
          await twilioClient.messages.create({
            from: process.env.TWILIO_WHATSAPP_NUMBER, to: recipientNumber,
            body: `You've received N${(amountKobo / 100).toFixed(2)} on CredAfri!`,
          });
        }
        await setState(from, "main_menu");
      }

    // ---------------- FUND WALLET ----------------
    } else if (state === "awaiting_fund_amount") {
      const amountNaira = parseFloat(incomingMessage);
      if (isNaN(amountNaira) || amountNaira <= 0) {
        twiml.message("That doesn't look like a valid amount. Reply with a number, e.g. 1000.");
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
          twiml.message(`Tap the link below to complete your payment of N${amountNaira.toFixed(2)}:\n${authUrl}`);
        } catch (err) {
          console.log("PAYSTACK INIT ERROR:", err.response ? err.response.data : err.message);
          twiml.message("Something went wrong starting your payment. Please try again shortly.");
        }
        await setState(from, "main_menu");
      }

    // ---------------- VERIFY BANK ACCOUNT ----------------
    } else if (state === "awaiting_bank_code") {
      if (incomingMessage.toLowerCase() === "banks") {
        try {
          const banksResp = await axios.get("https://api.paystack.co/bank", {
            headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
          });
          const list = banksResp.data.data.slice(0, 15).map(b => `${b.code} - ${b.name}`).join("\n");
          twiml.message(`Common bank codes:\n${list}\n\n(Reply with a code when ready)`);
        } catch (err) {
          twiml.message("Couldn't fetch the bank list right now. Please reply with your bank code directly.");
        }
      } else {
        await setState(from, `awaiting_account_number:${incomingMessage.trim()}`);
        twiml.message("Now reply with your 10-digit account number.");
      }

    } else if (state.startsWith("awaiting_account_number:")) {
      const bankCode = state.split(":")[1];
      const accountNumber = incomingMessage.replace(/\D/g, "");
      try {
        const resolveResp = await axios.get(
          `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
          { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
        );
        const accountName = resolveResp.data.data.account_name;
        await supabase.from("users").update({
          bank_account_number: accountNumber, bank_code: bankCode, account_name: accountName,
        }).eq("whatsapp_number", from);
        await setState(from, "main_menu");
        twiml.message(`Verified! Account name: ${accountName}. Reply 'menu' to continue.`);
      } catch (err) {
        console.log("BANK RESOLVE ERROR:", err.response ? err.response.data : err.message);
        await setState(from, "main_menu");
        twiml.message("Couldn't verify that account. Double check the bank code and account number, then try again from the menu.");
      }

    // ---------------- VERIFY IDENTITY (BVN then NIN) ----------------
    // NOTE: Paystack does not verify BVN/NIN directly. This calls a generic
    // placeholder endpoint — sign up with a provider (QoreID, Youverify, or
    // Prembly all work well for Nigeria) and set IDENTITY_API_URL and
    // IDENTITY_API_KEY in Render. Adjust the field names below (idNumber,
    // firstName etc.) to match whichever provider's actual response shape.
    } else if (state === "awaiting_bvn") {
      const bvn = incomingMessage.replace(/\D/g, "");
      if (bvn.length !== 11) {
        twiml.message("BVN should be exactly 11 digits. Please try again.");
      } else {
        try {
          await axios.post(
            process.env.IDENTITY_API_URL + "/bvn",
            { idNumber: bvn },
            { headers: { Authorization: `Bearer ${process.env.IDENTITY_API_KEY}` } }
          );
          // We deliberately do NOT store the raw BVN — only that it passed.
          await supabase.from("users").update({ bvn_verified: true }).eq("whatsapp_number", from);
          await setState(from, "awaiting_nin");
          twiml.message("BVN verified! Now reply with your 11-digit NIN.");
        } catch (err) {
          console.log("BVN VERIFY ERROR:", err.response ? err.response.data : err.message);
          twiml.message("We couldn't verify that BVN. Please check the number and try again, or reply 'menu' to cancel.");
        }
      }

    } else if (state === "awaiting_nin") {
      const nin = incomingMessage.replace(/\D/g, "");
      if (nin.length !== 11) {
        twiml.message("NIN should be exactly 11 digits. Please try again.");
      } else {
        try {
          await axios.post(
            process.env.IDENTITY_API_URL + "/nin",
            { idNumber: nin },
            { headers: { Authorization: `Bearer ${process.env.IDENTITY_API_KEY}` } }
          );
          await supabase.from("users").update({ nin_verified: true }).eq("whatsapp_number", from);
          await setState(from, "main_menu");
          twiml.message("Identity verified! Reply 'menu' to continue.");
        } catch (err) {
          console.log("NIN VERIFY ERROR:", err.response ? err.response.data : err.message);
          twiml.message("We couldn't verify that NIN. Please check the number and try again, or reply 'menu' to cancel.");
        }
      }

    // ---------------- FALLBACK ----------------
    } else {
      await setState(from, "main_menu");
      twiml.message(MENU_TEXT);
    }
  } catch (err) {
    console.log("UNEXPECTED ERROR:", err);
    twiml.message("Something went wrong. Please try again shortly.");
  }

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));