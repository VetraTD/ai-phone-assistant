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
          response: { success: true, available: true, open_times: [SLOT] },
        },
        stateEffects: { toolResult: { name: fc.name, success: true, message: "free" } },
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
          { capability: "appointments", type: "booked", data: { id: "appt-new", client_name: "John" } },
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
      env: {},
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
    /** The model claims the booking is done, having called nothing. */
    async claim(text = CLAIM) {
      live.push({ serverContent: { outputTranscription: { text } } });
      await settle();
      live.push({ serverContent: { turnComplete: true } });
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

  it("accepts a name that is on the caller's own records even if the transcript lost it", async () => {
    // The transcript here is a DEGRADED COPY -- 2,480 ms of speech has logged
    // as zero characters -- so the caller's existing rows are the second
    // independent source, and on LVX114 the caller had one.
    const s = await boot({
      callerContext: { upcomingAppointments: [{ client_name: "John", scheduled_at: SLOT }] },
    });
    await s.offerTimes();
    await s.quietTurn("");
    await s.claim();

    expect(s.bookCalls()).toHaveLength(1);
    expect(c().claim_completed_in_code).toBe(1);
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
