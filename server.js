import express from "express";

const app = express();
const PORT = 3000;

app.use(express.urlencoded({ extended: false }));

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
    <Response>
      <Say voice="Polly.Joanna">
        Hello. Thank you for calling. This is your AI receptionist.
      </Say>
    </Response>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});



