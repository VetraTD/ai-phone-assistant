/**
 * PERSONA: the caller starts out booking an appointment, then abandons it
 * partway through and asks for something categorically different — leaving a
 * message for a person instead.
 *
 * This guards mid-call intent switching, which set_call_intent is the only
 * mechanism for (see the "confirm" step guidance in services/gemini.js: "If
 * they ask for something new, call set_call_intent for the new request").
 *
 * Why it exists: the 2026-08-04 latency run showed the model calls
 * set_call_intent before speaking on EVERY turn, including turns where the
 * intent had not changed, and that redundant round-trip is roughly a third of
 * total voice-to-voice latency. The obvious fix — stop re-calling it once an
 * intent is set — would break exactly this scenario, and nothing in the suite
 * covered it. 16-changes-mind looks similar but only changes the TIME within
 * one intent; the intent itself never moves.
 *
 * So: this must pass BEFORE any prompt change, or it isn't a guard at all.
 */
import * as A from "../asserts.js";

export default {
  name: "intent-switch-midcall",
  tags: ["persona"],
  fixture: "appointments-db",
  caller: {
    mode: "persona",
    persona:
      "You are Marcus Webb, friendly but easily sidetracked. You give your name as Marcus Webb when asked.",
    goal:
      "Start by asking to book a cleaning appointment for next Tuesday morning. " +
      "After the receptionist responds and asks you anything, change course completely: say " +
      "actually never mind the appointment, you'd rather just leave a message for the office " +
      "manager asking them to call you back about a billing question on your last visit. " +
      "Do not agree to book anything after that.",
    maxTurns: 8,
  },
  hard: [
    // The switch itself must be registered. Without it the engine's step
    // machine stays in the appointments flow and the caller is answered from
    // the wrong script for the rest of the call. This passes today and must
    // keep passing — it is the reason this scenario exists.
    (ctx) =>
      A.toolCalledWith(
        ctx,
        "set_call_intent",
        (args) => args.intent === "take_message" || args.intent === "callback_request",
        "intent switched to take_message/callback_request"
      ),
    // Abandoning the booking means not booking it.
    (ctx) => A.toolNotCalled(ctx, "book_appointment"),
    // NOTE, deliberately not asserted: this call makes set_call_intent about
    // 7 times across 8 turns, mostly re-declaring an intent that has not
    // changed. Each one is a model round-trip the caller waits through before
    // hearing a word, and it is roughly a third of voice-to-voice latency.
    //
    // A prompt rewrite on 2026-08-04 cut it to 4-5 and saved ~185ms, but the
    // same run regressed three scenarios on the advisory judge — including
    // vague-caller, whose guidance shares the sentence that had to be edited.
    // It was reverted: a coin-flip on conversation quality is not worth 185ms.
    //
    // No cap is asserted here because the current count is not a target worth
    // freezing. Removing the redundancy properly means not routing intent
    // through a tool call that blocks speech — a design change, not a wording
    // one. See docs/latency-and-tts-tests.md.
  ],
  judge: [
    "Did the receptionist follow the caller's change from booking an appointment to leaving a message, without trying to continue the booking?",
    "Did the receptionist capture the message and the reason for the callback?",
  ],
};
