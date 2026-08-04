/**
 * Quote requests capability pack.
 *
 * THIS PACK IS THE TEST OF THE DESIGN.
 *
 * It was built after the engine was already carved up, using only the seams the
 * capability contract provides — a tool declaration, prompt fragments, an
 * execute, and a deferred effect. If building it had required editing
 * services/gemini.js, services/tools.js or lib/voice/session.js, the seam would
 * have been wrong and the whole refactor suspect. It did not.
 *
 * It is deliberately shaped UNLIKE appointments, which is what makes it a real
 * test rather than a second copy of the same thing:
 *
 *                        appointments        quotes            messages
 *   external system      yes (EHR)           no                no
 *   searches availability yes                no                no
 *   confirmation gate    yes                 no                yes (read-back)
 *   on success           writes a record     notifies          notifies
 *   identity             strict (name+dob)   loose (name+phone) loose
 *
 * A contract that fit all three is probably an abstraction. One that only fit
 * appointments would have been an appointment framework wearing a costume.
 *
 * Business shape: a caller asks "how much for X?". The receptionist must never
 * quote a price — it does not know the business's pricing, and a number it
 * invents is one the business has to honor or argue about. It collects what is
 * needed to call back with a real answer.
 */

import {
  withRequirements,
  requirementPromptLines,
  notesPromptLines,
  capabilityConfig,
} from "../lib/capabilities/requirements.js";
import { declineGuardrail } from "../lib/capabilities/decline.js";


const RECORD_QUOTE_REQUEST_DECLARATION = {
  name: "record_quote_request",
  description:
    "Record a pricing enquiry after collecting what the caller wants a price for, " +
    "their name, and a callback number. Call this once you have those details. " +
    "Never quote a price yourself — the team follows up with real pricing.",
  parameters: {
    type: "object",
    properties: {
      service_description: {
        type: "string",
        description: "What the caller wants priced, in their own words",
      },
      caller_name: { type: "string", description: "Caller's name" },
      callback_number: { type: "string", description: "Phone number to call back with the quote" },
      service_address: {
        type: "string",
        description: "Where the work would happen, if the caller gives it (optional)",
      },
      urgency: {
        type: "string",
        description: "How soon they need it, if mentioned (optional)",
      },
    },
    required: ["service_description"],
  },
};

/**
 * Flow guidance. Shorter than the booking flow on purpose: there is no
 * availability to negotiate, so the only job is collecting enough to call back.
 */
const QUOTE_GUIDANCE =
  `Your task: Find out what the caller wants priced and collect enough to call them back. ` +
  `One question at a time:\n` +
  `1. Ask what specifically they'd like a price for, and listen for details that change the price.\n` +
  `2. Ask for their name.\n` +
  `3. Ask for the best callback number, and read it back digit by digit to confirm.\n` +
  `4. Read back what they asked about, then call record_quote_request.\n` +
  `NEVER give a price, a range, or an estimate — not even "usually around". You do not have ` +
  `pricing, and a number you invent is one the business has to honor. If the caller pushes for ` +
  `a figure, say you'd rather have someone give them an accurate number than guess.`;

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "quotes",
  label: "Quote requests",
  description: "Collect pricing enquiries and pass them to your team.",
  core: false,
  adapterKind: null,

  toolNames: [RECORD_QUOTE_REQUEST_DECLARATION.name],
  // No `adapter` knob: quotes has no adapterKind and always records+notifies
  // internally (see execute/onEffect). Offering a "where should quotes go?"
  // choice would be a control that does nothing. Webhook routing is a real
  // feature to add later, with an actual backend behind it.
  configSchema: {
    require: {
      identity: {
        type: "identityFields",
        label: "What must the caller provide before we log a quote request?",
        builtinOptions: ["name", "callback_number"],
        allowCustom: true,
      },
    },
    notes: {
      type: "longtext",
      label: "Anything specific about how you quote?",
      placeholder: "e.g. Always ask whether it's an emergency. Never quote a price on the phone.",
    },
  },


  // Caller-visible completion: recording the request is the thing the caller
  // called to do, so a success may wrap up the call in the same turn.
  actionTools: ["record_quote_request"],

  tools(config) {
    const allowed = config?.allowedTasks || [];
    if (!allowed.includes("quote_request")) return [];
    return [withRequirements(RECORD_QUOTE_REQUEST_DECLARATION, capabilityConfig(config, "quotes"))];
  },

  prompt(config) {
    const allowed = config?.allowedTasks || [];
    const enabled = allowed.includes("quote_request");
    return {
      static: {
        capabilities: enabled
          ? ["discuss pricing/quotes (take details for follow-up, no commitments)"]
          : [],
        guardrails: enabled
          ? requirementPromptLines(capabilityConfig(config, "quotes")).map((l) => `${l}
`)
          : [declineGuardrail("give price quotes")],
        capabilityNotes: enabled ? notesPromptLines(capabilityConfig(config, "quotes")) : [],
      },
      dynamic: {
        stepGuidance: enabled ? { quote_request: QUOTE_GUIDANCE } : {},
      },
    };
  },

  async execute(fc, ctx = {}) {
    const args = fc.args ?? {};

    // Without something to price there is nothing to follow up on, and a
    // callback the team cannot act on is worse than no callback: the caller
    // believes they will hear back with a number.
    if (!String(args.service_description || "").trim()) {
      const message = "Ask the caller what specifically they'd like priced before recording this.";
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
        stateEffects: {
          toolResult: { name: fc.name, success: false, message },
          toolCallEvent: { name: fc.name, args },
        },
      };
    }

    const message = "I'll get that over to the team and someone will call you back with a price.";
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true, message } },
      stateEffects: {
        // Addressed to the caller (unlike the refusal above, which tells the
        // MODEL what to ask next) — so this one is safe to speak verbatim.
        toolResult: { name: fc.name, success: true, message, callerSafe: true },
        toolCallEvent: { name: fc.name, args },
        // The generic channel. Nothing here names a field the engine knows.
        capabilityEffects: [{ capability: "quotes", type: "requested", data: args }],
        // Remembered so a second ask in the same call does not re-record and
        // re-notify the same enquiry.
        capabilityState: { quotes: { lastRequested: args.service_description } },
      },
    };
  },

  /**
   * Persist and notify. Runs after the turn, from either applyReply or the
   * barge-in salvage path, so a caller who talks over the confirmation still
   * gets their callback.
   */
  onEffect(effect, engine) {
    if (effect.type !== "requested") return;

    const { businessId, callId, callerNumber, config } = engine.call;
    if (!businessId) return;

    const data = effect.data || {};
    engine.setStep(engine.STEPS.CONFIRM, "record_quote_request");
    engine.addHistoryNote(
      `record_quote_request succeeded for "${data.service_description}". Do not record it again`
    );

    // Stored as a customer request of type "quote". request_type is free text
    // in the schema, so this needs no migration — and it means quotes show up
    // in the same follow-up queue the team already works from, rather than a
    // second inbox nobody checks.
    const detail = [
      data.service_description,
      data.service_address ? `Address: ${data.service_address}` : null,
      data.urgency ? `Urgency: ${data.urgency}` : null,
    ]
      .filter(Boolean)
      .join(" — ");

    engine.deps.db
      .createCustomerRequest({
        businessId,
        callId,
        requestType: "quote",
        callerName: data.caller_name || null,
        callbackNumber: data.callback_number || callerNumber || null,
        message: detail,
        preferredTime: null,
      })
      .then((id) => {
        if (!id) return;
        engine.deps.notifications
          .notifyCustomerRequest({
            businessId,
            customerRequest: {
              request_type: "quote",
              caller_name: data.caller_name || null,
              callback_number: data.callback_number || callerNumber || null,
              message: detail,
            },
            call: { callerNumber },
          })
          .catch((err) =>
            engine.deps.log.error("notify_quote_failed", { reason: err?.message })
          );
        engine.deps.notifications
          .sendCallerSms(config, callerNumber, "message_received", {
            name_part: data.caller_name ? ` ${data.caller_name}` : "",
            business: config?.businessName,
            sla: engine.deps.notifications.MESSAGE_SLA_TEXT,
          })
          .catch((err) =>
            engine.deps.log.error("sms_followup_failed", {
              kind: "quote_request",
              reason: err?.message,
            })
          );
      })
      .catch((err) => engine.deps.captureException(err));
  },
};
