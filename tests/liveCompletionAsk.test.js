// ---------------------------------------------------------------------------
// LVX157. IT SAYS GOODBYE THE MOMENT THE JOB IS DONE.
//
// Twelve turns across call-corpus/ complete an action and sign off in the same
// breath; eleven of them never ask whether the caller needs anything else. Two
// callers on the night of 2026-09-19 demonstrably still had something to say.
//
// THE PART THAT IS NOT OBVIOUS, and that cost the previous attempt four hours:
// end_call's own declaration REQUIRES the sign-off in the same response as the
// call, so the farewell is composed before any gate can run. bfb65fb tried to
// make the words wait and f603af4 reverted it the same day -- "You're all set
// then", six seconds of dead air, a silence nudge. Nothing in this file defers
// a single word. Both halves act BEFORE the model composes, or not at all.
//
// LAYER A, the note. A successful write returns an instruction with its result.
//   The model reads that before it decides whether to call end_call, which is
//   the one seam where "do not sign off yet" can still change what gets said.
//
// LAYER B, the latches. Both halves of LVX132's ask gate could be disarmed
//   before they mattered, and the corpus says how:
//
//     askedAnythingElseThisCall was documented "never reset -- a caller asked
//     once has been asked". CA0ef8d221 asked at 15:53:04 with NOTHING booked,
//     booked at 15:55:37, and signed off unasked with end_call_refusals
//     {no_ask: 0}. The ask was about work that did not exist yet.
//
//     anythingElseRefused was one-shot per CALL. CA84dc64 spent it at 20:56:22
//     on a cancel, completed a booking at 20:58:31, and the sign-off at
//     20:58:36 went through ungated.
//
//   So an ask counts for the work that existed when it was asked, and one
//   refusal is available per completed action rather than per call. LVX21's
//   livelock stays impossible because re-arming requires a NEW SUCCESSFUL
//   write -- a refused write re-arms nothing, which is exactly the loop that
//   produced LVX21.
//
// Replayed over call-corpus/ before it was written: 11 hang-ups newly refused,
// and ZERO newly allowed. CAec2309, the one call that got this right on its
// own, is untouched.
//
// WHY bootLive. A suite that stubs `execute` hand-rolls the tool return shapes
// and cannot see either half: Layer A lives on the real functionResponse and
// Layer B is decided in the real services/tools.js gate off the real turnState
// wire. liveEndCallAsk.test.js says the same thing about the same gate.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

const OPEN = { open: "09:00", close: "18:00", closed: false };
const CONFIG = {
  businessName: "Digile Media",
  greeting: "Thanks for calling Digile Media.",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  businessHours: {
    mon: OPEN,
    tue: OPEN,
    wed: OPEN,
    thu: OPEN,
    fri: OPEN,
    sat: { open: null, close: null, closed: true },
    sun: { open: null, close: null, closed: true },
  },
  locale: "en-US",
  allowedTasks: ["book_appointment", "check_appointment", "cancel_appointment"],
  afterHoursPolicy: "take_message",
  capabilities: {
    appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } },
  },
};

const SLOT = "2026-09-18T15:30:00";
const SECOND_SLOT = "2026-09-18T16:30:00";
const CLIENT = "Marcus Bell";
const READ_BACK =
  "I have you down for a strategy call on Friday, September eighteenth at three thirty PM. Shall we go ahead and book that?";
const SECOND_READ_BACK =
  "I have you down for a strategy call on Friday, September eighteenth at four thirty PM. Shall we go ahead and book that?";
const CANCEL_READ_BACK =
  "Just to confirm, would you like me to cancel your appointment on Friday, September eighteenth at three thirty PM?";
/** The wording CA2556d4 used, which is what closingTicRe is scored against. */
const ASKED = "That is now cancelled for you. Is there anything else I can help you with today?";

/**
 * The seeded row, so a call can complete a cancel AND a booking.
 *
 * `business_id` is NOT optional and its absence is silent: every lookup in
 * lib/harness/fakeDeps.js filters on it, so a row without one is invisible, the
 * cancel finds nothing, and the failure surfaces as "the write did not land"
 * rather than as "the seed was wrong". Copied field for field from
 * tests/liveCorpusReplay.test.js, which learned this first.
 */
const SEED_ID = "seed-appt-1";
const SEEDED = [
  {
    id: SEED_ID,
    business_id: "biz-1",
    client_name: CLIENT,
    client_phone: "+15551234567",
    scheduled_at: `${SLOT}Z`,
    status: "scheduled",
  },
];

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});

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

const ok = (responses) => responses[0]?.response?.success === true;

/** A completed booking. One action on the call. */
async function bookedCall(callSid, opts = {}) {
  const s = await bootLive({ config: CONFIG, callSid, ...opts });
  await s.callTool("check_appointment_availability", { requested_at: SLOT });
  await s.callerSays("I'd like Friday afternoon.");
  await s.assistantTurn(READ_BACK);
  await s.callerSays("Yes, that works.");
  const res = await s.callTool("book_appointment", { client_name: CLIENT, scheduled_at: SLOT });
  expect(ok(res), "the booking the rest of the test depends on did not land").toBe(true);
  return s;
}

/**
 * A completed CANCEL. CA84dc64's own first action, and the reason the second
 * action here is not a second booking: one call cannot book twice. The booking
 * idempotency anchor in services/tools.js refuses the second one in the pack,
 * with `gated: false` -- not a gate decision at all -- which is the correct
 * product behaviour and would have made this test measure nothing.
 */
async function cancelsFirst(s) {
  await s.callTool("get_caller_appointments_from_db", {});
  await s.callerSays("I need to cancel my appointment.");
  await s.assistantTurn(CANCEL_READ_BACK);
  await s.callerSays("Yes, please cancel it.");
  const res = await s.callTool("cancel_appointment_db", { appointment_id: SEED_ID });
  expect(ok(res), "the cancel the test depends on did not land").toBe(true);
  return res;
}

/** The booking that follows it, so the action count advances to two. */
async function thenBooks(s) {
  await s.callTool("check_appointment_availability", { requested_at: SECOND_SLOT });
  await s.callerSays("Actually, can I take the four thirty instead?");
  await s.assistantTurn(SECOND_READ_BACK);
  await s.callerSays("Yes please.");
  const res = await s.callTool("book_appointment", {
    client_name: CLIENT,
    scheduled_at: SECOND_SLOT,
  });
  expect(ok(res), "the second write the test depends on did not land").toBe(true);
  return res;
}

// ---------------------------------------------------------------------------
// LAYER A
// ---------------------------------------------------------------------------
describe("the note that rides back with a completed write", () => {
  it("tells the model to report and ask, and not to sign off on this turn", async () => {
    const s = await bookedCall("CA_note_sent");
    const [res] = s.responsesFor("book_appointment").slice(-1);

    expect(res.response.success).toBe(true);
    // The instruction itself. Worded so that the model cannot read it as a
    // failure -- the whole lesson of the no_ask refusal's "NOT A FAILURE"
    // opening, which was added after a refusal was announced to a caller as a
    // system problem.
    expect(res.response.next_step).toMatch(/\[not caller speech\]/);
    expect(res.response.next_step).toMatch(/anything else/i);
    expect(res.response.next_step).toMatch(/do not say goodbye|not.*sign off/i);
    expect(counters().live_completion_ask_note_sent).toBe(1);
  });

  it("does not ride back with a REFUSED write", async () => {
    // No read-back, no agreement: the write-order gate refuses. A note saying
    // "the write went through" on a refusal would be a lie the model then
    // repeats to the caller, which is LVX140's defect pointed the other way.
    const s = await bootLive({ config: CONFIG, callSid: "CA_note_refused" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    const res = await s.callTool("book_appointment", { client_name: CLIENT, scheduled_at: SLOT });

    expect(ok(res)).toBe(false);
    expect(res[0].response.next_step).toBeUndefined();
    expect(counters().live_completion_ask_note_sent ?? 0).toBe(0);
  });

  it("does not ride back with a lookup", async () => {
    // Availability is not an action. Telling the model to wrap up after every
    // lookup is how "three questions in one breath" became LVX25.
    const s = await bootLive({ config: CONFIG, callSid: "CA_note_lookup" });
    const res = await s.callTool("check_appointment_availability", { requested_at: SLOT });

    expect(res[0].response.next_step).toBeUndefined();
    expect(counters().live_completion_ask_note_sent ?? 0).toBe(0);
  });

  it("counts whether the model actually asked, because a note is not a fact", async () => {
    // "At most once" in a prompt does not hold and neither does "ask before you
    // sign off". The positive twin exists so that a note_sent count with no
    // honoured count beside it cannot be read as the fix working.
    const s = await bookedCall("CA_note_honoured");
    await s.assistantTurn("That is booked for you. Is there anything else I can help you with today?");

    expect(counters().live_completion_ask_note_sent).toBe(1);
    expect(counters().live_completion_ask_note_honoured).toBe(1);
  });

  it("leaves the honoured counter at zero when the model signs off instead", async () => {
    const s = await bookedCall("CA_note_ignored");
    await s.assistantTurn(
      "I have successfully booked your strategy call. Thank you for calling Digile Media, and have a wonderful day."
    );

    expect(counters().live_completion_ask_note_sent).toBe(1);
    expect(counters().live_completion_ask_note_honoured ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LAYER B — the ask goes stale
// ---------------------------------------------------------------------------
describe("an ask covers the work that existed when it was asked", () => {
  it("does not cover a write that completed after it — CA0ef8d221", async () => {
    // The corpus shape exactly: asked while nothing was booked, then booked,
    // then tried to leave. The deployed gate allowed this and the caller was
    // thanked for calling with a booking they had never been asked about.
    const s = await bootLive({ config: CONFIG, callSid: "CA_ask_stale" });
    await s.callTool("get_caller_appointments_from_db", {});
    await s.assistantTurn(
      "I don't see any upcoming appointments on file for this number. Is there anything else I can assist you with today?"
    );
    await s.callerSays("Yes, I'd like to book one.");
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes, that works.");
    await s.callTool("book_appointment", { client_name: CLIENT, scheduled_at: SLOT });

    const res = await s.callTool("end_call", {});
    expect(ok(res)).toBe(false);
    expect(counters().end_call_refused_no_ask).toBe(1);
    expect(counters().live_ask_latch_stale_at_action).toBe(1);
  });

  it("still covers a hang-up when nothing has been written since the ask", async () => {
    // CAec2309, the one call that got this right on its own: cancelled, asked
    // in the same turn as the confirmation, then left. Nothing here may change
    // that -- if it does, the design is wrong.
    const s = await bookedCall("CA_ask_fresh");
    await s.assistantTurn(ASKED);
    await s.callerSays("No, that's everything.");

    const res = await s.callTool("end_call", {});
    expect(ok(res)).toBe(true);
    expect(counters().end_call_refused_no_ask ?? 0).toBe(0);
    expect(counters().live_ask_latch_stale_at_action ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LAYER B — the refusal re-arms
// ---------------------------------------------------------------------------
describe("one refusal per completed action, not per call", () => {
  it("re-arms when a NEW write lands — CA84dc64", async () => {
    // The corpus call, in order: cancel at 20:56:20, end_call REFUSED at
    // 20:56:22, the caller changes tack and books at 20:58:31, and the sign-off
    // at 20:58:36 goes through because the one refusal had been spent two
    // minutes earlier on work the caller had already abandoned.
    const s = await bootLive({
      config: CONFIG,
      callSid: "CA_rearm",
      seedAppointments: SEEDED,
    });
    await cancelsFirst(s);
    const first = await s.callTool("end_call", {});
    expect(ok(first)).toBe(false);

    // A second piece of work, completed. The caller has not been asked about
    // THIS one.
    await thenBooks(s);

    const second = await s.callTool("end_call", {});
    expect(ok(second)).toBe(false);
    expect(counters().end_call_refused_no_ask).toBe(2);
    expect(counters().end_call_ask_rearmed_by_action).toBe(1);
  });

  it("does not re-arm on a REFUSED write, so LVX21 stays impossible", async () => {
    // The livelock is a model re-proposing the same write in words the gate
    // does not recognise. If a refusal re-armed the hang-up gate, that loop
    // would hold the caller on the line indefinitely -- which is the exact
    // cost LVX21 recorded and the reason the latch existed at all.
    const s = await bookedCall("CA_rearm_refused");
    const first = await s.callTool("end_call", {});
    expect(ok(first)).toBe(false);

    // A write that is refused: no read-back, no agreement.
    const refused = await s.callTool("book_appointment", {
      client_name: CLIENT,
      scheduled_at: SECOND_SLOT,
    });
    expect(ok(refused)).toBe(false);

    const second = await s.callTool("end_call", {});
    expect(ok(second)).toBe(true);
    expect(counters().end_call_refused_no_ask).toBe(1);
    expect(counters().end_call_ask_rearmed_by_action ?? 0).toBe(0);
  });

  it("still lets a repeated hang-up through within the same action", async () => {
    // Unchanged from LVX132: one refusal is a question the caller can answer,
    // two in a row is a trap. Nothing has been written between these two
    // attempts, so nothing re-arms.
    const s = await bookedCall("CA_rearm_same_action");
    expect(ok(await s.callTool("end_call", {}))).toBe(false);
    expect(ok(await s.callTool("end_call", {}))).toBe(true);
    expect(counters().end_call_refused_no_ask).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LVX146's door, scoped the same way.
//
// A model that simply SAYS a farewell and never calls end_call walks past the
// gate entirely -- CA299f23ce, CAb4c0eb91. LVX146 holds the exit once for that,
// and "once" had the same defect the refusal did: spent on one piece of work,
// gone for the next.
// ---------------------------------------------------------------------------
describe("the back door holds once per completed action too", () => {
  it("holds again after a second write, where the old one-shot was spent", async () => {
    const s = await bootLive({
      config: CONFIG,
      callSid: "CA_backdoor",
      seedAppointments: SEEDED,
    });
    await cancelsFirst(s);
    // Spoken, no end_call at all. This is the shape the gate cannot see.
    await s.assistantTurn(
      "Your appointment is cancelled. Thanks for calling Digile Media, and have a great day."
    );
    expect(counters().live_goodbye_exit_held_no_ask).toBe(1);

    await thenBooks(s);
    await s.assistantTurn(
      "Your strategy call is booked. Thanks for calling Digile Media, and have a wonderful day."
    );
    expect(counters().live_goodbye_exit_held_no_ask).toBe(2);
  });

  it("does not hold twice for the same piece of work", async () => {
    // Still at most one per action, so it cannot become a line nobody can end.
    // That is CAaef5bd82's defect and the worse of the two failures.
    const s = await bookedCall("CA_backdoor_once");
    await s.assistantTurn(
      "That is booked. Thanks for calling Digile Media, and have a great day."
    );
    await s.assistantTurn("Thanks for calling Digile Media, and have a great day.");
    expect(counters().live_goodbye_exit_held_no_ask).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The number LVX157 is actually about, which exists whether or not any of the
// above works. end_call_refusals reads {no_ask: 0} on exactly the calls where
// the caller was signed off at, because END_CALL WAS NEVER CALLED.
// ---------------------------------------------------------------------------
describe("the defect's own counter", () => {
  it("counts a farewell spoken over a completed action with no ask behind it", async () => {
    const s = await bookedCall("CA_signoff_counted");
    await s.assistantTurn(
      "Your strategy call is booked for Friday, September 18th at 3:30 PM. Thanks for calling Digile Media, and have a great day."
    );

    expect(counters().live_completion_signoff_without_ask).toBe(1);
  });

  it("does not count the same farewell when the caller was asked first", async () => {
    const s = await bookedCall("CA_signoff_asked");
    await s.assistantTurn(ASKED);
    await s.callerSays("No, that's everything.");
    await s.assistantTurn("Thanks for calling Digile Media, and have a great day.");

    expect(counters().live_completion_signoff_without_ask ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE PER-CALL RECORD, and this suite is the reason it exists.
//
// All five of LVX157's counters shipped on 2026-09-19 as process-global
// bumpCounters. On CA98d6b04 -- the first real call on the fix -- the outcome
// was right and **whether the note had gone out or been honoured had no
// per-call answer at all**, so the one question the call was made to settle
// could not be settled from it. The counters are zeroed by the next deploy and
// shared by every call the instance handles.
//
// This asserts the WIRE, not the arithmetic: a ledger that is filled in and
// never emitted reads exactly like one that was never filled in, and that is
// the most-repeated defect in lib/voice/live/index.js.
// ---------------------------------------------------------------------------
describe("the per-call closing record", () => {
  async function summaryOf(run) {
    const chunks = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (typeof chunk === "string" && chunk.includes('"event":"live_call_summary"')) {
        chunks.push(chunk);
      }
      return true;
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    const summaries = chunks
      .flatMap((c) => c.split("\n"))
      .filter((l) => l.includes('"event":"live_call_summary"'))
      .map((l) => JSON.parse(l));
    expect(summaries).toHaveLength(1);
    return summaries[0];
  }

  it("carries the note and the ask on the call that made them", async () => {
    const summary = await summaryOf(async () => {
      const s = await bookedCall("CA_ledger_honoured");
      await s.assistantTurn(
        "That is booked. Is there anything else I can help you with today?"
      );
      await s.hangUp();
    });

    expect(summary.closing).toBeTruthy();
    expect(summary.closing.actions_completed).toBe(1);
    expect(summary.closing.ask_note_sent).toBe(1);
    expect(summary.closing.ask_note_honoured).toBe(1);
    expect(summary.closing.signoff_without_ask).toBe(0);
  });

  it("carries the note going UNhonoured, which is the case that decides", async () => {
    // sent 1 / honoured 0 is what "the model reads the instruction and ignores
    // it" looks like. Without both numbers on the same record it is
    // indistinguishable from the note never having been sent.
    const summary = await summaryOf(async () => {
      const s = await bookedCall("CA_ledger_ignored");
      await s.assistantTurn(
        "I have successfully booked your strategy call. Thank you for calling Digile Media, and have a wonderful day."
      );
      await s.hangUp();
    });

    expect(summary.closing.ask_note_sent).toBe(1);
    expect(summary.closing.ask_note_honoured).toBe(0);
    expect(summary.closing.signoff_without_ask).toBe(1);
  });

  it("carries the stale ask and the re-arm, the two shapes the fix is for", async () => {
    const summary = await summaryOf(async () => {
      const s = await bootLive({
        config: CONFIG,
        callSid: "CA_ledger_rearm",
        seedAppointments: SEEDED,
      });
      await cancelsFirst(s);
      // Never asked, so the first hang-up is refused on the plain LVX132 rule.
      // Not stale: there is no ask to be stale.
      expect(ok(await s.callTool("end_call", {}))).toBe(false);
      await s.assistantTurn(ASKED); // asked, at action 1
      await s.callerSays("Actually yes, one more thing.");
      // Action 2. The ask above is now about work that has been superseded, and
      // the refusal above was spent on it -- both halves move together, which is
      // CA84dc64 and CA0ef8d221 arriving on the same call.
      await thenBooks(s);
      expect(ok(await s.callTool("end_call", {}))).toBe(false);
      await s.hangUp();
    });

    expect(summary.closing.actions_completed).toBe(2);
    expect(summary.closing.ask_rearmed_by_action).toBe(1);
    expect(summary.closing.ask_latch_stale).toBe(1);
    // The old invariant, now false and worth pinning as false.
    expect(summary.end_call_refusals.no_ask).toBe(2);
  });

  it("is present and empty on a call that completed nothing", async () => {
    // A clean call and a call the fix could not apply to must not read the
    // same. actions_completed is the denominator that separates them.
    const summary = await summaryOf(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_ledger_noop" });
      await s.callerSays("What are your hours?");
      await s.assistantTurn("We're open nine to five, Monday to Friday.");
      await s.hangUp();
    });

    expect(summary.closing.actions_completed).toBe(0);
    expect(summary.closing.ask_note_sent).toBe(0);
    expect(summary.closing.signoff_without_ask).toBe(0);
  });
});
