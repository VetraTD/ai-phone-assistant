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

describe("transferOutcome: screened dials", () => {
  const done = { DialCallStatus: "completed" };
  it("accepted + DialBridged true -> hangup", () => {
    expect(transferOutcome({ ...done, DialBridged: "true" }, "accepted")).toBe("hangup");
  });
  it("accepted + DialBridged false (pressed 1, leg dropped before the bridge) -> message", () => {
    expect(transferOutcome({ ...done, DialBridged: "false" }, "accepted")).toBe("message");
  });
  it("accepted + DialBridged absent -> hangup", () => {
    expect(transferOutcome(done, "accepted")).toBe("hangup");
  });
  it("accepted but the dial did not complete -> message (today's rule)", () => {
    expect(transferOutcome({ DialCallStatus: "no-answer" }, "accepted")).toBe("message");
  });
  it("not_accepted -> message whatever DialCallStatus and DialBridged say", () => {
    expect(transferOutcome({ ...done, DialBridged: "true" }, "not_accepted")).toBe("message");
    expect(transferOutcome(done, "not_accepted")).toBe("message");
    expect(transferOutcome({ DialCallStatus: "busy" }, "not_accepted")).toBe("message");
  });
  it.each([[undefined], [null], ["unscreened"]])("outcome %j -> today's rule, DialBridged ignored", (outcome) => {
    expect(transferOutcome({ ...done, DialBridged: "false" }, outcome)).toBe("hangup");
    expect(transferOutcome({ DialCallStatus: "busy" }, outcome)).toBe("message");
  });
});
