/**
 * How fast is each candidate model, measured from where it actually matters?
 *
 * A laptop cannot answer this. Probing from a dev machine on 2026-08-30 put
 * gemini-3.6-flash at 2,090ms while live staging was recording 702-1,156ms for
 * the same model on the same prompt size -- a 2x gap that is almost certainly
 * the network hop, not the model. Absolute numbers taken from outside the
 * deployment are worthless for choosing between models; only a measurement
 * taken from inside it can be trusted.
 *
 * INTERLEAVED by round rather than model. Endpoint load drifts by the minute
 * (the same model measured 1,016ms and 2,090ms twenty minutes apart), so
 * running all of one model then all of the next hands the drift to whichever
 * arm went first. One trial of each per round spreads it evenly.
 *
 * Reports a median AND the raw samples. A single number here would be a coin
 * flip presented as a decision.
 */
import { GoogleGenAI } from "@google/genai";

/** Hard ceilings. This endpoint spends money per call; it must not be loopable. */
export const MAX_MODELS = 4;
export const MAX_TRIALS = 5;
export const MAX_PROMPT_TOKENS = 12_000;

/** Prose, not a repeated token — a degenerate prompt may not tokenize realistically. */
function padding(approxTokens) {
  const sentence =
    "The practice is open on weekdays and closed at weekends, and the front desk handles " +
    "appointments, billing questions, and messages for the clinical team. ";
  return sentence.repeat(Math.max(1, Math.round(approxTokens / 22)));
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}

/**
 * @param {object} opts
 * @param {string[]} opts.models
 * @param {number} [opts.trials]
 * @param {number} [opts.promptTokens]
 * @param {object} [deps] - { client, now } for tests; no network when supplied.
 * @returns {Promise<object>}
 */
export async function probeModelLatency(
  { models, trials = 3, promptTokens = 5000 } = {},
  deps = {}
) {
  const picked = (Array.isArray(models) ? models : [])
    .map((m) => String(m || "").trim())
    .filter(Boolean)
    .slice(0, MAX_MODELS);
  if (!picked.length) return { error: "no models given" };

  const n = Math.min(Math.max(1, Number(trials) || 1), MAX_TRIALS);
  const size = Math.min(Math.max(100, Number(promptTokens) || 5000), MAX_PROMPT_TOKENS);
  const systemInstruction = `You are a receptionist. ${padding(size)}`;

  const client =
    deps.client ||
    (process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null);
  if (!client) return { error: "GEMINI_API_KEY not configured" };
  const now = deps.now || (() => Date.now());

  const samples = Object.fromEntries(picked.map((m) => [m, []]));
  const errors = {};

  for (let round = 0; round < n; round++) {
    for (const model of picked) {
      if (errors[model]) continue; // a model that 404s is not retried n times
      const started = now();
      try {
        const stream = await client.models.generateContentStream({
          model,
          contents: [{ role: "user", parts: [{ text: "What are your opening hours on Tuesday?" }] }],
          config: {
            systemInstruction,
            temperature: 0.4,
            maxOutputTokens: 200,
          },
        });
        for await (const chunk of stream) {
          const part = chunk?.candidates?.[0]?.content?.parts?.[0];
          if (part?.text || part?.functionCall) break;
        }
        samples[model].push(Math.round(now() - started));
      } catch (err) {
        errors[model] = String(err?.message || err).slice(0, 200);
      }
    }
  }

  const results = {};
  for (const model of picked) {
    results[model] = errors[model]
      ? { error: errors[model] }
      : {
          median: median(samples[model]),
          min: samples[model].length ? Math.min(...samples[model]) : null,
          max: samples[model].length ? Math.max(...samples[model]) : null,
          samples: samples[model],
        };
  }

  return {
    promptTokens: size,
    trials: n,
    interleaved: true,
    note:
      "Medians over a small n on a shared endpoint. Treat gaps under ~150ms as noise, " +
      "and compare models only within this run — absolute values drift between runs.",
    results,
  };
}
