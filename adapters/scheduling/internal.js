/**
 * Internal scheduling adapter — appointments in our own `appointments` table.
 *
 * The default, and the only one that works for a business with no external
 * system at all. Its identity story is deliberately thin: the table stores a
 * name and a phone number, so those are the only things it can prove a caller
 * against. Claiming more would be a lie the settings UI would then repeat to
 * an operator.
 */

import { resolveDayHours } from "../../lib/businessHours.js";
import { zonedComponentsToUtcMs, zonedWeekdayAndMinutes } from "../../lib/capabilities/datetime.js";

/** Calendar Y/M/D of an instant as read in a timezone. */
function zonedDateParts(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) {
    if (type !== "literal") parts[type] = value;
  }
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** @type {import("./types.js").SchedulingAdapter} */
export default {
  id: "internal",
  label: "Our built-in calendar",

  // The one appointment backend a business can turn on itself.
  selfServe: true,

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

  async book(ctx, { clientName, clientPhone, scheduledAt, notes, lengthMinutes, capacity }) {
    // Always through the atomic RPC: it re-checks under a per-slot advisory lock,
    // so two callers cannot both slip into the last slot between the app-level
    // check and the insert. lengthMinutes <= 0 means "exact-timestamp guard"
    // (the availability-off case), reproducing migration 009's single-booking
    // rule atomically now that its unique index is gone (migration 022).
    const res = await ctx.deps.createAppointmentIfAvailable({
      businessId: ctx.businessId,
      callId: ctx.callId || null,
      clientName: clientName || null,
      clientPhone: clientPhone || null,
      scheduledAt,
      notes,
      lengthMinutes: Number.isFinite(lengthMinutes) ? lengthMinutes : 0,
      capacity: Number.isFinite(capacity) ? capacity : 1,
    });
    if (res?.full) return { ok: false, full: true, id: null };
    return { ok: !!res?.id, id: res?.id || null };
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
   * Point check: does the exact requested start still have capacity? Equal-length
   * slots overlap iff their starts are < length apart, so a simple count of
   * overlapping `scheduled` rows against the configured capacity answers it.
   */
  async checkAvailability(ctx, { startISO, lengthMinutes, capacity }) {
    const cap = Number.isFinite(capacity) ? capacity : 1;
    const count = await ctx.deps.countScheduledOverlapping(ctx.businessId, startISO, lengthMinutes);
    return { available: count < cap, remaining: Math.max(0, cap - count) };
  },

  /**
   * Enumerate free start times on the day of `dateISO`, for offering
   * alternatives. Business hours are wall-clock in the business timezone, so each
   * candidate is converted to UTC via zonedComponentsToUtcMs (never treated as
   * UTC directly — that was the historical 10:00-UTC bug). One day-window query,
   * overlaps counted locally per candidate.
   */
  async findSlots(ctx, { dateISO, lengthMinutes, capacity, businessHours, timezone }) {
    const L = Number.isFinite(lengthMinutes) ? lengthMinutes : 30;
    const cap = Number.isFinite(capacity) ? capacity : 1;
    const tz = timezone || "America/Chicago";
    const anchorMs = Date.parse(dateISO);
    if (!Number.isFinite(anchorMs)) return [];

    const { shortWeekday } = zonedWeekdayAndMinutes(anchorMs, tz);
    const day = resolveDayHours(businessHours ?? null, shortWeekday);
    if (day.closed || !day.open || !day.close) return [];

    const parts = zonedDateParts(anchorMs, tz);
    const [openH, openM] = day.open.split(":").map(Number);
    const [closeH, closeM] = day.close.split(":").map(Number);
    const openMin = openH * 60 + openM;
    const closeMin = closeH * 60 + closeM;

    const dayStartMs = zonedComponentsToUtcMs({ ...parts, hour: openH, minute: openM, second: 0 }, tz);
    const dayEndMs = zonedComponentsToUtcMs({ ...parts, hour: closeH, minute: closeM, second: 0 }, tz);
    const existing = await ctx.deps.listScheduledBetween(
      ctx.businessId,
      new Date(dayStartMs - L * 60_000).toISOString(),
      new Date(dayEndMs + L * 60_000).toISOString()
    );
    const existingMs = existing.map((r) => Date.parse(r.scheduled_at)).filter(Number.isFinite);

    const now = Date.now();
    const slots = [];
    for (let m = openMin; m + L <= closeMin; m += L) {
      const startMs = zonedComponentsToUtcMs(
        { ...parts, hour: Math.floor(m / 60), minute: m % 60, second: 0 },
        tz
      );
      if (startMs <= now) continue;
      const overlaps = existingMs.filter((t) => Math.abs(t - startMs) < L * 60_000).length;
      if (overlaps < cap) slots.push({ start: new Date(startMs).toISOString() });
    }
    return slots;
  },
};
