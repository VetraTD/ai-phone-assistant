import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

// POST /twilio/transfer-result against the REAL app. Signature validation is
// orthogonal here (tests/voicemailSignature.test.js covers it ON).
process.env.TWILIO_VALIDATE_SIGNATURE = "false";
process.env.BASE_URL = "https://test.example.com";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";

const mockIsEnabled = vi.fn(() => true);
const mockLookup = vi.fn(async () => null);
const mockEndPendingDial = vi.fn(async () => 1);
const mockOutcome = vi.fn(async () => "unscreened");

// loadConfig is the REAL implementation (delegated), so the
// db.loadConfig -> resolveProfile wire is exercised: a rename or shape change
// in either would fail here instead of hiding behind a hand-written stub.
vi.mock("../services/db.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isEnabled: (...a) => mockIsEnabled(...a),
    lookupBusinessByPhone: (...a) => mockLookup(...a),
    endPendingDial: (...a) => mockEndPendingDial(...a),
    pendingDialOutcome: (...a) => mockOutcome(...a),
    loadConfig: (...a) => actual.loadConfig(...a),
  };
});

// Every export real; only buildMessageTwiml can be made to throw (M13).
const twimlState = vi.hoisted(() => ({ throws: false }));
vi.mock("../lib/twiml.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildMessageTwiml: (...a) => {
      if (twimlState.throws) throw new Error("twiml builder exploded");
      return actual.buildMessageTwiml(...a);
    },
  };
});

import { CALL_LINES, buildMessageTwiml } from "../lib/twiml.js";
import { log } from "../lib/logger.js";

const BASE = "https://test.example.com";
const UK = "+441372656055";
const US = "+15550001111";
const FROM = "+447700900123";
const post = (app, body) => request(app).post("/twilio/transfer-result").type("form").send(body);
const postFlagged = (app, body) => request(app).post("/twilio/transfer-result?screened=1").type("form").send(body);
const expected = (voice, to) =>
  buildMessageTwiml({
    line: CALL_LINES.noAnswer,
    sayVoice: voice,
    callbackUrl: `${BASE}/twilio/voicemail?to=${encodeURIComponent(to)}`,
    actionUrl: `${BASE}/twilio/message-done`,
  });

let app;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 30000);

beforeEach(() => {
  twimlState.throws = false;
  mockIsEnabled.mockReset().mockReturnValue(true);
  mockLookup.mockReset().mockResolvedValue(null);
  mockEndPendingDial.mockReset().mockResolvedValue(1);
  mockOutcome.mockReset().mockResolvedValue("unscreened");
});

describe("POST /twilio/transfer-result: pending dial", () => {
  it.each(["completed", "no-answer", "busy", "failed"])("%s ends the dial for this CallSid", async (status) => {
    await post(app, { CallSid: "CA_end_1", To: UK, From: FROM, DialCallStatus: status });
    expect(mockEndPendingDial).toHaveBeenCalledTimes(1);
    expect(mockEndPendingDial).toHaveBeenCalledWith("CA_end_1");
  });

  it("a throwing end leaves the response unchanged (completed -> Hangup, otherwise the message)", async () => {
    mockEndPendingDial.mockRejectedValue(new Error("db down"));
    const done = await post(app, { CallSid: "CA_end_2", To: UK, From: FROM, DialCallStatus: "completed" });
    expect(done.status).toBe(200);
    expect(done.text).toBe("<Response><Hangup/></Response>");
    const missed = await post(app, { CallSid: "CA_end_2", To: UK, From: FROM, DialCallStatus: "no-answer" });
    expect(missed.status).toBe(200);
    expect(missed.text).toContain("<Record");
  });
});

describe("POST /twilio/transfer-result", () => {
  it("completed on an UNFLAGGED dial -> exactly a Hangup, text/xml, no business lookup, and zero outcome reads", async () => {
    const res = await post(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "completed", DialBridged: "false" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/xml/);
    expect(res.text).toBe("<Response><Hangup/></Response>");
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockOutcome).not.toHaveBeenCalled();
  });

  it("a FLAGGED dial reads the outcome before the dial ends", async () => {
    const order = [];
    mockOutcome.mockImplementation(async () => (order.push("outcome"), "accepted"));
    mockEndPendingDial.mockImplementation(async () => (order.push("end"), 1));
    const res = await postFlagged(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "completed", DialBridged: "true" });
    expect(res.text).toBe("<Response><Hangup/></Response>");
    expect(mockOutcome).toHaveBeenCalledWith("CA1");
    expect(order).toEqual(["outcome", "end"]);
  });

  it("flagged + not_accepted + DialBridged true -> the message step", async () => {
    mockOutcome.mockResolvedValue("not_accepted");
    mockLookup.mockResolvedValue({ id: "b1", name: "Biz", locale: "en-GB" });
    const res = await postFlagged(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "completed", DialBridged: "true" });
    expect(res.text).toBe(expected("Polly.Amy", UK));
  });

  it("flagged + no row (the dial-time write failed) + completed + DialBridged false -> the message step", async () => {
    mockOutcome.mockResolvedValue(null);
    const res = await postFlagged(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "completed", DialBridged: "false" });
    expect(res.text).toContain("<Record");
  });

  it("flagged + the outcome read throws + DialBridged false -> the message step", async () => {
    mockOutcome.mockRejectedValue(new Error("db down"));
    const res = await postFlagged(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "completed", DialBridged: "false" });
    expect(res.text).toContain("<Record");
  });

  it("flagged + the outcome read throws + DialBridged true -> Hangup", async () => {
    mockOutcome.mockRejectedValue(new Error("db down"));
    const res = await postFlagged(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "completed", DialBridged: "true" });
    expect(res.text).toBe("<Response><Hangup/></Response>");
  });

  it("flagged + an outcome read that never settles is cut off (null) and DialBridged decides", async () => {
    mockOutcome.mockImplementation(() => new Promise(() => {}));
    const res = await postFlagged(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "completed", DialBridged: "true" });
    expect(res.text).toBe("<Response><Hangup/></Response>");
  }, 15000);

  it("the transfer_result log line carries the screening flag, the verdict and DialBridged, and no numbers", async () => {
    mockOutcome.mockResolvedValue("accepted");
    const info = vi.spyOn(log, "info");
    await postFlagged(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "completed", DialBridged: "true" });
    const line = info.mock.calls.find((c) => c[0] === "transfer_result");
    expect(line[1]).toEqual({
      callSid: "CA1",
      dialStatus: "completed",
      outcome: "hangup",
      screened: true,
      screening: "accepted",
      dialBridged: "true",
    });
    await post(app, { CallSid: "CA2", To: UK, From: FROM, DialCallStatus: "busy" });
    const plain = info.mock.calls.filter((c) => c[0] === "transfer_result").at(-1);
    expect(plain[1]).toMatchObject({ screened: false, screening: null, dialBridged: null });
    expect(JSON.stringify(info.mock.calls)).not.toContain("7700900123");
    info.mockRestore();
  });

  it.each(["no-answer", "busy", "failed", "canceled"])("%s with a UK business -> message in Polly.Amy", async (status) => {
    mockLookup.mockResolvedValue({ id: "b1", name: "Biz", locale: "en-GB" });
    const res = await post(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: status });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/xml/);
    expect(res.text).toBe(expected("Polly.Amy", UK));
    expect(res.text).toContain('recordingStatusCallback="https://test.example.com/twilio/voicemail?to=%2B441372656055"');
    expect(res.text).toContain('action="https://test.example.com/twilio/message-done"');
    expect(res.text).not.toContain(encodeURIComponent(FROM));
    expect(mockLookup).toHaveBeenCalledWith(UK);
  });

  it("a US business -> Polly.Joanna", async () => {
    mockLookup.mockResolvedValue({ id: "b2", name: "Biz", locale: "en-US" });
    const res = await post(app, { CallSid: "CA1", To: US, From: "+15557778888", DialCallStatus: "no-answer" });
    expect(res.text).toBe(expected("Polly.Joanna", US));
  });

  it("lookup throws -> still 200 message, guess voice from the dialled UK number", async () => {
    mockLookup.mockRejectedValue(new Error("db down"));
    const res = await post(app, { CallSid: "CA1", To: UK, From: "+15557778888", DialCallStatus: "no-answer" });
    expect(res.status).toBe(200);
    expect(res.text).toBe(expected("Polly.Amy", UK));
  });

  it("unknown business -> guess voice (UK caller) ", async () => {
    const res = await post(app, { CallSid: "CA1", To: US, From: FROM, DialCallStatus: "busy" });
    expect(res.text).toBe(expected("Polly.Amy", US));
  });

  it("unknown business, US both ends -> en-US voice", async () => {
    const res = await post(app, { CallSid: "CA1", To: US, From: "+15557778888", DialCallStatus: "busy" });
    expect(res.text).toBe(expected("Polly.Joanna", US));
  });

  it("DB disabled -> no lookup, guess voice", async () => {
    mockIsEnabled.mockReturnValue(false);
    const res = await post(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "failed" });
    expect(mockLookup).not.toHaveBeenCalled();
    expect(res.text).toBe(expected("Polly.Amy", UK));
  });

  it("missing DialCallStatus -> message, never empty", async () => {
    const res = await post(app, { CallSid: "CA1", To: UK, From: FROM });
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Record");
  });

  it("missing To -> message with an empty ?to=, no lookup, no crash", async () => {
    const res = await post(app, { CallSid: "CA1", DialCallStatus: "no-answer" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Record");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("last resort: even the guess message throwing sends a constant Say+Hangup, 200 text/xml", async () => {
    twimlState.throws = true;
    const res = await post(app, { CallSid: "CA1", To: UK, From: FROM, DialCallStatus: "no-answer" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/xml/);
    expect(res.text).toBe("<Response><Say>Sorry, nobody could get to the phone. Goodbye.</Say><Hangup/></Response>");
    expect(res.text).not.toContain("<Record");
  });
});
