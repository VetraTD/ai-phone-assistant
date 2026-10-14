// ---------------------------------------------------------------------------
// Round A1 "say it once" — which save rule a write tool is on, and whether the
// caller has been given their one read-back. Owner decisions, 2026-10-13
// (docs/receptionist-backlog.md, LVX177 + LVX172):
//
//   "Save unless it HEARS a no." It used to be "save only once it hears a
//   clear yes", and LVX177 measured what that cost: 124 gate refusals over 67
//   saving calls, 73% of them on saves that later went through, and in 12 of
//   the 15 episodes that never saved the model told the caller it was done
//   anyway. Strictness now matches the harm:
//
//   | message / quote | no read-back gate; saved when the model calls it      |
//   | booking / move  | ONE read-back, then saved unless the answer is a no,  |
//   |                 | a question or a change. Silence or garble is not a no |
//   | cancel          | unchanged -- confirm once, ask again if unreadable    |
//   | anything else   | unchanged                                             |
//
// PURE, so the gate in services/tools.js reads one decision and logs it. The
// gate keeps every one of its existing paths for `applies: false`, which is
// the cascade, the end-of-call sweep, the engine's own retry, cancels and every
// strict tool: those are byte-for-byte what they were.
//
// WHERE A READ-BACK CAN BE. The previous completed turn (lastReplyText), as
// before, OR the turn being spoken right now (inTurnReplyText). The second is
// new and is what makes "Tuesday at 3 for Jon, booking that now" plus the tool
// call in one breath a single confirmation instead of two: on Live, when the
// model speaks before its tool call, that sentence exists ONLY in the turn in
// progress (lib/voice/live/index.js turnState). Nobody has answered it yet, so
// nothing has been heard to object with.
//
// EITHER WAY IT MUST NAME THE SLOT BEING WRITTEN (readBackMentionsSlot). The
// read-back regexes are action-blind; the slot is what stops a read-back of one
// appointment authorising another (CA8c019c, CA7ecba06).
// ---------------------------------------------------------------------------
import { readBackMentionsSlot } from "./slotMention.js";
import { callerObjects } from "../transcriptUtils.js";
import { speakableDateTime } from "../capabilities/datetime.js";
import { resolveProfile } from "./voiceLocale.js";
import { getStrings } from "./strings.js";

export const SAVE_RULE = Object.freeze({
  record_customer_request: "message",
  record_quote_request: "message",
  book_appointment: "booking",
  book_appointment_in_ehr: "booking",
  reschedule_appointment_db: "booking",
  reschedule_appointment: "booking",
  cancel_appointment_db: "cancel",
  cancel_appointment: "cancel",
});

/** @returns {"message"|"booking"|"cancel"|"strict"} */
export function saveRuleFor(toolName) {
  return SAVE_RULE[toolName] || "strict";
}

const NOT_APPLIED = {
  applies: false,
  readBackStanding: false,
  readBackSource: null,
  agreed: false,
  objection: false,
  awaitingAnswer: false,
};

/**
 * @param {object} p
 * @param {string} p.toolName
 * @param {boolean} p.onLive - ctx.callerSaidThisCall != null
 * @param {boolean} p.lastChance - the end-of-call message sweep
 * @param {boolean} p.engineRetry - retryPendingWrite, not the model
 * @param {string|null} p.writeSlot - the time this tool is about to write
 * @param {string} p.lastReplyText - the previous completed assistant turn
 * @param {string} p.inTurnReplyText - the assistant turn in progress
 * @param {string} p.lastCallerText - the caller's last turn
 * @param {boolean} p.callerRestatedSlot - LVX144, computed by the gate
 * @param {boolean|null} p.callerVoicedSinceReply - T5b: the caller made ANY sound the
 *   model heard since the last real reply (lib/voice/live/index.js). `false` holds a
 *   previous-turn read-back; `null` (wire absent) is not read as silence.
 * @param {object} p.strings - the call's locale table
 * @returns {{ rule: string, applies: boolean, readBackStanding: boolean,
 *   readBackSource: "not_needed"|"previous"|"in_turn"|null, agreed: boolean, objection: boolean,
 *   awaitingAnswer: boolean }}
 */
export function decideSave({
  toolName,
  onLive,
  lastChance,
  engineRetry,
  writeSlot,
  lastReplyText,
  inTurnReplyText,
  lastCallerText,
  callerRestatedSlot,
  callerVoicedSinceReply = null,
  strings,
}) {
  const rule = saveRuleFor(toolName);
  if (!onLive || lastChance || engineRetry || (rule !== "message" && rule !== "booking")) {
    return { rule, ...NOT_APPLIED };
  }
  if (rule === "message") {
    return { rule, applies: true, readBackStanding: true, readBackSource: "not_needed", agreed: true, objection: false, awaitingAnswer: false };
  }
  const readsBackThisSlot = (text) =>
    typeof text === "string" &&
    text.trim() !== "" &&
    Boolean(writeSlot) &&
    Boolean(strings?.confirmReadBackRe?.test(text) || strings?.readBackStatementRe?.test(text)) &&
    readBackMentionsSlot(text, writeSlot);

  // The turn in progress first: a read-back being spoken now supersedes the
  // last one, and has not been answered.
  if (readsBackThisSlot(inTurnReplyText)) {
    // Final review I2. The owner's "same breath" is a STATEMENT ("…booking that
    // now"). A read-back that ASKS ("…shall I go ahead and book that?") has
    // asked for an answer: saving before it comes is the CA6b662e / LVX95
    // shape. Held, awaiting the answer; the read-back then stands next turn.
    const asks = /\?/.test(inTurnReplyText) || !strings?.readBackStatementRe?.test(inTurnReplyText);
    if (asks) {
      return { rule, applies: true, readBackStanding: true, readBackSource: "in_turn", agreed: false, objection: false, awaitingAnswer: true };
    }
    return { rule, applies: true, readBackStanding: true, readBackSource: "in_turn", agreed: true, objection: false, awaitingAnswer: false };
  }
  if (readsBackThisSlot(lastReplyText)) {
    // T5b (owner, 2026-10-13, reversing S1): read back, then NO sound at all --
    // a person checks the caller is still there; they do not book it. Held,
    // awaiting the answer; whatever lastCallerText holds was said BEFORE the
    // read-back, so it is neither an answer nor an objection to it.
    if (callerVoicedSinceReply === false) {
      return { rule, applies: true, readBackStanding: true, readBackSource: "previous", agreed: false, objection: false, awaitingAnswer: true };
    }
    const objection = callerObjects(lastCallerText, { restatedSlot: Boolean(callerRestatedSlot) });
    return { rule, applies: true, readBackStanding: true, readBackSource: "previous", agreed: !objection, objection, awaitingAnswer: false };
  }
  return { rule, applies: true, readBackStanding: false, readBackSource: null, agreed: false, objection: false, awaitingAnswer: false };
}

// A wall-clock value with no offset is the tenant's local time; one with an
// offset (or "Z") is an instant. Same split validateBookingTime makes.
const NAIVE_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

function speakableSlot(raw, config) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const v = raw.trim();
  const profile = resolveProfile(config);
  return NAIVE_LOCAL_RE.test(v)
    ? speakableDateTime(`${v}Z`, "UTC", profile)
    : speakableDateTime(v, config?.timezone, profile);
}

function spelled(word) {
  return String(word).replace(/[^\p{L}]/gu, "").toUpperCase().split("").join("-");
}

/**
 * The ONE read-back, built from the arguments that will be written. Handed to
 * the model when it calls a booking tool with no read-back standing, so the
 * sentence the caller hears is the row the business gets -- including the
 * surname, letter by letter, when the caller spelled it (LVX172: a spoken
 * read-back cannot show letters, so "Dodla" said back as "Dodla" proves
 * nothing; "D-O-D-L-A" lets the caller say "no, B").
 *
 * Ends on "booking that now" / "moving it now" so the next turn is a
 * recognised read-back by construction (readBackStatementRe) and is never a
 * completion claim.
 *
 * @returns {string}
 */
export function composeReadBack({ toolName, args = {}, config = {}, callerSpelled = false }) {
  const S = getStrings(config);
  const es = S.lang === "es";
  const isMove = /reschedule/.test(toolName);
  const when = speakableSlot(isMove ? args.new_scheduled_at : args.scheduled_at, config) || "that time";

  const words = String(args.client_name || "").trim().split(/\s+/).filter(Boolean);
  let who = "";
  if (words.length) {
    if (callerSpelled) {
      const surname = words[words.length - 1];
      who = words.length > 1 ? `${words.slice(0, -1).join(" ")}, ${spelled(surname)}` : spelled(surname);
    } else {
      who = words.join(" ");
    }
  }

  if (isMove) {
    const base = es ? `Muevo su cita al ${when}` : `Moving your appointment to ${when}`;
    return es ? `${base}${who ? ` para ${who}` : ""}, lo cambio ahora.` : `${base}${who ? ` for ${who}` : ""}, moving it now.`;
  }
  return es
    ? `${when}${who ? ` para ${who}` : ""}, lo reservo ahora.`
    : `${when}${who ? ` for ${who}` : ""}, booking that now.`;
}
