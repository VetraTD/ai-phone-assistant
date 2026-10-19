// ---------------------------------------------------------------------------
// LVX179 (P0, 2026-10-16) — the receptionist booked a time the caller never
// chose. Replayed from the three calls of that afternoon, through a real Live
// session and the real gate (tests/helpers/liveBoot.js).
//
// Call b CA70682e: the model listed "9, 1 and 4:30 -- which works best?", the
// caller made a ~1.3 s "umm" (utterance 8, voiced 1,260 ms, no words), and the
// model said a statement read-back of 9 AM and called book_appointment in the
// same breath. `a1_readback: in_turn`, saved. The turn text was cut on the
// call (live_repeat_cut), so the statement below is the shape the probe
// recorded, not the literal words.
//
// Calls d1 CA7c0d50 / d1b CAb3e55: the same same-breath statement saved a slot
// the caller HAD asked for. Under the owner's 2026-10-16 rule both now wait for
// ONE question read-back and an answer that is not a no.
//
// Names are pseudonyms (LVX24). Slots sit on Friday 2026-09-18, inside the
// harness's business week.
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive, fakeDb } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { correctionAfterSave, classifyOrKeepAnswer, anchoredDates } from "../capabilities/appointments.js";

const OPEN = { open: "09:00", close: "18:00", closed: false };
const CONFIG = {
  businessName: "VetraTD Test Line",
  greeting: "Thanks for calling the VetraTD test line.",
  mainPhone: "+18175803291",
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

const AT_9 = "2026-09-18T09:00:00";
const AT_10 = "2026-09-18T10:00:00";
const AT_14 = "2026-09-18T14:00:00";
const book = (scheduled_at, client_name = "Ada Moss") => ({ client_name, scheduled_at, notes: "consultation" });

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

async function boot(callSid) {
  const s = await bootLive({ config: CONFIG, callSid });
  for (const at of [AT_9, "2026-09-18T13:00:00", "2026-09-18T16:30:00", AT_10, AT_14]) {
    await s.callTool("check_appointment_availability", { requested_at: at });
  }
  // The lookups happened earlier in the call, not in the turn under test (the
  // runner caps tool rounds per turn).
  await s.turnEnds();
  return s;
}

describe("LVX179: a booking waits for ONE question and an answer", () => {
  it("call b: a listed slot said back as a statement after an 'umm' is NOT booked", async () => {
    const s = await boot("CA70682e_replay");
    await s.callerSays("Ahm, Friday the 18th maybe. Actually, what do you have available on that day?");
    await s.assistantTurn(
      "On Friday, September 18th, we have openings at 9 00 AM, 1 00 PM, and 4 30 PM. Which of those works best for Ada?"
    );
    // The "umm": sound the model heard, no words.
    await s.feed(1260, { voiced: true });
    await s.feed(600);
    await s.assistantSays("Friday, September 18 at 9 AM for Ada Moss, booking that now.");
    const [r] = await s.callTool("book_appointment", book(AT_9));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
    // Handed the ONE question to ask, not a statement.
    expect(r.response.message).toMatch(/is that right\?/);
    expect(r.response.message).not.toMatch(/booking that now/);
  });

  it("call b, continued: the caller's own time is asked once, answered, and booked once", async () => {
    const s = await boot("CA70682e_replay2");
    await s.assistantTurn(
      "On Friday, September 18th, we have openings at 9 00 AM, 1 00 PM, and 4 30 PM. Which of those works best for Ada?"
    );
    await s.callerSays("What? No, I didn't even say anything. Just give me like 10:00 a.m.");
    await s.assistantTurn("So that's Friday, September 18 at 10 AM for Ada Moss, is that right?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(true);
    const rows = s.store.scheduled();
    expect(rows).toHaveLength(1);
    expect(Date.parse(rows[0].scheduled_at)).toBe(Date.parse(`${AT_10}-05:00`));
    // After the save: only "Done, you're all set" -- never the details again.
    expect(r.response.message).toMatch(/Done, you're all set/);
  });

  it("call b's second write: a 'just to confirm' that never named the time does not book it", async () => {
    const s = await boot("CA70682e_replay3");
    await s.callerSays("Just give me like 10:00 a.m.");
    await s.assistantTurn(
      "That time is available. Just to confirm, this appointment is an additional one beyond the ones already booked, correct?"
    );
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
    expect(r.response.message).toMatch(/is that right\?/);
  });

  it("call d1: a same-breath statement for the slot the caller asked for is held, then saved after one question", async () => {
    const s = await boot("CA7c0d50_replay");
    await s.callerSays("I'd like to book another appointment. Maybe for Friday the 18th at 2:00 p.m.");
    await s.assistantSays("Friday at 2 PM for Ada Moss, booking that now.");
    const [held] = await s.callTool("book_appointment", book(AT_14));
    expect(held.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
    await s.turnEnds();

    await s.assistantTurn("So that's Friday, September 18 at 2 PM for Ada Moss, is that right?");
    await s.callerSays("Yeah.");
    const [r] = await s.callTool("book_appointment", book(AT_14));
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("call d1b: a question asked in the SAME turn as the call waits for the answer (silence holds)", async () => {
    const s = await boot("CAb3e55_replay");
    await s.callerSays("Can I book something Friday the 18th maybe at 2:00 p.m.?");
    await s.assistantSays("So that's Friday, September 18 at 2 PM for Ada Moss, is that right?");
    const [early] = await s.callTool("book_appointment", book(AT_14));
    expect(early.response.success).toBe(false);
    await s.turnEnds();
    // Nothing heard at all: still held.
    await s.feed(3000);
    const [silent] = await s.callTool("book_appointment", book(AT_14));
    expect(silent.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
    // Any answer that is not a no saves it -- a garbled one included.
    await s.callerSays("entenderlo");
    const [r] = await s.callTool("book_appointment", book(AT_14));
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("a clear no to the one question is never booked, however many times the model retries", async () => {
    const s = await boot("CA_no_retry");
    await s.assistantTurn("So that's Friday, September 18 at 2 PM for Ada Moss, is that right?");
    await s.callerSays("No.");
    for (let i = 0; i < 4; i++) {
      const [r] = await s.callTool("book_appointment", book(AT_14));
      expect(r.response.success).toBe(false);
    }
    expect(s.store.scheduled()).toHaveLength(0);
  });

  it("a statement read-back in the PREVIOUS turn is not the question: held and handed the question", async () => {
    const s = await boot("CA_prev_statement");
    await s.assistantTurn("Friday at 2 PM for Ada Moss, booking that now.");
    await s.callerSays("Okay.");
    const [r] = await s.callTool("book_appointment", book(AT_14));
    expect(r.response.success).toBe(false);
    expect(r.response.message).toMatch(/is that right\?/);
    expect(s.store.scheduled()).toHaveLength(0);
  });
});

describe("LVX179 owner rule 2: a new person's FULL name is spelled", () => {
  it("the one question spells every name the caller spelled, first name too", async () => {
    const { composeReadBack } = await import("../lib/voice/savePolicy.js");
    const q = composeReadBack({
      toolName: "book_appointment",
      args: book(AT_10, "Maya Okafor"),
      config: CONFIG,
      callerSpelled: true,
    });
    expect(q).toContain("for Maya, M-A-Y-A, Okafor, O-K-A-F-O-R, is that right?");
  });

  it("a name on file is said, never spelled", async () => {
    const { composeReadBack } = await import("../lib/voice/savePolicy.js");
    const q = composeReadBack({ toolName: "book_appointment", args: book(AT_10, "Maya Okafor"), config: CONFIG });
    expect(q).toContain("for Maya Okafor, is that right?");
    expect(q).not.toMatch(/[A-Z]-[A-Z]/);
  });

  it("the prompt asks for the first AND last name in one ask, and never asks an on-file caller for a name", async () => {
    const { buildStaticSystemPrefix } = await import("../services/gemini.js");
    const { FIXTURES } = await import("./fixtures/businessConfigs.js");
    const f = FIXTURES["appointments-availability"];
    const saved = process.env.VOICE_SPELL_POLICY;
    delete process.env.VOICE_SPELL_POLICY;
    const prompt = buildStaticSystemPrefix(f.config, f.extras);
    if (saved !== undefined) process.env.VOICE_SPELL_POLICY = saved;
    expect(prompt).toContain("Could you spell the first and last name for me?");
    expect(prompt).toContain("do not ask them for it at all — not even their full name");
  });
});

// Owner, 2026-10-16: "it should not ask again for anything it already got the
// answer to." The answer to the ONE question carries across a spelling, an
// extra-or-move question or anything else, for THAT slot only, until a no, a
// newer proposal or the booking itself.
describe("LVX179: an answer given earlier in the call still counts", () => {
  const Q2 = "So that's Friday, September 18 at 2 PM for Ada Moss, is that right?";
  const Q10 = "So that's Friday, September 18 at 10 AM for Ada Moss, is that right?";

  it("CA03558d's shape: asked, yes, then a spelling exchange -- booked without asking again", async () => {
    const s = await boot("CA03558d_carry");
    await s.assistantTurn(Q2);
    await s.callerSays("Yes.");
    await s.assistantTurn("Before we wrap this up, could you please spell out your full name for me?");
    await s.callerSays("A D A, M O S S");
    await s.assistantTurn("A-D-A M-O-S-S. Is that correct?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_14));
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("a newer proposal supersedes it: the yes now stands for 10, not 2", async () => {
    const s = await boot("CA_carry_superseded");
    await s.assistantTurn(Q2);
    await s.callerSays("Yes.");
    await s.assistantTurn(Q10);
    await s.callerSays("Yes.");
    await s.assistantTurn("Could you spell your surname for me?");
    await s.callerSays("M O S S");
    const [two] = await s.callTool("book_appointment", book(AT_14));
    expect(two.response.success).toBe(false);
    const [ten] = await s.callTool("book_appointment", book(AT_10));
    expect(ten.response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("a no to a newer question clears it", async () => {
    const s = await boot("CA_carry_no");
    await s.assistantTurn(Q2);
    await s.callerSays("Yes.");
    await s.assistantTurn(Q10);
    await s.callerSays("No.");
    await s.assistantTurn("No problem. Which time would you like?");
    await s.callerSays("Hmm, let me think.");
    const [r] = await s.callTool("book_appointment", book(AT_14));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
  });

  it("CA94817d's shape: a yes that names a DIFFERENT time is a change, then and later", async () => {
    const s = await boot("CA94817d_carry");
    await s.assistantTurn("I have you down for Friday, September 18th, at 2 PM. Please confirm if these details are correct.");
    await s.callerSays("Yeah, they're correct. 10:00 a.m. works.");
    const [now] = await s.callTool("book_appointment", book(AT_14));
    expect(now.response.success).toBe(false);
    await s.turnEnds();
    await s.assistantTurn("Could you spell your surname for me?");
    await s.callerSays("M O S S");
    const [later] = await s.callTool("book_appointment", book(AT_14));
    expect(later.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
  });

  it("the booking spends it: a second person at the same time is asked about", async () => {
    const roomy = {
      ...CONFIG,
      capabilities: { appointments: { enabled: true, adapter: "internal", availability: { length: 30, capacity: 2 } } },
    };
    const s = await bootLive({ config: roomy, callSid: "CA_carry_spent" });
    await s.callTool("check_appointment_availability", { requested_at: AT_14 });
    await s.turnEnds();
    await s.assistantTurn(Q2);
    await s.callerSays("Yes.");
    await s.assistantTurn("Thanks. Anything else today?");
    await s.callerSays("And my colleague Bo Lin at the same time.");
    const [ada] = await s.callTool("book_appointment", book(AT_14));
    expect(ada.response.success).toBe(true);
    await s.turnEnds();
    await s.assistantTurn("Got it.");
    await s.callerSays("Thanks.");
    const [bo] = await s.callTool("book_appointment", book(AT_14, "Bo Lin"));
    expect(bo.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// LVX179 Fix 3 (owner, 2026-10-16): a correction right after a save MOVES that
// booking, never adds one. Call b: 9 AM booked, the caller's "10 a.m." became
// a second row through the in-addition question. The caller's words since the
// save decide; unclear words get ONE named question, which is also the
// confirmation (owner 22:55: "code makes it ask once").
// ---------------------------------------------------------------------------
describe("LVX179 Fix 3: a correction right after a save moves that booking", () => {
  const Q9 = "So that's Friday, September 18 at 9 a.m. for Ada Moss, is that right?";

  async function savedAt9(callSid) {
    const s = await boot(callSid);
    await s.assistantTurn(Q9);
    await s.callerSays("Yes.");
    const [saved] = await s.callTool("book_appointment", book(AT_9));
    expect(saved.response.success).toBe(true);
    await s.turnEnds();
    await s.assistantTurn("Done, you're all set.");
    return s;
  }
  const at = (row) => Date.parse(row.scheduled_at);
  const local = (naive) => Date.parse(`${naive}-05:00`);

  it("'no, 10 instead' right after the save: asked once as a move, then ONE row, moved to 10", async () => {
    const s = await savedAt9("CA_fix3_instead");
    await s.callerSays("No, 10 instead.");
    const [ask] = await s.callTool("book_appointment", book(AT_10));
    expect(ask.response.success).toBe(false);
    const asked = String(ask.response.message);
    expect(asked).toMatch(/So that's moving your Friday, September 18 at 9/);
    expect(asked).toMatch(/to 10/);
    expect(asked).not.toMatch(/or keep both/);
    await s.turnEnds();
    await s.assistantTurn("So that's moving your Friday, September 18 at 9 AM to 10 AM for Ada Moss, is that right?");
    await s.callerSays("Yes.");
    const [moved] = await s.callTool("book_appointment", book(AT_10));
    expect(moved.response.success).toBe(true);
    expect(String(moved.response.message)).toMatch(/Done, you're all set/);
    expect(String(moved.response.message)).toMatch(/ONE booking/);
    const rows = s.store.scheduled();
    expect(rows).toHaveLength(1);
    expect(at(rows[0])).toBe(local(AT_10));
  });

  it("'also one at 2' right after the save: an extra one, two rows, no move question", async () => {
    const s = await savedAt9("CA_fix3_also");
    await s.callerSays("Also one at 2, please.");
    const [ask] = await s.callTool("book_appointment", book(AT_14));
    expect(ask.response.success).toBe(false);
    expect(String(ask.response.message)).not.toMatch(/move/i);
    await s.turnEnds();
    await s.assistantTurn("So that's Friday, September 18 at 2 PM for Ada Moss, is that right?");
    await s.callerSays("Yes.");
    const [added] = await s.callTool("book_appointment", book(AT_14));
    expect(added.response.success).toBe(true);
    const rows = s.store.scheduled().map(at).sort();
    expect(rows).toEqual([local(AT_9), local(AT_14)]);
  });

  it("unclear words ('what about 10?'): ONE named question, then 'move it' -> moved, one row", async () => {
    const s = await savedAt9("CA_fix3_unclear_move");
    await s.callerSays("What about 10?");
    const [ask] = await s.callTool("book_appointment", book(AT_10));
    expect(ask.response.success).toBe(false);
    expect(String(ask.response.message)).toMatch(/Shall I move your Friday, September 18 at 9:00 AM to 10:00 AM, or keep both\?/);
    expect(s.store.scheduled()).toHaveLength(1);
    await s.turnEnds();
    await s.assistantTurn("Shall I move your Friday, September 18 at 9 a.m. to 10 a.m., or keep both?");
    await s.callerSays("Move it.");
    const [moved] = await s.callTool("book_appointment", book(AT_10));
    expect(moved.response.success).toBe(true);
    const rows = s.store.scheduled();
    expect(rows).toHaveLength(1);
    expect(at(rows[0])).toBe(local(AT_10));
  });

  it("unclear words, then 'keep both': two rows, and no second question", async () => {
    const s = await savedAt9("CA_fix3_unclear_keep");
    await s.callerSays("What about 10?");
    await s.callTool("book_appointment", book(AT_10));
    await s.turnEnds();
    await s.assistantTurn("Shall I move your Friday, September 18 at 9 a.m. to 10 a.m., or keep both?");
    await s.callerSays("Keep both.");
    const [added] = await s.callTool("book_appointment", book(AT_10));
    expect(added.response.success).toBe(true);
    const rows = s.store.scheduled().map(at).sort();
    expect(rows).toEqual([local(AT_9), local(AT_10)]);
  });

  it("a different person right after the save: the normal path, a second row, nothing moved", async () => {
    const s = await savedAt9("CA_fix3_other_person");
    await s.callerSays("Can you book my colleague Ben Ortiz at 10?");
    const [ask] = await s.callTool("book_appointment", book(AT_10, "Ben Ortiz"));
    expect(ask.response.success).toBe(false);
    expect(String(ask.response.message)).not.toMatch(/move/i);
    expect(String(ask.response.message)).toMatch(/for Ben Ortiz, is that right\?/);
    await s.turnEnds();
    await s.assistantTurn("So that's Friday, September 18 at 10 AM for Ben Ortiz, is that right?");
    await s.callerSays("Yes.");
    const [ben] = await s.callTool("book_appointment", book(AT_10, "Ben Ortiz"));
    expect(ben.response.success).toBe(true);
    const rows = s.store.scheduled().map(at).sort();
    expect(rows).toEqual([local(AT_9), local(AT_10)]);
  });
});

// ---------------------------------------------------------------------------
// Sabotage-row coverage (scripts/corpus/sabotage.mjs, p5- rows): the carried
// answer's own rules, the engine's retry, and a SPOKEN different time. Each
// case below is decided by exactly one guard line.
// ---------------------------------------------------------------------------
describe("LVX179 carry-over rules and the engine's retry", () => {
  const Q2 = "So that's Friday, September 18 at 2 PM for Ada Moss, is that right?";
  const Q10 = "So that's Friday, September 18 at 10 AM for Ada Moss, is that right?";

  it("a newer question about another time clears the carried answer BEFORE it is answered", async () => {
    const s = await boot("CA_carry_cleared_open");
    await s.assistantTurn(Q2);
    await s.callerSays("Yes.");
    await s.assistantTurn(Q10);
    const [two] = await s.callTool("book_appointment", book(AT_14));
    expect(two.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
  });

  it("a cancellation's yes is never carried to a booking of the same time", async () => {
    const s = await boot("CA_carry_cancel_never");
    await s.assistantTurn(Q2);
    await s.callerSays("Yes.");
    const [first] = await s.callTool("book_appointment", book(AT_14));
    expect(first.response.success).toBe(true);
    await s.turnEnds();
    await s.assistantTurn("Done, you're all set.");
    await s.callerSays("Actually, I need to cancel that one.");
    await s.assistantTurn("So that's cancelling your Friday, September 18 at 2 PM appointment for Ada Moss, is that right?");
    await s.callerSays("Yes.");
    const [gone] = await s.callTool("cancel_appointment_db", { appointment_id: s.store.scheduled()[0].id });
    expect(gone.response.success).toBe(true);
    await s.turnEnds();
    await s.assistantTurn("All done with that. Anything else today?");
    await s.callerSays("Yes please.");
    const [r] = await s.callTool("book_appointment", book(AT_14, "Bo Lin"));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
  });

  it("the engine's retry of a booking needs a question about ITS slot, not another one's", async () => {
    const s = await boot("CA_retry_own_slot");
    await s.assistantTurn(Q2);
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10), { id: "retry_book_appointment" });
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
  });

  it("...and the same retry for the slot that was asked about is saved", async () => {
    const s = await boot("CA_retry_own_slot_ok");
    await s.assistantTurn(Q10);
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10), { id: "retry_book_appointment" });
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);
  });

  it("a yes that names a SPOKEN different time is a change, not a yes", async () => {
    const s = await boot("CA_spoken_other_time");
    await s.assistantTurn(Q2);
    await s.callerSays("Yeah, ten o'clock works.");
    const [r] = await s.callTool("book_appointment", book(AT_14));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 3, opus review (2026-10-16): a row moves ONLY on an answer to a question
// that named the move; the same person means the same name; Live only; a full
// slot is never moved into; a transcript that lags the answer defers to the
// model, which heard it.
// ---------------------------------------------------------------------------
describe("LVX179 Fix 3 review: never a silent move", () => {
  const Q9 = "So that's Friday, September 18 at 9 a.m. for Ada Moss, is that right?";
  async function savedAt9(callSid, opts = {}) {
    const s = opts.seedAppointments
      ? await bootLive({ config: CONFIG, callSid, seedAppointments: opts.seedAppointments })
      : await boot(callSid);
    if (opts.seedAppointments) {
      for (const at of [AT_9, AT_10, AT_14]) await s.callTool("check_appointment_availability", { requested_at: at });
      await s.turnEnds();
    }
    await s.assistantTurn(Q9);
    await s.callerSays("Yes.");
    const [saved] = await s.callTool("book_appointment", book(AT_9));
    expect(saved.response.success).toBe(true);
    await s.turnEnds();
    await s.assistantTurn("Done, you're all set.");
    return s;
  }
  const at = (row) => Date.parse(row.scheduled_at);
  const local = (naive) => Date.parse(`${naive}-05:00`);
  const adaAt9 = (s) => s.store.scheduled().some((r) => r.client_name === "Ada Moss" && at(r) === local(AT_9));

  it("a daughter with the same surname is never a move of the first booking (review #1)", async () => {
    const s = await savedAt9("CA_fix3r_daughter");
    await s.callerSays("No, that's it. Oh actually, my daughter Mia Moss needs one at 10.");
    await s.assistantTurn("So that's Friday, September 18 at 10 AM for Mia Moss, is that right?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10, "Mia Moss"));
    expect(String(r.response.message)).not.toMatch(/Moved the appointment/);
    expect(adaAt9(s)).toBe(true);
  });

  it("a stray 'no' then the model's own plain read-back: the move is ASKED, never done silently (review #1)", async () => {
    const s = await savedAt9("CA_fix3r_stray_no");
    await s.callerSays("No thanks. Hmm, what about Friday at 2?");
    await s.assistantTurn("So that's Friday, September 18 at 2 PM for Ada Moss, is that right?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_14));
    expect(r.response.success).toBe(false);
    expect(String(r.response.message)).toMatch(/So that's moving your Friday, September 18 at 9/);
    expect(s.store.scheduled()).toHaveLength(1);
    expect(adaAt9(s)).toBe(true);
  });

  it("the model asks its own move question first: one question, moved (review #5)", async () => {
    const s = await savedAt9("CA_fix3r_model_asks");
    await s.callerSays("No, 10 instead.");
    await s.assistantTurn("Shall I move your Friday, September 18 at 9 a.m. to 10 a.m.?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(true);
    const rows = s.store.scheduled();
    expect(rows).toHaveLength(1);
    expect(at(rows[0])).toBe(local(AT_10));
  });

  it("a full slot is never moved into: the first booking stays (review #2)", async () => {
    // 10 was open when it was checked; someone else takes it before the move
    // (a plain reschedule would double-book it).
    const s = await savedAt9("CA_fix3r_full");
    s.store.appointments.push({
      id: "appt-ben",
      business_id: s.store.scheduled()[0].business_id,
      client_name: "Ben Ortiz",
      client_phone: "+15550001111",
      scheduled_at: "2026-09-18T15:00:00.000Z",
      status: "scheduled",
    });
    await s.callerSays("No, 10 instead.");
    await s.assistantTurn("So that's moving your Friday, September 18 at 9 AM to 10 AM for Ada Moss, is that right?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(false);
    expect(String(r.response.message)).toMatch(/fully booked/);
    expect(adaAt9(s)).toBe(true);
  });

  it("the answer to move-or-keep not transcribed yet: the model's choice stands, nothing lost (review #4)", async () => {
    const s = await savedAt9("CA_fix3r_lag");
    await s.callerSays("What about 10?");
    const [ask] = await s.callTool("book_appointment", book(AT_10));
    expect(String(ask.response.message)).toMatch(/or keep both\?/);
    await s.turnEnds();
    await s.assistantTurn("Shall I move your Friday, September 18 at 9:00 AM to 10:00 AM, or keep both?");
    await s.feed(900, { voiced: true });
    await s.feed(400);
    const [r] = await s.callTool("book_appointment", { ...book(AT_10), in_addition_to_existing: true });
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(2);
  });

  it("the cascade (no words-since-save) is left to the ordinary path (review #3)", () => {
    const ctx = {
      capabilityState: {
        appointments: { lastBooked: { id: "a1", scheduled_at: "2026-09-18T14:00:00.000Z", client_name: "Ada Moss", callerSaidLen: 0 } },
      },
      lastCallerText: "",
    };
    expect(correctionAfterSave(book(AT_10), ctx, "2026-09-18T15:00:00.000Z")).toBeNull();
    expect(correctionAfterSave(book(AT_10), { ...ctx, callerSaidThisCall: "No, 10 instead." }, "2026-09-18T15:00:00.000Z")).toMatchObject({ kind: "confirm_move" });
  });

  it("answers to move-or-keep: 'no' keeps both, 'no, just move it' moves, 'yes' moves", () => {
    expect(classifyOrKeepAnswer("No.")).toBe("add");
    expect(classifyOrKeepAnswer("No, keep both.")).toBe("add");
    expect(classifyOrKeepAnswer("No, just move it.")).toBe("move");
    expect(classifyOrKeepAnswer("Yes please.")).toBe("move");
    expect(classifyOrKeepAnswer("Yes, both.")).toBe("add");
    expect(classifyOrKeepAnswer("Hmm.")).toBeNull();
    // Re-review #2: the latest answer, and "just / only / cancel" name the move.
    expect(classifyOrKeepAnswer("No, just the ten.")).toBe("move");
    expect(classifyOrKeepAnswer("No, I only need one.")).toBe("move");
    expect(classifyOrKeepAnswer("Move it. Can you also text me?")).toBe("move");
    expect(classifyOrKeepAnswer("Don't move it.")).toBe("add");
    expect(classifyOrKeepAnswer("Keep the nine as well.")).toBe("add");
    // Re-review 3 #2: more ways of saying "keep it too".
    expect(classifyOrKeepAnswer("Yes, and the 9 too.")).toBe("add");
    expect(classifyOrKeepAnswer("I meant in addition.")).toBe("add");
    expect(classifyOrKeepAnswer("Yes, I still want the 9.")).toBe("add");
    // Re-review 4 (High): everyday asides after a yes are NOT "keep both".
    expect(classifyOrKeepAnswer("Yes. One more thing, do you have parking?")).toBe("move");
    expect(classifyOrKeepAnswer("Yeah, that's right. Is it still with Dr Lee?")).toBe("move");
    expect(classifyOrKeepAnswer("Yes, plus can you text me?")).toBe("move");
    expect(classifyOrKeepAnswer("Yes, also can you text me the address?")).toBe("move");
    expect(classifyOrKeepAnswer("Yes, the nine o'clock too.")).toBe("add");
    // A word naming the move outranks a keep-word said on the way to it.
    expect(classifyOrKeepAnswer("Hmm, both? No wait, just move it.")).toBe("move");
  });
});

// ---------------------------------------------------------------------------
// Fix 3, opus RE-review (2026-10-17): the question the caller answered decides.
// ---------------------------------------------------------------------------
describe("LVX179 Fix 3 re-review: the question answered decides", () => {
  const Q9 = "So that's Friday, September 18 at 9 a.m. for Ada Moss, is that right?";
  async function savedAt9(callSid) {
    const s = await boot(callSid);
    await s.assistantTurn(Q9);
    await s.callerSays("Yes.");
    const [saved] = await s.callTool("book_appointment", book(AT_9));
    expect(saved.response.success).toBe(true);
    await s.turnEnds();
    await s.assistantTurn("Done, you're all set.");
    return s;
  }
  const at = (row) => Date.parse(row.scheduled_at);
  const local = (naive) => Date.parse(`${naive}-05:00`);

  it("a move question WITH an alternative, answered 'keep the nine as well': two rows, never a move (Critical)", async () => {
    const s = await savedAt9("CA_fix3rr_keep_as_well");
    await s.callerSays("What about 10 too?");
    await s.assistantTurn("Shall I move your Friday, September 18 at 9 a.m. to 10 a.m., or keep the 9 as well?");
    await s.callerSays("Keep the nine as well.");
    const [r] = await s.callTool("book_appointment", { ...book(AT_10), in_addition_to_existing: true });
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled().map(at).sort()).toEqual([local(AT_9), local(AT_10)]);
  });

  it("'I won't move your 9 -- an extra one at 10?' answered yes: an extra one, never a move", async () => {
    const s = await savedAt9("CA_fix3rr_wont_move");
    await s.callerSays("And one at 10 please.");
    await s.assistantTurn("I won't move your 9 a.m., so that's an extra one on Friday, September 18 at 10 AM, is that right?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled().map(at).sort()).toEqual([local(AT_9), local(AT_10)]);
  });

  it("'No, just the ten' to move-or-keep, then the move question answered yes: ONE row, moved (#2)", async () => {
    const s = await savedAt9("CA_fix3rr_just_ten");
    await s.callerSays("What about 10?");
    await s.callTool("book_appointment", book(AT_10));
    await s.turnEnds();
    await s.assistantTurn("Shall I move your Friday, September 18 at 9:00 AM to 10:00 AM, or keep both?");
    await s.callerSays("No, just the ten.");
    await s.callTool("book_appointment", book(AT_10));
    await s.turnEnds();
    await s.assistantTurn("So that's moving your Friday, September 18 at 9 AM to 10 AM for Ada Moss, is that right?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(true);
    const rows = s.store.scheduled();
    expect(rows).toHaveLength(1);
    expect(at(rows[0])).toBe(local(AT_10));
  });

  it("a Fix 3 question is handed ONCE: a paraphrased plain read-back answered yes keeps both, no second ask (#3)", async () => {
    const s = await savedAt9("CA_fix3rr_once");
    await s.callerSays("No, 10 instead.");
    const [ask] = await s.callTool("book_appointment", book(AT_10));
    expect(String(ask.response.message)).toMatch(/So that's moving your/);
    await s.turnEnds();
    await s.assistantTurn("So that's Friday, September 18 at 10 AM for Ada Moss, is that right?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Fix 3, opus RE-review #2 (2026-10-17): a move needs OUR move wording, no
// alternative after it, an answer with no keep/both word, no in_addition flag,
// and the same name.
// ---------------------------------------------------------------------------
describe("LVX179 Fix 3 re-review 2: a move needs the move question and a plain yes", () => {
  const Q9 = "So that's Friday, September 18 at 9 a.m. for Ada Moss, is that right?";
  async function savedAt9(callSid) {
    const s = await boot(callSid);
    await s.assistantTurn(Q9);
    await s.callerSays("Yes.");
    const [saved] = await s.callTool("book_appointment", book(AT_9));
    expect(saved.response.success).toBe(true);
    await s.turnEnds();
    await s.assistantTurn("Done, you're all set.");
    return s;
  }
  const at = (row) => Date.parse(row.scheduled_at);
  const local = (naive) => Date.parse(`${naive}-05:00`);
  const adaAt9 = (s) => s.store.scheduled().some((r) => r.client_name === "Ada Moss" && at(r) === local(AT_9));

  it("'So that's moving your 9 to 10?' answered 'keep both please': two rows, never a move (Critical)", async () => {
    const s = await savedAt9("CA_fix3r2_keep_both");
    await s.callerSays("No, 10 instead.");
    await s.assistantTurn("So that's moving your Friday, September 18 at 9 AM to 10 AM for Ada Moss, is that right?");
    await s.callerSays("Keep both please.");
    const [r] = await s.callTool("book_appointment", { ...book(AT_10), in_addition_to_existing: true });
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled().map(at).sort()).toEqual([local(AT_9), local(AT_10)]);
  });

  it("an ordinary 'or would you like to change anything?' read-back is not a move question", async () => {
    const s = await savedAt9("CA_fix3r2_change_anything");
    await s.callerSays("Also one at 2, please.");
    await s.assistantTurn("So that's Friday, September 18 at 2 PM for Ada Moss. Does that sound right, or would you like to change anything?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_14));
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled().map(at).sort()).toEqual([local(AT_9), local(AT_14)]);
  });

  it("a spelled name in the move question (M-O-S-S) does not stop the move", async () => {
    const s = await savedAt9("CA_fix3r2_spelled");
    await s.callerSays("No, 10 instead.");
    await s.assistantTurn("So that's moving your Friday, September 18 at 9 AM to 10 AM for Ada Moss, M-O-S-S, is that right?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(true);
    const rows = s.store.scheduled();
    expect(rows).toHaveLength(1);
    expect(at(rows[0])).toBe(local(AT_10));
  });

  it("a different first name one letter away (Ana / Ada) is never offered as a move of Ada's booking", async () => {
    const s = await savedAt9("CA_fix3r2_ana");
    await s.callerSays("And my sister Ana Moss at 10, no wait, make it for Ana.");
    await s.assistantTurn("So that's Friday, September 18 at 10 AM for Ana Moss, is that right?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10, "Ana Moss"));
    expect(String(r.response.message)).not.toMatch(/moving your|Moved the appointment/);
    expect(adaAt9(s)).toBe(true);
  });

  it("an either/or with no 'keep' wording, answered unclearly: asked, never moved", async () => {
    const s = await savedAt9("CA_fix3r2_either_or");
    await s.callerSays("What about 10?");
    await s.assistantTurn("Shall I move your Friday, September 18 at 9 a.m. to 10 a.m., or book 10 a.m. as a separate visit?");
    await s.callerSays("The separate visit, please.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(false);
    expect(adaAt9(s)).toBe(true);
    expect(s.store.scheduled()).toHaveLength(1);
  });
});

describe("LVX179 Fix 3 re-review 3: the move question must name the booking it moves", () => {
  const Q9 = "So that's Friday, September 18 at 9 a.m. for Ada Moss, is that right?";
  const at = (row) => Date.parse(row.scheduled_at);
  const local = (naive) => Date.parse(`${naive}-05:00`);

  it("two bookings on the call: 'move your 9 to 10?' never moves the 2 p.m. one", async () => {
    const s = await boot("CA_fix3r3_two");
    await s.assistantTurn(Q9);
    await s.callerSays("Yes.");
    expect((await s.callTool("book_appointment", book(AT_9)))[0].response.success).toBe(true);
    await s.turnEnds();
    await s.assistantTurn("Done, you're all set.");
    await s.callerSays("Also one at 2, please.");
    await s.assistantTurn("So that's Friday, September 18 at 2 PM for Ada Moss, is that right?");
    await s.callerSays("Yes.");
    expect((await s.callTool("book_appointment", book(AT_14)))[0].response.success).toBe(true);
    await s.turnEnds();
    await s.assistantTurn("Done, you're all set.");
    await s.callerSays("The 9 one, make it 10 instead.");
    await s.assistantTurn("Shall I move your Friday, September 18 at 9 a.m. to 10 a.m.?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(String(r.response.message)).not.toMatch(/Moved the appointment/);
    const rows = s.store.scheduled().map(at).sort();
    expect(rows).toEqual([local(AT_9), local(AT_14)]);
  });
});

// ---------------------------------------------------------------------------
// The carry-over judge needs a SOUND (gate p5-final5, 2026-10-17: the row that
// removed that condition read GREEN -- no test had a nudge END with the caller
// silent before the model called).
// ---------------------------------------------------------------------------
describe("LVX179 carry-over: silence is never an answer", () => {
  it("a question met by silence and a nudge, with no sound at all, is never booked", async () => {
    const s = await boot("CA_carry_silence_nudge");
    await s.assistantTurn("So that's Friday, September 18 at 2 PM for Ada Moss, is that right?");
    await s.feed(12_000);
    await s.assistantTurn("Hello? Are you still there?");
    const [r] = await s.callTool("book_appointment", book(AT_14));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Part 6 (owner, 2026-10-19), call c CA1cfcbc4e: after "No, actually do 10
// instead." the model asked its OWN "Shall I move your appointment on Monday,
// October 26th to 10:00 AM?" -- the old booking by its DAY, not its 9 a.m. --
// so the gate handed ours and the caller heard two move questions. A day-only
// move question counts when that person has ONE booking that day.
// ---------------------------------------------------------------------------
describe("Part 6 Fix 1: a move question naming only the DAY", () => {
  const Q9 = "So that's Friday, September 18 at 9 a.m. for Ada Moss, is that right?";
  const DAY_Q = "Shall I move your appointment on Friday, September 18th to 10:00 AM?";
  const at = (row) => Date.parse(row.scheduled_at);
  const local = (naive) => Date.parse(`${naive}-05:00`);
  const row = (id, naive, client_name = "Ada Moss") => ({ id, client_name, scheduled_at: `${naive}-05:00` });

  // A known snapshot with nothing on file (review L2: no snapshot at all is
  // "unknown", not "none").
  const KNOWN = { callCount: 1, lastCallSummary: null, upcomingAppointments: [], upcomingOverflow: 0, upcomingBeyond: [] };

  async function savedAt9(callSid, callerContext = KNOWN) {
    const s = await bootLive({
      config: CONFIG,
      callSid,
      database: { ...fakeDb(CONFIG, "biz-1"), fetchCallerContext: async () => callerContext },
    });
    for (const t of [AT_9, AT_10, AT_14]) await s.callTool("check_appointment_availability", { requested_at: t });
    await s.turnEnds();
    await s.assistantTurn(Q9);
    await s.callerSays("Yes.");
    const [saved] = await s.callTool("book_appointment", { ...book(AT_9), in_addition_to_existing: true });
    expect(saved.response.success).toBe(true);
    await s.turnEnds();
    await s.assistantTurn("Done, you're all set.");
    await s.callerSays("No, actually do 10 instead.");
    return s;
  }

  it("call c: the model's day-only question answered yes MOVES the booking, no second question", async () => {
    const s = await savedAt9("CA_p6_day_only");
    await s.assistantTurn(DAY_Q);
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(true);
    expect(String(r.response.message)).toMatch(/Done, you're all set/);
    const rows = s.store.scheduled();
    expect(rows).toHaveLength(1);
    expect(at(rows[0])).toBe(local(AT_10));
  });

  it("the same person has a second booking that day: the day-only question is not enough, ours is asked", async () => {
    const s = await savedAt9("CA_p6_day_two", {
      callCount: 1,
      lastCallSummary: null,
      upcomingAppointments: [row("appt-2pm", "2026-09-18T14:00:00")],
      upcomingOverflow: 0,
      upcomingBeyond: [],
    });
    await s.assistantTurn(DAY_Q);
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(false);
    expect(String(r.response.message)).toMatch(/So that's moving your Friday, September 18 at 9/);
    expect(s.store.scheduled().map(at)).toEqual([local(AT_9)]);
  });

  it("that second booking is past the five listed (beyond): still counted, ours is asked", async () => {
    const listed = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"].map((d, i) =>
      row(`appt-l${i}`, `${d}T11:00:00`)
    );
    const s = await savedAt9("CA_p6_day_beyond", {
      callCount: 1,
      lastCallSummary: null,
      upcomingAppointments: listed,
      upcomingOverflow: 1,
      upcomingBeyond: [row("appt-b", "2026-09-18T14:00:00")],
    });
    await s.assistantTurn(DAY_Q);
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled().map(at)).toEqual([local(AT_9)]);
  });

  it("overflow with no beyond list (an older snapshot): unknown, so ours is asked", async () => {
    const s = await savedAt9("CA_p6_day_unknown", {
      callCount: 1,
      lastCallSummary: null,
      upcomingAppointments: [],
      upcomingOverflow: 3,
    });
    await s.assistantTurn(DAY_Q);
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled().map(at)).toEqual([local(AT_9)]);
  });

  it("another person's booking that day does not count: Priya's 2 p.m. leaves Ada's day unique", async () => {
    const s = await savedAt9("CA_p6_day_other_person", {
      callCount: 1,
      lastCallSummary: null,
      upcomingAppointments: [row("appt-priya", "2026-09-18T14:00:00", "Priya Raman")],
      upcomingOverflow: 0,
      upcomingBeyond: [],
    });
    await s.assistantTurn(DAY_Q);
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled().map(at)).toEqual([local(AT_10)]);
  });

  it("the old half names ANOTHER day or a clock time: not this booking, never a move", async () => {
    for (const [sid, q] of [
      ["CA_p6_day_wrong_weekday", "Shall I move your appointment on Thursday to 10:00 AM on Friday?"],
      ["CA_p6_day_wrong_date", "Shall I move your appointment on September 21st to 10:00 AM?"],
      ["CA_p6_day_clock", "Shall I move your Friday 2 PM appointment to 10:00 AM?"],
    ]) {
      const s = await savedAt9(sid);
      await s.assistantTurn(q);
      await s.callerSays("Yes.");
      const [r] = await s.callTool("book_appointment", book(AT_10));
      expect(String(r.response.message), sid).not.toMatch(/Moved the appointment/);
      expect(s.store.scheduled().map(at), sid).toContain(local(AT_9));
    }
  });

  // Opus review H1: the count is of what the question NAMED. "Your Friday
  // appointment" fits every Friday, so another Friday on file makes it unclear.
  it("a weekday only, with another Friday on file: ours is asked, nothing moved", async () => {
    const s = await savedAt9("CA_p6_day_weekday_two", {
      ...KNOWN,
      upcomingAppointments: [row("appt-next-fri", "2026-09-25T11:00:00")],
    });
    await s.assistantTurn("Shall I move your Friday appointment to 10:00 AM?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled().map(at)).toEqual([local(AT_9)]);
  });

  it("weekday AND date with another Friday on file: the date makes it this one, moved", async () => {
    const s = await savedAt9("CA_p6_day_weekday_date", {
      ...KNOWN,
      upcomingAppointments: [row("appt-next-fri", "2026-09-25T11:00:00")],
    });
    await s.assistantTurn(DAY_Q);
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(true);
    expect(s.store.scheduled().map(at)).toEqual([local(AT_10)]);
  });

  it("a spelled date is read like digits: 'the eighteenth' moves, 'the twenty-fifth' does not", async () => {
    const yes = await savedAt9("CA_p6_day_spelled_yes");
    await yes.assistantTurn("Shall I move your appointment on Friday the eighteenth to 10:00 AM?");
    await yes.callerSays("Yes.");
    expect((await yes.callTool("book_appointment", book(AT_10)))[0].response.success).toBe(true);
    expect(yes.store.scheduled().map(at)).toEqual([local(AT_10)]);

    const no = await savedAt9("CA_p6_day_spelled_no");
    await no.assistantTurn("Shall I move your appointment on Friday the twenty-fifth to 10:00 AM?");
    await no.callerSays("Yes.");
    await no.callTool("book_appointment", book(AT_10));
    expect(no.store.scheduled().map(at)).toContain(local(AT_9));
  });

  it("a time in words in the old half ('half past two') names a time, not the day: never a day-only move", async () => {
    const s = await savedAt9("CA_p6_day_word_clock");
    await s.assistantTurn("Shall I move your Friday half past two appointment to 10:00 AM?");
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(String(r.response.message)).not.toMatch(/Moved the appointment/);
    expect(s.store.scheduled().map(at)).toContain(local(AT_9));
  });

  // Opus re-review (High): an ordinal on its own is an ORDER ("your first
  // appointment"), not a date; read as the 18th it picked this row to move.
  it("an ordinal not beside a weekday or month is not a date: ours is asked, nothing moved", async () => {
    for (const [sid, q] of [
      ["CA_p6_ord_spelled", "Shall I move your eighteenth one to 10:00 AM?"],
      ["CA_p6_ord_digit", "Shall I move your 18th appointment to 10:00 AM?"],
    ]) {
      const s = await savedAt9(sid);
      await s.assistantTurn(q);
      await s.callerSays("Yes.");
      const [r] = await s.callTool("book_appointment", book(AT_10));
      expect(String(r.response.message), sid).not.toMatch(/Moved the appointment/);
      expect(s.store.scheduled().map(at), sid).toContain(local(AT_9));
    }
  });

  it("a withheld number (fetchCallerContext's empty shape): other bookings unknown, ours is asked", async () => {
    const s = await savedAt9("CA_p6_day_withheld", { callCount: 0, lastCallSummary: null, upcomingAppointments: [], snapshotMissing: true });
    await s.assistantTurn(DAY_Q);
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled().map(at)).toEqual([local(AT_9)]);
  });

  it("no call-start snapshot (lookup failed, number withheld): other bookings unknown, ours is asked", async () => {
    const s = await savedAt9("CA_p6_day_no_snapshot", null);
    await s.assistantTurn(DAY_Q);
    await s.callerSays("Yes.");
    const [r] = await s.callTool("book_appointment", book(AT_10));
    expect(r.response.success).toBe(false);
    expect(s.store.scheduled().map(at)).toEqual([local(AT_9)]);
  });
});

// Part 6, opus re-reviews #1-#2: in the old half of a move question a number
// or ordinal is a DATE only when anchored -- beside a month, or an ORDINAL
// beside a weekday -- and never one followed by "one". Anything else stray is
// an order or a time: null, ours is asked.
describe("Part 6: anchoredDates", () => {
  it.each([
    ["appointment on monday, october 26th", [26]],
    ["monday the twenty sixth", [26]],
    ["monday, the 26th", [26]],
    ["the 26th of october", [26]],
    ["october the 26th", [26]],
    ["monday 26 october", [26]],
    ["friday the twenty fifth", [25]],
    ["your monday, the second one", null],
    ["your monday 9 appointment", null],
    ["your first appointment", null],
    ["your 18th one", null],
    ["mon 26th", null],
  ])("%j -> %j", (half, want) => {
    expect(anchoredDates(half)).toEqual(want);
  });
});
