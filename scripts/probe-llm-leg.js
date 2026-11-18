/**
 * What actually governs the model leg?
 *
 * On a live call (2026-08-30) the model is by far the largest slice of a turn:
 * ~900ms for a plain reply, ~1,800ms on a tool turn (two serial legs). STT
 * endpointing is ~500ms and the tool itself measures 0ms.
 *
 * Two assumptions underpin the "nothing to do here" position, and only one of
 * them has ever been tested:
 *
 *   1. "TTFT is flat in prompt size." MEASURED — but at 6 tokens vs 2,586
 *      tokens with 8 tools (docs/latency-and-tts-tests.md:176). The live prompt
 *      averages ~4,840 tokens with 12 tools, so the range that matters is
 *      extrapolation, not measurement.
 *   2. "Declaring more tools is free." Never tested at all.
 *
 * This probe measures time-to-first-token against both, at realistic sizes.
 * Reports a rate (n trials per cell), never a single-shot verdict — Gemini
 * latency is noisy and one sample per arm is a coin flip dressed as a finding.
 *
 *   node scripts/probe-llm-leg.js
 *   node scripts/probe-llm-leg.js --trials 5
 */
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const trialsArg = process.argv.indexOf("--trials");
const TRIALS = trialsArg > -1 ? Number(process.argv[trialsArg + 1]) || 3 : 3;

/** Filler that is prose, not repetition — a repeated token may compress differently. */
function padding(approxTokens) {
  const sentence =
    "The practice is open on weekdays and closed at weekends, and the front desk handles " +
    "appointments, billing questions, and messages for the clinical team. ";
  const perSentence = 22;
  return sentence.repeat(Math.max(1, Math.round(approxTokens / perSentence)));
}

const toolDecl = (i) => ({
  name: `lookup_record_${i}`,
  description: `Look up record set ${i} for the caller before answering a question about it.`,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look up" },
      when: { type: "string", description: "ISO 8601 date and time" },
    },
    required: ["query"],
  },
});

async function ttfb(ai, { systemInstruction, tools }) {
  const started = Date.now();
  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: "What are your opening hours on Tuesday?" }] }],
    config: {
      systemInstruction,
      temperature: 0.4,
      maxOutputTokens: 200,
      thinkingConfig: { thinkingLevel: "minimal" },
      ...(tools ? { tools } : {}),
    },
  });
  for await (const chunk of stream) {
    const part = chunk?.candidates?.[0]?.content?.parts?.[0];
    if (part?.text || part?.functionCall) return Date.now() - started;
  }
  return Date.now() - started;
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY required");
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const cells = [];
  for (const promptTokens of [500, 3000, 5000, 10000]) {
    for (const toolCount of [0, 12]) {
      cells.push({ promptTokens, toolCount });
    }
  }

  console.log(`model ${MODEL}   ${TRIALS} trials per cell\n`);
  console.log("prompt tokens   tools   TTFT median   samples");
  const rows = [];
  for (const c of cells) {
    const systemInstruction = `You are a receptionist. ${padding(c.promptTokens)}`;
    const tools = c.toolCount
      ? [{ functionDeclarations: Array.from({ length: c.toolCount }, (_, i) => toolDecl(i)) }]
      : null;
    const samples = [];
    for (let i = 0; i < TRIALS; i++) {
      try {
        samples.push(await ttfb(ai, { systemInstruction, tools }));
      } catch (err) {
        console.log(`  cell ${c.promptTokens}/${c.toolCount} failed: ${err?.message?.slice(0, 80)}`);
      }
    }
    if (!samples.length) continue;
    const m = median(samples);
    rows.push({ ...c, median: m, samples });
    console.log(
      String(c.promptTokens).padStart(13) +
        String(c.toolCount).padStart(8) +
        String(m + "ms").padStart(14) +
        "   " +
        samples.join(", ")
    );
  }

  // The two questions this exists to answer, stated as differences.
  const at = (p, t) => rows.find((r) => r.promptTokens === p && r.toolCount === t)?.median;
  console.log("\n--- what this says ---");
  const small = at(500, 12);
  const large = at(10000, 12);
  if (small && large) {
    console.log(
      `prompt 500 -> 10,000 tokens (12 tools): ${small}ms -> ${large}ms  (${large - small >= 0 ? "+" : ""}${large - small}ms)`
    );
    console.log(
      large - small > 250
        ? "  TTFT is NOT flat at realistic sizes. Trimming the prompt is a latency lever."
        : "  TTFT is flat at these sizes too. Prompt size is not a latency lever — do not trim for speed."
    );
  }
  const noTools = at(5000, 0);
  const withTools = at(5000, 12);
  if (noTools && withTools) {
    console.log(
      `\ndeclaring 12 tools at 5,000 tokens: ${noTools}ms -> ${withTools}ms  (${withTools - noTools >= 0 ? "+" : ""}${withTools - noTools}ms)`
    );
    console.log(
      withTools - noTools > 250
        ? "  Tool declarations cost real TTFT. Registering fewer per business is a lever."
        : "  Tool declarations are ~free. Not a lever."
    );
  }
  console.log(
    "\nNOTE: medians over " +
      TRIALS +
      " trials on a shared endpoint. Treat differences under ~150ms as noise."
  );
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
