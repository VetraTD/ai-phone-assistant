// ---------------------------------------------------------------------------
// Boot a real Live session against fake vendors, and drive it with the four
// things a phone call is made of: the caller speaks, the assistant speaks, a
// tool is called, the turn ends.
//
// Extracted from tests/liveWritePathEndToEnd.test.js so the corpus replay
// (tests/liveCorpusReplay.test.js) drives the same path rather than a second
// approximation of it. That file's header explains why the path matters and is
// still the place to read first; what follows is only the mechanism.
//
// THE ONE PROPERTY WORTH RESTATING: there is NO `execute` override. The real
// executeToolCallGuarded runs, so every gate in services/tools.js and every
// guard in lib/voice/live/guards.js is in the path, and `callerSaidThisCall` is
// set by the real accumulator in lib/voice/live/index.js rather than by a test
// helper. That is what separates this from lib/harness/liveTextSession.js,
// which sets none of those fields and therefore cannot reach a consent gate at
// all.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import { vi, expect } from "vitest";
import { handleLiveSessionConnection } from "../../lib/voice/live/index.js";
import { makeFakeDeps } from "../../lib/harness/fakeDeps.js";
import { getLatencyStats } from "../../lib/voice/metrics.js";

export class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = 1;
  }
  send() {}
  // Records the close code (Task 14): the outbound 1008 path is asserted on
  // it. `closeCode` stays undefined for a socket nobody closed.
  close(code, reason) {
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
  }
  deliver(msg) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

/**
 * A Twilio REST client stand-in: `client.calls(sid).update({ twiml })`. Every
 * call is recorded in `updates` BEFORE any rejection, so a test can see the
 * attempt even when `failWith` makes it fail.
 */
export function fakeTwilioClient({ failWith } = {}) {
  const updates = [];
  const calls = vi.fn((sid) => ({
    update: async (params = {}) => {
      updates.push({ sid, twiml: params.twiml });
      if (failWith) throw failWith;
      return {};
    },
  }));
  return { calls, updates };
}

export function fakeLive({ connectGate, connectError } = {}) {
  // C1 (checkpoint-A review). `audioIn` records every caller-audio realtime
  // input, in call order -- the only way to prove "caller audio reaches Live
  // AFTER the seed" from outside index.js: `sendRealtimeInput` used to be a
  // pure no-op, so no test could see whether or when a frame reached Live at
  // all. Push order here IS wall-clock send order (session.sendRealtimeInput
  // and session.sendClientContent are called synchronously, from the same
  // single-threaded engine), so comparing `sent.audioIn.length` before and
  // after a `sent.clientContent` push proves ordering directly.
  const sent = { clientContent: [], toolResponses: [], audioIn: [] };
  let onmessage = null;
  let onclose = null;
  const session = {
    sendRealtimeInput: (m) => {
      if (m?.audio) sent.audioIn.push(m.audio);
    },
    sendClientContent: (m) => sent.clientContent.push(m),
    sendToolResponse: (m) => sent.toolResponses.push(m),
    close: () => {},
  };
  return {
    sent,
    connect: vi.fn(async ({ callbacks }) => {
      // Final fix wave I1: a test can hold the vendor connect open (cold connect).
      if (connectGate === "reject" || connectError) {
        // The "AI won't start" case.
        throw connectError ?? new Error("connect refused");
      }
      if (connectGate) await connectGate;
      onmessage = callbacks.onmessage;
      onclose = callbacks.onclose;
      return { session, languagePinned: true, surface: "aistudio", model: "m" };
    }),
    push: (msg) => onmessage?.(msg),
    // Vendor closes the Live socket: reaches the session's own onclose with the
    // shape classifyClose(e) reads.
    close: ({ code = 1011, reason = "" } = {}) => onclose?.({ code, reason }),
  };
}

export function fakeDb(config, businessId) {
  return {
    isEnabled: () => true,
    lookupBusinessByPhone: async () => ({ id: businessId, name: config.businessName }),
    loadConfig: () => config,
    withTenantSafe: async (_id, fn) => fn(),
    createCall: async () => "call-1",
    // b2 (checkpoint 2b fix wave): finish() flushes the transcript on every
    // call this helper boots, inbound and outbound alike -- an unstubbed
    // method threw and printed live_transcript_write_failed noise on every
    // test that never overrides `database`.
    addTranscriptEntry: async () => {},
    listIntegrationsForBusiness: async () => [],
    fetchBusinessKnowledge: async () => [],
    fetchCallerContext: async () => null,
    // S4-1: inbound callback recognition. No outreach by default.
    openOutreachForPhone: async () => null,
    closeOutreachCalledBack: async () => true,
    linkCallToOutreach: async () => {},
    // Task 20: the outbound finish() hook's own half of post-call. A no-op
    // here so every existing (inbound AND outbound) test that boots a
    // session through this helper, and never asked to exercise post-call
    // itself, does not have to know this call site exists.
    finishAttemptSession: async () => {},
    // I6 (fix wave, checkpoint 2b): the same rule -- a no-op default so a
    // test that boots an outbound session and never asked to exercise this
    // stamp does not get an unexpected outbound_answered_stamp_failed error
    // log (several tests assert the log is otherwise clean).
    stampAttemptAnswered: async () => {},
  };
}

/** Task 20: a safe default so booting a session never reaches the REAL,
 * wired-up postCall singleton (which would try the real services/db.js pool).
 * Tests that care about the exactly-once claim inject their own. */
export function fakePostCall() {
  return { tryClaim: async () => false, tryClaimByAttempt: async () => false };
}

/** Counters, by the same names the production logs carry. */
export const counters = () => getLatencyStats().turnTaking;

/** 20 ms of mu-law silence, the same payloads tests/liveSilence.test.js feeds. */
const SILENCE_FRAME = Buffer.alloc(160, 0xff).toString("base64");
/** Full-scale mu-law, well above inboundVad's floor. */
const VOICED_FRAME = Buffer.alloc(160, 0x00).toString("base64");
const FRAME_MS = 20;

/**
 * @param {object} opts
 * @param {object} opts.config - the business config the session loads
 * @param {string} [opts.businessId]
 * @param {string} [opts.businessPhone] - must match `config.mainPhone`
 * @param {string} [opts.callerPhone]
 * @param {string} [opts.callSid]
 * @param {Array}  [opts.seedAppointments] - rows already in the diary
 * @param {number} [opts.slotCapacity]
 * @param {object} [opts.env]
 * @param {object} [opts.customParameters] - Task 14. The stream's
 *   customParameters, verbatim. Omitted: `{businessPhone, callerPhone}` as
 *   before.
 * @param {boolean} [opts.waitForConnect=true] - Task 14. `false` returns once
 *   the start frame is delivered and settled, without waiting for
 *   `live.connect` -- the outbound 1008 path never connects.
 * @param {object} [opts.database] - Task 14. Replaces `fakeDb(config,
 *   businessId)`; the outbound path needs the by-CallSid resolver on it.
 * @param {string|null} [opts.authorizedCallSid] - Task 14. What the signed
 *   stream token bound (server.js sets `ws.authorizedCallSid`). Omitted:
 *   unset, as before.
 */
export async function bootLive({
  config,
  businessId = "biz-1",
  businessPhone,
  callerPhone = "+15551234567",
  callSid = "CA_test",
  seedAppointments = [],
  slotCapacity = 1,
  env = {},
  customParameters,
  waitForConnect = true,
  database,
  authorizedCallSid,
  postCall,
  // Final wave W1 (I2): the hang-up drain's bounds, passed through when a
  // test sets them; omitted -> the production constants.
  clipDrainMaxMs,
  clipDrainSettleMs,
  // Stage 4 S4-2: the one-shot Deepgram fallback for an untranscribed hang-up
  // drain. NEVER the real vendor from a test: the default is a stub that
  // fails, which is the "Deepgram unavailable" branch.
  clipHoldStt,
  clipHoldSttTimeoutMs,
  // Final fix wave I1: a promise the fake vendor connect awaits before it
  // resolves (a cold connect); a test releases it after the hang-up.
  connectGate,
  // The post-call reader seams (lib/voice/live/index.js deps.verify /
  // deps.judge), passed through only when a test sets them.
  verify,
  judge,
  // Batch-3 S2: connect rejects (connectGate "reject" or a connectError); a
  // Twilio client recording calls(sid).update({twiml}); the call clock's timer
  // source; the account SID on the start frame.
  connectError,
  twilioClient,
  twilioClientForAccountSid,
  setTimer,
  clearTimer,
  accountSid,
} = {}) {
  const ws = new FakeSocket();
  if (authorizedCallSid !== undefined) ws.authorizedCallSid = authorizedCallSid;
  const live = fakeLive({ connectGate, connectError });
  const { deps, store } = makeFakeDeps({ seedAppointments, slotCapacity });

  // A MUTABLE CLOCK, not the frozen `() => 0` this helper used to inject.
  //
  // It starts at 0 and moves only when a test asks, so every suite written
  // against the frozen clock behaves identically. What it adds is the one thing
  // LVX131 needs and no bootLive test could do: stop delivering frames and let
  // wall time pass. The engine's watchdog compares `now()` against the last
  // frame's own `atMs`, and both come from here.
  let clock = 0;

  await handleLiveSessionConnection(ws, {}, {
    now: () => clock,
    connect: live.connect,
    database: database ?? fakeDb(config, businessId),
    env,
    capabilityDeps: deps,
    postCall: postCall ?? fakePostCall(),
    ...(clipDrainMaxMs !== undefined ? { clipDrainMaxMs } : {}),
    ...(clipDrainSettleMs !== undefined ? { clipDrainSettleMs } : {}),
    clipHoldStt: clipHoldStt ?? (async () => { throw new Error("no Deepgram in tests"); }),
    ...(clipHoldSttTimeoutMs !== undefined ? { clipHoldSttTimeoutMs } : {}),
    ...(verify ? { verify } : {}),
    ...(judge ? { judge } : {}),
    ...(twilioClient !== undefined ? { twilioClient } : {}),
    ...(twilioClientForAccountSid !== undefined ? { twilioClientForAccountSid } : {}),
    ...(setTimer !== undefined ? { setTimer } : {}),
    ...(clearTimer !== undefined ? { clearTimer } : {}),
  });

  ws.deliver({
    event: "start",
    start: {
      callSid,
      streamSid: "MZ1",
      ...(accountSid !== undefined ? { accountSid } : {}),
      customParameters: customParameters ?? {
        businessPhone: businessPhone || config.mainPhone,
        callerPhone,
      },
    },
  });
  if (waitForConnect) {
    await vi.waitFor(() => expect(live.connect).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
  } else {
    // Let the start handler's awaited lookups run to wherever they stop.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  }

  // A tool round is fire-and-forget from the outside -- guards, packForTool, the
  // awaited execute, the effect merge -- so there is nothing to await. 25 ms is
  // the figure tests/liveWriteRetry.test.js settled on after two setTimeout(0)s
  // proved insufficient and failed reporting that execute had never run.
  const settle = () => new Promise((r) => setTimeout(r, 25));

  let toolSeq = 0;

  const api = {
    ws,
    live,
    store,
    // Final wave W1: the capability deps object the session's tools read
    // (ctx.deps), so a test can add a writer the fake set lacks (e.g.
    // insertSuppression for the outbound opt_out pack).
    deps,
    settle,

    /** The caller speaks. Does NOT end the turn. */
    async callerSays(text) {
      live.push({ serverContent: { inputTranscription: { text } } });
      await settle();
    },

    /** The model speaks, and the turn ends. This is what sets lastReplyText. */
    async assistantTurn(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      await settle();
      live.push({ serverContent: { turnComplete: true } });
      await settle();
      await settle();
    },

    /** The model speaks without ending the turn -- a tool round follows. */
    async assistantSays(text) {
      live.push({ serverContent: { outputTranscription: { text } } });
      await settle();
    },

    /** End the current model turn with no further speech. */
    async turnEnds() {
      live.push({ serverContent: { turnComplete: true } });
      await settle();
      await settle();
    },

    /** Any tool, with any args. Returns the functionResponses it produced. */
    /**
     * SEVERAL tool calls in ONE batch, the way the model actually sends them.
     *
     * `callTool` sends one per message, which is a turn boundary the real
     * session does not have. On CA1dfe055f the model sent book_appointment and
     * end_call together, four milliseconds apart, and every guard that reads
     * state mirrored from the runner was judging the hang-up against the world
     * as it stood BEFORE the booking. No test could reach that shape.
     *
     * @param {Array<[string, object]>} calls - [name, args] pairs, in order
     */
    async callToolBatch(calls) {
      const before = live.sent.toolResponses.length;
      const functionCalls = calls.map(([name, args = {}]) => {
        toolSeq += 1;
        return { id: `fc${toolSeq}`, name, args };
      });
      live.push({ toolCall: { functionCalls } });
      await settle();
      await settle();
      return live.sent.toolResponses.slice(before).flatMap((m) => m.functionResponses || []);
    },

    async callTool(name, args = {}) {
      const before = live.sent.toolResponses.length;
      toolSeq += 1;
      live.push({ toolCall: { functionCalls: [{ id: `fc${toolSeq}`, name, args }] } });
      await settle();
      await settle();
      return live.sent.toolResponses
        .slice(before)
        .flatMap((m) => m.functionResponses || [])
        .filter((r) => r.name === name);
    },

    toolResponses: () => live.sent.toolResponses.flatMap((m) => m.functionResponses || []),
    responsesFor: (name) =>
      live.sent.toolResponses.flatMap((m) => (m.functionResponses || []).filter((r) => r.name === name)),

    /** Where the injected clock is now, in ms. */
    clock: () => clock,

    /**
     * Twilio delivers `ms` of media, 20 ms at a time, advancing the clock with
     * it. This is what a live call looks like to the engine: frames arrive
     * whether or not anyone is speaking.
     */
    async feed(ms, { voiced = false } = {}) {
      const frames = Math.round(ms / FRAME_MS);
      for (let i = 0; i < frames; i++) {
        clock += FRAME_MS;
        ws.deliver({ event: "media", media: { payload: voiced ? VOICED_FRAME : SILENCE_FRAME } });
      }
      await settle();
    },

    /**
     * Final wave W1: like feed(), but with the caller's own 20 ms mu-law
     * payloads -- one Buffer per frame, in order -- so a test can tell every
     * frame apart when it reaches Live (frame-order and loss assertions).
     */
    async feedFrames(frames) {
      for (const frame of frames) {
        clock += FRAME_MS;
        ws.deliver({ event: "media", media: { payload: Buffer.from(frame).toString("base64") } });
      }
      await settle();
    },

    /**
     * The LVX131 case: time passes and NO frame arrives. The socket is not
     * closed and Twilio sends no `stop` -- from the engine's side nothing
     * happens at all, which is precisely the state CAdfeb9d was left in.
     *
     * Real timers are advanced alongside the injected clock, because the
     * watchdog is a setInterval and the value it compares is `now()`. Advancing
     * one without the other tests neither.
     */
    async starve(ms) {
      clock += ms;
      if (vi.isFakeTimers?.()) await vi.advanceTimersByTimeAsync(ms);
      await settle();
    },

    /** Close the socket the way Twilio does, so finish() runs. */
    async hangUp() {
      ws.deliver({ event: "stop" });
      await settle();
      await settle();
    },
  };

  return api;
}
