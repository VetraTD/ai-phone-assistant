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
  `1. Name: ask for it, then confirm the spelling once — "Could you spell that for me?" — unless you already confirmed it earlier in this call.\n` +
  `2. Number: ask for the best callback number. Read it back digit by digit to confirm. If they say "the number I'm calling from", confirm you'll use it.\n` +
  `3. Reason: ask briefly what the call is regarding.\n` +
  `4. Urgency: ask "Is this urgent, or is sometime in the next business day okay?"\n` +
  `5. Read the full message back once: name, number, reason. Correct anything they change.\n` +
  `6. Promise the callback: "Someone will get back to you [urgent: as soon as possible / normal: by the next business day]."\n` +
  `Record it with record_customer_request only AFTER the read-back is confirmed.`;

/**
 * Step guidance for the two message intents. Callbacks additionally collect a
 * preferred time; everything else is shared.
 * @param {"take_message"|"callback_request"} intent
 */
function messageGuidance(intent) {
  return (
    `Your task: Follow the message protocol, one question at a time: ` +
    `(1) ask for their name; (2) ask for the best callback number and read it back digit by digit to confirm; ` +
    `(3) ask briefly what the call is regarding` +
    (intent === "callback_request" ? ` and their preferred callback time` : ``) +
    `; (4) ask if it's urgent or if the next business day is fine; ` +
    `(5) read the full message back once — name, number, reason — and correct anything they change; ` +
    `(6) promise the callback. ` +
    `Only call record_customer_request after the read-back is confirmed.`
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

    const { callSid, businessId, callId, callerNumber, config } = engine.call;
    if (!businessId) return;

    const args = effect.data || {};
    const { db, notifications, log, captureException } = engine.deps;

    db.createCustomerRequest({
      businessId,
      callId,
      requestType: args.request_type || "message",
      callerName: args.caller_name || null,
      callbackNumber: args.callback_number || null,
      message: args.message || null,
      preferredTime: args.preferred_time || null,
    })
      .then((id) => {
        if (!id) return;
        notifications
          .notifyCustomerRequest({
            businessId,
            customerRequest: args,
            call: { callerNumber },
          })
          .catch((err) => log.error("notify_request_failed", { callSid, reason: err?.message }));
        notifications
          .sendCallerSms(config, callerNumber, "message_received", {
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
      })
      .catch((err) => captureException(err, { callSid }));
  },
};
