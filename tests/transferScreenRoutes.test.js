import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

// POST /twilio/transfer-whisper and /twilio/transfer-accept against the REAL app.
process.env.TWILIO_VALIDATE_SIGNATURE = "false";
process.env.BASE_URL = "https://test.example.com";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";

const mockBusinessOf = vi.fn(async () => "b1");
const mockAccept = vi.fn(async () => 1);
const mockFetch = vi.fn(async () => null);

vi.mock("../services/db.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    pendingDialBusiness: (...a) => mockBusinessOf(...a),
    acceptPendingDial: (...a) => mockAccept(...a),
    fetchBusinessById: (...a) => mockFetch(...a),
    withTenant: async (_id, fn) => fn(),
    loadConfig: (...a) => actual.loadConfig(...a),
  };
});

import { log } from "../lib/logger.js";

const whisper = (app, body, q = "?b=b1") => request(app).post(`/twilio/transfer-whisper${q}`).type("form").send(body);
const accept = (app, body, q = "") => request(app).post(`/twilio/transfer-accept${q}`).type("form").send(body);
const HANGUP = "<Response><Hangup/></Response>";
const ROW = { id: "b1", name: "Hammersleys Taxis", locale: "en-GB" };

let app;
let errors;
beforeAll(async () => {
  ({ app } = await import("../server.js"));
}, 30000);

beforeEach(() => {
  mockBusinessOf.mockReset().mockResolvedValue("b1");
  mockAccept.mockReset().mockResolvedValue(1);
  mockFetch.mockReset().mockResolvedValue(ROW);
  errors = [];
  vi.spyOn(log, "error").mockImplementation((...a) => void errors.push(a));
});

describe("POST /twilio/transfer-whisper", () => {
  it("hangs up when the business lookup stalls past the screen timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockBusinessOf.mockImplementation(() => new Promise(() => {}));
      const pending = whisper(app, { ParentCallSid: "CA_slow1" }).then((r) => r);
      await vi.advanceTimersByTimeAsync(3000);
      const res = await pending;
      expect(res.text).toBe(HANGUP);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hangs up when the business fetch stalls past the screen timeout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockFetch.mockImplementation(() => new Promise(() => {}));
      const pending = whisper(app, { ParentCallSid: "CA_slow2" }).then((r) => r);
      await vi.advanceTimersByTimeAsync(3000);
      const res = await pending;
      expect(res.text).toBe(HANGUP);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the generic sentence with the business name, twice, in the business's voice", async () => {
    const res = await whisper(app, { ParentCallSid: "CA1" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/xml/);
    const line = "Call from the Hammersleys Taxis AI receptionist. Press 1 to take it.";
    expect(res.text).toBe(
      '<Response><Gather numDigits="1" timeout="6" action="https://test.example.com/twilio/transfer-accept?p=CA1" method="POST">' +
        `<Say voice="Polly.Amy">${line}</Say><Pause length="1"/><Say voice="Polly.Amy">${line}</Say></Gather><Hangup/></Response>`
    );
    expect(mockBusinessOf).toHaveBeenCalledWith("CA1");
  });

  it("says the business's own text when it has one", async () => {
    mockFetch.mockResolvedValue({ ...ROW, transfer_whisper: "Urgent taxi request. Press 1." });
    const res = await whisper(app, { ParentCallSid: "CA1" });
    expect(res.text).toContain('<Say voice="Polly.Amy">Urgent taxi request. Press 1.</Say>');
    expect(res.text).not.toContain("AI receptionist. Press 1 to take it");
  });

  it.each([
    ["an unknown ParentCallSid", () => mockBusinessOf.mockResolvedValue(null), "?b=b1"],
    ["a ?b= that does not match", () => {}, "?b=other"],
    ["a database error on the lookup", () => mockBusinessOf.mockRejectedValue(new Error("db down")), "?b=b1"],
    ["a business that cannot be read", () => mockFetch.mockResolvedValue(null), "?b=b1"],
    ["a database error on the business read", () => mockFetch.mockRejectedValue(new Error("db down")), "?b=b1"],
  ])("%s -> Hangup", async (_name, arrange, q) => {
    arrange();
    const res = await whisper(app, { ParentCallSid: "CA1" }, q);
    expect(res.status).toBe(200);
    expect(res.text).toBe(HANGUP);
  });
});

describe("POST /twilio/transfer-accept", () => {
  it("Digits 1 stamps the parent call and bridges (empty Response)", async () => {
    const res = await accept(app, { ParentCallSid: "CA1", Digits: "1" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/xml/);
    expect(res.text).toBe("<Response></Response>");
    expect(mockAccept).toHaveBeenCalledWith("CA1");
  });

  it.each([["2"], [undefined], [""], ["11"]])("Digits %j -> Hangup and no stamp", async (Digits) => {
    const res = await accept(app, { ParentCallSid: "CA1", ...(Digits === undefined ? {} : { Digits }) });
    expect(res.text).toBe(HANGUP);
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it("one transient failure then success -> bridge", async () => {
    mockAccept.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(1);
    const res = await accept(app, { ParentCallSid: "CA1", Digits: "1" });
    expect(res.text).toBe("<Response></Response>");
    expect(mockAccept).toHaveBeenCalledTimes(2);
  });

  it("a stamp that throws twice -> Hangup (fail closed) and an error log without caller data", async () => {
    mockAccept.mockRejectedValue(new Error("db down"));
    const res = await accept(app, { ParentCallSid: "CA1", Digits: "1", From: "+447700900123", To: "+442079460958" });
    expect(res.text).toBe(HANGUP);
    expect(mockAccept).toHaveBeenCalledTimes(2);
    expect(errors.map((e) => e[0])).toContain("transfer_accept_failed_closed");
    expect(JSON.stringify(errors)).not.toContain("7700900123");
    expect(JSON.stringify(errors)).not.toContain("2079460958");
  });

  it("a stamp that matches no row twice, or no database -> Hangup", async () => {
    mockAccept.mockResolvedValue(0);
    expect((await accept(app, { ParentCallSid: "CA1", Digits: "1" })).text).toBe(HANGUP);
    mockAccept.mockReset().mockResolvedValue(null);
    expect((await accept(app, { ParentCallSid: "CA1", Digits: "1" })).text).toBe(HANGUP);
  });

  it("the whisper puts the parent sid on the accept URL, encoded", async () => {
    const res = await whisper(app, { ParentCallSid: "CA 1&2" });
    expect(res.text).toContain('action="https://test.example.com/twilio/transfer-accept?p=CA%201%262"');
  });

  it("no ParentCallSid in the body: the ?p= value is used", async () => {
    const res = await accept(app, { Digits: "1" }, "?p=CA9");
    expect(res.text).toBe("<Response></Response>");
    expect(mockAccept).toHaveBeenCalledWith("CA9");
  });

  it("body and ?p= agree -> bridge; the body's value is used", async () => {
    const res = await accept(app, { ParentCallSid: "CA1", Digits: "1" }, "?p=CA1");
    expect(res.text).toBe("<Response></Response>");
    expect(mockAccept).toHaveBeenCalledWith("CA1");
  });

  it("body and ?p= differ -> Hangup and no stamp", async () => {
    const res = await accept(app, { ParentCallSid: "CA1", Digits: "1" }, "?p=CA2");
    expect(res.text).toBe(HANGUP);
    expect(mockAccept).not.toHaveBeenCalled();
  });

  it("neither present -> Hangup (nothing to stamp)", async () => {
    mockAccept.mockResolvedValue(0);
    const res = await accept(app, { Digits: "1" });
    expect(res.text).toBe(HANGUP);
  });

  it("a stamp that never settles is cut off: retried once, then Hangup", async () => {
    mockAccept.mockImplementation(() => new Promise(() => {}));
    const res = await accept(app, { ParentCallSid: "CA1", Digits: "1" });
    expect(res.text).toBe(HANGUP);
    expect(mockAccept).toHaveBeenCalledTimes(2);
  }, 20000);

  it("a first attempt that hangs and a second that succeeds -> bridge", async () => {
    mockAccept.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(1);
    const res = await accept(app, { ParentCallSid: "CA1", Digits: "1" });
    expect(res.text).toBe("<Response></Response>");
  }, 20000);
});
