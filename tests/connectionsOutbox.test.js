// tests/connectionsOutbox.test.js
/**
 * S3-8: lib/connections/outbox.js (payload/backoff/delivery) and
 * lib/connections/secretBox.js (the two are not listed in separate brief
 * test files, so secretBox's required cases -- round-trip, wrong-key failure,
 * "never logged" -- live here alongside outbox's). No real network: the one
 * end-to-end delivery test below runs `connectVetted` against a REAL local
 * HTTPS server on 127.0.0.1 (same technique as tests/ssrfGuard.test.js),
 * never through the SSRF-guarded resolve step (which would correctly refuse
 * loopback -- that is proven in ssrfGuard.test.js, not here).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret, loadWebhookKey } from "../lib/connections/secretBox.js";
import {
  outboxIdempotencyKey,
  buildResultsPayload,
  nextBackoff,
  BACKOFF_SCHEDULE_MS,
  attemptDelivery,
} from "../lib/connections/outbox.js";
import { connectVetted, SsrfRefusedError } from "../lib/net/ssrfGuard.js";
import { log } from "../lib/logger.js";
import { handleLiveSessionConnection } from "../lib/voice/live/index.js";
import { clearStats } from "../lib/voice/metrics.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CERT = fs.readFileSync(path.join(HERE, "fixtures", "ssrfGuardTest.cert.pem"));
const KEY = fs.readFileSync(path.join(HERE, "fixtures", "ssrfGuardTest.key.pem"));

const TEST_KEY_B64 = randomBytes(32).toString("base64");
const OTHER_KEY_B64 = randomBytes(32).toString("base64");

describe("secretBox: AES-256-GCM round trip", () => {
  it("round-trips a plaintext secret under CONNECTIONS_WEBHOOK_KEY", () => {
    const env = { CONNECTIONS_WEBHOOK_KEY: TEST_KEY_B64 };
    const boxed = encryptSecret("whsec_super_secret_value", env);
    expect(Buffer.isBuffer(boxed)).toBe(true);
    expect(decryptSecret(boxed, env)).toBe("whsec_super_secret_value");
  });

  it("a ciphertext produced under one key fails to decrypt under another (GCM authTag)", () => {
    const boxed = encryptSecret("whsec_super_secret_value", { CONNECTIONS_WEBHOOK_KEY: TEST_KEY_B64 });
    expect(() => decryptSecret(boxed, { CONNECTIONS_WEBHOOK_KEY: OTHER_KEY_B64 })).toThrow();
  });

  it("a tampered ciphertext fails to decrypt (authenticity, not just confidentiality)", () => {
    const env = { CONNECTIONS_WEBHOOK_KEY: TEST_KEY_B64 };
    const boxed = encryptSecret("whsec_super_secret_value", env);
    const tampered = Buffer.from(boxed);
    tampered[tampered.length - 1] ^= 0xff; // flip the last ciphertext byte
    expect(() => decryptSecret(tampered, env)).toThrow();
  });

  it("fails closed on a missing key", () => {
    expect(() => loadWebhookKey({})).toThrow(/CONNECTIONS_WEBHOOK_KEY is not set/);
    expect(() => encryptSecret("x", {})).toThrow();
  });

  it("fails closed on a short/wrong-length key", () => {
    const shortKey = Buffer.from("too-short").toString("base64");
    expect(() => loadWebhookKey({ CONNECTIONS_WEBHOOK_KEY: shortKey })).toThrow(/32 bytes/);
  });

  it("fails closed on a non-base64 key", () => {
    // A key that decodes to the wrong length rather than throwing on decode
    // (Buffer.from is lenient about alphabet) -- still refused by the length check.
    expect(() => loadWebhookKey({ CONNECTIONS_WEBHOOK_KEY: "not valid base64 at all!!" })).toThrow();
  });
});

describe("connections outbox: idempotency key", () => {
  it("is deterministic for the same (endpoint, event, subject)", () => {
    const k1 = outboxIdempotencyKey({ endpointId: "ep-1", eventType: "call.completed", subjectId: "attempt-1" });
    const k2 = outboxIdempotencyKey({ endpointId: "ep-1", eventType: "call.completed", subjectId: "attempt-1" });
    expect(k1).toBe(k2);
  });

  it("differs across endpoints, event types, and subjects", () => {
    const base = { endpointId: "ep-1", eventType: "call.completed", subjectId: "attempt-1" };
    const keys = new Set([
      outboxIdempotencyKey(base),
      outboxIdempotencyKey({ ...base, endpointId: "ep-2" }),
      outboxIdempotencyKey({ ...base, eventType: "outreach.closed" }),
      outboxIdempotencyKey({ ...base, subjectId: "attempt-2" }),
    ]);
    expect(keys.size).toBe(4);
  });

  it("throws rather than building a partial key when a piece is missing", () => {
    expect(() => outboxIdempotencyKey({ endpointId: "ep-1", eventType: "call.completed", subjectId: null })).toThrow();
  });
});

describe("connections outbox: payload shape (spec §12.5 + S3-D3 direction)", () => {
  it("carries direction:outbound and every named field", () => {
    const payload = buildResultsPayload({
      event: "call.completed",
      deliveryId: "d1",
      occurredAt: "2026-09-28T10:00:00.000Z",
      campaign: { id: "camp-1", name: "Speed to lead", version: 3 },
      outreach: { id: "out-1", attempt: 2, state: "closed", close_reason: "terminal_outcome" },
      call: { result: "connected", answered_by: "human", duration_seconds: 312 },
      outcome: "booked",
      contact: { id: "c-1", phone: "+447700900202", first_name: "Sam", external_ids: {} },
      answers: { clinic_name: "Digile" },
      booking: { start: "2026-09-29T09:00:00.000Z", length_min: null, appointment_id: "appt-1" },
      summary: "Booked a consult.",
      nextAttemptAt: null,
    });
    expect(payload.direction).toBe("outbound");
    expect(payload).toMatchObject({
      event: "call.completed",
      delivery_id: "d1",
      occurred_at: "2026-09-28T10:00:00.000Z",
      outcome: "booked",
      next_attempt_at: null,
    });
    expect(payload.campaign).toEqual({ id: "camp-1", name: "Speed to lead", version: 3 });
    expect(payload.booking.appointment_id).toBe("appt-1");
  });

  it("defaults answers to {} and booking/outcome/summary/next_attempt_at to null when unset", () => {
    const payload = buildResultsPayload({
      event: "outreach.closed",
      deliveryId: "d2",
      occurredAt: "2026-09-28T10:00:00.000Z",
      campaign: { id: "c", name: "n", version: 1 },
      outreach: { id: "o", attempt: 1, state: "closed", close_reason: "attempts_exhausted" },
      call: { result: "no_answer", answered_by: null, duration_seconds: null },
      contact: { id: "ct", phone: "+1", first_name: null, external_ids: {} },
    });
    expect(payload.answers).toEqual({});
    expect(payload.booking).toBeNull();
    expect(payload.outcome).toBeNull();
    expect(payload.summary).toBeNull();
    expect(payload.direction).toBe("outbound");
  });
});

describe("connections outbox: backoff schedule (1m, 5m, 30m, 2h, 12h, then dead)", () => {
  const NOW = new Date("2026-09-28T00:00:00.000Z");

  it("uses each of the five listed delays in order for attempts 1-5", () => {
    const expectedMs = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
    expect(BACKOFF_SCHEDULE_MS).toEqual(expectedMs);
    for (let attempts = 1; attempts <= 5; attempts++) {
      const { status, nextAttemptAt } = nextBackoff(attempts, NOW);
      expect(status).toBe("pending");
      expect(nextAttemptAt.getTime()).toBe(NOW.getTime() + expectedMs[attempts - 1]);
    }
  });

  // Ruling (see lib/connections/outbox.js's own doc on BACKOFF_SCHEDULE_MS):
  // every one of the five listed delays is spent on a real retry before the
  // row gives up, so "dead" is the SIXTH failure -- the schedule exhausting,
  // not a fifth number this file would otherwise have to invent.
  it("the sixth consecutive failure (schedule exhausted) marks the row dead, with no further retry", () => {
    const { status, nextAttemptAt } = nextBackoff(6, NOW);
    expect(status).toBe("dead");
    expect(nextAttemptAt).toBeNull();
  });

  it("is monotonically increasing across the five retry delays", () => {
    for (let i = 1; i < BACKOFF_SCHEDULE_MS.length; i++) {
      expect(BACKOFF_SCHEDULE_MS[i]).toBeGreaterThan(BACKOFF_SCHEDULE_MS[i - 1]);
    }
  });
});

describe("connections outbox: attemptDelivery (stubbed fetchImpl matching fetchVetted's own return shape)", () => {
  const SECRET = "whsec_delivery_test_secret";
  const PAYLOAD = { event: "call.completed", direction: "outbound" };

  it("marks delivered on a 2xx", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, headers: {}, body: '{"ok":true}' }));
    const result = await attemptDelivery({
      url: "https://example.test/hook",
      secret: SECRET,
      eventType: "call.completed",
      deliveryId: "d1",
      payload: PAYLOAD,
      fetchImpl,
    });
    expect(result).toEqual({ ok: true, status: 200, lastError: null });
  });

  it("signs the exact JSON.stringify(payload) as the request body, with the three headers", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200, headers: {}, body: "" }));
    await attemptDelivery({
      url: "https://example.test/hook",
      secret: SECRET,
      eventType: "outreach.closed",
      deliveryId: "d-abc",
      payload: PAYLOAD,
      fetchImpl,
    });
    const [, opts] = fetchImpl.mock.calls[0];
    expect(opts.body).toBe(JSON.stringify(PAYLOAD));
    expect(opts.headers["X-Vetra-Event"]).toBe("outreach.closed");
    expect(opts.headers["X-Vetra-Delivery"]).toBe("d-abc");
    expect(opts.headers["X-Vetra-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("a non-2xx status is a failure whose lastError is the status code only", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 500, headers: {}, body: "internal vendor stack trace, never logged" }));
    const result = await attemptDelivery({
      url: "https://example.test/hook",
      secret: SECRET,
      eventType: "call.completed",
      deliveryId: "d2",
      payload: PAYLOAD,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, status: 500, lastError: "500" });
  });

  it("an SSRF refusal from the fetch layer is classified by its reason, never its free-text message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new SsrfRefusedError("private_address");
    });
    const result = await attemptDelivery({
      url: "https://example.test/hook",
      secret: SECRET,
      eventType: "call.completed",
      deliveryId: "d3",
      payload: PAYLOAD,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, status: null, lastError: "ssrf_private_address" });
  });

  it("a timeout is classified as \"timeout\", not a stack trace", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("timeout");
    });
    const result = await attemptDelivery({
      url: "https://example.test/hook",
      secret: SECRET,
      eventType: "call.completed",
      deliveryId: "d4",
      payload: PAYLOAD,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, status: null, lastError: "timeout" });
  });

  it("never throws -- every failure mode resolves to {ok:false,...}", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("getaddrinfo ENOTFOUND example.test");
      err.code = "ENOTFOUND";
      throw err;
    });
    await expect(
      attemptDelivery({ url: "https://example.test/hook", secret: SECRET, eventType: "call.completed", deliveryId: "d5", payload: PAYLOAD, fetchImpl })
    ).resolves.toMatchObject({ ok: false, lastError: "ENOTFOUND" });
  });
});

describe("connections outbox: the secret is never logged (real local delivery, real crypto)", () => {
  let server;
  let port;

  beforeAll(async () => {
    server = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("delivers a real signed request over a real local TLS connection with the secret appearing in zero log.* calls", async () => {
    const SECRET = "whsec_" + randomBytes(24).toString("hex");
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => {});
    const warnSpy = log.warn ? vi.spyOn(log, "warn").mockImplementation(() => {}) : null;

    try {
      // A real fetchImpl, backed by connectVetted's real HTTPS client -- the
      // point of this test is that NOTHING in the actual crypto+HTTP path
      // (signPayload, encryptSecret/decryptSecret upstream, the request
      // itself) ever hands the plaintext secret to the logger.
      const fetchImpl = (url, opts) =>
        connectVetted({
          hostname: "localhost",
          address: "127.0.0.1",
          family: 4,
          port,
          path: new URL(url).pathname,
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          timeoutMs: opts.timeoutMs,
          // D3 residual fix (wave-W2W3-rereview.md): ssrfGuard.js now pins
          // rejectUnauthorized true regardless of tlsOptions, so this real
          // local fixture is trusted with `ca`, same as tests/ssrfGuard.test.js.
          tlsOptions: { ca: CERT },
        });

      const result = await attemptDelivery({
        url: "https://localhost/deliver",
        secret: SECRET,
        eventType: "call.completed",
        deliveryId: "d-secret-test",
        payload: { event: "call.completed", direction: "outbound", contact: { phone: "+447700900202" } },
        fetchImpl,
      });
      expect(result.ok).toBe(true);

      const allCalls = [...infoSpy.mock.calls, ...errorSpy.mock.calls, ...(warnSpy ? warnSpy.mock.calls : [])];
      for (const call of allCalls) {
        const serialized = JSON.stringify(call);
        expect(serialized.includes(SECRET)).toBe(false);
      }
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy?.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Inbound is not wired (S3-8 brief, spec §19 S3-D3: "Inbound is not wired in
// stage 3"). This drives a REAL inbound call through the codebase's real
// finish() path (handleLiveSessionConnection -- the same entry point and
// harness shape as tests/livePostCall.test.js) and asserts zero outbox
// inserts. lib/voice/live/index.js was not touched by this task; this test
// is the regression guard that keeps it that way -- a future edit that
// wires inbound into the results channel without updating this test will
// fail it, because the fake db below has no OTHER outbox function to fall
// back on either.
// ---------------------------------------------------------------------------
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function fakeInboundLive() {
  let onmessage = null;
  return {
    connect: vi.fn(async ({ callbacks }) => {
      onmessage = callbacks.onmessage;
      return {
        session: { sendRealtimeInput: () => {}, sendClientContent: () => {}, sendToolResponse: () => {}, close: () => {} },
        languagePinned: true,
        surface: "aistudio",
        model: "m",
      };
    }),
    push: (msg) => onmessage?.(msg),
  };
}

describe("inbound finish() makes zero outbox inserts", () => {
  beforeAll(() => clearStats());

  it("a real inbound call, start to hangup, never calls insertOutboxRow or listActiveWebhookEndpoints", async () => {
    const insertOutboxRow = vi.fn(async () => ({ inserted: true, id: "should-not-happen" }));
    const listActiveWebhookEndpoints = vi.fn(async () => []);
    // D8 (final review, positive control): the two `.not.toHaveBeenCalled()`
    // assertions below are vacuously true if finish() never ran at all -- a
    // harness change that stopped BEFORE post-call processing would pass
    // them for the wrong reason (memory: negative-counters-cannot-confirm).
    // live_call_summary is logged exactly once, at the very end of finish()
    // (lib/voice/live/index.js:6737); a call-through spy (not mocked) lets
    // it prove the path was actually reached while still logging normally.
    const infoSpy = vi.spyOn(log, "info");

    const database = {
      isEnabled: () => true,
      lookupBusinessByPhone: vi.fn(async () => ({ id: "biz-inbound-1", name: "Inbound Co" })),
      loadConfig: () => ({
        businessId: "biz-inbound-1",
        businessName: "Inbound Co",
        timezone: "Europe/London",
        allowedTasks: ["general_question", "take_message"],
        capabilities: {},
        businessHours: {},
      }),
      withTenantSafe: async (_id, fn) => fn(),
      withTenant: async (_id, fn) => fn(),
      createCall: async () => "call-row-inbound-1",
      listAppointmentsByCallId: vi.fn(async () => []),
      fetchCallTranscript: vi.fn(async () => [
        { speaker: "ai", message: "Thanks for calling, how can I help?", sequence: 1 },
        { speaker: "caller", message: "Just a general question.", sequence: 2 },
      ]),
      listIntegrationsForBusiness: async () => [],
      fetchBusinessKnowledge: async () => [],
      fetchCallerContext: async () => null,
      addTranscriptEntry: vi.fn(async () => {}),
      // S3-8's own functions, present as spies ONLY so a call to either would
      // be caught by name rather than by a generic "not a function" throw
      // that could be swallowed somewhere upstream.
      insertOutboxRow,
      listActiveWebhookEndpoints,
    };

    const ws = new FakeSocket();
    const live = fakeInboundLive();

    await handleLiveSessionConnection(ws, {}, { now: () => 0, connect: live.connect, database, env: {}, execute: vi.fn() });
    ws.deliver({ event: "start", start: { callSid: "CAinbound1", streamSid: "MZ1", customParameters: { businessPhone: "+441372656055" } } });
    await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));

    live.push({ serverContent: { outputTranscription: { text: "Thanks for calling, how can I help?" } } });
    live.push({ serverContent: { turnComplete: true } });
    await new Promise((r) => setImmediate(r));

    ws.deliver({ event: "stop" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    try {
      expect(insertOutboxRow).not.toHaveBeenCalled();
      expect(listActiveWebhookEndpoints).not.toHaveBeenCalled();
      // D8 positive control: proves finish() actually ran to completion,
      // not merely that it never happened to reach the outbox step.
      expect(infoSpy).toHaveBeenCalledWith("live_call_summary", expect.anything());
    } finally {
      infoSpy.mockRestore();
    }
  });
});
