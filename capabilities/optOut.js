// capabilities/optOut.js
/**
 * S3-3 (spec §12.2): the "opt_out" PLATFORM pack -- `opt_out`.
 *
 * PLATFORM, not tenant (see lib/outbound/policy.js's PLATFORM_PACKS doc and
 * capabilities/outcome.js's file header for the shared mechanics: `tools()`
 * returns its declaration unconditionally, and services/gemini.js's
 * filterForOutboundCampaign / services/tools.js's execution-time mirror are
 * what union it onto every outbound call and strip it from every inbound
 * one).
 *
 * NOT an action tool (named risk 2): a stop-calling request is not a
 * caller-visible task completed FOR them, so it must not unlock a same-turn
 * end_call, and -- the load-bearing half -- it must never be blocked by
 * O-12's unverified-party refusal (services/tools.js), which gates only
 * `pack.actionTools`. A wrong-number person who never confirms any identity,
 * and a gatekeeper who is never the contact, must both still be able to stop
 * the calls.
 *
 * Per memory refusal-message-is-a-request: the row is the guarantee, not the
 * sentence Ava says. So the suppression is inserted IMMEDIATELY, inside this
 * tool's own tenant scope (services/tools.js's executeToolCallGuarded already
 * holds one open for the whole call) and awaited before this returns --
 * exactly the reasoning capabilities/smsConsent.js's own execute() doc gives
 * for writing consent immediately rather than deferring to onEffect: there is
 * no fallback flow for a promise that never lands, so the tool must not
 * report success until the row does.
 *
 * A second call on the same contact is a safe no-op: insertSuppression's
 * `ON CONFLICT (business_id, phone_e164) DO NOTHING` (services/db.js) means
 * this never throws and never duplicates, whatever inserted the first row
 * (this tool, the wrong_number branch of set_call_outcome, or the D9
 * transcript detector in lib/outbound/postCall.js).
 */
import { partyOf } from "../lib/capabilities/party.js";
import { isValidE164 } from "../lib/validate.js";

const OPT_OUT_DECLARATION = {
  name: "opt_out",
  description:
    "Call this the moment the contact asks to stop being called, to be taken off the list, or anything " +
    "equivalent -- even from a gatekeeper or someone who says this is the wrong number. Say the " +
    "confirmation sentence you have been given for this situation, then call this tool.",
  parameters: { type: "object", properties: {}, required: [] },
};

/** @type {import("./_contract.js").CapabilityPack} */
export default {
  id: "opt_out",
  label: "Opt out / do not call",
  description:
    "Record a do-not-call request immediately, inside the call, so this contact is never dialled again. " +
    "Always available on an outbound call; never used on inbound.",
  core: false,
  adapterKind: null,

  toolNames: [OPT_OUT_DECLARATION.name],
  // Named risk 2: never an action tool. See the file header.
  actionTools: [],

  tools() {
    return [OPT_OUT_DECLARATION];
  },

  async execute(fc, ctx = {}) {
    const phone = partyOf(ctx).phone;
    const callSid = ctx.callSid || null;

    if (isValidE164(phone)) {
      await ctx.deps?.insertSuppression?.({
        phone,
        reason: "opted_out",
        sourceCallId: ctx.callId || null,
        createdBy: "tool",
      });
    }
    if (callSid) {
      await ctx.deps?.setCallOutcomeCode?.(callSid, "opted_out");
    }

    const message =
      'Confirmed and recorded -- this contact will not be called again. If you have not already said so, ' +
      'tell them exactly what you were given to say for this situation, then end the call.';
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true, message } },
      stateEffects: {
        toolResult: { name: fc.name, success: true, message },
        toolCallEvent: { name: fc.name, args: fc.args ?? {} },
        capabilityState: { opt_out: { done: true } },
      },
    };
  },
};
