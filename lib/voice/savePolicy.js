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
// WHERE THE READ-BACK MUST BE (LVX179, owner 2026-10-16, replacing the S2
// "same breath saves" ruling). A QUESTION about this slot in the previous
// completed turn (lastReplyText), with a sound from the caller since that is
// not a no. A read-back in the turn being spoken right now (inTurnReplyText,
// lib/voice/live/index.js turnState) has not been answered by anyone, so it
// only ever HOLDS -- as a question it waits for the answer, as a statement
// ("…booking that now") the caller still has to be asked.
//
// EITHER WAY IT MUST NAME THE SLOT BEING WRITTEN (readBackMentionsSlot). The
// read-back regexes are action-blind; the slot is what stops a read-back of one
// appointment authorising another (CA8c019c, CA7ecba06).
// ---------------------------------------------------------------------------
import { readBackMentionsSlot } from "./slotMention.js";
import { callerObjects, isAffirmative } from "../transcriptUtils.js";
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
 * @param {string|null} [p.answeredReadBack] - LVX179: the last booking question the
 *   caller answered with anything but a no on this call (lib/voice/live/index.js),
 *   single-use, superseded by any newer question that names a time or a day.
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
  answeredReadBack = null,
  strings,
}) {
  const rule = saveRuleFor(toolName);
  if (!onLive || lastChance || engineRetry || (rule !== "message" && rule !== "booking")) {
    return { rule, ...NOT_APPLIED };
  }
  if (rule === "message") {
    return { rule, applies: true, readBackStanding: true, readBackSource: "not_needed", agreed: true, objection: false, awaitingAnswer: false };
  }
  const namesThisSlot = (text) =>
    typeof text === "string" &&
    text.trim() !== "" &&
    Boolean(writeSlot) &&
    readBackMentionsSlot(text, writeSlot);
  const readsBackThisSlot = (text) =>
    namesThisSlot(text) &&
    Boolean(strings?.confirmReadBackRe?.test(text) || strings?.readBackStatementRe?.test(text));
  const asksAboutThisSlot = (text) => namesThisSlot(text) && asksReadBack(text, strings);

  // LVX179 (owner, 2026-10-16, replacing the S2 "same breath saves" ruling):
  // the ONE read-back is a QUESTION about this slot, asked in an EARLIER turn,
  // and the caller has made a sound since that is not a no. Call b CA70682e:
  // "…9, 1 or 4:30 -- which works best?", an "umm", then "9 AM for Maja,
  // booking that now" plus the tool call in one breath, and 9 AM was saved --
  // a time nobody chose. A statement tells the caller; it does not ask them.
  //
  // The previous completed turn first: a question already asked and answered
  // is not undone by the model saying "great, booking that" as it calls.
  // Answered earlier in the call (owner, 2026-10-16: "it should not ask again
  // for anything it already got the answer to"). The caller said something
  // other than a no to the question about THIS slot, then a spelling, an
  // extra-or-move question or anything else came between. Only a no, a
  // question or a change since holds it.
  const answeredEarlier = asksAboutThisSlot(answeredReadBack);
  if (asksAboutThisSlot(lastReplyText)) {
    // T5b (owner, 2026-10-13, reversing S1): asked, then NO sound at all --
    // a person checks the caller is still there; they do not book it. Held,
    // awaiting the answer; whatever lastCallerText holds was said BEFORE the
    // question, so it is neither an answer nor an objection to it.
    if (callerVoicedSinceReply === false) {
      if (!answeredEarlier) {
        return { rule, applies: true, readBackStanding: true, readBackSource: "previous", agreed: false, objection: false, awaitingAnswer: true };
      }
    } else {
    // A YES whose only other cue is a time ("Yeah, 4:30 works") is the slot
    // said back, not a change: the restated-slot detector misses real
    // restatements (CA239046), so for a yes only a change word or a question
    // objects -- final review I4's rule, which held this before LVX179 made
    // the question decide. Without a yes, a different time still objects.
    // ...unless the time it names is a DIFFERENT one (CA94817d: "…4:30 PM.
    // Please confirm" -> "Yeah, they're correct. 10:00 a.m. works." is 10).
    const times = timesAgainst(lastCallerText, slotClockTimes(writeSlot));
    const yesNamingATime =
      isAffirmative(lastCallerText) && times !== "different" && !callerObjects(lastCallerText, { restatedSlot: true });
    const objection =
      !yesNamingATime &&
      callerObjects(lastCallerText, { restatedSlot: Boolean(callerRestatedSlot) || times === "same" });
    return { rule, applies: true, readBackStanding: true, readBackSource: "previous", agreed: !objection, objection, awaitingAnswer: false };
    }
  }
  if (answeredEarlier) {
    // What the caller said since is letters, "in addition", a yes to another
    // question -- not an answer about the time, so a time named in it does not
    // object; a no, a question or a change still does.
    const objection =
      callerObjects(lastCallerText, { restatedSlot: true }) ||
      timesAgainst(lastCallerText, slotClockTimes(writeSlot)) === "different";
    return { rule, applies: true, readBackStanding: true, readBackSource: "answered_earlier", agreed: !objection, objection, awaitingAnswer: false };
  }
  // A read-back in the turn being spoken has not been answered, whatever its
  // form. Asked as a question: held, awaiting the answer (final review I2,
  // CA6b662e / LVX95). Said as a statement: held, and the caller still has to
  // be asked.
  if (readsBackThisSlot(inTurnReplyText)) {
    if (asksAboutThisSlot(inTurnReplyText)) {
      return { rule, applies: true, readBackStanding: true, readBackSource: "in_turn", agreed: false, objection: false, awaitingAnswer: true };
    }
    return { rule, applies: true, readBackStanding: false, readBackSource: "in_turn_statement", agreed: false, objection: false, awaitingAnswer: false };
  }
  if (readsBackThisSlot(lastReplyText)) {
    return { rule, applies: true, readBackStanding: false, readBackSource: "previous_statement", agreed: false, objection: false, awaitingAnswer: false };
  }
  return { rule, applies: true, readBackStanding: false, readBackSource: null, agreed: false, objection: false, awaitingAnswer: false };
}

/**
 * Does this read-back ASK? confirmReadBackRe recognises a confirmation
 * ("…, is that right?", "just to confirm…"), and the turn must not END on a
 * statement of the write ("…booking that now"): the last thing the caller
 * heard is what they are answering. "Booking that now. Anything else?" asks
 * nothing about the booking; "…booking that now -- is that right?" does.
 */
export function asksReadBack(text, strings) {
  if (typeof text !== "string") return false;
  // "Please confirm these details" asks as plainly as "is that right?" does
  // (CA0ef8d2: "I'll book that … on Tuesday at 9:00 AM. Please confirm these
  // details." -> "Yeah, that works"). Kept here, not added to the shared
  // confirmReadBackRe, whose other readers batch 2 learned not to widen.
  const asks = (t) => Boolean(strings?.confirmReadBackRe?.test(t)) || PLEASE_CONFIRM_RE.test(t);
  if (!asks(text)) return false;
  const stmt = strings?.readBackStatementRe;
  if (!stmt) return true;
  const all = new RegExp(stmt.source, stmt.flags.includes("g") ? stmt.flags : `${stmt.flags}g`);
  let end = -1;
  for (const m of text.matchAll(all)) end = m.index + m[0].length;
  if (end < 0) return true;
  const tail = text.slice(end);
  return /\?/.test(tail) || asks(tail);
}

const PLEASE_CONFIRM_RE = /\b(?:please|can\s+you|could\s+you)\s+confirm\b/i;

// ---------------------------------------------------------------------------
// LVX179: WHICH CLOCK TIMES does a turn name, as {h12, m, pm|null}? Used to
// tell "Yeah, 4:30 works" (the slot said back) from "Yeah, 10:00 a.m. works"
// (a change riding on a yes). Over-reading is the safe direction: a word read
// as a different time holds the booking and the caller is asked once more; a
// time missed would book the slot they just changed.
// ---------------------------------------------------------------------------
const MERIDIEM = String.raw`(a\.?\s?m\b\.?|p\.?\s?m\b\.?)`;
const SPOKEN_HOURS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const SPOKEN_MINUTES = { thirty: 30, fifteen: 15, "forty five": 45, "forty-five": 45 };
const DIGIT_TIME_RE = new RegExp(
  String.raw`\b(\d{1,2})(?:(?::|\s)(\d{2}))?(?!\d|st\b|nd\b|rd\b|th\b)\s*${MERIDIEM}?`,
  "gi"
);
const SPOKEN_TIME_RE = new RegExp(
  String.raw`\b(${SPOKEN_HOURS.join("|")})(?:[\s-](thirty|fifteen|forty[\s-]five|o'?clock))?\s*${MERIDIEM}?`,
  "gi"
);

/** @returns {Array<{h12: number, m: number, pm: boolean|null}>} */
export function clockTimesIn(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  const pmOf = (mer) => (mer ? /^p/i.test(mer) : null);
  for (const m of text.matchAll(DIGIT_TIME_RE)) {
    const h = Number(m[1]);
    const min = m[2] == null ? 0 : Number(m[2]);
    // A bare number is a time only with minutes, a meridiem or a leading "at":
    // "two Ls", a phone digit and "the 23rd" are not.
    if (m[2] == null && !m[3] && !/\bat\s*$/i.test(text.slice(0, m.index))) continue;
    if (h < 1 || h > 12 || min > 59) {
      if (h >= 13 && h <= 23 && min <= 59) out.push({ h12: h - 12, m: min, pm: true });
      continue;
    }
    out.push({ h12: h, m: min, pm: pmOf(m[3]) });
  }
  for (const m of text.matchAll(SPOKEN_TIME_RE)) {
    const tail = text.slice(m.index + m[0].length);
    const said = Boolean(m[2] || m[3]) || /^\s*(?:works|is|sounds|please|would|then|that)\b/i.test(tail);
    if (!said) continue;
    const h = SPOKEN_HOURS.indexOf(m[1].toLowerCase()) + 1;
    const minWord = (m[2] || "").toLowerCase().replace(/\s+/g, " ");
    out.push({ h12: h, m: SPOKEN_MINUTES[minWord] ?? 0, pm: pmOf(m[3]) });
  }
  return out;
}

/** The slot's own clock time, as clockTimesIn would read it. */
export function slotClockTimes(naive) {
  const m = typeof naive === "string" && /T(\d{2}):(\d{2})/.exec(naive);
  if (!m) return [];
  const H = Number(m[1]);
  return [{ h12: H % 12 || 12, m: Number(m[2]), pm: H >= 12 }];
}

/**
 * Does `text` name only times in `against` ("same"), any other ("different"),
 * or none at all ("none")? A meridiem is compared only when both sides have one.
 */
export function timesAgainst(text, against) {
  const said = clockTimesIn(text);
  if (!said.length) return "none";
  const same = (a, b) => a.h12 === b.h12 && a.m === b.m && (a.pm == null || b.pm == null || a.pm === b.pm);
  return said.every((t) => against.some((o) => same(t, o))) ? "same" : "different";
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
 * A QUESTION ending "…, is that right?" (LVX179, owner 2026-10-16), so the
 * next turn is a recognised read-back by construction (confirmReadBackRe), it
 * is never a completion claim, and the caller has been asked rather than told.
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
      // LVX179 (owner, 2026-10-16): EVERY name spelled, first name too --
      // "Maja" and "Maya" sound the same, so only letters can show which one
      // the model wrote down. "Maya, M-A-Y-A, Okafor, O-K-A-F-O-R".
      who = words.map((w) => (spelled(w) ? `${w}, ${spelled(w)}` : w)).join(", ");
    } else {
      who = words.join(" ");
    }
  }

  // LVX179 (owner, 2026-10-16): ONE question, never a statement. The caller's
  // answer to it -- anything but a no -- is what saves the booking.
  if (isMove) {
    return es
      ? `Entonces muevo su cita al ${when}${who ? ` para ${who}` : ""}, ¿es correcto?`
      : `So that's moving your appointment to ${when}${who ? ` for ${who}` : ""}, is that right?`;
  }
  return es
    ? `Entonces es el ${when}${who ? ` para ${who}` : ""}, ¿es correcto?`
    : `So that's ${when}${who ? ` for ${who}` : ""}, is that right?`;
}
