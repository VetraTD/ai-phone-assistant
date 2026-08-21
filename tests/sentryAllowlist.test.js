import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A1.4 gate: no PHI-typed field reaches the error tracker.
//
// captureException(err, context) turned every entry in `context` into a Sentry
// tag, verbatim, and three call sites in services/notifications.js passed the
// recipient's email address, the caller's phone number, and a subject line that
// read "New appointment: Tue Mar 4, 3:30 PM — Jane Q Patient".
//
// Two layers, and the order matters. The call sites are cleaned so the values
// are not produced; the boundary allowlists so that a call site added later
// cannot leak by being careless. A denylist would have to be updated every time
// someone invents a new field name — an allowlist fails closed instead.
//
// Sentry is scheduled for retirement at D7. That is not a reason to leave a PHI
// path open until then: an error tracker's whole purpose is durable off-site
// storage, so anything sent today outlives the decision to stop sending.

const CAPTURED = [];

vi.mock("@sentry/node", () => {
  const scope = {
    tags: {},
    setTag(k, v) {
      this.tags[k] = v;
    },
  };
  return {
    init: vi.fn(),
    withScope: (fn) => {
      scope.tags = {};
      fn(scope);
      CAPTURED.push({ tags: { ...scope.tags } });
    },
    captureException: vi.fn(),
  };
});

let captureException;

beforeEach(async () => {
  CAPTURED.length = 0;
  process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
  vi.resetModules();
  ({ captureException } = await import("../lib/sentry.js"));
});

afterEach(() => {
  delete process.env.SENTRY_DSN;
  vi.resetModules();
});

/** Tags from the most recent capture. */
function tags() {
  return CAPTURED.at(-1)?.tags ?? {};
}

describe("captureException context allowlist", () => {
  it("keeps the correlation keys the tracker exists to provide", () => {
    captureException(new Error("boom"), {
      callSid: "CA123",
      requestId: "abc123",
      businessId: "biz-1",
      context: "session.tts",
      table: "calls",
      op: "insert",
      kind: "missed_call",
    });
    expect(tags()).toMatchObject({
      callSid: "CA123",
      requestId: "abc123",
      businessId: "biz-1",
      context: "session.tts",
      table: "calls",
      op: "insert",
      kind: "missed_call",
    });
  });

  it.each([
    ["to", "owner@example.com"],
    ["subject", "New appointment: Tue Mar 4, 3:30 PM — Jane Q Patient"],
    ["toNumber", "+15557654321"],
    ["callerNumber", "+15559998888"],
    ["clientName", "Jane Q Patient"],
    ["notes", "chest pain since Tuesday"],
    ["summary", "Caller asked to move their echo appointment"],
    ["email", "patient@example.com"],
    ["phone", "+15550001111"],
  ])("drops %s, and its value never appears in any tag", (key, value) => {
    captureException(new Error("boom"), { [key]: value, callSid: "CA123" });
    expect(tags()).not.toHaveProperty(key);
    expect(JSON.stringify(tags())).not.toContain(value);
  });

  it("records that something was withheld, by name only", () => {
    captureException(new Error("boom"), { to: "owner@example.com", callSid: "CA123" });
    // The NAME of a dropped field is not PHI and it is what tells whoever is
    // reading the event that the context was thinner than the call site thought.
    expect(tags().dropped_context).toContain("to");
    expect(JSON.stringify(tags())).not.toContain("owner@example.com");
  });

  it("says nothing about dropped context when nothing was dropped", () => {
    captureException(new Error("boom"), { callSid: "CA123" });
    expect(tags()).not.toHaveProperty("dropped_context");
  });

  it("caps a tag value rather than shipping an unbounded string", () => {
    captureException(new Error("boom"), { context: "x".repeat(5000) });
    expect(tags().context.length).toBeLessThanOrEqual(256);
  });

  it("is a no-op with no DSN, and does not throw on a missing context", async () => {
    delete process.env.SENTRY_DSN;
    vi.resetModules();
    const { captureException: noop } = await import("../lib/sentry.js");
    expect(() => noop(new Error("boom"))).not.toThrow();
    expect(CAPTURED).toHaveLength(0);
  });
});

describe("the call sites do not produce the values in the first place", () => {
  // Layer one. The allowlist above would catch these anyway; this asserts they
  // are not being constructed and handed over in the first place, which is what
  // keeps the allowlist a backstop rather than the only thing standing there.
  it("services/notifications.js passes no recipient, subject or caller number", async () => {
    const fs = await import("fs");
    const src = fs.readFileSync(new URL("../services/notifications.js", import.meta.url), "utf8");
    const calls = src.match(/captureException\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).not.toMatch(/\bto\b/);
      expect(call).not.toMatch(/\bsubject\b/);
      expect(call).not.toMatch(/\btoNumber\b/);
    }
  });
});
