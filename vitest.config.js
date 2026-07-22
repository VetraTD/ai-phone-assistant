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
    exclude: [...defaultExclude, "**/AI-phone-dashboard/**"],
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
    },
  },
};
