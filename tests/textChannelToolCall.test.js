import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Gemini sometimes writes a function call into the TEXT channel instead of
// emitting a structured functionCall part. Both reported bugs are this one bug.
//
// Verbatim from production call 7eee9cd1 (2026-08-04, AFTER the deploy that was
// supposed to have fixed the "API" leak):
//
//   # 2 AI | default_api:get_caller_appointments_from_db{} One moment while I check that for you.
//   # 5 CALL | Yeah. Why'd you say API?
//   #20 AI | One moment while I update that for you.            <- then silence
//   #30 AI | default_api:reschedule_appointment_db{appointment_id:8a13a7c6-…} One moment…
//
// The caller heard "default api get caller appointments from db" — the leak.
// Nothing ran — the silence. And with no tool result to work from, the model
// invented appointment id 8a13a7c6-…, which does not exist in the database;
// the caller's real appointment was never moved.
//
// The guard shipped on 2026-08-04 could not see any of it: \bapi\b does not
// match inside `default_api` because `_` is a word character, and the tool name
// matched nothing in the 20-word denylist.
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

const HALLUCINATED_ID = "8a13a7c6-7a19-480f-90d5-56ee3dbbf9d4";
const PRODUCTION_LEAK =
  `default_api:reschedule_appointment_db{appointment_id:${HALLUCINATED_ID},` +
  "new_scheduled_at:2026-08-06T14:00:00} One moment while I update that for you.";

/** A streamed text chunk, shaped the way textFromChunk reads it. */
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
    getReplyStreaming([], "move it to tomorrow please", "gather_details", null, CONFIG, {
      intentMarker: false,
      ...extras,
    })
  );

beforeEach(() => {
  H.chunks = [];
  H.sent = [];
});

describe("a tool call written into the text channel", () => {
  it("never speaks the pseudo-call, and keeps the real sentence that followed it", async () => {
    H.chunks = [
      [text(PRODUCTION_LEAK)],
      [call("reschedule_appointment_db", { appointment_id: "appt-real", new_scheduled_at: "2026-08-06T14:00:00" })],
      [text("You're all set for Thursday at 2 PM.")],
    ];

    const { spoken } = await run();

    expect(spoken).not.toMatch(/default_api/i);
    expect(spoken).not.toMatch(/reschedule_appointment_db/);
    expect(spoken).not.toMatch(/[{}]/);
    expect(spoken).not.toContain(HALLUCINATED_ID);
    // Excision, not sentence destruction — the caller-facing half is intact.
    expect(spoken).toContain("One moment while I update that for you.");
  });

  it("makes the model issue a real call instead of executing the parsed one", async () => {
    H.chunks = [
      [text(PRODUCTION_LEAK)],
      [call("reschedule_appointment_db", { appointment_id: "appt-real", new_scheduled_at: "2026-08-06T14:00:00" })],
      [text("You're all set.")],
    ];

    const { reply } = await run();

    const names = reply.toolCallEvents.map((e) => e.name);
    expect(names).toEqual(["reschedule_appointment_db"]);
    // The id the model invented must never reach a tool.
    expect(JSON.stringify(reply.toolCallEvents)).not.toContain(HALLUCINATED_ID);
  });

  it("asks for the tool by name without handing back the arguments it hallucinated", async () => {
    // Re-supplying appointment_id would launder the fabrication straight into a
    // DB write. The model has to re-derive arguments from the conversation,
    // where the real id came from an actual lookup.
    H.chunks = [
      [text(PRODUCTION_LEAK)],
      [call("reschedule_appointment_db", { appointment_id: "appt-real", new_scheduled_at: "2026-08-06T14:00:00" })],
      [text("Done.")],
    ];

    await run();

    const reask = JSON.stringify(H.sent[1].message);
    expect(reask).toContain("reschedule_appointment_db");
    expect(reask).not.toContain(HALLUCINATED_ID);
    expect(reask).toMatch(/not (a )?(real |actual )?function call|nothing ran|call .* properly|as a real function call/i);
  });

  it("forces the re-ask round to produce a structured call", async () => {
    H.chunks = [
      [text(PRODUCTION_LEAK)],
      [call("reschedule_appointment_db", { appointment_id: "appt-real", new_scheduled_at: "2026-08-06T14:00:00" })],
      [text("Done.")],
    ];

    await run();

    expect(H.sent[1].config?.toolConfig?.functionCallingConfig).toEqual({
      mode: "ANY",
      allowedFunctionNames: ["reschedule_appointment_db"],
    });
  });

  it("does not leave the caller in silence when the re-ask also fails", async () => {
    H.chunks = [
      [text(PRODUCTION_LEAK)],
      [text("")], // model produces nothing usable on the retry
    ];

    const { spoken, reply } = await run();

    expect(spoken).toContain(S.actionNotCompleted);
    expect(reply.text).toContain(S.actionNotCompleted);
    expect(spoken).not.toMatch(/default_api|reschedule_appointment_db/);
  });

  it("retries only once, however stuck the model is", async () => {
    H.chunks = [
      [text(PRODUCTION_LEAK)],
      [text(PRODUCTION_LEAK)],
      [text(PRODUCTION_LEAK)],
      [text(PRODUCTION_LEAK)],
    ];

    await run();

    // One original round plus exactly one re-ask.
    expect(H.sent.length).toBe(2);
  });
});
