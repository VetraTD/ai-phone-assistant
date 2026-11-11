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
  const nameLetters = ctx.callerSpelled === true && name ? spelledNameReadBack(name) : null;
  if (nameLetters) items.push({ say: `their name, "${nameLetters}"`, voiced: nameVoicedIn(name, said) });
  const emails = new Set((detailsFromArgs(args)?.answers || []).flatMap((a) => emailsInAnswer(a.answer)));
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

/**
 * The message-taking protocol for one business. With no callbackLine this is
 * the protocol the golden snapshots hold, byte for byte. With one, the urgency
 * question goes and the promise becomes the business's own line.
 * @param {object} cfg - the messages capability config
 */
function messageProtocol(cfg) {
  const callbackLine = callbackLineOf(cfg);
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
function messageGuidance(intent, cfg) {
  const callbackLine = callbackLineOf(cfg);
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
  label: "Messages & callbacks",
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
  },


  actionTools: ["record_customer_request"],

  tools(config) {
    // Core: registered on every call regardless of configuration.
    return [withRequirements(RECORD_CUSTOMER_REQUEST_DECLARATION, capabilityConfig(config, "messages"))];
  },

  prompt(config) {
    const cfg = capabilityConfig(config, "messages");
    return {
      static: {
        capabilities: ["take messages and schedule callbacks for follow-up"],
        protocols: [messageProtocol(cfg)],
        guardrails: requirementPromptLines(cfg).map((l) => `${l}
`),
        capabilityNotes: notesPromptLines(cfg),
      },
      dynamic: {
        stepGuidance: {
          take_message: messageGuidance("take_message", cfg),
          callback_request: messageGuidance("callback_request", cfg),
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
    const next = [readBack, needsNumber ? NO_NUMBER_NOTE : null, hasNotes ? NEXT_QUESTIONS_NOTE : null]
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
    })
      .then((saved) => {
        if (!saved) return;
        if (saved.corrected) {
          // Names only: the message is the caller's own words (LVX24).
          log.info("customer_request_corrected", { callSid, tool: "record_customer_request" });
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
        if (!saved.corrected && party.verified) {
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
