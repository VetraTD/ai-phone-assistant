// ---------------------------------------------------------------------------
// THE TWO WAYS A WRITE THE CALLER ASKED FOR ENDED WITH NOTHING WRITTEN.
//
// Measured over call-corpus/, all of it predating these fixes: of the calls
// that ATTEMPTED each write, the share that ended with no row at all was
// book 24% (5 of 21), cancel 21% (4 of 19), reschedule 33% (3 of 9). Eight of
// 37 calls needed three or more write-order refusals before anything landed;
// one needed nine. This is not a tail case, it is the main failure mode.
//
// LVX161 -- THE APOLOGY THAT RAISED THE CEILING.
//   The release ceiling is one refusal when the proposal was read back and two
//   when it was not. `readBackMade` looks only at the immediately preceding
//   turn pair, so when the model answered a refusal with an APOLOGY instead of
//   re-reading the proposal back, the read-back aged out, the flag went false,
//   and the ceiling ROSE. The model apologising bought the gate another refusal
//   against the caller.
//
// LVX160 -- THE ARGUMENT THE MODEL WOULD NOT SET.
//   A booking for a caller who already has one is refused unless
//   `in_addition_to_existing` is set, and the refusal says so in those words.
//   On CAad88df4a the model asked the caller the right question TWICE and never
//   re-sent the call with the flag. Six rewordings of a refusal have failed to
//   make this model change a tool argument, so the corrected argument is now
//   stored rather than requested, and released by the caller's own answer.
//
// Both are about the same thing: a caller who said yes and got nothing.
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
/** The sentences CAad88df4a actually used, which is what makes the ceiling rise. */
const APOLOGY_ONE =
  "I am so sorry, but I am unable to process that right now. Please allow me to take your details so someone on the team can follow up with you.";
const APOLOGY_TWO =
  "I'm not able to get into the details of why the system isn't working right now. Would you like to leave your name and callback number?";

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
const bookArgs = (slot = SLOT) => ({ client_name: CLIENT, scheduled_at: slot });

// ---------------------------------------------------------------------------
// LVX161
// ---------------------------------------------------------------------------
describe("an apology must not buy the gate another refusal", () => {
  it("keeps the earlier read-back, so the second refusal releases — CAad88df4a", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_ceiling_history" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday afternoon please.");

    // The read-back is made and the caller's yes is NOT heard -- the shape
    // 40% of all write-order refusals actually have, because the model is its
    // own recogniser and the transcript is a degraded copy. "gone" is a real
    // one from the corpus: the caller said "go on".
    await s.assistantTurn(READ_BACK);
    await s.callerSays("gone");
    expect(ok(await s.callTool("book_appointment", bookArgs()))).toBe(false);

    // The model apologises instead of re-reading it back. Two turns, exactly as
    // on the real call, which is what pushed the read-back out of view.
    //
    // The caller's turns here must carry WORDS. The refusal budget increments
    // per caller turn (`orderRefusalIsNew`), and an empty transcript does not
    // advance `callerTurnCount` -- so a version of this test that used "" never
    // reached a second counted refusal and read as the fix not working.
    await s.assistantTurn(APOLOGY_ONE);
    await s.callerSays("What? I just said yes.");
    await s.assistantTurn(APOLOGY_TWO);
    await s.callerSays("I do not want to leave a message.");

    // Same proposal, already read back once, already refused once. It is AT its
    // ceiling and must be released.
    const second = await s.callTool("book_appointment", bookArgs());
    expect(ok(second), "the ceiling did not release -- the apology raised it").toBe(true);
    expect(counters().write_order_gate_ceiling).toBe(1);
    expect(counters().write_order_ceiling_kept_by_history).toBe(1);
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("still gives a proposal nobody was ever asked about the full budget", async () => {
    // The other direction, and it must not move: with no read-back ever made
    // for this proposal, releasing on the second attempt would write something
    // the caller was never put to. That is what the higher ceiling is for.
    const s = await bootLive({ config: CONFIG, callSid: "CA_ceiling_unasked" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday afternoon please.");
    await s.assistantTurn("Let me get that sorted for you.");

    expect(ok(await s.callTool("book_appointment", bookArgs()))).toBe(false);
    await s.assistantTurn("One moment.");
    await s.callerSays("");
    expect(ok(await s.callTool("book_appointment", bookArgs()))).toBe(false);
    expect(counters().write_order_ceiling_kept_by_history ?? 0).toBe(0);
    expect(s.store.scheduled()).toHaveLength(0);
  });

  it("gives a NEW proposal a fresh budget, because nobody has been asked about it", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_ceiling_newproposal" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday afternoon please.");
    await s.assistantTurn(READ_BACK);
    await s.callerSays("");
    expect(ok(await s.callTool("book_appointment", bookArgs()))).toBe(false);

    // The caller changes their mind. A different time is a different question,
    // and the history of the old one must not spend the new one's budget.
    await s.assistantTurn("Of course, let me look at four thirty instead.");
    await s.callerSays("Actually make it four thirty.");
    expect(ok(await s.callTool("book_appointment", bookArgs(SECOND_SLOT)))).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LVX160
// ---------------------------------------------------------------------------
describe("the booking argument the model would not set", () => {
  /** One booking already on the call, which is what makes the caller "existing". */
  async function alreadyBooked(callSid) {
    const s = await bootLive({ config: CONFIG, callSid });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday at three thirty please.");
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes, that works.");
    expect(ok(await s.callTool("book_appointment", bookArgs()))).toBe(true);
    return s;
  }

  it("refuses a second booking with a read-back the caller can answer", async () => {
    const s = await alreadyBooked("CA_inaddition_readback");
    await s.callTool("check_appointment_availability", { requested_at: SECOND_SLOT });
    await s.callerSays("Can I also take four thirty?");
    await s.assistantTurn(SECOND_READ_BACK);
    await s.callerSays("Yes please.");

    const res = await s.callTool("book_appointment", bookArgs(SECOND_SLOT));
    expect(ok(res)).toBe(false);
    // The MODEL is told to set the flag...
    expect(res[0].response.message).toMatch(/in_addition_to_existing/);
    // ...and the CALLER gets a question that names the time, so their answer
    // means something. The old either/or named no time and could not be
    // answered yes, so nothing downstream could act on the reply.
    // The caller-safe line is asserted in tests/appointments.test.js, where the
    // pack is called directly and stateEffects.toolResult is reachable. Here the
    // behavioural consequence is what matters, and the next two cases are it.
  });

  it("books it on the caller's yes, without the model setting anything", async () => {
    // THE WHOLE POINT. The model does not have to get the argument right for
    // the booking to land -- it was told twice on CAad88df4a and did not.
    const s = await alreadyBooked("CA_inaddition_retry");
    await s.callTool("check_appointment_availability", { requested_at: SECOND_SLOT });
    await s.callerSays("Can I also take four thirty?");
    await s.assistantTurn(SECOND_READ_BACK);
    await s.callerSays("Yes please.");
    expect(ok(await s.callTool("book_appointment", bookArgs(SECOND_SLOT)))).toBe(false);
    expect(s.store.scheduled()).toHaveLength(1);

    // The model asks, the caller agrees, and the stash is released with the
    // flag the pack asked for.
    await s.assistantTurn(
      "You already have an appointment with us — shall I book this additional one for Friday at four thirty as well?"
    );
    await s.callerSays("Yes, book both.");
    await s.turnEnds();
    await s.settle();

    expect(s.store.scheduled(), "the second booking never landed").toHaveLength(2);
  });

  it("is not released by the spelling gate, only by agreement", async () => {
    // THE DEFECT THIS TEST EXISTS FOR, and it nearly shipped.
    //
    // retryPendingWrite fires on `spellingSettled` ALONE, with no agreement
    // anywhere in the condition. That is right for a write the spelling gate
    // held -- already consented to, waiting only on letters -- and wrong for
    // this one, which is created the instant the pack refuses and carries
    // `in_addition_to_existing: true`. The first run of this file wrote a
    // second appointment for a caller who said "No, move the first one".
    //
    // Reaching the pack WITHOUT a fresh affirmative takes the ceiling: refuse a
    // read-back proposal twice and LVX161 releases it, so consent is satisfied
    // by the budget rather than by a "yes" on this turn.
    const s = await alreadyBooked("CA_inaddition_spelling");
    await s.callTool("check_appointment_availability", { requested_at: SECOND_SLOT });
    await s.callerSays("What about four thirty?");
    await s.assistantTurn(SECOND_READ_BACK);
    await s.callerSays("gone");
    expect(ok(await s.callTool("book_appointment", bookArgs(SECOND_SLOT)))).toBe(false);
    await s.assistantTurn(APOLOGY_ONE);
    await s.callerSays("I do not want to leave a message.");

    // The ceiling releases the write-order gate, the pack refuses it for the
    // missing flag, and the stash is created on a turn whose caller text is not
    // an agreement to anything.
    expect(ok(await s.callTool("book_appointment", bookArgs(SECOND_SLOT)))).toBe(false);
    await s.assistantTurn("Let me check something for you.");
    await s.callerSays("I am still waiting.");
    await s.turnEnds();
    await s.settle();

    expect(
      s.store.scheduled(),
      "the spelling gate released a booking nobody agreed to"
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// LVX160's third half: the evidence that was missing
// ---------------------------------------------------------------------------
describe("what the model actually sent", () => {
  it("logs the argument NAMES and booleans on a write, refused or not", async () => {
    // "The flag was never set" was a deduction on CAad88df4a, reached by reading
    // the refusal branch and the model's own sentences, because tool arguments
    // have never been logged anywhere. Keys and booleans only: an argument name
    // is schema, a boolean is a branch, and neither is caller content.
    const lines = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      if (typeof chunk === "string" && chunk.includes('"event":"write_target"')) lines.push(chunk);
      return true;
    });
    try {
      const s = await bootLive({ config: CONFIG, callSid: "CA_argkeys" });
      await s.callTool("check_appointment_availability", { requested_at: SLOT });
      await s.callerSays("Friday afternoon.");
      await s.callTool("book_appointment", {
        ...bookArgs(),
        in_addition_to_existing: false,
      });
    } finally {
      spy.mockRestore();
    }

    const events = lines
      .flatMap((c) => c.split("\n"))
      .filter((l) => l.includes('"event":"write_target"'))
      .map((l) => JSON.parse(l));
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.arg_keys).toContain("in_addition_to_existing");
    expect(last.arg_keys).toContain("client_name");
    expect(last.arg_flags).toEqual({ in_addition_to_existing: false });
    // The line this log draws: names and booleans, never values.
    expect(JSON.stringify(last)).not.toContain(CLIENT);
  });
});
