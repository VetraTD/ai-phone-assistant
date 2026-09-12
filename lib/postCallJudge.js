import { getClient, buildThinkingConfig } from "../services/gemini.js";
import { log as defaultLog } from "./logger.js";
import { bumpCounter } from "./voice/metrics.js";

// ---------------------------------------------------------------------------
// A SECOND OPINION ON WHAT THE CALL OWED, read from the transcript.
//
// lib/postCallVerify.js answers the same question structurally: a point
// availability check came back open, the caller affirmed a read-back, and no row
// exists. That check is free, instant, deterministic and testable, and it has one
// blind spot that matters -- it requires a POINT-checked time. On the verification
// call of 2026-09-11, `verified_slots` was 16 and `point_verified_slots` was 2,
// because the caller was read a list of openings off a whole-day query. A caller
// who picks straight off that list and gets nothing booked is invisible to it.
//
// A reader of the transcript has no such blind spot, and does not ride the
// phrasing treadmill either: "we're all set", "I have you down for", "your new
// appointment is on" -- four wordings got through a regex in two weeks, each found
// after a caller was harmed, and a model reading the sentence needs none of them
// enumerated.
//
// THE TRANSCRIPT IS WRITTEN BY THE MODEL BEING AUDITED, and that is the whole
// reason this is a DETECTOR and never an author. On this front-end the model IS
// the speech recogniser, so the caller's lines are a degraded copy produced by
// the same system whose behaviour is in question. Two observations from real
// calls: 20 ms of caller audio became a confident "D I L L A N B H A K T A"
// read-back, and 1,500 ms of caller speech has been logged as zero characters. So
// the assistant's own words are reliable evidence and the caller's are not, which
// splits cleanly:
//
//   deciding "this call owed a booking and has none"  -- safe, and the point.
//   authorising the write                             -- not safe. The authority
//     is the caller's consent, and the transcript's caller is the unreliable half.
//
// And a judge that supplied the TIME or the NAME would be parsing prose into a
// database write, which is lib/voice/live/claimSlot.js -- reverted 2026-09-11
// after writing wrong times. If a write is ever driven from this, the arguments
// come from tool traffic and an availability-confirmed slot; this only ever says
// WHETHER.
//
// SHADOW ONLY. There is no rung that acts. It logs its verdict beside the
// structural check's, both keyed by callSid, so the disagreements can be read off
// real calls -- which is how either one gets validated without hand-labelling
// anything. A rule that has never been compared against a call it did not author
// is not evidence.
//
// NO CALLER DATA IN THE OUTPUT. The verdict is enums, booleans and a transcript
// ROW INDEX. A human who needs the sentence can pull the transcript by that
// index; the index is not itself caller data, and the sentence is. LVX24 was a
// sanitizer logging the text it caught, and note that the summary extractor next
// door logs `raw.slice(0, 200)` of raw model output on a parse failure -- which
// passes the PHI lint only because the lint matches field NAMES. This file does
// not copy that.
// ---------------------------------------------------------------------------

/** @typedef {"off"|"shadow"} JudgeMode */

/**
 * How far the post-call judge is allowed to go.
 *
 * There is deliberately no "act". Unrecognised values resolve to `off` rather
 * than throwing: this runs in a post-call handler and a typo in a deploy
 * variable should not be what breaks one.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {JudgeMode}
 */
export function judgeMode(env = process.env) {
  const raw = String(env.POSTCALL_JUDGE || "").trim().toLowerCase();
  return raw === "shadow" ? "shadow" : "off";
}

/** Same family as the summary extractor next door, and pinned for the same reason. */
const JUDGE_MODEL = "gemini-3.6-flash";

const AGREED_ACTIONS = ["book", "cancel", "reschedule", "none"];

// ---------------------------------------------------------------------------
// The question, and the four rules that decide whether it is worth asking.
//
// Each rule is here because a real call got it wrong, and each is stated as a
// NEGATIVE -- what does not count -- because that is where this kind of reader
// fails. A judge that says "book" whenever booking was discussed would fire on
// most calls and mean nothing.
// ---------------------------------------------------------------------------
const JUDGE_PROMPT = [
  "You are auditing a phone call between an AI receptionist and a caller.",
  "",
  "ONE QUESTION: did the caller and the receptionist reach agreement on a specific",
  "appointment action that the business should now have on record?",
  "",
  "Rules, all of which narrow the answer:",
  "",
  '1. "book" requires BOTH a specific date and time settled AND the caller',
  '   assenting to it in their own words. A receptionist asking "does that sound',
  '   right?" with no caller answer after it is NOT agreement.',
  "2. An appointment the caller ALREADY HAD, described back to them, is not an",
  "   agreement to a new action. Reading someone their existing booking is a",
  "   report.",
  "3. Offering several open times is not agreement. Browsing ends with options",
  "   open; an agreement ends with one time settled.",
  "4. If the caller declined, hesitated without answering, or the call ended",
  '   mid-decision, answer "none".',
  "",
  "Answer about what was AGREED, not about what the receptionist later said",
  "happened. A receptionist that agreed a booking and then announced a technical",
  'problem still agreed a booking: answer "book" and set claimed_failure true.',
  "",
  "Respond with ONLY valid JSON, no markdown, no prose:",
  '{"agreed_action":"book|cancel|reschedule|none",',
  ' "agreed_turn":<0-based index of the line where the caller assented, or null>,',
  ' "time_stated":<true if a specific date and time was spoken>,',
  ' "claimed_done":<true if the receptionist said the action was completed>,',
  ' "claimed_failure":<true if the receptionist said it could not be done>,',
  ' "confidence":"high|low"}',
  "",
  "Transcript, one line per turn, numbered from 0:",
].join("\n");

/**
 * Read a finished call's transcript and say what it agreed to.
 *
 * Never throws. It runs in a fire-and-forget post-call handler, so every failure
 * resolves to a verdict rather than a rejection.
 *
 * @param {object} input
 * @param {Array<{speaker: string, message: string}>} input.transcript
 * @param {string|null} [input.callSid] - for the log line only
 * @param {number} [input.bookedRowCount] - rows this call actually booked
 * @param {JudgeMode} [input.mode]
 * @param {object} [deps] - test seam: { generate, log }
 */
export async function judgeCall(input, deps = {}) {
  const { transcript = [], callSid = null, bookedRowCount = 0, mode = "off" } = input || {};
  const log = deps.log || defaultLog;

  if (mode === "off") return { ran: false, reason: "off" };

  const lines = (transcript || [])
    .map((t) => `${t?.speaker === "ai" ? "AI" : "Caller"}: ${String(t?.message || "").trim()}`)
    .filter((l) => l.length > 8);

  // A transcript with nothing in it cannot support a verdict, and "the caller
  // never spoke" is already a case server.js handles as spam upstream.
  if (lines.length < 2) {
    bumpCounter("postcall_judge_skipped");
    return { ran: false, reason: "transcript_too_short" };
  }

  const numbered = lines.map((l, i) => `${i}: ${l}`).join("\n");

  let parsed;
  try {
    const generate =
      deps.generate ||
      (async (prompt) => {
        const gemini = getClient();
        const response = await gemini.models.generateContent({
          model: JUDGE_MODEL,
          contents: prompt,
          config: {
            temperature: 0,
            maxOutputTokens: 256,
            // gemini-3.x thinks by default, and thought tokens come out of
            // maxOutputTokens -- which truncates the JSON and degrades silently
            // to a null verdict. The summary extractor pins this off for exactly
            // the same reason.
            thinkingConfig: buildThinkingConfig(JUDGE_MODEL, 0),
          },
        });
        return response?.text ?? "";
      });

    const raw = String(await generate(`${JUDGE_PROMPT}\n${numbered}`))
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");

    if (!raw) {
      bumpCounter("postcall_judge_failed");
      log.error("postcall_judge_failed", { callSid, reason: "empty", severity: "warn" });
      return { ran: false, reason: "empty" };
    }
    parsed = JSON.parse(raw);
  } catch (err) {
    // NOTHING FROM THE MODEL'S MOUTH IS LOGGED HERE, not even truncated. A
    // failed parse is most likely to be a half-written sentence about the
    // caller, and `reason` is the shape of the failure rather than its content.
    bumpCounter("postcall_judge_failed");
    log.error("postcall_judge_failed", { callSid, reason: err?.message, severity: "warn" });
    return { ran: false, reason: "error" };
  }

  // Every field validated against a closed set, and anything unexpected becomes
  // the safe value. A judge that returned prose where an enum belongs must not
  // be able to put that prose in a log line.
  const agreedAction = AGREED_ACTIONS.includes(parsed?.agreed_action) ? parsed.agreed_action : "none";
  const agreedTurn = Number.isInteger(parsed?.agreed_turn) ? parsed.agreed_turn : null;
  const verdict = {
    ran: true,
    agreedAction,
    agreedTurn,
    timeStated: parsed?.time_stated === true,
    claimedDone: parsed?.claimed_done === true,
    claimedFailure: parsed?.claimed_failure === true,
    confidence: parsed?.confidence === "high" ? "high" : "low",
    // The comparison the whole thing exists for. Not acted on.
    bookingMissing: agreedAction === "book" && bookedRowCount === 0,
  };

  bumpCounter("postcall_judge_ran");
  if (agreedAction === "book") bumpCounter("postcall_judge_booking_agreed");
  if (verdict.bookingMissing) bumpCounter("postcall_judge_booking_missing");

  log.info("postcall_judge", {
    callSid,
    mode,
    agreed_action: verdict.agreedAction,
    // An INDEX, not the sentence. A human pulls the transcript row themselves.
    agreed_turn: verdict.agreedTurn,
    time_stated: verdict.timeStated,
    claimed_done: verdict.claimedDone,
    claimed_failure: verdict.claimedFailure,
    confidence: verdict.confidence,
    booked_rows: bookedRowCount,
    booking_missing: verdict.bookingMissing,
    turns: lines.length,
  });

  return verdict;
}
