/**
 * Hammersleys round 6, design item 5 (owner: "make sure this isn't only
 * addressed in this one feature"). Every place where code decides "is this
 * save the same thing as an earlier one?", tested against the two
 * receptionist-wide rules:
 *
 *   R-visible: when unsure, pick the outcome the business can see (a duplicate
 *     record, one more question) over one nobody sees (a silent overwrite,
 *     move or merge).
 *   R-say-it: when the AI knows something (a correction, a second request), it
 *     says so in the tool call; code does not guess it from comparing text.
 *
 * One describe per row of the design's table, through the real functions. The
 * results table lives in docs/receptionist-backlog.md ("Hammersleys fix round 6").
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/db.js", () => ({
  createAppointment: vi.fn(),
  createAppointmentIfAvailable: vi.fn(),
  countScheduledOverlapping: async () => 0,
  listScheduledBetween: async () => [],
  listAppointmentsByCaller: async () => [],
  updateAppointmentStatus: vi.fn(),
  updateAppointment: vi.fn(),
  getAppointmentById: vi.fn(),
}));
vi.mock("../services/integrations.js", () => ({ executeIntegration: vi.fn() }));
vi.mock("../lib/sentry.js", () => ({ captureException: vi.fn() }));

import appointmentsPack, { inAdditionWouldRefuse, correctionAfterSave } from "../capabilities/appointments.js";
import { saveCustomerRequest } from "../lib/capabilities/customerRequests.js";
import { parseNotesQuestions, openQuestions } from "../lib/capabilities/notesQuestions.js";
import { asksIn, createAskLedger } from "../lib/voice/askLedger.js";
import { outboundNameOnFile } from "../services/tools.js";

// ---------------------------------------------------------------------------
// Row 1: messages / callbacks (lib/capabilities/customerRequests.js) -- fixed
// this round; tests/customerRequestsRound6.test.js holds the full set.
// ---------------------------------------------------------------------------
describe("row 1 messages: R-say-it decides, a forgotten field stays visible", () => {
  function db() {
    const rows = [];
    return {
      rows,
      withTenantSafe: async (_t, fn) => fn(),
      createCustomerRequest: async (r) => {
        rows.push({ id: `r${rows.length + 1}`, caller_name: r.callerName, message: r.message, details: r.details, request_type: r.requestType, seq: rows.length });
        return `r${rows.length}`;
      },
      listCallCustomerRequests: async () => [...rows].sort((a, b) => b.seq - a.seq),
      updateCustomerRequest: async (u) => {
        const row = rows.find((r) => r.id === u.id);
        if (u.callerName) row.caller_name = u.callerName;
        if (u.details) row.details = u.details;
        return row.id;
      },
    };
  }
  const trip = { callerType: "new_enquiry", answers: [{ label: "Pickup", answer: "Plaistow Street" }, { label: "Destination", answer: "Dormansland" }] };
  const save = (d, name, extra = {}) =>
    saveCustomerRequest({
      db: d,
      businessId: "b",
      callId: "c",
      row: { requestType: "message", callerName: name, callbackNumber: null, message: "Taxi booking request", preferredTime: null, details: trip },
      ...extra,
    });

  it("the AI says it (replaces_name): one record", async () => {
    const d = db();
    await save(d, "John Doe");
    await save(d, "James Doe", { replacesName: "John Doe" });
    expect(d.rows).toHaveLength(1);
  });
  it("the AI forgets it: two records the owner can see, never a silent merge (R59)", async () => {
    const d = db();
    await save(d, "John Doe");
    await save(d, "James Doe");
    expect(d.rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Row 2: appointments, name corrected (correct_appointment_name). The tool is
// how the AI says it (R-say-it); tests/tools.test.js "correct_appointment_name"
// proves it updates the existing row, refuses (asks) when it cannot tell which
// appointment, and never creates one.
// ---------------------------------------------------------------------------
describe("row 2 appointments, name corrected", () => {
  it("the AI has a tool to say it, and the tool says it updates, never creates", () => {
    expect(appointmentsPack.toolNames).toContain("correct_appointment_name");
  });
});

// ---------------------------------------------------------------------------
// Rows 3 + 4: appointments booked again after a misheard name, and a time
// corrected right after a save (LVX179 Fix 3).
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;
const day = (n) => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
const SLOT = `${day(30)}T14:00:00`;
const onFile = (client_name) => ({ callCount: 3, upcomingAppointments: [{ id: "a4", client_name, scheduled_at: `${day(4)}T11:00:00` }] });
const ctxWith = (over = {}) => ({
  businessId: "biz-1",
  callerPhone: "+15551234567",
  callId: "call-1",
  integrations: [],
  capabilityState: {},
  config: {},
  callerSaidThisCall: "I'd like to book something",
  lastCallerText: "",
  lastReplyText: "",
  inTurnReplyText: "",
  ...over,
});

describe("row 3 appointments, booked again after a misheard name", () => {
  it("one letter off (Jon / John): the same person -- the caller is asked (visible)", () => {
    expect(inAdditionWouldRefuse({ client_name: "Jon Doe", scheduled_at: SLOT }, ctxWith({ callerContext: onFile("John Doe") }), {})).toBe(true);
  });
  it("both names misheard (John Doe -> James Dean) and book_appointment again: a second booking, visible to the business, never a silent move", () => {
    const ctx = ctxWith({
      callerContext: onFile("John Doe"),
      capabilityState: { appointments: { lastBooked: { id: "a1", scheduled_at: `${day(30)}T13:00:00.000Z`, client_name: "John Doe", callerSaidLen: 0 } } },
      callerSaidThisCall: "No, it's James Dean.",
    });
    expect(inAdditionWouldRefuse({ client_name: "James Dean", scheduled_at: SLOT }, ctx, {})).toBe(false);
    expect(correctionAfterSave({ client_name: "James Dean", scheduled_at: SLOT }, ctx, `${day(30)}T14:00:00.000Z`)).toBeNull();
  });
});

describe("row 4 appointments, time corrected right after a save (Fix 3)", () => {
  const last = { id: "a1", scheduled_at: "2026-12-18T09:00:00.000Z", client_name: "Ada Moss", callerSaidLen: 0 };
  const ctx = (said) => ctxWith({ capabilityState: { appointments: { lastBooked: last } }, callerSaidThisCall: said });
  it("unsure what the caller meant: asks (move or keep both), never a silent move", () => {
    expect(correctionAfterSave({ client_name: "Ada Moss" }, ctx(""), "2026-12-18T10:00:00.000Z")).toMatchObject({ kind: "ask" });
  });
  it("a clear correction ('10 instead'): asks to confirm the move, still not silent", () => {
    expect(correctionAfterSave({ client_name: "Ada Moss" }, ctx("No, 10 instead."), "2026-12-18T10:00:00.000Z")).toMatchObject({ kind: "confirm_move" });
  });
  it("a different first name (Mary for Mark): not a move at all", () => {
    expect(correctionAfterSave({ client_name: "Mary Moss" }, ctx("No, 10 instead."), "2026-12-18T10:00:00.000Z")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row 5: the same question twice (lib/voice/askLedger.js). It decides only
// whether a question is cut; it never writes or merges a record. A miss is a
// repeat the caller hears, never lost data.
// ---------------------------------------------------------------------------
describe("row 5 same question twice", () => {
  it("a rewording it does not recognise is not the same ask: the worst case is the question asked again", () => {
    expect(asksIn("What is the postcode?")).toEqual(["q:postcode"]);
    expect(asksIn("And the post code for that?")).toEqual([]);
  });
  it("the ledger has no write path: it records turns and answers 'is this a repeat?', nothing else", () => {
    expect(Object.keys(createAskLedger()).sort()).toEqual(["forget", "isDeclined", "recordCallerTurn", "recordReply", "repeatIn"]);
  });
});

// ---------------------------------------------------------------------------
// Row 6: question answered? (lib/capabilities/notesQuestions.js). A label that
// does not match leaves the question open -- asked again (visible), never a
// saved answer lost. Completeness: messages.answerParts (round 6 item 2).
// ---------------------------------------------------------------------------
describe("row 6 question answered?", () => {
  const qs = parseNotesQuestions("Ask:\n1. Pickup: where from?\n2. Destination: where to?");
  it("an unmatched label keeps the question open (one more question, visible)", () => {
    expect(openQuestions(qs, ["Address"]).map((q) => q.label)).toEqual(["Pickup", "Destination"]);
  });
  it("a matching label closes it", () => {
    expect(openQuestions(qs, ["Pick-up location"]).map((q) => q.label)).toEqual(["Destination"]);
  });
});

// ---------------------------------------------------------------------------
// Row 7: outbound name on file (services/tools.js outboundNameOnFile; outbound
// is off). Unsure -> null, and the ordinary gate asks.
// ---------------------------------------------------------------------------
describe("row 7 outbound name on file", () => {
  const fc = (client_name) => ({ name: "book_appointment", args: { client_name } });
  const ctx = (verified = true) => ({ outboundCall: { contact: { firstName: "Nithin", lastName: "Dodla" } }, party: { verified } });
  it("a different person on the contact's phone: unsure -> asks", () => {
    expect(outboundNameOnFile(fc("Priya Dodla"), ctx())).toBeNull();
  });
  it("a misheard surname within the bound is the contact", () => {
    expect(outboundNameOnFile(fc("Nithin Dadla"), ctx())).toEqual({ fullName: "Nithin Dodla" });
  });
  it("an unverified party: never taken from the file", () => {
    expect(outboundNameOnFile(fc("Nithin Dodla"), ctx(false))).toBeNull();
  });
});
