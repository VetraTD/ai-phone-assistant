// ---------------------------------------------------------------------------
// THE DECISIONS OF scripts/live-call-harness.js --outbound, without the I/O.
//
// Pure by the same rule lib/probe/hangup.js follows: no timers, no sockets, no
// clock of its own, no database. The harness owns all of those and asks this
// module what to make of what it saw -- which is the only reason a verdict can
// be tested (tests/outboundHarnessVerdict.test.js, and the free end-to-end
// tests/liveOutboundHarness.test.js) without spending a call on it.
//
// What it decides:
//   - whether a DATABASE_URL is the local container (seeding never reaches a
//     non-local database);
//   - the lines dispatch would render for an attempt (the SAME rendering,
//     proven equal to lib/outbound/dispatch.js's by test);
//   - when a paced mark echo is due;
//   - the client-side clock: answer, stream start, hello onset, first frame;
//   - what the server's log says about THIS call;
//   - the ONE verdict, per criterion, which must be able to fail;
//   - what the run cost, or that it cannot be priced (then the full reserve is
//     committed, which keeps the Part 1 cap conservative);
//   - per rendered line: overlap, word_ratio, render time, and whether the
//     vendor's usageMetadata arrived before turnComplete.
// ---------------------------------------------------------------------------
import { randomBytes } from "node:crypto";
import { renderCampaignLine, CAMPAIGN_LIMITS, AI_DISCLOSURE_RE, foldDottedAI } from "../outbound/campaignSchema.js";
import { voicemailPermitted } from "../outbound/amd.js";
import { FIRST_AUDIO_MARK, FIRST_SECONDS_DEFAULTS } from "../outbound/firstSeconds.js";
import { wordOverlap, wordRatio } from "../outbound/liveRender.js";
import { emptyUsage, addUsage } from "../voice/geminiUsage.js";
import { priceTokens } from "../../scripts/probes/lib/spendLive.js";

/** reserveP1 per harness run with a real Live session (the brief's figure). */
export const HARNESS_RESERVE_USD = 0.05;

/** The vetra-pg16 container. The ONLY database the harness will seed. */
export const LOCAL_DB_PORT = "55432";
const LOOPBACK_DB_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Silent pickup: the backstop is QUEUED at pickup + 2.0 s = stream start + 1,650 (O-7). */
export const SILENT_QUEUE_TARGET_MS = FIRST_SECONDS_DEFAULTS.silenceBackstopMs - FIRST_SECONDS_DEFAULTS.answerToStreamMs;
export const SILENT_QUEUE_TOLERANCE_MS = 100;
/** Silent pickup: played out within this of the answer (owner-accepted 2.1-2.3 s; recorded, not hidden). */
export const SILENT_PLAYOUT_MAX_MS = 2500;
/** Speaks first: heard within this of the onset (Ofcom limb 1). */
export const SPEECH_REPLY_MAX_MS = 2000;
/** How much later than the simulated answer -> stream offset the stream may start before the run is warned about. */
export const STREAM_START_SLACK_MS = 100;

const PASS = "PASS";
const FAIL = "FAIL";
const UNKNOWN = "UNKNOWN";
const PENDING = "pending_task20";

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Throw unless `url` is the local Postgres container: a loopback host AND port
 * 55432. Loopback alone is NOT local -- the Cloud SQL Auth Proxy listens on
 * 127.0.0.1:5432, and a harness that seeded through it would write fake
 * tenants into production.
 *
 * @param {string|undefined} url
 * @returns {{host: string, port: string, database: string}}
 */
export function assertLocalDatabase(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error(
      "DATABASE_URL is not set. The outbound harness seeds and reads the LOCAL database " +
        `(postgresql://vetra:...@localhost:${LOCAL_DB_PORT}/vetra) and refuses to guess.`
    );
  }
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("DATABASE_URL could not be parsed as a URL; refusing to seed.");
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) {
    throw new Error(`DATABASE_URL could not be parsed as a postgres URL (${u.protocol}); refusing to seed.`);
  }
  if (!LOOPBACK_DB_HOSTS.has(u.hostname)) {
    throw new Error(`DATABASE_URL host ${u.hostname} is not loopback: the harness never seeds a non-local database.`);
  }
  if (u.port !== LOCAL_DB_PORT) {
    throw new Error(
      `DATABASE_URL port ${u.port || "(default 5432)"} is not ${LOCAL_DB_PORT}. Loopback alone is not local: the ` +
        `Cloud SQL Auth Proxy listens on 127.0.0.1:5432. Only the vetra-pg16 container (localhost:${LOCAL_DB_PORT}) is accepted.`
    );
  }
  return { host: u.hostname, port: u.port, database: u.pathname.replace(/^\//, "") };
}

/** The harness's own loopback rule for --base (scripts/live-call-harness.js). */
export function isLoopbackBase(base) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(String(base || ""));
}

// ---------------------------------------------------------------------------
// Seeding values
// ---------------------------------------------------------------------------

/**
 * Two distinct numbers in Ofcom's drama range (07700 900000-900999), which
 * are never allocated to a real line: OUR number (the caller_id) and the
 * person's.
 * @param {() => number} [rand]
 */
export function pickHarnessNumbers(rand = Math.random) {
  const a = 100 + Math.floor(rand() * 900);
  const offset = 1 + Math.floor(rand() * 898);
  const b = 100 + ((a - 100 + offset) % 900);
  return { callerId: `+447700900${a}`, contact: `+447700900${b}` };
}

/** A synthetic, unique CallSid the media-stream token can bind (no `.`, `/`, `\`). */
export function harnessCallSid() {
  return `CAharness${Date.now().toString(16)}${randomBytes(4).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// The lines dispatch would render
// ---------------------------------------------------------------------------

/**
 * The TEXT dispatch hands `renderAudio` for this attempt (lib/outbound/
 * dispatch.js, Task 13 / O-4 / O-9): each line rendered by renderCampaignLine
 * from the row's current values, OMITTED -- never truncated -- when it is
 * unusable or over budget, and the voicemail only when this attempt is in
 * voicemail_on and the class permits one.
 *
 * Mirrors dispatch.js rather than calling it (that function also locks rows,
 * runs the gate and dials); tests/outboundHarnessVerdict.test.js runs the REAL
 * dispatcher on the same rows and requires the two to be equal.
 *
 * @param {{row: {first_name: string|null, business_name: string, config: object, compliance_class: string}, attemptNo: number}} a
 * @returns {{lines: {opener?: string, voicemail?: string}, refused: Array<{kind: string, reason?: string, chars?: number}>}}
 */
export function dispatchLines({ row, attemptNo }) {
  const renderLine = (tpl) => renderCampaignLine(tpl, { firstName: row.first_name, businessName: row.business_name, config: row.config });
  const lines = {};
  const refused = [];

  const opener = renderLine(row.config.opener);
  if (opener === null) refused.push({ kind: "opener", reason: "unusable_line" });
  else if (opener.length > CAMPAIGN_LIMITS.rendered_opener) refused.push({ kind: "opener", chars: opener.length });
  else lines.opener = opener;

  const voicemailDue = (row.config.retries?.voicemail_on || []).includes(attemptNo) && voicemailPermitted(row.compliance_class);
  if (voicemailDue) {
    const voicemail = renderLine(row.config.voicemail);
    if (voicemail === null) refused.push({ kind: "voicemail", reason: "unusable_line" });
    else if (voicemail.length > CAMPAIGN_LIMITS.rendered_voicemail) refused.push({ kind: "voicemail", chars: voicemail.length });
    else lines.voicemail = voicemail;
  }
  return { lines, refused };
}

// ---------------------------------------------------------------------------
// The socket side
// ---------------------------------------------------------------------------

/**
 * The paced mark echo, the rule the inbound harness has always used
 * (scripts/live-call-harness.js, the `mark` handler): Twilio echoes a mark
 * only once the audio ahead of it has played, so an echo is due at the end of
 * the audio received so far, and a `clear` drops whatever was queued.
 * @param {{frameMs?: number}} [o]
 */
export function createPlayoutClock({ frameMs = 20 } = {}) {
  let playoutUntil = 0;
  return {
    onMedia(now) {
      playoutUntil = Math.max(playoutUntil, now) + frameMs;
    },
    markDelay(now) {
      return Math.max(0, playoutUntil - now);
    },
    onClear(now) {
      playoutUntil = now;
    },
  };
}

/**
 * The client-side clock. The harness tells it when it sent the answer, when
 * it sent the stream's `start`, when its first "Hello?" frame went out, and
 * hands it every message the server sends toward "Twilio".
 *
 * `frames_before_onset` counts assistant media frames that arrived while no
 * hello had been sent yet: on a speaks-first run, every one of them is audio
 * the person would have heard before saying anything.
 *
 * @param {{firstAudioMark?: string}} [o]
 */
export function createClientObserver({ firstAudioMark = FIRST_AUDIO_MARK } = {}) {
  let answeredAt = null;
  let streamStartAt = null;
  let helloOnsetAt = null;
  let firstMediaAt = null;
  let firstAudioMarkAt = null;
  let mediaFrames = 0;
  let framesBeforeOnset = 0;
  let marksReceived = 0;
  let clears = 0;
  const markNames = new Set();

  const rel = (t, base) => (t === null || base === null ? null : Math.round(t - base));

  return {
    answered(at) {
      answeredAt = at;
    },
    streamStarted(at) {
      streamStartAt = at;
    },
    helloOnset(at) {
      if (helloOnsetAt === null) helloOnsetAt = at;
    },
    fromServer(msg, at) {
      if (msg?.event === "media" && msg.media?.payload) {
        mediaFrames += 1;
        if (firstMediaAt === null) firstMediaAt = at;
        if (helloOnsetAt === null || at < helloOnsetAt) framesBeforeOnset += 1;
      } else if (msg?.event === "mark" && msg.mark?.name) {
        marksReceived += 1;
        markNames.add(msg.mark.name);
        if (msg.mark.name === firstAudioMark && firstAudioMarkAt === null) firstAudioMarkAt = at;
      } else if (msg?.event === "clear") {
        clears += 1;
      }
    },
    /** Every time relative to the answer, except where named otherwise. null = never happened. */
    snapshot() {
      return {
        hello_onset_at: rel(helloOnsetAt, answeredAt),
        first_media_at: rel(firstMediaAt, answeredAt),
        first_audio_mark_at: rel(firstAudioMarkAt, answeredAt),
        stream_start_from_answer_ms: rel(streamStartAt, answeredAt),
        hello_onset_from_answer_ms: rel(helloOnsetAt, answeredAt),
        from_answer_ms: rel(firstMediaAt, answeredAt),
        from_speech_ms: rel(firstMediaAt, helloOnsetAt),
        first_audio_mark_from_stream_start_ms: rel(firstAudioMarkAt, streamStartAt),
        first_audio_mark_from_answer_ms: rel(firstAudioMarkAt, answeredAt),
        frames_before_onset: framesBeforeOnset,
        media_frames: mediaFrames,
        marks_received: marksReceived,
        mark_names: [...markNames],
        clears,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The server's log
// ---------------------------------------------------------------------------

/**
 * A redirected log file as text: UTF-8 (with or without a BOM), or the
 * UTF-16LE a Windows PowerShell 5.1 `>` redirect writes.
 * @param {Buffer} buf
 */
export function decodeLogBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    return body.swap16().toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  const sample = buf.subarray(0, 400);
  let nuls = 0;
  for (const b of sample) if (b === 0) nuls += 1;
  if (sample.length > 0 && nuls > sample.length / 4) return buf.toString("utf16le");
  return buf.toString("utf8");
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/**
 * What the server's structured log says about ONE call. Session-level lines
 * with no callSid are read only for `live_debug_transcript_enabled`, which is
 * what makes "no introduction in the log" evidence rather than a switched-off
 * capture.
 *
 * @param {object[]} events - parsed log lines ({event, callSid, ...fields})
 * @param {{callSid: string}} o
 */
export function serverViewFromEvents(events, { callSid }) {
  const all = (events || []).filter((e) => e && typeof e === "object");
  const mine = all.filter((e) => e.callSid === callSid);
  const named = (name) => mine.filter((e) => e.event === name);
  const firstAudio = named("outbound_first_audio");
  return {
    events: mine,
    firstAudio: firstAudio[0] ? pick(firstAudio[0], ["from_answer_ms", "from_speech_ms", "path", "measured"]) : null,
    firstAudioCount: firstAudio.length,
    backstopPlayed: named("outbound_backstop_played").map((e) => pick(e, ["path", "source", "seed", "deferred_ms"])),
    backstopMissing: named("outbound_backstop_missing").map((e) => pick(e, ["path", "refetch", "line", "deferred_ms"])),
    firstTurnIncomplete: named("outbound_first_turn_incomplete").length,
    markTimeouts: named("outbound_backstop_mark_timeout").length,
    contextMissing: named("outbound_context_missing").map((e) => pick(e, ["reason"])),
    assistantTurns: named("live_debug_assistant_turn").map((e) => ({ text: typeof e.text === "string" ? e.text : "" })),
    summary: named("live_call_summary").at(-1) ?? null,
    debugTranscriptOn: all.some((e) => e.event === "live_debug_transcript_enabled"),
  };
}

/**
 * Parse `node server.js > file` output: one JSON object per line, anything
 * else (boot banners, stack traces) skipped.
 * @param {string} text
 * @param {{callSid: string}} o
 */
export function parseServerLog(text, { callSid }) {
  const events = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* not a log line */
    }
  }
  return serverViewFromEvents(events, { callSid });
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Did Live introduce itself in this turn? The §7 disclosure (dotted spellings
 * folded, as the session's own first-turn check folds them) or the persona
 * naming itself.
 * @param {string} text
 * @param {{personaName?: string}} [o]
 */
export function isIntroduction(text, { personaName } = {}) {
  const t = foldDottedAI(String(text || "")).replace(/[’]/g, "'");
  if (AI_DISCLOSURE_RE.test(t)) return true;
  const name = String(personaName || "").trim();
  if (!name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:it'?s|it is|this is|i'?m|i am|my name is)\\s+${esc}\\b`, "i").test(t);
}

const unknown = (reason) => ({ result: UNKNOWN, reason });

/**
 * THE ONE VERDICT. Every criterion is PASS, FAIL, UNKNOWN (the evidence to
 * judge it was not collected) or pending_task20. The run passes only when
 * every criterion is PASS or pending: an UNKNOWN is not a pass, because a sim
 * that cannot fail is worse than none.
 *
 * @param {object} a
 * @param {"speaks_first"|"silent"} a.mode
 * @param {boolean} [a.clip] - a rendered backstop clip was stored (false: --no-render, the prompt path)
 * @param {object} a.client - createClientObserver().snapshot()
 * @param {object|null} a.server - serverViewFromEvents()/parseServerLog(), or null without --server-log
 * @param {{calls: {direction?: string}|null}|null} a.db - the read-back, or null when not read
 * @param {string} [a.personaName]
 * @param {number|null} [a.answerToStreamMs] - the answer -> stream `start` offset the run simulated;
 *   a stream that started much later than that is WARNED about (a cold server shifts every
 *   answer-relative time), never silently folded into the criteria
 */
export function outboundVerdict({ mode, clip = true, client, server, db, personaName, answerToStreamMs = null }) {
  const c = client || {};
  const fa = server?.firstAudio ?? null;
  const criteria = {};

  if (mode === "speaks_first") {
    const onset = c.hello_onset_at ?? null;
    const first = c.first_media_at ?? null;
    const before = c.frames_before_onset ?? 0;
    const clean = onset !== null && before === 0 && (first === null || first >= onset);
    criteria.no_frame_before_onset = {
      result: clean ? PASS : FAIL,
      frames_before_onset: before,
      hello_onset_at: onset,
      first_media_at: first,
      ...(onset === null ? { reason: "the hello was never sent" } : {}),
    };
    criteria.path_live_reply = !server
      ? unknown("no server log (pass --server-log)")
      : !fa
        ? { result: FAIL, reason: "no outbound_first_audio for this call" }
        : { result: fa.path === "live_reply" ? PASS : FAIL, path: fa.path };
    const ms = c.from_speech_ms ?? null;
    criteria.from_speech_ms_le_2000 = {
      result: ms !== null && ms >= 0 && ms <= SPEECH_REPLY_MAX_MS ? PASS : FAIL,
      client_from_speech_ms: ms,
      server_from_speech_ms: fa?.from_speech_ms ?? null,
      server_measured: fa?.measured ?? null,
      ...(ms === null ? { reason: "no assistant audio after the hello" } : {}),
    };
  } else if (mode === "silent") {
    criteria.path_backstop_silence = !server
      ? unknown("no server log (pass --server-log)")
      : !fa
        ? { result: FAIL, reason: "no outbound_first_audio for this call" }
        : { result: fa.path === "backstop_silence" ? PASS : FAIL, path: fa.path };
    if (clip) {
      const q = c.first_audio_mark_from_stream_start_ms ?? null;
      criteria.backstop_queued_at_1650 = {
        result: q !== null && Math.abs(q - SILENT_QUEUE_TARGET_MS) <= SILENT_QUEUE_TOLERANCE_MS ? PASS : FAIL,
        client_queued_ms: q,
        target_ms: SILENT_QUEUE_TARGET_MS,
        tolerance_ms: SILENT_QUEUE_TOLERANCE_MS,
      };
      criteria.played_out_le_2500 = !server
        ? unknown("no server log (pass --server-log)")
        : !fa
          ? { result: FAIL, reason: "no outbound_first_audio for this call" }
          : {
              result: fa.measured === "playout" && typeof fa.from_answer_ms === "number" && fa.from_answer_ms <= SILENT_PLAYOUT_MAX_MS ? PASS : FAIL,
              server_from_answer_ms: fa.from_answer_ms,
              measured: fa.measured,
              above_2000: typeof fa.from_answer_ms === "number" && fa.from_answer_ms > 2000,
              client_from_answer_ms: c.from_answer_ms ?? null,
              ...(fa.measured !== "playout" ? { reason: "not measured at playout: the first-audio mark was never echoed" } : {}),
            };
      criteria.seeded = !server
        ? unknown("no server log (pass --server-log)")
        : {
            result: server.backstopPlayed.some((b) => b.path === "backstop_silence" && b.seed === "at_fire") ? PASS : FAIL,
            backstop_played: server.backstopPlayed.length,
          };
    } else {
      criteria.backstop_missing_logged = !server
        ? unknown("no server log (pass --server-log)")
        : {
            result: server.backstopMissing.some((m) => m.path === "backstop_silence") ? PASS : FAIL,
            count: server.backstopMissing.length,
          };
    }
    if (!server) {
      criteria.no_second_intro = unknown("no server log (pass --server-log)");
    } else if (!server.debugTranscriptOn) {
      criteria.no_second_intro = unknown("the server log carries no assistant text: run the server with LIVE_DEBUG_TRANSCRIPT=1");
    } else {
      const intros = server.assistantTurns.filter((t) => isIntroduction(t.text, { personaName })).length;
      // The clip IS the introduction; on the prompt path Live's first turn is.
      const allowed = clip ? 0 : 1;
      criteria.no_second_intro = {
        result: intros <= allowed ? PASS : FAIL,
        intro_turns: intros,
        allowed,
        assistant_turns: server.assistantTurns.length,
      };
    }
  } else {
    throw new Error(`outboundVerdict: unknown mode ${JSON.stringify(mode)}`);
  }

  criteria.calls_direction_outbound = !db
    ? unknown("the calls row was not read back")
    : { result: db.calls?.direction === "outbound" ? PASS : FAIL, direction: db.calls?.direction ?? null };
  criteria.post_call_exactly_once = { result: PENDING, note: "Task 20 adds this criterion" };

  const pass = Object.values(criteria).every((x) => x.result === PASS || x.result === PENDING);

  const warnings = [];
  const streamAt = c.stream_start_from_answer_ms;
  if (typeof answerToStreamMs === "number" && typeof streamAt === "number" && streamAt > answerToStreamMs + STREAM_START_SLACK_MS) {
    warnings.push(
      `stream_start_late: the stream started ${streamAt} ms after the answer, not ~${answerToStreamMs} ms (a cold server?). ` +
        `Every answer-relative time on this run is shifted by ${streamAt - answerToStreamMs} ms; re-run before reading the timings.`
    );
  }

  return {
    mode,
    clip,
    pass,
    warnings,
    criteria,
    measurements: {
      client: c,
      server_first_audio: fa,
      server_from_answer_ms: fa?.from_answer_ms ?? null,
      server_from_speech_ms: fa?.from_speech_ms ?? null,
      backstop_played: server?.backstopPlayed ?? null,
      backstop_missing: server?.backstopMissing ?? null,
      first_turn_incomplete: server?.firstTurnIncomplete ?? null,
      mark_timeouts: server?.markTimeouts ?? null,
      context_missing: server?.contextMissing ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

/**
 * What the run cost, on the spendLive.js rate card: the call's
 * live_call_summary usage plus every render session's own usage. A model with
 * no card, a usage that never arrived, or a missing summary makes the whole
 * run UNPRICEABLE -- never partially priced, because an understated bill is
 * how a cap stops being one.
 *
 * @param {{sessionOpened: boolean, callSummary: {model?: string, usage?: object}|null, renderSessions?: Array<{kind?: string, model?: string, usage?: object}>}} a
 * @returns {{usd: number|null, basis: "priced"|"no_session"|"unpriceable", reason?: string, breakdown: object[]}}
 */
export function priceHarnessRun({ sessionOpened, callSummary, renderSessions = [] }) {
  if (!sessionOpened && renderSessions.length === 0) return { usd: 0, basis: "no_session", breakdown: [] };
  const breakdown = [];
  const unpriceable = (reason) => ({ usd: null, basis: "unpriceable", reason, breakdown });

  const priceOne = (part, model, usage) => {
    if (!model) return `${part}: no model recorded`;
    if (!usage || !(usage.turns_billed > 0)) return `${part}: no usageMetadata arrived`;
    const { turns_billed: _turns, ...tokens } = usage;
    const p = priceTokens(model, tokens);
    if (p.error) return `${part}: ${p.error}`;
    if (p.unpriced_tokens > 0) return `${part}: ${p.unpriced_tokens} tokens have no rate on the ${model} card`;
    breakdown.push({ part, model, usd: p.usd, tokens });
    return null;
  };

  if (sessionOpened) {
    if (!callSummary) return unpriceable("no live_call_summary for this call (pass --server-log)");
    const err = priceOne("call", callSummary.model, callSummary.usage);
    if (err) return unpriceable(err);
  }
  for (const [i, s] of renderSessions.entries()) {
    const err = priceOne(`render_${s.kind ?? i}`, s.model, s.usage);
    if (err) return unpriceable(err);
  }
  return { usd: breakdown.reduce((n, b) => n + b.usd, 0), basis: "priced", breakdown };
}

/**
 * reserveP1 before, commit after -- once, and always with a numeric usd
 * (commit() ignores an entry without one, Ruling 2a-5). An unpriceable run
 * commits the full reserve.
 *
 * @param {{probe: string, reserveUsd?: number, spend: {reserveP1: Function, commit: Function}}} a
 */
export function createSpendGuard({ probe, reserveUsd = HARNESS_RESERVE_USD, spend }) {
  let reserved = false;
  let committed = null;
  return {
    /** Throws BudgetExceeded (or a TypeError for a non-P1 name) -- nothing is spent then. */
    reserve() {
      spend.reserveP1(probe, reserveUsd);
      reserved = true;
    },
    reserved: () => reserved,
    committed: () => committed,
    /**
     * @param {{usd: number|null, basis?: string, reason?: string}|null} priced
     * @param {object} [extra] - ids for the ledger entry (callSid, mode)
     */
    commit(priced, extra = {}) {
      if (!reserved || committed) return committed;
      const usable = priced && typeof priced.usd === "number" && Number.isFinite(priced.usd) && priced.usd >= 0;
      const entry = usable
        ? { probe, usd: priced.usd, basis: priced.basis ?? "priced" }
        : { probe, usd: reserveUsd, basis: "full_reserve", ...(priced?.reason ? { reason: priced.reason } : {}) };
      spend.commit({ ...extra, ...entry });
      committed = entry;
      return entry;
    },
  };
}

// ---------------------------------------------------------------------------
// The render tap
// ---------------------------------------------------------------------------

function observeRenderMessage(s, msg, now) {
  if (!msg) return;
  if (msg.usageMetadata) {
    addUsage(s.usage, msg.usageMetadata);
    s.usageMessages += 1;
    if (s.turnCompleteAt === null) s.usageBeforeTurnComplete += 1;
    else s.usageAfterTurnComplete += 1;
  }
  const sc = msg.serverContent;
  if (!sc) return;
  if (s.firstAudioAt === null && (sc.modelTurn?.parts || []).some((p) => p?.inlineData?.data)) s.firstAudioAt = now();
  if (sc.outputTranscription?.text) s.transcript += sc.outputTranscription.text;
  if (sc.turnComplete && s.turnCompleteAt === null) s.turnCompleteAt = now();
}

/**
 * Wrap `connectLive` for lib/outbound/liveRender.js so each render session is
 * observed without changing it: the line it was asked to say, its transcript,
 * its model, its usage (folded as geminiUsage.js folds it), when its first
 * audio and its turnComplete arrived, and how many usageMetadata messages came
 * before and after that turnComplete -- the renderer meters at turnComplete,
 * so usage arriving after it is usage the product log never sees (M2).
 *
 * @param {Function} connect - connectLive, or a fake
 * @param {{now?: () => number}} [o]
 */
export function createRenderTap(connect, { now = () => Date.now() } = {}) {
  const sessions = [];
  async function tapped(args = {}) {
    const s = {
      startedAt: now(),
      line: null,
      model: null,
      transcript: "",
      usage: emptyUsage(),
      usageMessages: 0,
      usageBeforeTurnComplete: 0,
      usageAfterTurnComplete: 0,
      firstAudioAt: null,
      turnCompleteAt: null,
      closedAt: null,
      error: null,
    };
    sessions.push(s);
    const cb = args.callbacks || {};
    const callbacks = {
      ...cb,
      onmessage: (msg) => {
        try {
          observeRenderMessage(s, msg, now);
        } catch {
          /* an observer must never break the render */
        }
        return cb.onmessage?.(msg);
      },
      onerror: (e) => {
        s.error = e?.message || String(e);
        return cb.onerror?.(e);
      },
      onclose: (e) => {
        if (s.closedAt === null) s.closedAt = now();
        return cb.onclose?.(e);
      },
    };
    const connected = await connect({ ...args, callbacks });
    s.model = connected?.model ?? null;
    const session = connected?.session;
    if (!session) return connected;
    return {
      ...connected,
      session: {
        sendClientContent(msg) {
          const text = msg?.turns?.[0]?.parts?.[0]?.text;
          const m = typeof text === "string" ? text.match(/^Say exactly: "([\s\S]*)"$/) : null;
          s.line = m ? m[1] : typeof text === "string" ? text : null;
          return session.sendClientContent(msg);
        },
        close() {
          return session.close?.();
        },
      },
    };
  }
  return { connect: tapped, sessions: () => sessions.map((x) => ({ ...x, usage: { ...x.usage } })) };
}

const round3 = (n) => (Number.isFinite(n) ? Number(n.toFixed(3)) : n);

/**
 * One row per render session: which line it was, and the measurements the
 * paid runs must record (Task 14 carry: word_ratio, overlap, render time,
 * usage before turnComplete).
 *
 * @param {object[]} sessions - createRenderTap().sessions()
 * @param {{opener?: string, voicemail?: string}} lines
 * @param {object[]} events - what the renderer logged ({event, kind, outcome, ...})
 */
export function summarizeRenderSessions(sessions, lines = {}, events = []) {
  return sessions.map((s) => {
    const kind = Object.keys(lines).find((k) => lines[k] === s.line) ?? null;
    const usageEvent = events.find((e) => e.event === "outbound_render_usage" && e.kind === kind);
    const hasLine = typeof s.line === "string" && s.line.length > 0;
    return {
      kind,
      chars: hasLine ? s.line.length : null,
      model: s.model,
      outcome: usageEvent?.outcome ?? (s.error ? "error" : null),
      overlap: hasLine ? round3(wordOverlap(s.line, s.transcript)) : null,
      word_ratio: hasLine ? round3(wordRatio(s.line, s.transcript)) : null,
      render_ms: s.turnCompleteAt !== null ? s.turnCompleteAt - s.startedAt : null,
      first_audio_ms: s.firstAudioAt !== null ? s.firstAudioAt - s.startedAt : null,
      transcript: s.transcript,
      usage: s.usage,
      usage_before_turn_complete: s.turnCompleteAt === null ? null : s.usageBeforeTurnComplete > 0,
      usage_messages_after_turn_complete: s.usageAfterTurnComplete,
      error: s.error,
    };
  });
}
