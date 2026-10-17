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
import { bootLive } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";

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
