require("dotenv").config({ path: ".env.local" });
const express = require("express");
const twilio = require("twilio");
const bcrypt = require("bcryptjs");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.urlencoded({ extended: false }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MAX_ATTEMPTS = 3;
const LOCK_MINUTES = 5;

async function getOrCreateUser(whatsappNumber) {
  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("whatsapp_number", whatsappNumber)
    .single();

  if (!user) {
    const { data: newUser } = await supabase
      .from("users")
      .insert({ whatsapp_number: whatsappNumber })
      .select()
      .single();

    user = newUser;
    await supabase.from("wallets").insert({ user_id: user.id, balance_kobo: 0 });
  }

  return user;
}

async function updateUser(userId, fields) {
  await supabase.from("users").update(fields).eq("id", userId);
}

async function getWalletBalance(userId) {
  const { data: wallet } = await supabase
    .from("wallets")
    .select("balance_kobo")
    .eq("user_id", userId)
    .single();

  return wallet ? wallet.balance_kobo : 0;
}

function isValidPinFormat(text) {
  return /^\d{4}$/.test(text);
}

function isValidAmount(text) {
  return /^\d+$/.test(text) && parseInt(text, 10) >= 100;
}

function isLocked(user) {
  return user.locked_until && new Date(user.locked_until) > new Date();
}

async function createPaystackPaymentLink(user, amountKobo) {
  const reference = `credafi_${user.id.slice(0, 8)}_${Date.now()}`;
  const fakeEmail = `${user.whatsapp_number.replace(/\D/g, "")}@credafi.temp`;

  const response = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    {
      email: fakeEmail,
      amount: amountKobo,
      reference: reference,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  await supabase.from("pending_payments").insert({
    reference: reference,
    user_id: user.id,
    amount_kobo: amountKobo,
    status: "pending",
  });

  return response.data.data.authorization_url;
}

app.post("/api/whatsapp", async (req, res) => {
  const incomingMessage = (req.body.Body || "").trim();
  const senderNumber = req.body.From;

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    let user = await getOrCreateUser(senderNumber);

    if (isLocked(user)) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      twiml.message(`Too many wrong PIN attempts. Please try again in ${minutesLeft} minute(s).`);
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    if (!user.pin_hash && user.conversation_state !== "awaiting_pin_setup" && user.conversation_state !== "awaiting_pin_confirm") {
      await updateUser(user.id, { conversation_state: "awaiting_pin_setup" });
      twiml.message("Welcome to Credafi! To get started, please set a 4-digit PIN to secure your account. Reply with 4 digits (e.g. 1234).");
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    if (user.conversation_state === "awaiting_pin_setup") {
      if (!isValidPinFormat(incomingMessage)) {
        twiml.message("That doesn't look like a valid PIN. Please reply with exactly 4 digits (e.g. 1234).");
      } else {
        await updateUser(user.id, { conversation_state: `awaiting_pin_confirm:${incomingMessage}` });
        twiml.message("Please re-enter your 4-digit PIN to confirm it.");
      }
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    if (user.conversation_state && user.conversation_state.startsWith("awaiting_pin_confirm:")) {
      const firstPin = user.conversation_state.split(":")[1];

      if (incomingMessage !== firstPin) {
        await updateUser(user.id, { conversation_state: "awaiting_pin_setup" });
        twiml.message("PINs didn't match. Let's try again — reply with a 4-digit PIN.");
      } else {
        const hashedPin = await bcrypt.hash(firstPin, 10);
        await updateUser(user.id, { pin_hash: hashedPin, conversation_state: null });
        twiml.message("PIN set successfully! Reply:\n1. Check balance\n2. Fund wallet\n3. Send money");
      }
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    // PIN verify, then branch based on what they were trying to do
    if (user.conversation_state && user.conversation_state.startsWith("awaiting_pin_verify:")) {
      const nextAction = user.conversation_state.split(":")[1];
      const pinMatches = await bcrypt.compare(incomingMessage, user.pin_hash);

      if (!pinMatches) {
        const newAttempts = (user.failed_pin_attempts || 0) + 1;

        if (newAttempts >= MAX_ATTEMPTS) {
          const lockUntil = new Date(Date.now() + LOCK_MINUTES * 60000).toISOString();
          await updateUser(user.id, { failed_pin_attempts: 0, locked_until: lockUntil, conversation_state: null });
          twiml.message(`Wrong PIN too many times. Account locked for ${LOCK_MINUTES} minutes.`);
        } else {
          await updateUser(user.id, { failed_pin_attempts: newAttempts });
          twiml.message(`Incorrect PIN. ${MAX_ATTEMPTS - newAttempts} attempt(s) left.`);
        }
        res.set("Content-Type", "text/xml");
        return res.send(twiml.toString());
      }

      await updateUser(user.id, { failed_pin_attempts: 0 });

      if (nextAction === "fund") {
        await updateUser(user.id, { conversation_state: "awaiting_fund_amount" });
        twiml.message("How much would you like to fund? Reply with an amount in Naira (e.g. 1000 for ₦1,000).");
      } else if (nextAction === "send") {
        await updateUser(user.id, { conversation_state: null });
        twiml.message("PIN verified! (Send money feature coming soon.)");
      }
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    // Amount entry for funding
    if (user.conversation_state === "awaiting_fund_amount") {
      if (!isValidAmount(incomingMessage)) {
        twiml.message("Please enter a valid amount in Naira (minimum ₦1), numbers only, e.g. 1000.");
      } else {
        const amountKobo = parseInt(incomingMessage, 10) * 100;
        const paymentUrl = await createPaystackPaymentLink(user, amountKobo);
        await updateUser(user.id, { conversation_state: null });
        twiml.message(`Tap this link to complete your ₦${incomingMessage} payment:\n${paymentUrl}\n\nYour balance will update automatically once payment is confirmed.`);
      }
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    // Normal menu
    if (incomingMessage.toLowerCase() === "hi") {
      twiml.message("Welcome back to Credafi! Reply:\n1. Check balance\n2. Fund wallet\n3. Send money");
    } else if (incomingMessage === "1") {
      const balanceKobo = await getWalletBalance(user.id);
      const balanceNaira = (balanceKobo / 100).toFixed(2);
      twiml.message(`Your balance is ₦${balanceNaira}`);
    } else if (incomingMessage === "2") {
      await updateUser(user.id, { conversation_state: "awaiting_pin_verify:fund" });
      twiml.message("Please enter your 4-digit PIN to continue.");
    } else if (incomingMessage === "3") {
      await updateUser(user.id, { conversation_state: "awaiting_pin_verify:send" });
      twiml.message("Please enter your 4-digit PIN to continue.");
    } else {
      twiml.message("Sorry, I didn't understand that. Reply 'hi' to start.");
    }
  } catch (error) {
    console.error("Error:", error);
    twiml.message("Something went wrong. Please try again.");
  }

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});