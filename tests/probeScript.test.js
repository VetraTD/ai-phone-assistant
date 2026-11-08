import { describe, it, expect } from "vitest";
import twilio from "twilio";
import { buildStatusCallbackRequest } from "../lib/probe/twilioRequests.js";
import { SCRIPT_LINES, REPRESENTATIVE_LINES, resolveScriptLines } from "../lib/probe/script.js";

// ---------------------------------------------------------------------------
// The diagnostic script (SCRIPT_LINES) hand-picks utterances to trigger each
// classifyHold branch — 4 of its 8 lines carry an expectRule. That is right for
// exercising the branches, and wrong for sizing what they cost: it made
// classifyHold look like it fires on ~1 in 3 turns.
//
// REPRESENTATIVE_LINES exists to answer the other question. Its shape is taken
// from 1,000 real caller utterances in call_transcripts (aggregate statistics
// only, no transcript text was copied):
//
//   median 6 words · p25 4 · p90 14 · ~25% are 1-3 words · ~34% questions
//   · ~10% contain digits
//
// The tolerances below are wide because the target is "realistic", not "exact".
// They exist to stop this script drifting back into a rigged one.
// ---------------------------------------------------------------------------
const words = (s) => s.trim().split(/\s+/).length;
const pct = (n) => (100 * n) / REPRESENTATIVE_LINES.length;

describe("REPRESENTATIVE_LINES — shaped like real caller speech", () => {
  it("never declares an expected hold rule", () => {
    // The whole point: Deepgram decides where finals land, so the rule mix is
    // an OUTCOME of the run. Naming an expectation here would rig it again.
    for (const line of REPRESENTATIVE_LINES) {
      expect(line.expectRule).toBeUndefined();
    }
  });

  it("has a median length near the real 6 words", () => {
    const w = REPRESENTATIVE_LINES.map((l) => words(l.text)).sort((a, b) => a - b);
    const median = w[Math.floor(w.length / 2)];
    expect(median).toBeGreaterThanOrEqual(4);
    expect(median).toBeLessThanOrEqual(8);
  });

  it("carries the real proportion of short acknowledgements (~25%)", () => {
    expect(pct(REPRESENTATIVE_LINES.filter((l) => words(l.text) <= 3).length)).toBeGreaterThanOrEqual(10);
    expect(pct(REPRESENTATIVE_LINES.filter((l) => words(l.text) <= 3).length)).toBeLessThanOrEqual(40);
  });

  it("carries the real proportion of questions (~34%)", () => {
    const q = REPRESENTATIVE_LINES.filter((l) => /\?\s*$/.test(l.text)).length;
    expect(pct(q)).toBeGreaterThanOrEqual(20);
    expect(pct(q)).toBeLessThanOrEqual(50);
  });

  it("includes digits on roughly one line in ten, and a long tail utterance", () => {
    expect(REPRESENTATIVE_LINES.some((l) => /\d|five|three|seven/i.test(l.text))).toBe(true);
    expect(Math.max(...REPRESENTATIVE_LINES.map((l) => words(l.text)))).toBeGreaterThanOrEqual(12);
  });

  it("still exercises the barge-in path exactly once", () => {
    expect(REPRESENTATIVE_LINES.filter((l) => l.bargeInAfterMs).length).toBe(1);
  });

  it("uses labels that cannot collide with the diagnostic script's cached audio", () => {
    const diag = new Set(SCRIPT_LINES.map((l) => l.label));
    for (const l of REPRESENTATIVE_LINES) expect(diag.has(l.label)).toBe(false);
  });
});

describe("resolveScriptLines", () => {
  it("defaults to the diagnostic script, preserving existing behaviour", () => {
    expect(resolveScriptLines()).toBe(SCRIPT_LINES);
    expect(resolveScriptLines("diagnostic")).toBe(SCRIPT_LINES);
  });

  it("returns the representative script by name", () => {
    expect(resolveScriptLines("representative")).toBe(REPRESENTATIVE_LINES);
  });

  it("refuses an unknown name rather than silently running the wrong script", () => {
    expect(() => resolveScriptLines("nonsense")).toThrow(/unknown probe script/i);
  });
});

// ---------------------------------------------------------------------------
// Task 15h: four generic scripted INBOUND callers (a business enquiry that
// answers everything, one that corrects its number, one that hangs up after the
// company, and a wrong number). Generic on purpose: fictional names, reserved
// numbers (UK 07700 900xxx), an example.com email.
// ---------------------------------------------------------------------------
const INBOUND_NAMES = ["inbound_lead_full", "inbound_lead_correct_number", "inbound_lead_hangup", "inbound_wrong_number"];
const INBOUND_HANGUP_LABEL = "ih_company";

describe("inbound enquiry scripts (Task 15h)", () => {
  it("each resolves by name to non-empty { label, text } lines", () => {
    for (const name of INBOUND_NAMES) {
      const lines = resolveScriptLines(name);
      expect(lines.length).toBeGreaterThan(1);
      for (const l of lines) {
        expect(typeof l.label).toBe("string");
        expect(typeof l.text).toBe("string");
        expect(l.text.length).toBeGreaterThan(0);
      }
    }
  });

  it("labels are unique inside each script and never reused by another script", () => {
    const owner = new Map();
    for (const name of INBOUND_NAMES) {
      for (const l of resolveScriptLines(name)) {
        expect(owner.has(l.label), `${l.label} in ${name} also in ${owner.get(l.label)}`).toBe(false);
        owner.set(l.label, name);
      }
    }
    for (const other of ["diagnostic", "representative", "demo_booking", "demo_cancel", "outbound_hello", "outbound_email"]) {
      for (const l of resolveScriptLines(other)) expect(owner.has(l.label), `${l.label} collides with ${other}`).toBe(false);
    }
  });

  it("any digits are a reserved UK number (07700 900xxx), never a real-looking one", () => {
    for (const name of INBOUND_NAMES) {
      for (const l of resolveScriptLines(name)) {
        const runs = l.text.replace(/[ ,-]/g, "").match(/[0-9]{5,}/g) || [];
        for (const run of runs) expect(run).toMatch(/^07700900[0-9]{3}$/);
      }
    }
  });

  it("carries no business name and spells an example.com email", () => {
    const all = INBOUND_NAMES.flatMap((n) => resolveScriptLines(n).map((l) => l.text)).join(" ");
    expect(all).toMatch(/example dot com/i);
    expect(all).not.toMatch(/brightwork|digile|vetra|ilija/i);
  });

  it("the hang-up script ends on its company line, and that label is ih_company", () => {
    const lines = resolveScriptLines("inbound_lead_hangup");
    expect(lines.at(-1).label).toBe(INBOUND_HANGUP_LABEL);
    expect(lines.map((l) => l.label)).toContain(INBOUND_HANGUP_LABEL);
  });

  it("the correct-number script gives one number, then a different one later", () => {
    const lines = resolveScriptLines("inbound_lead_correct_number");
    const numbered = lines.filter((l) => /zero seven seven zero/i.test(l.text));
    expect(numbered.length).toBe(2);
    expect(numbered[0].text).not.toBe(numbered[1].text);
    expect(lines.indexOf(numbered[1]) - lines.indexOf(numbered[0])).toBeGreaterThanOrEqual(3);
  });

  it("the wrong-number script apologises and says goodbye", () => {
    const lines = resolveScriptLines("inbound_wrong_number");
    expect(lines[0].text).toMatch(/wrong number/i);
    expect(lines.at(-1).text).toMatch(/bye/i);
  });
});

// ---------------------------------------------------------------------------
// Task 15h: --post-status. The status callback Twilio sends when a call ends,
// which is what makes the server email the owner their saved messages.
// ---------------------------------------------------------------------------
describe("buildStatusCallbackRequest (--post-status)", () => {
  const args = {
    base: "http://localhost:3000",
    callSid: "CAabc123",
    to: "+447700900111",
    from: "+447700900222",
    durationSec: 87.6,
    authToken: "test-token",
  };

  it("posts to /twilio/status with the call's own CallSid and CallStatus=completed", () => {
    const req = buildStatusCallbackRequest(args);
    expect(req.url).toBe("http://localhost:3000/twilio/status");
    expect(req.init.method).toBe("POST");
    const body = new URLSearchParams(req.init.body);
    expect(body.get("CallSid")).toBe("CAabc123");
    expect(body.get("CallStatus")).toBe("completed");
    expect(body.get("To")).toBe("+447700900111");
    expect(body.get("From")).toBe("+447700900222");
    expect(body.get("CallDuration")).toBe("88");
  });

  it("is signed so twilio.validateRequest accepts it over the same url and params", () => {
    const req = buildStatusCallbackRequest(args);
    const params = Object.fromEntries(new URLSearchParams(req.init.body));
    expect(twilio.validateRequest("test-token", req.init.headers["X-Twilio-Signature"], req.url, params)).toBe(true);
    expect(twilio.validateRequest("other-token", req.init.headers["X-Twilio-Signature"], req.url, params)).toBe(false);
  });
});
