/**
 * Task W: a caller whose number did not come through (*67, a placeholder, the
 * business's own line) who says "use the number I'm calling from" used to get a
 * save with no callback number and a plain "recorded" reply. The save still
 * goes through (a caller who will not give a number must still leave a
 * message), but the model-only reply tells it to ask for the digits and save
 * again, which merges onto the same row.
 */

import { describe, it, expect } from "vitest";
import messages from "../capabilities/messages.js";

const fc = (args) => ({ id: "f1", name: "record_customer_request", args });
const BASE = { request_type: "message", caller_name: "Sam", message: "Please call about the invoice." };
const NOTE = /did not come through/;

async function run(args, callerPhone) {
  return messages.execute(fc(args), { callerPhone, config: {} });
}

describe("record_customer_request with no number to call back on", () => {
  it("withheld placeholder, no callback_number: saved, and the reply asks for the digits", async () => {
    const r = await run(BASE, "+266696687");
    const res = r.functionResponse.response;
    expect(res.success).toBe(true);
    expect(res.next).toMatch(NOTE);
    expect(res.next).toMatch(/\[not caller speech\]/);
    expect(res.next).toMatch(/read them back/i);
    expect(r.stateEffects.capabilityEffects).toHaveLength(1);
    // Model-only: never in the text that may be spoken.
    expect(r.stateEffects.toolResult.message).not.toMatch(NOTE);
  });

  it("empty caller number, no callback_number: same note", async () => {
    for (const callerPhone of [null, undefined, ""]) {
      const r = await run(BASE, callerPhone);
      expect(r.functionResponse.response.next).toMatch(NOTE);
    }
  });

  it("a callback_number given: no note", async () => {
    const r = await run({ ...BASE, callback_number: "2145550123" }, "+266696687");
    expect(r.functionResponse.response.next).toBeUndefined();
  });

  it("a real caller number: no note", async () => {
    const r = await run(BASE, "+18175551234");
    expect(r.functionResponse.response.next).toBeUndefined();
  });

  it("a business with notes and no number gets both lines", async () => {
    const r = await messages.execute(fc(BASE), {
      callerPhone: "",
      config: { capabilities: { messages: { enabled: true, notes: "Ask which department." } } },
    });
    const next = r.functionResponse.response.next;
    expect(next).toMatch(NOTE);
    expect(next).toMatch(/business's notes list questions/);
  });
});
