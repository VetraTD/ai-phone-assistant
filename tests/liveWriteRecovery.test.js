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
import { bootLive, counters, fakeDb } from "./helpers/liveBoot.js";
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
  // LVX179 (owner, 2026-10-16): a BOOKING is saved only on an answer to the
  // ONE question that is not a no -- the write-order ceiling and the attempt
  // budget never release one (CA954592 #2-4 changed the same way). A hedge
  // ("Hmm, maybe.") is not that answer, and two apologies do not make it one.
  // Before LVX179 this test certified that the ceiling released here.
  it("a hedge to the one question is never released by the ceiling, apologies or not — CAad88df4a", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_ceiling_history" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday afternoon please.");

    // The read-back is made and the caller's yes is NOT heard -- the shape
    // 40% of all write-order refusals actually have, because the model is its
    // own recogniser and the transcript is a degraded copy. "gone" is a real
    // one from the corpus: the caller said "go on". Since 2026-10-02 (owner,
    // batch 2) a mangled yes after a read-back writes at once, so the ceiling
    // this test certifies is now reached by a HEDGE instead.
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Hmm, maybe.");
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
    expect(ok(second), "a booking-rule write was released without an answer").toBe(false);
    expect(counters().write_order_gate_ceiling || 0).toBe(0);
    expect(s.store.scheduled()).toHaveLength(0);
    // The ONE question is handed again, so the caller can answer it.
    expect(String(second[0]?.response?.message || "")).toMatch(/is that right\?/);
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
    // Round A1: was "" (silence). Under "save unless it HEARS a no" a silent
    // answer to a read-back now saves a booking, so the refusal this test needs
    // comes from an answer every rule reads as a hold.
    await s.callerSays("Hang on.");
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

  // LVX179 Fix 3 + LVX180 (owner, 2026-10-16): right after a booking on this
  // call, the caller's words decide. "Also" says it is an extra one, so there
  // is no in-addition question: the one read-back, the yes, booked. (The
  // in-addition question for a booking already ON FILE from an earlier call
  // is tests/a1InAddition.test.js.)
  it("an 'also' right after a booking is an extra one: no in-addition question, booked on the yes", async () => {
    const s = await alreadyBooked("CA_inaddition_readback");
    await s.callTool("check_appointment_availability", { requested_at: SECOND_SLOT });
    await s.callerSays("Can I also take four thirty?");
    await s.assistantTurn(SECOND_READ_BACK);
    await s.callerSays("Yes please.");

    const res = await s.callTool("book_appointment", bookArgs(SECOND_SLOT));
    expect(ok(res)).toBe(true);
    expect(s.store.scheduled()).toHaveLength(2);
  });

  it("books it on the caller's yes, without the model setting anything", async () => {
    // THE WHOLE POINT. The model does not have to get the argument right for
    // the booking to land -- it was told twice on CAad88df4a and did not.
    // Since LVX179 Fix 3, unclear words right after a booking get ONE named
    // question ("Shall I move ..., or keep both?"). The model only has to call
    // again with the SAME details; the caller's words ("book both") decide
    // that it is an extra one -- no flag for the model to set.
    const s = await alreadyBooked("CA_inaddition_retry");
    await s.callTool("check_appointment_availability", { requested_at: SECOND_SLOT });
    await s.callerSays("What about four thirty?");
    const held = await s.callTool("book_appointment", bookArgs(SECOND_SLOT));
    expect(ok(held)).toBe(false);
    const asked = /"(Shall I move [^"]*or keep both\?)"/.exec(String(held[0]?.response?.message || ""));
    expect(asked, "the move-or-keep question was not handed").toBeTruthy();
    expect(s.store.scheduled()).toHaveLength(1);
    await s.turnEnds();

    await s.assistantTurn(asked[1]);
    await s.callerSays("Yes, book both.");
    const again = await s.callTool("book_appointment", bookArgs(SECOND_SLOT));
    expect(ok(again)).toBe(true);
    await s.turnEnds();
    await s.settle();

    expect(s.store.scheduled(), "the second booking never landed").toHaveLength(2);
  });

  // LVX160 for a booking already ON FILE from an earlier call (Fix 3 handles one
  // made on THIS call). The pack refuses, stores the corrected arguments with the
  // flag, and the caller's yes releases them -- the model sets nothing.
  it("a booking already on file: the caller's yes releases the stash with the flag", async () => {
    const onFile = { id: "appt-onfile", client_name: CLIENT, scheduled_at: "2026-09-18T20:30:00.000Z" };
    const s = await bootLive({
      config: CONFIG,
      callSid: "CA_inaddition_onfile",
      seedAppointments: [{ ...onFile, business_id: "biz-1", client_phone: "+15551234567", status: "scheduled" }],
      database: {
        ...fakeDb(CONFIG, "biz-1"),
        fetchCallerContext: async () => ({ callCount: 2, upcomingAppointments: [onFile] }),
      },
    });
    await s.callTool("check_appointment_availability", { requested_at: SECOND_SLOT });
    await s.callerSays("Can I book four thirty?");
    await s.assistantTurn(SECOND_READ_BACK);
    await s.callerSays("Yes please.");
    const held = await s.callTool("book_appointment", bookArgs(SECOND_SLOT));
    expect(ok(held)).toBe(false);
    expect(String(held[0]?.response?.message || "")).toMatch(/in_addition_to_existing/);
    expect(s.store.scheduled()).toHaveLength(1);
    await s.turnEnds();

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

// ---------------------------------------------------------------------------
// LVX162 / LVX163 — the two defects three real calls found on 2026-09-20.
// ---------------------------------------------------------------------------
describe("a booking made on the call can be changed on the call", () => {
  it("carries the row id into the caller snapshot — CA1d405002", async () => {
    // The caller booked at 06:52:04 and asked to cancel it seconds later. NINE
    // cancel attempts failed, including three the consent gate had already
    // released, because the snapshot row written by the booking had `id: null`
    // and nothing could name a row. It worked at 06:54:20, immediately after
    // the model re-ran the lookup itself.
    //
    // Eighty seconds, two false claims, and an offer to have someone call back.
    const s = await bootLive({ config: CONFIG, callSid: "CA_book_then_cancel" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday at three thirty please.");
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes, that works.");
    expect(ok(await s.callTool("book_appointment", bookArgs()))).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);

    // Straight into a cancellation, with NO lookup in between -- which is the
    // whole point: the model has no id of its own and must get one from the
    // snapshot the booking just wrote.
    await s.callerSays("Actually, cancel that please.");
    await s.assistantTurn(
      "To confirm, you would like to cancel your strategy call on Friday, September eighteenth at three thirty PM?"
    );
    await s.callerSays("Yes, cancel it.");
    const res = await s.callTool("cancel_appointment_db", {});

    expect(ok(res), "the cancellation could not name the row the call just booked").toBe(true);
    expect(s.store.scheduled()).toHaveLength(0);
  });

  // Round A1 Part 6: the history rule on a CANCEL (CAad88df4a's own tool) -- restores ceiling-ignores-history.
  // Since LVX179 a booking is never released by the ceiling, so a CANCEL is the
  // only write that still shows whether an apology buys the gate a refusal.
  it("an apology after a refused cancellation does not raise the ceiling — CAad88df4a", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_cancel_ceiling_history" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday at three thirty please.");
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes, that works.");
    expect(ok(await s.callTool("book_appointment", bookArgs()))).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);

    await s.callerSays("Actually, cancel that please.");
    await s.assistantTurn(
      "To confirm, you would like to cancel your strategy call on Friday, September eighteenth at three thirty PM?"
    );
    await s.callerSays("Hmm, maybe.");
    const first = await s.callTool("cancel_appointment_db", {});
    expect(ok(first), "a hedge was taken as a yes").toBe(false);
    expect(s.store.scheduled()).toHaveLength(1);

    // Two apologies, none re-reading the proposal: the read-back ages out.
    await s.assistantTurn(APOLOGY_ONE);
    await s.callerSays("What? I just said yes.");
    await s.assistantTurn(APOLOGY_TWO);
    await s.callerSays("I do not want to leave a message.");

    // Same proposal, already read back once and refused once: AT its ceiling.
    const second = await s.callTool("cancel_appointment_db", {});
    expect(ok(second), String(second[0]?.response?.message || "")).toBe(true);
    expect(counters().write_order_gate_ceiling || 0).toBe(1);
    expect(counters().write_order_ceiling_kept_by_history || 0).toBe(1);
    expect(s.store.scheduled()).toHaveLength(0);
  });
});

describe("a write and a hang-up in the SAME tool batch", () => {
  it("does not let a stale ask cover the write beside it — CA1dfe055f", async () => {
    // 06:47:33  "...Is there anything else I can help you with today?"  <- 0 actions
    // 06:49:03.326  book_appointment  SUCCESS
    // 06:49:03.330  end_call          ALLOWED, four milliseconds later
    // 06:49:08  "That's all set, and your appointment is booked..."     <- no ask
    //
    // end_call_refusals read {no_ask: 0} on the exact shape LVX157 exists for.
    // The mirrored action count in live/index.js is a round behind, so the
    // hang-up was judged against the world before the booking landed.
    const s = await bootLive({ config: CONFIG, callSid: "CA_batch_stale_ask" });
    await s.callTool("get_caller_appointments_from_db", {});
    await s.assistantTurn(
      "I've checked the records for this number, and I don't see any upcoming appointments. Is there anything else I can help you with today?"
    );
    await s.callerSays("Yes, I'd like to book one.");
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes, that works.");

    // Both in one batch, in the order the model sent them.
    const out = await s.callToolBatch([
      ["book_appointment", bookArgs()],
      ["end_call", {}],
    ]);

    const booked = out.find((r) => r.name === "book_appointment");
    const ended = out.find((r) => r.name === "end_call");
    expect(booked?.response?.success, "the booking itself must still land").toBe(true);
    expect(
      ended?.response?.success,
      "the hang-up was allowed by an ask that predated the booking beside it"
    ).toBe(false);
    expect(counters().end_call_refused_no_ask).toBe(1);
    expect(counters().live_ask_latch_stale_at_action).toBe(1);
  });

  it("still allows the hang-up when the ask came after the write", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_batch_fresh_ask" });
    await s.callTool("check_appointment_availability", { requested_at: SLOT });
    await s.callerSays("Friday at three thirty please.");
    await s.assistantTurn(READ_BACK);
    await s.callerSays("Yes, that works.");
    expect(ok(await s.callTool("book_appointment", bookArgs()))).toBe(true);
    await s.assistantTurn("That's booked. Is there anything else I can help you with today?");
    await s.callerSays("No, that's everything.");

    expect(ok(await s.callTool("end_call", {}))).toBe(true);
    expect(counters().end_call_refused_no_ask ?? 0).toBe(0);
  });
});
