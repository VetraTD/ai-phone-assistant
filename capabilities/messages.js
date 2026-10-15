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
import { saveCustomerRequest, noteOwnerNotified, ownerNotifiedFor } from "../lib/capabilities/customerRequests.js";


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
const MESSAGE_PROTOCOL_SECTION =
  `=== MESSAGE PROTOCOL ===\n` +
  `TAKING A MESSAGE — follow this exactly:\n` +
  // See the note on BOOKING_CONFIRMATION_GUARDRAIL in capabilities/appointments.js
  // for why the full-name read-back was removed. This pack is `core: true`, so
  // it renders on BOOKING calls too — leaving the old sentence here would have
  // reinstated the instruction on exactly the calls the other edit is for.
  `1. Name: ask for it. Do NOT say it back to them — a name you have only heard is one you may have misheard, so "Thanks — and what's the best number to reach you on?" is all you need. Once they have spelled it you may use their first name — "Thanks, Nithin — ". If their name is already on their record from an earlier visit, you have it right already: use it, and do not ask them to spell it again. Do not ask them to spell anything unless you are told to.\n` +
  // Round A1 (owner, 2026-10-13): the number used to be read back on its own
  // ("Read it back digit by digit to confirm") and the message saved "only
  // AFTER the read-back is confirmed" — two waits for a yes. Now one summary,
  // saved in the same breath; a correction files it again.
  `2. Number: ask for the best callback number. You will read it back digit by digit in your one summary — not now. If they say "the number I'm calling from", use it.\n` +
  `3. Reason: ask briefly what the call is regarding.\n` +
  `4. Urgency: ask "Is this urgent, or is sometime in the next business day okay?"\n` +
  `5. Summarise it ONCE, in one breath — name, the number digit by digit, the reason — and record it with record_customer_request in that same response: "So that's Jon on 2 1 4, 5 5 5, 0 1 2 3 about the invoice — passing that on now." Do not wait for a yes. If they correct anything, record it again with the fix.\n` +
  `6. Promise the callback: "Someone will get back to you [urgent: as soon as possible / normal: by the next business day]."`;

/**
 * Step guidance for the two message intents. Callbacks additionally collect a
 * preferred time; everything else is shared.
 * @param {"take_message"|"callback_request"} intent
 */
function messageGuidance(intent) {
  return (
    `Your task: Follow the message protocol, one question at a time: ` +
    `(1) ask for their name; (2) ask for the best callback number; ` +
    `(3) ask briefly what the call is regarding` +
    (intent === "callback_request" ? ` and their preferred callback time` : ``) +
    `; (4) ask if it's urgent or if the next business day is fine; ` +
    `(5) summarise it once — name, the number digit by digit, reason — and call record_customer_request in that same response, without waiting for a yes; if they correct anything, record it again with the fix; ` +
    `(6) promise the callback.`
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
  },


  actionTools: ["record_customer_request"],

  tools(config) {
    // Core: registered on every call regardless of configuration.
    return [withRequirements(RECORD_CUSTOMER_REQUEST_DECLARATION, capabilityConfig(config, "messages"))];
  },

  prompt(config) {
    return {
      static: {
        capabilities: ["take messages and schedule callbacks for follow-up"],
        protocols: [MESSAGE_PROTOCOL_SECTION],
        guardrails: requirementPromptLines(capabilityConfig(config, "messages")).map((l) => `${l}
`),
        capabilityNotes: notesPromptLines(capabilityConfig(config, "messages")),
      },
      dynamic: {
        stepGuidance: {
          take_message: messageGuidance("take_message"),
          callback_request: messageGuidance("callback_request"),
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
  async execute(fc) {
    const args = fc.args ?? {};
    const message = "I'll make sure they get your message.";
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true, message } },
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
   * Persist the message and tell the business about it.
   *
   * Notification is gated on the row actually being written: promising the
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
    // corrects. A corrected row is already in the owner's inbox -- the email
    // is link-only and went out at the first save -- so a correction sends
    // nothing: one email per message. Unless that first send never reached the
    // owner (SMTP refused it, the rate limit dropped it): then the correction
    // sends it, as its own email always used to.
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
      },
    })
      .then(async (saved) => {
        if (!saved) return;
        if (saved.corrected) {
          // Names only: the message is the caller's own words (LVX24).
          log.info("customer_request_corrected", { callSid, tool: "record_customer_request" });
          if (await ownerNotifiedFor(saved.id)) return;
        }
        noteOwnerNotified(
          saved.id,
          notifications
            .notifyCustomerRequest({
              businessId,
              customerRequest: args,
              call: { callerNumber: party.phone },
            })
            .catch((err) => {
              log.error("notify_request_failed", { callSid, reason: err?.message });
              return false;
            })
        );
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
