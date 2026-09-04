import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// LVX72's real fix: WE re-issue the write, rather than asking the model to.
//
// Four calls have now lost a booking on one path. The spelling gate refuses
// pending a spelling, the caller spells it, and the model announces the booking
// without ever calling the tool again:
//
//   asst > Thanks, Nithan Dodla. I have you down for a cleaning on Monday,
//          September seventh, at four thirty PM.
//   postcall_verify: write_abandoned, booked_rows 0, appointments table EMPTY
//
// Three separate texts have asked it to retry -- LVX34's rewritten gate
// refusal, the abandoned-write refusal, and the hang-up gate. All three were
// ignored, because a refusal message is a request.
//
// Blocking the exit could never have worked either, and call 4 proved it:
// end_call's declaration makes the model write its sign-off in the SAME
// response as the call, so the goodbye is already spoken before any gate runs.
// The caller heard "You're all set then" with no row, and was then held on the
// line for six seconds of dead air and a silence nudge.
//
// So the retry stopped being a request. What is asserted here is the WIRING --
// that a settled spelling reaches retryPendingWrite and that the write actually
// goes out -- because that wire is the part that can silently not exist, which
// is how the hesitation gate sat unreachable for the life of a deployment.
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

const CONFIG = {
  businessName: "Brightwork Family Dental",
  mainPhone: "+18176011171",
  timezone: "America/Chicago",
  locale: "en-US",
  allowedTasks: ["book_appointment", "general_question"],
  capabilities: { appointments: { enabled: true } },
  businessHours: {},
};

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: "biz-1", name: CONFIG.businessName }),
    loadConfig: () => CONFIG,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

const BOOK = { scheduled_at: "2026-09-07T16:30:00", client_name: "Nitin Dodla", notes: "cleaning" };

/**
 * Stands in for the spelling gate: refuses the first booking and stashes it,
 * succeeds on anything after. `stash` lets a test withhold the pendingWrite so
 * the "nothing to retry" case can be exercised.
 */
function gateExecutor({ stash = true, retryFails = false } = {}) {
  const calls = [];
  let bookAttempts = 0;
  const execute = vi.fn(async (fc) => {
    calls.push(fc);

    // The availability invariant (LVX49) blocks a booking with no verified
    // slot, BEFORE execute is ever reached. That is not incidental to this
    // test: it is the proof that the retry goes THROUGH the guards rather than
    // around them, so a real call has to arm it first and so does this.
    if (fc.name === "check_appointment_availability") {
      return {
        // open_times, and `requested_at` on the call above -- the guard keys on
        // those exact names (guards.js AVAILABILITY_SHAPES), not on
        // scheduled_at. Getting it wrong reads identically to a broken wire:
        // execute is never reached for the booking and the test reports zero
        // calls.
        functionResponse: {
          id: fc.id,
          name: fc.name,
          response: { success: true, available: true, open_times: [BOOK.scheduled_at] },
        },
        stateEffects: { toolResult: { name: fc.name, success: true, message: "free" } },
      };
    }

    bookAttempts += 1;
    if (bookAttempts === 1) {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: "spell it" } },
        stateEffects: {
          toolResult: { name: fc.name, success: false, message: "spell it" },
          capabilityState: stash
            ? { appointments: { pendingWrite: { name: fc.name, args: fc.args || {} } } }
            : { appointments: { spellingGateRefusals: 1 } },
        },
      };
    }
    if (retryFails) {
      return {
        functionResponse: { id: fc.id, name: fc.name, response: { success: false, message: "slot gone" } },
        stateEffects: { toolResult: { name: fc.name, success: false, message: "slot gone" } },
      };
    }
    return {
      functionResponse: { id: fc.id, name: fc.name, response: { success: true } },
      stateEffects: {
        toolResult: { name: fc.name, success: true, message: "booked" },
        capabilityEffects: [{ capability: "appointments", type: "booked", data: {} }],
      },
    };
  });
  return { execute, calls, bookCalls: () => calls.filter((f) => f.name === "book_appointment") };
}

async function boot(opts = {}) {
  const bookArgs = opts.args || BOOK;
  const ws = new FakeSocket();
  const live = fakeLive();
  const { execute, calls, bookCalls } = gateExecutor(opts);
  await handleLiveSessionConnection(
    ws,
    {},
    { now: () => 0, connect: live.connect, database: fakeDb(), env: {}, execute }
  );
  ws.deliver({
    event: "start",
    start: { callSid: "CA_retry", streamSid: "MZ1", customParameters: { businessPhone: "+18176011171" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  // A tool round is genuinely asynchronous -- guards, packForTool, the awaited
  // execute, then the effect merge -- and onToolCall is fire-and-forget, so
  // there is nothing to await from the outside. Two setTimeout(0)s were not
  // enough and the tests failed reporting that execute had never run, which
  // reads exactly like a broken wire. 25 ms is comfortably past it.
  const settle = () => new Promise((r) => setTimeout(r, 25));

  return {
    live,
    calls,
    bookCalls,
    /** Check availability, then try to book. The gate refuses and stashes it. */
    async book() {
      live.push({
        toolCall: {
          functionCalls: [
            { id: "a", name: "check_appointment_availability", args: { requested_at: BOOK.scheduled_at } },
          ],
        },
      });
      await settle();
      await settle();
      live.push({ toolCall: { functionCalls: [{ id: "1", name: "book_appointment", args: bookArgs }] } });
      await settle();
      await settle();
    },
    /**
     * The caller spells their name, and the turn then ENDS.
     *
     * Both halves matter. The spelling settles the gate; the turnComplete is
     * what gives the model its own chance to re-issue the write first, which
     * is deliberately preferred over ours because its version carries the
     * corrected spelling and ours cannot.
     */
    async spell(text = "n i t h i n  d o d l a") {
      live.push({ serverContent: { inputTranscription: { text } } });
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
      await settle();
    },
    /** The model re-issues the booking itself, the way it is supposed to. */
    async modelRebooks(args) {
      live.push({ toolCall: { functionCalls: [{ id: "m", name: "book_appointment", args }] } });
      await settle();
      await settle();
    },
    notes: () => live.sent.clientContent.slice(1).map((m) => m.turns[0].parts[0].text),
    /** Every note, with whether it asked the model to speak. */
    noteFrames: () => live.sent.clientContent.slice(1),
  };
}

const c = () => getLatencyStats().turnTaking;

describe("LVX72 — the refused write is re-issued when the spelling arrives", () => {
  beforeEach(() => clearStats());

  it("calls the booking tool again, without the model asking", async () => {
    const s = await boot();
    await s.book();
    expect(s.bookCalls()).toHaveLength(1);

    await s.spell();

    // THE ASSERTION THE WHOLE SESSION IS ABOUT. Four calls reached this point
    // and stopped; the caller was then told they were booked.
    expect(s.bookCalls()).toHaveLength(2);
    expect(s.bookCalls()[1].args).toEqual(BOOK);
    expect(c().write_retry_attempted).toBe(1);
    expect(c().write_retried_after_spelling).toBe(1);
  });

  it("tells the model the booking is real, so its next sentence is true", async () => {
    // No client_name in the refused args -- a booking for a caller whose name
    // was already on file. Nothing about the spelling is at stake, so the plain
    // note applies rather than the name one.
    const s = await boot({ args: { scheduled_at: BOOK.scheduled_at, notes: "cleaning" } });
    await s.book();
    await s.spell();

    const note = s.notes().find((t) => /has now been completed and saved/.test(t));
    expect(note).toBeTruthy();
    expect(note).toMatch(/do NOT call the booking tool again/i);
    expect(c().write_retry_name_unspelled).toBe(0);
  });

  it("tells the model plainly when the retry FAILED, and not to claim it", async () => {
    // The half that matters more. Left to guess after a failure, the model
    // describes a booking that does not exist -- which is the defect itself.
    const s = await boot({ retryFails: true });
    await s.book();
    await s.spell();

    expect(c().write_retry_attempted).toBe(1);
    expect(c().write_retry_refused).toBe(1);
    expect(c().write_retried_after_spelling).toBe(0);

    const note = s.notes().find((t) => /could NOT be completed/.test(t));
    expect(note).toBeTruthy();
    expect(note).toMatch(/Do NOT tell the caller it is booked/i);
  });

  it("fires ONCE — a re-delivered transcript cannot book twice", async () => {
    // takePendingWrite is atomic for this reason. Two identical bookings a
    // second apart are both legitimately available, so the availability guard
    // would not catch a double-fire; it would just be two appointments.
    const s = await boot();
    await s.book();
    await s.spell();
    await s.spell("n i t h i n  d o d l a");

    expect(s.bookCalls()).toHaveLength(2);
    expect(c().write_retry_attempted).toBe(1);
  });

  it("does nothing when no write was ever refused", async () => {
    const s = await boot({ stash: false });
    await s.book();
    await s.spell();

    expect(s.bookCalls()).toHaveLength(1);
    expect(c().write_retry_attempted).toBe(0);
  });

  it("stands down when the MODEL re-issues the write itself", async () => {
    // The model's own retry is better than ours and must win: it carries the
    // name the caller just spelled, and the replayed arguments do not. A
    // successful write clears the stash, which is also what stops the booking
    // being made twice.
    const s = await boot();
    await s.book();
    await s.modelRebooks({ ...BOOK, client_name: "Nithin Dodla" });
    await s.spell();

    expect(s.bookCalls()).toHaveLength(2);
    expect(s.bookCalls()[1].args.client_name).toBe("Nithin Dodla");
    expect(c().write_retry_attempted).toBe(0);
  });

  it("tells the model the saved name is the UNSPELLED one", async () => {
    // Call 5, and the reason this note exists. The caller said "Nitin Dodla",
    // spelled "N I T H I N", the assistant read the letters back correctly --
    // and the row was written "Nitin Dodla", because the retry replays the
    // arguments as they were when the gate refused.
    //
    // The letters are not assembled in code on purpose: LVX62 records that a
    // spelled "D" has arrived as "V" here, and applyCallerSpellingSignal only
    // ever sets a boolean. The model heard them; it is asked to correct the
    // row through the tool that exists for it.
    const s = await boot();
    await s.book();
    await s.spell();

    expect(c().write_retried_after_spelling).toBe(1);
    expect(c().write_retry_name_unspelled).toBe(1);
    const note = s.notes().find((t) => /BEFORE the caller spelled it/.test(t));
    expect(note).toBeTruthy();
    expect(note).toMatch(/call correct_appointment_name/i);
  });

  it("does not make the model SPEAK after a successful retry", async () => {
    // Call 6. The retry fired 43 ms after turnComplete and its note, sent with
    // turnComplete:true, forced an entire extra spoken turn in which the model
    // repeated its previous sentence word for word. The model had already told
    // the caller the right thing; the note only needs a tool called.
    const s = await boot();
    await s.book();
    await s.spell();

    const frame = s.noteFrames().find((m) => /BEFORE the caller spelled it/.test(m.turns[0].parts[0].text));
    expect(frame).toBeTruthy();
    expect(frame.turnComplete).toBe(false);
  });

  it("DOES make it speak when the retry failed", async () => {
    // The one case that must be said out loud: the caller has been told about a
    // booking that does not exist, and only the model can correct that.
    const s = await boot({ retryFails: true });
    await s.book();
    await s.spell();

    const frame = s.noteFrames().find((m) => /could NOT be completed/.test(m.turns[0].parts[0].text));
    expect(frame).toBeTruthy();
    expect(frame.turnComplete).toBe(true);
  });

  it("does nothing on ordinary caller speech that is not a spelling", async () => {
    const s = await boot();
    await s.book();
    await s.spell("yes that sounds good to me thanks");

    expect(s.bookCalls()).toHaveLength(1);
    expect(c().write_retry_attempted).toBe(0);
  });
});
