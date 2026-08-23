import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

/**
 * THE LIST THAT MUST NOT GO STALE.
 *
 * The whole reason the dashboard had no PHI-access trail at all is that O29
 * classified the VOICE server's data layer and nothing ever asked whether the
 * other server needed the same thing. `tests/phiAuditCoverage.test.js` in the
 * root suite is the guard for that half, it reads only `services/db.js`, and it
 * contains zero references to this directory — correct about its subject, blind
 * to the other half of the system.
 *
 * This is the missing half of that guard. Every route that runs inside a tenant
 * scope is either classified as PHI access or explicitly named as not being one.
 * A route that is neither fails the build, so "nobody remembered to classify it"
 * cannot be the reason a caller's transcript is read with no record of it.
 *
 * It walks the REAL express router stack rather than a hand-maintained list of
 * paths, because a hand-maintained list is the same failure one level up.
 */

/** Every `METHOD /path` in the app that is wrapped in withTenantHandler. */
function tenantScopedRoutes() {
  // Requiring server.js boots the app. It does not listen — server.js guards
  // that on require.main === module — but it does construct the router stack,
  // which is the thing being inspected.
  const app = require("../server.js");
  const found = new Set();

  const walk = (stack) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const path = layer.route.path;
        for (const method of Object.keys(layer.route.methods || {})) {
          // A route counts as tenant-scoped when one of its handlers is the
          // wrapper. The wrapper's function name is `scopedHandler`, which is
          // why withTenantHandler names its returned function at all.
          const scoped = (layer.route.stack || []).some((h) => h.name === "scopedHandler");
          if (scoped) found.add(`${method.toUpperCase()} ${path}`);
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };

  walk(app._router?.stack || app.router?.stack);
  return [...found].sort();
}

describe("every tenant-scoped route is classified for §164.312(b)", () => {
  const { PHI_ROUTES, NON_PHI_ROUTES } = require("../phiAudit.js");

  it("finds the tenant-scoped routes at all", () => {
    // Guards the guard. If the router walk silently found nothing, the
    // classification assertion below would pass vacuously — which is exactly
    // the shape of failure this whole session kept finding.
    const routes = tenantScopedRoutes();
    expect(routes.length).toBeGreaterThan(5);
    expect(routes).toContain("GET /api/calls");
  });

  it("classifies every one of them as PHI or explicitly not-PHI", () => {
    const classified = new Set([...Object.keys(PHI_ROUTES), ...NON_PHI_ROUTES]);
    const unclassified = tenantScopedRoutes().filter((r) => !classified.has(r));

    expect(
      unclassified,
      "unclassified tenant-scoped routes — each reads or writes inside a tenant " +
        "and none has been declared PHI or not-PHI. Add it to PHI_ROUTES or " +
        "NON_PHI_ROUTES in src/phiAudit.js"
    ).toEqual([]);
  });

  it("names no route that does not exist", () => {
    // The other direction. A classification for a deleted route is a comforting
    // entry that covers nothing, and it makes the list look more complete than
    // it is.
    const live = new Set(tenantScopedRoutes());
    const stale = [...Object.keys(PHI_ROUTES), ...NON_PHI_ROUTES].filter((r) => !live.has(r));
    expect(stale, "classified routes that no longer exist in the app").toEqual([]);
  });

  it("never classifies the same route twice", () => {
    const both = Object.keys(PHI_ROUTES).filter((r) => NON_PHI_ROUTES.includes(r));
    expect(both, "routes declared BOTH PHI and not-PHI").toEqual([]);
  });
});
