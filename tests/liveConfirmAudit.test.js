// ---------------------------------------------------------------------------
// Round A1, T6 — the per-call `confirm` block in live_call_summary, and one
// `save_confirmations` event per save.
//
// A1's done-when is per CALL (report-the-unit-a-caller-feels): on the live
// calls, saves_over_one_readback = 0 and gate refusals <= 1 per save. Before
// this, write-gate refusals were process counters and log lines only, so no
// call could answer "how many times was THIS caller asked?".
//
// Read-backs are attributed to the save they precede; a read-back spoken in
// the same breath as the save (tool first, words after, which is the usual
// Live order) belongs to that save, not the next one. Ladder lines never count.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, fakeDb } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { composeReadBack } from "../lib/voice/savePolicy.js";

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
  allowedTasks: ["book_appointment", "check_appointment"],
  afterHoursPolicy: "take_message",
  capabilities: { appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 1 } } },
};
const SLOT = "2026-09-18T14:00:00";
const ARGS = { client_name: "Jon Dodla", scheduled_at: SLOT, notes: "strategy call" };
const READ_BACK = composeReadBack({ toolName: "book_appointment", args: ARGS, config: CONFIG });
const SPELLED_READ_BACK = composeReadBack({ toolName: "book_appointment", args: ARGS, config: CONFIG, callerSpelled: true });
const OFFER = "Just to confirm, Friday, September 18 at 2:00 PM for Jon Dodla. Does that sound right?";

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
});
afterAll(() => vi.useRealTimers());

let prior;
beforeEach(() => {
  clearStats();
  prior = process.env.VOICE_SPELL_POLICY;
  process.env.VOICE_SPELL_POLICY = "off";
  return () => {
    if (prior === undefined) delete process.env.VOICE_SPELL_POLICY;
    else process.env.VOICE_SPELL_POLICY = prior;
  };
});

/** Run a call and return its live_call_summary and save_confirmations events. */
async function record(run) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    if (typeof chunk === "string") lines.push(...chunk.split("\n"));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  const parse = (ev) => lines.filter((l) => l.includes(`"event":"${ev}"`)).map((l) => JSON.parse(l));
  const summaries = parse("live_call_summary");
  expect(summaries).toHaveLength(1);
  return { summary: summaries[0], saves: parse("save_confirmations") };
}

async function availability(s) {
  await s.callTool("check_appointment_availability", { requested_at: SLOT });
  await s.callerSays("Friday at two works.");
}

describe("the confirm block", () => {
  it("one read-back, one save: nothing over one", async () => {
    const { summary, saves } = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_conf_one" });
      await availability(s);
      await s.assistantTurn(READ_BACK);
      await s.callerSays("Yes.");
      await s.callTool("book_appointment", ARGS);
      await s.assistantTurn("You're all set.");
      await s.hangUp();
    });
    expect(summary.confirm).toMatchObject({
      saves: 1,
      readbacks: 1,
      gate_refusals: 0,
      max_readbacks_per_save: 1,
      saves_over_one_readback: 0,
    });
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ tool: "book_appointment", rule: "booking", readbacks: 1, refusals: 0 });
  });

  it("the caller asked twice: saves_over_one_readback 1", async () => {
    const { summary, saves } = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_conf_two" });
      await availability(s);
      await s.assistantTurn(OFFER);
      await s.callerSays("Yes.");
      await s.assistantTurn(OFFER);
      await s.callerSays("Yes, I said yes.");
      await s.callTool("book_appointment", ARGS);
      await s.assistantTurn("You're all set.");
      await s.hangUp();
    });
    expect(summary.confirm.saves_over_one_readback).toBe(1);
    expect(summary.confirm.max_readbacks_per_save).toBe(2);
    expect(saves[0].readbacks).toBe(2);
  });

  it("a read-back spoken in the same breath as the save belongs to that save", async () => {
    const { summary, saves } = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_conf_breath" });
      await availability(s);
      // Words, then the tool, in ONE turn: the read-back is still being
      // spoken (turnReplyText) when the tool fires, and the turn ends after.
      await s.assistantSays(READ_BACK);
      await s.callTool("book_appointment", ARGS);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(saves).toHaveLength(1);
    expect(saves[0].readbacks).toBe(1);
    expect(summary.confirm.readbacks).toBe(1);
    expect(summary.confirm.saves_over_one_readback).toBe(0);
  });

  it("counts each refusal by its gate, on the call and on the save", async () => {
    const { summary, saves } = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_conf_refused" });
      await availability(s);
      await s.assistantTurn("Great, and can I take your name?");
      await s.callerSays("Jon Dodla. Book it.");
      // No read-back standing: refused once, handed the sentence.
      await s.callTool("book_appointment", ARGS);
      await s.assistantTurn(READ_BACK);
      await s.callerSays("Yes.");
      await s.callTool("book_appointment", ARGS);
      await s.assistantTurn("You're all set.");
      await s.hangUp();
    });
    expect(summary.confirm.gate_refusals).toBe(1);
    expect(summary.confirm.refusals_by_gate).toEqual({
      consent: 0,
      hesitation: 0,
      unusable: 0,
      write_order: 1,
      spelling: 0,
    });
    expect(saves[0]).toMatchObject({ readbacks: 1, refusals: 1 });
  });

  it("a booking's read-backs are the ones that name its slot", async () => {
    // Final review: "I'm putting you through" / a read-back of a slot that was
    // then changed is not a read-back of THIS booking.
    const { summary, saves } = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_conf_slot" });
      await availability(s);
      await s.assistantTurn("Just to confirm, Friday, September 18 at 10:00 AM for Jon Dodla. Does that sound right?");
      await s.callerSays("Actually, make it two.");
      await s.assistantTurn(READ_BACK);
      await s.callerSays("Yes.");
      await s.callTool("book_appointment", ARGS);
      await s.assistantTurn("You're all set.");
      await s.hangUp();
    });
    expect(saves[0].readbacks).toBe(1);
    expect(summary.confirm.saves_over_one_readback).toBe(0);
    // Both turns were read-backs; only one was of this booking.
    expect(summary.confirm.readbacks).toBe(2);
  });

  it("ladder lines are never counted as read-backs", async () => {
    const { summary } = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_conf_ladder" });
      await availability(s);
      await s.assistantTurn(READ_BACK);
      await s.feed(12_000);
      // The model speaks whatever the ladder handed it.
      await s.assistantTurn("Hello? Are you still there?");
      await s.callerSays("Yes.");
      await s.callTool("book_appointment", ARGS);
      await s.hangUp();
    });
    expect(summary.confirm.readbacks).toBe(1);
  });
});

describe("spelling", () => {
  it("counts the ask, and a read-back that spelled the surname the caller spelled", async () => {
    const { summary } = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_conf_spelled" });
      await availability(s);
      await s.assistantTurn("Could you spell your last name for me?");
      await s.callerSays("It's Jon, D O D L A.");
      await s.assistantSays(SPELLED_READ_BACK);
      await s.callTool("book_appointment", ARGS);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.spell_asks).toBe(1);
    expect(summary.confirm.readback_spelled).toBe(1);
    expect(summary.confirm.readback_spelled_missing).toBe(0);
  });

  it("counts a read-back that did NOT spell a surname the caller spelled", async () => {
    const { summary } = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_conf_unspelled" });
      await availability(s);
      await s.callerSays("It's Jon, D O D L A.");
      await s.assistantSays(READ_BACK);
      await s.callTool("book_appointment", ARGS);
      await s.turnEnds();
      await s.hangUp();
    });
    expect(summary.confirm.readback_spelled).toBe(0);
    expect(summary.confirm.readback_spelled_missing).toBe(1);
  });

  it("nothing spelled, nothing counted", async () => {
    const { summary } = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_conf_nospell" });
      await availability(s);
      await s.assistantTurn(READ_BACK);
      await s.callerSays("Yes.");
      await s.callTool("book_appointment", ARGS);
      await s.hangUp();
    });
    expect(summary.confirm.readback_spelled).toBe(0);
    expect(summary.confirm.readback_spelled_missing).toBe(0);
  });
});

// Round A1 part 3, review I2 (owner 2026-10-15: prompt only, COUNTED). A name
// on file is never asked for; the one read-back should spell its surname. The
// code hands that sentence only when the model calls before speaking, so a
// model that reads back on its own may leave the letters out -- counted here,
// read on the live call.
describe("an on-file name: was its surname spelled in the read-back?", () => {
  const ON_FILE = { upcomingAppointments: [{ id: "a0", client_name: "Jon Dodla", scheduled_at: "2026-09-21T15:00:00Z" }] };
  const bootOnFile = (callSid) =>
    bootLive({ config: CONFIG, callSid, database: { ...fakeDb(CONFIG, "biz-1"), fetchCallerContext: async () => ON_FILE } });
  const BOOK = { ...ARGS, in_addition_to_existing: true };

  it("a read-back with no letters is counted", async () => {
    const { summary } = await record(async () => {
      const s = await bootOnFile("CA_conf_onfile_plain");
      await availability(s);
      await s.assistantTurn(READ_BACK);
      await s.callerSays("Yes.");
      await s.callTool("book_appointment", BOOK);
      await s.assistantTurn("You're all set.");
      await s.hangUp();
    });
    expect(summary.confirm.saves).toBe(1);
    expect(summary.confirm.onfile_saves).toBe(1);
    expect(summary.confirm.onfile_readback_unspelled).toBe(1);
  });

  it("a read-back that spells it is not", async () => {
    const { summary } = await record(async () => {
      const s = await bootOnFile("CA_conf_onfile_spelled");
      await availability(s);
      await s.assistantTurn(SPELLED_READ_BACK);
      await s.callerSays("Yes.");
      await s.callTool("book_appointment", BOOK);
      await s.assistantTurn("You're all set.");
      await s.hangUp();
    });
    expect(summary.confirm.onfile_saves).toBe(1);
    expect(summary.confirm.onfile_readback_unspelled).toBe(0);
  });

  it("a name not on file is neither", async () => {
    const { summary } = await record(async () => {
      const s = await bootLive({ config: CONFIG, callSid: "CA_conf_onfile_none" });
      await availability(s);
      await s.assistantTurn(READ_BACK);
      await s.callerSays("Yes.");
      await s.callTool("book_appointment", ARGS);
      await s.assistantTurn("You're all set.");
      await s.hangUp();
    });
    expect(summary.confirm.onfile_saves).toBe(0);
    expect(summary.confirm.onfile_readback_unspelled).toBe(0);
  });
});
