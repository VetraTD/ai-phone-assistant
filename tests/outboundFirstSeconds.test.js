// tests/outboundFirstSeconds.test.js
/**
 * Spec §9.3 (revised after spikes A and B): the first seconds of an outbound
 * call. `createFirstSecondsController` is pure -- a fake clock, a fake
 * audioOut that records what it is handed, and the seed / note / prompt seams
 * as recorders. The index.js wiring (the real barge path, the real mark
 * handler, the real clearAudio) is exercised in tests/liveOutboundStart.test.js.
 *
 * THE TIMELINE. `streamStartAtMs = 0`. The owner's measured hellos (1.87 s and
 * 2.2 s) and Ofcom's two limbs are measured from PICKUP, which is the stream
 * start minus the answer->stream offset spike B measured (319-334 ms). The
 * tests model that offset as ANSWER_TO_STREAM and convert pickup-relative
 * times with `fromPickup`, so "the owner's 1,870 ms hello" lands at 1,520 ms
 * on the stream clock -- BEFORE the 1,650 ms silence deadline, which is the
 * whole point of listening first.
 *
 * Every controller here is built with the module's DEFAULT timings (no
 * silenceBackstopMs / answerToStreamMs override), so a change to a default is
 * a change these tests can see.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createFirstSecondsController,
  BACKSTOP_END_MARK,
  FIRST_SECONDS_DEFAULTS,
  BACKSTOP_MARK_GRACE_MS,
  BACKSTOP_REFETCH_LEAD_MS,
} from "../lib/outbound/firstSeconds.js";

/** Let a started promise chain (the late clip re-read) settle. */
const flush = () => new Promise((r) => setImmediate(r));

/** The test's model of the measured answer -> stream-start offset (spike B). */
const ANSWER_TO_STREAM = 350;
/** A pickup-relative time, on the stream clock (streamStartAtMs = 0). */
const fromPickup = (ms) => ms - ANSWER_TO_STREAM;

const BACKSTOP_TEXT = "Hi, is that Sam? It's Ava, an AI assistant from Digile Media.";
const AUDIO = Buffer.alloc(8000, 0x7f); // one second of 8 kHz mu-law

function rig(overrides = {}) {
  const enqueue = vi.fn();
  const clear = vi.fn();
  const rec = { marks: [], seeds: [], notes: [], prompts: [], spoken: [], logs: [] };
  const log = {
    info: (event, fields) => rec.logs.push({ level: "info", event, fields }),
    error: (event, fields) => rec.logs.push({ level: "error", event, fields }),
  };
  const ctl = createFirstSecondsController({
    now: () => 0,
    backstopAudio: AUDIO,
    backstopText: BACKSTOP_TEXT,
    // `clear` is offered and must never be called: the controller has no
    // business protecting its clip from the normal barge path.
    audioOut: { enqueue, clear },
    sendMark: (name) => rec.marks.push(name),
    seed: (text) => rec.seeds.push(text),
    noteToModel: (text) => rec.notes.push(text),
    promptModel: (text) => rec.prompts.push(text),
    noteSpoken: (text, atMs) => rec.spoken.push({ text, atMs }),
    streamStartAtMs: 0,
    businessName: "Digile Media",
    personaName: "Ava",
    log,
    logFields: { callSid: "CA1", attemptId: "att-1" },
    ...overrides,
  });
  const events = (name) => rec.logs.filter((l) => l.event === name);
  return { ctl, enqueue, clear, rec, events };
}

/**
 * Twilio's media clock, the way index.js drives the controller: every frame
 * reports the caller's VAD verdict, then ticks. 10 ms steps so the exact
 * deadlines (1,650 / 2,600) are hit rather than straddled.
 */
function run(ctl, fromMs, toMs, voiced = () => false) {
  for (let t = fromMs; t <= toMs; t += 10) {
    ctl.onCallerFrame({ voiced: voiced(t), atMs: t });
    ctl.tick(t);
  }
}

describe("defaults are spec §9.3's numbers", () => {
  it("2,000 ms after pickup, 350 ms answer->stream, 1,600 ms slow-Live net", () => {
    expect(FIRST_SECONDS_DEFAULTS).toEqual({ answerToStreamMs: 350, silenceBackstopMs: 2000, slowLiveMs: 1600 });
  });
});

describe("1. listen first", () => {
  it("plays nothing while the person is silent, then the backstop at 1,650 ms (2,000 - 350), seeded once", () => {
    const { ctl, enqueue, rec, events } = rig();

    run(ctl, 0, 1640);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.seeds).toEqual([]);
    expect(ctl.firstAudio()).toBeNull();

    run(ctl, 1650, 1650);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]).toEqual([AUDIO]);
    expect(rec.marks).toEqual([BACKSTOP_END_MARK]);
    expect(rec.seeds).toEqual([BACKSTOP_TEXT]);
    expect(rec.spoken).toEqual([{ text: BACKSTOP_TEXT, atMs: 1650 }]);
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 2000, from_speech_ms: null, path: "backstop_silence" });
    expect(events("outbound_backstop_played")).toHaveLength(1);
    expect(events("outbound_first_audio")[0].fields).toMatchObject({
      callSid: "CA1",
      attemptId: "att-1",
      from_answer_ms: 2000,
      from_speech_ms: null,
      path: "backstop_silence",
    });

    // Once. The rest of the call never replays it.
    run(ctl, 1660, 6000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(rec.seeds).toHaveLength(1);
  });
});

describe("2. the person speaks and Live answers", () => {
  it("the owner's measured hello (1,870 ms after pickup) is not talked over; Live's reply is the first audio", () => {
    const { ctl, enqueue, rec } = rig();
    const hello = fromPickup(1870); // 1,520 on the stream clock
    const reply = fromPickup(2900);

    run(ctl, 0, reply - 10, (t) => t >= hello && t <= hello + 300);
    expect(enqueue).not.toHaveBeenCalled();

    expect(ctl.onModelAudio(reply)).toBe(true);
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 2900, from_speech_ms: 1030, path: "live_reply" });

    run(ctl, reply, 8000);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.seeds).toEqual([]);
  });
});

describe("3. slow Live", () => {
  it("speech onset at 1,000 ms with no model audio: the backstop at 2,600 ms (onset + 1,600), seeded", () => {
    const { ctl, enqueue, rec } = rig();

    run(ctl, 0, 2590, (t) => t >= 1000 && t <= 1400);
    expect(enqueue).not.toHaveBeenCalled();

    run(ctl, 2600, 2600);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(rec.seeds).toEqual([BACKSTOP_TEXT]);
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 2950, from_speech_ms: 1600, path: "backstop_slow" });
  });
});

describe("4. the backstop is interruptible", () => {
  it("speech during playback makes the controller do nothing special: no clear protection, no second clip", () => {
    const { ctl, enqueue, clear, rec } = rig();
    run(ctl, 0, 1650);
    expect(enqueue).toHaveBeenCalledTimes(1);
    // Handed over as ordinary audio -- the buffer alone, no flag that could
    // mark it non-interruptible.
    expect(enqueue.mock.calls[0]).toHaveLength(1);

    run(ctl, 1660, 2400, (t) => t >= 1700);

    expect(clear).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(rec.marks).toEqual([BACKSTOP_END_MARK]);
    expect(rec.seeds).toHaveLength(1);
    expect(rec.notes).toEqual([]);
    expect(rec.prompts).toEqual([]);
  });
});

describe("5. seeded suppression", () => {
  it("model audio before the backstop-end mark echoes is dropped; after the echo it plays", () => {
    const { ctl } = rig();
    run(ctl, 0, 1650);

    expect(ctl.onModelAudio(1700)).toBe(false);
    ctl.onMark("some-other-mark");
    expect(ctl.onModelAudio(1800)).toBe(false);

    ctl.onMark(BACKSTOP_END_MARK);
    expect(ctl.onModelAudio(2700)).toBe(true);
    // The first audio is still the backstop; a later reply does not rewrite it.
    expect(ctl.firstAudio().path).toBe("backstop_silence");
  });

  it("a clear (barge, clearAudio, vendor interrupted) lifts it: the mark never echoes and the next model audio PLAYS", () => {
    // audioOut.clear() empties the queue and its outstanding marks, so the
    // backstop-end mark is never sent and never echoed. Without the lift Live
    // would be muted for the rest of the call (spec §9.3 step 4: Live answers
    // a barge).
    const { ctl } = rig();
    run(ctl, 0, 1650);
    expect(ctl.onModelAudio(1700)).toBe(false);

    ctl.onAudioCleared();
    // ...and no mark ever arrives.
    expect(ctl.onModelAudio(1900)).toBe(true);
  });

  it("no suppression without a backstop: nothing is dropped on the live_reply path", () => {
    const { ctl } = rig();
    run(ctl, 0, 1000, (t) => t >= 500);
    expect(ctl.onModelAudio(1100)).toBe(true);
    expect(ctl.onModelAudio(1120)).toBe(true);
  });
});

describe("6. first-turn check (G3)", () => {
  const NOTE = "Tell them now, briefly: you are Ava, an AI assistant from Digile Media.";

  it("a first turn with no disclosure and no business name is corrected once, and logged", () => {
    const { ctl, rec, events } = rig();
    ctl.onAssistantTurnText("Hi, is that Sam?");
    expect(rec.notes).toEqual([NOTE]);
    expect(events("outbound_first_turn_incomplete")).toHaveLength(1);

    // A second incomplete turn does not call it again.
    ctl.onAssistantTurnText("Great, thanks.");
    expect(rec.notes).toEqual([NOTE]);
  });

  it("a complete first turn is left alone", () => {
    const { ctl, rec, events } = rig();
    ctl.onAssistantTurnText("Hi Sam, it's Ava, an AI assistant from Digile Media");
    expect(rec.notes).toEqual([]);
    expect(events("outbound_first_turn_incomplete")).toHaveLength(0);
  });

  it("the business name alone is not enough: the AI disclosure is required", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText("Hi Sam, it's Ava from Digile Media.");
    expect(rec.notes).toEqual([NOTE]);
  });

  it("the AI disclosure alone is not enough: the business name is required", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText("Hi Sam, it's Ava, an AI assistant.");
    expect(rec.notes).toEqual([NOTE]);
  });

  it("an empty turn (a tool round with no speech) does not use up the check", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText("");
    ctl.onAssistantTurnText("   ");
    ctl.onAssistantTurnText("Hi, is that Sam?");
    expect(rec.notes).toEqual([NOTE]);
  });

  it("when the backstop played, the backstop IS the first turn: it passes, and Live's next turn is not checked", () => {
    const { ctl, rec } = rig();
    run(ctl, 0, 1650);
    ctl.onAssistantTurnText("Great, what's the clinic called?");
    expect(rec.notes).toEqual([]);
  });
});

describe("7. no backstop audio (render failed or refused)", () => {
  it("the silence path prompts Live with the line instead, and logs outbound_backstop_missing", () => {
    const { ctl, enqueue, rec, events } = rig({ backstopAudio: null });

    run(ctl, 0, 1640);
    expect(rec.prompts).toEqual([]);

    run(ctl, 1650, 1650);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.seeds).toEqual([]); // Live will say it itself; nothing to seed
    expect(rec.prompts).toEqual([`The person hasn't spoken. Say: ${BACKSTOP_TEXT}`]);
    expect(events("outbound_backstop_missing")).toHaveLength(1);
    expect(events("outbound_backstop_missing")[0].fields).toMatchObject({ callSid: "CA1", attemptId: "att-1", path: "backstop_silence" });

    // Nothing is suppressed on this path: Live's audio IS the line.
    expect(ctl.onModelAudio(2300)).toBe(true);
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 2650, from_speech_ms: null, path: "backstop_silence" });

    run(ctl, 1660, 6000);
    expect(rec.prompts).toHaveLength(1);
  });

  it("an empty buffer is the same as none", () => {
    const { ctl, enqueue, rec } = rig({ backstopAudio: Buffer.alloc(0) });
    run(ctl, 0, 1650);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.prompts).toHaveLength(1);
  });

  it("the slow path with no audio logs the miss and does not talk over a reply Live is already making", () => {
    const { ctl, enqueue, rec, events } = rig({ backstopAudio: null });
    run(ctl, 0, 2600, (t) => t >= 1000 && t <= 1400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.prompts).toEqual([]);
    expect(events("outbound_backstop_missing")[0].fields).toMatchObject({ path: "backstop_slow" });

    expect(ctl.onModelAudio(3000)).toBe(true);
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 3350, from_speech_ms: 2000, path: "live_reply" });
  });
});

// ---------------------------------------------------------------------------
// Fix round 1.
// ---------------------------------------------------------------------------

describe("I1: a backstop cut before the disclosure does not count as the disclosure", () => {
  const NOTE = "Tell them now, briefly: you are Ava, an AI assistant from Digile Media.";

  it("the reviewer's probe: backstop -> an 800 ms barge clears it -> Live's next turn lacks the disclosure -> ONE correction", () => {
    const { ctl, rec, events } = rig();
    run(ctl, 0, 1650); // the backstop fires and starts playing
    expect(rec.notes).toEqual([]); // the full backstop text passed the check when it fired

    // "Yes, speaking" over the clip, before "It's Ava, an AI assistant…" is
    // reached. index.js's barge path clears the audio: onAudioCleared.
    run(ctl, 1660, 2460, (t) => t >= 1700);
    ctl.onAudioCleared();

    ctl.onAssistantTurnText("Great, thanks Sam. I'm calling about your enquiry.");
    expect(rec.notes).toEqual([NOTE]);
    expect(events("outbound_first_turn_incomplete")).toHaveLength(1);

    ctl.onAssistantTurnText("Is now a good time?");
    expect(rec.notes).toEqual([NOTE]);
  });

  it("a re-armed check passes a complete next turn without a note", () => {
    const { ctl, rec } = rig();
    run(ctl, 0, 1650);
    ctl.onAudioCleared();
    ctl.onAssistantTurnText("Sorry -- it's Ava, an AI assistant from Digile Media. Is that Sam?");
    expect(rec.notes).toEqual([]);
  });

  it("a clip that played to its end mark is not re-armed by a LATER clear", () => {
    const { ctl, rec } = rig();
    run(ctl, 0, 1650);
    ctl.onMark(BACKSTOP_END_MARK);
    ctl.onAudioCleared(); // e.g. a barge on Live's own reply later on
    ctl.onAssistantTurnText("Great, thanks Sam. I'm calling about your enquiry.");
    expect(rec.notes).toEqual([]);
  });

  it("the text of a reply whose audio was DROPPED during the clip cannot satisfy the re-armed check", () => {
    // Slow-Live shape: Live's reply was suppressed while the clip played, the
    // person barged, and the vendor then reports that (unheard) turn's text.
    const { ctl, rec } = rig();
    run(ctl, 0, 1650);
    expect(ctl.onModelAudio(1700)).toBe(false); // dropped
    ctl.onAudioCleared();
    ctl.onAssistantTurnText("Hi Sam, it's Ava, an AI assistant from Digile Media."); // never heard
    expect(rec.notes).toEqual([]);
    ctl.onAssistantTurnText("Great, what's the clinic called?"); // the first turn the person heard
    expect(rec.notes).toEqual([NOTE]);
  });
});

describe("M3: dotted spellings of AI count as the disclosure", () => {
  it.each([
    "Hi Sam, it's Ava, an A.I. assistant from Digile Media.",
    "Hi Sam, it's Ava, an A. I. assistant from Digile Media.",
    "Hi Sam, it's Ava, an a.i. assistant from Digile Media.",
  ])("%s -> no correction", (text) => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText(text);
    expect(rec.notes).toEqual([]);
  });

  it("a dotted form without the business name is still corrected", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText("Hi Sam, it's Ava, an A.I. assistant.");
    expect(rec.notes).toHaveLength(1);
  });
});

describe("M9: the suppression has a safety lift", () => {
  it("a mark that never echoes lifts it at clip length + BACKSTOP_MARK_GRACE_MS, logged", () => {
    const { ctl, events } = rig();
    run(ctl, 0, 1650); // 8,000 bytes = 1,000 ms of clip, fired at 1,650
    const liftAt = 1650 + 1000 + BACKSTOP_MARK_GRACE_MS;
    expect(BACKSTOP_MARK_GRACE_MS).toBe(1500);

    expect(ctl.onModelAudio(liftAt - 10)).toBe(false);
    ctl.tick(liftAt - 10);
    expect(ctl.suppressing()).toBe(true);

    ctl.tick(liftAt);
    expect(ctl.suppressing()).toBe(false);
    expect(ctl.onModelAudio(liftAt + 10)).toBe(true);
    expect(events("outbound_backstop_mark_timeout")).toHaveLength(1);
    expect(events("outbound_backstop_mark_timeout")[0].fields).toMatchObject({ callSid: "CA1", attemptId: "att-1", waited_ms: 2500 });
  });

  it("model audio alone (no frames) also sees the deadline", () => {
    const { ctl } = rig();
    run(ctl, 0, 1650);
    expect(ctl.onModelAudio(1650 + 1000 + BACKSTOP_MARK_GRACE_MS)).toBe(true);
  });

  it("an echoed mark lifts it first, and the timeout then logs nothing", () => {
    const { ctl, events } = rig();
    run(ctl, 0, 1650);
    ctl.onMark(BACKSTOP_END_MARK);
    run(ctl, 1660, 6000);
    expect(events("outbound_backstop_mark_timeout")).toHaveLength(0);
  });
});

describe("I4: no clip at stream start -- the stored clip is re-read once, before the deadline", () => {
  it(`reads at deadline - ${BACKSTOP_REFETCH_LEAD_MS} ms and plays the late clip at the deadline`, async () => {
    const LATE = Buffer.alloc(4000, 0x55);
    const refetch = vi.fn(async () => LATE);
    const { ctl, enqueue, rec, events } = rig({ backstopAudio: null, refetchBackstopAudio: refetch });

    run(ctl, 0, 1650 - BACKSTOP_REFETCH_LEAD_MS - 10);
    expect(refetch).not.toHaveBeenCalled();
    run(ctl, 1650 - BACKSTOP_REFETCH_LEAD_MS, 1650 - BACKSTOP_REFETCH_LEAD_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
    await flush();

    run(ctl, 1260, 1650);
    expect(enqueue).toHaveBeenCalledWith(LATE);
    expect(rec.prompts).toEqual([]);
    expect(rec.seeds).toEqual([BACKSTOP_TEXT]);
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ source: "refetched" });
    expect(events("outbound_backstop_missing")).toHaveLength(0);
    run(ctl, 1660, 4000);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a read still out at the deadline is a miss: the prompt path fires on time, and a late answer is ignored", async () => {
    let resolveLate;
    const refetch = vi.fn(() => new Promise((r) => (resolveLate = r)));
    const { ctl, enqueue, rec, events } = rig({ backstopAudio: null, refetchBackstopAudio: refetch });
    run(ctl, 0, 1650);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.prompts).toHaveLength(1);
    expect(events("outbound_backstop_missing")[0].fields).toMatchObject({ refetch: "pending" });

    resolveLate(Buffer.alloc(800, 1));
    await flush();
    run(ctl, 1660, 4000);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a read that fails, or finds nothing, is the prompt path", async () => {
    for (const refetch of [vi.fn(async () => { throw new Error("db down"); }), vi.fn(async () => null)]) {
      const { ctl, enqueue, rec } = rig({ backstopAudio: null, refetchBackstopAudio: refetch });
      run(ctl, 0, 1300);
      await flush();
      run(ctl, 1310, 1650);
      expect(refetch).toHaveBeenCalledTimes(1);
      expect(enqueue).not.toHaveBeenCalled();
      expect(rec.prompts).toHaveLength(1);
    }
  });

  it("no re-read when there is a clip already", () => {
    const refetch = vi.fn(async () => Buffer.alloc(10));
    const { ctl } = rig({ refetchBackstopAudio: refetch });
    run(ctl, 0, 1650);
    expect(refetch).not.toHaveBeenCalled();
  });
});
