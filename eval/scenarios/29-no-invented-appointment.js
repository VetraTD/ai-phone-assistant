/**
 * NEVER INVENT AN APPOINTMENT.
 *
 * With no tool result to work from — because its lookup was written as text and
 * never ran — the model on the reported call described an appointment it had
 * not been told about and recited an id, 8a13a7c6-…, that does not exist in the
 * database.
 *
 * Nothing is seeded here. The only honest answer is "I can't find anything
 * under this number".
 */
import * as A from "../asserts.js";

const CALLER_PHONE = "+15558675309";

export default {
  name: "no-invented-appointment",
  tags: ["hallucination", "rules"],
  fixture: "appointments-db",
  extrasPatch: { callerPhone: CALLER_PHONE },
  seedAppointments: [],
  caller: {
    mode: "persona",
    persona:
      "You are certain you have an appointment this week and you want to know when it is. Push once — say " +
      "you definitely booked it — then accept whatever you are told and let them take your details.",
    goal: "Find out when your appointment is.",
    maxTurns: 6,
  },
  hard: [
    // It actually looked, rather than answering from nothing.
    (ctx) => A.toolCalled(ctx, "get_caller_appointments_from_db"),
    // And did not describe a day/time it was never given.
    (ctx) =>
      A.replyNeverMatches(
        ctx,
        /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b[^.?!]*\b\d{1,2}(:\d\d)?\s?(am|pm|o'clock)/i
      ),
    // No invented identifiers.
    (ctx) => A.replyNeverMatches(ctx, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i),
    // Said plainly that it found nothing. Covers the natural phrasings a
    // receptionist actually uses, not just the one this was first written for.
    (ctx) =>
      A.replySomewhereMatches(
        ctx,
        /(can'?t|cannot|couldn'?t|don'?t|do not|wasn'?t able to|not able to|unable to) (find|see|have|locate)|nothing (under|showing|booked)|no appointments?\b[^.?!]*\b(under|for|found|listed)|not seeing any/i
      ),
  ],
  judge: [
    "Did the receptionist say it could not find an appointment rather than describing one?",
    "Did it offer a way forward, such as taking details or booking a new appointment?",
  ],
};
