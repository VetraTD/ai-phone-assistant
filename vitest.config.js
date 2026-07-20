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
    env: {
      NODE_ENV: "test",
      GEMINI_API_KEY: "test-key",
      BASE_URL: "https://test.example.com",
      DEEPGRAM_API_KEY: "test-key",
    },
  },
};
