/**
 * The one helper every phone-keyed consumer reads a call's party through.
 *
 * Spec §9.6 (Task 18). Two front ends build a `ctx` (or an `engine.call`) for
 * a tool/effect to read: the Live tool runner (lib/voice/live/tools.js), which
 * is the only one that can carry an outbound call today, and every inbound
 * shape (the cascade, the text harness, and every existing unit test that
 * hand-builds a ctx). Rather than teach each of those the outbound shape, this
 * is the single place a consumer asks "whose phone number is this, and is it
 * proven".
 *
 * INBOUND (no `ctx.party` set): the caller ID Twilio handed us is trusted call
 * metadata, so it has always been treated as proven. Returned verified,
 * exactly as every phone-keyed check already behaved before this file existed
 * — this is what makes today's whole inbound test suite pass unmodified.
 *
 * OUTBOUND (`ctx.party` set by the Live tool runner): the phone is the number
 * WE dialled, not one the person on the line has proven ownership of merely by
 * picking up — a receptionist, a child, or a wrong number could have answered.
 * `verified` starts false and is flipped true only by the model calling
 * `confirm_identity({name_confirmed: true})` (services/tools.js).
 *
 * Two field names for "the other party's phone" exist in this codebase and
 * both are accepted here: `callerPhone` (the tool ctx shape, e.g.
 * capabilities/requirements.js, capabilities/appointments.js) and
 * `callerNumber` (the effect-dispatch `engine.call` shape, e.g.
 * capabilities/smsConsent.js's onEffect). A consumer never needs to know which
 * one its ctx carries.
 *
 * @param {{party?: {phone: string|null, source: string, verified: boolean}, callerPhone?: string|null, callerNumber?: string|null}} [ctx]
 * @returns {{phone: string|null, source: string, verified: boolean}}
 */
export function partyOf(ctx) {
  if (ctx && typeof ctx === "object" && ctx.party && typeof ctx.party === "object") {
    return ctx.party;
  }
  const phone = ctx && typeof ctx === "object" ? ctx.callerPhone ?? ctx.callerNumber ?? null : null;
  return { phone: phone || null, source: "caller_id", verified: true };
}

/**
 * The party as it stood WHEN A CAPABILITY EFFECT WAS PRODUCED (owner decision
 * O-13, fix round 1), not the live value at the moment the effect is
 * dispatched.
 *
 * Effects are queued and dispatched later (lib/capabilities/effects.js,
 * `pendingCapabilityEffects` in lib/voice/live/index.js), and `ctx.party` in
 * the tool runner can change in between — `confirm_identity` can flip it
 * either direction on a later turn, before this call's effects have all been
 * applied. Reading the LIVE value at dispatch time would let a later
 * `confirm_identity(false)` cancel a text a verified write already earned, or
 * let a later `confirm_identity(true)` release a text for a write that (were
 * O-12 ever bypassed) happened while unverified. So every effect is stamped
 * with `party` at the moment services/tools.js's `executeToolCall` produced
 * it (see the `default:` case), and `onEffect` handlers read the stamp
 * through this helper instead of `partyOf(engine.call)` directly.
 *
 * `effect.party` is `null` on every inbound effect (ctx.party is always null
 * there), so this falls through to `engineCall`'s own fields — byte-identical
 * to `partyOf(engineCall)` for every inbound call and every existing test that
 * builds an `engine.call` by hand with no `party` field at all.
 *
 * @param {{party?: {phone: string|null, source: string, verified: boolean}|null}} [effect]
 * @param {object} [engineCall] - `engine.call`, the effect-dispatch shape
 * @returns {{phone: string|null, source: string, verified: boolean}}
 */
export function partyOfEffect(effect, engineCall) {
  return partyOf({ ...(engineCall || {}), party: effect?.party ?? engineCall?.party ?? null });
}
