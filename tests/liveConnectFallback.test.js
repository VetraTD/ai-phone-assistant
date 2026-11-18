import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// A Live failure was SILENCE. readiness.md A1 called the connect-time fallback
// "the cheap and valuable half", and §C called the absence of any fallback
// "the strongest single argument for demoing the cascade instead".
//
// On a prospect's call silence is the worst outcome available. It is worse than
// voicemail and worse than a wrong answer, because the conclusion a business
// draws from it is that the software does not work, and they draw it before
// they have asked a single question worth judging.
//
// TWO failure shapes, and this file exists because only one of them is a throw:
//
//   a throw       res.type("text/xml") has already run at the top of the
//                 handler, so Express's centralized handler sends a JSON body
//                 under an XML content type with a 500. Twilio reports 11200.
//
//   a null token  NOT a throw, and therefore invisible to a try/catch.
//                 mintMediaStreamToken returns null when it holds no signing
//                 key. The TwiML is well-formed, Twilio connects, and the
//                 websocket upgrade is then refused with a bare 403. The call
//                 rings, says nothing, and ends.
//
// The second is not hypothetical here. This project has TWO Twilio accounts.
// twilioValidationLive accepts a signature from TWILIO_AUTH_TOKEN *or*
// TWILIO_AUTH_TOKEN_ALT, while the token signing key is MEDIA_STREAM_SECRET ||
// TWILIO_AUTH_TOKEN. A deployment holding only the ALT token validates the
// webhook perfectly and cannot mint a stream token at all -- so every call is
// authenticated, accepted, and silent. That is the first test below.
//
// This file runs with signature validation ON. Almost every other server test
// sets TWILIO_VALIDATE_SIGNATURE="false", which also switches
// mediaStreamTokenRequired() off -- and the null-token branch only exists when
// tokens are required, so it would be untestable in that configuration.
// ---------------------------------------------------------------------------

const ALT_TOKEN = "alt_account_auth_token_for_the_second_twilio_account";
const BASE = "https://example.test";

process.env.TWILIO_VALIDATE_SIGNATURE = "true";
process.env.TWILIO_AUTH_TOKEN_ALT = ALT_TOKEN;
// Emptied, NOT deleted. server.js runs dotenv at import, and dotenv does not
// override a key that already exists but DOES fill in one that was deleted --
// so `delete process.env.TWILIO_AUTH_TOKEN` hands the real .env value straight
// back, the token mints, and the test silently exercises the happy path.
// signingKey() trims and treats "" as absent, which is what makes "" work.
process.env.TWILIO_AUTH_TOKEN = "";
process.env.MEDIA_STREAM_SECRET = "";
process.env.CALLER_ALLOWLIST = "";
process.env.LIVE_BUSINESS_PHONE = "";
process.env.BASE_URL = BASE;
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "not-a-real-key";

const dbState = vi.hoisted(() => ({ enabled: false, explodes: false }));

vi.mock("../services/db.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isEnabled: () => {
    if (dbState.explodes) throw new Error("db module exploded");
    return dbState.enabled;
  },
  lookupBusinessByPhone: async () => ({ id: "biz-1", name: "Brightwork Family Dental" }),
  loadConfig: () => null,
  completeCall: async () => {},
  fetchCallTranscript: async () => [],
  updateCallSummary: async () => {},
  updateCallLatency: async () => {},
  startCall: async () => {},
}));

vi.mock("../services/notifications.js", () => ({
  notifyCallMissed: async () => {},
  sendCallerSms: async () => {},
  notifyCallCompleted: async () => {},
  notifyAppointmentBooked: async () => {},
  isEmailConfigured: () => false,
  isSmsConfigured: () => false,
}));

/** Twilio's documented scheme: URL, then each POST param appended key+value in sorted key order. */
function twilioSignature(url, params, token = ALT_TOKEN) {
  let payload = url;
  for (const key of Object.keys(params).sort()) payload += key + params[key];
  return crypto.createHmac("sha1", token).update(Buffer.from(payload, "utf-8")).digest("base64");
}

const PATH = "/twilio/live-voice";

function params(callSid = "CA00000000000000000000000000000001") {
  return { CallSid: callSid, From: "+15550000000", To: "+18176011171" };
}

let app;
let getLatencyStats;
let clearStats;

beforeAll(async () => {
  ({ app } = await import("../server.js"));
  ({ getLatencyStats, clearStats } = await import("../lib/voice/metrics.js"));
}, 20000);

const call = (p) =>
  request(app).post(PATH).type("form").set("X-Twilio-Signature", twilioSignature(BASE + PATH, p)).send(p);

const counters = () => getLatencyStats().turnTaking;

beforeEach(() => {
  clearStats();
  dbState.enabled = false;
  dbState.explodes = false;
});

afterEach(() => {
  process.env.TWILIO_AUTH_TOKEN = "";
});

describe("a Live failure is no longer silence", () => {
  it("does not hand back a tokenless stream URL when tokens are required", async () => {
    // The two-account configuration: the ALT token validates the webhook, and
    // there is no signing key, so mintMediaStreamToken returns null. Before
    // this change the caller got a perfectly well-formed <Connect><Stream> with
    // no token in the path, the upgrade 403'd, and they heard nothing.
    const p = params();
    const res = await call(p);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("live-stream");
    expect(res.text).not.toContain("media-stream");
    // Both front-ends share one signing key, so if the Live token cannot be
    // minted the cascade's cannot either -- routing there would only move the
    // silent 403 to a different socket. Voicemail is the honest floor.
    expect(res.text).toContain("<Record");
    expect(counters().live_connect_fallback).toBe(1);
    expect(counters().live_connect_ok).toBe(0);
  });

  it("connects to the Live front-end and counts it when everything is well", async () => {
    // Asserted before any failure case. Without it, every test in this file is
    // satisfied by a route that falls back on absolutely everything -- which is
    // the failure this codebase has already paid for once, in
    // tests/twilioSignatureValidation.test.js.
    process.env.TWILIO_AUTH_TOKEN = ALT_TOKEN;
    const res = await call(params());

    expect(res.status).toBe(200);
    expect(res.text).toContain("/twilio/live-stream/");
    expect(counters().live_connect_ok).toBe(1);
    expect(counters().live_connect_fallback).toBe(0);
  });

  it("routes to the cascade when the Live route throws", async () => {
    process.env.TWILIO_AUTH_TOKEN = ALT_TOKEN;
    dbState.explodes = true;
    const res = await call(params());

    expect(res.status).toBe(200);
    expect(res.text).toContain("/twilio/media-stream/");
    expect(res.text).not.toContain("/twilio/live-stream/");
    expect(counters().live_connect_fallback).toBe(1);
    expect(counters().live_connect_ok).toBe(0);
  });

  it("returns TwiML, not a JSON 500, when the handler throws", async () => {
    // res.type("text/xml") runs at the top of the handler, and Express's
    // res.json only sets a content type when one is unset. So an uncaught throw
    // used to deliver a JSON body under an XML content type with a 500 -- a
    // Twilio 11200, not a fallback.
    process.env.TWILIO_AUTH_TOKEN = ALT_TOKEN;
    dbState.explodes = true;
    const res = await call(params());

    expect(res.status).not.toBe(500);
    expect(res.text).toContain("<Response>");
    expect(res.text).not.toContain('{"error"');
  });

  it("falls back to voicemail when neither front-end can mint a token", async () => {
    // An unusable CallSid throws in mintMediaStreamToken on both paths. Still
    // not silence.
    process.env.TWILIO_AUTH_TOKEN = ALT_TOKEN;
    const res = await call(params("CA.0000000000000000000000000000001"));

    expect(res.status).toBe(200);
    expect(res.text).toContain("<Record");
    expect(counters().live_connect_fallback).toBe(1);
  });

  it("emits a fallback TwiML identical to the Live one except the socket path", async () => {
    // The whole fallback rests on the two <Connect><Stream> strings being
    // interchangeable. They were byte-identical except for the path, maintained
    // a hundred lines apart, and true only by inspection. buildStreamTwiml made
    // that structural; this pins it, because a drift here would be discovered
    // on a prospect's call.
    process.env.TWILIO_AUTH_TOKEN = ALT_TOKEN;

    const good = await call(params());
    dbState.explodes = true;
    const fallen = await call(params());

    expect(good.text).toContain("/twilio/live-stream/");
    expect(fallen.text).toContain("/twilio/media-stream/");

    // The token is stripped before comparing, and that is not laziness.
    //
    // It carries a unix-SECOND expiry (exp = floor(now/1000) + ttl), so two
    // requests that straddle a second boundary mint different tokens and an
    // exact string comparison fails on the clock rather than on any drift.
    // This test passed eight runs and then failed on the ninth for precisely
    // that reason -- ...719 against ...720. The token's own correctness is
    // covered by tests/mediaStreamToken.test.js; what belongs here is that the
    // two routes emit the same TwiML SHAPE around it.
    const shape = (xml) => xml.replace(/(live-stream|media-stream)\/[^"]+/, "$1/<token>");

    expect(shape(fallen.text).replace("/twilio/media-stream/", "/twilio/live-stream/")).toBe(
      shape(good.text)
    );
  });
});
