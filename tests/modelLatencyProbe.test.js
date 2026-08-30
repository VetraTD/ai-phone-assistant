/**
 * The model-latency probe.
 *
 * It exists because a laptop cannot answer "which model is fastest for us":
 * probing from a dev machine put gemini-3.6-flash at 2,090ms while the
 * deployment was recording 702-1,156ms for the same model on the same prompt.
 * That gap is the network hop, and it makes any comparison taken from outside
 * the deployment worthless.
 *
 * Every test here runs against an injected fake client — this module must never
 * make a real call from the suite.
 */
import { describe, it, expect, vi } from "vitest";
import { probeModelLatency, MAX_MODELS, MAX_TRIALS } from "../lib/probe/modelLatency.js";

/** A fake Gemini whose per-model latency we control exactly. */
function fakeClient(latencyByModel, clock) {
  return {
    models: {
      generateContentStream: async ({ model }) => {
        const err = latencyByModel[model]?.error;
        if (err) throw new Error(err);
        clock.t += latencyByModel[model] ?? 100;
        return (async function* () {
          yield { candidates: [{ content: { parts: [{ text: "Hello." }] } }] };
        })();
      },
    },
  };
}

const run = (opts, latency) => {
  const clock = { t: 0 };
  return probeModelLatency(opts, { client: fakeClient(latency, clock), now: () => clock.t });
};

describe("probeModelLatency", () => {
  it("separates models by latency and reports the raw samples", async () => {
    const out = await run(
      { models: ["fast-model", "slow-model"], trials: 3 },
      { "fast-model": 200, "slow-model": 2000 }
    );
    expect(out.results["fast-model"].median).toBe(200);
    expect(out.results["slow-model"].median).toBe(2000);
    // Raw samples, not just a median — one number would be a coin flip
    // presented as a decision.
    expect(out.results["fast-model"].samples).toHaveLength(3);
  });

  it("INTERLEAVES by round, so drifting load hits every arm equally", async () => {
    // The reason this matters: the same model measured 1,016ms and 2,090ms
    // twenty minutes apart. Running all of one model then all of the next hands
    // that drift to whichever went first.
    const order = [];
    const clock = { t: 0 };
    const client = {
      models: {
        generateContentStream: async ({ model }) => {
          order.push(model);
          clock.t += 100;
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: "x" }] } }] };
          })();
        },
      },
    };
    await probeModelLatency({ models: ["a", "b"], trials: 3 }, { client, now: () => clock.t });
    expect(order).toEqual(["a", "b", "a", "b", "a", "b"]);
  });

  it("caps the number of calls it can ever make", async () => {
    // It spends real money per request and is reachable over HTTP. It must not
    // be loopable into a large bill.
    const out = await run(
      { models: ["a", "b", "c", "d", "e", "f"], trials: 99 },
      { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 }
    );
    expect(Object.keys(out.results).length).toBe(MAX_MODELS);
    expect(out.trials).toBe(MAX_TRIALS);
  });

  it("reports a model that fails without losing the others, and does not retry it", async () => {
    let attempts = 0;
    const clock = { t: 0 };
    const client = {
      models: {
        generateContentStream: async ({ model }) => {
          if (model === "missing-model") {
            attempts++;
            throw new Error("404 model not found");
          }
          clock.t += 300;
          return (async function* () {
            yield { candidates: [{ content: { parts: [{ text: "x" }] } }] };
          })();
        },
      },
    };
    const out = await probeModelLatency(
      { models: ["missing-model", "good-model"], trials: 4 },
      { client, now: () => clock.t }
    );
    expect(out.results["missing-model"].error).toMatch(/404/);
    expect(out.results["good-model"].median).toBe(300);
    expect(attempts).toBe(1); // a 404 is not worth four round trips
  });

  it("refuses with no models rather than probing something arbitrary", async () => {
    expect((await run({ models: [] }, {})).error).toMatch(/no models/i);
  });

  it("clamps an absurd prompt size instead of sending it", async () => {
    const out = await run({ models: ["a"], promptTokens: 5_000_000 }, { a: 1 });
    expect(out.promptTokens).toBeLessThanOrEqual(12_000);
  });

  it("carries a warning about how to read the numbers", async () => {
    // Anyone reading a median over n=3 on a shared endpoint needs telling.
    const out = await run({ models: ["a"] }, { a: 1 });
    expect(out.note).toMatch(/noise/i);
    expect(out.interleaved).toBe(true);
  });
});
