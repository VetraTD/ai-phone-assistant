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

/**
 * OUTBOUND CALLING (carried from Task 16, session 2b, Task 17). "the message
 * protocol" never exists on outbound: `messages` is not a legal outbound
 * campaign capability at all (lib/outbound/campaignSchema.js
 * CAMPAIGN_ENUMS.capabilities has no "messages" entry), so
 * lib/capabilities/promptAssembler.js's outboundAllowsPack never lets that
 * pack's MESSAGE PROTOCOL section render on an outbound call -- naming it
 * here would be the same phantom-tool defect this whole batch keeps finding.
 * Dropped rather than pointed at a replacement: stage-3's `callback` pack
 * (schedule_callback) is not built yet, and naming an undeclared tool would
 * just move the defect rather than fix it.
 */
const ESCALATION_SECTION_OUTBOUND =
  `=== ESCALATION ===\n` +
  `When transferring: tell the caller briefly why and to whom ("Let me get you over to someone who can help with that — one moment."), then use request_transfer. If transfer is unavailable or fails, say so honestly.`;

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "transfer",
  label: "Transfers",
  // Dashboard: shown in the Voice agent's Actions.
  dashboardListing: "listed",
  // Dashboard: its policy and number live on the business row; this names the
  // panel that edits them under the action (TransferRulesSection).
  dashboardPanel: "transferRules",
  description: "Hand the caller to a human when they ask or when we cannot help.",
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
        escalation: [ctx.outboundCall ? ESCALATION_SECTION_OUTBOUND : ESCALATION_SECTION],
      },
    };
  },

  /**
   * The gate that makes always-registering safe: the tool exists on every call,
   * but actually transferring is refused here when the business has no transfer
   * number, has transfer_policy "never", or is outside the hours its policy
   * allows. Refusing at execution rather than at registration is what lets a
   * caller ask for a person in any language and still get a coherent answer
   * instead of the model improvising around a missing tool.
   */
  async execute(fc, ctx = {}) {
    const reason = fc.args?.reason || null;

    if (!ctx.transferAllowed) {
      // b17 (checkpoint 2b review). The same phantom-tool wording
      // ESCALATION_SECTION_OUTBOUND above already avoids in the PROMPT was
      // still reachable here, at EXECUTION time: "the message protocol"
      // does not exist on outbound (messages is never a legal outbound
      // campaign capability), so a refusal that tells the model to offer
      // one is exactly the class of instruction this file's own header
      // comment on ESCALATION_SECTION_OUTBOUND already names.
      const message = ctx.outboundCall
        ? "Transfer is not available right now. Offer to call them back another time instead."
        : "Transfer is not available right now. Offer to take a message instead.";
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
        stateEffects: {
          toolResult: { name: fc.name, success: false, message },
          toolCallEvent: { name: fc.name, args: fc.args },
        },
      };
    }

    const message = "Let the caller know you are transferring them now, briefly.";
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true, message } },
      stateEffects: {
        transferRequested: { reason },
        toolResult: { name: fc.name, success: true, message },
        toolCallEvent: { name: fc.name, args: fc.args },
      },
    };
  },
};
