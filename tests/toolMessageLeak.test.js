import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The zero-text fallback must never speak a tool's message to the caller
// unless that message was written for the caller.
//
// THE BUG THIS GUARDS. On a live call, mid-booking, the assistant said the word
// "API" to a caller. Nothing inspected model output before TTS, and separately,
// when the model produced no text of its own, getReplyStreaming spoke
// `toolResult.message` VERBATIM — no model mediation at all — for any tool not
// named in ACTION_TOOL_NAMES.
//
// That exclusion list silently decided everything it did not name was safe to
// say out loud. It was not. Tool messages are written for two different
// audiences and nothing marked which was which:
//
//   "Let the caller know you are transferring them now, briefly."  <- transfer
//   "Ask the caller what specifically they'd like priced ..."      <- quotes
//   "Missing required field: X. Ask the caller for it ..."         <- requirements
//   "Read these back in local time: ..."                           <- appointments
//
// Each is an instruction TO THE MODEL, and each was one text-free turn away
// from being read aloud. For a business with a webhook integration the same
// path carries an upstream vendor's raw error body, which is where a literal
// "API" comes from.
//
// The rule is now opt-in: a tool message is spoken only when its author marked
// it callerSafe. Everything else falls back to the localized generic line.
// ---------------------------------------------------------------------------

const H = { chunks: [], sentMessages: [] };

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor() {
      this.chats = {
        create: () => ({
          async sendMessageStream({ message }) {
            H.sentMessages.push(message);
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

/** A streamed function-call chunk with no accompanying text. */
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

function run(extras = {}) {
  return drain(
    getReplyStreaming([], "put me through to someone", "gather_details", null, CONFIG, {
      intentMarker: false,
      ...extras,
    })
  );
}

beforeEach(() => {
  H.chunks = [];
  H.sentMessages = [];
});

describe("zero-text turns never speak an unmarked tool message", () => {
  it("does NOT read a model directive aloud when the model produced no text", async () => {
    // transferAllowed:false makes request_transfer return its refusal, whose
    // message is addressed to the model: "Transfer is not available right now.
    // Offer to take a message instead."
    H.chunks = [[call("request_transfer", { reason: "caller asked" })], []];

    const { spoken, reply } = await run({ transferAllowed: false });

    expect(spoken).not.toMatch(/offer to take a message/i);
    expect(spoken).not.toMatch(/let the caller know/i);
    // Falls back to the localized generic line instead.
    expect(spoken).toBe(S.toolFail);
    // The directive still reaches the MODEL — only the caller is protected.
    expect(reply.toolResults[0].message).toMatch(/offer to take a message/i);
  });

  it("still speaks a message its author marked as written for the caller", async () => {
    // record_customer_request's "I'll make sure they get your message." is
    // addressed to the caller and marked callerSafe, so the opt-in rule must
    // not have made the assistant uselessly generic.
    H.chunks = [[call("record_customer_request", { request_type: "message", message: "call me back" })], []];

    const { spoken } = await drain(
      getReplyStreaming([], "take a message please", "gather_details", null, CONFIG, { intentMarker: false })
    );

    expect(spoken).toBe("I'll make sure they get your message.");
  });

  it("speaks a generic line rather than an unknown-tool internal string", async () => {
    // The default branch returns { error: "Unknown function" } to the model.
    // That string must never be what a caller hears.
    H.chunks = [[call("some_tool_that_does_not_exist", {})], []];

    const { spoken } = await run();

    expect(spoken.toLowerCase()).not.toContain("unknown function");
    expect(spoken).toBe("I'm sorry, I wasn't able to do that.");
  });
});
