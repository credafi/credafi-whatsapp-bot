const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcryptjs");

const app = express();
app.use(express.urlencoded({ extended: false }));

// ---- Supabase connection ----
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ---- Main webhook Twilio calls on every incoming WhatsApp message ----
app.post("/api/whatsapp", async (req, res) => {
  const incomingMessage = (req.body.Body || "").trim();
  const from = req.body.From; // e.g. "whatsapp:+2348169945302"

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    // 1. Find this user, or create a new row if they've never messaged before
    let { data: user, error: findError } = await supabase
      .from("users")
      .select("*")
      .eq("whatsapp_number", from)
      .single();

    if (findError && findError.code !== "PGRST116") {
      // PGRST116 = "no row found", which is fine for a brand new user.
      // Any other error means something is actually wrong with the connection/table.
      console.log("USER LOOKUP ERROR:", findError);
      twiml.message("Something went wrong on our end. Please try again shortly.");
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    if (!user) {
      const { data: newUser, error: insertError } = await supabase
        .from("users")
        .insert({ whatsapp_number: from, conversation_state: "awaiting_pin_setup" })
        .select()
        .single();

      console.log("NEW USER CREATED:", { newUser, insertError });

      if (insertError) {
        twiml.message("Something went wrong setting up your account. Please try again.");
        res.set("Content-Type", "text/xml");
        return res.send(twiml.toString());
      }

      user = newUser;
      twiml.message("Welcome to Credafi! To get started, please set a 4-digit PIN to secure your account. Reply with 4 digits (e.g. 1234).");
      res.set("Content-Type", "text/xml");
      return res.send(twiml.toString());
    }

    const state = user.conversation_state;

    // 2. Route the message based on where this user currently is in the flow
    if (state === "awaiting_pin_setup") {
      if (!/^\d{4}$/.test(incomingMessage)) {
        twiml.message("That doesn't look like a valid PIN. Please reply with exactly 4 digits (e.g. 1234).");
      } else {
        // Temporarily store the PIN attempt in conversation_state so we can compare it on confirm.
        // (We do NOT hash it yet — we hash only once it's confirmed, below.)
        const { data, error } = await supabase
          .from("users")
          .update({
            conversation_state: `awaiting_pin_confirm:${incomingMessage}`,
          })
          .eq("whatsapp_number", from);

        console.log("PIN FIRST ENTRY SAVE:", { data, error });

        if (error) {
          twiml.message("Something went wrong saving your PIN. Please try again.");
        } else {
          twiml.message("Please re-enter your 4-digit PIN to confirm it.");
        }
      }
    } else if (state && state.startsWith("awaiting_pin_confirm:")) {
      const pendingPin = state.split(":")[1];

      if (incomingMessage !== pendingPin) {
        // Confirmation didn't match — send them back to the start of PIN setup.
        const { data, error } = await supabase
          .from("users")
          .update({ conversation_state: "awaiting_pin_setup" })
          .eq("whatsapp_number", from);

        console.log("PIN MISMATCH RESET:", { data, error });

        twiml.message("PINs didn't match. Let's try again — reply with a new 4-digit PIN (e.g. 1234).");
      } else {
        const hashedPin = await bcrypt.hash(incomingMessage, 10);

        const { data, error } = await supabase
          .from("users")
          .update({
            pin_hash: hashedPin,
            conversation_state: "main_menu",
          })
          .eq("whatsapp_number", from);

        console.log("PIN CONFIRMED SAVE:", { data, error });

        if (error) {
          twiml.message("Something went wrong saving your PIN. Please try again.");
        } else {
          twiml.message(
            "Your PIN is set! Welcome to Credafi. Reply:\n1. Check balance\n2. Send money\n3. Fund account"
          );
        }
      }
    } else if (state === "main_menu") {
      if (incomingMessage === "1") {
        const { data: wallet, error } = await supabase
          .from("wallets")
          .select("balance")
          .eq("whatsapp_number", from)
          .single();

        console.log("BALANCE LOOKUP:", { wallet, error });

        const balanceNaira = wallet ? (wallet.balance / 100).toFixed(2) : "0.00";
        twiml.message(`Your balance is ₦${balanceNaira}`);
      } else if (incomingMessage === "2") {
        twiml.message("Send money flow is coming soon.");
      } else if (incomingMessage === "3") {
        twiml.message("Fund account flow is coming soon.");
      } else if (incomingMessage.toLowerCase() === "menu") {
        twiml.message("Reply:\n1. Check balance\n2. Send money\n3. Fund account");
      } else {
        twiml.message("Sorry, I didn't understand that. Reply 'menu' to see your options.");
      }
    } else {
      // Fallback for any unexpected state — reset them safely to the menu.
      await supabase
        .from("users")
        .update({ conversation_state: "main_menu" })
        .eq("whatsapp_number", from);

      twiml.message("Reply:\n1. Check balance\n2. Send money\n3. Fund account");
    }
  } catch (err) {
    console.log("UNEXPECTED ERROR:", err);
    twiml.message("Something went wrong. Please try again shortly.");
  }

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});