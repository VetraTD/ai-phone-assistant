import { describe, it, expect } from "vitest";
import { buildDialPlan, MAX_CALLS } from "../lib/probe/dialPlan.js";

// ---------------------------------------------------------------------------
// This module is the gate in front of code that places real, billable phone
// calls in a loop. Every check here exists because the failure it prevents is
// expensive, hard to undo, or both: dialling a number that isn't ours, dialling
// far more times than intended, or dialling at all when the operator only
// meant to see what would happen.
//
// The plan is a pure value. Nothing dials until a caller acts on it, so the
// decision to place calls is reviewable and testable on its own.
// ---------------------------------------------------------------------------

const OK = {
  to: "+15550000001",
  from: "+15550000002",
  assistantNumber: "+15550000001",
  baseUrl: "https://assistant.example.com",
  debugToken: "tok",
  calls: 12,
  confirm: true,
};

describe("buildDialPlan — guardrails in front of automated dialling", () => {
  it("approves a well-formed, confirmed plan", () => {
    const plan = buildDialPlan(OK);

    expect(plan.ok).toBe(true);
    expect(plan.calls).toBe(12);
    expect(plan.to).toBe("+15550000001");
  });

  it("refuses to dial any number other than the configured assistant number", () => {
    // The single check that stops a typo or a stale env var from ringing a
    // stranger repeatedly.
    const plan = buildDialPlan({ ...OK, to: "+15559999999" });

    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/allowlist|assistant number/i);
  });

  it("refuses when no assistant number is configured at all", () => {
    const plan = buildDialPlan({ ...OK, assistantNumber: "" });
    expect(plan.ok).toBe(false);
  });

  it("refuses to originate from the number it is dialling", () => {
    // Same number on both legs cannot bridge; it either fails at Twilio or
    // loops the assistant into itself.
    const plan = buildDialPlan({ ...OK, from: OK.to });

    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/same number|from/i);
  });

  it("rejects numbers that are not E.164", () => {
    expect(buildDialPlan({ ...OK, from: "5550002" }).ok).toBe(false);
  });

  it("does not dial without an explicit confirmation flag", () => {
    const plan = buildDialPlan({ ...OK, confirm: false });

    expect(plan.ok).toBe(false);
    expect(plan.dryRun).toBe(true);
    // A dry run is still useful output — it must show what WOULD happen.
    expect(plan.calls).toBe(12);
    expect(plan.estimatedCostUsd).toBeGreaterThan(0);
  });

  it(`caps the run at ${MAX_CALLS} calls however many were asked for`, () => {
    const plan = buildDialPlan({ ...OK, calls: 500 });

    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/cap|maximum/i);
  });

  it("rejects a zero or negative call count", () => {
    expect(buildDialPlan({ ...OK, calls: 0 }).ok).toBe(false);
    expect(buildDialPlan({ ...OK, calls: -3 }).ok).toBe(false);
  });

  it("requires a debug token, since the probe endpoint refuses without one", () => {
    const plan = buildDialPlan({ ...OK, debugToken: "" });

    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/DEBUG_TOKEN/i);
  });

  it("requires an https base url so the media stream can connect", () => {
    expect(buildDialPlan({ ...OK, baseUrl: "http://insecure.example.com" }).ok).toBe(false);
    expect(buildDialPlan({ ...OK, baseUrl: "" }).ok).toBe(false);
  });

  it("estimates cost from both legs, since a bridged test call bills twice", () => {
    const plan = buildDialPlan({ ...OK, calls: 10, minutesPerCall: 2 });

    // 10 calls x 2 minutes x 2 legs x per-minute rate.
    expect(plan.billedMinutes).toBe(40);
    expect(plan.estimatedCostUsd).toBeCloseTo(40 * plan.perMinuteUsd, 5);
  });

  it("builds a wss stream url carrying the token, never a plain ws one", () => {
    const plan = buildDialPlan(OK);

    expect(plan.streamUrl.startsWith("wss://")).toBe(true);
    expect(plan.streamUrl).toContain("tok");
  });

  it("puts the token in the path, not the query string", () => {
    // Twilio drops a <Stream url="..."> query string before the websocket
    // handshake, so a ?token= form reaches the server empty and the call dies
    // in under a second with error 31920.
    const plan = buildDialPlan(OK);

    expect(plan.streamUrl).toBe("wss://assistant.example.com/twilio/probe-stream/tok");
    expect(plan.streamUrl).not.toContain("?");
  });

  it("keeps the token out of the human-readable summary", () => {
    // The summary is printed to a terminal and pasted into notes; the token
    // is a live credential for a public endpoint.
    const plan = buildDialPlan(OK);

    expect(plan.summary).not.toContain("tok");
  });
});
