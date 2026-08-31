const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post("/api/whatsapp", (req, res) => {
  const incomingMessage = req.body.Body;

  const twiml = new twilio.twiml.MessagingResponse();

  if (incomingMessage.toLowerCase() === "hi") {
    twiml.message("Welcome to Credafi! Reply:\n1. Check balance\n2. Send money");
  } else if (incomingMessage === "1") {
    twiml.message("Your balance is ₦0.00 (test mode)");
  } else {
    twiml.message("Sorry, I didn't understand that. Reply 'hi' to start.");
  }

  res.set("Content-Type", "text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});