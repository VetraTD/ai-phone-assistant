// tests/outboundDoor.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { registerOutboundDoorRoutes } from "../lib/outbound/doorRoutes.js";
import { signMediaUrl } from "../lib/outbound/mediaUrl.js";
import * as notifications from "../services/notifications.js";

// Task 12, spec §9.1 / §9.4, plan C15, session 2b additions. These three
// routes are the ones every outbound call answers, statuses and (later)
// voicemail plays through. None of them may touch inbound's missed-call text
// or spam heuristic (server.js:851-905) -- that is the whole point of a
// SEPARATE status door for outbound (Ruling P-2).

const BIZ = "11111111-1111-1111-1111-111111111111";
const ATTEMPT = "22222222-2222-2222-2222-222222222222";
const OUTREACH = "33333333-3333-3333-3333-333333333333";
const CAMPAIGN = "44444444-4444-4444-4444-444444444444";
const CALL_SID = "CAoutbound00000000000000000000000001";

function fakeDb(over = {}) {
  return {
    outboundAttemptByCallSid: vi.fn(async (sid) =>
      sid === CALL_SID
        ? { businessId: BIZ, attemptId: ATTEMPT, outreachId: OUTREACH, campaignId: CAMPAIGN, campaignVersion: 1 }
        : null
    ),
    lookupBusinessByPhone: vi.fn(async () => null),
    withTenantSafe: vi.fn(async (businessId, fn) => fn()),
    withTenant: vi.fn(async (businessId, fn) => fn()),
    // Default: the common case (an answered call, first and only terminal
    // stamp). Fix round 1, item 9 -- stampAttemptStatus now reports whether
    // this was the first terminal stamp and whether the attempt was ever
    // answered; doorRoutes.js gates completeCall on both. Tests that need a
    // duplicate or a never-answered attempt override this per call.
    stampAttemptStatus: vi.fn(async () => ({ firstTerminalStamp: true, answered: true })),
    completeCall: vi.fn(async () => {}),
    fetchAttemptVoicemailAudio: vi.fn(async () => Buffer.from([0xff, 0x7e, 0x80, 0x01])),
    ...over,
  };
}

function fakeDeps(over = {}) {
  return {
    validate: (req, res, next) => next(),
    db: fakeDb(),
    mintToken: vi.fn((callSid) => `token-for-${callSid}`),
    postCall: { tryClaim: vi.fn(async () => false) },
    log: { info: vi.fn(), error: vi.fn() },
    now: () => 1_700_000_000_000,
    ...over,
  };
}

function buildApp(deps) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  registerOutboundDoorRoutes(app, deps);
  return app;
}

beforeEach(() => {
  // Fix round 1, item 10: stubEnv/unstubAllEnvs, not a direct process.env
  // write with nothing restoring it -- the old version leaked this secret
  // into every test file that runs in the same worker afterwards.
  vi.stubEnv("OUTBOUND_MEDIA_URL_SECRET", "outbound-door-test-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /twilio/outbound-answer", () => {
  it("a known CallSid gets Connect/Stream with exactly one direction=outbound Parameter and a token for THAT CallSid", async () => {
    const deps = fakeDeps();
    const res = await request(buildApp(deps)).post("/twilio/outbound-answer").type("form").send({ CallSid: CALL_SID, From: "+441372656055" });
    expect(res.status).toBe(200);
    const directionMatches = res.text.match(/<Parameter name="direction" value="outbound"\s*\/>/g) || [];
    expect(directionMatches).toHaveLength(1);
    expect(deps.mintToken).toHaveBeenCalledWith(CALL_SID);
    expect(res.text).toContain(`token-for-${CALL_SID}`);
    expect(res.text).toContain("<Connect><Stream");
  });

  it("an unknown CallSid resolves the OWNED number's business and speaks its name before hanging up (owner ruling, not a bare Hangup)", async () => {
    const db = fakeDb({
      lookupBusinessByPhone: vi.fn(async (phone) => (phone === "+441372656999" ? { name: "Digile Media" } : null)),
    });
    const deps = fakeDeps({ db });
    const res = await request(buildApp(deps))
      .post("/twilio/outbound-answer").type("form")
      .send({ CallSid: "CAunknown", From: "+441372656999" });
    expect(res.status).toBe(200);
    // Fix round 1, item 11: the same voice/language selection inbound uses
    // for its own <Say> lines -- From is a UK number, so en-GB's Polly.Amy.
    expect(res.text).toBe(
      '<Response><Say voice="Polly.Amy">Sorry, this is Digile Media calling. We\'ll try you again later. Goodbye.</Say><Hangup/></Response>'
    );
    expect(db.lookupBusinessByPhone).toHaveBeenCalledWith("+441372656999");
  });

  it("Ruling P-1: when the business lookup misses too, it hangs up without a name and never goes silent", async () => {
    const deps = fakeDeps(); // lookupBusinessByPhone -> null by default
    const res = await request(buildApp(deps)).post("/twilio/outbound-answer").type("form").send({ CallSid: "CAunknown", From: "+441372650000" });
    expect(res.status).toBe(200);
    expect(res.text).toBe('<Response><Say voice="Polly.Amy">Sorry, we\'ll try you again later. Goodbye.</Say><Hangup/></Response>');
  });

  it("Ruling P-1: when the business lookup THROWS, it also hangs up without a name rather than going silent", async () => {
    const db = fakeDb({ lookupBusinessByPhone: vi.fn(async () => { throw new Error("db down"); }) });
    const deps = fakeDeps({ db });
    const res = await request(buildApp(deps)).post("/twilio/outbound-answer").type("form").send({ CallSid: "CAunknown", From: "+441372650000" });
    expect(res.status).toBe(200);
    expect(res.text).toBe('<Response><Say voice="Polly.Amy">Sorry, we\'ll try you again later. Goodbye.</Say><Hangup/></Response>');
  });

  // Fix round 1, item 11: a US number gets the US voice, proving the
  // selection is not just hardcoded to the GB branch.
  it("a US From/To pair gets the US voice (Polly.Joanna, the plain default)", async () => {
    const deps = fakeDeps();
    const res = await request(buildApp(deps))
      .post("/twilio/outbound-answer").type("form")
      .send({ CallSid: "CAunknown", From: "+14155551234", To: "+14155559999" });
    expect(res.status).toBe(200);
    expect(res.text).toBe('<Response><Say voice="Polly.Joanna">Sorry, we\'ll try you again later. Goodbye.</Say><Hangup/></Response>');
  });

  // Fix round 1, item 2. mediaStreamTokenRequired(env) defaults to true
  // whenever TWILIO_VALIDATE_SIGNATURE is not the literal string "false" --
  // an explicit env keeps this test decoupled from ambient process.env.
  it("a resolved attempt with no token to mint (signature required) answers with the ID line, not a broken Stream", async () => {
    const deps = fakeDeps({
      mintToken: vi.fn(() => null),
      env: { BASE_URL: "https://svc.example" },
    });
    const res = await request(buildApp(deps)).post("/twilio/outbound-answer").type("form").send({ CallSid: CALL_SID, From: "+441372656999" });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("<Stream");
    expect(res.text).toContain("<Hangup/>");
    expect(deps.log.error).toHaveBeenCalledWith(
      "outbound_answer_token_unavailable",
      expect.objectContaining({ callSid: CALL_SID, businessId: BIZ, attemptId: ATTEMPT })
    );
  });

  it("logs outbound_context_missing with businessResolved on a miss, and outbound_answered on a hit", async () => {
    const deps = fakeDeps();
    await request(buildApp(deps)).post("/twilio/outbound-answer").type("form").send({ CallSid: CALL_SID, From: "+441372656055" });
    expect(deps.log.info).toHaveBeenCalledWith("outbound_answered", expect.objectContaining({ callSid: CALL_SID }));

    const deps2 = fakeDeps();
    await request(buildApp(deps2)).post("/twilio/outbound-answer").type("form").send({ CallSid: "CAunknown", From: "+441372650000" });
    expect(deps2.log.info).toHaveBeenCalledWith("outbound_context_missing", expect.objectContaining({ callSid: "CAunknown", businessResolved: false }));
  });

  // The sabotage target (Step 3 of the brief): remove `validate` from this
  // route and this test goes RED.
  it("a failed signature (validate refuses) returns 403 and never reaches the lookup", async () => {
    const deps = fakeDeps({ validate: (req, res) => res.status(403).send("Forbidden") });
    const res = await request(buildApp(deps)).post("/twilio/outbound-answer").type("form").send({ CallSid: CALL_SID, From: "+441372656055" });
    expect(res.status).toBe(403);
    expect(deps.db.outboundAttemptByCallSid).not.toHaveBeenCalled();
  });
});

describe("POST /twilio/outbound-status", () => {
  it("an unknown SID is ignored with a 200 and does not error (Ruling: carried from the 2a ledger)", async () => {
    const deps = fakeDeps();
    const res = await request(buildApp(deps)).post("/twilio/outbound-status").type("form").send({ CallSid: "CAghost", CallStatus: "completed" });
    expect(res.status).toBe(200);
    expect(deps.db.withTenantSafe).not.toHaveBeenCalled();
    expect(deps.postCall.tryClaim).not.toHaveBeenCalled();
    expect(deps.log.info).toHaveBeenCalledWith("outbound_status_unknown_sid", expect.objectContaining({ callSid: "CAghost" }));
  });

  it("in-progress stamps answered_at (answered:true, terminal:false)", async () => {
    const deps = fakeDeps();
    const res = await request(buildApp(deps)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: "in-progress" });
    expect(res.status).toBe(200);
    expect(deps.db.stampAttemptStatus).toHaveBeenCalledWith(ATTEMPT, expect.objectContaining({ twilioStatus: "in-progress", answered: true, terminal: false }));
    expect(deps.db.completeCall).not.toHaveBeenCalled();
    expect(deps.postCall.tryClaim).not.toHaveBeenCalled();
  });

  it("completed stamps status_completed_at (terminal:true), completes the calls row and calls postCall.tryClaim", async () => {
    const deps = fakeDeps();
    const res = await request(buildApp(deps)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: "completed", CallDuration: "42" });
    expect(res.status).toBe(200);
    expect(deps.db.stampAttemptStatus).toHaveBeenCalledWith(ATTEMPT, expect.objectContaining({ twilioStatus: "completed", terminal: true }));
    expect(deps.db.completeCall).toHaveBeenCalledWith(CALL_SID, "completed", 42);
    expect(deps.postCall.tryClaim).toHaveBeenCalledWith(CALL_SID);
  });

  it("no-answer sets result='no_answer'; never answered, so completeCall does not run (fix round 1, item 9)", async () => {
    const db = fakeDb({ stampAttemptStatus: vi.fn(async () => ({ firstTerminalStamp: true, answered: false })) });
    const deps = fakeDeps({ db });
    await request(buildApp(deps)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: "no-answer" });
    expect(deps.db.stampAttemptStatus).toHaveBeenCalledWith(ATTEMPT, expect.objectContaining({ result: "no_answer", terminal: true }));
    expect(deps.db.completeCall).not.toHaveBeenCalled();
    expect(deps.postCall.tryClaim).toHaveBeenCalledWith(CALL_SID);
  });

  it("busy sets result='busy' and calls postCall.tryClaim exactly as no-answer does (spec §9.4: a decline the carrier ends outright); never answered, so completeCall does not run", async () => {
    const db = fakeDb({ stampAttemptStatus: vi.fn(async () => ({ firstTerminalStamp: true, answered: false })) });
    const deps = fakeDeps({ db });
    await request(buildApp(deps)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: "busy" });
    expect(deps.db.stampAttemptStatus).toHaveBeenCalledWith(ATTEMPT, expect.objectContaining({ result: "busy", terminal: true }));
    expect(deps.db.completeCall).not.toHaveBeenCalled();
    expect(deps.postCall.tryClaim).toHaveBeenCalledWith(CALL_SID);
  });

  // Fix round 1, item 9: a duplicate terminal callback (this was NOT the
  // first terminal stamp) must not re-run completeCall, even though the
  // attempt WAS answered -- it already ran once.
  it("a duplicate terminal callback does not call completeCall again, but still calls postCall.tryClaim", async () => {
    const db = fakeDb({ stampAttemptStatus: vi.fn(async () => ({ firstTerminalStamp: false, answered: true })) });
    const deps = fakeDeps({ db });
    const res = await request(buildApp(deps)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: "completed" });
    expect(res.status).toBe(200);
    expect(deps.db.completeCall).not.toHaveBeenCalled();
    expect(deps.postCall.tryClaim).toHaveBeenCalledWith(CALL_SID);
  });

  // Fix round 1, item 4: a THROW from the by-CallSid lookup is not a clean
  // miss -- the attempt likely exists and would otherwise silently keep
  // counting against capacity for up to an hour with nothing retrying it.
  it("a throw from the by-CallSid lookup returns 5xx (so Twilio retries) and touches nothing", async () => {
    const db = fakeDb({ outboundAttemptByCallSid: vi.fn(async () => { throw new Error("pg down"); }) });
    const deps = fakeDeps({ db });
    const res = await request(buildApp(deps)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: "completed" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBeLessThan(600);
    expect(deps.db.withTenantSafe).not.toHaveBeenCalled();
    expect(deps.db.stampAttemptStatus).not.toHaveBeenCalled();
    expect(deps.db.completeCall).not.toHaveBeenCalled();
    expect(deps.postCall.tryClaim).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledWith("outbound_status_lookup_failed", expect.objectContaining({ callSid: CALL_SID }));
  });

  it("failed sets result='failed', canceled sets result='canceled'", async () => {
    const deps1 = fakeDeps();
    await request(buildApp(deps1)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: "failed" });
    expect(deps1.db.stampAttemptStatus).toHaveBeenCalledWith(ATTEMPT, expect.objectContaining({ result: "failed" }));

    const deps2 = fakeDeps();
    await request(buildApp(deps2)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: "canceled" });
    expect(deps2.db.stampAttemptStatus).toHaveBeenCalledWith(ATTEMPT, expect.objectContaining({ result: "canceled" }));
  });

  it("ringing/initiated are neither answered nor terminal, and set no result", async () => {
    const deps = fakeDeps();
    for (const status of ["queued", "initiated", "ringing"]) {
      deps.db.stampAttemptStatus.mockClear();
      await request(buildApp(deps)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: status });
      expect(deps.db.stampAttemptStatus).toHaveBeenCalledWith(ATTEMPT, expect.objectContaining({ twilioStatus: status, answered: false, terminal: false, result: null }));
    }
    expect(deps.postCall.tryClaim).not.toHaveBeenCalled();
  });

  // Never the inbound missed-call text-back and never the spam heuristic.
  it("never calls notifications.sendCallerSms, for any status", async () => {
    const spy = vi.spyOn(notifications, "sendCallerSms").mockResolvedValue(undefined);
    const deps = fakeDeps();
    for (const status of ["queued", "ringing", "in-progress", "completed", "busy", "no-answer", "failed", "canceled"]) {
      await request(buildApp(deps)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: status });
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("a failed signature (validate refuses) returns 403", async () => {
    const deps = fakeDeps({ validate: (req, res) => res.status(403).send("Forbidden") });
    const res = await request(buildApp(deps)).post("/twilio/outbound-status").type("form").send({ CallSid: CALL_SID, CallStatus: "completed" });
    expect(res.status).toBe(403);
  });
});

describe("GET /media/outbound/:callSid/:kind.wav", () => {
  const NOW = 1_700_000_000_000;

  it("serves bytes starting with RIFF when the signature is good", async () => {
    const url = signMediaUrl({ base: "https://svc.example", callSid: CALL_SID, kind: "voicemail", now: NOW });
    const path = url.replace("https://svc.example", "");
    const deps = fakeDeps({ now: () => NOW });
    const res = await request(buildApp(deps)).get(path);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/wav/);
    expect(Buffer.from(res.body).slice(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("returns 403 when the signature is bad", async () => {
    const deps = fakeDeps({ now: () => NOW });
    const res = await request(buildApp(deps)).get(`/media/outbound/${CALL_SID}/voicemail.wav?exp=9999999999&sig=deadbeef`);
    expect(res.status).toBe(403);
    expect(deps.db.fetchAttemptVoicemailAudio).not.toHaveBeenCalled();
  });

  it("returns 404 for any kind other than voicemail", async () => {
    const url = signMediaUrl({ base: "https://svc.example", callSid: CALL_SID, kind: "opener", now: NOW });
    const path = url.replace("https://svc.example", "");
    const deps = fakeDeps({ now: () => NOW });
    const res = await request(buildApp(deps)).get(path);
    expect(res.status).toBe(404);
  });

  it("returns 404 when there is no audio for an otherwise-valid signature", async () => {
    const url = signMediaUrl({ base: "https://svc.example", callSid: CALL_SID, kind: "voicemail", now: NOW });
    const path = url.replace("https://svc.example", "");
    const db = fakeDb({ fetchAttemptVoicemailAudio: vi.fn(async () => null) });
    const deps = fakeDeps({ db, now: () => NOW });
    const res = await request(buildApp(deps)).get(path);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unresolvable CallSid even with a good signature (cannot serve another tenant's audio through a stale attempt)", async () => {
    const url = signMediaUrl({ base: "https://svc.example", callSid: "CAnolonger", kind: "voicemail", now: NOW });
    const path = url.replace("https://svc.example", "");
    const deps = fakeDeps({ now: () => NOW });
    const res = await request(buildApp(deps)).get(path);
    expect(res.status).toBe(404);
  });

  it("scopes the read to the resolved tenant via withTenant, with a voice/callSid actor (fix round 1, item 8)", async () => {
    const url = signMediaUrl({ base: "https://svc.example", callSid: CALL_SID, kind: "voicemail", now: NOW });
    const path = url.replace("https://svc.example", "");
    const deps = fakeDeps({ now: () => NOW });
    await request(buildApp(deps)).get(path);
    expect(deps.db.withTenant).toHaveBeenCalledWith(
      BIZ,
      expect.any(Function),
      expect.objectContaining({ callSid: CALL_SID, actor: { type: "voice", id: CALL_SID } })
    );
    expect(deps.db.fetchAttemptVoicemailAudio).toHaveBeenCalledWith(ATTEMPT);
  });
});
