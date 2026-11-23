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
  // Dashboard: outbound calling only; never shown to an inbound business.
  dashboardListing: "hidden",
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
    // -- the call's outcome is set to wrong_person (spec §12.2).
    const recordedOutcome = outcome === "wrong_number" ? "wrong_person" : outcome;

    if (outcome === "wrong_number") {
      // Fix round 1 (review Important #1). Checked and, if needed, refused
      // BEFORE any write -- including before setCallOutcomeCode -- mirroring
      // capabilities/smsConsent.js's own precedent for exactly this shape (an
      // unusable phone number): a "must-hold" write must never silently
      // no-op while the tool still claims the guarantee ("they will not be
      // called again").
      //
      // The dialled number, even while the party is unverified (party.js:
      // unverified still carries the number WE dialled) -- there is no
      // caller-proven identity needed to know which number this call is on.
      const phone = partyOf(ctx).phone;
      if (!isValidE164(phone)) {
        return refusal(
          fc,
          "There is no usable phone number on this call, so the wrong-number report could not be recorded. " +
            "Do not tell them they will not be called again."
        );
      }
      const inserted = await ctx.deps?.insertSuppression?.({
        phone,
        reason: "wrong_number",
        sourceCallId: ctx.callId || null,
        createdBy: "tool",
      });
      // insertSuppression (services/db.js) returns a plain boolean: `true`
      // when THIS call's own INSERT landed, `false` when `ON CONFLICT DO
      // NOTHING` fired because a suppression already covered this number
      // (any reason, any writer) -- the guarantee already held before this
      // call ran. Anything else (`undefined` -- the deps wire itself missing
      // or broken) must NOT read as success: memory "?. hiding a missing
      // wire" -- a required write's absence must never look like it happened.
      if (inserted !== true && inserted !== false) {
        return refusal(
          fc,
          "The wrong-number report could not be recorded. Do not tell them they will not be called again."
        );
      }
      if (inserted) bumpCounter("outbound_wrong_number_suppressed");
    }

    if (callSid) {
      await ctx.deps?.setCallOutcomeCode?.(callSid, recordedOutcome);
      // I2 fix (checkpoint-A review). The note used to live only in
      // stateEffects.capabilityState.outcome.note -- a per-session, in-memory
      // scratchpad (lib/voice/live/tools.js) never serialised as a whole to
      // the DB -- so "email me instead" left no trace anywhere a future
      // results webhook (S3-8) or the business could read. Persisted the way
      // schedule_callback already persists (capabilities/callback.js's
      // mergeCallAnswers pattern): calls.answers jsonb, keyed on
      // `_outcome_note`. Ruling: the LEADING UNDERSCORE, not a plain word
      // like `outcome_note` -- a campaign question key matches
      // /^[a-z][a-z0-9_]{0,31}$/, which REQUIRES the first character to be a
      // lowercase letter, so a key starting with `_` can never match that
      // pattern regardless of what any campaign ever names a question. Cost
      // if wrong (a plain-word key instead): a campaign author naming a
      // question `outcome_note` would silently overwrite this value (or vice
      // versa) with no error either way, since a shallow JSONB merge has no
      // conflict detection.
      if (note) {
        await ctx.deps?.mergeCallAnswers?.(callSid, { _outcome_note: note });
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
