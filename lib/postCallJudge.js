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

/** @typedef {"off"|"shadow"|"act"} JudgeMode */

/**
 * How far the post-call judge is allowed to go.
 *
 * `act` was added 2026-09-12 and it does NOT mean the judge authors a write from
 * what it read. It means one narrow thing: `selectAgreedSlot` may choose among
 * the times an availability tool already confirmed open, and
 * lib/postCallRecover.js books the chosen one. The verdict this file's other
 * rung produces still acts on nothing by itself.
 *
 * The distinction that makes the rung safe is in selectAgreedSlot: its output is
 * an INDEX into a list it was handed, so it can name a wrong opening but cannot
 * invent a time. A reader that returned a timestamp would be the reverted
 * claimSlot.js.
 *
 * Unrecognised values resolve to `off` rather than throwing: this runs in a
 * post-call handler and a typo in a deploy variable should not be what breaks
 * one. Note the ladder is deliberately not ordered -- `act` is not "shadow and
 * more", it replaces the shadow run rather than adding to it, so the cost stays
 * one model call per call.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {JudgeMode}
 */
export function judgeMode(env = process.env) {
  const raw = String(env.POSTCALL_JUDGE || "").trim().toLowerCase();
  if (raw === "act") return "act";
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

// ---------------------------------------------------------------------------
// WHICH OF THE SLOTS THIS CALL CONFIRMED OPEN DID THE CALLER CHOOSE?
//
// A SELECTION, never a parse, and that distinction is the whole safety case.
//
// `claimSlot.js` was reverted 2026-09-11 for writing wrong times. Its defect was
// not that it read prose -- it was that it had to pick one slot out of
// `verifiedSlots` with no information about which, and a day query puts sixteen
// in there. "Use the time this call verified" is ambiguous sixteen ways, so it
// wrote a verified time that was not the agreed one, with every guard passing.
//
// This answers exactly that missing question and nothing else. The candidate set
// comes from availability tool RESPONSES (lib/voice/live/guards.js), so the only
// thing that can be returned is a time the business's own calendar presented as
// open. A reader that hallucinates a time cannot express it: the output is an
// INDEX into a list it was given, so the worst it can do is choose the wrong
// member of a set of real openings -- and rule 4 below exists to make "none"
// the answer whenever the caller's time is not in that set, rather than letting
// it round to the nearest one.
//
// The time itself is read off the ASSISTANT's own words. That is the reliable
// half of this transcript: the model's output is what it said, while the caller's
// lines are a degraded copy produced by the same model acting as recogniser --
// 1,500 ms of speech has been logged as zero characters, and "Alice to 4:30" is
// what one caller's choice of 4:30 became. So the caller's line establishes THAT
// they agreed; the assistant's read-back establishes WHICH time.
//
// Runs only in `act` mode and only after the missing-booking verdict, so a call
// that booked normally costs nothing.
// ---------------------------------------------------------------------------
const SELECT_PROMPT = [
  "You are auditing a finished phone call between an AI receptionist and a caller.",
  "The receptionist AGREED to book an appointment and then failed to record it.",
  "",
  "You are given the exact times the business's calendar confirmed were OPEN on",
  "this call. Say which ONE of them the caller settled on.",
  "",
  "Rules, all of which narrow the answer:",
  "",
  "1. Choose a slot only if the caller settled on that specific time. The",
  "   receptionist's own read-back of the time is the most reliable evidence of",
  "   WHICH time; the caller's line is evidence THAT they agreed.",
  "2. If the time the caller settled on is NOT in the list, answer null. Do not",
  "   choose the closest one. A near miss written into a calendar is a wrong",
  "   appointment, which is worse than none.",
  "3. Several times being offered is not a choice. If the call ended with options",
  "   still open, answer null.",
  "4. An appointment the caller ALREADY HAD, read back to them, is not a choice.",
  "5. If two slots would both fit what was said, answer null. Ambiguity is not a",
  "   selection.",
  "",
  "Respond with ONLY valid JSON, no markdown, no prose:",
  '{"slot_index":<0-based index into the list, or null>,',
  ' "confidence":"high|low"}',
].join("\n");

/**
 * Pick the agreed slot out of the times this call confirmed open.
 *
 * Never throws: it runs in a post-call handler, so every failure resolves to a
 * verdict with no selection. A refusal to choose is always a valid answer and is
 * the default on anything unexpected.
 *
 * @param {object} input
 * @param {Array<{speaker: string, message: string}>} input.transcript
 * @param {string[]} input.slots - naive local slot keys, from guards.verifiedSlotList()
 * @param {string|null} [input.callSid]
 * @param {JudgeMode|"act"} [input.mode]
 * @param {object} [deps] - test seam: { generate, log }
 */
export async function selectAgreedSlot(input, deps = {}) {
  const { transcript = [], slots = [], callSid = null, mode = "off" } = input || {};
  const log = deps.log || defaultLog;

  // Only the acting rung selects. shadow and off both decline, so turning the
  // judge on for measurement can never start authoring a write.
  if (mode !== "act") return { ran: false, reason: "not_act", slot: null };
  if (!Array.isArray(slots) || slots.length === 0) {
    bumpCounter("recover_no_candidate_slots");
    return { ran: false, reason: "no_candidate_slots", slot: null };
  }

  const lines = (transcript || [])
    .map((t) => `${t?.speaker === "ai" ? "AI" : "Caller"}: ${String(t?.message || "").trim()}`)
    .filter((l) => l.length > 8);
  if (lines.length < 2) {
    bumpCounter("recover_transcript_too_short");
    return { ran: false, reason: "transcript_too_short", slot: null };
  }

  const slotList = slots.map((s, i) => `${i}: ${s}`).join("\n");
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
            thinkingConfig: buildThinkingConfig(JUDGE_MODEL, 0),
          },
        });
        return response?.text ?? "";
      });

    const raw = String(
      await generate(`${SELECT_PROMPT}\n\nTimes confirmed open:\n${slotList}\n\nTranscript:\n${numbered}`)
    )
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
    if (!raw) {
      bumpCounter("recover_select_failed");
      log.error("recover_select_failed", { callSid, reason: "empty", severity: "warn" });
      return { ran: false, reason: "empty", slot: null };
    }
    parsed = JSON.parse(raw);
  } catch (err) {
    // Same rule as judgeCall: nothing from the model's mouth is logged, not even
    // truncated, because a half-written answer is most likely a sentence about
    // the caller.
    bumpCounter("recover_select_failed");
    log.error("recover_select_failed", { callSid, reason: err?.message, severity: "warn" });
    return { ran: false, reason: "error", slot: null };
  }

  // An index OUT OF RANGE is the shape a hallucinated slot would take, and it
  // resolves to no selection rather than to slots[0]. Validated against the list
  // that was actually sent, so the returned time is one this call confirmed open
  // by construction -- the property the whole design rests on.
  const idx = parsed?.slot_index;
  const valid = Number.isInteger(idx) && idx >= 0 && idx < slots.length;
  const confidence = parsed?.confidence === "high" ? "high" : "low";
  if (!valid) {
    bumpCounter(Number.isInteger(idx) ? "recover_select_out_of_range" : "recover_select_declined");
    log.info("recover_select", {
      callSid,
      selected: false,
      // The shape of the refusal, not a time.
      out_of_range: Number.isInteger(idx),
      candidates: slots.length,
      confidence,
    });
    return { ran: true, reason: valid ? null : "no_selection", slot: null, confidence };
  }

  bumpCounter("recover_select_chose");
  // An INDEX and a count. The chosen time is a caller's appointment and does not
  // go in a log line, the same rule judgeCall follows for the transcript row.
  log.info("recover_select", { callSid, selected: true, slot_index: idx, candidates: slots.length, confidence });
  return { ran: true, reason: null, slot: slots[idx], slotIndex: idx, confidence };
}
