/**
 * Messages and callbacks capability pack.
 *
 * CORE: always on, cannot be disabled. Taking a message is baseline
 * receptionist behavior and the universal safety net — every other capability
 * falls back to it when a tool fails, an answer is unknown, or a transfer is
 * unavailable. See lib/voice/fallbackFlow.js for the deterministic no-LLM
 * version that runs after repeated LLM failures.
 *
 * The second of the three shapes the pack contract was designed against:
 * stateless, no external adapter, its effect is a notification rather than a
 * write to a system of record.
 *
 * Step A status: tool declaration only, moved verbatim from services/gemini.js.
 */

import {
  withRequirements,
  requirementPromptLines,
  notesPromptLines,
  capabilityConfig,
} from "../lib/capabilities/requirements.js";
import { partyOfEffect } from "../lib/capabilities/party.js";
import { saveCustomerRequest, detailsFromArgs, CALLER_TYPES } from "../lib/capabilities/customerRequests.js";
import { isRealCallerNumber } from "../lib/inboundGuards.js";
import { parseNotesQuestions, openQuestions, anyAnswered } from "../lib/capabilities/notesQuestions.js";
import { nameIsOnFile } from "../lib/nameQuality.js";
import {
  confirmStyleOf,
  spellUpFrontOf,
  isHealthcareTier,
  intakeTypeFor,
  decisionTypeOf,
  hasMessageNotes,
  LEAD_LIKE,
} from "../lib/capabilities/intakeSettings.js";
import { END_READ_BACK } from "../lib/voice/intakePath.js";
import {
  spelledNameReadBack,
  nameVoicedIn,
  emailsInAnswer,
  spelledEmailReadBack,
  emailVoicedIn,
} from "../lib/voice/spelledReadBack.js";

/** record_customer_request's request_type enum: two types, one request to the caller (see matchTypes below). */
const MESSAGE_PACK_TYPES = ["message", "callback"];

/**
 * Model-only, in the tool reply and never in toolResult (which may be spoken).
 * Present only when the business wrote notes for taking messages: those notes
 * are where its extra questions live.
 */
const NEXT_QUESTIONS_NOTE =
  "[not caller speech] If this business's notes list more questions for this caller, ask them now, one at a time, before closing. Then save again with the same message and the answers in details.";

/**
 * The standard tier's version of the note above (caller-experience Task 3,
 * wording only: a business's own notes beat our default, so no code gate on
 * caller type). The healthcare tier keeps the note above byte for byte.
 */
const NEXT_QUESTIONS_NOTE_STANDARD =
  "[not caller speech] If this business's notes list questions, ask them now: new enquiries by default, other callers only when the notes say so. Ask all of them, in the business's order, one at a time, skipping any this caller already answered. If they say they are short of time, offer to leave the rest for the callback. Then save again with the same message and the answers in details.";

/**
 * Fix wave I8 (P28), model-only. A lead's FIRST save at a business that has its
 * own questions: the questions come first and the spelled read-back waits until
 * the last answer, so the caller hears one read-back at the end, not one now and
 * another after the questions. Described, never a quoted question. The letters
 * come with the later save that carries the answers.
 */
const NEXT_QUESTIONS_NOTE_DEFERRED =
  NEXT_QUESTIONS_NOTE_STANDARD +
  " Apart from their number, do not read anything back yet: make the one read-back after the last answer, then ask whether it is right. If they answer none of them, make it then.";

/** LVX192 Task 5. Model-only, like the notes above. Cap on the labels remembered across saves. */
const MAX_SAVED_LABELS = 20;
const ALL_QUESTIONS_ANSWERED_NOTE =
  "[not caller speech] Every numbered question in this business's notes has a saved answer. If the notes give a further step after them, do it now.";
/**
 * Fix round 2 (owner's calls 1-2: the pickup was never read back, so "RH7 642"
 * reached the email). Leads the list or the all-answered sentence on a save that
 * carried answers, at a business that confirms each answer as it is given.
 */
const CONFIRM_FIRST_NOTE =
  "[not caller speech] First confirm the answer you just saved, the way this business's notes say (read an address back, ask for any part left out). Then: ";
const MODEL_NOTE_PREFIX = "[not caller speech] ";
/** The save the end_call guard forced, with no question left open: ask once, then let them go. */
const QUIET_SAVE_NOTE =
  "Saved. If the caller already said they need nothing else, say a short goodbye and call end_call; otherwise ask whether there is anything else.";

function nextQuestionsNote(config) {
  return isHealthcareTier(config) ? NEXT_QUESTIONS_NOTE : NEXT_QUESTIONS_NOTE_STANDARD;
}

/**
 * Model-only, like the note above. Present when the save carries no
 * callback_number and the call has no usable caller number either (withheld,
 * a placeholder, or the business's own line). The message IS saved; this only
 * makes the model get the digits, and a later save merges onto the same row.
 */
const NO_NUMBER_NOTE =
  "[not caller speech] Their message is saved, but there is no number to call them back on because their number did not come through. Ask them for the digits now, read them back, and save again with the same message and the number.";

/**
 * S4-F3. Model-only, like the notes above, and FIRST in `next`: a spelled name
 * or an email, read back one letter at a time from the args this save wrote,
 * before anything else is said. Null when there is nothing to read.
 *
 * The prompt's own rule (spell a spelled name back) held on about half the
 * 2026-11 test calls, and call 15 saved "Roman" for a caller who spelled
 * R-A-M-A-N with no read-back at all. On Live a tool's reply is obeyed at once,
 * in the same turn; a note appended elsewhere is not. The letters are composed
 * here, from what was saved, so the caller hears what the business will get.
 *
 * Fires only when all of these hold:
 * - inbound (no ctx.outboundCall);
 * - on Live: ctx.assistantSaidThisCall is a string. The cascade does not pass
 *   it, and without it "already read back" cannot be known, so no note there;
 * - something to read: a name, when the caller spelled on this call
 *   (ctx.callerSpelled), and/or an email-shaped answer in details. An email
 *   needs no spelling signal: on the phone it is always spelled, and the
 *   spelling detector ignores volunteered emails on purpose
 *   (lib/voice/replyState.js);
 * - those letters are not already in what the assistant said: earlier turns
 *   (assistantSaidThisCall) or this turn before the call (inTurnReplyText --
 *   call 14 spelled the surname in the same breath as the save). A corrected
 *   save carries new letters, so it fires again.
 *
 * Carries the caller's name and email to the MODEL only: function responses
 * are not logged (LVX24), and nothing here logs.
 */
function spelledReadBackNote(args, ctx) {
  if (ctx?.outboundCall) return null;
  if (typeof ctx?.assistantSaidThisCall !== "string") return null;
  const said = `${ctx.assistantSaidThisCall} ${typeof ctx.inTurnReplyText === "string" ? ctx.inTurnReplyText : ""}`;
  const items = [];
  const name = typeof args.caller_name === "string" ? args.caller_name.trim() : "";
  // Healthcare tier: the rule as it always was (name when the caller spelled, any email).
  // Standard tier: by caller type and the business's settings. A lead or an existing
  // client gets the end read-back even when they did not spell (the letters come from
  // the saved name); other types only when they spelled and the business asked everyone.
  let nameOn = ctx.callerSpelled === true;
  let emailOn = true;
  // What the name letters cover (fix wave I7, standard tier): a caller who spelled
  // gets every word read back, as before; one who did not gets the surname only,
  // and a name confirmed on file gets none (the spec: never spelled if on file).
  let surnameOnly = false;
  if (!isHealthcareTier(ctx?.config)) {
    const lead = LEAD_LIKE.has(decisionTypeOf(intakeTypeFor(args, ctx)));
    const end = confirmStyleOf(ctx?.config) === "end";
    const everyone = spellUpFrontOf(ctx?.config) === "everyone";
    nameOn = lead ? ctx.callerSpelled === true || end : ctx.callerSpelled === true && everyone;
    emailOn = (lead && end) || everyone;
    if (ctx.callerSpelled !== true) {
      surnameOnly = true;
      if (nameIsOnFile(name, ctx.callerContext)) nameOn = false;
    }
  }
  const nameWordsOf = name.split(/\s+/).filter(Boolean);
  const spellWords = surnameOnly ? nameWordsOf.slice(-1) : nameWordsOf;
  const nameLetters = nameOn && name ? spelledNameReadBack(spellWords.join(" ")) : null;
  if (nameLetters) {
    const what = surnameOnly && nameWordsOf.length > 1 ? "their surname" : "their name";
    items.push({ say: `${what}, "${nameLetters}"`, voiced: nameVoicedIn(name, said) });
  }
  const emails = emailOn
    ? new Set((detailsFromArgs(args)?.answers || []).flatMap((a) => emailsInAnswer(a.answer)))
    : new Set();
  for (const email of emails) {
    items.push({ say: `their email, "${spelledEmailReadBack(email)}"`, voiced: emailVoicedIn(email, said) });
  }
  const unread = items.filter((item) => !item.voiced);
  if (!unread.length) return null;
  return (
    "[not caller speech] Before anything else, read back to the caller exactly what was saved, one letter at a time: " +
    unread.map((item) => item.say).join(", and ") +
    ". Then ask whether that is right. If they correct anything, save again with the fix."
  );
}

/**
 * Previously registered unconditionally at services/gemini.js:144. It used to
 * be gated on take_message/callback_request appearing in allowedTasks, which
 * let the prompt's ESCALATION section instruct the model to call a tool that
 * was not registered — the phantom-tool bug. Being CORE is what fixes that
 * class of defect permanently.
 */
const RECORD_CUSTOMER_REQUEST_DECLARATION = {
  name: "record_customer_request",
  description:
    "Record a message or callback request after collecting the caller's name, " +
    "callback number, and message (and preferred callback time for callbacks). " +
    "Call this when the caller wants to leave a message or have someone call them back.",
  parameters: {
    type: "object",
    properties: {
      request_type: {
        type: "string",
        enum: ["message", "callback"],
        description: "Whether this is a message to pass along or a request for a callback",
      },
      caller_name: { type: "string", description: "Caller's name" },
      callback_number: { type: "string", description: "Phone number to call back" },
      message: { type: "string", description: "The message or reason for callback" },
      preferred_time: {
        type: "string",
        description: "When they prefer to be called back (for callback type)",
      },
      caller_type: {
        type: "string",
        enum: CALLER_TYPES,
        description: "What kind of caller this is, whenever you can tell. Leave it out if unsure.",
      },
      details: {
        type: "array",
        description:
          "The caller's answers to this business's extra questions, one entry per question they answered. " +
          "Skip anything they would rather not answer.",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "The question, in a few words (e.g. Company)" },
            answer: { type: "string", description: "What the caller said" },
          },
          required: ["label", "answer"],
        },
      },
    },
    required: ["request_type"],
  },
};

/**
 * The standard tier's description of the same tool (fix wave I5). Live reads a
 * tool's description on every turn, so the old "after collecting the name,
 * callback number and message" sentence kept driving a number ask the protocol
 * says not to make. The healthcare tier and outbound keep the text above.
 */
const RECORD_CUSTOMER_REQUEST_STANDARD_DESCRIPTION =
  "Record a message or callback request as soon as you have the caller's name and what it is about, " +
  "with a number only if theirs did not come through (and a preferred callback time for callbacks). " +
  "Call this when the caller wants to leave a message or have someone call them back.";

/**
 * The message-taking protocol — its own prompt section, not a bullet, because
 * it is a procedure the model must follow in order rather than a rule it must
 * respect. The read-back in step 5 is what stops the receptionist recording a
 * misheard callback number, which is the single most damaging failure mode for
 * this capability: the caller believes they will hear back, and never does.
 */
const MESSAGE_PROTOCOL_HEADER =
  `=== MESSAGE PROTOCOL ===\n` +
  `TAKING A MESSAGE — follow this exactly:\n`;

// Each step below is a body with no number. The number is its position in the
// list the protocol is built from, so a business that sets callbackLine drops
// the urgency step and every later step renumbers without its text changing.

// See the note on BOOKING_CONFIRMATION_GUARDRAIL in capabilities/appointments.js
// for why the full-name read-back was removed. This pack is `core: true`, so
// it renders on BOOKING calls too — leaving the old sentence here would have
// reinstated the instruction on exactly the calls the other edit is for.
const STEP_NAME =
  `Name: ask for it. Do NOT say it back to them — a name you have only heard is one you may have misheard, so "Thanks — and what's the best number to reach you on?" is all you need. Once they have spelled it you may use their first name — "Thanks, Nithin — ". If a name is on their record from an earlier call, it may not be who is calling: ask once "Am I speaking with <name>?" If yes, use it and do not ask them to spell it. If no, ask for their name. In your one question, just say the name — "for Nithin Dodla" — and do not spell it; letters are only for a name they spelled for you on this call. Do not ask them to spell anything unless you are told to.`;

// Round A1 (owner, 2026-10-13): the number used to be read back on its own
// ("Read it back digit by digit to confirm") and the message saved "only
// AFTER the read-back is confirmed" — two waits for a yes. Now one summary,
// saved in the same breath; a correction files it again.
//
// LVX189 (2026-11-07): one ask, and the caller-ID number offered on it. The
// number was asked seven turns running while the caller ID sat unused; the
// ask cutter (lib/voice/askLedger.js) now counts it in code, and this offers
// the number they are calling from first. The model "knows" it only from the
// THIS CALLER'S NUMBER block (services/gemini.js), which renders nothing for
// a withheld caller (Twilio's placeholders, isWithheldCallerNumber) or a call
// from the business's own line (recorded with no caller number). Task 4's
// fallbackNumber covers a save with no number.
const STEP_NUMBER =
  `Number: if you know the number they are calling from, ask once: "Is the number you're calling from the best one?" Anything other than a different number means use it. If you do not have it, ask for the best number once. You will read it back digit by digit in your one summary, not now.`;

const STEP_REASON = `Reason: ask briefly what the call is regarding.`;

const STEP_URGENCY = `Urgency: ask "Is this urgent, or is sometime in the next business day okay?"`;

const STEP_SUMMARISE =
  `Summarise it ONCE, in one breath — name (a surname they spelled, one letter at a time), the number digit by digit, the reason — and record it with record_customer_request in that same response: "So that's Jon, D-O-E, on 2 1 4, 5 5 5, 0 1 2 3 about the invoice — passing that on now." Do not wait for a yes. If they correct anything, record it again with the fix.`;

const STEP_PROMISE_STANDING =
  `Promise the callback: "Someone will get back to you [urgent: as soon as possible / normal: by the next business day]."`;

const STEP_EXTRA_QUESTIONS =
  `Extra questions: if this business's notes list more questions, save as soon as you have name, number and reason, keep going one question at a time, then call record_customer_request once more with the same message and the answers in details. Skip anything they would rather not answer and never ask it again. Set caller_type whenever you can tell.`;

/**
 * The line the business chose for who calls back and how soon, or null when it
 * has not set one. The loader has already cleaned it (no double quotes, no
 * newlines, at most 160 characters).
 */
function callbackLineOf(cfg) {
  return typeof cfg?.callbackLine === "string" && cfg.callbackLine.trim() ? cfg.callbackLine : null;
}

const STANDARD_PROTOCOL_HEADER =
  `=== MESSAGE PROTOCOL ===\n` +
  `TAKING A MESSAGE — a goal, not a script. Use your own words:\n`;

/**
 * The standard tier's protocol lines, shared by the Live static prefix
 * (messageProtocol) and the cascade step guidance (messageGuidance) so the two
 * say the same thing. Described, never scripted: no quoted question for the
 * model to recite (the 2026-09-05 tic rule). The callbackLine is the business's
 * own text and stays quoted. The healthcare tier does not use this.
 *
 * What each caller type needs is also handed back per type, in the
 * set_call_intent reply (lib/voice/intakePath.js).
 * @param {object} cfg - the messages capability config
 * @param {object} config - the business config (tier and the two intake settings)
 * @param {{ callback?: boolean }} [opts]
 * @returns {string[]}
 */
function standardLines(cfg, config, { callback = false } = {}) {
  const callbackLine = callbackLineOf(cfg);
  const each = confirmStyleOf(config) === "each";
  const spell = spellUpFrontOf(config);
  const lines = [
    `Goal: get what the business needs to pass this on. Anything the caller has already said counts as answered: never ask it again, and never guess a detail. If something is unclear, ask once.`,
    `Before your first question, say one short line tied to what they asked for, saying why a few questions follow. Never repeat the greeting's words. Ask one question per turn, acknowledging the last answer without opening every question with thanks.`,
    `Name: ask a personal caller for their first name only, and everyone else for their name. If a name is on their record from an earlier call, use it only to confirm once, and only when the caller has not given a name; never ask them to spell a confirmed on-file name. What the caller says about who they are wins over the record.`,
    `Number: when THIS CALLER'S NUMBER is known, do not ask for a number; it is the callback number, and they can give another. When it is not known, ask for the best number once.`,
  ];
  if (!callbackLine) {
    lines.push(
      `Urgency: ask an existing client whether it is urgent only when what they said suggests it matters; do not ask anyone else.`
    );
  }
  lines.push(
    `Save with record_customer_request as soon as you have the minimum: their name and what it is about` +
      (callback ? `, their preferred callback time,` : ``) +
      ` plus a number if theirs did not come through.`
  );
  // The business-questions line only means something when the notes list some
  // (fix wave M8a); a business with none does not carry it on every turn.
  if (hasMessageNotes(config)) {
    lines.push(
      `Then ask this business's own questions, if its notes list any: new enquiries by default, other callers only when the notes say so. Ask all of them, in the business's order, one at a time, skipping any the caller already answered. If the caller says they are short of time, offer to leave the rest for the callback. Then save again with the same message and the answers in details.`
    );
  }
  lines.push(
    each
      ? `Confirming: confirm each answer briefly as it is given, spelling the surname back from what you heard and saying any number digit by digit; there is no closing recap.`
      : `Confirming: for new enquiries and existing clients, make one read-back at the end: ${END_READ_BACK}.`
  );
  lines.push(
    spell === "leads"
      ? `Spelling: ask new enquiries and existing clients to spell their surname before you save. Ask nobody else.`
      : spell === "everyone"
        ? `Spelling: ask every caller who leaves a message to spell their name before you save.`
        : `Spelling: do not ask anyone to spell; the ${each ? "confirmation" : "read-back"} spells it.`
  );
  lines.push(
    callbackLine
      ? `Promise the callback: "${callbackLine}"`
      : `Promise the callback: say someone will get back to them as soon as possible if it is urgent, otherwise by the next business day.`
  );
  return lines;
}

/**
 * The message-taking protocol for one business. With no callbackLine this is
 * the protocol the golden snapshots hold, byte for byte. With one, the urgency
 * question goes and the promise becomes the business's own line.
 * @param {object} cfg - the messages capability config
 */
function messageProtocol(cfg, config) {
  const callbackLine = callbackLineOf(cfg);
  if (!isHealthcareTier(config)) {
    return STANDARD_PROTOCOL_HEADER + standardLines(cfg, config).map((line, i) => `${i + 1}. ${line}`).join("\n");
  }
  const steps = callbackLine
    ? [STEP_NAME, STEP_NUMBER, STEP_REASON, STEP_SUMMARISE, `Promise the callback: "${callbackLine}"`, STEP_EXTRA_QUESTIONS]
    : [STEP_NAME, STEP_NUMBER, STEP_REASON, STEP_URGENCY, STEP_SUMMARISE, STEP_PROMISE_STANDING, STEP_EXTRA_QUESTIONS];
  return MESSAGE_PROTOCOL_HEADER + steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
}

/**
 * Step guidance for the two message intents. Callbacks additionally collect a
 * preferred time; everything else is shared. Follows the same numbering rule
 * as messageProtocol.
 * @param {"take_message"|"callback_request"} intent
 * @param {object} cfg - the messages capability config
 */
function messageGuidance(intent, cfg, config) {
  const callbackLine = callbackLineOf(cfg);
  if (!isHealthcareTier(config)) {
    return (
      `Your task: take the message by this goal, one question at a time. ` +
      standardLines(cfg, config, { callback: intent === "callback_request" })
        .map((line, i) => `(${i + 1}) ${line}`)
        .join(" ")
    );
  }
  const steps = [
    `ask for their name`,
    `if you know the number they are calling from, ask once whether it is the best one; otherwise ask for the best number once`,
    `ask briefly what the call is regarding` +
      (intent === "callback_request" ? ` and their preferred callback time` : ``),
  ];
  if (!callbackLine) steps.push(`ask if it's urgent or if the next business day is fine`);
  steps.push(
    `summarise it once — name (a surname they spelled, one letter at a time), the number digit by digit, reason — and call record_customer_request in that same response, without waiting for a yes; if they correct anything, record it again with the fix`
  );
  steps.push(callbackLine ? `promise the callback: "${callbackLine}"` : `promise the callback`);
  return (
    `Your task: Follow the message protocol, one question at a time: ` +
    steps.map((step, i) => `(${i + 1}) ${step}`).join("; ") +
    `.`
  );
}

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "messages",
  label: "Messages",
  // Dashboard: shown in the Voice agent's Actions.
  dashboardListing: "listed",
  description:
    "Take a message from any caller. A callback request is just a message flagged to call them back — same record, sorted for your team. Always on.",
  core: true,
  adapterKind: null,

  toolNames: [RECORD_CUSTOMER_REQUEST_DECLARATION.name],
  configSchema: {
    require: {
      identity: {
        type: "identityFields",
        label: "What must the caller provide before we take a message?",
        builtinOptions: ["name", "callback_number"],
        allowCustom: true,
      },
    },
    notes: {
      type: "longtext",
      label: "Anything specific about how you take messages?",
      placeholder: "e.g. Always ask which department the message is for",
    },
    callbackLine: {
      type: "text",
      label: "What should the assistant promise about getting back to the caller?",
      placeholder: "e.g. Sam will call you back as soon as he can.",
    },
    // How the assistant checks what it heard. "end" reads the details back once
    // when the message is complete; "each" confirms each answer as it is given.
    confirmStyle: {
      type: "choice",
      label: "How should answers be confirmed?",
      options: ["end", "each"],
      optionLabels: {
        end: "Once, at the end",
        each: "After each answer",
      },
      default: "end",
    },
    // LVX192 fix round 2. Reasons that skip the numbered-question list: a save
    // whose message starts with one of these (e.g. "URGENT") gets the generic
    // questions note, so an urgent caller is put through rather than asked the
    // booking questions. Operator-set on import; no dashboard control yet.
    questionsSkipReasonPrefixes: {
      type: "list",
      label: "Message reasons that skip the question list",
      maxItems: 5,
      maxLength: 40,
    },
    // When the assistant asks the caller to spell their name before the reason
    // for the call, rather than only when it is needed.
    spellUpFront: {
      type: "choice",
      label: "Ask callers to spell their name up front?",
      options: ["no", "leads", "everyone"],
      optionLabels: {
        no: "No, only when it is unclear",
        leads: "Yes, for new enquiries and existing clients",
        everyone: "Yes, for every caller who leaves a message",
      },
      default: "no",
    },
  },


  actionTools: ["record_customer_request"],

  tools(config) {
    // Core: registered on every call regardless of configuration.
    const declaration = isHealthcareTier(config)
      ? RECORD_CUSTOMER_REQUEST_DECLARATION
      : { ...RECORD_CUSTOMER_REQUEST_DECLARATION, description: RECORD_CUSTOMER_REQUEST_STANDARD_DESCRIPTION };
    return [withRequirements(declaration, capabilityConfig(config, "messages"))];
  },

  prompt(config) {
    const cfg = capabilityConfig(config, "messages");
    return {
      static: {
        capabilities: ["take messages and schedule callbacks for follow-up"],
        protocols: [messageProtocol(cfg, config)],
        guardrails: requirementPromptLines(cfg).map((l) => `${l}
`),
        capabilityNotes: notesPromptLines(cfg),
      },
      dynamic: {
        stepGuidance: {
          take_message: messageGuidance("take_message", cfg, config),
          callback_request: messageGuidance("callback_request", cfg, config),
        },
      },
    };
  },

  /**
   * Recording is optimistic on purpose: it reports success to the model
   * immediately and defers the write to onEffect.
   *
   * Awaiting the write here would make the caller wait on a database round trip
   * mid-sentence, for a message the fallback flow can re-record anyway.
   * Message-taking is the safety net beneath every other capability, so it must
   * never be the thing that stalls a call.
   */
  async execute(fc, ctx = {}) {
    const args = fc.args ?? {};
    const message = "I'll make sure they get your message.";
    const notes = capabilityConfig(ctx?.config, "messages").notes;
    const hasNotes = typeof notes === "string" && notes.trim() !== "";
    const hasCallback = typeof args.callback_number === "string" && args.callback_number.trim() !== "";
    const needsNumber = !hasCallback && !isRealCallerNumber(ctx?.callerPhone);
    // S4-F3: the spelled read-back first, then the number, then the questions.
    const readBack = spelledReadBackNote(args, ctx);
    // I8: a lead at a business with its own questions, saving before any answer is in:
    // questions first, the read-back after the last answer (standard tier only).
    // Only the call's FIRST message save (P32 N2: a correction re-save hands its letters),
    // and only when the notes look like questions (a "?" or the word "ask"): rules-only
    // notes would defer the letters for good, since no later save comes.
    const deferReadBack =
      Boolean(readBack) &&
      hasNotes &&
      /\?|\bask\b/i.test(notes) &&
      ctx?.capabilityState?.messages?.firstSaveDone !== true &&
      !isHealthcareTier(ctx?.config) &&
      !(detailsFromArgs(args)?.answers?.length > 0) &&
      decisionTypeOf(intakeTypeFor(args, ctx)) === "new_enquiry";
    // LVX192 Task 5 (standard tier only): the labels saved so far this call, and
    // the numbered notes questions with no saved answer. The list replaces
    // today's generic note only when the caller is already in the business's
    // question flow (a saved label answers a numbered question); otherwise
    // today's text stands, byte for byte.
    const standardTier = !isHealthcareTier(ctx?.config);
    const questionLikeNotes = hasNotes && /\?|\bask\b/i.test(notes);
    let savedLabels = null;
    let listNote = null;
    let openCount = 0;
    if (standardTier) {
      const seen = new Set();
      savedLabels = [];
      const prior = ctx?.capabilityState?.messages?.savedLabels;
      const now = (detailsFromArgs(args)?.answers ?? []).map((a) => a.label);
      for (const label of [...(Array.isArray(prior) ? prior : []), ...now]) {
        if (typeof label !== "string") continue;
        const key = label.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        savedLabels.push(label);
      }
      savedLabels = savedLabels.slice(-MAX_SAVED_LABELS);
      if (questionLikeNotes) {
        const questions = parseNotesQuestions(notes);
        // Fix round 2: the list also starts on a save with no labels yet (the
        // caller's first save, before any answer is in), so an opener that gives
        // two answers at once is still asked the rest. A save whose reason starts
        // with one of the business's skip words (e.g. "URGENT") keeps today's
        // text: that caller is put through, not asked the questions.
        const reason = typeof args.message === "string" ? args.message.trim().toLowerCase() : "";
        const skipWords = capabilityConfig(ctx?.config, "messages").questionsSkipReasonPrefixes;
        const skipped =
          reason !== "" &&
          Array.isArray(skipWords) &&
          skipWords.some((w) => typeof w === "string" && w.trim() !== "" && reason.startsWith(w.trim().toLowerCase()));
        // Opus review I1: the call's FIRST save starts it too, whatever its labels
        // (a traveller's name saved as "Passenger" answers no question). M1: the
        // new starts are for a new enquiry only (an unknown type counts as one);
        // a complaint or an existing client keeps today's text.
        const firstSave = ctx?.capabilityState?.messages?.firstSaveDone !== true;
        const enquiry = decisionTypeOf(intakeTypeFor(args, ctx)) === "new_enquiry";
        const startsHere = enquiry && (firstSave || savedLabels.length === 0);
        const listStarts = !skipped && (startsHere || anyAnswered(questions, savedLabels));
        if (questions.length >= 2 && listStarts) {
          const open = openQuestions(questions, savedLabels);
          openCount = open.length;
          // Confirm before the next question: only a save that added an answer
          // has something to confirm (review M3: a re-save of answers already
          // saved does not), and only a business that confirms each answer as
          // given ("end" makes one read-back at the end instead).
          const priorKeys = new Set((Array.isArray(prior) ? prior : []).map((l) => String(l).trim().toLowerCase()));
          const added = now.some((l) => !priorKeys.has(String(l).trim().toLowerCase()));
          const lead = added && confirmStyleOf(ctx?.config) === "each" ? CONFIRM_FIRST_NOTE : MODEL_NOTE_PREFIX;
          listNote = open.length
            ? `${lead}This business's questions with no saved answer yet: ${open.map((q) => `${q.n}. ${q.label}`).join(", ")}. If they apply to this caller (new enquiries by default, other callers only when the notes say so), ask them now in that order, one at a time; if the caller already gave one, save it under the label shown instead of asking again; skip any they would rather not answer. If they say they are short of time, offer to leave the rest for the callback. Then save again with the same message and all the answers in details.`
            : `${lead}${ALL_QUESTIONS_ANSWERED_NOTE.slice(MODEL_NOTE_PREFIX.length)}`;
        }
      }
    }
    // A save the end_call guard forced is ALWAYS quiet (no completion note, not
    // counted as new work). Its TEXT: open questions in scope -> the list; in
    // scope and all answered -> the quiet sentence; out of scope or unknown ->
    // today's questions note, unchanged.
    const quietSave = standardTier && ctx?.saveGuardPending === true;
    const quietAllAnswered = quietSave && listNote !== null && openCount === 0;
    const preceded = Boolean(readBack) || needsNumber;
    const questionsPart = quietAllAnswered
      ? [preceded ? `Then: ${QUIET_SAVE_NOTE}` : `[not caller speech] ${QUIET_SAVE_NOTE}`]
      : [listNote ?? (hasNotes ? nextQuestionsNote(ctx?.config) : null)];
    const next = (
      deferReadBack
        ? [needsNumber ? NO_NUMBER_NOTE : null, NEXT_QUESTIONS_NOTE_DEFERRED]
        : [readBack, needsNumber ? NO_NUMBER_NOTE : null, ...questionsPart]
    )
      .filter(Boolean)
      .join(" ");
    return {
      functionResponse: {
        id: fc.id,
        name: fc.name,
        // `next` before `message`, so the reply the model reads leads with it.
        response: { success: true, ...(next ? { next } : {}), message },
      },
      stateEffects: {
        // Written for the caller, so it may be spoken if the model produces no
        // text of its own. See the callerSafe note in services/gemini.js.
        toolResult: { name: fc.name, success: true, message, callerSafe: true },
        toolCallEvent: { name: fc.name, args },
        capabilityEffects: [{ capability: "messages", type: "recorded", data: args }],
        // The call's first message save is behind us (the I8 deferral is for that one only).
        capabilityState: { messages: { firstSaveDone: true, ...(savedLabels ? { savedLabels } : {}) } },
        ...(listNote !== null ? { questionsOpen: openCount > 0 } : {}),
        ...(quietSave ? { quietSave: true } : {}),
      },
    };
  },

  /**
   * Persist the message. The business is told once, at call end, from the
   * pending row; only a save with no call row emails here.
   *
   * Any email is gated on the row actually being written: promising the
   * caller a callback and storing nothing is the worst outcome this capability
   * has, because nobody finds out until the caller gives up waiting.
   */
  onEffect(effect, engine) {
    if (effect.type !== "recorded") return;

    // Taking a message IS the whole job on this kind of call, so the step
    // machine must say so — exactly as the appointments and quotes packs do
    // after their own completing action.
    //
    // Without this, a message-taking call never left "gather_details", and
    // end_call's gate (services/tools.js) refused every attempt to hang up
    // after the goodbye had already been spoken. Set before the businessId
    // guard below: the conversational outcome is the same whether or not the
    // row lands, and refusing to let the assistant end the call is not a
    // sensible response to a failed insert.
    engine.setStep(engine.STEPS.CONFIRM, "record_customer_request");

    const { callSid, businessId, callId, config } = engine.call;
    if (!businessId) return;
    // Task 18, owner decision D-c: not reachable on outbound today ("messages"
    // is not a legal campaign capability — lib/outbound/campaignSchema.js
    // CAMPAIGN_ENUMS.capabilities), but wired the same way as every other
    // text-sending effect against the day it might be. Fix round 1, O-13:
    // partyOfEffect prefers the effect's own stamp over the live
    // engine.call.party. Inbound is byte-identical — the stamp is always null
    // there, so this falls back to engine.call.callerNumber.
    const party = partyOfEffect(effect, engine.call);

    const args = effect.data || {};
    const { db, notifications, log, captureException } = engine.deps;

    // Scoped by the capability itself, because a DEFERRED EFFECT runs after
    // executeToolCallGuarded's withTenantSafe has already closed — it inherits
    // no scope at all. Under FORCE row-level security (migration 029) that is a
    // REFUSED write, not a degraded one, and the refusal is invisible from
    // here: the tool has already told the model it succeeded.
    //
    // Proven on a live call:
    //   tool_result success=true tool=record_customer_request
    //   db_error   new row violates row-level security policy for "customer_requests"
    // The caller was told their message had been taken. It had not.
    //
    // Round A1 S3 (I3): saveCustomerRequest opens that scope itself, and turns
    // a same-call correction ("no, it's 0 1 2 4") into an UPDATE of the row it
    // corrects, so a caller who fixes something leaves one row.
    //
    // Ilija inbound, Task 4: a row filed on a call is saved with
    // ownerNoticePending, and the owner's one email goes at call end (Tasks 5
    // and 6), once the caller's answers are in. Only a save with no call row has
    // nothing to hold the email, so it is sent here at once. The number the
    // caller rang from fills a NEW row only when it is a real number: Twilio
    // sends a withheld caller as a placeholder that must never be stored as a
    // callback number.
    saveCustomerRequest({
      db,
      businessId,
      callId,
      callSid,
      row: {
        requestType: args.request_type || "message",
        callerName: args.caller_name || null,
        callbackNumber: args.callback_number || null,
        message: args.message || null,
        preferredTime: args.preferred_time || null,
        details: detailsFromArgs(args),
      },
      fallbackNumber: isRealCallerNumber(party.phone) ? party.phone : null,
      // CA082a6db7: the model sent "message" on one save and "callback" on the
      // other for one request; both are this pack's, so the match looks at both.
      matchTypes: MESSAGE_PACK_TYPES,
      // Fix round 2 (Opus review C1): only where the notes ask numbered
      // questions is a row with no answers an unfinished intake, so a corrected
      // name may take it over. Elsewhere every row is bare and two people on
      // one call stay two rows.
      takeOverBareRow:
        !isHealthcareTier(config) && parseNotesQuestions(capabilityConfig(config, "messages").notes).length >= 2,
    })
      .then((saved) => {
        if (!saved) return;
        if (saved.corrected) {
          // Names only: the message is the caller's own words (LVX24).
          log.info("customer_request_corrected", {
            callSid,
            tool: "record_customer_request",
            ...(saved.nameTakeover ? { nameTakeover: true } : {}),
          });
        }
        if (!saved.ownerNoticePending) {
          notifications
            .notifyCustomerRequest({
              businessId,
              customerRequest: args,
              call: { callerNumber: party.phone },
            })
            .catch((err) => {
              log.error("notify_request_failed", { callSid, reason: err?.message });
            });
        }
        // Owner decision D-c: every TEXT-SENDING effect on an outbound call
        // requires party.verified. The caller's acknowledgement goes once, at
        // the first save.
        // M3: the after-call message is never acknowledged to the caller: nothing new is said to them.
        if (!saved.corrected && party.verified && effect.afterCall !== true) {
          notifications
            .sendCallerSms(config, party.phone, "message_received", {
              name_part: args.caller_name ? ` ${args.caller_name}` : "",
              business: config?.businessName,
              sla: notifications.MESSAGE_SLA_TEXT,
            })
            .catch((err) =>
              log.error("sms_followup_failed", {
                callSid,
                kind: "message_received",
                reason: err?.message,
              })
            );
        }
      })
      .catch((err) => captureException(err, { callSid }));
  },
};
