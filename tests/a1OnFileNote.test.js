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
    // LVX188: an on-file name is a question, never assumed.
    expect(onFileNameNote(live(one), BOOK)).toContain('Am I speaking with Ada Moss?');
    expect(note).not.toMatch(/that is their name/);
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

// LVX188 (calls, 2026-11): an on-file name is a question, never assumed. The
// record can belong to someone else on a shared phone, so the caller confirms it.
describe("LVX188: an on-file name is asked, never assumed", () => {
  const jd = { upcomingAppointments: [row("Jonathan Daniel", "2030-01-15T15:00:00Z")] };

  it("single name: ask once 'Am I speaking with <name>?', then use it; no 'that is their name'", () => {
    const note = onFileNameNote(live(jd), BOOK);
    expect(note).toContain(
      "[not caller speech] On this caller's record: Jonathan Daniel. That may not be who is calling. " +
        'Before using it, ask once: "Am I speaking with Jonathan Daniel?" If yes, use it exactly as written: ' +
        "do not ask for it again, do not ask them to spell it, and do not spell it back. If no, ask for their name."
    );
    expect(note).not.toMatch(/that is their name/);
    expect(note).not.toMatch(/Do not ask for their name/);
  });

  it("single name with another booking allowed: the 'another' clause is still appended", () => {
    const note = onFileNameNote(live(jd), BOOK);
    expect(note.endsWith(" If they ask for another or one more appointment, it is an extra booking: do not ask whether they want to move or reschedule one they already have, do not list the ones they already have, and book it with in_addition_to_existing set to true -- that extra booking only, never a change to one already booked.")).toBe(true);
  });

  it("protocol step 1 asks once and never assumes the on-record name", async () => {
    const { buildStaticSystemPrefix } = await import("../services/gemini.js");
    const { FIXTURES } = await import("./fixtures/businessConfigs.js");
    const { config, extras } = FIXTURES["messages-only"];
    // Healthcare tier: the old scripted line, byte for byte.
    const hipaa = buildStaticSystemPrefix({ ...config, complianceTier: "hipaa" }, extras);
    expect(hipaa).toContain(
      'If a name is on their record from an earlier call, it may not be who is calling: ask once "Am I speaking with <name>?" If yes, use it and do not ask them to spell it. If no, ask for their name.'
    );
    // Standard tier (Task 3): the same rule, described rather than scripted.
    const text = buildStaticSystemPrefix(config, extras);
    expect(text).toContain("use it only to confirm once, and only when the caller has not given a name");
    expect(text).toContain("never ask them to spell a confirmed on-file name");
    for (const t of [text, hipaa]) {
      expect(t).not.toContain("you have it right already");
      expect(t).not.toContain("that is their name");
    }
  });

  it("caller context names are flagged as possibly someone else's until confirmed", async () => {
    const { buildDynamicTail } = await import("../services/gemini.js");
    const { FIXTURES } = await import("./fixtures/businessConfigs.js");
    const f = FIXTURES["appointments-db"];
    const tail = buildDynamicTail("identify_intent", null, f.config, {
      ...f.extras,
      callerContext: { callCount: 1, upcomingAppointments: [row("Jonathan Daniel", "2030-01-15T15:00:00Z")] },
    });
    expect(tail).toContain("Upcoming appointments:");
    expect(tail).toContain(
      "Names below may belong to someone else on this phone. Do not call the caller by any of them until they confirm."
    );
    const bare = buildDynamicTail("identify_intent", null, f.config, {
      ...f.extras,
      callerContext: { callCount: 2, upcomingAppointments: [] },
    });
    expect(bare).not.toContain("Names below may belong");
  });

  // LVX188, Hammersleys round 3 (re-test calls 3 and 4, 2026-11-25): a business
  // with no appointments gets the name only through the last-call summary, and
  // got no caution -- "Thank you, Jane" to a caller who never said it, and an
  // URGENT save with caller_name "Jane" before the caller answered.
  it("a last-call summary carries the same caution, for messages-only businesses too", async () => {
    const { buildDynamicTail } = await import("../services/gemini.js");
    const { FIXTURES } = await import("./fixtures/businessConfigs.js");
    const f = FIXTURES["messages-only"];
    const CAUTION =
      "A name in that last call may belong to someone else on this phone: do not call the caller by it or save it as their name until they say it on this call.";
    const withSummary = buildDynamicTail("identify_intent", null, f.config, {
      ...f.extras,
      callerContext: { callCount: 3, lastCallSummary: "Jane Doe asked for a taxi from Lingfield to Gatwick.", upcomingAppointments: [] },
    });
    expect(withSummary).toContain('Last call: "Jane Doe asked for a taxi from Lingfield to Gatwick."');
    expect(withSummary).toContain(CAUTION);
    const noSummary = buildDynamicTail("identify_intent", null, f.config, {
      ...f.extras,
      callerContext: { callCount: 3, upcomingAppointments: [] },
    });
    expect(noSummary).not.toContain("A name in that last call");
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
