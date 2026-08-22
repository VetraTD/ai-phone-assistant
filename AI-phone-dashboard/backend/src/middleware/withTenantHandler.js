const db = require("../db");
const { getBusinessIdForUser } = require("../utils");

// ---------------------------------------------------------------------------
// The tenant boundary for the dashboard.
//
// Wraps a HANDLER, not `next()`. That is the whole design decision and it is
// worth stating, because the middleware-shaped version looks obviously right
// and is broken:
//
//   app.use((req, res, next) => db.withTenant(id, () => next()))
//
// `next()` returns as soon as the next layer starts, so the promise resolves
// while the handler is still running and the transaction COMMITS underneath it.
// Every query after that point runs unscoped, on a connection already returned
// to the pool.
//
// The other near-miss is committing on `res.on("finish")`. That holds a pooled
// connection and an open transaction across response serialisation — including
// however long the client takes to read the body — and by the time `finish`
// fires the response is already sent, so a late error cannot roll anything
// back.
//
// Wrapping the handler makes the transaction span exactly one HTTP handler,
// which is what services/db.js means by "wrap a unit of work, never a call".
// ---------------------------------------------------------------------------

/**
 * Resolve the caller's tenant, then run `handler` scoped to it.
 *
 * On success `req.businessId` is the tenant. This replaces the
 * `getBusinessIdForUser` + 403 block that was repeated in 23 handlers — the
 * kind of duplication where one copy eventually differs from the rest and
 * nobody can say which is correct.
 *
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<void>} handler
 * @returns {import('express').RequestHandler}
 */
function withTenantHandler(handler) {
  return async function scopedHandler(req, res, next) {
    let businessId;
    try {
      businessId = await getBusinessIdForUser(req.authUser);
    } catch (err) {
      return next(err);
    }

    if (!businessId) {
      // Authenticated, but carrying no staff row or no business — a signed-up
      // account that was never onboarded. Not an authentication failure, so not
      // a 401. The message is unchanged from the 23 copies this replaces.
      return res.status(403).json({ error: "No business linked to this user" });
    }

    req.businessId = businessId;

    try {
      await db.withTenant(businessId, () => handler(req, res));
    } catch (err) {
      // Through express's error handler, not swallowed here. A rollback has
      // already happened by this point; what must not happen is a 200 for a
      // unit of work that rolled back.
      if (!res.headersSent) return next(err);
      next(err);
    }
  };
}

module.exports = { withTenantHandler };
