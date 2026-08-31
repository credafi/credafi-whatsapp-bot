require("dotenv").config({ path: ".env.local" });
const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.urlencoded({ extended: false }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

async function getWalletBalance(userId) {
  const { data: wallet } = await supabase
    .from("wallets")
    .select("balance_kobo")
    .eq("user_id", userId)
    .single();

  return wallet ? wallet.balance_kobo : 0;
}

app.post("/api/whatsapp", async (req, res) => {
  const incomingMessage = req.body.Body;
  const senderNumber = req.body.From;

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const user = await getOrCreateUser(senderNumber);

    if (incomingMessage.toLowerCase() === "hi") {
      twiml.message("Welcome to Credafi! Reply:\n1. Check balance\n2. Send money");
    } else if (incomingMessage === "1") {
      const balanceKobo = await getWalletBalance(user.id);
      const balanceNaira = (balanceKobo / 100).toFixed(2);
      twiml.message(`Your balance is ₦${balanceNaira}`);
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