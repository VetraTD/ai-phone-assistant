/**
 * Transfer-to-human capability pack.
 *
 * CORE: always on. Escalating to a person is baseline receptionist behavior,
 * and a caller must never be trapped in the conversation.
 *
 * Registered unconditionally rather than gated on configuration, then refused
 * at EXECUTION time on ctx.transferAllowed. That ordering is deliberate: gating
 * registration on an English-language regex fast-path used to mean a caller
 * asking for a person in Spanish had no tool to reach. Register always, decide
 * at execution — the model can then honor the request in any language.
 *
 * Step A status: tool declaration only, moved verbatim from services/gemini.js.
 */

const REQUEST_TRANSFER_DECLARATION = {
  name: "request_transfer",
  description:
    "Transfer the caller to a human. Use when the caller asks for a person/" +
    "representative/manager in any language, or when you cannot help and " +
    "transfer is appropriate.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "Brief reason for the transfer" },
    },
    required: ["reason"],
  },
};

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "transfer",
  core: true,
  adapterKind: null,

  toolNames: [REQUEST_TRANSFER_DECLARATION.name],

  // Not an action tool: a transfer hands the call off rather than completing a
  // task within it, so it must not unlock same-turn end_call.
  actionTools: [],

  tools() {
    return [REQUEST_TRANSFER_DECLARATION];
  },
};
