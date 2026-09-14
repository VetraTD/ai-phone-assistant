import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import appointments from "../capabilities/appointments.js";
import { makeFakeDeps } from "../lib/harness/fakeDeps.js";
import { WEEKLY_HOURS } from "./fixtures/businessConfigs.js";

// ---------------------------------------------------------------------------
// THE SENTENCE THAT SAYS A THING HAPPENED SHOULD COME FROM THE THING HAPPENING.
//
// On the Live path the model produces audio directly -- there is no text step
// to inspect before the caller hears it -- and it speaks and calls tools in
// parallel. So any sentence it authors about a write is a GUESS until the write
// returns. It has guessed wrong on four of six real calls:
//
//   CAf1d6447d34  "Your free strategy call is now booked"   spoken 11ms BEFORE
//                                                           the tool call, which
//                                                           was refused. No row.
//   CA327945c3    "I've gone ahead and cancelled your ..."   cancel_appointment_db
//                                                           was never called at all.
//   CA163f2fe4    "I have you all set"                       7s before the write;
//                                                           being refused at the time.
//   CA570f3e65    "I have you down for Tuesday ..."          had to retract it out loud.
//
// Two of those were flatly false to the caller.
//
// The fix is not another guard. Every guard so far answers "may this write
// proceed?", and today's gate collision is what happens when two of those are
// each correct and jointly wrong. This answers a different question -- "what do
// we say about what already happened" -- and it takes a decision AWAY from the
// model rather than adding a rule it has to satisfy.
//
// MECHANISM: the `callerSafe` message on the tool result, which already exists
// and which the refusal paths already use. It rides a round trip that happens
// anyway, so it costs no latency. What it CANNOT give is word-for-word
// determinism -- speakLine on this path asks the model to say a line rather
// than synthesising it, so the model may still paraphrase. What it does give,
// and the part that matters, is that the sentence only EXISTS once the row
// does. It cannot announce a booking that never happened.
// ---------------------------------------------------------------------------

const CONFIG = {
  businessName: "Brightwork Family Dental",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  businessHours: WEEKLY_HOURS,
  locale: "en-US",
  allowedTasks: ["book_appointment", "check_appointment", "cancel_reschedule"],
  capabilities: {
    appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } },
  },
};

// Monday 7 September 2026, 2 PM Chicago -- inside WEEKLY_HOURS and after the
// frozen clock, so validateBookingTime's branches all pass.
const SLOT = "2026-09-07T14:00:00";
// The same instant as SLOT, in the shape the DATABASE stores: a UTC ISO string.
// A naive datetime in a fixture parses against whatever zone the runner is in,
// which makes the assertion about the test environment rather than the code.
const SLOT_UTC = "2026-09-07T19:00:00Z";
const CLIENT = "Marcus Bell";

const ctxFor = (deps, extra = {}) => ({
  businessId: "b1",
  config: CONFIG,
  integrations: [],
  callerPhone: "+15551234567",
  deps,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the booking confirmation is built from the row, not from the model", () => {
  it("hands back a caller-safe sentence naming the time that was actually saved", async () => {
    const { deps, store } = makeFakeDeps({ seedAppointments: [], slotCapacity: 1 });

    const res = await appointments.execute(
      { id: "1", name: "book_appointment", args: { scheduled_at: SLOT, client_name: CLIENT } },
      ctxFor(deps)
    );

    // The row exists. Everything below is about what the caller is told.
    expect(store.scheduled()).toHaveLength(1);

    const toolResult = res.stateEffects.toolResult;
    expect(toolResult.success).toBe(true);
    // callerSafe marks the one string that may reach the caller. Without it the
    // session falls through to whatever the model decides to say.
    expect(toolResult.callerSafe).toBe(true);
    // Spoken, not an ISO string: a stored datetime read aloud is how a 2 PM
    // Chicago appointment becomes "7 PM".
    expect(toolResult.message).not.toContain(SLOT);
    // The time the caller agreed to, in words.
    expect(toolResult.message).toMatch(/2[:\s]?00\s*PM|2\s*PM/i);
    expect(toolResult.message).toMatch(/September|Monday/i);
  });

  it("says nothing confirmatory when the booking did not happen", async () => {
    // Capacity 1 and the slot already taken: the write fails for a real reason.
    // The slot comes back full. Forced at the dep rather than by seeding an
    // overlapping row, because the seed's naive datetime and the anchored one
    // the pack writes are not the same string and the overlap arithmetic then
    // tests the fixture rather than the behaviour.
    const { deps, store } = makeFakeDeps({ seedAppointments: [], slotCapacity: 1 });
    const fullDeps = { ...deps, createAppointmentIfAvailable: async () => ({ full: true }) };

    const res = await appointments.execute(
      { id: "2", name: "book_appointment", args: { scheduled_at: SLOT, client_name: CLIENT } },
      ctxFor(fullDeps)
    );

    expect(store.scheduled()).toHaveLength(0);
    const toolResult = res.stateEffects.toolResult;
    expect(toolResult.success).toBe(false);
    // THE WHOLE POINT. A failed write must not produce a sentence that reads as
    // a confirmation -- that is the class of defect this exists to close.
    expect(toolResult.message).not.toMatch(/\bbooked\b|\ball set\b|\bconfirmed\b/i);
  });
});

describe("the cancellation confirmation is built from the row it changed", () => {
  it("names the appointment that was actually cancelled", async () => {
    const { deps, store } = makeFakeDeps({
      seedAppointments: [
        {
          id: "appt-1",
          business_id: "b1",
          client_phone: "+15551234567",
          scheduled_at: SLOT,
          client_name: CLIENT,
          status: "scheduled",
        },
      ],
      slotCapacity: 1,
    });

    // The pack reaches its appointment through a lookup that sets
    // selectedAppointmentId, so the lookup runs first exactly as on a call.
    await appointments.execute({ id: "l", name: "get_caller_appointments_from_db", args: {} }, ctxFor(deps));

    // A real call has this: fetchCallerContext runs at call start and the
    // snapshot is what the pack reads to know WHICH appointment a caller means.
    const res = await appointments.execute(
      { id: "3", name: "cancel_appointment_db", args: { appointment_id: "appt-1" } },
      ctxFor(deps, {
        selectedAppointmentId: "appt-1",
        callerContext: {
          upcomingAppointments: [{ id: "appt-1", scheduled_at: SLOT_UTC, client_name: CLIENT }],
        },
      })
    );

    expect(store.scheduled()).toHaveLength(0);

    const toolResult = res.stateEffects.toolResult;
    expect(toolResult.success).toBe(true);
    expect(toolResult.callerSafe).toBe(true);
    // Specific, not "That appointment has been cancelled." A caller with two
    // appointments cannot tell which one that sentence refers to.
    expect(toolResult.message).toContain("2:00 PM");
    expect(toolResult.message).toMatch(/September/i);
  });
});
