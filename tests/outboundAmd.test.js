// tests/outboundAmd.test.js
/**
 * Task 13 (session 2b), spec §9.4: the async AMD verdict and the voicemail
 * redirect. Two layers:
 *   - `decideAmd` (lib/outbound/amd.js): a pure table, no I/O.
 *   - `POST /twilio/outbound-amd` (lib/outbound/doorRoutes.js): records the
 *     verdict, then redirects a machine-answered call by Twilio REST (a
 *     signed <Play> or a hangup) -- never through the media stream, which is
 *     the whole point of the cross-instance rule (spec §9).
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "node:crypto";
import { registerOutboundDoorRoutes } from "../lib/outbound/doorRoutes.js";
import { decideAmd, isMachineEnd, voicemailPermitted } from "../lib/outbound/amd.js";
import { verifyMediaUrl } from "../lib/outbound/mediaUrl.js";
import { createTwilioClientFor } from "../lib/outbound/internalRoutes.js";

// ---------------------------------------------------------------------------
// Inbound-unchanged assertion (session 2b rule): a real server.js mount,
// proving /twilio/outbound-amd is wired with the REAL Twilio signature check
// and that mounting it does not disturb inbound's own /twilio/live-voice
// route. `vi.mock` calls MUST sit at true module top level -- Vitest hoists
// them above every other statement in the file (including a describe/it
// callback's own body), so a variable a factory closes over has to be
// declared here too, or the hoisted factory closes over nothing and throws a
// ReferenceError at call time (caught internally by the real route, which
// then degrades -- the wrong kind of "passing" test, worth naming so nobody
// "simplifies" this back into the describe block below).
//
// tests/outboundDoorServerMount.test.js (Task 12's own frozen file) is
// untouched and still covers the fuller answer/status/missed-call proof;
// this is a smaller, independent instance of the same idiom, scoped to what
// THIS task added.
// ---------------------------------------------------------------------------
const AMD_MOUNT_AUTH_TOKEN = "outbound-amd-mount-token";
const AMD_MOUNT_BASE = "https://outbound-amd-mount.example.test";

process.env.TWILIO_VALIDATE_SIGNATURE = "true";
process.env.TWILIO_AUTH_TOKEN = AMD_MOUNT_AUTH_TOKEN;
process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
process.env.BASE_URL = AMD_MOUNT_BASE;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";

// A vi.fn (not a plain async stub), so the live-voice test can make it
// resolve a business for ITS OWN To number -- the same reason
// tests/outboundDoorServerMount.test.js does this: server.js's real
// /twilio/live-voice route falls back to a degraded-voicemail TwiML for an
// unrouted To number, so a null default would silently prove nothing about
// <Connect><Stream>.
const mockLookupBusinessByPhone = vi.fn(async () => null);

vi.mock("../services/db.js", () => ({
  isEnabled: () => true,
  lookupBusinessByPhone: (...args) => mockLookupBusinessByPhone(...args),
  loadConfig: (business) => (business ? { businessName: business.name || "Test Biz", smsFollowupEnabled: false, smsTemplates: {} } : null),
  completeCall: async () => {},
  fetchCallTranscript: async () => [],
  updateCallSummary: async () => {},
  updateCallLatency: async () => {},
  withTenantSafe: async (_businessId, fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  },
  withTenant: async (_businessId, fn) => fn(),
  outboundAttemptByCallSid: async () => null, // every test here is about the WIRE, not a specific attempt
  stampAttemptStatus: async () => {},
  stampAttemptAmd: async () => {},
  outboundAmdContext: async () => null,
  fetchAttemptVoicemailAudio: async () => null,
}));

vi.mock("../services/notifications.js", () => ({
  notifyCallMissed: async () => {},
  sendCallerSms: async () => {},
  HAS_SMS_CREDS: true,
  MESSAGE_SLA_TEXT: "as soon as possible",
}));

// ---------------------------------------------------------------------------
// decideAmd: the pure table (brief step 1) -- all seven AnsweredBy values;
// voicemail_on including and excluding the attempt; a machine_end_beep
// outside voicemail_on gives hangup/voicemail_skipped.
// ---------------------------------------------------------------------------
describe("decideAmd (spec §9.4)", () => {
  const TABLE = [
    { answeredBy: "human", attemptNo: 1, voicemailOn: [1, 5], complianceClass: "solicited", expected: { action: "none" } },
    { answeredBy: "unknown", attemptNo: 1, voicemailOn: [1, 5], complianceClass: "solicited", expected: { action: "none" } },
    { answeredBy: "machine_start", attemptNo: 1, voicemailOn: [1, 5], complianceClass: "solicited", expected: { action: "wait" } },

    // In voicemail_on, class permits -> voicemail_left, for all three
    // machine_end_* spellings.
    { answeredBy: "machine_end_beep", attemptNo: 1, voicemailOn: [1, 5], complianceClass: "solicited", expected: { action: "voicemail", result: "voicemail_left" } },
    { answeredBy: "machine_end_silence", attemptNo: 5, voicemailOn: [1, 5], complianceClass: "service", expected: { action: "voicemail", result: "voicemail_left" } },
    { answeredBy: "machine_end_other", attemptNo: 5, voicemailOn: [1, 5], complianceClass: "solicited", expected: { action: "voicemail", result: "voicemail_left" } },

    // Outside voicemail_on -> hangup/voicemail_skipped (the row the brief
    // names explicitly).
    { answeredBy: "machine_end_beep", attemptNo: 2, voicemailOn: [1, 5], complianceClass: "solicited", expected: { action: "hangup", result: "voicemail_skipped" } },
    { answeredBy: "machine_end_silence", attemptNo: 3, voicemailOn: [1, 5], complianceClass: "service", expected: { action: "hangup", result: "voicemail_skipped" } },
    { answeredBy: "machine_end_other", attemptNo: 1, voicemailOn: [], complianceClass: "solicited", expected: { action: "hangup", result: "voicemail_skipped" } },

    // In voicemail_on, but the compliance class does not permit a message
    // (marketing_consented is refused at save in Part 1, but decideAmd still
    // refuses it defensively rather than trusting the caller).
    { answeredBy: "machine_end_beep", attemptNo: 1, voicemailOn: [1, 5], complianceClass: "marketing_consented", expected: { action: "hangup", result: "voicemail_skipped" } },
    { answeredBy: "machine_end_beep", attemptNo: 1, voicemailOn: [1, 5], complianceClass: undefined, expected: { action: "hangup", result: "voicemail_skipped" } },

    { answeredBy: "fax", attemptNo: 1, voicemailOn: [1, 5], complianceClass: "solicited", expected: { action: "hangup", result: "failed" } },
    { answeredBy: "fax", attemptNo: 99, voicemailOn: [], complianceClass: "service", expected: { action: "hangup", result: "failed" } },

    // Defensive default: a malformed/missing AnsweredBy does nothing rather
    // than guessing at a hangup or a voicemail redirect.
    { answeredBy: null, attemptNo: 1, voicemailOn: [1, 5], complianceClass: "solicited", expected: { action: "none" } },
    { answeredBy: "garbage", attemptNo: 1, voicemailOn: [1, 5], complianceClass: "solicited", expected: { action: "none" } },
  ];

  it.each(TABLE)("$answeredBy attemptNo=$attemptNo voicemailOn=$voicemailOn class=$complianceClass -> $expected.action/$expected.result", (row) => {
    expect(decideAmd(row)).toEqual(row.expected);
  });

  it("voicemailPermitted: solicited and service permit; everything else, including marketing_consented, refuses", () => {
    expect(voicemailPermitted("solicited")).toBe(true);
    expect(voicemailPermitted("service")).toBe(true);
    expect(voicemailPermitted("marketing_consented")).toBe(false);
    expect(voicemailPermitted(undefined)).toBe(false);
    expect(voicemailPermitted("")).toBe(false);
  });

  it("isMachineEnd: the three machine_end_* values only, not machine_start or fax", () => {
    expect(isMachineEnd("machine_end_beep")).toBe(true);
    expect(isMachineEnd("machine_end_silence")).toBe(true);
    expect(isMachineEnd("machine_end_other")).toBe(true);
    expect(isMachineEnd("machine_start")).toBe(false);
    expect(isMachineEnd("fax")).toBe(false);
    expect(isMachineEnd("human")).toBe(false);
    expect(isMachineEnd(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /twilio/outbound-amd
// ---------------------------------------------------------------------------
const BIZ = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const ATTEMPT = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";
const OUTREACH = "cccccccc-3333-4ccc-8ccc-cccccccccccc";
const CAMPAIGN = "dddddddd-4444-4ddd-8ddd-dddddddddddd";
const CALL_SID = "CAamdtest0000000000000000000000000001";
const NOW = 1_700_000_000_000;
const SECRET = "outbound-amd-test-secret";
const ENV = Object.freeze({ BASE_URL: "https://svc.example", OUTBOUND_MEDIA_URL_SECRET: SECRET });

const CTX_DEFAULT = Object.freeze({ attemptNo: 1, complianceClass: "solicited", voicemailOn: [1, 5] });

function fakeDb(over = {}) {
  return {
    outboundAttemptByCallSid: vi.fn(async (sid) =>
      sid === CALL_SID ? { businessId: BIZ, attemptId: ATTEMPT, outreachId: OUTREACH, campaignId: CAMPAIGN, campaignVersion: 1 } : null
    ),
    // Mirrors the real withTenantSafe's degrade-on-throw shape closely enough
    // for these tests: run the unit of work, and swallow anything it throws.
    withTenantSafe: vi.fn(async (_businessId, fn) => {
      try {
        return await fn();
      } catch {
        return null;
      }
    }),
    stampAttemptAmd: vi.fn(async () => {}),
    outboundAmdContext: vi.fn(async () => CTX_DEFAULT),
    fetchAttemptVoicemailAudio: vi.fn(async () => Buffer.from([0xff, 0x7e, 0x80, 0x01])),
    ...over,
  };
}

/** A Twilio client fake with the one shape the AMD route uses: calls(sid).update(body). */
function twilioClientFake(update = vi.fn(async () => ({}))) {
  const calls = vi.fn(() => ({ update }));
  const twilioClientFor = vi.fn(() => ({ calls }));
  return { twilioClientFor, calls, update };
}

function fakeDeps(over = {}) {
  return {
    validate: (req, res, next) => next(),
    db: fakeDb(),
    mintToken: vi.fn(() => "tok"),
    postCall: { tryClaim: vi.fn(async () => false) },
    twilioClientFor: twilioClientFake().twilioClientFor,
    log: { info: vi.fn(), error: vi.fn() },
    now: () => NOW,
    env: ENV,
    ...over,
  };
}

function buildApp(deps) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  registerOutboundDoorRoutes(app, deps);
  return app;
}

function postAmd(deps, body) {
  return request(buildApp(deps)).post("/twilio/outbound-amd").type("form").send(body);
}

describe("POST /twilio/outbound-amd: routing and recording", () => {
  it("an unknown CallSid is a 200 no-op, logged at info, and never reaches withTenantSafe", async () => {
    const deps = fakeDeps();
    const res = await postAmd(deps, { CallSid: "CAghost", AnsweredBy: "human" });
    expect(res.status).toBe(200);
    expect(deps.db.withTenantSafe).not.toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith("outbound_amd_unknown_sid", { callSid: "CAghost" });
  });

  it("a throw from the by-CallSid lookup returns 5xx so Twilio retries, and touches nothing else", async () => {
    const db = fakeDb({ outboundAttemptByCallSid: vi.fn(async () => { throw new Error("pg down"); }) });
    const deps = fakeDeps({ db });
    const res = await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: "human" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
    expect(deps.db.withTenantSafe).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledWith("outbound_amd_lookup_failed", expect.objectContaining({ callSid: CALL_SID }));
  });

  it("a failed signature (validate refuses) returns 403 and never reaches the lookup", async () => {
    const deps = fakeDeps({ validate: (req, res) => res.status(403).send("Forbidden") });
    const res = await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: "human" });
    expect(res.status).toBe(403);
    expect(deps.db.outboundAttemptByCallSid).not.toHaveBeenCalled();
  });

  it.each(["human", "unknown"])("%s: records answered_by, logs outbound_amd, and touches Twilio for nothing (spec: record the value and change nothing)", async (answeredBy) => {
    const twilio = twilioClientFake();
    const deps = fakeDeps({ twilioClientFor: twilio.twilioClientFor });
    const res = await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: answeredBy, MachineDetectionDuration: "2200" });
    expect(res.status).toBe(200);
    expect(deps.db.stampAttemptAmd).toHaveBeenCalledTimes(1); // fields only -- no result to write
    expect(deps.db.stampAttemptAmd).toHaveBeenCalledWith(ATTEMPT, { answeredBy, amdDurationMs: 2200, result: null });
    expect(deps.log.info).toHaveBeenCalledWith("outbound_amd", { callSid: CALL_SID, attemptId: ATTEMPT, answered_by: answeredBy });
    expect(twilio.calls).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalledWith("outbound_voicemail", expect.anything());
  });

  it("machine_start: record answered_by and do nothing else (DetectMessageEnd guarantees a machine_end_* follows)", async () => {
    const twilio = twilioClientFake();
    const deps = fakeDeps({ twilioClientFor: twilio.twilioClientFor });
    const res = await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: "machine_start" });
    expect(res.status).toBe(200);
    expect(deps.db.stampAttemptAmd).toHaveBeenCalledTimes(1);
    expect(deps.db.stampAttemptAmd).toHaveBeenCalledWith(ATTEMPT, { answeredBy: "machine_start", amdDurationMs: null, result: null });
    expect(twilio.calls).not.toHaveBeenCalled();
  });

  it("MachineDetectionDuration: a missing or non-numeric value records amdDurationMs: null, not NaN or the raw string", async () => {
    for (const duration of [undefined, "", "not-a-number"]) {
      const deps = fakeDeps();
      const body = { CallSid: CALL_SID, AnsweredBy: "human" };
      if (duration !== undefined) body.MachineDetectionDuration = duration;
      await postAmd(deps, body);
      expect(deps.db.stampAttemptAmd).toHaveBeenCalledWith(ATTEMPT, expect.objectContaining({ amdDurationMs: null }));
    }
  });
});

describe("POST /twilio/outbound-amd: voicemail redirect (in voicemail_on, class permits, audio stored)", () => {
  it("plays the signed voicemail clip and hangs up; the <Play> URL's & is XML-escaped, verifies, and carries this CallSid", async () => {
    const twilio = twilioClientFake();
    const deps = fakeDeps({ twilioClientFor: twilio.twilioClientFor });
    const res = await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: "machine_end_beep", MachineDetectionDuration: "4500" });
    expect(res.status).toBe(200);

    expect(twilio.calls).toHaveBeenCalledWith(CALL_SID);
    const body = twilio.update.mock.calls[0][0];
    expect(body.twiml).toMatch(/^<Response><Play>.*<\/Play><Hangup\/><\/Response>$/);
    expect(body.twiml).toContain("&amp;"); // the raw URL's exp=...&sig=... joiner, XML-escaped

    const urlMatch = body.twiml.match(/<Play>(.*)<\/Play>/);
    const rawUrl = urlMatch[1].replace(/&amp;/g, "&"); // undo the XML escaping, not URL-decode
    const pathMatch = rawUrl.match(/^https:\/\/svc\.example(\/media\/outbound\/[^?]+)\?(.*)$/);
    expect(pathMatch[1]).toBe(`/media/outbound/${CALL_SID}/voicemail.wav`);
    const params = new URLSearchParams(pathMatch[2]);
    const verdict = verifyMediaUrl({ callSid: CALL_SID, kind: "voicemail", exp: params.get("exp"), sig: params.get("sig"), now: NOW, env: ENV });
    expect(verdict).toEqual({ ok: true });

    // Recorded fields, then the decided result -- two writes, in that order.
    expect(deps.db.stampAttemptAmd).toHaveBeenCalledTimes(2);
    expect(deps.db.stampAttemptAmd).toHaveBeenNthCalledWith(1, ATTEMPT, { answeredBy: "machine_end_beep", amdDurationMs: 4500, result: null });
    expect(deps.db.stampAttemptAmd).toHaveBeenNthCalledWith(2, ATTEMPT, { answeredBy: "machine_end_beep", amdDurationMs: 4500, result: "voicemail_left" });
    expect(deps.log.info).toHaveBeenCalledWith("outbound_voicemail", { callSid: CALL_SID, attemptId: ATTEMPT, result: "left" });
  });

  it.each(["machine_end_silence", "machine_end_other"])("the same voicemail redirect for %s", async (answeredBy) => {
    const twilio = twilioClientFake();
    const deps = fakeDeps({ twilioClientFor: twilio.twilioClientFor });
    await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: answeredBy });
    expect(twilio.update).toHaveBeenCalledWith(expect.objectContaining({ twiml: expect.stringContaining("<Play>") }));
    expect(deps.log.info).toHaveBeenCalledWith("outbound_voicemail", { callSid: CALL_SID, attemptId: ATTEMPT, result: "left" });
  });

  it("no stored audio (render failed, refused, or already cleared by post-call): never plays a URL that will 404, falls back to hangup, voicemail_skipped, reason no_audio", async () => {
    const twilio = twilioClientFake();
    const db = fakeDb({ fetchAttemptVoicemailAudio: vi.fn(async () => null) });
    const deps = fakeDeps({ db, twilioClientFor: twilio.twilioClientFor });
    const res = await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: "machine_end_beep" });
    expect(res.status).toBe(200);
    expect(twilio.update).toHaveBeenCalledWith({ status: "completed" });
    expect(deps.db.stampAttemptAmd).toHaveBeenNthCalledWith(2, ATTEMPT, expect.objectContaining({ result: "voicemail_skipped" }));
    expect(deps.log.info).toHaveBeenCalledWith("outbound_voicemail", { callSid: CALL_SID, attemptId: ATTEMPT, result: "skipped", reason: "no_audio" });
  });
});

describe("POST /twilio/outbound-amd: hangup (outside voicemail_on, class refuses, or fax)", () => {
  it("machine_end_beep outside voicemail_on: hangs up by REST, voicemail_skipped, no reason field (distinct from the no-audio case)", async () => {
    const twilio = twilioClientFake();
    const db = fakeDb({ outboundAmdContext: vi.fn(async () => ({ attemptNo: 2, complianceClass: "solicited", voicemailOn: [1, 5] })) });
    const deps = fakeDeps({ db, twilioClientFor: twilio.twilioClientFor });
    const res = await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: "machine_end_beep" });
    expect(res.status).toBe(200);
    expect(twilio.update).toHaveBeenCalledWith({ status: "completed" });
    expect(deps.db.fetchAttemptVoicemailAudio).not.toHaveBeenCalled();
    expect(deps.db.stampAttemptAmd).toHaveBeenNthCalledWith(2, ATTEMPT, expect.objectContaining({ result: "voicemail_skipped" }));
    expect(deps.log.info).toHaveBeenCalledWith("outbound_voicemail", { callSid: CALL_SID, attemptId: ATTEMPT, result: "skipped" });
  });

  it("in voicemail_on but the campaign's compliance class does not permit a message: same hangup/voicemail_skipped", async () => {
    const twilio = twilioClientFake();
    const db = fakeDb({ outboundAmdContext: vi.fn(async () => ({ attemptNo: 1, complianceClass: "marketing_consented", voicemailOn: [1, 5] })) });
    const deps = fakeDeps({ db, twilioClientFor: twilio.twilioClientFor });
    await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: "machine_end_beep" });
    expect(twilio.update).toHaveBeenCalledWith({ status: "completed" });
    expect(deps.db.stampAttemptAmd).toHaveBeenNthCalledWith(2, ATTEMPT, expect.objectContaining({ result: "voicemail_skipped" }));
  });

  it("fax: hangs up by REST, result failed, and never logs outbound_voicemail (not a machine branch)", async () => {
    const twilio = twilioClientFake();
    const deps = fakeDeps({ twilioClientFor: twilio.twilioClientFor });
    const res = await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: "fax" });
    expect(res.status).toBe(200);
    expect(twilio.update).toHaveBeenCalledWith({ status: "completed" });
    expect(deps.db.stampAttemptAmd).toHaveBeenNthCalledWith(2, ATTEMPT, expect.objectContaining({ result: "failed" }));
    expect(deps.log.info).not.toHaveBeenCalledWith("outbound_voicemail", expect.anything());
  });
});

describe("POST /twilio/outbound-amd: a Twilio REST error is caught, logged, and still answers 200", () => {
  it("a REST update() throw on the voicemail path still writes the decided result and returns 200", async () => {
    const update = vi.fn(async () => { throw new Error("call not found (already ended)"); });
    const twilio = twilioClientFake(update);
    const deps = fakeDeps({ twilioClientFor: twilio.twilioClientFor });
    const res = await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: "machine_end_beep" });
    expect(res.status).toBe(200);
    expect(deps.log.error).toHaveBeenCalledWith("outbound_amd_update_failed", expect.objectContaining({ callSid: CALL_SID, attemptId: ATTEMPT }));
    expect(deps.db.stampAttemptAmd).toHaveBeenNthCalledWith(2, ATTEMPT, expect.objectContaining({ result: "voicemail_left" }));
  });

  it("a REST update() throw on the hangup path also stays 200 and still writes the result", async () => {
    const update = vi.fn(async () => { throw new Error("already ended"); });
    const twilio = twilioClientFake(update);
    const deps = fakeDeps({ twilioClientFor: twilio.twilioClientFor });
    const res = await postAmd(deps, { CallSid: CALL_SID, AnsweredBy: "fax" });
    expect(res.status).toBe(200);
    expect(deps.log.error).toHaveBeenCalledWith("outbound_amd_update_failed", expect.objectContaining({ callSid: CALL_SID }));
    expect(deps.db.stampAttemptAmd).toHaveBeenNthCalledWith(2, ATTEMPT, expect.objectContaining({ result: "failed" }));
  });
});

// ---------------------------------------------------------------------------
// createTwilioClientFor (Task 13's extraction, internalRoutes.js)
// ---------------------------------------------------------------------------
describe("createTwilioClientFor", () => {
  it("does not construct a client just by being created (no credentials needed to import/build)", () => {
    expect(() => createTwilioClientFor({})).not.toThrow();
  });

  it("is lazy and a singleton: the same client instance on every call, built only on first use", () => {
    const env = { TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000", TWILIO_AUTH_TOKEN: "tok" };
    const twilioClientFor = createTwilioClientFor(env);
    const a = twilioClientFor("+441372656055");
    const b = twilioClientFor("+14155551234"); // callerId ignored until Task 22 -- same client either way
    expect(a).toBe(b);
  });
});

describe("server.js's real mount: /twilio/outbound-amd carries the real Twilio signature check, and inbound is untouched", () => {
  function twilioSignature(url, params, token = AMD_MOUNT_AUTH_TOKEN) {
    let payload = url;
    for (const key of Object.keys(params).sort()) payload += key + params[key];
    return crypto.createHmac("sha1", token).update(Buffer.from(payload, "utf-8")).digest("base64");
  }

  it("no signature -> 403", async () => {
    const { app } = await import("../server.js");
    const params = { CallSid: "CAamdmount0001", AnsweredBy: "human" };
    const res = await request(app).post("/twilio/outbound-amd").type("form").send(params);
    expect(res.status).toBe(403);
  });

  it("correctly signed, unknown CallSid -> 200", async () => {
    const { app } = await import("../server.js");
    const params = { CallSid: "CAamdmount0002", AnsweredBy: "human" };
    const sig = twilioSignature(AMD_MOUNT_BASE + "/twilio/outbound-amd", params);
    const res = await request(app).post("/twilio/outbound-amd").type("form").set("X-Twilio-Signature", sig).send(params);
    expect(res.status).toBe(200);
  });

  it("/twilio/live-voice is untouched: still <Connect><Stream> with businessPhone/callerPhone and no direction Parameter", async () => {
    const { app } = await import("../server.js");
    mockLookupBusinessByPhone.mockResolvedValueOnce({ id: "biz-live", name: "Live Biz", phone_number: "+15550003333" });
    const params = { CallSid: "CAamdmount0003", From: "+15550004444", To: "+15550003333" };
    const sig = twilioSignature(AMD_MOUNT_BASE + "/twilio/live-voice", params);
    const res = await request(app).post("/twilio/live-voice").type("form").set("X-Twilio-Signature", sig).send(params);
    expect(res.status).toBe(200);
    expect(res.text).toContain("<Connect><Stream");
    expect(res.text).toContain('<Parameter name="businessPhone"');
    expect(res.text).toContain('<Parameter name="callerPhone"');
    expect(res.text).not.toMatch(/name="direction"/);
  });
});
