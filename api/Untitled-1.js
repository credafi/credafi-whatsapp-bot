const twilio = require("twilio");

module.exports = (req, res) => {
  const incomingMessage = req.body.Body;
  const senderNumber = req.body.From;

  const twiml = new twilio.twiml.MessagingResponse();

  if (incomingMessage.toLowerCase() === "hi") {
    twiml.message("Welcome to Credafi! Reply:\n1. Check balance\n2. Send money");
  } else if (incomingMessage === "1") {
    twiml.message("Your balance is ₦0.00 (test mode)");
  } else {
    twiml.message("Sorry, I didn't understand that. Reply 'hi' to start.");
  }

  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(twiml.toString());
};