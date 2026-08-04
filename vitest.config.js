import { defaultExclude } from "vitest/config";

/** @type {import('vitest').UserConfig} */
export default {
  test: {
    environment: "node",
    globals: true,
    // AI-phone-dashboard/backend is a separate CJS app with its own
    // package.json, vitest.config.js, and test suite (run via `npm test`
    // from that directory) — without this, root `vitest run` sweeps its
    // tests in too, since vitest's default excludes don't know about it.
    // eval/ is the live conversation suite (run via `npm run eval`), not unit
    // tests — it makes real Gemini calls and has no *.test.js files, so vitest's
    // default globs already skip it; excluded explicitly so a future scenario
    // helper named *.test.js can't be swept into the unit run by accident. The
    // eval helpers' OWN unit tests live in tests/ and still run.
    exclude: [...defaultExclude, "**/AI-phone-dashboard/**", "eval/**"],
    // The default 5s is not enough for the FIRST test in a file under full-suite
    // parallelism: cold module import (supabase + twilio + the genai SDK) is
    // billed to test #1, which measures ~1.9s alone and multiplies under
    // contention. That intermittently failed notifications.sms and
    // supabase-calls with no logic defect. The capability refactor leans on
    // this suite as its correctness gate, so a flaky gate is worse than a slow
    // one. Still far below any real hang.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      GEMINI_API_KEY: "test-key",
      BASE_URL: "https://test.example.com",
      DEEPGRAM_API_KEY: "test-key",
      // Pin a NON-UTC zone deliberately.
      //
      // Several code paths parse a naive datetime string with Date.parse() or
      // new Date(), which per spec resolves in the SERVER's local zone, then
      // re-render it in the business zone. On a UTC box those two cancel out
      // and the bug is invisible; on a developer machine in another zone it
      // silently shifts appointment times. Leaving TZ unpinned meant CI could
      // never see that class of defect. America/Los_Angeles also observes DST,
      // so a zone-handling bug that only appears under DST has somewhere to
      // show up.
      //
      // Run the suite a second time with TZ=UTC to cover the other direction:
      //   TZ=UTC npx vitest run
      TZ: process.env.TZ || "America/Los_Angeles",
    },
  },
};
