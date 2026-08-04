import base from "./vitest.config.js";

/**
 * Config for sim/ — measurement harnesses, not tests.
 *
 * They live behind their own config (and a *.sim.js suffix the default include
 * glob does not match) so `npm test` never sweeps them in: a simulation that
 * prints a table is not a pass/fail gate, and running one on every commit would
 * make the real suite slower and noisier for no benefit.
 *
 *   npm run sim:cutoff
 *
 * @type {import('vitest').UserConfig}
 */
export default {
  ...base,
  test: {
    ...base.test,
    include: ["sim/**/*.sim.js"],
    // A simulated call runs thousands of 20ms frames through the real VAD,
    // echo guard and turn manager on a virtual clock. Cheap in wall-clock
    // terms, but well past the unit-test budget.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Sequential: the scenarios print an ordered comparison table, and the
    // session module keeps process-wide state (utterance cache, TTS breaker).
    fileParallelism: false,
  },
};
