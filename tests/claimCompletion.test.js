import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX114. MAKE THE CLAIM TRUE.
//
// Call CAbdff67b2:
//
//   01:10:47  offers Monday Sept 14 at 9 AM / 1 PM / 4:30 PM
//   01:11:03  "that's 469-933-8887? And what name should I book that under?"
//   01:11:15  "Thanks, John. So, we're all set for Monday, September 14th, at 1 PM"
//   01:12:45  cancel_appointment_db  success=TRUE
//
// book_appointment was never called. booked_rows=0. The caller hung up
// believing he had a Monday appointment, and having lost the real Friday one he
// arrived with.
//
// Both essential fields were recoverable at 01:11:15: the slot from
// guards.js verifiedSlots, which a real availability call had filled thirty
// seconds earlier, and the name from the fabricating sentence itself.
//
// What is asserted here is the WIRING and the REFUSALS. The wiring, because
// that is the part that can silently not exist -- the hesitation gate sat
// unreachable for the life of a deployment with its counter reading 0
// throughout. The refusals, because a path that can originate a booking must be
// provably unable to originate one nobody checked.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function fakeLive() {
  const sent = { clientContent: [], toolResponses: [] };
  let onmessage = null;
  const session = {
    sendRealtimeInput: () => {},
    sendClientContent: (m) => sent.clientContent.push(m),
    sendToolResponse: (m) => sent.toolResponses.push(m),
    close: () => {},
  };
  return {
    sent,
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return { session, languagePinned: true, surface: "aistudio", model: "m" };
    }),
    push: (msg) => onmessage?.(msg),
  };
}

const CONFIG = {
  businessName: "Brightwork Studio",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  locale: "en-US",
  allowedTasks: ["book_appointment", "general_question"],
  capabilities: { appointments: { enabled: true } },
  businessHours: {},
};

/** The 1 PM slot the availability call returned on the real call. */
const SLOT = "2026-09-14T13:00:00";
/** Naive local, minute precision -- what guards.js stores and the booking gets. */
const SLOT_KEY = "2026-09-14T13:00";
/**
 * A SECOND verified time on the same day.
 *
 * Load-bearing rather than scenery: without it, a claim naming 4:30 resolves to
 * null because the time was never verified, which is indistinguishable from a
 * claim naming a time that simply is not the one booked. Only a second VERIFIED
 * slot tests the discriminator that actually exists.
 */
const SLOT_OTHER = "2026-09-14T16:30";
/** Verbatim from the call, and the sentence the whole feature exists for. */
const CLAIM = "Thanks, John. So, we're all set for Monday, September 14th, at 1 PM";
/**
 * A claim that NAMES the act.
 *
 * The difference from CLAIM above is the whole reason both exist. "we're all
 * set" carries no verb, so it can only be recognised as a booking by the slot
 * it names -- and where there is no verified slot it stays `unspecified` and
 * keeps the note that has always fired for it. "I've booked you in" says what
 * it is, so it reaches the ladder even when nothing can be recovered, which is
 * what these cases are about.
 */
const NAMED_CLAIM = "Thanks, John. I've booked you in for Monday, September 14th, at 1 PM";

function fakeDb(callerContext = null) {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: "biz-1", name: CONFIG.businessName }),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => callerContext,
  };
}

/**
 * Answers availability truthfully and books whatever it is given.
 *
 * It does NOT police the slot, deliberately: the availability invariant in
 * lib/voice/live/guards.js is what must refuse an unverified time, and a fake
 * that refused as well would hide whether the real guard ever ran.
 */
function executor({ bookFails = false } = {}) {
  const calls = [];
  const execute = vi.fn(async (fc) => {
    calls.push(fc);
    if (fc.name === "check_appointment_availability") {
      return {
        functionResponse: {
          id: fc.id,
          name: fc.name,
          response: { success: true, available: true, open_times: [SLOT, SLOT_OTHER] },
        },
        stateEffects: { toolResult: { name: fc.name, success: true, message: "free" } },
      };
    }
    if (fc.name === "cancel_appointment_db") {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
        stateEffects: {
          toolResult: { name: fc.name, success: true, message: "cancelled" },
          capabilityEffects: [
            {
              capability: "appointments",
              type: "changed",
              data: { tool: fc.name, appointmentId: fc.args?.appointment_id || "appt-old" },
            },
          ],
        },
      };
    }
    if (bookFails) {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: "slot gone" } },
        stateEffects: { toolResult: { name: fc.name, success: false, message: "slot gone" } },
      };
    }
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      stateEffects: {
        toolResult: { name: fc.name, success: true, message: "booked" },
        capabilityEffects: [
          {
            capability: "appointments",
            type: "booked",
            data: {
              id: "appt-new",
              client_name: "John",
              // The ROW's form: an absolute instant, not the naive local string
              // the model handed in. 13:00 America/Chicago in September is CDT,
              // UTC-5. Written this way on purpose -- the ledger has to put it
              // through the guards' own normalisation to compare with a slot
              // key, and a naive fixture would skip the step that can be wrong.
              scheduled_at: "2026-09-14T18:00:00.000Z",
            },
          },
        ],
      },
    };
  });
  return { execute, calls };
}

async function boot(opts = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const { execute, calls } = executor(opts);
  await handleLiveSessionConnection(
    ws,
    {},
    {
      now: () => 0,
      connect: live.connect,
      database: fakeDb(opts.callerContext || null),
      env: opts.env || {},
      execute,
    }
  );
  ws.deliver({
    event: "start",
    start: {
      callSid: "CA_claim",
      streamSid: "MZ1",
      // callerPhone, or fetchCallerContext is never called and callerContext is
      // null -- which silently removes the second name-provenance source.
      customParameters: { businessPhone: "+18176011171", callerPhone: "+14699338887" },
    },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  // A tool round is genuinely asynchronous and onToolCall is fire-and-forget,
  // so there is nothing to await from outside. See tests/liveWriteRetry.test.js:
  // two setTimeout(0)s were not enough, and the failure reads exactly like a
  // broken wire.
  const settle = () => new Promise((r) => setTimeout(r, 25));

  return {
    live,
    calls,
    bookCalls: () => calls.filter((f) => f.name === "book_appointment"),
    /** A real availability call, which is the only thing that fills verifiedSlots. */
    async offerTimes() {
      live.push({
        toolCall: {
          functionCalls: [{ id: "a", name: "check_appointment_availability", args: { requested_at: SLOT } }],
        },
      });
      await settle();
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
    },
    /**
     * An ordinary turn with no tools in it.
     *
     * Load-bearing rather than scene-setting: the claim guard looks back one
     * turn, so the availability call has to stop being "last turn" before a
     * claim can be unbacked. On the real call this is the assistant asking for
     * the number and the name.
     */
    async quietTurn(callerText = "It's John") {
      live.push({ serverContent: { inputTranscription: { text: callerText } } });
      await settle();
      live.push({ serverContent: { outputTranscription: { text: "And what name should I book that under?" } } });
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
    },
    /**
     * The model cancels the caller's existing appointment.
     *
     * Load-bearing for LVX119: a successful cancel rewrites the caller snapshot
     * through onEffect, and the name on it goes with it.
     */
    async cancel(id = "appt-old") {
      live.push({
        toolCall: {
          functionCalls: [{ id: "c", name: "cancel_appointment_db", args: { appointment_id: id } }],
        },
      });
      await settle();
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
    },
    /** The model books properly, the way it is supposed to. */
    async modelBooks(args) {
      live.push({
        toolCall: {
          functionCalls: [
            {
              id: "b",
              name: "book_appointment",
              args: args || { client_name: "John", scheduled_at: SLOT },
            },
          ],
        },
      });
      await settle();
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
    },
    /** The model claims the booking is done, having called nothing. */
    async claim(text = CLAIM) {
      live.push({ serverContent: { outputTranscription: { text } } });
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
      await settle();
    },
    /** One assistant turn, whatever the claim predicate makes of it. */
    async say(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
      await settle();
    },
    /** The caller hangs up, which is what runs finish() and the sweep. */
    async hangUp() {
      ws.deliver({ event: "stop" });
      await settle();
      await settle();
      await settle();
    },
    spoken: () => live.sent.clientContent.map((m) => m.turns?.[0]?.parts?.[0]?.text || ""),
  };
}

const c = () => getLatencyStats().turnTaking;

// The clock is pinned for the reason tests/whichAppointment.test.js records: a
// fixture date that passes turns ten tests red mid-session. 2026-09-04 sits
// before every date in this file.
const FROZEN_NOW = new Date("2026-09-04T12:00:00Z");

beforeAll(() => {
  // shouldAdvanceTime, not a bare useFakeTimers(): these settle async work with
  // a real setTimeout, and a frozen timer queue hangs the run instead of
  // failing it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => clearStats());

describe("completing a fabricated booking", () => {
  it("LVX114: books the slot the caller was told, without being asked to", async () => {
    const s = await boot();
    await s.offerTimes();
    await s.quietTurn();
    await s.claim();

    const booked = s.bookCalls();
    expect(booked).toHaveLength(1);
    // THE TIME THE CALLER HEARD, not one the model named unchecked.
    expect(booked[0].args.scheduled_at).toBe(SLOT_KEY);
    expect(booked[0].args.client_name).toBe("John");
    expect(c().claim_completed_in_code).toBe(1);
  });

  it("the write goes through the availability invariant, which allows it", async () => {
    const s = await boot();
    await s.offerTimes();
    await s.quietTurn();
    await s.claim();

    // Proof the booking took the guarded path rather than going around it.
    expect(c().live_guard_availability_allowed).toBeGreaterThan(0);
    expect(c().live_guard_availability_blocked).toBe(0);
  });

  it("says NOTHING when it works", async () => {
    // The model already told the caller the right thing. A note here invites it
    // to say the same sentence again -- call 6 repeated one verbatim 43 ms
    // after a note -- and there is nothing left to correct.
    const s = await boot();
    await s.offerTimes();
    await s.quietTurn();
    await s.claim();

    const said = s.spoken().join(" ");
    expect(said).not.toMatch(/no tool has run/);
    expect(said).not.toMatch(/Before I finish/);
    expect(c().claim_confirm_asked).toBe(0);
  });

  it("promotes an unspecified claim to a booking because it named a verified slot", async () => {
    // "we're all set" carries no verb, so the action probes cannot classify it.
    // The slot is what identifies it as a booking confirmation.
    const s = await boot();
    await s.offerTimes();
    await s.quietTurn();
    await s.claim();

    expect(c().live_claim_action_from_slot).toBe(1);
  });
});

describe("what it must refuse to complete", () => {
  it("THE SAFETY RULE: will not book a time no availability call returned", async () => {
    const s = await boot();
    // No offerTimes(), so verifiedSlots is empty.
    await s.quietTurn();
    await s.claim(NAMED_CLAIM);

    expect(s.bookCalls()).toHaveLength(0);
    expect(c().claim_completed_in_code).toBe(0);
    expect(c().claim_completion_unrecoverable).toBe(1);
  });

  it("will not book a DIFFERENT time from the one that was verified", async () => {
    const s = await boot();
    await s.offerTimes();
    await s.quietTurn();
    await s.claim("Thanks, John. I've booked you in for Monday, September 14th, at 2 PM");

    expect(s.bookCalls()).toHaveLength(0);
    expect(c().claim_completion_unrecoverable).toBe(1);
  });

  it("will not book under a name the caller was never transcribed saying", async () => {
    // LVX77: a booking retry once wrote "Jane Doe", a name the caller never
    // said, into somebody's diary. A name identifies the row.
    const s = await boot();
    await s.offerTimes();
    await s.quietTurn("I'd like something on Monday");
    await s.claim("Thanks, Jane. So, we're all set for Monday, September 14th, at 1 PM");

    expect(s.bookCalls()).toHaveLength(0);
    expect(c().claim_completion_unrecoverable).toBe(1);
  });

  it("LVX119: a cancellation must not destroy the name that authorises the re-booking", async () => {
    // From the call of 2026-09-11. The caller cancelled their only appointment
    // and then booked a new one. By the time the booking claim arrived, the
    // live snapshot was empty, the name on it was gone, and the completion was
    // refused for name_provenance -- on a caller who had just SPELLED their
    // name, and whose 2,880 ms of spelling reached the transcript as four
    // characters.
    const s = await boot({
      callerContext: {
        upcomingAppointments: [{ id: "appt-old", client_name: "John", scheduled_at: SLOT_OTHER }],
      },
    });
    await s.offerTimes();
    await s.cancel("appt-old");
    // The transcript never carries the name -- exactly as on the real call.
    await s.quietTurn("");
    await s.claim();

    expect(s.bookCalls()).toHaveLength(1);
    expect(s.bookCalls()[0].args.client_name).toBe("John");
    expect(c().claim_completed_in_code).toBe(1);
    expect(c().claim_completion_unrecoverable).toBe(0);
  });

  it("accepts a name that is on the caller's own records even if the transcript lost it", async () => {
    // The transcript here is a DEGRADED COPY -- 2,480 ms of speech has logged
    // as zero characters -- so the caller's existing rows are the second
    // independent source, and on LVX114 the caller had one.
    const s = await boot({
      // A DIFFERENT time from the one being claimed. The caller holding an
      // appointment at the very hour the claim names would make that sentence a
      // report of what they already had, not a claim this call booked anything
      // -- which is LVX120, and is what this fixture used to describe by
      // accident.
      callerContext: {
        upcomingAppointments: [{ client_name: "John", scheduled_at: SLOT_OTHER }],
      },
    });
    await s.offerTimes();
    await s.quietTurn("");
    await s.claim();

    expect(s.bookCalls()).toHaveLength(1);
    expect(c().claim_completed_in_code).toBe(1);
  });
});

describe("a claim the call has already made true", () => {
  // THE CALL OF 2026-09-11, and the defect this whole block exists for.
  //
  //   03:50:38  book_appointment            success
  //   03:50:59  "We have your strategy call scheduled for Tuesday, September
  //              15th at 4 30pm. Does that work?"     <- TRUE
  //   03:51:02  "Before I finish - can I just confirm the time with you?"
  //   03:51:39  "Just to clarify, the appointment wasn't booked yet."  <- FALSE
  //
  // The guard looks back one turn; the booking was two turns back. So it fired
  // on a true sentence, the ladder asked the caller about an appointment they
  // already had, and the note then made the assistant deny a row that existed.
  it("says nothing when a booking earlier in the call already backs it", async () => {
    const s = await boot();
    await s.offerTimes();
    // The model books it properly...
    await s.modelBooks();
    // ...then two quiet turns pass, putting the write out of the look-back...
    await s.quietTurn();
    // ...and then it describes the booking it really did make.
    await s.claim("We have your strategy call scheduled for Monday, September 14th at 1 PM. Does that work?");

    const said = s.spoken().join(" ");
    expect(said).not.toMatch(/Before I finish/);
    expect(said).not.toMatch(/no tool has run/);
    expect(c().live_claim_backed_this_call).toBe(1);
    expect(c().claim_confirm_asked).toBe(0);
    // Exactly one booking: the model's own. Nothing was re-issued.
    expect(s.bookCalls()).toHaveLength(1);
  });

  it("but STILL catches a claim about a different time", async () => {
    // Books Monday 1 PM, then claims a 4:30 booking that never happened. The
    // tool matches; the time does not. Silence here would be the new blind spot.
    const s = await boot();
    await s.offerTimes();
    await s.modelBooks();
    await s.quietTurn();
    await s.claim("We have your strategy call scheduled for Monday, September 14th at 4 30pm. Does that work?");

    expect(c().live_claim_backed_this_call).toBe(0);
  });
});

describe("the ladder", () => {
  it("asks the caller plainly when the time cannot be verified", async () => {
    const s = await boot();
    await s.quietTurn();
    await s.claim(NAMED_CLAIM);

    const said = s.spoken().join(" ");
    expect(said).toMatch(/Before I finish/);
    expect(said).toMatch(/confirm the time/);
    expect(c().claim_confirm_asked).toBe(1);
  });

  it("asks about the NAME when the name is what failed", async () => {
    const s = await boot();
    await s.offerTimes();
    await s.quietTurn("I'd like something on Monday");
    await s.claim("Thanks, Jane. So, we're all set for Monday, September 14th, at 1 PM");

    const said = s.spoken().join(" ");
    expect(said).toMatch(/take the name for the booking/);
    expect(c().claim_confirm_asked).toBe(1);
  });

  it("never tells the caller anything went wrong", async () => {
    // LVX105 deleted a line that asked for an apology, and LVX98 is six of them
    // in a row. The caller has been told they are booked and they are about to
    // be; there is nothing to apologise for.
    const s = await boot();
    await s.quietTurn();
    await s.claim(NAMED_CLAIM);

    const said = s.spoken().join(" ");
    expect(said).not.toMatch(/sorry|didn't go through|not gone through|trouble|wrong/i);
  });

  it("asks at most once per call", async () => {
    // A nudge that can repeat is the shape that made the leak guard destroy a
    // call (LVX21).
    const s = await boot();
    await s.quietTurn();
    await s.claim(NAMED_CLAIM);
    await s.quietTurn();
    await s.claim(NAMED_CLAIM);

    expect(c().claim_confirm_asked).toBe(1);
  });

  it("falls back to the existing note for a claim it cannot complete", async () => {
    // A cancellation claim is declared but deliberately not completable:
    // completing a false claim about a cancel would destroy a real row. The
    // guard that exists today must still fire for it.
    const s = await boot();
    await s.quietTurn();
    await s.claim("That appointment has been cancelled.");

    expect(s.spoken().join(" ")).toMatch(/no tool has run/);
    expect(c().claim_confirm_asked).toBe(0);
  });

  it("an unspecified claim with nothing verified keeps the note it always had", async () => {
    // "we're all set" names no act, and with no availability call there is no
    // slot to identify it as a booking either. Nothing here can tell what was
    // claimed, so the guard that exists today is the right response and this
    // path must not quietly replace it. Rung three still catches it after the
    // call: no matching write means verdict claim_without_row, which writes a
    // customer_requests row and notifies the business.
    const s = await boot();
    await s.quietTurn();
    await s.claim();

    expect(s.bookCalls()).toHaveLength(0);
    expect(s.spoken().join(" ")).toMatch(/no tool has run/);
    expect(c().claim_confirm_asked).toBe(0);
  });

  it("a refused write asks about the name rather than going quiet", async () => {
    const s = await boot({ bookFails: true });
    await s.offerTimes();
    await s.quietTurn();
    await s.claim();

    expect(s.bookCalls()).toHaveLength(1);
    expect(c().claim_completion_refused).toBe(1);
    expect(c().claim_completed_in_code).toBe(0);
    expect(s.spoken().join(" ")).toMatch(/Before I finish/);
  });
});

// ---------------------------------------------------------------------------
// LVX120. THE END-OF-CALL SWEEP.
//
// The call of 2026-09-11 05:36-05:38, verbatim:
//
//   05:36:57  cancel_appointment_db          SUCCESS
//   05:37:21  check_appointment_availability SUCCESS  (16 slots)
//   05:37:37  "That's Tuesday, September 15th at 4 30 PM. Could you tell me
//              your full name, please?"
//   05:38:01  "Thanks, Nithin Dodla, and what's the best number to call you
//              back on?"
//   05:38:18  "Your new appointment is on Tuesday, September 15th at 4 30 PM."
//   05:38:24  end_call
//
// book_appointment was NEVER CALLED. booked_rows=0. The caller cancelled a real
// appointment and left with nothing.
//
// The claim predicate never matched that last sentence -- "your NEW appointment"
// puts an adjective between the determiner and the noun, and "is on" is
// locative rather than a completion verb -- so the mid-call completion was never
// even consulted. That is the fourth phrasing in two weeks to defeat it.
//
// The sweep does not read the phrasing. It asks which verified slot the call
// named, which is a bounded question with sixteen candidates.
// ---------------------------------------------------------------------------
describe("the end-of-call sweep", () => {
  it("LVX120: books what the call promised and never wrote", async () => {
    const s = await boot({
      callerContext: {
        upcomingAppointments: [{ id: "appt-old", client_name: "John", scheduled_at: SLOT_OTHER }],
      },
    });
    await s.offerTimes();
    await s.cancel("appt-old");
    // The name arrives on its own turn, as it did on the call -- "Thanks,
    // Nithin Dodla, and what's the best number to call you back on?"
    await s.say("Thanks, John. And what's the best number to call you back on?");
    // Then the phrasing that defeated the predicate. It names the slot, and
    // nothing else about it is recognisable as a claim.
    await s.say("Your new appointment is on Monday, September 14th at 1 PM.");
    await s.hangUp();

    const booked = s.bookCalls();
    expect(booked).toHaveLength(1);
    expect(booked[0].args.scheduled_at).toBe(SLOT_KEY);
    expect(booked[0].args.client_name).toBe("John");
    expect(c().sweep_booked_at_close).toBe(1);
  });

  it("does nothing when the call already booked", async () => {
    const s = await boot();
    await s.offerTimes();
    await s.modelBooks();
    await s.say("You're all set for Monday, September 14th at 1 PM.");
    await s.hangUp();

    // The model's own booking, and no second one.
    expect(s.bookCalls()).toHaveLength(1);
    expect(c().sweep_booked_at_close).toBe(0);
  });

  it("THE BROWSING GUARD: three times on the table is not a promise", async () => {
    // The condition that does the work a consent check cannot do here. A caller
    // offered "9 AM, 1 PM, or 4 30 PM" who hangs up to think has options open,
    // not an appointment. matchClaimSlot refuses on ambiguity.
    const s = await boot();
    await s.offerTimes();
    await s.say("We have Monday, September 14th at 9 AM, 1 PM, or 4 30 PM. Which suits you?");
    await s.hangUp();

    expect(s.bookCalls()).toHaveLength(0);
    expect(c().sweep_booked_at_close).toBe(0);
  });

  it("THE SAFETY RULE: will not book a time no availability call returned", async () => {
    const s = await boot();
    // No offerTimes(), so verifiedSlots is empty.
    await s.say("Your new appointment is on Monday, September 14th at 1 PM.");
    await s.hangUp();

    expect(s.bookCalls()).toHaveLength(0);
    expect(c().sweep_booked_at_close).toBe(0);
  });

  it("will not book under a name the caller cannot be shown to have given", async () => {
    // LVX77. No caller records, and the transcript never carried the name.
    const s = await boot();
    await s.offerTimes();
    await s.quietTurn("I'd like something Monday");
    await s.say("Thanks, Jane. Your new appointment is on Monday, September 14th at 1 PM.");
    await s.hangUp();

    expect(s.bookCalls()).toHaveLength(0);
    expect(c().sweep_declined_no_name).toBe(1);
  });

  it("stops when the caller said no", async () => {
    const s = await boot({
      callerContext: {
        upcomingAppointments: [{ id: "appt-old", client_name: "John", scheduled_at: SLOT_OTHER }],
      },
    });
    await s.offerTimes();
    await s.say("Thanks, John. And what's the best number to call you back on?");
    await s.quietTurn("Actually, never mind — I'll call back.");
    await s.say("Your new appointment is on Monday, September 14th at 1 PM.");
    await s.hangUp();

    expect(s.bookCalls()).toHaveLength(0);
    expect(c().sweep_declined_caller_said_no).toBe(1);
  });

  it("does not re-book a time the caller ALREADY had", async () => {
    // Reporting an existing appointment on the way out is not a promise.
    const s = await boot({
      callerContext: {
        upcomingAppointments: [{ id: "appt-old", client_name: "John", scheduled_at: SLOT }],
      },
    });
    await s.offerTimes();
    await s.say("You still have your appointment on Monday, September 14th at 1 PM.");
    await s.hangUp();

    expect(s.bookCalls()).toHaveLength(0);
    expect(c().sweep_booked_at_close).toBe(0);
  });

  it("LIVE_BOOKING_SWEEP=off disables it without a deploy", async () => {
    const s = await boot({
      env: { LIVE_BOOKING_SWEEP: "off" },
      callerContext: {
        upcomingAppointments: [{ id: "appt-old", client_name: "John", scheduled_at: SLOT_OTHER }],
      },
    });
    await s.offerTimes();
    await s.cancel("appt-old");
    await s.say("Your new appointment is on Monday, September 14th at 1 PM.");
    await s.hangUp();

    expect(s.bookCalls()).toHaveLength(0);
    expect(c().sweep_booked_at_close).toBe(0);
  });
});

describe("a report of an existing appointment is not a claim", () => {
  it("LVX120: naming the appointment the caller arrived with demands no write", async () => {
    // Verbatim from the call: "I see you have an appointment scheduled for
    // Monday, September 14th at 4 30 PM" -- read off a lookup, entirely true,
    // and counted as an unsatisfied booking claim.
    const s = await boot({
      callerContext: {
        upcomingAppointments: [{ id: "appt-old", client_name: "John", scheduled_at: SLOT }],
      },
    });
    await s.offerTimes();
    await s.quietTurn();
    await s.claim("I see you have an appointment scheduled for Monday, September 14th at 1 PM.");

    expect(c().live_claim_reported_existing).toBe(1);
    // Demoted, so it demands no booking write of its own.
    expect(s.bookCalls()).toHaveLength(0);
  });

  it("but a NEW verified slot is still a claim about this call", async () => {
    const s = await boot({
      callerContext: {
        upcomingAppointments: [{ id: "appt-old", client_name: "John", scheduled_at: SLOT_OTHER }],
      },
    });
    await s.offerTimes();
    await s.quietTurn();
    await s.claim("We're all set for Monday, September 14th, at 1 PM");

    expect(c().live_claim_reported_existing).toBe(0);
    expect(c().live_claim_action_from_slot).toBe(1);
  });
});
