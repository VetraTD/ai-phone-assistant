/**
 * LLM judge — one call per scenario, AFTER the conversation is over.
 *
 * Judges the ADVISORY rubric questions a scenario declares (things too fuzzy
 * for a hard assertion: "was the tone warm?", "did it offer alternatives?").
 * Its verdicts set the scenario's `judgePass` field but NEVER the process exit
 * code — only hard assertions gate that. So a flaky or over-strict judge can
 * mislead a human reading the report, but it cannot turn a green suite red.
 *
 * Determinism guards: temperature 0, and structured output
 * (responseMimeType=application/json + responseSchema) so the response is
 * always parseable JSON in the exact shape expected — no brittle prose parsing.
 * On a malformed response we retry once; if it still won't parse, every
 * question is marked `error` (distinct from `fail`) so the report shows the
 * judge broke rather than pretending the receptionist failed.
 */

import { Type } from "@google/genai";
import { getClient } from "../services/gemini.js";

const JUDGE_MODEL = "gemini-2.5-flash";

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING },
          verdict: { type: Type.STRING, enum: ["pass", "fail"] },
          reason: { type: Type.STRING },
        },
        required: ["question", "verdict", "reason"],
      },
    },
  },
  required: ["results"],
};

const SYSTEM_INSTRUCTION =
  "You are a strict but fair QA reviewer grading a phone receptionist AI. " +
  "You are given the full transcript of one call (caller lines, receptionist lines, and the tools the receptionist invoked) " +
  "and a list of yes/no rubric questions. For each question, answer 'pass' only if the transcript clearly satisfies it, " +
  "otherwise 'fail'. Judge ONLY what the transcript shows — do not assume unstated good behavior. " +
  "Give a one-sentence reason citing the transcript. Return one result per question, in the order asked.";

/**
 * Render the collected turns into a plain-text transcript the judge can read.
 * @param {Array<{caller?: string, reply?: string, toolCalls?: Array}>} turns
 */
export function renderTranscript(turns) {
  const lines = [];
  for (const t of turns || []) {
    if (t.caller != null) lines.push(`CALLER: ${t.caller}`);
    for (const c of t.toolCalls || []) {
      lines.push(`  [tool] ${c.name}(${JSON.stringify(c.args || {})})`);
    }
    if (t.reply != null) lines.push(`RECEPTIONIST: ${t.reply || "(no spoken reply)"}`);
  }
  return lines.join("\n");
}

function buildPrompt(transcriptText, questions) {
  const numbered = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return (
    `TRANSCRIPT:\n${transcriptText}\n\n` +
    `RUBRIC QUESTIONS (answer each pass/fail, in order):\n${numbered}`
  );
}

/**
 * @param {object} params
 * @param {Array} params.turns - collected conversation turns
 * @param {string[]} params.questions - rubric questions
 * @param {string} [params.model]
 * @returns {Promise<Array<{question, verdict: "pass"|"fail"|"error", reason}>>}
 */
export async function judgeConversation({ turns, questions, model = JUDGE_MODEL }) {
  if (!questions || questions.length === 0) return [];
  const contents = buildPrompt(renderTranscript(turns), questions);

  // getClient() lives INSIDE the guarded callOnce, not hoisted above the
  // try/retry below. The judge is advisory by contract (see file header) —
  // runScenario's own try/catch treats any throw that escapes this function
  // as a scenario ERROR (hardPass=false, non-advisory), so a judge-side throw
  // that happened before the try (e.g. getClient() failing because the SDK
  // wasn't configured) would flip the exit code exactly like a hard-assertion
  // failure would. Keeping acquisition inside the guarded path means ANY
  // judge failure — client construction included — is caught below and
  // downgraded to per-question "error" verdicts instead.
  const callOnce = async () => {
    const client = getClient();
    const resp = await client.models.generateContent({
      model,
      contents,
      config: {
        temperature: 0,
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    });
    const parsed = JSON.parse(resp.text);
    if (!parsed || !Array.isArray(parsed.results)) throw new Error("judge JSON missing results[]");
    return parsed.results;
  };

  let results;
  try {
    results = await callOnce();
  } catch {
    try {
      results = await callOnce(); // one retry — transient malformed output
    } catch (err) {
      return questions.map((question) => ({
        question,
        verdict: "error",
        reason: `judge failed to return valid JSON: ${err?.message ?? err}`,
      }));
    }
  }

  // Align results back to the asked questions by position; tolerate a judge
  // that returns the wrong count rather than throwing.
  return questions.map((question, i) => {
    const r = results[i] || {};
    const verdict = r.verdict === "pass" || r.verdict === "fail" ? r.verdict : "error";
    return { question, verdict, reason: r.reason || "(no reason given)" };
  });
}
