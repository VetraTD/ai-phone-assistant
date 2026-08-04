import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// getReplyStreaming in marker mode.
//
// The behaviour under test is the swap of TRANSPORT, not of meaning: the model
// still declares the caller's intent explicitly, it just writes it as the first
// line of the reply instead of spending a function call — and a function call
// is a whole model round-trip, ~700ms of a 3,062ms turn, for a value nothing
// reads until the following turn.
//
// The SDK is faked at the module boundary so these are real runs of the
// generator: the strip, the intent event and the tool declarations are all
// produced by production code paths.
// ---------------------------------------------------------------------------

const H = { chunks: [], sentMessages: [], chatConfigs: [] };

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor() {
      this.chats = {
        create: (opts) => {
          H.chatConfigs.push(opts.config);
          return {
            async sendMessageStream({ message }) {
              H.sentMessages.push(message);
              const round = H.chunks.shift() ?? [];
              return (async function* () {
                for (const c of round) yield c;
              })();
            },
          };
        },
      };
    }
  },
}));

const { getReplyStreaming, buildCallTools, buildStaticSystemPrefix } = await import("../services/gemini.js");
const { FIXTURES } = await import("./fixtures/businessConfigs.js");

const CONFIG = FIXTURES["appointments-db"].config;
const MARKER = { intentMarker: true };
const TOOL = { intentMarker: false };

/** A streamed text chunk, in the shape textFromChunk reads. */
const text = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });

/** A streamed function-call chunk. */
const call = (name, args) => ({
  functionCalls: [{ id: "fc1", name, args }],
  candidates: [{ finishReason: "STOP" }],
});

/** Drain the generator into the pieces the session cares about. */
async function drain(gen) {
  const deltas = [];
  const toolCalls = [];
  let reply = null;
  for await (const ev of gen) {
    if (ev.delta !== undefined) deltas.push(ev.delta);
    if (ev.toolCall) toolCalls.push(ev.toolCall);
    if (ev.done) reply = ev.reply;
  }
  return { deltas, spoken: deltas.join(""), toolCalls, reply };
}

function run({ step = "identify_intent", intent = null, extras = MARKER } = {}) {
  return drain(getReplyStreaming([], "I'd like to book a cleaning", step, intent, CONFIG, extras));
}

beforeEach(() => {
  H.chunks = [];
  H.sentMessages = [];
  H.chatConfigs = [];
});

describe("getReplyStreaming — marker mode", () => {
  it("does not offer set_call_intent, so the model cannot spend a round-trip on it", () => {
    const names = buildCallTools(CONFIG, { markerMode: true }).functionDeclarations.map((d) => d.name);

    expect(names).not.toContain("set_call_intent");
    expect(names).toContain("end_call");
    expect(names).toContain("book_appointment");
  });

  it("still offers it with the flag off", () => {
    const names = buildCallTools(CONFIG, { markerMode: false }).functionDeclarations.map((d) => d.name);

    expect(names).toContain("set_call_intent");
  });

  it("speaks the reply without the marker and reports the intent", async () => {
    H.chunks = [[text("<<intent:book_appointment>>\nSure, I can "), text("get that booked.")]];

    const { spoken, reply } = await run();

    expect(spoken).toBe("Sure, I can get that booked.");
    expect(reply.intentArgs).toEqual({ intent: "book_appointment" });
    expect(reply.text).toBe("Sure, I can get that booked.");
  });

  // ctx.toolCalls in the eval runner is built from toolCallEvents, and
  // eval/scenarios/25-intent-switch-midcall.js asserts on it. The event is
  // honest: the model did declare the intent, in its own output.
  it("records the declaration as a set_call_intent event for downstream consumers", async () => {
    H.chunks = [[text("<<intent:take_message>>\nOf course.")]];

    const { toolCalls, reply } = await run();

    expect(toolCalls).toEqual([{ name: "set_call_intent", args: { intent: "take_message" } }]);
    expect(reply.toolCallEvents).toEqual([{ name: "set_call_intent", args: { intent: "take_message" } }]);
  });

  // Pushing set_call_intent's toolResult would change what a text-free turn
  // says: its message is speakable and feeds the zero-text fallback.
  it("adds no toolResult for the marker", async () => {
    H.chunks = [[text("<<intent:take_message>>\nOf course.")]];

    expect((await run()).reply.toolResults).toEqual([]);
  });

  // applyReplyState moves CONFIRM back to GATHER_DETAILS whenever intentArgs is
  // present. The prompt asks for the line on every reply, so without this the
  // call would fall out of its confirmation step every single turn and could
  // never reach end_call.
  it("treats an unchanged intent as a no-op, leaving the step machine alone", async () => {
    H.chunks = [[text("<<intent:book_appointment>>\nYou're all set for Tuesday at ten.")]];

    const { spoken, toolCalls, reply } = await run({ step: "confirm", intent: "book_appointment" });

    expect(spoken).toBe("You're all set for Tuesday at ten.");
    expect(reply.intentArgs).toBeNull();
    expect(toolCalls).toEqual([]);
  });

  // The behaviour eval/scenarios/25 exists to guard: a caller abandons a
  // booking mid-call and asks for something else instead.
  it("reports a CHANGED intent mid-call", async () => {
    H.chunks = [[text("<<intent:take_message>>\nOf course, I can take a message.")]];

    const { reply, toolCalls } = await run({ step: "confirm", intent: "book_appointment" });

    expect(reply.intentArgs).toEqual({ intent: "take_message" });
    expect(toolCalls).toHaveLength(1);
  });

  it("strips a value the business has not enabled without setting it", async () => {
    H.chunks = [[text("<<intent:wire_transfer>>\nSure, I can help.")]];

    const { spoken, reply } = await run();

    expect(spoken).toBe("Sure, I can help.");
    expect(reply.intentArgs).toBeNull();
  });

  // A pure function-call round produces no text, so the marker arrives at the
  // head of the NEXT round. The stripper has to survive the round boundary.
  it("reads the marker off the round after a tool call", async () => {
    H.chunks = [
      [call("get_caller_appointments_from_db", {})],
      [text("<<intent:cancel_reschedule>>\nI found your appointment.")],
    ];

    const { spoken, reply } = await run({ step: "gather_details", intent: "book_appointment" });

    expect(spoken).toBe("I found your appointment.");
    expect(reply.intentArgs).toEqual({ intent: "cancel_reschedule" });
  });

  it("speaks a short reply that never had a marker", async () => {
    H.chunks = [[text("We close at five.")]];

    const { spoken, reply } = await run();

    expect(spoken).toBe("We close at five.");
    expect(reply.intentArgs).toBeNull();
  });

  // The buffer is held while the parser decides. A reply shorter than the hold
  // window must still be released, not swallowed by the zero-text fallback.
  it("releases a held buffer at end of stream rather than dropping it", async () => {
    H.chunks = [[text("<<")]];

    expect((await run()).spoken).toBe("<<");
  });

  it("puts the INTENT LINE block in the cacheable static prefix, and only in marker mode", () => {
    expect(buildStaticSystemPrefix(CONFIG, MARKER)).toContain("=== INTENT LINE ===");
    expect(buildStaticSystemPrefix(CONFIG, TOOL)).not.toContain("INTENT LINE");
    expect(buildStaticSystemPrefix(CONFIG, TOOL)).toContain("set_call_intent");
  });

  it("names only the intents this business enabled", () => {
    const prefix = buildStaticSystemPrefix(CONFIG, MARKER);

    for (const task of CONFIG.allowedTasks) expect(prefix).toContain(task);
    expect(prefix).not.toContain("quote_request");
  });
});
