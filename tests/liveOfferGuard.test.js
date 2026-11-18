import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { getLatencyStats, clearStats } from "../lib/voice/metrics.js";

// ---------------------------------------------------------------------------
// The other half of LVX27, and the earlier one.
//
// On the fabricated call the assistant said:
//
//   "We also have appointments available at nine AM, nine thirty AM, ten AM,
//    ten thirty AM, and eleven AM that day. Do any of those work for you?"
//
// with no tool call anywhere in the session. The claim guard cannot see that --
// it is not a claim of completion, it is an OFFER, and it happens before the
// caller has committed to anything. By the time the claim guard fires the
// caller has already chosen an invented slot.
//
// ---------------------------------------------------------------------------
// Why this does not parse times out of prose
// ---------------------------------------------------------------------------
//
// The obvious design is to pull the times out of what was said and compare
// them against the verified set. Speech renders them as "nine AM", "ten thirty
// AM", "11 30 AM", "2 P M" -- and times appear in sentences that are not
// offers at all ("we're open nine to five", "your appointment is at ten").
// A parser there is a false-positive generator.
//
// The precision comes from the tool record instead. guards.js already keeps
// `verifiedSlots`, filled ONLY from a real availability tool's response, and
// the booking invariant already gates on it. So the question becomes: did the
// assistant offer specific times when NOTHING has ever verified a slot on this
// call. That is answerable exactly, with no parsing.
//
// What it therefore does NOT catch, stated so nobody assumes otherwise: a
// wrong time quoted AFTER a real availability call. That needs the parser, and
// it is a smaller hole than the one being closed.
// ---------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
    this.sent = [];
  }
  send(raw) {
    // Recorded so the HARD clear is observable: a tapered clear drops only what
    // audioOut holds locally, a hard one also sends Twilio `clear`. That event
    // is the only thing that distinguishes them from outside.
    this.sent.push(raw);
  }
  close() {
    this.readyState = 3;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function fakeLive() {
  const sent = { clientContent: [] };
  let onmessage = null;
  return {
    sent,
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return {
        session: {
          sendRealtimeInput: () => {},
          sendClientContent: (m) => sent.clientContent.push(m),
          sendToolResponse: () => {},
          close: () => {},
        },
        languagePinned: true,
        surface: "aistudio",
        model: "m",
      };
    }),
    push: (msg) => onmessage?.(msg),
  };
}

function fakeDb() {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-1", name: "Digile Media" })),
    loadConfig: () => ({
      businessName: "Digile Media",
      timezone: "Europe/London",
      allowedTasks: ["general_question", "take_message", "book_appointment", "check_appointment"],
      capabilities: { appointments: { enabled: true }, messages: { enabled: true } },
      businessHours: {},
    }),
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
  };
}

let toolId = 0;

async function boot(env = {}, { now = () => 0 } = {}) {
  const ws = new FakeSocket();
  const live = fakeLive();
  const execute = vi.fn(async (fc) => ({
    functionResponse: {
      id: fc.id,
      name: fc.name,
      response:
        fc.name === "check_appointment_availability"
          ? { open_times: ["2026-09-07T10:00:00+01:00", "2026-09-07T10:30:00+01:00"] }
          : { success: true },
    },
    stateEffects: { toolResult: { name: fc.name, success: true, message: "ok" } },
  }));
  await handleLiveSessionConnection(ws, {}, {
    now,
    connect: live.connect,
    database: fakeDb(),
    env,
    execute,
  });
  ws.deliver({
    event: "start",
    start: { callSid: "CA1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } },
  });
  await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
  await new Promise((r) => setImmediate(r));

  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return {
    ws,
    live,
    settle,
    // Put real frames in audioOut's queue, so aiAudioPlayingUntil() is ahead of
    // the clock and there is something for the guard to cut.
    //
    // 24 kHz PCM16 in, 8 kHz mu-law out, decimation 3: one 160-byte Twilio
    // frame is 20 ms and eats 960 bytes of input. Silence is fine -- the
    // resampler and framer do not look at the values, only the lengths.
    audio: (ms) => {
      const bytes = Math.round((ms / 20) * 960);
      live.push({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(bytes).toString("base64") } }] },
        },
      });
    },
    say: (text) => live.push({ serverContent: { outputTranscription: { text } } }),
    endTurn: () => live.push({ serverContent: { turnComplete: true } }),
    async checkAvailability() {
      live.push({
        toolCall: {
          functionCalls: [
            { id: `t${(toolId += 1)}`, name: "check_appointment_availability", args: { requested_at: "2026-09-07T10:00:00+01:00" } },
          ],
        },
      });
      await settle();
    },
  };
}

const offers = () => getLatencyStats().turnTaking.live_offer_unverified;
const notes = (live) => live.sent.clientContent.slice(1);

describe("times offered that nothing ever verified", () => {
  beforeEach(() => clearStats());

  it("counts the exact sentence from the fabricated call", async () => {
    const s = await boot();
    s.say(
      "We also have appointments available at nine AM, nine thirty AM, ten AM, ten thirty AM, and eleven AM that day. Do any of those work for you?"
    );
    s.endTurn();
    await s.settle();

    expect(offers()).toBe(1);
  });

  it("catches the other ways it offers a slot", async () => {
    for (const line of [
      "I have an opening this coming Monday, September 7th, at nine AM — does that work for you?",
      "We have times available at 12 AM, 11 30 AM, or 11 PM.",
      "I've got a free slot at two o'clock on Thursday.",
    ]) {
      clearStats();
      const s = await boot();
      s.say(line);
      s.endTurn();
      await s.settle();
      expect(offers(), line).toBe(1);
    }
  });

  it("stays silent once an availability call has verified something", async () => {
    const s = await boot();
    await s.checkAvailability();
    s.say("We have times available at ten AM and ten thirty AM. Do either work?");
    s.endTurn();
    await s.settle();

    expect(offers()).toBe(0);
  });

  it("does not fire on stating the opening hours", async () => {
    const s = await boot();
    s.say("Strategy calls are thirty minutes and available between nine AM and five PM UK time.");
    s.endTurn();
    await s.settle();

    expect(offers()).toBe(0);
  });

  it("does not fire on ordinary conversation", async () => {
    for (const line of [
      "Is there anything else I can help you with today?",
      "Thanks, Nathan — could you spell your surname for me?",
      "Your appointment is at ten AM on Monday.",
    ]) {
      clearStats();
      const s = await boot();
      s.say(line);
      s.endTurn();
      await s.settle();
      expect(offers(), line).toBe(0);
    }
  });

  it("NOW speaks, like its sibling — same switch, same evidence", async () => {
    // Flipped with the claim guard on 2026-09-06. An offer of times nothing
    // verified is the same defect one step earlier in the call: the caller is
    // told something that is not backed by anything, and cannot tell.
    const s = await boot();
    s.say("We have times available at nine AM or ten AM.");
    s.endTurn();
    await s.settle();

    expect(offers()).toBe(1);
    expect(notes(s.live)).toHaveLength(1);
  });

  it("stays silent when the guard is switched off", async () => {
    const s = await boot({ LIVE_CLAIM_GUARD: "off" });
    s.say("We have times available at nine AM or ten AM.");
    s.endTurn();
    await s.settle();

    expect(offers()).toBe(1);
    expect(notes(s.live)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LVX80 -- the guard cuts the audio, it does not only complain about it.
//
// The order on the first deployed Live call, 2026-09-07, is the whole ticket:
//
//   19:38:59.313  live_offer_unverified   (step gather_details)
//   19:39:00.325  check_appointment_availability   (29 ms, success)
//
// The calendar lookup was never broken. It was one second late, and OFFER_NOTE
// corrected into a caller who had already been told 11:30pm. The owner reported
// it as "it keeps bringing out 11:30pm".
//
// The detection was always right. What was wrong was WHERE it ran: auditTurn
// fires on turnComplete, by which point the model has stopped generating and
// audioOut holds only the tail of the turn, so a cut there would chop the
// harmless end of a sentence and leave the wrong time already heard. It now
// runs per fragment, beside the leak guard, where there is still queued audio.
//
// On this front-end a guard can only ever be a TRUNCATOR, never a preventer:
// outputAudioTranscription lags the audio it describes. The leak guard's
// measured record is seven cut and four missed, so both outcomes get their own
// counter and neither is assumed.
// ---------------------------------------------------------------------------

const cuts = () => getLatencyStats().turnTaking.live_offer_cuts;
const missed = () => getLatencyStats().turnTaking.live_offer_cut_missed;
const clears = (ws) => ws.sent.filter((r) => JSON.parse(r).event === "clear").length;

describe("LVX80 — an unverified offer is cut off, not talked over", () => {
  beforeEach(() => clearStats());

  it("cuts while the offer is still queued, and takes Twilio's buffer with it", async () => {
    const s = await boot();
    // Two seconds of the turn still unplayed when the transcript names it.
    s.audio(2000);
    s.say("We have times available at nine AM or ten AM.");
    await s.settle();

    expect(offers()).toBe(1);
    expect(cuts()).toBe(1);
    expect(missed()).toBe(0);
    // HARD, not tapered. A tapered clear lets Twilio finish playing the ~100 ms
    // it already holds -- which here is the wrong time.
    expect(clears(s.ws)).toBe(1);
  });

  it("records a miss rather than a cut when nothing is left to drop", async () => {
    const s = await boot();
    // No audio queued: the transcript arrived after the caller heard all of it.
    s.say("We have times available at nine AM or ten AM.");
    await s.settle();

    expect(offers()).toBe(1);
    expect(cuts()).toBe(0);
    expect(missed()).toBe(1);
    expect(clears(s.ws)).toBe(0);
  });

  it("still sends the note when the cut was too late", async () => {
    // A caller who has heard the whole wrong time needs the correction MORE,
    // not less. The note is not conditional on winning the race.
    const s = await boot();
    s.say("We have times available at nine AM or ten AM.");
    await s.settle();

    expect(missed()).toBe(1);
    expect(notes(s.live)).toHaveLength(1);
  });

  it("LIVE_OFFER_CUT=off keeps the detection and the note, and stops cutting", async () => {
    // The note has been in production since 2026-09-06 and is known safe. The
    // cut is new. Turning the cut off must not cost the evidence needed to
    // decide what to do next.
    const s = await boot({ LIVE_OFFER_CUT: "off" });
    s.audio(2000);
    s.say("We have times available at nine AM or ten AM.");
    await s.settle();

    expect(offers()).toBe(1);
    expect(cuts()).toBe(0);
    expect(clears(s.ws)).toBe(0);
    expect(notes(s.live)).toHaveLength(1);
  });

  it("fires once per turn however many fragments match", async () => {
    // The repeat cutter fired three times in 173 ms on one real turn and burned
    // the whole call's cap. Every guard on this path has carried a per-turn
    // latch since.
    const s = await boot();
    s.audio(2000);
    s.say("We have times available at nine AM or ten AM.");
    s.say(" We also have openings at two PM.");
    await s.settle();

    expect(offers()).toBe(1);
    expect(cuts()).toBe(1);
  });

  it("does not cut once an availability call has verified something", async () => {
    const s = await boot();
    await s.checkAvailability();
    s.audio(2000);
    s.say("We have times available at ten AM and ten thirty AM. Do either work?");
    await s.settle();

    expect(offers()).toBe(0);
    expect(cuts()).toBe(0);
    expect(clears(s.ws)).toBe(0);
  });

  it("does not cut ordinary conversation", async () => {
    const s = await boot();
    s.audio(2000);
    s.say("Your appointment is at ten AM on Monday.");
    await s.settle();

    expect(offers()).toBe(0);
    expect(clears(s.ws)).toBe(0);
  });
});
