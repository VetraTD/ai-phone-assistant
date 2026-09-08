// Moments in the real demo call, in order. `at` is the start of the
// receptionist's turn in seconds (the hero seeks there on "Hear it");
// `excerpt` is the receptionist's words verbatim, with "…" where a sentence
// has been left out. callMoments.test.js checks every fragment against the
// transcript, so an edited excerpt that no longer matches fails the build.

export const CALL_MOMENTS = [
  {
    at: 0,
    label: "0:00",
    does: "Answers in your name and says what it is.",
    excerpt:
      "Thank you for calling Apex Wellness Clinic. I'm the virtual assistant here. How can I help you today?",
  },
  {
    at: 15.88,
    label: "0:16",
    does: "Answers questions from the knowledge base you give it, including out of hours.",
    excerpt:
      "It runs for thirty minutes. The office is currently closed, but I can still book an appointment for you.",
  },
  {
    at: 75.06,
    label: "1:15",
    does: "Offers real free slots from your appointment book.",
    excerpt:
      "We have availability for a general GP consultation on Thursday, June 4 at 10AM or Friday, June 5 at 2PM.",
  },
  {
    at: 92.87,
    label: "1:33",
    does: "Takes the details it needs and reads them back before booking.",
    excerpt: "…could I please get your full name and a contact phone number to confirm the booking?",
  },
  {
    at: 129.2,
    label: "2:09",
    does: "Books it, then tells the caller your cancellation terms and what to bring.",
    excerpt:
      "Your general GP consultation is booked for Friday, June 5 at 2PM. … Please arrive ten minutes early to complete an intake form and bring a valid photo ID and any relevant medical records.",
  },
];

// Things it does on other calls that this one did not need.
export const OTHER_CALLS = [
  "Takes a message or a callback request when the caller needs a person.",
  "Transfers the call to you when your rules allow it: always, in business hours only, or never.",
  "Moves or cancels an appointment that is already in the book.",
  "Takes the details for a quote without ever quoting a price.",
];
