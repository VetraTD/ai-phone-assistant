import { describe, it, expect, vi } from "vitest";
import { createLiveTextSession } from "../lib/harness/liveTextSession.js";
import { makeFakeDeps, makeFakeEffectsDeps } from "../lib/harness/fakeDeps.js";
import { FIXTURES } from "./fixtures/businessConfigs.js";
import { STEPS } from "../lib/callState.js";

// ---------------------------------------------------------------------------
// The Live eval driver, against a fake socket. No network, no spend.
//
// What this file is for is NARROW and worth stating, because a green run here
// proves nothing about fabrication: it asserts that the driver satisfies the
// same contract as lib/harness/textSession.js, that it drives the REAL tool
// runner rather than a copy of it, and that it does not invent numbers it
// cannot measure.
//
// The rate this instrument exists to measure needs real Gemini sessions and is
// pre-registered in docs/lvx27-fabrication-rate.md. Nothing here substitutes.
// ---------------------------------------------------------------------------

const FIXTURE = FIXTURES["appointments-db"];
const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

function fakeConnect({ script = [] } = {}) {
  const sent = { clientContent: [], toolResponses: [] };
  let onmessage = null;
  let step = 0;

  const connect = vi.fn(async ({ callbacks, config }) => {
    onmessage = callbacks.onmessage;
    sent.config = config;
    return {
      session: {
        sendClientContent: (m) => {
          sent.clientContent.push(m);
          // Play this turn's scripted vendor messages on the next tick, the
          // way a real socket would deliver them.
          const messages = script[step] || [{ serverContent: { turnComplete: true } }];
          step += 1;
          (async () => {
            for (const msg of messages) {
              await new Promise((r) => setImmediate(r));
              await onmessage(msg);
            }
          })();
        },
        sendToolResponse: (m) => sent.toolResponses.push(m),
        close: vi.fn(),
      },
      languagePinned: true,
      surface: "aistudio",
      model: "m",
    };
  });

  return { connect, sent, session: () => connect.mock.results[0]?.value };
}

function makeSession({ script, env = {} } = {}) {
  const { deps, store } = makeFakeDeps({ seedAppointments: [] });
  const effects = makeFakeEffectsDeps();
  const live = fakeConnect({ script });
  const session = createLiveTextSession({
    config: FIXTURE.config,
    extras: { ...FIXTURE.extras, businessId: BUSINESS_ID },
    fakes: { deps, store, effects },
    env: { LIVE_VOICE: "Kore", LIVE_LANGUAGE_CODE: "en-GB", ...env },
    connect: live.connect,
    turnTimeoutMs: 500,
  });
  return { session, live, store };
}

const say = (text) => ({ serverContent: { outputTranscription: { text } } });
const endTurn = () => ({ serverContent: { turnComplete: true } });

describe("the Live eval driver satisfies the text driver's contract", () => {
  it("exposes the same three members, plus a socket to give back", () => {
    const { session } = makeSession();
    expect(typeof session.sendTurn).toBe("function");
    expect(typeof session.getState).toBe("function");
    expect(Array.isArray(session.transcript)).toBe(true);
    expect(typeof session.close).toBe("function");
  });

  it("connects lazily, on the first turn and not before", async () => {
    const { session, live } = makeSession({ script: [[say("Hello."), endTurn()]] });
    expect(live.connect).not.toHaveBeenCalled();

    await session.sendTurn("Hi there.");
    expect(live.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps the audio modality, because that is the path that fabricated", async () => {
    const { session, live } = makeSession({ script: [[endTurn()]] });
    await session.sendTurn("Hi.");

    expect(live.sent.config.responseModalities).toEqual(["AUDIO"]);
    expect(live.sent.config.outputAudioTranscription).toEqual({});
  });

  it("declares the tenant's real tools", async () => {
    const { session, live } = makeSession({ script: [[endTurn()]] });
    await session.sendTurn("Hi.");

    const names = live.sent.config.tools[0].functionDeclarations.map((d) => d.name);
    expect(names).toContain("book_appointment");
    expect(names).toContain("end_call");
  });

  it("sends the caller turn as a completed user turn", async () => {
    const { session, live } = makeSession({ script: [[say("Hi!"), endTurn()]] });
    await session.sendTurn("I'd like to book.");

    expect(live.sent.clientContent[0]).toEqual({
      turns: [{ role: "user", parts: [{ text: "I'd like to book." }] }],
      turnComplete: true,
    });
  });

  it("assembles the reply out of the output transcription", async () => {
    const { session } = makeSession({
      script: [[say("Of course — "), say("what day suits you?"), endTurn()]],
    });
    const out = await session.sendTurn("I'd like to book.");

    expect(out.text).toBe("Of course — what day suits you?");
    expect(session.transcript).toHaveLength(2);
    expect(session.transcript[1]).toMatchObject({ role: "model" });
  });

  it("reports no first-event time rather than a fabricated one", async () => {
    const { session } = makeSession({ script: [[say("Hi."), endTurn()]] });
    const out = await session.sendTurn("Hello.");

    // There are no streaming deltas on this path. A number here would end up
    // in the eval's latency rollup looking like a measurement.
    expect(out.timings.firstEventMs).toBeNull();
    expect(out.timings.totalMs).toBeGreaterThanOrEqual(0);
  });
});

describe("it drives the real tool runner", () => {
  it("runs a tool call against the fakes and reports it to the eval", async () => {
    const { session, live } = makeSession({
      script: [
        [
          {
            toolCall: {
              functionCalls: [
                { id: "t1", name: "check_appointment_availability", args: { requested_at: "2026-09-07T10:00:00" } },
              ],
            },
          },
          say("I have ten AM."),
          endTurn(),
        ],
      ],
    });

    const out = await session.sendTurn("Anything Monday morning?");

    expect(out.toolCalls).toEqual([
      { name: "check_appointment_availability", args: { requested_at: "2026-09-07T10:00:00" } },
    ]);
    expect(out.toolResults[0]).toMatchObject({ name: "check_appointment_availability" });
    // The vendor is waiting on this; a turn that never answers sits silent.
    expect(live.sent.toolResponses).toHaveLength(1);
  });

  it("advances the reducer's step, so the eval's finalState means something", async () => {
    const { session } = makeSession({
      script: [[say("Sure, what day works for you?"), endTurn()]],
    });
    expect(session.getState().step).toBe(STEPS.IDENTIFY_INTENT);

    await session.sendTurn("I'd like to book an appointment.");
    // Not asserting WHICH step: that is the reducer's business and it is
    // tested in its own file. Asserting only that the reducer ran at all,
    // which is what separates this driver from one that fakes a reply.
    expect(session.getState().history.length).toBeGreaterThan(0);
  });
});

describe("it does not over-report what it spent", () => {
  it("normalises usage without accumulating it", async () => {
    const { session } = makeSession({
      script: [
        [{ usageMetadata: { promptTokenCount: 8800, responseTokenCount: 120, totalTokenCount: 8920 } }, endTurn()],
        [{ usageMetadata: { promptTokenCount: 17600, responseTokenCount: 240, totalTokenCount: 17840 } }, endTurn()],
      ],
    });

    const t1 = await session.sendTurn("One.");
    const t2 = await session.sendTurn("Two.");

    expect(t1.usage).toEqual({ promptTokens: 8800, outputTokens: 120, totalTokens: 8920 });
    // Live's usageMetadata is already cumulative for the session. Summing it
    // per turn is harness defect #1 and #7 from the handoff, made twice, and
    // it over-reports a multi-turn run several-fold.
    expect(t2.usage).toEqual({ promptTokens: 17600, outputTokens: 240, totalTokens: 17840 });
  });

  it("reports a turn the vendor never completed as a timeout", async () => {
    const { session } = makeSession({ script: [[say("thinking...")]] });
    const out = await session.sendTurn("Hello?");

    expect(out.finishReason).toBe("TIMEOUT");
    expect(out.text).toBe("thinking...");
  });
});

describe("the socket is given back", () => {
  it("closes on close()", async () => {
    const { session, live } = makeSession({ script: [[endTurn()]] });
    await session.sendTurn("Hi.");
    const vendorSession = (await live.connect.mock.results[0].value).session;

    session.close();
    expect(vendorSession.close).toHaveBeenCalled();
  });

  it("does not reconnect after close", async () => {
    const { session, live } = makeSession({ script: [[endTurn()]] });
    await session.sendTurn("Hi.");
    session.close();

    await expect(session.sendTurn("Again?")).rejects.toThrow();
    expect(live.connect).toHaveBeenCalledTimes(1);
  });
});
