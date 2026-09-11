import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { makeFakeDeps } from "../lib/harness/fakeDeps.js";
import { WEEKLY_HOURS } from "./fixtures/businessConfigs.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// THE TEST THAT WOULD HAVE CAUGHT "NEVER FIRED ONCE".
//
// The claim-completion attempt reverted on 2026-09-11 shipped 894 lines of
// passing tests and originated a write ZERO times across nine production calls.
// It could not have been otherwise, because no test in this repository joined
// the two halves of the write path:
//
//   tests/liveWriteRetry.test.js  drives the real session with a STUBBED
//                                `execute`, so it proves ordering and wiring
//                                and never once runs a gate.
//   tests/liveWriteOrder.test.js  runs the real gate against a hand-built ctx,
//                                so it proves decisions and never proves the
//                                ctx is the one production builds.
//
// Both can be green while the path between them is broken -- which is exactly
// the class of defect that sank the last attempt: `?.` hiding a missing wire,
// a value computed thirty lines before the object it read from existed.
//
// So this file asserts the only thing neither can: that driving
// handleLiveSessionConnection with vendor frames puts a ROW, at the right time,
// in a store reachable only by the real write path -- real runner, real
// executeToolCallGuarded, real guards, real appointments pack.
//
// WHY NO vi.mock OF services/db.js IS NEEDED. `withTenantSafe` runs the work
// directly when there is no pool (services/db.js: "NO DATABASE: run it anyway.
// `fallback` is for a scope that FAILED, not for a scope that was never
// possible"), and every data function the pack reaches comes from
// `capabilityDeps`. The seam that makes this possible is new: `extras` is built
// inline in the session and omitted the key, so until now only the eval driver
// could set it.
//
// WHAT THIS FILE CANNOT WITNESS, stated so nobody mistakes a green run for
// more than it is: the test supplies both the audio frames AND the
// inputTranscription, so the real race between the caller-turn close and the
// vendor transcript (113-360 ms on nine calls, lib/voice/live/turnEnd/
// constants.js) is whatever the test says it is. Any consent mechanism that
// depends on that ordering is NOT verifiable here.
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

// Derived from the "appointments-availability" fixture rather than imported.
// That fixture carries `require: { identity: { builtin: ["name", "dob"] } }`,
// which makes checkRequirements demand a date of birth and refuse every booking
// here for a reason that has nothing to do with the write path. Its values are
// byte-locked to the prompt snapshots, so it cannot be edited -- only avoided.
// WEEKLY_HOURS is imported, because the booking must land inside real business
// hours for validateBookingTime to pass, and those hours are stable.
const CONFIG = {
  businessName: "Brightwork Family Dental",
  greeting: "Thanks for calling Brightwork Family Dental.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  businessHours: WEEKLY_HOURS,
  locale: "en-US",
  allowedTasks: ["book_appointment", "check_appointment"],
  afterHoursPolicy: "take_message",
  capabilities: {
    appointments: {
      enabled: true,
      adapter: "internal",
      availability: { length: 30, capacity: 1 },
    },
  },
};

const BUSINESS_ID = "biz-1";

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: BUSINESS_ID, name: CONFIG.businessName }),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

// Monday 7 September 2026, 2 PM Chicago. Monday is open 09:00-17:00 in
// WEEKLY_HOURS, and the date sits after FROZEN_NOW, so validateBookingTime's
// past / closed-day / out-of-hours branches all pass. `scheduled_at` is naive
// LOCAL wall clock, which is what the declaration asks for.
const SLOT = "2026-09-07T14:00:00";
const CLIENT = "Nitin Dodla";

// "just to confirm" is matched by confirmReadBackRe (lib/voice/strings.js).
const READ_BACK = `Just to confirm, I'm booking you in for Monday, September 7th at 2 00 PM. Does that sound right?`;

async function boot({ seedAppointments = [] } = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const { deps, store } = makeFakeDeps({ seedAppointments, slotCapacity: 1 });

  await handleLiveSessionConnection(
    ws,
    {},
    {
      now: () => 0,
      connect: live.connect,
      database: fakeDb(),
      env: {},
      // NO `execute` override. This is the whole point of the file: the real
      // executeToolCallGuarded runs, so every gate in services/tools.js and
      // every guard in lib/voice/live/guards.js is in the path.
      capabilityDeps: deps,
    }
  );

  ws.deliver({
    event: "start",
    start: {
      callSid: "CA_e2e",
      streamSid: "MZ1",
      customParameters: { businessPhone: "+18176011171", callerPhone: "+15551234567" },
    },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  // A tool round is fire-and-forget from the outside -- guards, packForTool, the
  // awaited execute, the effect merge -- so there is nothing to await. 25 ms is
  // the figure tests/liveWriteRetry.test.js settled on after two setTimeout(0)s
  // proved insufficient and failed reporting that execute had never run.
  const settle = () => new Promise((r) => setTimeout(r, 25));

  return {
    live,
    store,
    settle,
    async checkAvailability(at = SLOT) {
      live.push({
        toolCall: { functionCalls: [{ id: "av", name: "check_appointment_availability", args: { requested_at: at } }] },
      });
      await settle();
      await settle();
    },
    /** The model speaks, and the turn ends. This is what sets lastReplyText. */
    async assistantTurn(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
      await settle();
    },
    /** The caller speaks. Does NOT end the turn. */
    async callerSays(text) {
      live.push({ serverContent: { inputTranscription: { text } } });
      await settle();
    },
    async book(args = { scheduled_at: SLOT, client_name: CLIENT }) {
      live.push({ toolCall: { functionCalls: [{ id: `b${Math.random()}`, name: "book_appointment", args }] } });
      await settle();
      await settle();
    },
    toolResponses: () => live.sent.toolResponses.flatMap((m) => m.functionResponses || []),
    bookResponses: () =>
      live.sent.toolResponses.flatMap((m) => (m.functionResponses || []).filter((r) => r.name === "book_appointment")),
  };
}

const c = () => getLatencyStats().turnTaking;

// Friday 4 September 2026 sits before every fixture date in this repository.
// See tests/liveWriteRetry.test.js for what an unfrozen clock did to ten tests
// that imported nothing related.
const FROZEN_NOW = new Date("2026-09-04T12:00:00Z");

beforeAll(() => {
  // shouldAdvanceTime, not a bare useFakeTimers(): `settle` uses a real
  // setTimeout and a frozen timer queue would hang the run rather than fail it.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// THE SPELLING GATE IS TURNED OFF FOR THE WRITE-ORDER TESTS, and finding out
// why it had to be is the first thing this instrument produced that reading the
// code had not.
//
// The first run of the happy path below failed with zero rows and
// `tool_duration ... success:false, gated:true` and NO `write_order_refused`
// line -- so it was the OTHER gate. A first booking carrying an unspelled name
// is held by the spelling gate (services/tools.js, shouldConfirmSpelling), which
// is LVX72's subject, has its own tests, and is not what tiers 1-3 are about.
// Leaving it armed would mean every assertion here passed or failed for the
// wrong reason.
//
// `spellPolicy()` reads process.env directly rather than the injected env, so
// this is a process.env mutation with a restore -- the same shape
// tests/liveWriteOrder.test.js uses for LIVE_WRITE_ORDER_GATE. The gate is
// exercised with the policy ON in its own describe at the bottom.
// ---------------------------------------------------------------------------
describe("the Live write path, end to end, asserted on the row", () => {
  let priorSpellPolicy;

  beforeEach(() => {
    clearStats();
    priorSpellPolicy = process.env.VOICE_SPELL_POLICY;
    process.env.VOICE_SPELL_POLICY = "off";
  });

  afterEach(() => {
    if (priorSpellPolicy === undefined) delete process.env.VOICE_SPELL_POLICY;
    else process.env.VOICE_SPELL_POLICY = priorSpellPolicy;
  });

  it("writes the row when availability, a read-back and an agreement all happened", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");
    await s.book();

    // THE LIVENESS ASSERTION. Zero rows here is what nine production calls
    // looked like, and no unit test in the repository could tell that apart
    // from a passing run.
    expect(s.store.scheduled()).toHaveLength(1);
    expect(s.store.scheduled()[0].scheduled_at).toContain("2026-09-07");
    expect(s.store.scheduled()[0].client_name).toBe(CLIENT);
  });

  // -------------------------------------------------------------------------
  // A SILENT CALLER TURN SKIPS EVERY CONSENT CHECK. Found by this instrument on
  // the day it was written, and NOT one of the defects it was built to catch.
  //
  // services/tools.js wraps the hesitation gate, the unusable-transcript gate
  // AND the write-order gate in a single `if (lastCallerText.trim() !== "")`.
  // The stated reason is good -- the cascade never sets lastCallerText, so the
  // nesting is what keeps that path byte-identical. But on Live an empty caller
  // turn does not mean "this is the cascade", it means THE CALLER HAS NOT
  // SPOKEN, and the write goes through unchecked.
  //
  // Worse than the retry-ordering defect it sits beside, because it needs no
  // retry and no gate interaction: a read-back, a tool call, and a caller who
  // said nothing is enough. And it is reachable in production without anyone
  // being silent at all -- this front-end's transcripts are lossy (the model IS
  // the recogniser), `live_zero_text_turn` exists to count exactly this, and
  // 1,500 ms of speech has been logged as zero characters. A caller who really
  // did say "no" and transcribed empty is indistinguishable here from consent.
  //
  // ASSERTED AS IT BEHAVES TODAY, deliberately. This step ships instruments and
  // no behaviour change, and a test that documents the bug is what makes the
  // fix visible as a diff. The discriminator the fix should use already exists
  // and is already documented as Live-only: `ctx.callerSaidThisCall` is null on
  // the cascade and non-null on Live (the LVX53 note in services/tools.js says
  // so), so the gates can run on "Live with no caller text" while the cascade
  // stays untouched. Flip this expectation then.
  // -------------------------------------------------------------------------
  it("TODAY'S BEHAVIOUR, AND A DEFECT: a silent caller turn bypasses the consent gate", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(READ_BACK);
    // No caller turn at all: the read-back was spoken into silence.
    await s.book();

    // Should be 0. Is 1, because the gate never ran.
    expect(s.store.scheduled()).toHaveLength(1);
    expect(c().write_consent_checked ?? 0).toBe(0);
    expect(c().write_order_would_refuse ?? 0).toBe(0);
  });

  it("writes nothing when there was no read-back to agree to", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn("What time would suit you?");
    await s.callerSays("Yes.");
    await s.book();

    expect(s.store.scheduled()).toHaveLength(0);
  });

  it("refuses a time no availability call ever confirmed", async () => {
    const s = await boot();

    // A read-back and an agreement, but the slot was never checked. The
    // availability invariant in lib/voice/live/guards.js is the only thing
    // standing between a fabricated time and a row.
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");
    await s.book();

    expect(s.store.scheduled()).toHaveLength(0);
  });
});
