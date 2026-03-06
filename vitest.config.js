/** @type {import('vitest').UserConfig} */
export default {
  test: {
    environment: "node",
    globals: true,
    env: {
      NODE_ENV: "test",
      GEMINI_API_KEY: "test-key",
      BASE_URL: "https://test.example.com",
    },
  },
};
