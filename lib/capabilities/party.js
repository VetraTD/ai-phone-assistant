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
