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

/**
 * Escalation etiquette. The fallback clause matters as much as the transfer
 * itself: when no human is reachable, the caller must still leave with
 * something, which is why this hands off to the message protocol rather than
 * apologising and ending.
 */
const ESCALATION_SECTION =
  `=== ESCALATION ===\n` +
  `When transferring: tell the caller briefly why and to whom ("Let me get you over to someone who can help with that — one moment."), then use request_transfer. If transfer is unavailable or fails, say so honestly and offer to take a message using the message protocol.`;

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

  prompt(config, ctx = {}) {
    // The tool is always registered, but the CAPABILITIES line must not promise
    // a transfer the business cannot actually take — transferAllowed folds in
    // the transfer_policy (never / business_hours_only) and whether a transfer
    // number is even configured.
    const transferAllowed = ctx.transferAllowed !== false;

    return {
      static: {
        capabilities: transferAllowed ? ["transfer the caller to a person when needed"] : [],
        escalation: [ESCALATION_SECTION],
      },
    };
  },
};
