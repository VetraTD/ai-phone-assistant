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

describe("transferOutcome: screened (flagged) dials", () => {
  const done = { DialCallStatus: "completed" };
  const flagged = (outcome) => ({ flagged: true, outcome });
  it("accepted + DialBridged true -> hangup", () => {
    expect(transferOutcome({ ...done, DialBridged: "true" }, flagged("accepted"))).toBe("hangup");
  });
  it("accepted + DialBridged false (pressed 1, leg dropped before the bridge) -> message", () => {
    expect(transferOutcome({ ...done, DialBridged: "false" }, flagged("accepted"))).toBe("message");
  });
  it("accepted + DialBridged absent -> hangup", () => {
    expect(transferOutcome(done, flagged("accepted"))).toBe("hangup");
  });
  it("accepted but the dial did not complete -> message", () => {
    expect(transferOutcome({ DialCallStatus: "no-answer" }, flagged("accepted"))).toBe("message");
  });
  it("not_accepted -> message whatever DialCallStatus and DialBridged say", () => {
    expect(transferOutcome({ ...done, DialBridged: "true" }, flagged("not_accepted"))).toBe("message");
    expect(transferOutcome(done, flagged("not_accepted"))).toBe("message");
  });
  it("outcome unknown (null: no row, or the read failed): DialBridged decides", () => {
    expect(transferOutcome({ ...done, DialBridged: "false" }, flagged(null))).toBe("message");
    expect(transferOutcome({ ...done, DialBridged: "true" }, flagged(null))).toBe("hangup");
    expect(transferOutcome({ ...done, DialBridged: "false" }, flagged("unscreened"))).toBe("message");
  });
});

describe("transferOutcome: unflagged dials ignore everything about screening", () => {
  it.each([[undefined], [null]])("screening %j -> today's rule, DialBridged ignored", (screening) => {
    expect(transferOutcome({ DialCallStatus: "completed", DialBridged: "false" }, screening)).toBe("hangup");
    expect(transferOutcome({ DialCallStatus: "busy" }, screening)).toBe("message");
  });
});
