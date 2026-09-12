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

    // The write's target is now on the record, relationally. Before this event
    // existed, no log line anywhere said what time a write aimed at, so no
    // change to this path could be checked against history.
    expect(c().write_landed_on_listed_slot ?? 0).toBe(0);
  });

  it("marks a write that landed on a slot nothing ever point-checked", async () => {
    // The common real shape: the caller's first choice is taken, the response
    // carries alternatives the model is instructed to offer, and the booking
    // lands on one of those -- a time the caller was SHOWN rather than one they
    // were ASKED about. The availability invariant allows it, correctly. Nothing
    // measured it until now.
    const s = await boot({
      seedAppointments: [
        { business_id: BUSINESS_ID, client_name: "Someone Else", scheduled_at: "2026-09-07T19:00:00.000Z" },
      ],
    });

    await s.checkAvailability(SLOT);
    expect(c().availability_point_taken).toBe(1);

    // Book one of the alternatives the taken-check put on the table.
    const alt = "2026-09-07T14:30:00";
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");
    await s.book({ scheduled_at: alt, client_name: CLIENT });

    expect(s.store.scheduled().length).toBeGreaterThanOrEqual(2);
    expect(c().write_landed_on_listed_slot).toBe(1);
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
  // CLOSED 2026-09-12, and the discriminator is the one this comment predicted:
  // `ctx.callerSaidThisCall` is null on the cascade and non-null on Live, so the
  // refusal runs on "Live with no caller text" while the cascade stays
  // byte-identical (tests/liveWriteConsent.test.js proves the second half).
  //
  // The rule is NOT "require caller text" -- that refuses the legitimate write
  // in the test below. It is "no caller text on this turn AND no agreement token
  // anywhere on the call", and the token is read ONLY to refuse, never to allow.
  // -------------------------------------------------------------------------
  it("refuses a write on a silent turn when the caller has agreed to nothing at all", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(READ_BACK);
    // No caller turn at all: the read-back was spoken into silence.
    await s.book();

    // WAS 1 until the refusal shipped, asserted as the defect with the comment
    // "Should be 0". This is the row CA422f58 wrote against a question its
    // caller had not answered.
    expect(s.store.scheduled()).toHaveLength(0);
    // Still zero: the refusal returns ABOVE the cascade, so none of it ran.
    expect(c().write_consent_checked ?? 0).toBe(0);
    expect(c().write_order_would_refuse ?? 0).toBe(0);

    // THE PROBE STILL SEES THE SHAPE. This counter is the denominator the new
    // one is a subset of, so both have to be present to tell "refused" from
    // "allowed because they had agreed earlier".
    expect(c().write_consent_skipped_silent_turn).toBe(1);
    expect(c().write_refused_no_consent_silent_turn).toBe(1);
    // No agreement anywhere on the call, which is the whole reason refusing is
    // safe here: there is no action this could be withdrawing consent from.
    expect(c().consent_agreement_recorded ?? 0).toBe(0);
    expect(c().write_consent_token_present ?? 0).toBe(0);

    // HELD, NOT FAILED, as a boolean. lib/voice/live/index.js reads exactly this
    // to decide whether to tell the caller the booking did not go through --
    // prose saying "NOT A FAILURE" is not a branch.
    const r = s.bookResponses().at(-1)?.response;
    expect(r?.success).toBe(false);
    expect(r?.gated).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CONSENT OUTLIVES THE TURN IT WAS GIVEN ON, and this is why the silent-turn
  // hole above cannot simply be closed by requiring caller text.
  //
  // The caller agrees on turn N. The model says something, the turn ends, and it
  // calls book_appointment on turn N+1 with no new caller speech. Today that
  // write succeeds -- because the gate block is skipped when lastCallerText is
  // empty, which is the same hole. But the write is also CORRECT: the caller did
  // agree, one turn earlier, to this exact booking.
  //
  // So "the caller has not spoken this turn" is not "the caller has not agreed",
  // and a fix that conflates them refuses legitimate bookings. Closing the hole
  // needs a durable record of the agreement, which is the open design question --
  // and the reverted three-turn window (services/tools.js) is what happens when
  // that record is not scoped to the action it authorised.
  //
  // Pinned so that any future change here has to confront both cases at once.
  // -------------------------------------------------------------------------
  it("allows a write one turn after the agreement, with no caller speech on that turn", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");
    // The turn ends with the model speaking again, so the agreement is now two
    // turns back and this turn carries no caller text at all.
    await s.assistantTurn("Lovely, one moment while I get that in for you.");
    await s.book();

    expect(s.store.scheduled()).toHaveLength(1);

    // THE BENIGN SHAPE, and the whole reason the hole cannot just be closed.
    // The gate was skipped exactly as in the test above -- but here the caller
    // DID agree, one turn earlier, and the engine holds a token proving it. The
    // two cases are indistinguishable to the gate and distinguishable to the
    // probe, which is what a rule would need in order to be safe.
    expect(c().write_consent_skipped_silent_turn).toBe(1);
    expect(c().consent_agreement_recorded).toBe(1);
    expect(c().write_consent_token_present).toBe(1);

    // AND IT WAS NEVER REFUSED. The token is why: same silent turn as the test
    // above, opposite outcome. If this counter is ever non-zero here, the rule
    // has been implemented as "require caller text" and refuses real bookings.
    expect(c().write_refused_no_consent_silent_turn ?? 0).toBe(0);
  });

  // -------------------------------------------------------------------------
  // CA422f58, END TO END: THE REFUSED WRITE MUST NOT BE A LOST WRITE.
  //
  // This is the half of the fix that is not about refusing. retryPendingWrite
  // TAKES the stash rather than reading it -- takePendingWrite clears as it
  // reads, because a re-delivered transcript must not book twice -- so a gate
  // that simply returns a refusal DESTROYS the write it refused. On a
  // cancellation that is worse than the defect being fixed: bookingOwedNoRow
  // only ever covers a missing BOOKING, so a dropped cancel reaches nobody.
  //
  // So the refusal re-stashes with reason "write_order", and heldForAgreement
  // re-issues it the moment the caller actually agrees, back through the whole
  // gate stack. The write is DELAYED BY ONE TURN, not cancelled -- which is what
  // CA422f58 should have done: commit at 20:51:49 on the real "Yes." rather than
  // at 20:51:42 on nothing.
  // -------------------------------------------------------------------------
  it("re-issues the refused write when the caller finally agrees, and writes it once", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(READ_BACK);
    // The caller says nothing. The write is refused, not dropped.
    await s.book();
    expect(s.store.scheduled()).toHaveLength(0);
    expect(c().write_refused_no_consent_silent_turn).toBe(1);

    // NOW they answer the question that was actually put to them. The turn has
    // to close for the engine to see it, which is what assistantTurn does.
    await s.callerSays("Yes.");
    await s.assistantTurn("Lovely, that's booked in for you.");
    await s.settle();
    await s.settle();

    // THE ROW EXISTS, exactly once, at the time that was read back.
    expect(s.store.scheduled()).toHaveLength(1);
    expect(s.store.scheduled()[0].scheduled_at).toContain("2026-09-07");
    // And the agreement that released it was a real one, recorded by the ledger
    // rather than inferred from the write having happened.
    expect(c().consent_agreement_recorded).toBe(1);
  });

  it("writes nothing when there was no read-back to agree to", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn("What time would suit you?");
    await s.callerSays("Yes.");
    await s.book();

    expect(s.store.scheduled()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // THE AVAILABILITY VERDICT DISCRIMINATES, which nothing could previously
  // assert because nothing recorded it. These three cases all produce
  // `success: true` from check_appointment_availability and were indistinguishable
  // in every log and counter in the tree.
  // -------------------------------------------------------------------------
  it("records a point check that found the time OPEN, and ties it to one slot", async () => {
    const s = await boot();
    await s.checkAvailability(SLOT);

    expect(c().availability_point_open).toBe(1);
    expect(c().availability_point_taken ?? 0).toBe(0);
    expect(c().availability_day_listed ?? 0).toBe(0);
  });

  it("records a point check that found the time TAKEN, and does not tie it to a slot", async () => {
    // Capacity 1 and the slot already filled, so the check comes back
    // available:false -- the response that also carries the alternatives the
    // model is instructed to offer.
    const s = await boot({
      seedAppointments: [
        { business_id: BUSINESS_ID, client_name: "Someone Else", scheduled_at: "2026-09-07T19:00:00.000Z" },
      ],
    });
    await s.checkAvailability(SLOT);

    expect(c().availability_point_taken).toBe(1);
    expect(c().availability_point_open ?? 0).toBe(0);
  });

  it("counts a whole-day query per slot, and as no point check at all", async () => {
    const s = await boot();
    // A bare date is a day query (capabilities/appointments.js routes it to
    // openTimesForDay, which returns no `available` field at all).
    await s.checkAvailability("2026-09-07");

    // THE DISCRIMINATION, and the assertion that matters: a day query yields NO
    // point verdict at all. openTimesForDay returns no `available` field, by its
    // own deliberate choice, so "the caller was shown a list" and "the caller's
    // time was confirmed" are now different facts rather than one success flag.
    expect(c().availability_point_open ?? 0).toBe(0);
    expect(c().availability_point_taken ?? 0).toBe(0);
    // Many slots from one call -- the number that says a caller was browsing
    // rather than agreeing, and why one combined verifiedSlots count could never
    // answer "which time did this call confirm". Counted per slot in BOTH the
    // per-call summary and the process-global counter; they disagreed until a
    // failing assertion here caught it.
    expect(c().availability_day_listed).toBeGreaterThan(1);
  });

  // -------------------------------------------------------------------------
  // A READ-BACK THAT ASKED TWO THINGS, AND THE "YES" THAT CANNOT BE ATTRIBUTED.
  //
  // Observed twice on one real call, 2026-09-12: "that's D I L L A N... is that
  // right? And what main marketing challenge are you facing?" and "can I send you
  // a text confirmation? Also, what day were you thinking of". Both fired
  // live_stacked_questions. Neither happened to land on the turn carrying the
  // booking consent -- which is luck, not design, and is exactly why the rate at
  // the consent point needs measuring rather than assuming.
  //
  // THE WRITE STILL SUCCEEDS, and that is asserted deliberately. This is
  // measurement, not a gate. Refusing here would reject bookings that work today
  // on the strength of one call, and the evidence for that call says the
  // stacking fell elsewhere.
  // -------------------------------------------------------------------------
  it("records that a read-back asked two things, and writes anyway", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(`${READ_BACK} And can I take your email address?`);
    await s.callerSays("Yes.");
    await s.book();

    expect(c().write_consent_readback_checked).toBe(1);
    expect(c().write_consent_readback_ambiguous).toBe(1);
    // Measurement, not a gate.
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("records a clean read-back as unambiguous", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");
    await s.book();

    expect(c().write_consent_readback_checked).toBe(1);
    expect(c().write_consent_readback_ambiguous ?? 0).toBe(0);
    expect(s.store.scheduled()).toHaveLength(1);
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
