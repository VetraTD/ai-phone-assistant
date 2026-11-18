/**
 * Webhook scheduling adapter — the business's own system, over HTTP.
 *
 * The escape hatch for a backend we will never integrate with directly. The
 * business declares an endpoint and we POST to it.
 *
 * verifiableFields is deliberately EMPTY. We cannot prove anything about a
 * caller against a system whose contents we cannot read, so an operator on this
 * adapter can collect a custom identity field but can never mark it verified.
 * The settings UI reads this list precisely so it can grey that option out with
 * a reason, rather than letting someone configure a guarantee that silently
 * does nothing.
 */

/** @type {import("./types.js").SchedulingAdapter} */
export default {
  id: "webhook",
  label: "Send to my own system",

  // Not offered in the dashboard: this adapter is a stub (its book() is null),
  // so a business that selected it would have bookings fail silently. Hidden
  // until it is actually wired, rather than presented as a working option.
  selfServe: false,

  verifiableFields: [],

  claimsIntegration() {
    // Never auto-claims: a webhook is only ever used because it was explicitly
    // configured. Guessing would silently reroute a business's appointments.
    return false;
  },

  routesThroughIntegration: true,
  lookupByCaller: null,
  book: null,
  cancel: null,
  reschedule: null,
  checkAvailability: null,
  findSlots: null,
};
