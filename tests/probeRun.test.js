import { describe, it, expect, vi } from "vitest";
import { createProbeRun, FRAME_BYTES } from "../lib/probe/probeRun.js";

// ---------------------------------------------------------------------------
// The probe is the far-end half of a Twilio->Twilio test call: it plays fixed
// caller audio into the assistant and times how long the reply takes to come
// back. Its clock sits OUTSIDE the server process, past both Twilio hops, so
// it measures the wait a real caller experiences — including Deepgram's
// endpointing, carrier transit and the pacing pump, none of which any
// in-process metric can see.
//
// Everything here is injected (clock, frame sink, VAD input) so the state
// machine is testable without a socket, a phone call, or real time passing.
// ---------------------------------------------------------------------------

/** Loud mu-law bytes: far enough from 0xFF silence to read as voiced. */
function voicedFrame(n = FRAME_BYTES) {
  return Buffer.alloc(n, 0x10);
}

/** Mu-law silence, the value Twilio pads with. */
function silentFrame(n = FRAME_BYTES) {
  return Buffer.alloc(n, 0xff);
}

/** A script utterance of `frames` frames of voiced audio. */
function utterance(label, frames, extra = {}) {
  return { label, mulaw: Buffer.alloc(frames * FRAME_BYTES, 0x10), ...extra };
}

function setup({ script, ...opts } = {}) {
  let t = 0;
  const sent = [];
  const run = createProbeRun({
    script: script ?? [utterance("u1", 2)],
    sendFrame: (buf) => sent.push(buf),
    now: () => t,
    ...opts,
  });
  return {
    run,
    sent,
    now: () => t,
    /** Advance the clock and pump `count` 20ms ticks. */
    ticks(count) {
      for (let i = 0; i < count; i++) {
        t += 20;
        run.tick();
      }
    },
    /** Deliver `count` frames of inbound audio, one per 20ms tick. */
    inbound(count, frame = voicedFrame()) {
      for (let i = 0; i < count; i++) {
        t += 20;
        run.handleInbound(frame);
        run.tick();
      }
    },
  };
}

/** Play the assistant's greeting through, so the run reaches the script. */
function passGreeting(h) {
  h.inbound(20, voicedFrame()); // 400ms of assistant audio
  h.inbound(60, silentFrame()); // 1200ms of silence: ends the greeting, clears the gap
}

describe("probeRun — scripted caller side of a measured test call", () => {
  it("waits for the assistant's greeting before saying anything", () => {
    const h = setup({ script: [utterance("u1", 2)] });

    h.ticks(50); // a full second passes with the assistant still greeting

    // Speaking over the greeting would make the first measured turn a
    // barge-in rather than a clean turn, and every later turn would inherit
    // the resulting timing skew.
    expect(h.sent.length).toBe(0);
  });

  it("starts the first utterance once the greeting has finished", () => {
    const h = setup({ script: [utterance("u1", 2)] });

    passGreeting(h);
    h.ticks(2);

    expect(h.sent.length).toBeGreaterThan(0);
  });

  it("measures the reply as first-AI-audio minus our last frame", () => {
    const h = setup({ script: [utterance("u1", 2)] });
    passGreeting(h);

    h.ticks(2); // both frames go out; speech ends 20ms after the last one
    h.inbound(10, silentFrame()); // 200ms of dead air on the line
    h.inbound(1, voicedFrame()); // assistant starts talking

    const [turn] = h.run.getTurns();
    expect(turn.label).toBe("u1");
    expect(turn.probeV2vMs).toBe(200);
  });

  it("ignores assistant audio that overlaps our own speech", () => {
    // Audio arriving before we stopped talking is the assistant still
    // finishing its previous line (or echo) — counting it would report a
    // reply that started before the question did.
    const h = setup({ script: [utterance("u1", 10)] });
    passGreeting(h);

    h.inbound(3, voicedFrame()); // assistant audio while we are mid-utterance
    h.ticks(7); // finish our 10 frames
    h.inbound(5, silentFrame());
    h.inbound(1, voicedFrame());

    const [turn] = h.run.getTurns();
    expect(turn.probeV2vMs).toBe(100); // measured from OUR speech end, not earlier
  });

  it("records a null measurement instead of hanging when no reply arrives", () => {
    const h = setup({ script: [utterance("u1", 2)], replyTimeoutMs: 1000 });
    passGreeting(h);

    h.ticks(2);
    h.inbound(60, silentFrame()); // 1200ms of nothing

    const [turn] = h.run.getTurns();
    expect(turn.probeV2vMs).toBeNull();
    expect(turn.timedOut).toBe(true);
  });

  it("moves to the next utterance after the assistant stops speaking", () => {
    const h = setup({
      script: [utterance("u1", 2), utterance("u2", 2)],
      silenceMs: 400,
      gapMs: 200,
    });
    passGreeting(h);

    h.ticks(2);
    h.inbound(1, voicedFrame()); // reply starts
    h.inbound(5, voicedFrame()); // reply continues
    const sentAfterFirst = h.sent.length;
    h.inbound(30, silentFrame()); // 600ms silence, then the gap elapses
    h.ticks(4);

    expect(h.sent.length).toBeGreaterThan(sentAfterFirst);
    expect(h.run.getTurns().length).toBeGreaterThanOrEqual(1);
  });

  it("interrupts mid-reply for an utterance marked as a barge-in", () => {
    const h = setup({
      script: [utterance("u1", 2), utterance("u2", 2, { bargeInAfterMs: 100 })],
    });
    passGreeting(h);

    h.ticks(2);
    const beforeReply = h.sent.length;
    h.inbound(1, voicedFrame()); // assistant begins its reply
    h.inbound(8, voicedFrame()); // 160ms into it, past the 100ms barge point

    // The whole point of the barge turn is to speak while the assistant still
    // is — waiting for silence would measure an ordinary turn instead.
    expect(h.sent.length).toBeGreaterThan(beforeReply);
    expect(h.run.getTurns()[0].label).toBe("u1");
  });

  it("marks the barge turn so its timing is not pooled with clean turns", () => {
    const h = setup({
      script: [utterance("u1", 2), utterance("u2", 2, { bargeInAfterMs: 100 })],
      silenceMs: 400,
      gapMs: 200,
    });
    passGreeting(h);

    h.ticks(2);
    h.inbound(1, voicedFrame());
    h.inbound(8, voicedFrame());
    h.ticks(2);
    h.inbound(5, silentFrame());
    h.inbound(1, voicedFrame());

    const bargeTurn = h.run.getTurns().find((t) => t.label === "u2");
    expect(bargeTurn?.bargeIn).toBe(true);
  });

  it("reports done once the script is exhausted", () => {
    const h = setup({ script: [utterance("u1", 2)], silenceMs: 400, gapMs: 200 });
    passGreeting(h);

    expect(h.run.isDone()).toBe(false);

    h.ticks(2);
    h.inbound(1, voicedFrame());
    h.inbound(30, silentFrame());
    h.ticks(15);

    expect(h.run.isDone()).toBe(true);
  });

  it("sends exactly one 160-byte frame per tick, so audio plays at realtime", () => {
    // Twilio plays what it is given at 8kHz; bursting frames would compress
    // our utterance in time and desynchronise every measurement after it.
    const h = setup({ script: [utterance("u1", 5)] });
    passGreeting(h);

    h.ticks(3);

    expect(h.sent.length).toBe(3);
    for (const f of h.sent) expect(f.length).toBe(FRAME_BYTES);
  });

  it("stops sending after stop() even if ticks keep arriving", () => {
    const h = setup({ script: [utterance("u1", 10)] });
    passGreeting(h);
    h.ticks(2);
    const sentBefore = h.sent.length;

    h.run.stop();
    h.ticks(10);

    expect(h.sent.length).toBe(sentBefore);
    expect(h.run.isDone()).toBe(true);
  });

  it("never lets a frame-sink failure kill the run", () => {
    let t = 0;
    const run = createProbeRun({
      script: [utterance("u1", 3)],
      sendFrame: () => {
        throw new Error("socket gone");
      },
      now: () => t,
    });
    // greeting
    for (let i = 0; i < 20; i++) {
      t += 20;
      run.handleInbound(voicedFrame());
      run.tick();
    }
    for (let i = 0; i < 60; i++) {
      t += 20;
      run.handleInbound(silentFrame());
      run.tick();
    }

    expect(() => {
      t += 20;
      run.tick();
    }).not.toThrow();
  });
});
