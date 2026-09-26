// tests/geminiSummaryOutbound.test.js
/**
 * Ruling P-7 (Task 20, spec §12.2): generateSummaryAndSentiment gains an
 * OPTIONAL 2nd argument, the outbound outcome enum. The 1-argument call
 * (server.js:928, inbound) must build the byte-identical request; this file
 * asserts the `contents` string sent to the model, not just the returned
 * shape, so a change to the prompt text on the outbound branch cannot leak
 * into the inbound one unnoticed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const calls = [];
/** Reconfigured per test: what the (single, cached) client's generateContent returns. */
let respond = async () => ({ text: JSON.stringify({ summary: "s", sentiment: "neutral", outcome: "appointment" }) });

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor() {
      this.models = {
        generateContent: async (req) => {
          calls.push(req);
          return respond(req);
        },
      };
    }
  },
}));

const { generateSummaryAndSentiment, OUTBOUND_OUTCOME_ENUM, CALL_OUTCOMES } = await import("../services/gemini.js");

const TRANSCRIPT = [
  { speaker: "ai", message: "Hi, is that Sam? It's Ava, an AI assistant from Acme Dental." },
  { speaker: "caller", message: "Yes, what's this about?" },
];

beforeEach(() => {
  calls.length = 0;
  process.env.GEMINI_API_KEY = "test-key";
  respond = async () => ({ text: JSON.stringify({ summary: "s", sentiment: "neutral", outcome: "appointment" }) });
});

describe("generateSummaryAndSentiment: the 1-argument call stays byte-identical", () => {
  it("builds the SAME contents string with or without an omitted 2nd argument", async () => {
    await generateSummaryAndSentiment(TRANSCRIPT);
    const oneArgContents = calls[0].contents;
    calls.length = 0;

    await generateSummaryAndSentiment(TRANSCRIPT, undefined);
    expect(calls[0].contents).toBe(oneArgContents);
  });

  it("the 1-argument request's prompt carries CALL_OUTCOMES, never the outbound enum", async () => {
    await generateSummaryAndSentiment(TRANSCRIPT);
    for (const o of CALL_OUTCOMES) expect(calls[0].contents).toContain(o);
    for (const o of OUTBOUND_OUTCOME_ENUM) expect(calls[0].contents).not.toContain(o);
  });
});

describe("generateSummaryAndSentiment: the 2-argument outbound call", () => {
  it("the prompt carries the outbound enum instead of CALL_OUTCOMES, and a valid outcome is honoured", async () => {
    respond = async () => ({ text: JSON.stringify({ summary: "s", sentiment: "neutral", outcome: "not_interested" }) });
    const r = await generateSummaryAndSentiment(TRANSCRIPT, OUTBOUND_OUTCOME_ENUM);
    expect(r.outcome).toBe("not_interested");
    for (const o of OUTBOUND_OUTCOME_ENUM) expect(calls[0].contents).toContain(o);
    expect(calls[0].contents).not.toContain("general_inquiry");
  });

  it("an outcome outside the given enum falls back to unknown", async () => {
    respond = async () => ({ text: JSON.stringify({ summary: "s", sentiment: "neutral", outcome: "appointment" }) });
    const r = await generateSummaryAndSentiment(TRANSCRIPT, OUTBOUND_OUTCOME_ENUM);
    expect(r.outcome).toBe("unknown");
  });

  it("an empty array behaves like omitting the argument (falls back to CALL_OUTCOMES)", async () => {
    const r = await generateSummaryAndSentiment(TRANSCRIPT, []);
    expect(r.outcome).toBe("appointment");
    expect(calls[0].contents).toContain("general_inquiry");
  });

  it("no GEMINI_API_KEY -> the same fallback, regardless of the 2nd argument", async () => {
    delete process.env.GEMINI_API_KEY;
    const r = await generateSummaryAndSentiment(TRANSCRIPT, OUTBOUND_OUTCOME_ENUM);
    expect(r).toEqual({ summary: null, sentiment: null, outcome: "unknown" });
  });
});
