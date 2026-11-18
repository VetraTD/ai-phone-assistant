import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Turns 20, 24 and 26 of production call 7eee9cd1 contained no pseudo-call at
// all — just a promise and nothing else:
//
//   #19 CALL | Yes
//   #20 AI   | One moment while I update that for you.       <- then silence
//   #21 CALL | Why didn't it — did you update it?
//   #24 AI   | One moment while I update that for you.       <- then silence
//   #26 AI   | One moment while I locate your appointment record. <- then silence
//
// The model spoke the filler the prompt mandates alongside a lookup and emitted
// zero tool calls in either channel. fullText was non-empty, so the zero-text
// safety net could not fire; the turn completed normally and the caller sat in
// silence until the nudge. The appointment was never moved.
//
// This is the deterministic layer: it is our code, not the model's judgement.
// A turn that promises an action and calls nothing must never end in silence.
// ---------------------------------------------------------------------------

const H = { chunks: [], sent: [] };

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor() {
      this.chats = {
        create: () => ({
          async sendMessageStream({ message, config }) {
            H.sent.push({ message, config });
            const round = H.chunks.shift() ?? [];
            return (async function* () {
              for (const c of round) yield c;
            })();
          },
        }),
      };
    }
  },
}));

const { getReplyStreaming } = await import("../services/gemini.js");
const { FIXTURES } = await import("./fixtures/businessConfigs.js");
const { getStrings } = await import("../lib/voice/strings.js");

const CONFIG = FIXTURES["appointments-db"].config;
const S = getStrings(CONFIG);

const PROMISE = "One moment while I update that for you.";

const text = (t) => ({
  candidates: [{ content: { parts: [{ text: t }] }, finishReason: "STOP" }],
});
const call = (name, args = {}) => ({
  functionCalls: [{ id: "fc1", name, args }],
  candidates: [{ finishReason: "STOP" }],
});

async function drain(gen) {
  const deltas = [];
  let reply = null;
  for await (const ev of gen) {
    if (ev.delta !== undefined) deltas.push(ev.delta);
    if (ev.done) reply = ev.reply;
  }
  return { spoken: deltas.join(""), reply };
}

const run = (extras = {}) =>
  drain(
    getReplyStreaming([], "yes please move it", "gather_details", null, CONFIG, {
      intentMarker: false,
      ...extras,
    })
  );

beforeEach(() => {
  H.chunks = [];
  H.sent = [];
});

describe("a turn that promises an action and calls nothing", () => {
  it("asks the model to actually make the call", async () => {
    H.chunks = [[text(PROMISE)], [call("reschedule_appointment_db", { appointment_id: "a1", new_scheduled_at: "2026-08-06T14:00:00" })], [text("All set.")]];

    const { reply } = await run();

    expect(H.sent.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(H.sent[1].message)).toMatch(/did not call|no function|nothing happened|call the correct function/i);
    expect(reply.toolCallEvents.map((e) => e.name)).toContain("reschedule_appointment_db");
  });

  it("never ends in silence when the model still calls nothing", async () => {
    H.chunks = [[text(PROMISE)], [text("")]];

    const { spoken, reply } = await run();

    expect(spoken).toContain(PROMISE);
    expect(spoken).toContain(S.actionNotCompleted);
    expect(reply.text).toContain(S.actionNotCompleted);
  });

  it("does NOT fire when the promise accompanied a real tool call", async () => {
    // The whole false-positive risk. A legitimate "one moment" that preceded an
    // actual call must cost nothing — no extra round, no apology.
    H.chunks = [
      [text("One moment while I check that for you."), call("get_caller_appointments_from_db", {})],
      [text("You're booked for Thursday at 2 PM.")],
    ];

    const { spoken } = await run();

    expect(spoken).not.toContain(S.actionNotCompleted);
    // One original round + one function-response round. No recovery round.
    expect(H.sent.length).toBe(2);
  });

  it("does NOT fire on a plain conversational reply that promises nothing", async () => {
    H.chunks = [[text("We're open until five on Thursdays.")]];

    const { spoken } = await run();

    expect(spoken).toBe("We're open until five on Thursdays.");
    expect(H.sent.length).toBe(1);
  });

  it("still fires in marker mode, where a synthetic intent event is the only tool event", async () => {
    // set_call_intent's marker is pushed into toolCallEvents without ever
    // running through executeToolCall. Counting it as "a tool ran" would
    // silently disable this guard for every marker-mode business.
    H.chunks = [[text(`<<intent:cancel_reschedule>>\n${PROMISE}`)], [text("")]];

    const { spoken } = await run({ intentMarker: true });

    expect(spoken).toContain(S.actionNotCompleted);
  });
});
