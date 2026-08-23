// ---------------------------------------------------------------------------
// Which dashboard routes touch PHI — §164.312(b), the human half.
//
// O29 built the PHI-access trail for the VOICE server and stopped there. Found
// 2026-08-23 by running the C8 probe against the live deployment: fifteen
// authenticated, tenant-scoped API calls produced ZERO phi_access entries,
// while voice-us-staging emitted them normally.
//
// The coverage was the wrong way round. O29 audits the RECEPTIONIST writing
// transcripts. This is the only place a HUMAN BEING reads a transcript, an
// appointment, or a caller's phone number — and §164.312(b) exists principally
// to detect inappropriate access by workforce members.
//
// ---------------------------------------------------------------------------
// THE CLASSIFICATION LINE, and it is the voice server's, unchanged
// ---------------------------------------------------------------------------
//
// An access READS, WRITES OR DESTROYS DATA ABOUT THE CALLER OR THEIR CARE.
//
// That is why the analytics routes are not here: they return COUNT and SUM over
// calls with no subject attached, exactly as `countScheduledOverlapping` and
// `listScheduledBetween` are exempt on the voice side. It is also why the
// settings, knowledge, capabilities and integrations routes are not here —
// changing a greeting or a business's opening hours touches no patient data,
// and a trail that records it drowns the accesses that matter. The difference
// between an audit trail and a query log is what it leaves OUT.
//
// ---------------------------------------------------------------------------
// KEYED ON THE ROUTE, because the dashboard has no data layer
// ---------------------------------------------------------------------------
//
// services/db.js classifies per exported FUNCTION, because every PHI query
// there goes through one. The dashboard writes SQL inline in its handlers, so
// the unit that can be classified is the ROUTE — which is also exactly the unit
// of work `withTenantHandler` wraps. One handler, one transaction, one row.
// ---------------------------------------------------------------------------

/** `METHOD /path` (the express route pattern, so `:id` stays a parameter). */
const PHI_ROUTES = Object.freeze({
  // The record that an interaction happened, and who was on the other end.
  "GET /api/calls": { action: "read", resources: ["calls"] },

  // THE RICHEST PHI READ IN THE PRODUCT. One request returns the call, its full
  // transcript, every appointment booked on it and every message left — what a
  // patient actually said, verbatim.
  "GET /api/calls/:id": {
    action: "read",
    resources: ["calls", "call_transcripts", "appointments", "customer_requests"],
  },

  // A named person, at a time, with their phone number.
  "GET /api/appointments": { action: "read", resources: ["appointments"] },

  // `export`, not `read`, and the distinction is the point: this SENDS
  // appointment data to the business's notification address. It is the only
  // dashboard route that moves PHI out of the system, so an auditor asking
  // "what left" must be able to find it without reading every read.
  "POST /api/appointments/email": { action: "export", resources: ["appointments"] },
});

/**
 * Routes that run inside a tenant scope and are deliberately NOT PHI access.
 *
 * THE LIST THAT MUST NOT GO STALE, and it is here because this session found
 * three separate guards that were correct about their subject while the subject
 * had quietly become half the system. A route added to the dashboard tomorrow
 * is either classified above or named here; `phiAuditRoutes.test.js` fails the
 * build on anything that is neither, so "nobody remembered to classify it"
 * cannot be the reason PHI is read without a record.
 */
const NON_PHI_ROUTES = Object.freeze([
  // Aggregates. Counts and sums over calls, with no subject.
  "GET /api/analytics/:businessId",
  "GET /api/usage",
  "GET /api/analytics-breakdown",

  // The business's own configuration and content.
  "GET /api/businesses/:id",
  "PUT /api/business/:id/settings",
  "GET /api/business/:id/capabilities",
  "PUT /api/business/:id/capabilities/:capabilityId",
  "GET /api/knowledge",
  "POST /api/knowledge",
  "PUT /api/knowledge/:id",
  "DELETE /api/knowledge/:id",
  "GET /api/integrations",
  "POST /api/integrations",
  "DELETE /api/integrations/:id",
]);

/**
 * The audit record for one request, or null when the route touches no PHI.
 *
 * Returns null rather than throwing for an unclassified route: at runtime an
 * unrecognised path must not take the dashboard down, and the build-time test
 * is what makes the omission impossible to ship. Same posture as the voice
 * server's `noteAccess`.
 *
 * @param {string} method
 * @param {string} routePath - the express route PATTERN, not the request URL
 */
function classifyRoute(method, routePath) {
  if (!method || !routePath) return null;
  const key = `${method.toUpperCase()} ${routePath}`;
  const entry = PHI_ROUTES[key];
  if (!entry) return null;
  // The route key travels as the OPERATION. Without it the row says only
  // "somebody read appointments" and cannot say through which endpoint —
  // `operations` is the field services/db.js uses for exactly this, carrying
  // the data-layer function's own name.
  return { action: entry.action, resources: entry.resources, operations: [key] };
}

module.exports = { PHI_ROUTES, NON_PHI_ROUTES, classifyRoute };
