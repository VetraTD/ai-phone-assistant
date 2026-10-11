import { describe, it, expect } from "vitest";
import { transferOutcome } from "../lib/transferOutcome.js";

describe("transferOutcome", () => {
  it("hangs up after a completed (real) conversation", () => {
    expect(transferOutcome({ DialCallStatus: "completed" })).toBe("hangup");
  });

  it.each([["busy"], ["no-answer"], ["failed"], ["canceled"], ["answered"], [""], ["COMPLETED"], [undefined], [null], [7]])(
    "takes a message for DialCallStatus=%j",
    (status) => {
      expect(transferOutcome({ DialCallStatus: status })).toBe("message");
    }
  );

  it.each([[{}], [undefined], [null], ["completed"]])("takes a message for body %j", (body) => {
    expect(transferOutcome(body)).toBe("message");
  });
});
