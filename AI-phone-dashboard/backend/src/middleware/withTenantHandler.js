const db = require("../db");
const { getBusinessIdForUser } = require("../utils");
const { classifyRoute } = require("../phiAudit");

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

    // §164.312(b). Classified from the express ROUTE PATTERN rather than the
    // request URL, so `/api/calls/abc-123` and `/api/calls/def-456` are the same
    // access and no caller's row id is ever the thing being matched on.
    //
    // `req.route` is populated by express before the handler runs, because this
    // wrapper IS the route handler. It is absent when the wrapper is used
    // outside a route — null there, which classifies as no access, which is the
    // safe direction for an unknown caller of this helper.
    const access = classifyRoute(req.method, req.route?.path);

    // HOW MANY RECORDS WERE DISCLOSED, observed rather than guessed.
    //
    // This wrapper never sees the handler's result set — the handler owns it
    // and hands it straight to res.json — so the count has to be taken from the
    // response as it goes out. The first version used the length of
    // resource_ids instead, which recorded a list of twenty appointments as
    // row_count 0. An auditor reading that concludes nothing was read, and a
    // wrong number in an audit trail is worse than an absent one because it is
    // believed.
    //
    // Only wrapped for a classified route: a non-PHI response is nobody's
    // business and there is no reason to touch res.json on those paths.
    let disclosed = 0;
    if (access) {
      const json = res.json.bind(res);
      res.json = (body) => {
        disclosed = Array.isArray(body) ? body.length : body == null ? 0 : 1;
        return json(body);
      };
    }

    try {
      await db.withTenant(businessId, () => handler(req, res), {
        rowCount: () => disclosed,
        access,
        // The record being read, when the route names one. This is what makes
        // "who accessed THIS call" answerable — the question O29 put a GIN
        // index on `resource_ids` to serve, and which a row with no id cannot
        // answer at all.
        //
        // `:id` only. Deliberately not every param: `:capabilityId` and
        // `:businessId` do not identify a patient record, and an audit column
        // that accumulates whatever happened to be in the URL stops meaning
        // one thing.
        resourceIds: req.params?.id ? [req.params.id] : [],
        // The AUTH provider's id, not `users.id`. It is what identifies the
        // human being to Identity Platform, survives a staff row being
        // rewritten, and is what an investigator would be given to look up.
        actorId: req.authUser?.id ?? null,
      });
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
