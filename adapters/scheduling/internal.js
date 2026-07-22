/**
 * Internal scheduling adapter — appointments in our own `appointments` table.
 *
 * The default, and the only one that works for a business with no external
 * system at all. Its identity story is deliberately thin: the table stores a
 * name and a phone number, so those are the only things it can prove a caller
 * against. Claiming more would be a lie the settings UI would then repeat to
 * an operator.
 */

/** @type {import("./types.js").SchedulingAdapter} */
export default {
  id: "internal",
  label: "Our built-in calendar",

  // Name alone is NOT here. A name is public information, and knowing one must
  // never be enough to cancel a stranger's appointment — the phone number is
  // the second factor. See the appointments pack's identity check.
  verifiableFields: ["phone_on_file", "phone_last4"],

  /** This adapter is the fallback; it never claims an integration. */
  claimsIntegration() {
    return false;
  },

  /**
   * Look the caller up by the number they are calling FROM — trusted Twilio
   * metadata, never a model-supplied value, so a caller cannot fish for
   * someone else's appointments by naming a different number.
   */
  async lookupByCaller(ctx) {
    if (!ctx.businessId || !ctx.callerPhone) return [];
    return ctx.deps.listAppointmentsByCaller(ctx.businessId, { clientPhone: ctx.callerPhone });
  },

  async book(ctx, { clientName, clientPhone, scheduledAt, notes }) {
    const id = await ctx.deps.createAppointment({
      businessId: ctx.businessId,
      callId: ctx.callId || null,
      clientName: clientName || null,
      clientPhone: clientPhone || null,
      scheduledAt,
      notes,
    });
    return { ok: !!id, id: id || null };
  },

  async cancel(ctx, { appointmentId }) {
    const ok = await ctx.deps.updateAppointmentStatus(appointmentId, "cancelled", ctx.businessId);
    return { ok: !!ok };
  },

  async reschedule(ctx, { appointmentId, newScheduledAt }) {
    const ok = await ctx.deps.updateAppointment(
      appointmentId,
      { scheduled_at: newScheduledAt },
      ctx.businessId
    );
    return { ok: !!ok };
  },

  /**
   * No availability search. The internal table records what was booked; it has
   * no model of provider schedules, room capacity or appointment length, so it
   * cannot answer "what is free on Tuesday". The capability falls back to
   * suggesting times from business hours, which is what a receptionist with a
   * paper diary does.
   */
  findSlots: null,
};
