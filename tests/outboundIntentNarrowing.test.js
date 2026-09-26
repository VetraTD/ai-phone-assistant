// tests/outboundIntentNarrowing.test.js
/**
 * Checkpoint 2b review, c1. narrowIntentsForOutbound (services/gemini.js)
 * intersects the tenant's allowedTasks with the campaign's own capabilities
 * (session 2b, amends D-c). An empty result is not a degraded prompt -- it is
 * a malformed set_call_intent enum, and would fail EVERY outbound session at
 * connect. Must never return an empty array.
 */
import { describe, it, expect } from "vitest";
import { narrowIntentsForOutbound } from "../services/gemini.js";

const outboundCall = (capabilities) => ({ config: { capabilities } });

describe("narrowIntentsForOutbound — never returns an empty enum", () => {
  it("empty campaign capabilities: falls back to general_question", () => {
    expect(narrowIntentsForOutbound(["book_appointment", "check_appointment"], { outboundCall: outboundCall([]) })).toEqual([
      "general_question",
    ]);
  });

  it("capabilities present but none match any of the tenant's intents: falls back to general_question", () => {
    expect(
      narrowIntentsForOutbound(["book_appointment", "cancel_reschedule"], {
        outboundCall: outboundCall(["qualification", "callback", "opt_out", "outcome"]),
      })
    ).toEqual(["general_question"]);
  });

  it("normal case: a matching capability keeps its intent, unmatched ones drop", () => {
    expect(
      narrowIntentsForOutbound(["book_appointment", "quote_request", "take_message"], {
        outboundCall: outboundCall(["appointments"]),
      })
    ).toEqual(["book_appointment"]);
  });

  it("intents with no pack mapping (e.g. general_question) are always kept", () => {
    expect(
      narrowIntentsForOutbound(["general_question", "book_appointment"], { outboundCall: outboundCall([]) })
    ).toEqual(["general_question"]);
  });

  it("no outbound context at all (inbound): passes intents through unchanged, even if empty", () => {
    expect(narrowIntentsForOutbound(["book_appointment"], {})).toEqual(["book_appointment"]);
    expect(narrowIntentsForOutbound([], {})).toEqual([]);
  });
});
