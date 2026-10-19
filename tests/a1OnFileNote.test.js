// ---------------------------------------------------------------------------
// Round A1 Part 6 (calls a/c CAc31b31c / CA1cfcbc4e, 2026-10-19): an on-file
// caller was asked to spell their name on 3 of 3 calls, and "another
// appointment" drew the extra-or-move question. Both were prompt-only rules.
// set_call_intent is the first tool of those calls and runs before the
// model's words that turn, so its reply now carries the on-file name.
// Names are pseudonyms (LVX24).
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bootLive, fakeDb } from "./helpers/liveBoot.js";
import { onFileNameNote } from "../capabilities/appointments.js";
import { executeToolCall } from "../services/tools.js";

const BOOKING = { allowedTasks: ["book_appointment", "check_appointment"], timezone: "America/Chicago" };
const row = (client_name, at) => ({ id: `a-${client_name}-${at}`, client_name, scheduled_at: at });
const one = { upcomingAppointments: [row("Ada Moss", "2026-09-21T15:00:00Z"), row("Ada Moss", "2026-09-22T15:00:00Z")] };
const several = {
  upcomingAppointments: [
    row("Priya Raman", "2026-09-21T15:00:00Z"),
    row("Ada Moss", "2026-09-22T15:00:00Z"),
    row("Ada Moss", "2026-09-23T15:00:00Z"),
    row("Maja Okafor", "2026-09-24T15:00:00Z"),
  ],
  upcomingOverflow: 1,
  upcomingBeyond: [row("Ada Moss", "2026-09-30T15:00:00Z")],
};
const BOOK = "book_appointment";
const live = (callerContext, config = BOOKING, extra = {}) => ({ callerSaidThisCall: "", callerContext, config, ...extra });

describe("Part 6: the on-file name in set_call_intent's reply", () => {
  it("one name on record: use it, never ask for it or spell it; 'another' is an extra booking", () => {
    const note = onFileNameNote(live(one), BOOK);
    expect(note).toMatch(/^\[not caller speech\] On this caller's record: Ada Moss\./);
    expect(note).toMatch(/do not ask them to spell it/);
    expect(note).toMatch(/another or one more appointment, it is an extra booking/);
    expect(note).toMatch(/book it with in_addition_to_existing set to true/);
    expect(note).not.toMatch(/Is that under/);
  });

  // Opus review M2: a message has no read-back, so someone else on the
  // household phone would be filed under the on-file name.
  it("only for a booking intent: a message or anything else gets no note", () => {
    expect(onFileNameNote(live(one), "take_message")).toBeNull();
    expect(onFileNameNote(live(one), undefined)).toBeNull();
  });

  // Opus review M3: the listed rows only (the spelling gate's own list), at
  // most three -- an office number does not hand the model every name.
  it("names from the listed bookings only, at most three, most-booked first", () => {
    const office = {
      upcomingAppointments: [
        row("Cara Lim", "2026-09-21T15:00:00Z"),
        row("Ben Moss", "2026-09-22T15:00:00Z"),
        row("Ben Moss", "2026-09-23T15:00:00Z"),
        row("Dev Shah", "2026-09-24T15:00:00Z"),
        row("Eve Tan", "2026-09-25T15:00:00Z"),
      ],
      // Beyond the five listed and the most-booked: still never named.
      upcomingOverflow: 3,
      upcomingBeyond: ["09-28", "09-29", "09-30"].map((d) => row("Zed Orr", `2026-${d}T15:00:00Z`)),
    };
    const note = onFileNameNote(live(office), BOOK);
    expect(note).toMatch(/Names on this caller's record: Ben Moss, Cara Lim and Dev Shah\./);
    expect(note).not.toMatch(/Eve Tan|Zed Orr/);
  });

  it("several names: never spell any; only 'Is that under <most booked>?' when unclear", () => {
    const note = onFileNameNote(live(several), BOOK);
    expect(note).toMatch(/Names on this caller's record: Ada Moss, Priya Raman and Maja Okafor\./);
    expect(note).toMatch(/Never ask any of them to spell their name/);
    expect(note).toMatch(/ask only "Is that under Ada Moss\?"/);
  });

  it("no note on the cascade, on outbound, or with no name on record", () => {
    expect(onFileNameNote({ callerContext: one, config: BOOKING }, BOOK)).toBeNull();
    expect(onFileNameNote(live(one, BOOKING, { outboundCall: { id: "o1" } }), BOOK)).toBeNull();
    expect(onFileNameNote(live({ upcomingAppointments: [row("", "2026-09-21T15:00:00Z")] }), BOOK)).toBeNull();
    expect(onFileNameNote(live(null), BOOK)).toBeNull();
  });

  it("no 'another' clause where the business blocks a second booking, or cannot book", () => {
    const block = { ...BOOKING, capabilities: { appointments: { existingAppointment: "block" } } };
    expect(onFileNameNote(live(one, block), BOOK)).not.toMatch(/another/);
    expect(onFileNameNote(live(one, { allowedTasks: ["take_message"] }), BOOK)).not.toMatch(/another/);
  });

  it("services/tools.js hands it as the reply's message; the cascade's reply is unchanged", async () => {
    const fc = { id: "fc1", name: "set_call_intent", args: { intent: "book_appointment" } };
    const onLive = await executeToolCall(fc, live(one));
    expect(onLive.functionResponse.response).toEqual({ success: true, message: onFileNameNote(live(one), BOOK) });
    const cascade = await executeToolCall(fc, { callerContext: one, config: BOOKING });
    expect(cascade.functionResponse.response).toEqual({ success: true });
  });
});

// Both ends real (memory: a test proves a wire only if both ends are real):
// the call-start snapshot through a Live session into the reply the model gets.
describe("Part 6: the wire, through a real Live session", () => {
  beforeAll(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
  });
  afterAll(() => vi.useRealTimers());

  it("the caller's snapshot reaches set_call_intent's reply", async () => {
    const config = {
      businessName: "VetraTD Test Line",
      greeting: "Thanks for calling the VetraTD test line.",
      mainPhone: "+18175803291",
      timezone: "America/Chicago",
      locale: "en-US",
      allowedTasks: ["book_appointment", "check_appointment"],
      afterHoursPolicy: "take_message",
      capabilities: { appointments: { enabled: true, adapter: "internal" } },
    };
    const s = await bootLive({
      config,
      callSid: "CA_p6_onfile_wire",
      database: { ...fakeDb(config, "biz-1"), fetchCallerContext: async () => ({ callCount: 3, lastCallSummary: null, ...one }) },
    });
    await s.callerSays("I'd like to book another appointment for myself.");
    const [r] = await s.callTool("set_call_intent", { intent: "book_appointment" });
    expect(r.response.success).toBe(true);
    expect(String(r.response.message)).toMatch(/On this caller's record: Ada Moss\./);
  });
});
