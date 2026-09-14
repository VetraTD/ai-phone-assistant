import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { makeFakeDeps } from "../lib/harness/fakeDeps.js";
import { WEEKLY_HOURS } from "./fixtures/businessConfigs.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// THE CONSENT LATCH. Written against CAf1d6447d3439aeffbc14ffc4f76040ce,
// 2026-09-13, a call that agreed to a booking, announced it was done, and wrote
// nothing.
//
// The production sequence, from the logs:
//
//   17:59:21  ASST  "Just to confirm, that's Wednesday, September 16th at
//                    4 30 PM Central time ... Is that correct?"
//   17:59:25  CALR  "Yes."                        <- agreement, recorded
//   17:59:25  book_appointment  agreed_now:true readback_now:true -> HELD
//                                                  (spelling gate)
//   17:59:31  ASST  "Before I book that for you, could you spell your full name?"
//   17:59:50  CALR  "n i t h i n d o d l a"       <- a SPELLING, not a yes
//   17:59:50  book_appointment  agreed_now:FALSE readback_now:FALSE
//                               caller_turns_since_agreement:1 -> REFUSED
//   17:59:53  end_call
//
// TWO GATES THAT CANNOT BOTH BE SATISFIED. The spelling gate's remedy is to ask
// a question; asking costs a caller turn; the write-order gate requires the
// agreement to be the caller's current position. So the spelling gate spends
// the very consent the write-order gate demands, and nothing re-asks for it.
//
// The morning call CA3563cbaa17 survived the identical shape only because its
// two attempts were 36 seconds apart with room for the caller to re-agree after
// the token existed. This one retried 3 ms later. The success was timing, not
// design.
//
// WHY A BARE LATCH IS NOT THE FIX, and why every test below asserts on the
// ARGS rather than on "an agreement exists somewhere": on CA8c019c a token
// recorded when the caller agreed to a CANCELLATION was still present, looking
// valid, at a BOOKING write ten caller turns later. A yes that authorises
// anything is worse than a yes that expires. So the latch is bound to WHAT was
// agreed -- the action and the time -- and is spendable only on that.
//
// THE MATCH RULE, decided 2026-09-13: action and time are locked; the name and
// phone may still be corrected afterwards. Locking every field would re-create
// the bug above on any call where the spelling still lands after the yes, and
// the prompt change that moves it earlier is a prompt change -- this codebase
// has written down twice that "at most once" in a prompt does not hold.
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

// Same shape as tests/liveWritePathEndToEnd.test.js, and for the same reason:
// the "appointments-availability" fixture demands a date of birth and would
// refuse every booking here for a reason that has nothing to do with consent.
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

// Monday 7 September 2026. Monday is open 09:00-17:00 in WEEKLY_HOURS and the
// date is after FROZEN_NOW, so validateBookingTime passes for both.
const SLOT = "2026-09-07T14:00:00";
const OTHER_SLOT = "2026-09-07T15:00:00";
const CLIENT = "Nitin Dodla";
const CLIENT_SPELLED = "Nithin Dodla";

// "just to confirm" is matched by confirmReadBackRe (lib/voice/strings.js).
const READ_BACK = `Just to confirm, I'm booking you in for Monday, September 7th at 2 00 PM. Does that sound right?`;

// The line the spelling gate's refusal asks the model to say, and the line that
// cost the production call its booking.
const SPELL_ASK = `Before I book that for you, could you spell out your full name?`;

async function boot() {
  const ws = new FakeSocket();
  const live = fakeLive();
  const { deps, store } = makeFakeDeps({ seedAppointments: [], slotCapacity: 1 });

  await handleLiveSessionConnection(
    ws,
    {},
    {
      now: () => 0,
      connect: live.connect,
      database: fakeDb(),
      env: {},
      // No `execute` override: the real gate cascade in services/tools.js runs.
      capabilityDeps: deps,
    }
  );

  ws.deliver({
    event: "start",
    start: {
      callSid: "CA_latch",
      streamSid: "MZ1",
      customParameters: { businessPhone: "+18176011171", callerPhone: "+15551234567" },
    },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  const settle = () => new Promise((r) => setTimeout(r, 25));

  return {
    live,
    store,
    settle,
    async checkAvailability(at = SLOT) {
      live.push({
        toolCall: {
          functionCalls: [{ id: `av${Math.random()}`, name: "check_appointment_availability", args: { requested_at: at } }],
        },
      });
      await settle();
      await settle();
    },
    async assistantTurn(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
      await settle();
    },
    async callerSays(text) {
      live.push({ serverContent: { inputTranscription: { text } } });
      await settle();
    },
    async book(args = { scheduled_at: SLOT, client_name: CLIENT }) {
      live.push({ toolCall: { functionCalls: [{ id: `b${Math.random()}`, name: "book_appointment", args }] } });
      await settle();
      await settle();
    },
  };
}

const c = () => getLatencyStats().turnTaking;

const FROZEN_NOW = new Date("2026-09-04T12:00:00Z");

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(FROZEN_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tier 1 -- the latch itself, with the spelling gate OFF so that the only thing
// under test is what an interposed caller turn does to a standing agreement.
// Tier 2 reproduces the production call with the gate armed.
// ---------------------------------------------------------------------------
describe("the consent latch: an agreement survives an interposed caller turn", () => {
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

  // THE BUG. Today this refuses: the caller's current turn is a spelling, so
  // isAffirmative is false and the write-order gate sees no agreement at all,
  // despite one having been given two turns earlier for these exact details.
  it("writes the row when the caller answered a question between agreeing and the write", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");
    await s.assistantTurn(SPELL_ASK);
    await s.callerSays("n i t h i n d o d l a");
    await s.book();

    expect(s.store.scheduled()).toHaveLength(1);
    expect(s.store.scheduled()[0].scheduled_at).toContain("2026-09-07");
  });

  // THE SAFETY HALF, and the reason the latch stores the args rather than a
  // bare flag. CA8c019c spent a cancellation's consent on a booking; this is
  // the same failure in the form this fixture can express -- consent given for
  // 2 PM must not buy a row at 3 PM.
  it("refuses a time the caller never agreed to, even with a standing agreement", async () => {
    const s = await boot();

    await s.checkAvailability(SLOT);
    await s.checkAvailability(OTHER_SLOT);
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");
    await s.assistantTurn(SPELL_ASK);
    await s.callerSays("n i t h i n d o d l a");
    // The read-back said 2 PM. This is 3 PM.
    await s.book({ scheduled_at: OTHER_SLOT, client_name: CLIENT });

    expect(s.store.scheduled()).toHaveLength(0);
  });

  // THE SAFETY HALF WITH THE AGREEMENT STILL CURRENT, which is the only form
  // of it that fails today. The test above refuses for the wrong reason -- the
  // caller's last turn is a spelling, so `agreed_now` is false and the existing
  // gate stops it without ever looking at the arguments. Here the caller has
  // just said yes, so every check the gate makes today passes, and it writes a
  // row for a time nobody ever read back. That is CA8c019c's shape exactly:
  // consent, valid and current, spent on something it was not given for.
  //
  // SKIPPED, AND THE REASON IS THE POINT. Catching this needs the read-back
  // TEXT compared against the write's arguments -- "Monday, September 7th at
  // 2 00 PM" against `scheduled_at: "2026-09-07T14:00:00"`. Every other test in
  // this file is settled by comparing two fingerprints the engine already
  // computes; this one is not, and the phrasings a model uses for a time
  // ("2 PM", "two o'clock", "half two") are exactly the surface this codebase
  // has written down that a detector must be measured against real fixtures
  // before it is trusted. A miss refuses a booking the caller agreed to, which
  // is the defect this whole branch exists to remove.
  //
  // So it is a SEPARATE piece of work with a measurement pass in front of it,
  // filed rather than faked. The latch shipped here does not close it: consent
  // given for one time can still be spent on another within the same read-back.
  it.skip("refuses a different time even while the agreement is the caller's current turn", async () => {
    const s = await boot();

    await s.checkAvailability(SLOT);
    await s.checkAvailability(OTHER_SLOT);
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");
    // No interposed turn at all. The read-back said 2 PM; this books 3 PM.
    await s.book({ scheduled_at: OTHER_SLOT, client_name: CLIENT });

    expect(s.store.scheduled()).toHaveLength(0);
  });

  // THE MATCH RULE, decided rather than derived: the name may be corrected
  // after the agreement without a fresh read-back, because the appointment the
  // caller agreed to has not changed. Locking it would refuse the very call
  // this work exists to fix.
  it("allows a corrected name after the agreement, without a fresh read-back", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");
    await s.assistantTurn(SPELL_ASK);
    await s.callerSays("n i t h i n d o d l a");
    // Same appointment, name now spelled out.
    await s.book({ scheduled_at: SLOT, client_name: CLIENT_SPELLED });

    expect(s.store.scheduled()).toHaveLength(1);
    expect(s.store.scheduled()[0].client_name).toBe(CLIENT_SPELLED);
  });

  // The latch must not invent consent. With no agreement anywhere on the call
  // there is nothing to survive, and the write-order gate's existing refusal
  // has to stand exactly as it does today.
  it("still refuses when the caller never agreed at all", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(READ_BACK);
    await s.callerSays("What are your opening hours?");
    await s.book();

    expect(s.store.scheduled()).toHaveLength(0);
  });

  // A latch that outlives its read-back would authorise a write against details
  // the caller never heard. Once the model reads a DIFFERENT set of details
  // back, the standing agreement refers to the earlier one and must not be
  // spendable on the new one without a new yes.
  it("refuses after a second, different read-back the caller has not answered", async () => {
    const s = await boot();

    await s.checkAvailability(SLOT);
    await s.checkAvailability(OTHER_SLOT);
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");
    // The caller changes their mind; the model reads the new time back and the
    // caller has not answered yet.
    await s.assistantTurn(
      `Just to confirm, I'm booking you in for Monday, September 7th at 3 00 PM instead. Does that sound right?`
    );
    await s.book({ scheduled_at: OTHER_SLOT, client_name: CLIENT });

    // The counter says WHY it was refused, so a green here cannot be the old
    // gate refusing for the old reason.
    expect(c().write_consent_agreement_superseded).toBe(1);
    expect(s.store.scheduled()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 -- the production call, with the spelling gate armed. This is the
// integration the tier-1 tests deliberately isolate away from: the gate holds
// the first attempt, stashes the args, asks for a spelling, and the retry comes
// back through the whole cascade after the caller answers.
//
// tests/liveWritePathEndToEnd.test.js turns this policy OFF for every one of
// its write-order tests, which is why no existing test in the tree could ever
// have witnessed the collision.
// ---------------------------------------------------------------------------
describe("the consent latch: the spelling gate and the write-order gate together", () => {
  let priorSpellPolicy;

  beforeEach(() => {
    clearStats();
    priorSpellPolicy = process.env.VOICE_SPELL_POLICY;
    // "always" is the default; the gate is armed.
    delete process.env.VOICE_SPELL_POLICY;
  });

  afterEach(() => {
    if (priorSpellPolicy === undefined) delete process.env.VOICE_SPELL_POLICY;
    else process.env.VOICE_SPELL_POLICY = priorSpellPolicy;
  });

  it("books CAf1d6447d34's call: held for a spelling, then written once the caller spells", async () => {
    const s = await boot();

    await s.checkAvailability();
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes.");

    // Attempt 1: consent is current, but the name has never been spelled. The
    // spelling gate holds it and stashes the args.
    await s.book();
    expect(s.store.scheduled()).toHaveLength(0);

    // The model asks, the caller answers. spellingSettled() fires the retry in
    // code -- this is the path that produced live_write_retried {gated:true,
    // ok:false} in production.
    await s.assistantTurn(SPELL_ASK);
    await s.callerSays("n i t h i n d o d l a");
    await s.assistantTurn("Thanks — I have that spelled out.");
    await s.settle();
    await s.settle();

    // THE ROW THE PRODUCTION CALL NEVER GOT.
    expect(s.store.scheduled()).toHaveLength(1);
    expect(s.store.scheduled()[0].scheduled_at).toContain("2026-09-07");
    // And exactly one agreement carried it, not a second inferred from the
    // write having happened.
    expect(c().consent_agreement_recorded).toBe(1);
  });
});
