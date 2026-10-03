// ---------------------------------------------------------------------------
// THE NAME ON FILE IS THE SPELLING, ON A CALL WE PLACED. 2026-10-02.
//
// CA1ff2c6 (outbound, rev 00098): the lead had agreed to a discovery call, and
// the spelling gate then held the booking -- "could you please spell your full
// name for me?" -- on a call that had opened with their name. The caller asked
// "What do you have on file?", was told "I cannot share the details on file",
// and three turns went on a name the business already had, typed by the lead.
//
// Owner rule (2026-10-02): full name on file -> no name or spelling question,
// and the booking uses the name on file; no name -> the ordinary full ask. Only
// for a booking made FOR the contact, on an outbound call, once confirm_identity
// has verified them.
//
// CHANGED 2026-10-02 night (owner, batch 2): first name only on file -> NO
// surname ask either. O1 CA591a92 showed the cost -- read-back to booked took
// 31 s, most of it the surname being spelled. The booking goes under the
// model's client_name (the first name plus the surname it heard), or the first
// name alone if it heard none.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateAppointment = vi.fn();

vi.mock("../services/db.js", () => ({
  createAppointment: (...a) => mockCreateAppointment(...a),
  createAppointmentIfAvailable: async (p) => {
    const id = await mockCreateAppointment(p);
    return id ? { id } : { full: true };
  },
  countScheduledOverlapping: async () => 0,
  listScheduledBetween: async () => [],
  listAppointmentsByCaller: async () => [],
  updateAppointmentStatus: async () => false,
  updateAppointment: async () => false,
  getAppointmentById: async () => null,
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createRequestId: vi.fn(() => "req-1"),
  recordTurnLatency: vi.fn(),
}));

import { executeToolCall } from "../services/tools.js";
import { clearStats, getLatencyStats } from "../lib/voice/metrics.js";

const FUTURE_SLOT = `${new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)}T10:00:00`;
const READ_BACK = "Shall we book your discovery call for Monday, October fifth at four thirty PM?";

const outboundCtx = ({ firstName = "Nithin", lastName = "Dodla", verified = true, outbound = true } = {}) => ({
  businessId: "biz-1",
  callerPhone: "+15551234567",
  callId: "call-1",
  integrations: [],
  capabilityState: {},
  config: {},
  spellingSettled: false,
  callerTurnCount: 5,
  lastCallerText: "Yes",
  lastReplyText: READ_BACK,
  callerContext: null,
  callerSaidThisCall: "Hello. Yes. Yes.",
  ...(outbound
    ? {
        outboundCall: {
          config: { capabilities: ["appointments"] },
          contact: { firstName, lastName, phone: "+15551234567" },
        },
        party: { phone: "+15551234567", source: "dialed", verified },
      }
    : {}),
});

const bookAs = (client_name, c) =>
  executeToolCall(
    {
      id: "fc1",
      name: "book_appointment",
      args: { ...(client_name == null ? {} : { client_name }), scheduled_at: FUTURE_SLOT, notes: "discovery call" },
    },
    c
  );

const counters = () => getLatencyStats().turnTaking;
const writtenName = () => JSON.stringify(mockCreateAppointment.mock.calls[0]?.[0] ?? null);

beforeEach(() => {
  clearStats();
  vi.clearAllMocks();
  mockCreateAppointment.mockResolvedValue("appt-1");
});

describe("outbound: a full name on file is used, never asked for", () => {
  it("books under the name on file when the model passed only the first name", async () => {
    const res = await bookAs("Nithin", outboundCtx());
    expect(res.functionResponse.response.success).toBe(true);
    expect(counters().spelling_gate_refusals).toBeFalsy();
    expect(counters().outbound_name_from_file).toBe(1);
    expect(writtenName()).toContain("Nithin Dodla");
  });

  it("books under the name on file when the model passed no name at all", async () => {
    const res = await bookAs(null, outboundCtx());
    expect(res.functionResponse.response.success).toBe(true);
    expect(writtenName()).toContain("Nithin Dodla");
  });

  it("replaces a misheard surname with the one on file", async () => {
    const res = await bookAs("Nithin Dadla", outboundCtx());
    expect(res.functionResponse.response.success).toBe(true);
    expect(writtenName()).toContain("Nithin Dodla");
    expect(writtenName()).not.toContain("Dadla");
  });

  it("leaves a booking for SOMEONE ELSE to the ordinary spelling gate", async () => {
    const res = await bookAs("Priya Shah", outboundCtx());
    expect(res.functionResponse.response.success).toBe(false);
    expect(counters().spelling_gate_refusals).toBe(1);
    expect(counters().outbound_name_from_file).toBeFalsy();
    expect(res.functionResponse.response.message).toContain("FULL name");
  });
});

describe("outbound: first name only on file -> no spelling question at all (owner, 2026-10-02 night)", () => {
  it("books under the model's name -- the first name plus the surname it heard", async () => {
    const res = await bookAs("Nithin Dodla", outboundCtx({ lastName: null }));
    expect(res.functionResponse.response.success).toBe(true);
    expect(counters().spelling_gate_refusals).toBeFalsy();
    expect(counters().outbound_name_first_only_used).toBe(1);
    expect(writtenName()).toContain("Nithin Dodla");
  });

  it("books under the first name alone when the model heard no surname", async () => {
    const res = await bookAs("Nithin", outboundCtx({ lastName: null }));
    expect(res.functionResponse.response.success).toBe(true);
    expect(counters().spelling_gate_refusals).toBeFalsy();
    expect(writtenName()).toContain('"Nithin"');
  });
});

describe("unchanged everywhere else", () => {
  it("inbound: the ordinary full-name ask", async () => {
    const res = await bookAs("Nithin Dodla", outboundCtx({ outbound: false }));
    expect(res.functionResponse.response.success).toBe(false);
    expect(res.functionResponse.response.message).toContain("FULL name");
    expect(counters().outbound_name_from_file).toBeFalsy();
  });

  it("outbound with no name on file: the ordinary full-name ask", async () => {
    const res = await bookAs("Nithin Dodla", outboundCtx({ firstName: null, lastName: null }));
    expect(res.functionResponse.response.success).toBe(false);
    expect(res.functionResponse.response.message).toContain("FULL name");
  });

  it("outbound, identity not confirmed: refused before any name is used", async () => {
    const res = await bookAs("Nithin", outboundCtx({ verified: false }));
    expect(res.functionResponse.response.success).toBe(false);
    expect(res.functionResponse.response.message).toContain("confirm_identity");
    expect(counters().outbound_name_from_file).toBeFalsy();
  });
});

// Review fixes (2026-10-02, final review I1/I3/M6).
describe("only a misheard SURNAME is replaced; a different name goes to the ordinary gate", () => {
  it.each([["Nithin's wife"], ["Nithin and Priya Dodla"], ["Nithin Dodla-Reddy"], ["Nithin Patel"]])(
    "%j is not booked under the name on file",
    async (said) => {
      const res = await bookAs(said, outboundCtx({ firstName: "Nithin", lastName: "Dodla" }));
      expect(counters().outbound_name_from_file).toBeFalsy();
      expect(res.functionResponse.response.success).toBe(false);
      expect(res.functionResponse.response.message).toContain("FULL name");
    }
  );

  it("first name only on file, and the model sent no name: booked under the first name, nothing asked", async () => {
    const res = await bookAs(null, outboundCtx({ lastName: null }));
    expect(res.functionResponse.response.success).toBe(true);
    expect(counters().spelling_gate_refusals).toBeFalsy();
    expect(writtenName()).toContain('"Nithin"');
  });

  it.each([["Nithin's wife"], ["Nithin and Priya"], ["Nithin Dodla Reddy"], ["Priya Shah"]])(
    "first name only on file, %j: someone else's name -> the ordinary full-name ask",
    async (said) => {
      const res = await bookAs(said, outboundCtx({ lastName: null }));
      expect(res.functionResponse.response.success).toBe(false);
      expect(counters().outbound_name_first_only_used).toBeFalsy();
      expect(res.functionResponse.response.message).toContain("FULL name");
    }
  );

  it("a name-on-file booking does not trip the never-spoken screen", async () => {
    const res = await bookAs("Nithin", outboundCtx());
    expect(res.functionResponse.response.success).toBe(true);
    expect(counters().booking_name_never_spoken).toBeFalsy();
  });
});
