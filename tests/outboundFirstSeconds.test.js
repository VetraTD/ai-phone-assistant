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
  FIRST_AUDIO_MARK,
  FIRST_TURN_END_MARK,
  FIRST_SECONDS_DEFAULTS,
  BACKSTOP_MARK_GRACE_MS,
  BACKSTOP_REFETCH_LEAD_MS,
  ONSET_CONFIRM_DEFER_MS,
  CLIP_BARGE_MIN_MS,
  STALE_GENERATION_GRACE_MS,
  firstTurnComplete,
} from "../lib/outbound/firstSeconds.js";
import { createVad } from "../lib/voice/inboundVad.js";

/** Full-scale mu-law (RMS 32,124) and digital silence: what the real VAD reads as voice and not. */
const LOUD = Buffer.alloc(160, 0x00);
const QUIET = Buffer.alloc(160, 0xff);

/** Let a started promise chain (the late clip re-read) settle. */
const flush = () => new Promise((r) => setImmediate(r));

/** The test's model of the measured answer -> stream-start offset (spike B). */
const ANSWER_TO_STREAM = 350;
/** A pickup-relative time, on the stream clock (streamStartAtMs = 0). */
const fromPickup = (ms) => ms - ANSWER_TO_STREAM;

const BACKSTOP_TEXT = "Hi, is that Sam? It's Ava, an AI assistant from Digile Media.";
const AUDIO = Buffer.alloc(8000, 0x7f); // one second of 8 kHz mu-law

const vads = new WeakMap();

/**
 * S3-2 (spec §19, S3-D2): this rig defaults `firstSpeaker` to "live" -- the
 * OLD race every test below `rig()`'s original section (1-7, fix rounds 1-3,
 * checkpoint 2b review) was written against, and the brief's contract item 6
 * requires those tests to keep passing UNCHANGED. Rather than touch every one
 * of those call sites, the default carries the "live" mode forward and only
 * the NEW S3-2 describe blocks (below the fix-round-3/checkpoint-2b-review
 * sections) opt into `firstSpeaker: "clip"` explicitly -- clip mode is the
 * PRODUCTION default (the controller's own constructor default, asserted
 * directly, without going through this rig, in "S3-2: clip is the
 * production default").
 */
function rig(overrides = {}) {
  const rec = { marks: [], seeds: [], notes: [], prompts: [], spoken: [], logs: [], wire: [], counters: [] };
  // `wire` is the ORDER things were handed over: marks and audio interleaved.
  const enqueue = vi.fn((buf) => rec.wire.push({ audio: buf.length }));
  const clear = vi.fn();
  const log = {
    info: (event, fields) => rec.logs.push({ level: "info", event, fields }),
    error: (event, fields) => rec.logs.push({ level: "error", event, fields }),
  };
  const ctl = createFirstSecondsController({
    now: () => 0,
    backstopAudio: AUDIO,
    backstopText: BACKSTOP_TEXT,
    // `clear` is offered and must never be called: the controller has no
    // business protecting its clip from the normal barge path -- ONLY its
    // own onCallerFrame's `clipBarge` verdict (S3-2) reports a recommendation;
    // index.js is what actually calls audioOut.clear.
    audioOut: { enqueue, clear },
    sendMark: (name) => {
      rec.marks.push(name);
      rec.wire.push({ mark: name });
    },
    seed: (text) => rec.seeds.push(text),
    noteToModel: (text) => rec.notes.push(text),
    promptModel: (text) => rec.prompts.push(text),
    noteSpoken: (text, atMs) => rec.spoken.push({ text, atMs }),
    bumpCounter: (name) => rec.counters.push(name),
    firstSpeaker: "live",
    streamStartAtMs: 0,
    businessName: "Digile Media",
    personaName: "Ava",
    log,
    logFields: { callSid: "CA1", attemptId: "att-1" },
    ...overrides,
  });
  vads.set(ctl, createVad());
  const events = (name) => rec.logs.filter((l) => l.event === name);
  return { ctl, enqueue, clear, rec, events };
}

/**
 * Twilio's media clock, the way index.js drives the controller: every frame
 * goes through the REAL inboundVad, its verdict ({voiced, voiceActive}) goes
 * to onCallerFrame, then the controller ticks. 10 ms steps so the exact
 * deadlines (1,650 / 2,600) are hit rather than straddled. `voiced(t)` says
 * whether the frame at `t` is loud.
 */
function run(ctl, fromMs, toMs, voiced = () => false) {
  const vad = vads.get(ctl);
  for (let t = fromMs; t <= toMs; t += 10) {
    const v = vad.processFrame(voiced(t) ? LOUD : QUIET, t);
    // voicedRunMs (S3-2): the same value index.js's own vad.voicedRunMs(atMs)
    // would report, passed through so the clip-barge threshold (onCallerFrame's
    // OWN concern, gated on clipPlaying) can be exercised through this shared
    // helper too. It is 0 whenever the caller is not both active and mid-run,
    // so every pre-S3-2 test above (which never checks onCallerFrame's return
    // value) is unaffected by its presence.
    ctl.onCallerFrame({ voiced: v.voiced, voiceActive: v.voiceActive, atMs: t, voicedRunMs: vad.voicedRunMs(t) });
    ctl.tick(t);
  }
}

describe("defaults are spec §9.3's numbers", () => {
  // CHANGED (S3-2, P-a): silenceBackstopMs 2,000 -> 1,750 -- live round 1's T1
  // found the clip PLAYING OUT at 2.09-2.11 s (queue time + mark-echo
  // latency), breaching Ofcom's 2.0 s limb even though the clip did fire.
  // helloEndGapMs is new: the clip mode default's third timer.
  it("1,750 ms after pickup, 350 ms answer->stream, 1,600 ms slow-Live net, 350 ms hello-end gap", () => {
    expect(FIRST_SECONDS_DEFAULTS).toEqual({ answerToStreamMs: 350, silenceBackstopMs: 1750, slowLiveMs: 1600, helloEndGapMs: 350 });
  });

  // T1's own margin, pinned: the OLD 2,000 ms queue deadline left no room at
  // all for mark-echo latency before crossing Ofcom's 2.0 s line; this pins
  // that the new default leaves at least 150 ms of it.
  it("T1's margin: silenceBackstopMs + 150 <= 2000", () => {
    expect(FIRST_SECONDS_DEFAULTS.silenceBackstopMs + 150).toBeLessThanOrEqual(2000);
  });
});

describe("1. listen first", () => {
  // CHANGED (S3-2, P-a): 1,650/2,000 -> 1,400/1,750 -- silenceBackstopMs's
  // default moved from 2,000 to 1,750 (T1), so the stream-clock fire time
  // (silenceBackstopMs - answerToStreamMs) moved with it. The mechanism under
  // test (nothing plays while silent, then the clip fires once, seeded) is
  // unchanged; only the deadline's own number is.
  it("plays nothing while the person is silent, then the backstop at 1,400 ms (1,750 - 350), seeded once", () => {
    const { ctl, enqueue, rec, events } = rig();

    run(ctl, 0, 1390);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.seeds).toEqual([]);
    expect(ctl.firstAudio()).toBeNull();

    run(ctl, 1400, 1400);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]).toEqual([AUDIO]);
    // The playout mark right before the clip (O-7), the end mark right after.
    expect(rec.wire).toEqual([{ mark: FIRST_AUDIO_MARK }, { audio: AUDIO.length }, { mark: BACKSTOP_END_MARK }]);
    expect(rec.seeds).toEqual([BACKSTOP_TEXT]); // the SILENCE path seeds at fire time
    expect(rec.spoken).toEqual([{ text: BACKSTOP_TEXT, atMs: 1400 }]);
    // Queued, not yet heard to play: the queue-time value, flagged as such.
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 1750, from_speech_ms: null, path: "backstop_silence", measured: "enqueue" });
    expect(events("outbound_backstop_played")).toHaveLength(1);
    expect(events("outbound_first_audio")).toHaveLength(0);

    ctl.onMark(FIRST_AUDIO_MARK, 1400);
    expect(events("outbound_first_audio")[0].fields).toMatchObject({
      callSid: "CA1",
      attemptId: "att-1",
      from_answer_ms: 1750,
      from_speech_ms: null,
      path: "backstop_silence",
      measured: "playout",
    });

    // Once. The rest of the call never replays it.
    run(ctl, 1410, 6000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(rec.seeds).toHaveLength(1);
  });
});

describe("2. the person speaks and Live answers", () => {
  // CHANGED (S3-2, P-a): the hello moved from fromPickup(1870) to
  // fromPickup(1200) -- see the P-a trade-off test right below this one. With
  // silenceBackstopMs now 1,750 (was 2,000), a hello starting at 1,870 ms
  // after pickup arrives AFTER the (lowered) silence deadline, so the
  // deferral mechanism (O-6) never gets a run to hold back: nothing has been
  // said yet AT ALL when the deadline itself fires. A faster hello (1,200 ms
  // after pickup, comfortably inside the new deadline) is what this test
  // needs to keep demonstrating the mechanism it is actually about: onset
  // backdating and Live's reply measured at playout, in `live` mode's kept
  // race. `from_speech_ms` is recomputed for the new hello time.
  it("a hello well inside the (lowered) silence deadline is not talked over; Live's reply is the first audio", () => {
    const { ctl, enqueue, rec } = rig();
    const hello = fromPickup(1200); // 850 on the stream clock
    const queuedAt = fromPickup(2800);
    const playedAt = fromPickup(2900);

    run(ctl, 0, queuedAt - 10, (t) => t >= hello && t <= hello + 300);
    expect(enqueue).not.toHaveBeenCalled();
    // Confirmed by the VAD 200 ms in, BACKDATED to where the hello began (O-6).
    expect(ctl.onsetAt()).toBe(hello);

    expect(ctl.onModelAudio(queuedAt)).toBe(true);
    expect(rec.marks).toEqual([FIRST_AUDIO_MARK]);
    ctl.onMark(FIRST_AUDIO_MARK, playedAt);
    // Measured at PLAYOUT (O-7), from the start of the hello.
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 2900, from_speech_ms: 1700, path: "live_reply", measured: "playout" });

    run(ctl, queuedAt, 8000);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.seeds).toEqual([]);
  });

  // S3-2, P-a's named trade-off (findings for the report, not just a test):
  // the owner's TWO measured hellos (1.87 s and 2.2 s after pickup) both now
  // arrive AFTER the lowered silence deadline (1.75 s), in EITHER
  // `firstSpeaker` mode -- silenceBackstopMs is not mode-gated (T1's false
  // "silent call" flag is a two-limb-rule/playout-timing problem, not a
  // clip-vs-live one). The backstop fires anyway at the deadline, exactly as
  // it does on a truly silent pickup; what makes THIS survivable and not a
  // repeat of D1 is step 4's interruptibility (I1) -- the person's actual
  // hello either barges the clip (a run past CLIP_BARGE_MIN_MS, clip mode
  // only) or, in `live` mode, is simply what Live hears and answers next,
  // same as any barge on assistant audio always has been.
  it("P-a's trade-off: the owner's 1.87 s hello now arrives AFTER the deadline -- the backstop still fires (relies on interruptibility, not avoidance)", () => {
    const { ctl, enqueue } = rig();
    const hello = fromPickup(1870); // 1,520 on the stream clock -- AFTER 1,400
    run(ctl, 0, 1390, (t) => t >= hello && t <= hello + 300); // nobody has spoken yet by 1,390
    expect(enqueue).not.toHaveBeenCalled();
    run(ctl, 1400, 1400);
    expect(enqueue).toHaveBeenCalledTimes(1); // fired anyway: backstop_silence, not backstop_hello_end (live mode has no hello-end timer)
  });
});

describe("3. slow Live", () => {
  it("speech onset at 1,000 ms with no model audio: the backstop at 2,600 ms (onset + 1,600), seeded when it has PLAYED", () => {
    const { ctl, enqueue, rec } = rig();

    run(ctl, 0, 2590, (t) => t >= 1000 && t <= 1400);
    expect(enqueue).not.toHaveBeenCalled();

    run(ctl, 2600, 2600);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(rec.seeds).toEqual([]); // O-8: not at fire time on the slow path
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 2950, from_speech_ms: 1600, path: "backstop_slow", measured: "enqueue" });
    ctl.onMark(BACKSTOP_END_MARK, 3700);
    expect(rec.seeds).toEqual([BACKSTOP_TEXT]);
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
    expect(rec.marks).toEqual([FIRST_AUDIO_MARK, BACKSTOP_END_MARK]);
    expect(rec.seeds).toHaveLength(1);
    expect(rec.notes).toEqual([]);
    expect(rec.prompts).toEqual([]);
  });
});

describe("5. seeded suppression", () => {
  // CHANGED (NB3, fix round 3, re-review 2): this test used to call
  // `ctl.onMark(BACKSTOP_END_MARK)` with NO `atMs`, which defaults to
  // `now()` -- 0 in this rig -- rather than a realistic echo time. That put
  // `catchMidClipGeneration`'s own grace deadline (item 3, fix round 2) at
  // 0 + STALE_GENERATION_GRACE_MS = 2,000, BEFORE the next chunk at 2,700 --
  // so the chunk passed via a SPURIOUS outbound_stale_discard_timeout, not
  // because the mark echoed and the generation genuinely closed, which is
  // what this test is named for. (The re-review also found the report had
  // mis-cited a DIFFERENT test, "a clear ... lifts it", as the one relying
  // on this bound; that test calls onAudioCleared, not onMark, so it can
  // never reach catchMidClipGeneration at all -- this is the one.)
  it("model audio before the backstop-end mark echoes is dropped; after the echo AND the generation closes, it plays", () => {
    const { ctl } = rig();
    run(ctl, 0, 1650);

    expect(ctl.onModelAudio(1700)).toBe(false);
    ctl.onMark("some-other-mark");
    expect(ctl.onModelAudio(1800)).toBe(false);

    // A realistic echo time (the clip's own ~1,000 ms after its 1,400 ms
    // fire), not atMs=0.
    ctl.onMark(BACKSTOP_END_MARK, 2400);
    // Still dropped: the mark echoing is not the signal on its own (S3-2's
    // own point) -- the generation opened by the two chunks above has not
    // yet reported its own end (condition (i)).
    expect(ctl.onModelAudio(2500)).toBe(false);
    ctl.onAssistantTurnText("hello", true, 2600); // NOW it closes, for real
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

    run(ctl, 0, 1390);
    expect(rec.prompts).toEqual([]);

    run(ctl, 1400, 1400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.seeds).toEqual([]); // Live will say it itself; nothing to seed
    expect(rec.prompts).toEqual([`The person hasn't spoken. Say: ${BACKSTOP_TEXT}`]);
    expect(events("outbound_backstop_missing")).toHaveLength(1);
    expect(events("outbound_backstop_missing")[0].fields).toMatchObject({ callSid: "CA1", attemptId: "att-1", path: "backstop_silence" });

    // Nothing is suppressed on this path: Live's audio IS the line. It is
    // measured at its own playout, like every other path (O-7).
    expect(ctl.onModelAudio(2300)).toBe(true);
    expect(rec.marks).toEqual([FIRST_AUDIO_MARK]);
    ctl.onMark(FIRST_AUDIO_MARK, 2400);
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 2750, from_speech_ms: null, path: "backstop_silence", measured: "playout" });

    run(ctl, 1410, 6000);
    expect(rec.prompts).toHaveLength(1);
  });

  it("an empty buffer is the same as none", () => {
    const { ctl, enqueue, rec } = rig({ backstopAudio: Buffer.alloc(0) });
    run(ctl, 0, 1400);
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
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 3350, from_speech_ms: 2000, path: "live_reply", measured: "enqueue" });
  });
});

// M3 (fix round 1): the legacy no-clip/silence-path scenarios, run in CLIP
// mode too -- the rig() default is "live" (see its own docstring), so
// without this the production default never exercised these at all. Both
// scenarios here have no onset ever confirmed, so they behave identically
// in either mode (no generation can be open at fire; M3's own new behaviour
// only bites on the SLOW path, covered separately above in "S3-2:
// stale-audio discard").
describe("7 in clip mode: the silence-path no-clip scenarios are unaffected by mode", () => {
  it("the silence path prompts Live with the line instead, and logs outbound_backstop_missing", () => {
    const { ctl, enqueue, rec, events } = rig({ backstopAudio: null, firstSpeaker: "clip" });
    run(ctl, 0, 1400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.seeds).toEqual([]);
    expect(rec.prompts).toEqual([`The person hasn't spoken. Say: ${BACKSTOP_TEXT}`]);
    expect(events("outbound_backstop_missing")).toHaveLength(1);
    expect(ctl.onModelAudio(2300)).toBe(true); // no generation was ever open: forwarded, same as live mode
  });

  it("an empty buffer is the same as none", () => {
    const { ctl, enqueue, rec } = rig({ backstopAudio: Buffer.alloc(0), firstSpeaker: "clip" });
    run(ctl, 0, 1400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.prompts).toHaveLength(1);
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
    run(ctl, 0, 1650); // 8,000 bytes = 1,000 ms of clip, fired at 1,400 (S3-2: silenceBackstopMs 1,750)
    const liftAt = 1400 + 1000 + BACKSTOP_MARK_GRACE_MS;
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
    expect(ctl.onModelAudio(1400 + 1000 + BACKSTOP_MARK_GRACE_MS)).toBe(true);
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

    // S3-2: the deadline this races against is now 1,400 (silenceBackstopMs
    // 1,750, was 2,000), so the refetch-lead trigger point moves with it.
    run(ctl, 0, 1400 - BACKSTOP_REFETCH_LEAD_MS - 10);
    expect(refetch).not.toHaveBeenCalled();
    run(ctl, 1400 - BACKSTOP_REFETCH_LEAD_MS, 1400 - BACKSTOP_REFETCH_LEAD_MS);
    expect(refetch).toHaveBeenCalledTimes(1);
    await flush();

    run(ctl, 1010, 1400);
    expect(enqueue).toHaveBeenCalledWith(LATE);
    expect(rec.prompts).toEqual([]);
    expect(rec.seeds).toEqual([BACKSTOP_TEXT]);
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ source: "refetched" });
    expect(events("outbound_backstop_missing")).toHaveLength(0);
    run(ctl, 1410, 4000);
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

// ---------------------------------------------------------------------------
// Fix round 2 -- owner decisions O-6, O-7, O-8 (and O-9's controller half).
// ---------------------------------------------------------------------------

describe("O-6: onset is confirmed speech (the VAD's sustained flag), backdated to where it began", () => {
  // CHANGED (S3-2, P-a): 1,510/1,160/1,640/1,650 -> shifted by the same -250
  // ms the deadline itself moved (1,650 -> 1,400).
  it("a single loud frame at pickup + 1.26 s, nobody speaking: the backstop still goes at the silence deadline (no 2.85 s breach)", () => {
    const { ctl, enqueue, events } = rig();
    const click = fromPickup(1260); // 910 on the stream clock
    run(ctl, 0, 1390, (t) => t === click);
    expect(ctl.onsetAt()).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    run(ctl, 1400, 1400);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ path: "backstop_silence" });
    // Nothing held it back, so no deferral is reported (fix round 3).
    expect(events("outbound_backstop_played")[0].fields).not.toHaveProperty("deferred_ms");
  });

  // CHANGED (S3-2, P-a): the hello moved from fromPickup(1870) to
  // fromPickup(1200) for the same reason as section 2's replacement test --
  // 1,870 ms after pickup now arrives AFTER the lowered silence deadline
  // (see "P-a's trade-off", section 2), so it can no longer demonstrate
  // "caught before the deadline". The mechanism under test (onsetAt backdated
  // to the hello's true start; from_speech_ms measured from there) is
  // unaffected by which hello time is used.
  it("a real hello at pickup + 1.2 s is caught, and from_speech_ms runs from the start of the hello", () => {
    const { ctl, enqueue } = rig();
    const hello = fromPickup(1200); // 850 on the stream clock
    run(ctl, 0, 2400, (t) => t >= hello && t <= hello + 400);
    expect(enqueue).not.toHaveBeenCalled();
    expect(ctl.onsetAt()).toBe(hello);
    ctl.onModelAudio(2400);
    ctl.onMark(FIRST_AUDIO_MARK, 2450);
    expect(ctl.firstAudio()).toMatchObject({ from_speech_ms: 2450 - hello, path: "live_reply", measured: "playout" });
  });

  it("a run in progress but unconfirmed at the deadline DEFERS the backstop; it confirms, and nothing is played over it", () => {
    const { ctl, enqueue } = rig();
    // Voice from 1,350: at the 1,400 deadline it is 50 ms old, unconfirmed.
    run(ctl, 0, 1400, (t) => t >= 1350);
    expect(enqueue).not.toHaveBeenCalled();
    run(ctl, 1410, 1950, (t) => t >= 1350 && t <= 1750);
    expect(ctl.onsetAt()).toBe(1350); // confirmed at 1,550, backdated
    expect(enqueue).not.toHaveBeenCalled();
    // From here it is the slow-Live clock: onset + 1,600.
    run(ctl, 1960, 2940);
    expect(enqueue).not.toHaveBeenCalled();
    run(ctl, 2950, 2950);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("a run in progress at the deadline that DIES fires the moment it dies, inside the deferral cap", () => {
    const { ctl, enqueue, events } = rig();
    run(ctl, 0, 1450, (t) => t >= 1350 && t <= 1450);
    expect(enqueue).not.toHaveBeenCalled();
    run(ctl, 1460, 1460); // the first quiet frame
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ path: "backstop_silence", deferred_ms: 60 });
    expect(1460).toBeLessThanOrEqual(1400 + ONSET_CONFIRM_DEFER_MS);
  });

  it("never holds past the cap, whatever the VAD does", () => {
    // A VAD that keeps calling frames voiced and never confirms.
    const { ctl, enqueue } = rig();
    expect(ONSET_CONFIRM_DEFER_MS).toBe(200);
    for (let t = 1350; t <= 1750; t += 10) {
      ctl.onCallerFrame({ voiced: true, voiceActive: false, atMs: t });
      ctl.tick(t);
      if (t < 1400 + ONSET_CONFIRM_DEFER_MS) expect(enqueue).not.toHaveBeenCalled();
    }
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("O-7: the G2 metric is taken at PLAYOUT, on every path", () => {
  it("the metric equals the playout time (the first-audio mark's echo), not the queue time", () => {
    const { ctl, events } = rig();
    run(ctl, 0, 1650); // queued at 1,400 = pickup + 1,750 (S3-2)
    ctl.onMark(FIRST_AUDIO_MARK, 1580); // started playing 180 ms later
    expect(ctl.firstAudio()).toEqual({ from_answer_ms: 1930, from_speech_ms: null, path: "backstop_silence", measured: "playout" });
    expect(events("outbound_first_audio").map((e) => e.fields.from_answer_ms)).toEqual([1930]);
  });

  it("the mark goes on the wire BEFORE the first frame of our first audio", () => {
    const { ctl, rec } = rig();
    run(ctl, 0, 1650);
    expect(rec.wire[0]).toEqual({ mark: FIRST_AUDIO_MARK });
    expect(rec.wire[1]).toEqual({ audio: AUDIO.length });
  });

  it("no echo before the session ends: the queue-time value is logged, flagged measured enqueue -- once", () => {
    const { ctl, events } = rig();
    run(ctl, 0, 1650);
    ctl.onSessionEnd();
    ctl.onSessionEnd();
    const logged = events("outbound_first_audio");
    expect(logged).toHaveLength(1);
    expect(logged[0].fields).toMatchObject({ from_answer_ms: 1750, measured: "enqueue" });
  });

  it("an echo logs once, and session end then adds nothing", () => {
    const { ctl, events } = rig();
    run(ctl, 0, 1650);
    ctl.onMark(FIRST_AUDIO_MARK, 1450);
    ctl.onMark(FIRST_AUDIO_MARK, 1650);
    ctl.onSessionEnd();
    expect(events("outbound_first_audio").map((e) => e.fields.measured)).toEqual(["playout"]);
    expect(ctl.firstAudio().from_answer_ms).toBe(1800);
  });

  it("the queue deadline itself is unchanged: queued at pickup + 1.75 s (S3-2)", () => {
    const { ctl, enqueue } = rig();
    run(ctl, 0, 1390);
    expect(enqueue).not.toHaveBeenCalled();
    run(ctl, 1400, 1400);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("O-8: the SLOW-path seed waits for the clip to have played", () => {
  it("no seed at fire time; exactly one when the end mark echoes", () => {
    const { ctl, rec, events } = rig();
    run(ctl, 0, 2600, (t) => t >= 1000 && t <= 1400);
    expect(rec.wire.filter((w) => w.audio)).toHaveLength(1);
    expect(rec.seeds).toEqual([]);
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ path: "backstop_slow", seed: "at_end_mark" });
    expect(ctl.onModelAudio(2700)).toBe(false); // still suppressed while it plays

    ctl.onMark(BACKSTOP_END_MARK, 3650);
    expect(rec.seeds).toEqual([BACKSTOP_TEXT]);
    ctl.onMark(BACKSTOP_END_MARK, 3700);
    expect(rec.seeds).toEqual([BACKSTOP_TEXT]);
  });

  it("a slow-path clip cut by a barge is NEVER seeded, even if its end mark turns up later", () => {
    const { ctl, rec } = rig();
    run(ctl, 0, 2600, (t) => t >= 1000 && t <= 1400);
    ctl.onAudioCleared();
    ctl.onMark(BACKSTOP_END_MARK, 3000);
    expect(rec.seeds).toEqual([]);
  });

  it("a slow-path clip whose end mark never echoes is not seeded late by the safety lift", () => {
    const { ctl, rec, events } = rig();
    run(ctl, 0, 2600, (t) => t >= 1000 && t <= 1400);
    run(ctl, 2610, 2600 + 1000 + BACKSTOP_MARK_GRACE_MS);
    expect(rec.seeds).toEqual([]);
    expect(events("outbound_backstop_mark_timeout")[0].fields).toMatchObject({ seed_dropped: true });
  });

  it("the SILENCE path still seeds at fire time", () => {
    const { ctl, rec, events } = rig();
    run(ctl, 0, 1650);
    expect(rec.seeds).toEqual([BACKSTOP_TEXT]);
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ seed: "at_fire" });
  });
});

describe("O-9 (controller half): no usable line at all", () => {
  it("no text and no clip: the silence path asks Live to introduce itself with the disclosure", () => {
    const { ctl, enqueue, rec, events } = rig({ backstopText: null, backstopAudio: null });
    run(ctl, 0, 1650);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.prompts).toEqual([
      "The person hasn't spoken. Say briefly, in your own words, that you are Ava, an AI assistant from Digile Media.",
    ]);
    expect(events("outbound_backstop_missing")[0].fields).toMatchObject({ line: "none" });
    expect(rec.prompts.join(" ")).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  it("a clip with no text is never played (the clip says something the session cannot seed)", () => {
    const { ctl, enqueue, rec } = rig({ backstopText: null });
    run(ctl, 0, 1650);
    expect(enqueue).not.toHaveBeenCalled();
    expect(rec.seeds).toEqual([]);
    expect(rec.prompts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fix round 3.
// ---------------------------------------------------------------------------

describe("round 3: the dotted-AI fold only folds a TRUE acronym (the G3 check must not fail open)", () => {
  const BRIGHTWORK = { businessName: "Brightwork", personaName: "Ava" };

  it.each([
    "Hi Sam, it's Ava from Digile Media, calling about Plan A. I wanted to check in.",
    "Hi Sam, it's Ava from Digile Media. Your clinic got a grade A. I'll explain.",
  ])("%s -> incomplete: a correction is sent", (text) => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText(text);
    expect(rec.notes).toEqual(["Tell them now, briefly: you are Ava, an AI assistant from Digile Media."]);
  });

  it.each(["Hi Sam, it's Ava, an A.I. assistant from Brightwork.", "Hi Sam, it's Ava, an A. I. assistant from Brightwork."])(
    "%s -> complete: no correction",
    (text) => {
      const { ctl, rec } = rig(BRIGHTWORK);
      ctl.onAssistantTurnText(text);
      expect(rec.notes).toEqual([]);
    }
  );
});

describe("round 3: deferred_ms is reported only for a real deferral", () => {
  // CHANGED (S3-2, P-a): shifted by the same -250 ms as the deadline itself.
  it("a run that CONFIRMED during the deferral leaves no deferred_ms on the later slow-path fire", () => {
    const { ctl, events } = rig();
    // The reviewer's probe shape: voice from 1,310 -- unconfirmed at the 1,400
    // deadline (deferral starts), confirmed at 1,510, slow fire at 2,910.
    run(ctl, 0, 2910, (t) => t >= 1310 && t <= 1650);
    const played = events("outbound_backstop_played");
    expect(played).toHaveLength(1);
    expect(played[0].fields).toMatchObject({ path: "backstop_slow" });
    expect(played[0].fields).not.toHaveProperty("deferred_ms");
  });

  it("a deferral that ended in a silence fire is reported, on the missing-clip line too", () => {
    const { ctl, events } = rig({ backstopAudio: null });
    run(ctl, 0, 1460, (t) => t >= 1350 && t <= 1450);
    expect(events("outbound_backstop_missing")[0].fields).toMatchObject({ path: "backstop_silence", deferred_ms: 60 });
  });
});

// ---------------------------------------------------------------------------
// Checkpoint 2b review, I5 + M3.
// ---------------------------------------------------------------------------

describe("M3 (checkpoint 2b review): firstTurnComplete tolerates a glued transcript (H1's re-split, reused)", () => {
  it("a glued disclosure AND a glued business name both recover -- the render check's own H1 fixture, applied to the session's first-turn check", () => {
    expect(
      firstTurnComplete("Hi, isthat Sam? It'sAva, an AIassistant from HarnessTest Clinic.", "Harness Test Clinic")
    ).toBe(true);
  });

  it("still incomplete when the SAME gluing also drops the disclosure entirely", () => {
    expect(
      firstTurnComplete("Hi, isthat Sam? It'sAva, an assistant from HarnessTest Clinic.", "Harness Test Clinic")
    ).toBe(false);
  });

  it("a glued token that cannot be segmented from the vocab stays a miss, but does not block the OTHER tokens that can", () => {
    expect(firstTurnComplete("Hi, isthot Sam. AIassistant HarnessTest Clinic.", "Harness Test Clinic")).toBe(true);
  });

  it("round 3's fail-open guard survives the re-split: 'A. I wanted' is still two words, not the disclosure", () => {
    expect(firstTurnComplete("Plan A. I wanted to check in, from Digile Media.", "Digile Media")).toBe(false);
  });
});

describe("I5 (checkpoint 2b review): Live's own first turn is confirmed HEARD, not merely generated", () => {
  const NOTE = "Tell them now, briefly: you are Ava, an AI assistant from Digile Media.";
  const COMPLETE_TEXT = "Hi Sam, it's Ava, an AI assistant from Digile Media.";
  const INCOMPLETE_TEXT = "Hi, is that Sam?";

  it("an INTERRUPTED turn with the full disclosure never satisfies the check: no note, no mark queued, still armed for the next turn", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText(COMPLETE_TEXT, false);
    expect(rec.notes).toEqual([]);
    expect(rec.marks).toEqual([]);
    // Still armed: the NEXT (complete) turn is judged on its own text, and
    // this one has no disclosure at all -- proof the interrupted turn's
    // content was never credited.
    ctl.onAssistantTurnText(INCOMPLETE_TEXT, true);
    expect(rec.notes).toEqual([NOTE]);
  });

  it("an INTERRUPTED turn that lacks the disclosure does not correct either -- an interrupted turn never corrects, only re-arms", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText(INCOMPLETE_TEXT, false);
    expect(rec.notes).toEqual([]);
    // Still armed: a later COMPLETE turn is checked fresh and queues its mark.
    ctl.onAssistantTurnText(COMPLETE_TEXT, true);
    expect(rec.marks).toEqual([FIRST_TURN_END_MARK]);
    expect(rec.notes).toEqual([]);
  });

  it("a COMPLETE turn that passes the text check queues FIRST_TURN_END_MARK and is not yet satisfied", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText(COMPLETE_TEXT, true);
    expect(rec.marks).toEqual([FIRST_TURN_END_MARK]);
    expect(rec.notes).toEqual([]);

    // Undecided, not satisfied: a second turn arriving before the mark echoes
    // is neither corrected nor re-checked -- it is ignored until the mark
    // resolves one way or the other.
    ctl.onAssistantTurnText(INCOMPLETE_TEXT, true);
    expect(rec.notes).toEqual([]);
  });

  it("the check is satisfied only once FIRST_TURN_END_MARK echoes -- a later incomplete turn then does not correct", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText(COMPLETE_TEXT, true);
    ctl.onMark(FIRST_TURN_END_MARK);
    ctl.onAssistantTurnText(INCOMPLETE_TEXT, true);
    expect(rec.notes).toEqual([]);
  });

  it("audio cleared BEFORE the mark echoes re-arms the check silently -- no note fires for the clear itself", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText(COMPLETE_TEXT, true);
    expect(rec.marks).toEqual([FIRST_TURN_END_MARK]);

    ctl.onAudioCleared(); // the barge cut it before the mark echoed
    expect(rec.notes).toEqual([]);

    // Re-armed: the NEXT complete turn is judged fresh, and this one fails.
    ctl.onAssistantTurnText(INCOMPLETE_TEXT, true);
    expect(rec.notes).toEqual([NOTE]);
  });

  it("a mark that HAS already echoed is not undone by a later, unrelated clear", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText(COMPLETE_TEXT, true);
    ctl.onMark(FIRST_TURN_END_MARK);
    ctl.onAudioCleared(); // some later, unrelated barge on a subsequent turn
    ctl.onAssistantTurnText(INCOMPLETE_TEXT, true);
    expect(rec.notes).toEqual([]); // already satisfied; not re-armed
  });

  it("onAssistantTurnText with no second argument defaults to complete (every pre-I5 call site)", () => {
    const { ctl, rec } = rig();
    ctl.onAssistantTurnText(COMPLETE_TEXT);
    expect(rec.marks).toEqual([FIRST_TURN_END_MARK]);
    expect(rec.notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S3-2 (spec §19, S3-D2, live round 1): the clip ALWAYS plays first.
//
// Every test below opts into `firstSpeaker: "clip"` explicitly even though it
// is the constructor's own default (see the very first test in this section),
// so each one reads as a deliberate choice rather than an accident of what
// `rig()` happens to default to.
// ---------------------------------------------------------------------------

describe("S3-2: clip mode is the production default", () => {
  it("createFirstSecondsController with no firstSpeaker option never lets Live speak first", () => {
    // Built directly (not through rig(), whose OWN default is "live" -- see
    // that function's docstring) so this is a true test of the constructor's
    // default, matching how lib/voice/live/index.js constructs it when
    // OUTBOUND_FIRST_SPEAKER is unset.
    const enqueue = vi.fn();
    const ctl = createFirstSecondsController({
      now: () => 0,
      backstopAudio: AUDIO,
      backstopText: BACKSTOP_TEXT,
      audioOut: { enqueue, clear: vi.fn() },
      sendMark: () => {},
      seed: () => {},
      noteToModel: () => {},
      streamStartAtMs: 0,
      businessName: "Digile Media",
      personaName: "Ava",
    });
    // A chunk arriving before ANY backstop decision: in "live" mode this
    // would be forwarded (path=live_reply). Here it is discarded.
    expect(ctl.onModelAudio(10)).toBe(false);
  });
});

describe("S3-2: the clip always plays first, at the FIRST of three timers", () => {
  it("nobody speaks: the clip is queued at 1,750 ms after pickup (backstop_silence), same as live mode", () => {
    const { ctl, enqueue, events } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1390);
    expect(enqueue).not.toHaveBeenCalled();
    run(ctl, 1400, 1400);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ path: "backstop_silence" });
  });

  it("short hello: onset at 1,100 ms, voice to 1,550 ms -> the clip at 1,900 ms (helloEndGapMs after the run ends), backstop_hello_end", () => {
    const { ctl, enqueue, events } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1890, (t) => t >= 1100 && t <= 1550);
    expect(enqueue).not.toHaveBeenCalled();
    expect(ctl.onsetAt()).toBe(1100);
    run(ctl, 1900, 1900);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ path: "backstop_hello_end" });
  });

  it("long talk: onset at 1,000 ms, voice continuing (no end) -> the clip at 2,600 ms (onset + slowLiveMs), backstop_slow", () => {
    const { ctl, enqueue, events } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 2590, (t) => t >= 1000);
    expect(enqueue).not.toHaveBeenCalled();
    run(ctl, 2600, 2600);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ path: "backstop_slow" });
  });

  it("Live's reply is never waited for and never played: audio arriving before the clip decision is discarded, not raced", () => {
    const { ctl, enqueue, rec } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1100, (t) => t >= 500 && t <= 700); // a hello, then quiet
    expect(ctl.onModelAudio(1150)).toBe(false); // Live's reply: discarded
    run(ctl, 1110, 1900); // the hello-end timer still fires the clip regardless
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(rec.seeds).toHaveLength(0); // hello-end path: seed deferred to the end mark (O-8)
  });
});

describe("S3-2: clip barge threshold (CLIP_BARGE_MIN_MS)", () => {
  it(`a ${CLIP_BARGE_MIN_MS - 200} ms caller run during the clip never reports clipBarge`, () => {
    const { ctl } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1400); // the silence backstop fires and starts playing
    const vad = vads.get(ctl);
    let sawBarge = false;
    for (let t = 1410; t <= 1410 + (CLIP_BARGE_MIN_MS - 200); t += 10) {
      const v = vad.processFrame(LOUD, t);
      const { clipBarge } = ctl.onCallerFrame({ voiced: v.voiced, voiceActive: v.voiceActive, atMs: t, voicedRunMs: vad.voicedRunMs(t) });
      if (clipBarge) sawBarge = true;
      ctl.tick(t);
    }
    expect(sawBarge).toBe(false);
    expect(ctl.clipPlaying()).toBe(true); // still playing -- never cleared
  });

  it(`a ${CLIP_BARGE_MIN_MS + 300} ms run reports clipBarge exactly once; index.js's clearAudio (onAudioCleared) then re-arms the first-turn check`, () => {
    const { ctl, rec } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1400); // the clip's full text already passed the first-turn check when it fired
    expect(rec.notes).toEqual([]);
    const vad = vads.get(ctl);
    let bargeCount = 0;
    for (let t = 1410; t <= 1410 + (CLIP_BARGE_MIN_MS + 300); t += 10) {
      const v = vad.processFrame(LOUD, t);
      const { clipBarge } = ctl.onCallerFrame({ voiced: v.voiced, voiceActive: v.voiceActive, atMs: t, voicedRunMs: vad.voicedRunMs(t) });
      if (clipBarge) bargeCount += 1;
      ctl.tick(t);
    }
    expect(bargeCount).toBe(1);
    // The controller only RECOMMENDS; index.js is what actually clears the
    // audio and calls onAudioCleared -- simulated directly here.
    ctl.onAudioCleared();
    ctl.onAssistantTurnText("Great, thanks Sam. I'm calling about your enquiry.");
    expect(rec.notes).toEqual(["Tell them now, briefly: you are Ava, an AI assistant from Digile Media."]);
  });

  // M2 (fix round 1): CLIP_BARGE_MIN_MS is clip-mode-only. `live` mode is the
  // pre-S3-2 race verbatim, including its ORDINARY (lower, gate-driven)
  // barge threshold -- this file's own 600 ms carve-out must not leak into
  // it, or "pass under live unchanged" (contract item 6) is false for this
  // one behaviour.
  it(`live mode: clipBarge never fires, however long the run, and clipPlaying() reads false even while the clip is on the wire`, () => {
    const { ctl, enqueue } = rig({ firstSpeaker: "live" });
    run(ctl, 0, 1400); // the silence backstop fires and starts playing (live mode fires a clip too, rule 6)
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(ctl.clipPlaying()).toBe(false); // gated off in live mode, even though the clip IS playing
    const vad = vads.get(ctl);
    let sawBarge = false;
    for (let t = 1410; t <= 1410 + (CLIP_BARGE_MIN_MS + 300); t += 10) {
      const v = vad.processFrame(LOUD, t);
      const { clipBarge } = ctl.onCallerFrame({ voiced: v.voiced, voiceActive: v.voiceActive, atMs: t, voicedRunMs: vad.voicedRunMs(t) });
      if (clipBarge) sawBarge = true;
      ctl.tick(t);
    }
    expect(sawBarge).toBe(false); // never -- index.js's ordinary (300 ms) gate threshold governs instead
  });
});

describe("S3-2: stale-audio discard (named risks 1, 2, 4)", () => {
  it("6 chunks from the pre-clip generation -- some during the clip, some after its end mark -- never reach the socket; the shadow log counts all 6 and measures the first one", () => {
    const { ctl, enqueue, rec, events } = rig({ firstSpeaker: "clip" });
    // Onset at 1,000, hello ends at 1,200 -> backstop_hello_end at 1,550
    // (before the 2,600 slow deadline).
    run(ctl, 0, 1290, (t) => t >= 1000 && t <= 1200);
    // A generation is already in flight when the clip queues: chunk 1, BEFORE
    // the clip has even fired (clip mode discards it on that ground alone).
    expect(ctl.onModelAudio(1300)).toBe(false);
    run(ctl, 1310, 1550, (t) => t >= 1000 && t <= 1200);
    expect(enqueue).toHaveBeenCalledTimes(1); // fired: backstop_hello_end
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ path: "backstop_hello_end" });

    // Chunks 2-3: DURING the clip's own playback.
    expect(ctl.onModelAudio(1700)).toBe(false);
    expect(ctl.onModelAudio(1900)).toBe(false);

    // The clip's end mark echoes (~1,000 ms of clip audio after 1,550): the
    // seed goes, but the generation open when the clip queued has not closed.
    ctl.onMark(BACKSTOP_END_MARK, 2600);
    expect(rec.seeds).toHaveLength(1);
    expect(ctl.clipPlaying()).toBe(false);

    // Chunks 4-6: AFTER the end mark, BEFORE the stale generation's own
    // turnComplete/interrupted -- named risk 1's exact probe. Still dropped.
    expect(ctl.onModelAudio(2700)).toBe(false);
    expect(ctl.onModelAudio(2900)).toBe(false);
    expect(ctl.onModelAudio(3100)).toBe(false);

    // Only now does the stale generation report its own close.
    ctl.onAssistantTurnText("stale reply the person never heard", false, 3200);

    // A NEW generation's chunk, after both conditions are met, is forwarded.
    expect(ctl.onModelAudio(3300)).toBe(true);

    ctl.onSessionEnd();
    const shadow = events("outbound_live_shadow");
    expect(shadow).toHaveLength(1);
    expect(shadow[0].fields).toMatchObject({
      callSid: "CA1",
      attemptId: "att-1",
      discarded_chunks: 6,
      from_speech_ms: 1300 - 1000, // the FIRST discarded chunk (1,300), from onset (1,000)
      from_speech_end_ms: 1300 - 1200, // ...and from the hello's own end (1,200)
    });
    expect(rec.counters).toContain("outbound_live_shadow");
  });

  // C1 (fix round 1). Every test above this one feeds its first stale chunk
  // BEFORE the clip fires, which the queue-time snapshot alone already
  // catches. The REALISTIC hello timing is the other order: Live's
  // voice-to-voice latency is normally longer than helloEndGapMs (350 ms),
  // so on the typical hello call the clip queues FIRST and Live's reply to
  // that same hello only starts generating afterwards -- still before the
  // seed, since the seed itself waits for the end-mark echo.
  it("C1: a chunk that arrives AFTER the clip is queued but BEFORE the seed is sent is still stale -- the realistic hello timing", () => {
    const { ctl, enqueue, rec, events } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1550, (t) => t >= 1000 && t <= 1200); // hello ends at 1,200; clip queues at 1,550
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(events("outbound_backstop_played")[0].fields).toMatchObject({ path: "backstop_hello_end" });
    expect(rec.seeds).toHaveLength(0); // deferred to the end mark

    // Nothing was open AT QUEUE TIME (1,550) -- the OLD snapshot-only check
    // would have lifted the discard the instant the seed went. Live's reply
    // to the hello only starts generating now.
    expect(ctl.onModelAudio(1700)).toBe(false);

    ctl.onMark(BACKSTOP_END_MARK, 2600); // the end mark echoes; the seed goes
    expect(rec.seeds).toHaveLength(1);
    expect(ctl.onModelAudio(2700)).toBe(false); // still stale: the seed did not close this generation
    expect(ctl.onModelAudio(2900)).toBe(false);

    ctl.onAssistantTurnText("stale reply the person never heard", false, 3000);
    expect(ctl.onModelAudio(3100)).toBe(true); // a NEW generation, now trusted
  });

  it("C1's G variant: a stale generation closes DURING the clip, and a NEW one opens before the seed -- also discarded until IT closes", () => {
    const { ctl, rec } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1550, (t) => t >= 1000 && t <= 1200);
    expect(ctl.onModelAudio(1700)).toBe(false); // generation A opens
    ctl.onAssistantTurnText("generation A", false, 2000); // A closes, mid-clip
    expect(ctl.onModelAudio(2100)).toBe(false); // generation B opens, still before the seed

    ctl.onMark(BACKSTOP_END_MARK, 2600); // seed goes; B is still open
    expect(rec.seeds).toHaveLength(1);
    expect(ctl.onModelAudio(2700)).toBe(false); // B is still stale

    ctl.onAssistantTurnText("generation B", false, 2800); // B closes
    expect(ctl.onModelAudio(2900)).toBe(true);
  });

  // I1 (fix round 1). The pure controller's own half of I1: if onAudioCleared
  // is ever invoked while the clip is STILL PLAYING (clipPlaying() true) --
  // whatever the reason -- M4 says only condition (ii) is abandoned; a
  // generation genuinely open keeps the discard, on its own grace clock
  // started at the clear. (index.js's own half -- that a vendor `interrupted`
  // no longer reaches this call at all while the clip plays -- is
  // liveOutboundStart.test.js's "I1: a vendor `interrupted` does not clear
  // the clip" below.)
  it("M4: onAudioCleared while the clip is STILL PLAYING drops only condition (ii) -- a generation still open keeps the discard, on a fresh grace clock", () => {
    const { ctl, enqueue, events } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1550, (t) => t >= 1000 && t <= 1200); // backstop_hello_end fires and starts playing
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(ctl.onModelAudio(1700)).toBe(false); // a generation is open
    expect(ctl.clipPlaying()).toBe(true); // the clip's own audio is still on the wire

    ctl.onAudioCleared(2000); // e.g. a genuine >= CLIP_BARGE_MIN_MS barge, before the end mark
    expect(ctl.clipPlaying()).toBe(false); // the clip itself is gone
    expect(ctl.onModelAudio(2050)).toBe(false); // but the OPEN generation still has not closed

    // Its own grace clock, started at the clear (2,000) -- there is no seed
    // instant to anchor it to any more, since the seed was never sent.
    const liftAt = 2000 + STALE_GENERATION_GRACE_MS;
    expect(ctl.onModelAudio(liftAt - 10)).toBe(false);
    ctl.tick(liftAt);
    expect(ctl.onModelAudio(liftAt)).toBe(true);
    expect(events("outbound_stale_discard_timeout")).toHaveLength(1);
  });

  it("M4: the M9 mark-echo timeout also drops only condition (ii) -- a generation still open keeps the discard, on a fresh grace clock", () => {
    const { ctl, events } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1550, (t) => t >= 1000 && t <= 1200);
    expect(ctl.onModelAudio(1700)).toBe(false); // a generation is open
    const clipMs = 1000; // AUDIO is 8,000 bytes = 1,000 ms of clip
    const markTimeoutAt = 1550 + clipMs + BACKSTOP_MARK_GRACE_MS; // the mark never echoes

    expect(ctl.onModelAudio(markTimeoutAt - 10)).toBe(false);
    ctl.tick(markTimeoutAt);
    expect(events("outbound_backstop_mark_timeout")).toHaveLength(1);
    expect(ctl.onModelAudio(markTimeoutAt + 10)).toBe(false); // condition (i) alone did not lift it

    const liftAt = markTimeoutAt + STALE_GENERATION_GRACE_MS;
    expect(ctl.onModelAudio(liftAt - 10)).toBe(false);
    ctl.tick(liftAt);
    expect(ctl.onModelAudio(liftAt)).toBe(true);
    expect(events("outbound_stale_discard_timeout")).toHaveLength(1);
  });

  it("named risk 4: a turnComplete that never arrives does not mute Live forever -- STALE_GENERATION_GRACE_MS after the seed, the discard lifts anyway, logged", () => {
    const { ctl, enqueue, events } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1190, (t) => t >= 1000);
    expect(ctl.onModelAudio(1200)).toBe(false); // a generation in flight, never to close
    run(ctl, 1200, 2600, (t) => t >= 1000);
    expect(enqueue).toHaveBeenCalledTimes(1);
    ctl.onMark(BACKSTOP_END_MARK, 3700); // seed sent at 3,700; the grace clock starts here
    const liftAt = 3700 + STALE_GENERATION_GRACE_MS;

    expect(ctl.onModelAudio(liftAt - 10)).toBe(false);
    ctl.tick(liftAt - 10);
    expect(ctl.onModelAudio(liftAt)).toBe(true); // never muted forever
    expect(events("outbound_stale_discard_timeout")).toHaveLength(1);
    expect(events("outbound_stale_discard_timeout")[0].fields).toMatchObject({ callSid: "CA1", attemptId: "att-1", waited_ms: STALE_GENERATION_GRACE_MS });
  });

  // M3 (fix round 1, Ruling): no clip (the render failed or refused), clip
  // mode, on the slow path -- a generation open at the moment of decision
  // must be dropped WHOLE, never partially (its HEAD was already dropped by
  // the never-let-Live-speak-first rule; forwarding its TAIL from here on
  // would play a sentence starting mid-way through). Ruling: drop the whole
  // thing and let the NEXT generation speak, rather than buffer-and-replay
  // the dropped head -- replaying unvetted content would risk exactly the
  // D1 overlap this file exists to prevent.
  it("M3: no clip, clip mode, slow path -- a generation open at the decision is dropped WHOLE, not partially", () => {
    const { ctl, enqueue, rec, events } = rig({ firstSpeaker: "clip", backstopAudio: null });
    run(ctl, 0, 1190, (t) => t >= 1000); // onset confirmed; continuous hello (slow path)
    expect(ctl.onModelAudio(1200)).toBe(false); // pre-decision: never let Live speak first (head dropped)
    run(ctl, 1200, 2600, (t) => t >= 1000); // through the slow deadline (1,000 + 1,600)
    expect(enqueue).not.toHaveBeenCalled(); // no clip to play
    expect(events("outbound_backstop_missing")[0].fields).toMatchObject({ path: "backstop_slow" });
    expect(rec.prompts).toEqual([]); // slow path: no prompt -- Live is already replying

    // Past the decision (backstopFired is now true): the SAME generation is
    // still dropped, not resumed mid-sentence.
    expect(ctl.onModelAudio(2650)).toBe(false);
    expect(ctl.onModelAudio(2900)).toBe(false);

    ctl.onAssistantTurnText("the reply the person only half-heard", false, 3000);
    expect(ctl.onModelAudio(3100)).toBe(true); // a NEW generation is trusted from here
  });

  // N1 (fix round 2, re-review). The ORIGINAL M3 fix (fix round 1) armed
  // `staleDiscard` on the no-clip path but never set staleDiscardFrom/
  // staleDiscardDeadline, so named risk 4 (a turnComplete that never
  // arrives) was NOT actually bounded here -- the re-review's own probe saw
  // chunks still dropped at 20, 30 and 60 s with no timeout ever logged.
  // This proves the bound directly: the SAME STALE_GENERATION_GRACE_MS the
  // has-clip paths use.
  it("N1: the no-clip M3 discard is bounded too -- if the generation never closes, it lifts at STALE_GENERATION_GRACE_MS after the decision, logged", () => {
    const { ctl, events } = rig({ firstSpeaker: "clip", backstopAudio: null });
    run(ctl, 0, 1190, (t) => t >= 1000);
    expect(ctl.onModelAudio(1200)).toBe(false);
    run(ctl, 1200, 2600, (t) => t >= 1000); // the slow-path decision fires at 2,600, no clip
    const liftAt = 2600 + STALE_GENERATION_GRACE_MS;

    expect(ctl.onModelAudio(liftAt - 10)).toBe(false); // still discarded, well past 20/30/60 s in real terms
    ctl.tick(liftAt - 10);
    expect(ctl.onModelAudio(liftAt)).toBe(true); // never muted forever
    expect(events("outbound_stale_discard_timeout")).toHaveLength(1);
    expect(events("outbound_stale_discard_timeout")[0].fields).toMatchObject({ waited_ms: STALE_GENERATION_GRACE_MS });
  });

  // N2/item 2 (fix round 2). Unlike every has-clip path, the no-clip M3
  // scenario has NOTHING else said to the caller -- dropping Live's only
  // reply whole left them in real silence until they spoke again. A one-off
  // nudge, reusing the SAME prompt mechanism the silence path's own no-clip
  // case already uses, fires once the dropped generation resolves.
  it("N2: after the whole no-clip generation closes for real, Live is re-prompted once so the caller is not left in dead air", () => {
    const { ctl, rec, events } = rig({ firstSpeaker: "clip", backstopAudio: null });
    run(ctl, 0, 1190, (t) => t >= 1000);
    expect(ctl.onModelAudio(1200)).toBe(false);
    run(ctl, 1200, 2600, (t) => t >= 1000);
    expect(rec.prompts).toEqual([]); // not yet -- the drop has not resolved

    ctl.onAssistantTurnText("the dropped reply", false, 3000); // it finally closes
    expect(rec.prompts).toEqual([`The person hasn't heard you yet. Say: ${BACKSTOP_TEXT}`]);
    expect(events("outbound_no_clip_reprompt")).toHaveLength(1);
    expect(rec.counters).toContain("outbound_no_clip_reprompt");

    // Once only: a later, unrelated turn does not reprompt again.
    ctl.onAssistantTurnText("something else entirely", true, 3500);
    expect(rec.prompts).toHaveLength(1);
  });

  it("N2: the grace-timeout resolution ALSO re-prompts Live once (named risk 4's bound is one of the two ways this can resolve)", () => {
    const { ctl, rec, events } = rig({ firstSpeaker: "clip", backstopAudio: null });
    run(ctl, 0, 1190, (t) => t >= 1000);
    expect(ctl.onModelAudio(1200)).toBe(false);
    run(ctl, 1200, 2600, (t) => t >= 1000);
    const liftAt = 2600 + STALE_GENERATION_GRACE_MS;
    ctl.tick(liftAt);
    expect(events("outbound_stale_discard_timeout")).toHaveLength(1);
    expect(events("outbound_no_clip_reprompt")).toHaveLength(1);
    expect(rec.prompts).toHaveLength(1);
  });

  // NB1 (fix round 3, re-review 2). Re-review 2's probe P3: the caller
  // speaking again, before the armed no-clip generation (A) ever reports its
  // own end, must cancel the reprompt -- in production A usually closes
  // BECAUSE the caller spoke (Live's `interrupted` fires on hearing them),
  // so reprompting at that instant makes Live talk over them.
  it("NB1: the caller speaking again after the drop cancels the reprompt -- Live's reply to them is coming anyway", () => {
    const { ctl, rec, events } = rig({ firstSpeaker: "clip", backstopAudio: null });
    expect(ctl.onModelAudio(300)).toBe(false); // Live already generating (A), before any onset
    run(ctl, 0, 1550, (t) => t >= 1000 && t <= 1200); // a hello, then quiet: hello-end fires at 1,550 (1,200 + 350), arming the reprompt
    expect(rec.prompts).toEqual([]); // not yet -- A has not resolved

    // The caller speaks AGAIN -- a new, sustained voiced run, after the
    // original hello's own hangover has expired.
    run(ctl, 1650, 1900, (t) => t >= 1650);

    ctl.onAssistantTurnText("A's reply, now moot", false, 2000); // A finally closes
    expect(rec.prompts).toEqual([]); // NOT reprompted: the caller is not in dead air
    expect(events("outbound_no_clip_reprompt")).toHaveLength(0);
  });

  // NB2 (fix round 3, re-review 2). Re-review 2's probe P4: the SILENCE
  // path's own no-clip case already prompts Live itself (fireBackstop, a few
  // lines above the M3 arm) -- arming the SAME reprompt there too fired it a
  // second time, exactly as A (the dropped generation) closed answering
  // prompt 1. Scoped away from this one path.
  it("NB2: the silence path with no clip and a generation already open prompts Live only once, not twice", () => {
    const { ctl, rec, events } = rig({ firstSpeaker: "clip", backstopAudio: null });
    expect(ctl.onModelAudio(300)).toBe(false); // Live already replying to something our own VAD never confirmed (I1 route (a))
    run(ctl, 0, 1400); // nobody speaks: the silence deadline fires -- backstop_silence, no clip
    expect(rec.prompts).toEqual([`The person hasn't spoken. Say: ${BACKSTOP_TEXT}`]); // prompt #1, the silence path's own line

    ctl.onAssistantTurnText("whatever that reply was", false, 1600); // the dropped generation finally closes
    expect(rec.prompts).toHaveLength(1); // NOT prompted again
    expect(events("outbound_no_clip_reprompt")).toHaveLength(0);
  });

  // Item 3 (fix round 2, re-review out-of-scope observation 1). Silence
  // path: nothing open at fire, so the seed goes at once and the discard
  // lifts trivially -- but the caller then answers "yes" mid-clip and Live
  // starts replying. Its head is dropped by `clipPlaying` alone; without
  // catchMidClipGeneration, its tail played mid-sentence the instant the
  // clip's own end mark echoed. The SAME whole-or-nothing rule M3 applies
  // on the no-clip path now applies here too.
  it("item 3: silence path, a generation opens mid-clip (the caller answers 'yes') -- dropped WHOLE, not partially, once the clip ends normally", () => {
    const { ctl, enqueue, rec } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1400); // silence path fires; seed sent AT FIRE (nothing was open)
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(rec.seeds).toEqual([BACKSTOP_TEXT]);

    expect(ctl.onModelAudio(1700)).toBe(false); // dropped: the clip is still on the wire

    ctl.onMark(BACKSTOP_END_MARK, 2600); // the clip's own end mark echoes normally
    expect(ctl.onModelAudio(2700)).toBe(false); // NOT forwarded mid-sentence -- caught, still stale

    ctl.onAssistantTurnText("yes, I can help with that", false, 2900); // the generation closes
    expect(ctl.onModelAudio(3000)).toBe(true); // a NEW generation, now trusted
  });

  // Scoping ruling (fix round 2): a BARGE or the M9 mark-timeout must NOT
  // extend the discard this way -- both are pre-existing tests (section 5,
  // "M9") this file already pins, and both represent the caller (or a lost
  // event) actively ending the clip, not it finishing on its own schedule.
  // Extending item 3's catch to those paths regressed both (RED-confirmed
  // below); scoped to the NORMAL end-mark-echo path only.

  it("a call with no discarded chunk still logs the shadow line, with from_speech_end_ms and from_speech_ms null -- never skipped", () => {
    const { ctl, events } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1890, (t) => t >= 1100 && t <= 1550); // a hello, nothing ever discarded
    run(ctl, 1900, 1900);
    ctl.onSessionEnd();
    expect(events("outbound_live_shadow")).toHaveLength(1);
    expect(events("outbound_live_shadow")[0].fields).toMatchObject({
      discarded_chunks: 0,
      from_speech_ms: null,
      from_speech_end_ms: null,
    });
  });

  it("a truly silent call (no onset at all) never logs the shadow line", () => {
    const { ctl, events } = rig({ firstSpeaker: "clip" });
    run(ctl, 0, 1400);
    ctl.onSessionEnd();
    expect(events("outbound_live_shadow")).toHaveLength(0);
  });
});

describe("S3-2: OUTBOUND_FIRST_SPEAKER=live keeps the old race (contract item 6)", () => {
  // The whole rest of this file (every describe block above this one) IS
  // that contract: rig()'s own default is "live", and every pre-S3-2 test
  // passes unchanged (bar the deliberate default-number updates, listed in
  // the S3-2 task report). This block adds only what those tests could not
  // already show: rule 6's OWN claim, that a stale generation cannot exist
  // when a live-mode clip fires at all.
  it("rule 6 is automatically satisfied: in live mode, ANY Live audio before a backstop decision already IS the first audio (live_reply), so a clip only ever fires when nothing was in flight", () => {
    const { ctl, enqueue } = rig({ firstSpeaker: "live" });
    run(ctl, 0, 990, (t) => t >= 500 && t <= 700); // a hello, unconfirmed... no, confirmed and died
    expect(ctl.onModelAudio(950)).toBe(true); // Live's own reply -- forwarded, not discarded
    run(ctl, 1000, 6000);
    expect(enqueue).not.toHaveBeenCalled(); // the backstop can never fire now: queued !== null
  });
});
