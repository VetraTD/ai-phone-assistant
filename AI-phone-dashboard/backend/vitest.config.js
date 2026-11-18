/** @type {import('vitest').UserConfig} */
export default {
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.js"],
  },
};
