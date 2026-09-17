// ---------------------------------------------------------------------------
// LVX137. THE ASSISTANT TURNED DOWN A TIME THAT WAS OPEN.
//
// CA6df19e98, 2026-09-17, verbatim:
//
//   14:46:51  check_appointment_availability  success=true   <- the ONLY one
//   14:47:03  A: "We have several times available tomorrow ... such as 9:00 AM,
//                 1:00 PM, or 4:30 PM."
//   14:47:25  A: "I'm sorry, 2:00 PM is not available. We do have 1:00 PM or
//                 4:30 PM open tomorrow, September 18th."
//   14:47:41  book_appointment  success=true   (3:00 PM)
//
// Guard counters for that call: verified_slots 16, point_verified_slots 0,
// read_memo_hit 0. The tenant is open 09:00-17:00 in thirty-minute slots --
// sixteen slots exactly -- and the diary shows that Friday had ZERO scheduled
// appointments. 2:00 PM was in the listing the model was holding.
//
// This is the mirror of every write gate in this repository. They stop the
// assistant claiming a booking that does not exist; nothing watched it claiming
// a slot is TAKEN when it is free. That failure writes no row, trips no refusal
// and, until this, moved no counter -- so a caller pushed off their preferred
// time left no trace at all.
//
// COUNTED, NOT REFUSED. One call proves the class exists and says nothing about
// the rate. LVX72 is the precedent in both directions: it counted first, and
// the one time a refusal shipped on three calls' evidence, call four overturned
// it.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, counters } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

// The REAL tenant's hours, read from the diary on 2026-09-17: 09:00-17:00
// America/Chicago. Not the corpus fixture's 18:00 close, which exists only so
// that file's 16:30 times stay legal.
const OPEN = { open: "09:00", close: "17:00", closed: false };
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
  allowedTasks: ["book_appointment", "check_appointment"],
  afterHoursPolicy: "take_message",
  capabilities: {
    appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } },
  },
};

const DAY = "2026-09-18";

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  clearStats();
});

/**
 * A call that has LISTED THE DAY, which is the state CA6df19e98 was in.
 *
 * Date-only, not a time: that is what puts the tool in day mode, and it
 * reproduces the live call exactly --
 *   open_times      09:00, 13:00, 16:30   <- "9:00 AM, 1:00 PM, or 4:30 PM"
 *   all_open_times  sixteen slots, 09:00 to 16:30, INCLUDING 14:00
 *   total_open      16                    <- the call reported verified_slots 16
 * A point check instead verifies exactly one slot, which is a different call
 * and would let this whole file pass for the wrong reason.
 */
async function listedTheDay(callSid) {
  const s = await bootLive({ config: CONFIG, callSid });
  await s.callerSays("What have you got on Friday?");
  await s.callTool("check_appointment_availability", { requested_at: DAY });
  return s;
}

describe("a denial of a slot the system itself listed as open", () => {
  it("counts CA6df19e98's actual sentence", async () => {
    const s = await listedTheDay("CA_deny_real");
    await s.assistantTurn(
      "I'm sorry, 2:00 PM is not available. We do have 1:00 PM or 4:30 PM open tomorrow, September 18th. Which of those would you prefer?"
    );

    expect(counters().availability_denial_spoken).toBe(1);
    expect(counters().availability_denied_verified_open).toBe(1);
  });

  it("reads the clock in words, which is how 3.8 speaks it", async () => {
    // aab2f12 had to fix exactly this once already: slotMention generated digit
    // forms only, and 3.8 says "two o'clock". A detector that cannot read the
    // model's own register counts zero and reports it as good news.
    const s = await listedTheDay("CA_deny_words");
    await s.assistantTurn("I'm afraid two o'clock is not available that day.");
    expect(counters().availability_denied_verified_open).toBe(1);
  });

  // -------------------------------------------------------------------------
  // SENTENCE BY SENTENCE, and this is the case that makes it load bearing.
  // The real reply turns ONE time down and offers TWO others in the same
  // breath. A reply-level test counts all three and the number means nothing.
  // -------------------------------------------------------------------------
  it("does not count the alternatives offered in the same reply", async () => {
    const s = await listedTheDay("CA_deny_alts");
    await s.assistantTurn(
      "I'm sorry, 2:00 PM is not available. We do have 1:00 PM or 4:30 PM open tomorrow, September 18th."
    );
    // ONE, not three. 1:00 PM and 4:30 PM are in the verified set as well and
    // are named in the same reply -- scored reply-level this reads 3, which is
    // exactly what the denial-reply-level sabotage row now produces. The
    // counter is per SLOT, so this number can only stay 1 if the sentence
    // boundary is real.
    expect(counters().availability_denied_verified_open).toBe(1);
  });

  it("stays silent on an ordinary offer", async () => {
    const s = await listedTheDay("CA_deny_none");
    await s.assistantTurn(
      "We have several times available tomorrow, Friday, September 18th, such as 9:00 AM, 1:00 PM, or 4:30 PM. Which works best?"
    );
    expect(counters().availability_denial_spoken).toBe(0);
    expect(counters().availability_denied_verified_open).toBe(0);
  });

  it("separates a denial of a time nothing ever verified", async () => {
    // 7:00 PM is outside the tenant's hours and was never listed, so turning it
    // down is CORRECT. The denominator still moves; the fault counter must not.
    const s = await listedTheDay("CA_deny_unlisted");
    await s.assistantTurn("I'm sorry, 7:00 PM is not available — we close at 5.");
    expect(counters().availability_denial_spoken).toBe(1);
    expect(counters().availability_denied_verified_open).toBe(0);
  });

  it("cannot fire before anything has been verified", async () => {
    // No availability call at all: there is no record to contradict, so the
    // structural half has nothing to say and the counter stays honest.
    const s = await bootLive({ config: CONFIG, callSid: "CA_deny_unarmed" });
    await s.callerSays("Can I have 2 PM on Friday?");
    await s.assistantTurn("I'm sorry, 2:00 PM is not available.");
    expect(counters().availability_denied_verified_open).toBe(0);
  });
});
