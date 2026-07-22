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
  `1. Name: ask for it. If it's unusual or you're unsure of spelling, confirm: "Could you spell that for me?"\n` +
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
  core: true,
  adapterKind: null,

  toolNames: [RECORD_CUSTOMER_REQUEST_DECLARATION.name],

  actionTools: ["record_customer_request"],

  tools() {
    // Core: registered on every call regardless of configuration.
    return [RECORD_CUSTOMER_REQUEST_DECLARATION];
  },

  prompt() {
    return {
      static: {
        capabilities: ["take messages and schedule callbacks for follow-up"],
        protocols: [MESSAGE_PROTOCOL_SECTION],
      },
      dynamic: {
        stepGuidance: {
          take_message: messageGuidance("take_message"),
          callback_request: messageGuidance("callback_request"),
        },
      },
    };
  },
};
