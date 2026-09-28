// tests/liveOutboundHarness.test.js
/**
 * Task 15: the simulated outbound call, FREE -- the real door routes and the
 * real Live session, on fakes, driven with the harness's own requests and
 * judged by the harness's own verdict. It proves Tasks 12-14 end to end:
 *
 *   1. the door answers a Twilio-signed /twilio/outbound-answer (the request
 *      scripts/live-call-harness.js --outbound sends, built by
 *      lib/probe/twilioRequests.js) with TwiML;
 *   2. the harness's parseTwiml reads the <Parameter>s and the token out of it;
 *   3. the Live session starts with those customParameters and the CallSid the
 *      token binds -- what server.js's upgrade handler does;
 *   4. the first seconds run: listen first, or the backstop at 1,650 ms after
 *      stream start (2,000 - 350);
 *   5. the calls row is created with direction:"outbound";
 *   6. the terminal status reaches postCall.tryClaim.
 *
 * The session clock is the injected one (tests/helpers/liveBoot.js): stream
 * start is 0 and the simulated answer is 350 ms before it -- the answer ->
 * stream offset the product itself assumes (FIRST_SECONDS_DEFAULTS).
 *
 * Every paid run of the same path is the CLI's, done by the controller; this
 * file spends nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const logged = vi.hoisted(() => []);
vi.mock("../lib/logger.js", async (importOriginal) => {
  const rec = (level) => (event, fields = {}) => {
    logged.push({ level, event, ...fields });
  };
  return { ...(await importOriginal()), log: { debug: rec("DEBUG"), info: rec("INFO"), error: rec("ERROR") } };
});

import express from "express";
import request from "supertest";
import { registerOutboundDoorRoutes } from "../lib/outbound/doorRoutes.js";
import { createPostCall } from "../lib/outbound/postCall.js";
import { bootLive, fakeDb } from "./helpers/liveBoot.js";
import { mintMediaStreamToken, verifyMediaStreamToken, tokenFromPath } from "../lib/mediaStreamToken.js";
import { verifyTwilioSignatureAny } from "../lib/twilioSignature.js";
import { FIRST_AUDIO_MARK, BACKSTOP_END_MARK } from "../lib/outbound/firstSeconds.js";
import { renderCampaignLine } from "../lib/outbound/campaignSchema.js";
import { TEMPLATES } from "../lib/outbound/templates.js";
import {
  parseTwiml,
  buildOutboundAnswerRequest,
  buildOutboundStatusRequest,
  buildOutboundAmdRequest,
} from "../lib/probe/twilioRequests.js";
import { createClientObserver, outboundVerdict, parseServerLog } from "../lib/probe/outboundHarness.js";

const BASE = "http://localhost:3000";
const AUTH = "live-outbound-harness-auth";
const ENV = { BASE_URL: BASE, MEDIA_STREAM_SECRET: "live-outbound-harness-secret", TWILIO_VALIDATE_SIGNATURE: "true" };

const SID = "CAharness00000000000001";
const BIZ = "biz-harness";
const BUSINESS_NAME = "Harness Test Clinic";
const CALLER_ID = "+447700900101"; // OUR number (Ofcom drama range)
const CONTACT = "+447700900202"; // the person
const CAMPAIGN_CONFIG = { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: CALLER_ID };
const OPENER = renderCampaignLine(CAMPAIGN_CONFIG.opener, { firstName: "Sam", businessName: BUSINESS_NAME, config: CAMPAIGN_CONFIG });
const OPENER_AUDIO = Buffer.alloc(8000, 0x7f); // one second of 8 kHz mu-law
/** Where the simulated answer sits on the session clock (stream start = 0). */
const ANSWER_AT = -350;

const CONFIG = {
  businessId: BIZ,
  businessName: BUSINESS_NAME,
  greeting: `Thanks for calling ${BUSINESS_NAME}.`,
  mainPhone: CALLER_ID,
  timezone: "Europe/London",
  businessHours: {},
  locale: null,
  liveVoice: null,
  allowedTasks: ["general_question", "take_message"],
  capabilities: {},
};
const BUSINESS_ROW = { id: BIZ, name: BUSINESS_NAME, timezone: "Europe/London", phone_number: CALLER_ID };
const LINKS = { direction: "outbound", campaignId: "camp-1", campaignVersion: 1, outreachId: "out-1", attemptId: "att-1", contactId: "contact-1" };

/**
 * ONE fake database, shared by the door and the session -- as the real one
 * is. Task 20 completion: this now carries a real, in-memory model of
 * `call_attempts`' post-call columns (`sessionFinishedAt`, `postCallStarted`,
 * `silent`, `result`) and every function `lib/outbound/postCall.js`'s real
 * `runPostCall` needs, so `createPostCall` (below) is the REAL orchestration
 * -- not a stub -- and "post-call runs exactly once" is asserted against
 * actual claim semantics, not a canned return value.
 */
function harnessDb() {
  const base = fakeDb(CONFIG, BIZ);
  const attempt = { answeredAt: null, completedAt: null, answeredBy: null, sessionFinishedAt: null, postCallStarted: false, silent: false, result: null };
  // Fix round 1, item 5: a REAL in-memory transcript, so a test can prove
  // the FINAL turn (written right before hangup) is still there when
  // runPostCall's own transcript read (after transcriptSettled) happens.
  const transcript = [];
  return {
    ...base,
    attempt,
    transcript,
    lookupBusinessByPhone: vi.fn(base.lookupBusinessByPhone),
    loadConfig: vi.fn(() => CONFIG),
    createCall: vi.fn(async () => "call-1"),
    fetchCallerContext: vi.fn(async () => null),
    addTranscriptEntry: vi.fn(async (_callId, speaker, message, sequence) => {
      transcript.push({ speaker, message, sequence });
    }),
    fetchAttemptOpenerAudio: vi.fn(async () => null),
    withTenant: vi.fn(async (_id, fn) => fn()),
    withTenantSafe: vi.fn(async (_id, fn) => fn()),
    outboundAttemptByCallSid: vi.fn(async (sid) =>
      sid === SID ? { businessId: BIZ, attemptId: "att-1", outreachId: "out-1", campaignId: "camp-1", campaignVersion: 1 } : null
    ),
    outboundCallContext: vi.fn(async () => ({
      attemptNo: 1,
      openerAudio: OPENER_AUDIO,
      toNumber: CONTACT,
      outreachId: "out-1",
      campaignId: "camp-1",
      campaignVersion: 1,
      contactId: "contact-1",
      trigger: { source: "outbound-admin" },
      templateKey: "speed_to_lead",
      complianceClass: "solicited",
      audience: "business",
      config: CAMPAIGN_CONFIG,
      firstName: "Sam",
      contactTimezone: null,
    })),
    fetchBusinessById: vi.fn(async () => BUSINESS_ROW),
    fetchBusinessCapabilities: vi.fn(async () => []),
    // The door's writes, with the row's state -- so completeCall is gated by
    // the in-progress stamp having landed first, as in Postgres.
    stampAttemptStatus: vi.fn(async (_id, { answered, terminal }) => {
      const wasAnswered = attempt.answeredAt !== null;
      const firstTerminalStamp = Boolean(terminal) && attempt.completedAt === null;
      if (answered && attempt.answeredAt === null) attempt.answeredAt = "stamped";
      if (terminal && attempt.completedAt === null) attempt.completedAt = "stamped";
      return { firstTerminalStamp, answered: wasAnswered };
    }),
    completeCall: vi.fn(async () => {}),
    stampAttemptAmd: vi.fn(async (_id, { answeredBy }) => {
      attempt.answeredBy = answeredBy;
    }),
    outboundAmdContext: vi.fn(async () => ({ attemptNo: 1, complianceClass: "solicited", voicemailOn: [1, 5] })),

    // -----------------------------------------------------------------
    // Task 20: the real claim + post-call pipeline's own data layer, as an
    // in-memory model of the same guard claimPostCall's SQL expresses.
    // -----------------------------------------------------------------
    finishAttemptSession: vi.fn(async (_id, { firstAudioMs, silent }) => {
      attempt.sessionFinishedAt = attempt.sessionFinishedAt ?? "stamped";
      attempt.firstAudioMs = firstAudioMs;
      attempt.silent = silent;
    }),
    claimPostCall: vi.fn(async () => {
      if (attempt.postCallStarted) return false;
      if (attempt.completedAt === null) return false;
      if (!(attempt.sessionFinishedAt !== null || attempt.answeredAt === null)) return false;
      attempt.postCallStarted = true;
      return true;
    }),
    outboundPostCallContext: vi.fn(async () => ({
      attemptNo: 1,
      dialedAt: new Date(),
      answeredAt: attempt.answeredAt !== null ? new Date() : null,
      endedAt: null,
      answeredBy: attempt.answeredBy,
      result: attempt.result,
      silent: attempt.silent,
      sessionFinishedAt: attempt.sessionFinishedAt !== null ? new Date() : null,
      statusCompletedAt: attempt.completedAt !== null ? new Date() : null,
      twilioCallSid: SID,
      outreachId: "out-1",
      outreachState: "dialing",
      attemptsMade: 1,
      outreachCreatedAt: new Date("2026-09-20T09:00:00Z"),
      campaignId: "camp-1",
      campaignVersion: 1,
      contactId: "contact-1",
      complianceClass: "solicited",
      templateKey: "speed_to_lead",
      config: CAMPAIGN_CONFIG,
      phoneE164: CONTACT,
      contactTimezone: null,
      businessTimezone: "Europe/London",
      callId: "call-1",
      callSid: SID,
      outcomeCode: null,
      answers: null,
    })),
    finalizeAttemptResult: vi.fn(async (_id, resultIfUnset) => {
      attempt.result = attempt.result ?? resultIfUnset;
    }),
    outboundCallEffects: vi.fn(async () => ({ booked: false, optedOut: false })),
    fetchCallTranscript: vi.fn(async () => transcript.slice().sort((a, b) => a.sequence - b.sequence)),
    setCallOutcomeCode: vi.fn(async () => {}),
    updateCallSummary: vi.fn(async () => {}),
    isSuppressed: vi.fn(async () => false),
    insertDetectorSuppression: vi.fn(async () => true),
    setAttemptSilent: vi.fn(async (_id, silent) => {
      attempt.silent = silent;
    }),
    setOutreachHold: vi.fn(async () => {}),
    applyOutreachResult: vi.fn(async () => true),
    releasePostCallClaim: vi.fn(async () => {
      attempt.postCallStarted = false;
      return true;
    }),
  };
}

/** The door, mounted with the REAL signature check at BASE_URL + path. */
function doorApp(db, postCall) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const validate = (req, res, next) =>
    verifyTwilioSignatureAny({
      authTokens: [AUTH],
      signature: req.headers["x-twilio-signature"],
      url: ENV.BASE_URL + req.originalUrl,
      params: req.body,
    })
      ? next()
      : res.status(403).send("Forbidden");
  registerOutboundDoorRoutes(app, {
    validate,
    db,
    mintToken: (sid) => mintMediaStreamToken(sid, { env: ENV }),
    postCall,
    // A human/unknown AMD verdict must never reach Twilio REST.
    twilioClientFor: () => {
      throw new Error("the harness's AMD verdicts must never reach Twilio REST");
    },
    env: ENV,
  });
  return app;
}

/** Send one of the harness's own `fetch` requests through supertest, unchanged. */
function send(app, req) {
  let r = request(app).post(new URL(req.url).pathname);
  for (const [k, v] of Object.entries(req.init.headers)) r = r.set(k, v);
  return r.send(req.init.body);
}

const COMMON = { base: BASE, callSid: SID, accountSid: "ACharness", authToken: AUTH };
const PARTIES = { callerId: CALLER_ID, contact: CONTACT };

/**
 * Steps 1-3: answer through the door, parse the TwiML with the harness's own
 * parser, and start the session exactly as server.js's upgrade handler would.
 * Everything the session then sends toward "Twilio" is what the harness would
 * receive, and goes into the harness's own client-side observer.
 */
async function answerAndStart({ env = {} } = {}) {
  const db = harnessDb();
  // Task 20 completion: the REAL claim + orchestration, shared by the door
  // (below) and the session (bootLive, below), exactly as server.js shares
  // ONE instance across both callers. NO log override: this file's own
  // vi.mock("../lib/logger.js") already captures postCall.js's real log
  // calls into `logged`, which serverLog()/parseServerLog() reads --
  // exactly what attemptResultCount (Task 20's verdict criterion) needs.
  const postCall = createPostCall({ db });
  vi.spyOn(postCall, "tryClaim");
  vi.spyOn(postCall, "tryClaimByAttempt");
  const app = doorApp(db, postCall);

  const answer = await send(app, buildOutboundAnswerRequest({ ...COMMON, ...PARTIES }));
  expect(answer.status).toBe(200);
  const twiml = parseTwiml(answer.text);
  expect(twiml).not.toBeNull();
  expect(twiml.customParameters).toEqual({ direction: "outbound" });
  const streamUrl = new URL(twiml.url);
  expect(`${streamUrl.protocol}//${streamUrl.host}`).toBe("ws://localhost:3000");
  const bound = verifyMediaStreamToken(tokenFromPath(streamUrl.pathname, "/twilio/live-stream"), { env: ENV });
  expect(bound).toMatchObject({ ok: true, callSid: SID });

  // `in-progress` right after the answer, as the harness sends it.
  const inProgress = await send(app, buildOutboundStatusRequest({ ...COMMON, ...PARTIES, status: "in-progress" }));
  expect(inProgress.status).toBe(200);
  expect(db.stampAttemptStatus).toHaveBeenLastCalledWith("att-1", { twilioStatus: "in-progress", answered: true, terminal: false, result: null });

  const call = await bootLive({
    config: CONFIG,
    callSid: SID,
    customParameters: twiml.customParameters,
    authorizedCallSid: bound.callSid,
    database: db,
    env: { ...ENV, ...env },
    postCall,
  });

  const observer = createClientObserver();
  observer.answered(ANSWER_AT);
  observer.streamStarted(0);
  const toTwilio = [];
  vi.spyOn(call.ws, "send").mockImplementation((raw) => {
    const msg = JSON.parse(raw);
    toTwilio.push(msg);
    observer.fromServer(msg, call.clock());
  });
  return { db, postCall, app, call, observer, toTwilio };
}

/**
 * Step 6: the caller hangs up (the session's own finish() fires first, and
 * stamps session_finished_at, then tries -- and fails -- to claim, because
 * status_completed_at is not set yet); then Twilio's terminal status
 * callback lands (stamps status_completed_at, and its OWN tryClaim call now
 * finds both inputs present and claims -- "whichever arrives second").
 */
async function hangUpAndComplete({ app, call, db, postCall }) {
  await call.hangUp();
  expect(db.attempt.sessionFinishedAt).not.toBeNull(); // the session's own half landed already
  expect(db.attempt.postCallStarted).toBe(false); // but status_completed_at had not landed yet: no claim yet

  const done = await send(app, buildOutboundStatusRequest({ ...COMMON, ...PARTIES, status: "completed", durationSeconds: 7 }));
  expect(done.status).toBe(200);
  expect(db.completeCall).toHaveBeenCalledTimes(1);
  expect(db.completeCall).toHaveBeenCalledWith(SID, "completed", 7);
  expect(postCall.tryClaim).toHaveBeenCalledWith(SID);

  // Task 20 completes: "post-call runs exactly once". Both callers tried to
  // claim (the session's finish(), then the door's terminal status), and
  // exactly one of them actually claimed it.
  expect(db.claimPostCall).toHaveBeenCalledTimes(2);
  expect(db.attempt.postCallStarted).toBe(true);
  expect(db.applyOutreachResult).toHaveBeenCalledTimes(1); // runPostCall's own step 5, run exactly once
}

/** The server's log lines, as the CLI would read them back from --server-log. */
const serverLog = () => parseServerLog(logged.map((e) => JSON.stringify(e)).join("\n"), { callSid: SID });

/** 24 kHz PCM16 as the model sends it. */
function modelAudioMsg(ms = 200) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  return { serverContent: { modelTurn: { parts: [{ inlineData: { data: buf.toString("base64") } }] } } };
}

const echo = (call, name) => call.ws.deliver({ event: "mark", mark: { name } });
const results = (v) => Object.fromEntries(Object.entries(v.criteria).map(([k, c]) => [k, c.result]));

beforeEach(() => {
  logged.length = 0;
});

describe("the simulated outbound call, through the real door and session", () => {
  // Live mode (contract item 6): this scenario IS the pre-S3-2 race by
  // definition (mode: "speaks_first" -- Live's own reply is the first audio).
  // Clip mode (the new default) never lets Live speak first at all, so this
  // needs the explicit env override to keep testing the race it names.
  it("SPEAKS FIRST: 'Hello?' -> no assistant frame before the onset, Live's reply is the first audio (live_reply) within 2 s; calls row outbound; terminal status claims post-call", async () => {
    const ctx = await answerAndStart({ env: { OUTBOUND_FIRST_SPEAKER: "live" } });
    const { call, observer, toTwilio, db, app } = ctx;
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    // Step 4: the person picks up and says nothing yet. Nothing may play.
    await call.feed(1100);
    expect(toTwilio.filter((m) => m.event === "media")).toEqual([]);

    // "Hello?" -- the harness marks the onset at its first speech frame, which
    // the fake line delivers one frame (20 ms) on.
    observer.helloOnset(call.clock() + 20);
    await call.feed(300, { voiced: true });
    expect(toTwilio.filter((m) => m.event === "media")).toEqual([]);

    // Live answers the hello: its audio is the first thing the person hears.
    call.live.push(modelAudioMsg());
    await call.settle();
    expect(enqueue).toHaveBeenCalled();
    expect(enqueue.mock.calls.every(([buf]) => buf !== OPENER_AUDIO)).toBe(true);
    expect(call.live.sent.clientContent).toEqual([]); // no backstop, no seed

    // The harness echoes the first-audio mark (nothing ahead of it: at once).
    echo(call, FIRST_AUDIO_MARK);
    expect(call.ws.liveDialFirstSeconds.firstAudio()).toMatchObject({ path: "live_reply", measured: "playout" });

    // --amd human: recorded, and nothing reaches Twilio REST.
    const amd = await send(app, buildOutboundAmdRequest({ ...COMMON, answeredBy: "human", durationMs: 2400 }));
    expect(amd.status).toBe(200);
    expect(db.stampAttemptAmd).toHaveBeenCalledWith("att-1", { answeredBy: "human", amdDurationMs: 2400, result: null });

    // Step 5: the calls row.
    expect(db.createCall).toHaveBeenCalledTimes(1);
    expect(db.createCall.mock.calls[0]).toEqual([BIZ, SID, CONTACT, CALLER_ID, LINKS]);

    await hangUpAndComplete(ctx);

    const v = outboundVerdict({
      mode: "speaks_first",
      clip: true,
      client: observer.snapshot(),
      server: serverLog(),
      db: { calls: { direction: db.createCall.mock.calls[0][4].direction }, attempt: { post_call_started_at: db.attempt.postCallStarted ? new Date() : null } },
      personaName: "Ava",
    });
    expect(results(v)).toEqual({
      no_frame_before_onset: "PASS",
      path_live_reply: "PASS",
      from_speech_ms_le_2000: "PASS",
      calls_direction_outbound: "PASS",
      post_call_exactly_once: "PASS",
    });
    expect(v.criteria.from_speech_ms_le_2000.client_from_speech_ms).toBe(280);
    expect(v.pass).toBe(true);
  });

  // CHANGED (S3-2, P-a): 1,640/1,660/1,650 -> 1,380/1,400 -- silenceBackstopMs
  // moved from 2,000 to 1,750, and the new deadline (1,400) is itself a
  // multiple of the 20 ms frame size, so it is hit EXACTLY rather than
  // overshot.
  it("SILENT: the backstop is queued 1,400 ms after stream start (1,750 - 350, S3-2), seeded, backstop_silence; Live does not introduce itself again", async () => {
    const ctx = await answerAndStart({ env: { LIVE_DEBUG_TRANSCRIPT: "1" } });
    const { call, observer, toTwilio, db } = ctx;
    const enqueue = vi.spyOn(call.ws.liveAudioOut, "enqueue");

    await call.feed(1380);
    expect(toTwilio.filter((m) => m.event === "media" || m.event === "mark")).toEqual([]);
    expect(call.live.sent.clientContent).toEqual([]);

    await call.feed(20); // 1,400: the deadline, landed on exactly
    expect(enqueue).toHaveBeenCalledWith(OPENER_AUDIO);
    expect(toTwilio[0]).toMatchObject({ event: "mark", mark: { name: FIRST_AUDIO_MARK } });
    expect(toTwilio[1]).toMatchObject({ event: "media" });
    expect(call.live.sent.clientContent).toEqual([{ turns: [{ role: "model", parts: [{ text: OPENER }] }], turnComplete: false }]);

    echo(call, FIRST_AUDIO_MARK);
    await call.feed(1000); // the one-second clip plays out
    echo(call, BACKSTOP_END_MARK);

    // The person stays silent; Live's next turn is a nudge, not a second opener.
    call.live.push(modelAudioMsg());
    await call.settle();
    await call.assistantTurn("Sorry, is now a bad time?");
    await call.feed(1000);

    expect(db.createCall.mock.calls[0]).toEqual([BIZ, SID, CONTACT, CALLER_ID, LINKS]);
    await hangUpAndComplete(ctx);

    const server = serverLog();
    expect(server.backstopPlayed).toEqual([{ path: "backstop_silence", source: "stored", seed: "at_fire" }]);
    expect(server.assistantTurns.map((t) => t.text)).toEqual(["Sorry, is now a bad time?"]);

    const v = outboundVerdict({
      mode: "silent",
      clip: true,
      client: observer.snapshot(),
      server,
      db: { calls: { direction: db.createCall.mock.calls[0][4].direction }, attempt: { post_call_started_at: db.attempt.postCallStarted ? new Date() : null } },
      personaName: "Ava",
    });
    expect(results(v)).toEqual({
      path_backstop_silence: "PASS",
      backstop_queued_at_target_ms: "PASS",
      played_out_le_2500: "PASS",
      seeded: "PASS",
      no_second_intro: "PASS",
      calls_direction_outbound: "PASS",
      post_call_exactly_once: "PASS",
    });
    // RENAMED (S3-5): the key was `backstop_queued_at_1650`, a stale label
    // from before S3-2 -- the underlying target (SILENT_QUEUE_TARGET_MS)
    // already recomputed from FIRST_SECONDS_DEFAULTS and was checked
    // correctly here; only the identifier's own number was out of date. It
    // is now named after the constant, not a number (lib/probe/
    // outboundHarness.js), so a future change to silenceBackstopMs cannot
    // make it stale again.
    expect(v.criteria.backstop_queued_at_target_ms.client_queued_ms).toBe(1400);
    // Played out at the echo, 1,400 + 350: T1's own fix -- this is now UNDER
    // 2,000, where it used to read 2,010 (above_2000: true) before P-a.
    expect(v.criteria.played_out_le_2500).toMatchObject({ server_from_answer_ms: 1750, measured: "playout", above_2000: false });
    expect(v.pass).toBe(true);
  });

  it("b7 (checkpoint 2b review): the silent-path backstop's own line lands in the tenant transcript, once, with the AI disclosure", async () => {
    // persistTranscriptRows, not persistTurnTranscript: the real first turn
    // (the model's own reply once the person eventually speaks) must still
    // get its own row later, undropped by this one.
    const ctx = await answerAndStart();
    const { call, db } = ctx;

    await call.feed(1660); // past the silence deadline (1,400, S3-2): the backstop fires and is seeded AT ONCE (O-8 is the slow path only)

    expect(OPENER).toMatch(/\bAI\b/i); // the line this session is actually verifying carries the disclosure
    const backstopRows = db.transcript.filter((r) => r.message === OPENER);
    expect(backstopRows).toHaveLength(1);
    expect(backstopRows[0].speaker).toBe("ai");

    await hangUpAndComplete(ctx);
    // Still exactly once after the real turn and teardown: not re-written by
    // a later flush, and the real turn's own row was not dropped by it.
    expect(db.transcript.filter((r) => r.message === OPENER)).toHaveLength(1);
  });

  it("the sim can FAIL: a hello AFTER the silence deadline hears the backstop first -- speaks-first fails no_frame_before_onset and the path", async () => {
    const ctx = await answerAndStart();
    const { call, observer, db } = ctx;

    await call.feed(1700); // the backstop already fired (silence deadline 1,400, S3-2)
    observer.helloOnset(call.clock() + 20);
    await call.feed(300, { voiced: true });
    await hangUpAndComplete(ctx);

    const v = outboundVerdict({
      mode: "speaks_first",
      clip: true,
      client: observer.snapshot(),
      server: serverLog(),
      db: { calls: { direction: db.createCall.mock.calls[0][4].direction }, attempt: { post_call_started_at: db.attempt.postCallStarted ? new Date() : null } },
      personaName: "Ava",
    });
    expect(v.criteria.no_frame_before_onset.result).toBe("FAIL");
    expect(v.criteria.no_frame_before_onset.frames_before_onset).toBeGreaterThan(0);
    expect(v.criteria.path_live_reply).toMatchObject({ result: "FAIL", path: "backstop_silence" });
    expect(v.pass).toBe(false);
  });

  it("an unsigned answer is refused at the door (403), so a harness that signs wrongly cannot read as a dead route", async () => {
    const db = harnessDb();
    const app = doorApp(db, { tryClaim: vi.fn() });
    const req = buildOutboundAnswerRequest({ ...COMMON, ...PARTIES, authToken: "not-the-token" });
    const res = await send(app, req);
    expect(res.status).toBe(403);
    expect(db.outboundAttemptByCallSid).not.toHaveBeenCalled();
  });

  // Task 20 completes: the post-call chain (the real postCall.tryClaim) runs
  // exactly once per call, however many terminal callbacks arrive.
  it("Task 20 completes: post-call runs exactly once, even with a DUPLICATE terminal callback (a Cloud Tasks / Twilio retry)", async () => {
    const ctx = await answerAndStart();
    const { db, app, postCall } = ctx;

    await hangUpAndComplete(ctx);
    expect(db.attempt.postCallStarted).toBe(true);
    expect(db.claimPostCall).toHaveBeenCalledTimes(2);
    expect(db.applyOutreachResult).toHaveBeenCalledTimes(1);

    // A duplicate "completed" callback -- Twilio retries a status callback
    // whose response it never got, and the sweep can also independently
    // try the same attempt. Both routes ONLY ever call postCall.tryClaim /
    // tryClaimByAttempt; claimPostCall's own guard (post_call_started_at IS
    // NULL) is what makes a third+ call a safe no-op.
    const again = await send(app, buildOutboundStatusRequest({ ...COMMON, ...PARTIES, status: "completed", durationSeconds: 7 }));
    expect(again.status).toBe(200);
    expect(postCall.tryClaim).toHaveBeenCalledTimes(2); // once per terminal callback
    expect(db.claimPostCall).toHaveBeenCalledTimes(3); // the duplicate tried too...
    expect(db.applyOutreachResult).toHaveBeenCalledTimes(1); // ...but runPostCall did NOT run again

    // The sweep, arriving later still, must also refuse: postcall_pending's
    // own precondition (post_call_started_at IS NULL) already fails.
    const sweptAgain = await postCall.tryClaimByAttempt("att-1", BIZ);
    expect(sweptAgain).toBe(false);
    expect(db.applyOutreachResult).toHaveBeenCalledTimes(1);

    // Only post_call_exactly_once is under test here; the other speaks_first
    // criteria are exercised fully by the first test above.
    const v = outboundVerdict({
      mode: "speaks_first",
      clip: true,
      client: {},
      server: serverLog(),
      db: { calls: { direction: "outbound" }, attempt: { post_call_started_at: db.attempt.postCallStarted ? new Date() : null } },
      personaName: "Ava",
    });
    expect(v.criteria.post_call_exactly_once.result).toBe("PASS");
    expect(v.criteria.post_call_exactly_once.post_call_started_at).not.toBeNull();
    expect(v.criteria.post_call_exactly_once.attempt_result_log_count).toBe(1);
  });

  // Fix round 1, item 5: finish() now chains session_finished_at (and so
  // the post-call claim) AFTER transcriptSettled, exactly like the verify/
  // recover readers already did. Proven directly: the assistant's LAST
  // turn -- spoken right before hangup, where an opt-out confirmation
  // ("we won't call you again") most often lives -- must still be visible
  // to the detector once post-call runs.
  it("Task 20 fix round 1, item 5: the FINAL turn (right before hangup) reaches the opt-out detector", async () => {
    const ctx = await answerAndStart();
    const { call, db, app } = ctx;

    // A deterministic ORDER log of WHEN each event actually happened,
    // checked only after BOTH are guaranteed to have occurred (an explicit
    // extra wait below) -- not a race decided by how fast the assertion
    // happens to run. The final turn's own write is delayed past
    // `call.assistantTurn()`'s own settle time (2x25ms), so it is STILL
    // PENDING at the exact moment `finish()` fires (synchronously, inside
    // `call.hangUp()`'s `ws.deliver({event:"stop"})`, before hangUp's own
    // settles) -- only a finish() that genuinely waits for transcriptSettled
    // can see this write land before reading the transcript.
    const order = [];
    db.addTranscriptEntry.mockImplementationOnce(
      (_callId, speaker, message, sequence) =>
        new Promise((resolve) => {
          setTimeout(() => {
            db.transcript.push({ speaker, message, sequence });
            order.push("transcript_write");
            resolve();
          }, 150);
        })
    );
    const realFetch = db.fetchCallTranscript.getMockImplementation();
    db.fetchCallTranscript.mockImplementation(async (...args) => {
      order.push("fetch_call_transcript");
      return realFetch(...args);
    });

    // The assistant's very last words before the caller hangs up.
    await call.assistantTurn("I've made sure we won't call you again.");

    // NOT the shared hangUpAndComplete(): its own assertions assume
    // session_finished_at lands within call.hangUp()'s ordinary settle
    // time, which the delayed write above deliberately violates (that is
    // the whole point -- finish() must wait for it). Same two real steps,
    // without that timing assumption.
    await call.hangUp();
    const done = await send(app, buildOutboundStatusRequest({ ...COMMON, ...PARTIES, status: "completed", durationSeconds: 7 }));
    expect(done.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300)); // both events are guaranteed to have happened by now

    expect(order).toEqual(["transcript_write", "fetch_call_transcript"]);

    // The transcript runPostCall actually read (captured by the wrapper
    // above, the ONE real read during hangUpAndComplete) included the final
    // turn...
    const rows = await db.fetchCallTranscript("call-1");
    expect(rows.map((r) => r.message)).toContain("I've made sure we won't call you again.");
    // ...and it reached the detector: the suppression was inserted, proving
    // post-call did not run (and read the transcript) before this turn's
    // row had landed.
    expect(db.insertDetectorSuppression).toHaveBeenCalledWith({ phone: CONTACT, sourceCallId: "call-1" });
  });
});
