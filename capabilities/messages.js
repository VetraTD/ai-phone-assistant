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
};
