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

  // -------------------------------------------------------------------------
  // Round 3, 2026-08-29. The caller heard the goodbye TWICE:
  //
  //   "{reason:Caller declined further assistance and said thank you. }
  //    You're very welcome. Thank you for calling Digile Media, and have a
  //    wonderful day. You're very welcome. Thank you for calling Digile Media,
  //    and have a great day."
  //
  // Round 0 wrote end_call into the text channel and said goodbye. The re-ask
  // forces mode:ANY, and the model obliged with the call AND another goodbye,
  // appended to the same fullText. The recovery exists to get the tool CALLED;
  // whatever it says has already been said.
  // -------------------------------------------------------------------------
  describe("the recovery round must not re-speak", () => {
    const GOODBYE_1 = "You're very welcome. Thank you for calling Digile Media, and have a wonderful day.";
    const GOODBYE_2 = "You're very welcome. Thank you for calling Digile Media, and have a great day.";

    it("suppresses the recovery round's text when the turn already spoke", async () => {
      H.chunks = [
        [text(`${GOODBYE_1} default_api:end_call{reason:Caller declined further assistance and said thank you. }`)],
        [text(GOODBYE_2), call("end_call", { reason: "Caller declined further assistance" })],
      ];

      const { spoken, reply } = await run({ callerTurnCount: 3 });

      expect(spoken).toContain("have a wonderful day.");
      expect(spoken).not.toContain("have a great day.");
      expect(spoken).not.toMatch(/[{}]|reason\s*:|default_api|end_call/i);
      // The whole point of the recovery: the tool still actually runs.
      expect(reply.toolCallEvents.map((e) => e.name)).toContain("end_call");
    });

    it("still speaks the recovery round when the turn said nothing first", async () => {
      // Nothing was spoken, so there is no duplicate to suppress and silence is
      // the worse failure. Suppression must be conditional, not blanket.
      H.chunks = [
        [text("default_api:end_call{reason:done}")],
        [text("Thanks for calling. Goodbye."), call("end_call", { reason: "done" })],
      ];

      const { spoken } = await run({ callerTurnCount: 3 });

      expect(spoken).toContain("Thanks for calling. Goodbye.");
    });
  });

  describe("end_call ends the turn", () => {
    it("does not send another request after end_call succeeds", async () => {
      // end_call's own declaration says the goodbye belongs in the SAME
      // response. A round after it can only produce a second one — and costs a
      // whole Gemini round-trip at the end of every call.
      H.chunks = [
        [text("Thanks for calling. Goodbye."), call("end_call", { reason: "caller is done" })],
        [text("Goodbye again!")],
      ];

      const { spoken, reply } = await run({ callerTurnCount: 3 });

      expect(H.sent.length).toBe(1);
      expect(spoken).toContain("Thanks for calling. Goodbye.");
      expect(spoken).not.toContain("Goodbye again!");
      expect(reply.endCallArgs).toBeTruthy();
    });

    it("keeps going when end_call is REFUSED, so the model can recover", async () => {
      // callerTurnCount 0 and no completed action: the gate refuses. Breaking
      // here would strand the caller mid-call with an unanswered request.
      H.chunks = [
        [call("end_call", { reason: "too early" })],
        [text("Sorry — is there anything else I can help with?")],
      ];

      const { spoken } = await run({ callerTurnCount: 0 });

      expect(H.sent.length).toBe(2);
      expect(spoken).toContain("anything else I can help with?");
    });
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
