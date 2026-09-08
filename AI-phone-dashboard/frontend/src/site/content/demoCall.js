import transcript from "./demo-call.transcript.json";

// The real demo call and the two moments the diary page reacts to.
//
// The timestamps are the START of the receptionist turns in which the slots
// are offered and the booking is confirmed; demoCall.test.js checks that the
// words at those times say what this file claims, so a re-transcription that
// moves them fails loudly instead of silently mis-timing the diary.

export const DEMO_CALL = {
  transcript,
  clinic: "Apex Wellness Clinic",
  context: "After hours",
  moments: {
    // "We have availability … Thursday, June 4 at 10AM or Friday, June 5 at 2PM."
    offeredAt: 75.06,
    // "Your general GP consultation is booked for Friday, June 5 at 2PM."
    bookedAt: 129.2,
  },
  booking: {
    dayLabel: "Friday 5 June",
    hour: 14,
    time: "14:00",
    who: "Nathan Smith",
    what: "General GP consultation",
    minutes: 30,
  },
};

export const SPEAKER_LABELS = transcript.speakers;
