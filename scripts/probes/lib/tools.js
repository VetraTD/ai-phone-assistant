// ---------------------------------------------------------------------------
// A fake, instant executor for the real tool declarations.
//
// Why this exists at all: the real prompt tells the model to call
// `set_call_intent` "as soon as you understand why the caller is calling", so
// the very first turn of every conversation is a tool turn. A probe that does
// not answer tool calls measures a model sitting still waiting for us. The
// first version of L1 did exactly that and recorded zero replies.
//
// Every response is returned IMMEDIATELY and is a canned success. That is
// deliberate and it is what makes the arms comparable:
//
//   - The question is how fast the VENDOR's model leg is, not how fast our
//     Postgres is. scripts/probe-llm-leg.js already measured the cascade's
//     tool execution itself at 0 ms, so a zero-cost tool is not a distortion
//     of the cascade baseline, it matches it.
//   - Gemini and OpenAI must see byte-identical tool behaviour or a latency
//     difference between them could just be a difference in what we handed
//     back.
//
// What this therefore CANNOT tell us: anything about booking correctness. The
// model never sees a refusal, a double-booking, or a slot that vanished. That
// is the 43-scenario eval's job and PLAN.md already says so.
// ---------------------------------------------------------------------------

/** Canned results, keyed by tool name. Anything unlisted gets a bare success. */
const RESULTS = {
  set_call_intent: { ok: true },
  end_call: { ok: true },
  book_appointment: {
    ok: true,
    confirmation_id: "PROBE-1234",
    scheduled_at: "2026-09-08T10:00:00-05:00",
  },
  check_appointment_availability: {
    ok: true,
    slots: ["2026-09-08T10:00:00-05:00", "2026-09-08T14:30:00-05:00"],
  },
  get_available_slots: {
    ok: true,
    slots: ["2026-09-08T10:00:00-05:00", "2026-09-08T14:30:00-05:00"],
  },
  record_customer_request: { ok: true, message_id: "PROBE-MSG-1" },
  request_transfer: { ok: true, transferring: true },
  record_sms_consent: { ok: true },
};

export function resultFor(name) {
  return RESULTS[name] ?? { ok: true };
}

/**
 * Gemini shape. `id` must be echoed back or the model cannot match the
 * response to its call.
 * @param {Array<{id?:string,name:string,args?:object}>} calls
 */
export function geminiToolResponses(calls) {
  return (calls || []).map((c) => ({
    id: c.id,
    name: c.name,
    response: resultFor(c.name),
  }));
}

/**
 * OpenAI Realtime shape: a conversation item, then a response.create to let
 * the model continue speaking.
 * @param {{call_id:string,name:string}} call
 */
export function openaiToolResponseItem(call) {
  return {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: call.call_id,
      output: JSON.stringify(resultFor(call.name)),
    },
  };
}
