// capabilities/outcome.js
/**
 * S3-3 (spec §12.2): the "outcome" PLATFORM pack -- `set_call_outcome`.
 *
 * PLATFORM, not tenant. See lib/outbound/policy.js's PLATFORM_PACKS doc: this
 * pack's tool is unioned onto every outbound call regardless of what the
 * campaign's own `capabilities` list says (services/gemini.js
 * filterForOutboundCampaign, services/tools.js's execution-time mirror), and
 * stripped from every inbound call by the same filter. `tools()` below
 * therefore returns its declaration unconditionally, exactly like
 * transfer.js's CORE pattern -- direction is decided downstream, never here.
 *
 * NOT an action tool (`actionTools: []`, named risk 2): recording an outcome
 * does nothing FOR the caller, so it must not unlock a same-turn end_call,
 * and O-12's unverified-party refusal (services/tools.js) gates only
 * `pack.actionTools`, so a gatekeeper or a wrong-number person -- neither of
 * whom will ever pass confirm_identity -- can still have an outcome recorded
 * for the call.
 *
 * `wrong_number` is the wrong-number suppression writer, a must-hold (spec
 * §12.2): it inserts a suppression (reason `wrong_number`, created_by `tool`)
 * IMMEDIATELY, inside this tool's own tenant scope (services/tools.js's
 * executeToolCallGuarded already holds one open for the whole call), and the
 * CALL's own recorded outcome is `wrong_person` -- the value
 * lib/outbound/postCall.js's TERMINAL_OUTCOMES already knows, not the
 * argument value itself, which the suppression reason alone carries.
 *
 * `booked`/`opted_out`/`transferred` are refused: those three outcomes are
 * each set by their OWN door (book_appointment's effect, the opt_out pack,
 * request_transfer's effect) precisely because each has its own immediate,
 * must-land side effect this tool does not perform. A model calling
 * set_call_outcome for one of them would be recording the outcome without
 * the effect that is supposed to accompany it.
 */
import { OUTBOUND_OUTCOME_ENUM_MIRROR } from "./_outcomeEnum.js";
import { partyOf } from "../lib/capabilities/party.js";
import { isValidE164 } from "../lib/validate.js";
import { bumpCounter } from "../lib/voice/metrics.js";

const SET_CALL_OUTCOME_DECLARATION = {
  name: "set_call_outcome",
  description:
    "Record how this outbound call ended. Call this once, near the end of the call, choosing whichever " +
    "option best matches what actually happened. Never call this for a booking (book_appointment already " +
    "records that), an opt-out request (use the opt_out tool instead), or a transfer (request_transfer " +
    "already records that) -- this tool refuses all three.",
  parameters: {
    type: "object",
    properties: {
      outcome: {
        type: "string",
        enum: [...OUTBOUND_OUTCOME_ENUM_MIRROR],
        description:
          "qualified_no_booking: a real conversation, no booking made. not_interested: they said no. " +
          "not_a_fit: they do not meet the criteria. callback_requested: they asked to be called back at " +
          "a specific time -- use schedule_callback for that, then this. wrong_person: you established " +
          "this is not the right person (not a wrong NUMBER -- use wrong_number for that). wrong_number: " +
          "this number does not reach the right person or business at all. other: anything else, with a note.",
      },
      note: { type: "string", description: "Optional short note, e.g. what the contact asked for." },
    },
    required: ["outcome"],
  },
};

/** Outcomes with their own door/tool and their own immediate effect -- refused here on purpose. */
const REFUSED_OUTCOMES = Object.freeze({
  booked: "Do not call set_call_outcome for a booking -- book_appointment already recorded that.",
  opted_out: "Do not call set_call_outcome for an opt-out -- call the opt_out tool instead.",
  transferred: "Do not call set_call_outcome for a transfer -- request_transfer already recorded that.",
});

function refusal(fc, message) {
  return {
    functionResponse: { id: fc.id, name: fc.name, response: { success: false, message } },
    stateEffects: {
      toolResult: { name: fc.name, success: false, message },
      toolCallEvent: { name: fc.name, args: fc.args ?? {}, silent: true },
    },
  };
}

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "outcome",
  label: "Call outcome",
  description:
    "Record how an outbound call ended (qualified, not interested, wrong number, ...). Always available " +
    "on an outbound call; never used on inbound.",
  core: false,
  adapterKind: null,

  toolNames: [SET_CALL_OUTCOME_DECLARATION.name],
  // Named risk 2: never an action tool. See the file header.
  actionTools: [],

  tools() {
    return [SET_CALL_OUTCOME_DECLARATION];
  },

  async execute(fc, ctx = {}) {
    const outcome = fc.args?.outcome;

    if (Object.prototype.hasOwnProperty.call(REFUSED_OUTCOMES, outcome)) {
      return refusal(fc, REFUSED_OUTCOMES[outcome]);
    }
    if (!OUTBOUND_OUTCOME_ENUM_MIRROR.includes(outcome)) {
      return refusal(fc, `outcome must be one of: ${OUTBOUND_OUTCOME_ENUM_MIRROR.join(", ")}`);
    }

    const note = typeof fc.args?.note === "string" ? fc.args.note.slice(0, 500) : null;
    const callSid = ctx.callSid || null;
    // wrong_number is a suppression reason, never a calls.outcome_code value
    // -- the call itself is recorded as wrong_person (spec §12.2).
    const recordedOutcome = outcome === "wrong_number" ? "wrong_person" : outcome;

    if (callSid) {
      await ctx.deps?.setCallOutcomeCode?.(callSid, recordedOutcome);
    }

    if (outcome === "wrong_number") {
      // The dialled number, even while the party is unverified (party.js:
      // unverified still carries the number WE dialled) -- there is no
      // caller-proven identity needed to know which number this call is on.
      const phone = partyOf(ctx).phone;
      if (isValidE164(phone)) {
        const inserted = await ctx.deps?.insertSuppression?.({
          phone,
          reason: "wrong_number",
          sourceCallId: ctx.callId || null,
          createdBy: "tool",
        });
        if (inserted) bumpCounter("outbound_wrong_number_suppressed");
      }
    }

    const message = "Noted.";
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true, message } },
      stateEffects: {
        toolResult: { name: fc.name, success: true, message },
        toolCallEvent: { name: fc.name, args: fc.args ?? {} },
        capabilityState: { outcome: { code: recordedOutcome, note } },
      },
    };
  },
};
