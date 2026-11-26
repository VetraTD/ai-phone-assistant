// ---------------------------------------------------------------------------
// Hammersleys round 3, item 4 (2026-11-26): the silences, diagnosed before any
// fix. On every debug-on call 2026-11-21..26, each "reply" over 5 s was our own
// first nudge after the model never answered: call A twice at 8.4 s, c20b56
// 10.4 s. Two candidate causes, and the logs could not tell them apart:
//   1. the caller answered over the tail of our question and the half-duplex
//      gate held or dropped it, so Live never heard the answer;
//   2. Live heard it (its transcript arrived) and still never replied.
// `live_silence_diag`, beside each first nudge, carries the counts that
// separate them -- and no caller words.
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootLive } from "./helpers/liveBoot.js";
import { clearStats } from "../lib/voice/metrics.js";
import { log } from "../lib/logger.js";

const CONFIG = {
  businessName: "Harbour Lane Studio",
  mainPhone: "+15550104000",
  timezone: "America/Chicago",
  businessHours: {},
  locale: "en-US",
  allowedTasks: ["general_question"],
  capabilities: {},
};

function modelAudio(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return buf.toString("base64");
}

describe("round 3 item 4 — live_silence_diag beside the first nudge", () => {
  let info;
  beforeEach(() => {
    clearStats();
    info = vi.spyOn(log, "info");
  });
  afterEach(() => info.mockRestore());

  const diags = () => info.mock.calls.filter(([event]) => event === "live_silence_diag").map(([, f]) => f);

  it("a caller answer Live heard, then no reply: the diag says so, with counts only", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_sdiag" });
    s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(1500) } }] } } });
    await s.assistantTurn("So that is Saturday at seven, is that right?");
    await s.feed(2500); // our audio drains
    await s.feed(700, { voiced: true });
    await s.callerSays("Yes, that's right, thank you.");
    await s.feed(12_000); // the model never answers; the ladder's first rung is due

    const d = diags();
    expect(d).toHaveLength(1);
    expect(d[0].caller_fwd_voiced_ms).toBeGreaterThanOrEqual(600);
    expect(d[0].transcript_chars).toBe("Yes, that's right, thank you.".length);
    expect(d[0].since_voice_ms).toBeGreaterThanOrEqual(5_000);
    expect(d[0].since_turn_end_ms).toBeGreaterThan(d[0].since_voice_ms);
    expect(d[0].last_reply_chars).toBe("So that is Saturday at seven, is that right?".length);
    expect(d[0].model_generating).toBe(false);
    // No caller words, in any field.
    expect(JSON.stringify(d[0])).not.toMatch(/right|thank|Saturday/i);
  });

  // Round 3 review M2: a kept "umm" reply released at its turnComplete (it was
  // not a re-ask) must not leave the model marked as still speaking.
  it("after a kept reply is released at turnComplete, the model is not marked speaking", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_sdiag3" });
    s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(1500) } }] } } });
    await s.assistantTurn("What day would suit you?");
    await s.feed(2500);
    await s.feed(40, { voiced: true });
    await s.feed(600);
    await s.callerSays("A");
    s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(1200) } }] } } });
    await s.feed(0);
    await s.assistantTurn("Take your time.");
    await s.feed(16_000);
    const d = diags();
    expect(d).toHaveLength(1);
    expect(d[0].model_generating).toBe(false);
  });

  it("is logged once per silence, not on later rungs", async () => {
    const s = await bootLive({ config: CONFIG, callSid: "CA_sdiag2" });
    s.live.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: modelAudio(1500) } }] } } });
    await s.assistantTurn("What day would suit you?");
    await s.feed(2500);
    await s.feed(30_000);
    expect(diags()).toHaveLength(1);
  });
});
