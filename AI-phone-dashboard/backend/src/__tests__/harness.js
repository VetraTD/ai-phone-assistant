// Test harness for supertest-against-the-real-app testing.
//
// server.js (and everything it requires) is plain CommonJS, loaded via
// Node's native `require()` — Vitest's `vi.mock()` only intercepts static
// ESM `import` specifiers, not runtime `require()` calls, so it cannot mock
// these dependencies (verified: a vi.mock'd CJS dependency required at
// runtime by another CJS module still resolves to the real implementation).
// Instead we inject fakes directly into Node's `require.cache` for `db` and
// `authMiddleware` before requiring `server.js` fresh, which is a standard
// and reliable way to fake out CJS dependencies.
import { createRequire } from "module";
import path from "path";
import { vi } from "vitest";

const require = createRequire(import.meta.url);
const SRC_DIR = path.dirname(require.resolve("../server.js"));

export const DEFAULT_TEST_USER = { id: "11111111-1111-1111-1111-111111111111", email: "owner@example.com" };

function clearSrcRequireCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR)) delete require.cache[key];
  }
}

function injectFakeModule(specifier, exportsValue) {
  const resolved = require.resolve(specifier);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

/**
 * Build a fresh app instance with a mocked pg pool and a mocked auth
 * middleware. Call this in `beforeEach` so every test gets an isolated
 * require graph (no query-mock or auth-state bleed between tests).
 *
 * @returns {{ app: import('express').Express, poolQueryMock: import('vitest').Mock, authState: { user: object|null } }}
 */
export function createTestApp() {
  clearSrcRequireCache();

  const poolQueryMock = vi.fn();
  const authState = { user: { ...DEFAULT_TEST_USER } };

  injectFakeModule("../db/index.js", {
    query: (...args) => poolQueryMock(...args),
  });

  injectFakeModule("../middleware/authMiddleware.js", function fakeAuthenticate(req, res, next) {
    if (!authState.user) {
      return res.status(401).json({ error: "No authorization header" });
    }
    req.authUser = authState.user;
    next();
  });

  const app = require("../server.js");
  return { app, poolQueryMock, authState };
}

/**
 * Swap the real `axios` module for `fake` in Node's require cache, so route
 * modules loaded afterwards (i.e. by a later `createTestApp()`) pick it up.
 * Unlike the fakes above this touches a shared node_modules entry, so the
 * returned restore function MUST be called (afterEach) to avoid leaking the
 * fake into other suites in the same worker.
 *
 * @param {object} fake - stand-in axios (usually `{ post: vi.fn() }`)
 * @returns {() => void} restore
 */
export function injectFakeAxios(fake) {
  const resolved = require.resolve("axios");
  const original = require.cache[resolved];
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: fake,
  };
  return () => {
    if (original) require.cache[resolved] = original;
    else delete require.cache[resolved];
  };
}
