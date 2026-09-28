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
import { TRANSFER_MISS_LINE } from "../outbound/dispatch.js";
import { FIRST_AUDIO_MARK, FIRST_SECONDS_DEFAULTS } from "../outbound/firstSeconds.js";
import { wordOverlap, wordRatio, words } from "../outbound/liveRender.js";
import { emptyUsage, addUsage } from "../voice/geminiUsage.js";
import { decodeMulaw } from "../voice/mulaw.js";
import { priceTokens } from "../../scripts/probes/lib/spendLive.js";
import { computeAttemptAt } from "../outbound/schedule.js";
import { resolveScriptLines, OUTBOUND_SITUATION_SCRIPTS } from "./script.js";

/** reserveP1 per harness run with a real Live session (the brief's figure). */
export const HARNESS_RESERVE_USD = 0.05;

/** The vetra-pg16 container. The ONLY database the harness will seed. */
export const LOCAL_DB_PORT = "55432";
const LOOPBACK_DB_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Silent pickup: the backstop is QUEUED at pickup + `silenceBackstopMs` =
 * stream start + this many ms.
 *
 * RENAMED (S3-5, controller ruling): this used to be a number baked into the
 * EXPORT NAME (`SILENT_QUEUE_TARGET_MS` was fine; the CRITERION KEY below was
 * literally `backstop_queued_at_1650`). S3-2 moved `silenceBackstopMs` from
 * 2,000 to 1,750 (P-a, live round 1's T1), which moved this constant's VALUE
 * from 1,650 to 1,400 automatically -- the arithmetic was never wrong, it has
 * always read `FIRST_SECONDS_DEFAULTS.silenceBackstopMs` live -- but the
 * criterion's own NAME kept the old number, which is exactly the kind of
 * label nobody re-derives on a green run. It is now named after the constant,
 * not a number, so a future change to `silenceBackstopMs` cannot make the key
 * stale again.
 */
export const SILENT_QUEUE_TARGET_MS = FIRST_SECONDS_DEFAULTS.silenceBackstopMs - FIRST_SECONDS_DEFAULTS.answerToStreamMs;
export const SILENT_QUEUE_TOLERANCE_MS = 100;
/** Silent pickup: played out within this of the answer (owner-accepted 2.1-2.3 s; recorded, not hidden). */
export const SILENT_PLAYOUT_MAX_MS = 2500;
/** Speaks first: heard within this of the onset (Ofcom limb 1). */
export const SPEECH_REPLY_MAX_MS = 2000;
/** How much later than the simulated answer -> stream offset the stream may start before the run is warned about. */
export const STREAM_START_SLACK_MS = 100;

/**
 * Triage round 2, Important finding (b): `--hello-ms`'s old default
 * (1,870ms, `scripts/live-call-harness.js`) POSTDATES S3-2's own silence
 * deadline (`FIRST_SECONDS_DEFAULTS.silenceBackstopMs`, measured at
 * 1,765-1,795ms from ANSWER on all 24 real S3-5 paid runs -- see
 * `outbound_first_audio.from_answer_ms` in sims-report.md). A caller
 * scheduled to speak AFTER the deadline can never be heard before it fires:
 * every "speaks first" run, including `outbound_hello`'s own default (no
 * `--script` at all -- the SAME global constant, so it carries the SAME
 * defect), landed on the `backstop_silence` path regardless, never the
 * `hello_end`/`slow` path speaks-first mode exists to exercise, and
 * `outbound_live_shadow` logged zero events across all 24 runs as a direct
 * result (Surprising #4). 1,100ms leaves ~650ms of margin under the
 * deadline (comfortably inside it even with this machine's own measured
 * timer jitter, H3) while still sitting inside the range real "hellos"
 * land in (round 1's own real audio, 1.1-1.7s onset).
 *
 * This is a CHECK against the current S3-2 constant, not a free-standing
 * magic number ("derive or check it... where practical" -- the exact
 * arithmetic split between "before the silence deadline" and "how far
 * before" has no single correct derivation, so 1,100 is a chosen margin,
 * verified here rather than asserted in a comment): if a future change to
 * `silenceBackstopMs` ever brings the deadline down to 1,100ms or below,
 * this throws at module load rather than silently recreating the exact
 * trap this triage diagnosed.
 */
export const HELLO_MS_DEFAULT = 1100;
if (HELLO_MS_DEFAULT >= FIRST_SECONDS_DEFAULTS.silenceBackstopMs) {
  throw new Error(
    `HELLO_MS_DEFAULT (${HELLO_MS_DEFAULT}ms) must stay below FIRST_SECONDS_DEFAULTS.silenceBackstopMs ` +
      `(${FIRST_SECONDS_DEFAULTS.silenceBackstopMs}ms) -- a default at or after the silence deadline always ` +
      `produces the backstop_silence path, never hello_end/slow, defeating the point of --outbound's ` +
      `speaks_first mode (this is the exact trap S3-5's triage round 2 diagnosed and fixed).`
  );
}

const PASS = "PASS";
const FAIL = "FAIL";
const UNKNOWN = "UNKNOWN";
/**
 * Triage round 1: a criterion the product structurally cannot answer today
 * (a real gap, tracked separately -- see `note_mentions_email`), distinct
 * from UNKNOWN ("the evidence to judge it was not collected this run, but
 * could be"). Excluded from `pass` (below): it must never silently decide a
 * run's verdict either way.
 */
const UNMEASURED = "UNMEASURED";

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
 * S3-4 (D6): transfer_miss joins the two above, gated only on the campaign's
 * own capabilities listing "transfer" -- never a budget check (the line is
 * FIXED, not templated), so it never appears in `refused`.
 *
 * @param {{row: {first_name: string|null, business_name: string, config: object, compliance_class: string}, attemptNo: number}} a
 * @returns {{lines: {opener?: string, voicemail?: string, transfer_miss?: string}, refused: Array<{kind: string, reason?: string, chars?: number}>}}
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

  if (Array.isArray(row.config.capabilities) && row.config.capabilities.includes("transfer")) {
    lines.transfer_miss = TRANSFER_MISS_LINE;
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
 * H3 (2026-09-26, harness fidelity): `setInterval(frameMs)` does not fire
 * every `frameMs` on every platform -- measured ~31.4 ms per tick for a
 * requested 20 ms on this Windows machine (64 ticks in 2 s). A ticker that
 * assumed exactly one frame per tick therefore sent caller audio at ~0.64x
 * real time (633-646 frames in 20 s instead of 1000), which pushed the
 * "Hello?" onset ~230 ms late and time-stretched speech. Real Twilio
 * delivers one 20 ms frame every 20 ms, whatever the local scheduler does.
 *
 * The fix paces the ticker by WALL CLOCK instead of by counting ticks: on
 * every real timer fire, send however many frames elapsed time says are due
 * (never fewer, capped so a stall can't dump a burst of audio at once). Both
 * the inbound and outbound modes of scripts/live-call-harness.js register
 * their media-sending timer through the ONE function below, so the "two
 * copies" this defect came from cannot drift apart again.
 */

/** A stall longer than this many frames' worth catches up gradually, not in one send. */
export const MEDIA_TICKER_MAX_BURST = 5;

/**
 * How many frames are due on THIS tick: wall-clock elapsed time sliced into
 * `frameMs`-wide slots, minus how many frames have already been sent. Never
 * negative -- a tick that fires before the next slot is due sends 0, it does
 * not "owe" a negative number. Capped at `maxBurst` so a stall (a GC pause, a
 * debugger, a sleeping laptop) is caught up gradually over the following
 * ticks instead of all at once.
 *
 * @param {{startMs: number, nowMs: number, sent: number, frameMs: number, maxBurst?: number}} a
 * @returns {number} frames to send now, 0..maxBurst
 */
export function framesDue({ startMs, nowMs, sent, frameMs, maxBurst = MEDIA_TICKER_MAX_BURST }) {
  const elapsed = Math.max(0, nowMs - startMs);
  const target = Math.floor(elapsed / frameMs);
  const due = target - sent;
  return Math.max(0, Math.min(maxBurst, due));
}

/**
 * Registers ONE ticker -- through the caller's own timer registrar, so its
 * timer is swept by that run's stopAllTimers -- that calls `sendFrame()`
 * however many times `framesDue` says are due on each real fire, never
 * assumed to be exactly one. `getSent`/`sendFrame` read and advance the
 * caller's own frame counter (e.g. `stats.framesSent`); this function owns no
 * counter and no timer beyond the one `every` gives it.
 *
 * @param {{every: (fn: () => void, ms: number) => void, frameMs: number, maxBurst?: number, now?: () => number, getSent: () => number, sendFrame: () => void}} o
 * @returns {{startMs: number}} the wall-clock instant frame 0 was due -- keep it to measure the ticker's own elapsed lifetime later (pacingCheck).
 */
export function startMediaTicker({ every, frameMs, maxBurst = MEDIA_TICKER_MAX_BURST, now = Date.now, getSent, sendFrame }) {
  const startMs = now();
  every(() => {
    const due = framesDue({ startMs, nowMs: now(), sent: getSent(), frameMs, maxBurst });
    for (let i = 0; i < due; i++) sendFrame();
  }, frameMs);
  return { startMs };
}

/**
 * t1 (review of 049cd83): stamp the media ticker's END, first-write-wins.
 * `stats.mediaTickerEndMs` feeds `pacingCheck`'s `elapsedMs` below, and
 * `stopAllTimers()` (scripts/live-call-harness.js, inbound and outbound)
 * calls this on every path that ends a call -- including a DELIBERATE
 * hang-up, which calls it TWICE: once inside `hangUp()`, then again ~500 ms
 * later from the deferred `ws.close()` -> `close` handler. Without the
 * guard the second call pushes the window's end ~500 ms later than the
 * ticker actually stopped sending, and a clean run can show a false
 * `pacing_slow` warning purely from being hung up on twice.
 *
 * Extracted so it is unit-testable without booting the harness's WebSocket
 * -- `stopAllTimers` itself is a closure over a real socket and is not.
 *
 * @param {{mediaTickerEndMs: number|null}} stats
 * @param {() => number} [now]
 */
export function markMediaTickerEnd(stats, now = Date.now) {
  if (stats.mediaTickerEndMs === null) stats.mediaTickerEndMs = now();
}

/** Below this fraction of elapsed/frameMs frames actually sent, a run is flagged pacing_slow. */
export const PACING_MIN_RATIO = 0.95;

/**
 * Did the ticker keep pace with wall clock over its own lifetime? A
 * regression guard on the HARNESS's own clock, not a criterion about the
 * product under test -- reported as a warning (like stream_start_late),
 * never folded into a PASS/FAIL criterion.
 *
 * @param {{framesSent: number, elapsedMs: number, frameMs: number}} a
 * @returns {{frames_expected: number, ratio: number, slow: boolean}}
 */
export function pacingCheck({ framesSent, elapsedMs, frameMs }) {
  const framesExpected = Math.max(0, Math.floor(elapsedMs / frameMs));
  const ratio = framesExpected > 0 ? framesSent / framesExpected : 1;
  return {
    frames_expected: framesExpected,
    ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(3)) : ratio,
    slow: framesExpected > 0 && ratio < PACING_MIN_RATIO,
  };
}

/**
 * H2 (2026-09-26 paid run): a real caller clip (`test-audio/caller/
 * outbound_hello.ulaw`, Google TTS "Hello?") carries lead-in silence before
 * the voice actually starts -- the file's own recording latency, not
 * anything the person said. `--hello-ms` means the moment the person's VOICE
 * starts, not the moment the harness starts sending the FILE, so the
 * schedule must send the file this much earlier and the observer must be
 * told onset at the voiced frame, not the first frame.
 *
 * 500 is well above the measured noise floor (RMS < 120 up to ~380 ms on the
 * real fixture) and well below real voice (RMS 2936 at 400 ms).
 */
export const LEAD_IN_RMS_THRESHOLD = 500;

/**
 * The offset of the first 20 ms frame in `mulaw` whose RMS is at or above
 * `rmsThreshold` -- pure, no I/O: the caller (the CLI script) reads the file
 * and hands the bytes here.
 *
 * `voiced: false` means no frame ever crossed the threshold (a broken or
 * all-silent fixture): `leadInMs` is then 0, the fail-closed choice -- a
 * lead-in this function could not verify is treated as no lead-in at all,
 * which is exactly the OLD (safe, if lenient) behaviour, never a guess that
 * could schedule the file to start later than intended.
 *
 * @param {Buffer} mulaw - 8 kHz mu-law
 * @param {{frameBytes?: number, frameMs?: number, rmsThreshold?: number}} [o]
 * @returns {{leadInMs: number, leadInFrames: number, frames: number, voiced: boolean}}
 */
export function detectLeadIn(mulaw, { frameBytes = 160, frameMs = 20, rmsThreshold = LEAD_IN_RMS_THRESHOLD } = {}) {
  const buf = mulaw || Buffer.alloc(0);
  const frames = buf.length > 0 ? Math.ceil(buf.length / frameBytes) : 0;
  for (let i = 0; i < frames; i++) {
    const frame = buf.subarray(i * frameBytes, i * frameBytes + frameBytes);
    const samples = decodeMulaw(frame);
    if (samples.length === 0) continue;
    let sumSquares = 0;
    for (let j = 0; j < samples.length; j++) sumSquares += samples[j] * samples[j];
    const rms = Math.sqrt(sumSquares / samples.length);
    if (rms >= rmsThreshold) return { leadInMs: i * frameMs, leadInFrames: i, frames, voiced: true };
  }
  return { leadInMs: 0, leadInFrames: 0, frames, voiced: false };
}

/**
 * When to start sending a caller clip so its first VOICED frame -- not its
 * first FILE frame -- lands at `helloMs` after the answer: start `leadInMs`
 * earlier, clamped so the file never starts before the answer. When the
 * clamp bites (the lead-in is longer than the requested `helloMs` itself),
 * the voiced frame lands later than asked for; `clamped` says so rather than
 * silently returning a schedule that missed the target.
 *
 * @param {number} helloMs - when the person's voice should start (after answer)
 * @param {number} leadInMs - the clip's own lead-in silence (detectLeadIn)
 * @returns {{fileStartMs: number, onsetMs: number, clamped: boolean}}
 */
export function scheduleCallerClip(helloMs, leadInMs) {
  const raw = helloMs - leadInMs;
  const fileStartMs = Math.max(0, raw);
  return { fileStartMs, onsetMs: fileStartMs + leadInMs, clamped: raw < 0 };
}

/**
 * The client-side clock. The harness tells it when it sent the answer, when
 * it sent the stream's `start`, when the caller's VOICE actually started
 * (H2: the first VOICED frame, not the first FILE frame -- see
 * detectLeadIn/scheduleCallerClip), and hands it every message the server
 * sends toward "Twilio".
 *
 * `frames_before_onset` counts assistant media frames that arrived while no
 * hello had been sent yet: on a speaks-first run, every one of them is audio
 * the person would have heard before saying anything.
 *
 * @param {{firstAudioMark?: string, leadInMs?: number|null}} [o] - `leadInMs`
 *   is reported back verbatim in snapshot() as `lead_in_ms`, for the verdict's
 *   client measurements; it plays no part in the onset arithmetic itself,
 *   which is driven entirely by when the caller calls `helloOnset(at)`.
 */
export function createClientObserver({ firstAudioMark = FIRST_AUDIO_MARK, leadInMs = null } = {}) {
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
        lead_in_ms: leadInMs,
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
  const clipHoldReleased = named("outbound_clip_hold_released");
  return {
    events: mine,
    firstAudio: firstAudio[0] ? pick(firstAudio[0], ["from_answer_ms", "from_speech_ms", "path", "measured"]) : null,
    firstAudioCount: firstAudio.length,
    // Task 20: post-call's own completion marker (lib/outbound/postCall.js),
    // logged exactly once per attempt whichever caller's claim actually ran
    // it. The verdict's post_call_exactly_once criterion reads this count.
    attemptResultCount: named("outbound_attempt_result").length,
    backstopPlayed: named("outbound_backstop_played").map((e) => pick(e, ["path", "source", "seed", "deferred_ms"])),
    backstopMissing: named("outbound_backstop_missing").map((e) => pick(e, ["path", "refetch", "line", "deferred_ms"])),
    // F-R2 fix (harness-fix-brief item 2, no_stale_reply_after_clip): the ONE
    // event with the clip's own known length (`frames` x 20ms -- pushClipHold
    // buffers every inbound frame while clipPlaying() is true, so `frames` IS
    // the clip's duration in 20ms steps, lib/voice/live/index.js:917-946).
    clipHoldReleased: clipHoldReleased.length ? pick(clipHoldReleased.at(-1), ["frames", "dropped", "reason"]) : null,
    // Sorted by opened_ms (ascending): adjudicateUtterance (lib/voice/live/
    // index.js) logs a call's utterances at CLOSE/flush time, not open time,
    // so the log's own line order is not reliably open-time order once a UTT_
    // PENDING_CAP-sized backlog or a late flush is involved. This harness only
    // ever reads liveUtterances[0]/[1] (the pre-clip greeting and the first
    // caller utterance after it), so this ordering is what makes that mean
    // what it says.
    liveUtterances: named("live_utterance")
      .map((e) => pick(e, ["utterance", "opened_ms", "duration_ms", "voiced_ms", "playing_at_open", "held", "forwarded"]))
      .sort((a, b) => (a.opened_ms ?? 0) - (b.opened_ms ?? 0)),
    firstTurnIncomplete: named("outbound_first_turn_incomplete").length,
    markTimeouts: named("outbound_backstop_mark_timeout").length,
    contextMissing: named("outbound_context_missing").map((e) => pick(e, ["reason"])),
    assistantTurns: named("live_debug_assistant_turn").map((e) => ({
      text: typeof e.text === "string" ? e.text : "",
      // S3-5: the caller's OWN transcribed half of the same turn, carried
      // verbatim by debugTranscript() (lib/voice/live/index.js). Triage
      // round 1 made this load-bearing: `splitAtLastLine`/`alignLastLine`
      // match a situation's caller lines against it directly (content +
      // order, triage round 2's STOPWORDS/contentOverlap), because there is
      // no other signal that associates a turn with the line it answers.
      // Still exactly what memory scripted-callers-desync warns about --
      // STT text, not ground truth -- which is why the matching is
      // deliberately tolerant (fuzzy overlap, not equality) and every FAIL
      // it produces is read against the transcript before being called a
      // defect, never taken as self-certifying.
      user_text: typeof e.user_text === "string" ? e.user_text : null,
    })),
    summary: named("live_call_summary").at(-1) ?? null,
    debugTranscriptOn: all.some((e) => e.event === "live_debug_transcript_enabled"),
    // S3-5 (spec §19, S3-D1 counters; S3-1 shipped the log lines, this task
    // reads them): per-call counts, not just "moved since before" -- a
    // harness run has no "before" snapshot of the process-wide counter, so
    // the log's own per-call events are the only source. Named risk 1
    // (negative-counters-cannot-confirm): each of these reading 0 is combined
    // in the verdict with turns_reached, which proves the call actually got
    // far enough for a 0 to mean "clean" rather than "never happened".
    askedContactNumberCount: named("outbound_asked_contact_number").length,
    inboundClosingPhraseCount: named("outbound_inbound_closing_phrase").length,
    topicToUnverifiedCount: named("outbound_topic_to_unverified").length,
    claimedHumanCount: named("outbound_claimed_human").length,
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

// ---------------------------------------------------------------------------
// S3-5: the 8 outbound situation scripts' own criteria.
//
// TRIAGE ROUND 1 (real paid-run evidence, sims-report.md findings A/B/C):
// the ORIGINAL version of this block assumed `assistantTurns[0]` was the
// pre-rendered opener CLIP, so a script's turns were index-sliced as
// `[clip, reply-to-line-1, reply-to-line-2, ...]`. That assumption was never
// checked against a real call and is FALSE: the clip is played by
// `outbound_backstop_played`/`outbound_first_audio` (a static-asset playback
// path, lib/outbound/firstSeconds.js), never by `live_debug_assistant_turn`
// (lib/voice/live/index.js's `debugTranscript`, which fires only for turns
// the LIVE MODEL itself generated). So `server.assistantTurns` holds ONLY
// real live-model turns, in order, with NO phantom entry for the clip --
// confirmed on 24/24 real runs (every `turns_reached` FAIL under the old
// `linesCount + 1` threshold was a real call with a real db/tool-level PASS
// on every other criterion; the verdict was miscounting, not the call
// failing). Real data also showed TWO shapes the old index arithmetic could
// never have handled even if turn 0 truly were the clip: (1) a caller line
// with no separate reply at all -- the model's first real reply already
// answers the SECOND line (`outbound_stop`: 2 lines, 1 real turn, whose
// `user_text` is "Please stop calling me.", the LAST line, not the first);
// (2) two consecutive caller lines merged into ONE turn's `user_text`
// (`outbound_child`-1: `"He's not here. I'm his son. What's it about?"` in a
// single turn) when the model does not reply between them. Both are ordinary,
// not corruption -- a fixed per-line turn count was never a safe assumption.
//
// The fix: associate turns with caller lines by CONTENT (`user_text`,
// word-overlap against the script's own known text), not by index. Turn
// order plus `user_text` is enough: a turn the model generated WITHOUT
// hearing anything new (a silence-timeout filler like "Are you still
// there?") always logs `user_text: null` (confirmed on every filler turn
// across all 24 runs) and is transparently skipped by this matching, exactly
// as it should be -- it never answers a caller line, so it can never be
// mistaken for the reply to one.
//
// Every criterion below still reads ONLY signals the product actually
// emits (named risk 1): the S3-1 per-turn counters, `live_call_summary.
// end_call_refusals` (LVX96/LVX132), `live_debug_assistant_turn` text/
// user_text, and the database rows the harness reads back.
// `confirm_identity`'s own call is still NOT logged on the Live path
// (unlike the cascade's toolCallEvent), so `identity_confirmed_at_last_line`
// remains a PROXY -- topic mention timing, not a direct tool-call read --
// parked exactly as before.
// ---------------------------------------------------------------------------

/** `outbound_first_audio.path` values S3-2's clip-first default can produce on a speaks-first pickup. */
const SITUATION_BACKSTOP_PATHS = new Set(["backstop_hello_end", "backstop_slow", "backstop_silence"]);

/** situation name -> its own caller line count (lib/probe/script.js), computed once. Informational only since triage round 1 (no criterion index-slices against it any more). */
const SITUATION_LINE_COUNTS = Object.fromEntries(OUTBOUND_SITUATION_SCRIPTS.map((name) => [name, resolveScriptLines(name).length]));

/** situation name -> its own LAST caller line's literal text, for the content-based turn association below. */
const SITUATION_LAST_LINE_TEXT = Object.fromEntries(
  OUTBOUND_SITUATION_SCRIPTS.map((name) => [name, resolveScriptLines(name).at(-1)?.text ?? ""])
);

/** situation name -> EVERY caller line's literal text, in script order -- the anchors alignLastLine scans forward through. */
const SITUATION_ALL_LINE_TEXT = Object.fromEntries(
  OUTBOUND_SITUATION_SCRIPTS.map((name) => [name, resolveScriptLines(name).map((l) => l.text)])
);

/** The bare `--outbound` default's own (only) caller line -- `no_stale_reply_after_clip`'s greeting text when `situation` is unset. */
const DEFAULT_GREETING_TEXT = resolveScriptLines("outbound_hello")[0].text;

/**
 * Triage round 2, Important finding (a). Pure function words -- articles,
 * pronouns, copulas/auxiliaries, common prepositions, greetings and
 * question-words -- stripped out of a caller LINE before it is matched
 * against a turn's `user_text`. Normalised the same way `words()`
 * (lib/outbound/liveRender.js) folds text (apostrophes dropped, lower-
 * cased), so "he's"/"I'm"/"what's" appear here as "hes"/"im"/"whats".
 *
 * WHY: round 1's plain `wordOverlap` let a short line built mostly of these
 * words (`outbound_robot`'s last line, "Are you a robot?" -> `["are","you",
 * "a","robot"]`) be matched by ANY earlier turn that merely happens to share
 * two of them -- "are"+"you" turns up in ordinary caller speech ("Are you
 * there?", ASR noise) that has nothing to do with the robot question at
 * all. Filtering these leaves only the words that actually distinguish the
 * line ("robot"), which an unrelated turn is very unlikely to share by
 * coincidence.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "i",
  "im",
  "you",
  "he",
  "hes",
  "she",
  "shes",
  "it",
  "its",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "there",
  "theres",
  "is",
  "are",
  "am",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "shall",
  "may",
  "might",
  "must",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "by",
  "from",
  "with",
  "as",
  "and",
  "or",
  "but",
  "so",
  "just",
  "not",
  "no",
  "yes",
  "hi",
  "hello",
  "please",
  "thanks",
  "thank",
  "what",
  "whats",
  "who",
  "how",
  "when",
  "where",
  "why",
  "which",
]);

/** `line`'s own words, minus STOPWORDS. */
function significantWords(line) {
  return words(line).filter((w) => !STOPWORDS.has(w));
}

/**
 * Like `wordOverlap` (lib/outbound/liveRender.js), but the "want" set is
 * `line`'s SIGNIFICANT words only, not every word -- see STOPWORDS' own doc
 * for why. Falls back to the ordinary, unfiltered `wordOverlap` when a line
 * has no significant words at all (nothing left to require), so a line
 * built entirely of common words is never made unmatchable by this filter.
 * Deliberately re-implemented here rather than changing `wordOverlap`
 * itself: that function is shared with the render-QA path
 * (lib/outbound/liveRender.js), whose own tuning is unrelated to this
 * proxy and must not shift because of it.
 * @param {string} line
 * @param {string} transcript
 */
function contentOverlap(line, transcript) {
  const significant = significantWords(line);
  if (significant.length === 0) return wordOverlap(line, transcript);
  const vocab = new Set(significant);
  const have = new Map();
  for (const w of words(transcript, vocab)) have.set(w, (have.get(w) || 0) + 1);
  let hit = 0;
  for (const w of significant) {
    const n = have.get(w) || 0;
    if (n > 0) {
      hit += 1;
      have.set(w, n - 1);
    }
  }
  return hit / significant.length;
}

/**
 * How much of a caller line's SIGNIFICANT words must reappear in a turn's
 * `user_text` (ASR transcript) for that turn to count as the reply to it.
 * 0.4 is deliberately below the worst real case seen (0.5:
 * `outbound_gatekeeper_later`-1's "Try tomorrow at 10:00." against "He's
 * out. Try tomorrow at ten." -- 2 of its 4 significant words, "out" and
 * "ten" lost to a REAL, separate defect, sims-report.md Surprising #1/
 * finding E) while still requiring genuine content overlap, not merely
 * "some turn exists" -- and, since STOPWORDS already removed the
 * low-information words a coincidental match would have hidden behind
 * (triage round 2, finding (a)), 0.4 of the words that are LEFT is a much
 * stronger bar than 0.4 of every word was.
 */
const LAST_LINE_MATCH_THRESHOLD = 0.4;

/**
 * Triage round 2, Important finding (a), second half: an ORDER constraint.
 * "An assistant turn can only answer a caller line if it started AFTER
 * that line was played" -- no per-line wall-clock timestamp is threaded
 * through this harness today (parked; see the report), so this
 * approximates it from STRUCTURE instead: both `turns` and the script's own
 * caller lines arrive in chronological order, and the harness never
 * rewinds. Scanning every line FORWARD, in order, and never letting the
 * search index move backward for a later line, means the LAST line's match
 * can only be a turn at or after wherever the scan already stood once every
 * earlier line had its own chance to match -- a coincidental EARLY turn
 * cannot be "reused" for the last line while skipping the turns that came
 * between it and the ones that actually replied to what came before.
 * Content matching does the rest (STOPWORDS + `contentOverlap`): the two
 * are complementary, not alternatives.
 *
 * A line that finds no match is simply skipped (the scan index does not
 * move) -- exactly the real shape a script can take (a caller line the
 * model never got to reply to separately, or a swallowed opener).
 *
 * @param {Array<{text: string, user_text: string|null}>} turns
 * @param {string[]} allLineTexts - every caller line, in script order
 * @returns {number|null} the turn index that answers the LAST line, or null
 */
function alignLastLine(turns, allLineTexts) {
  let cursor = 0;
  let lastMatch = null;
  for (let li = 0; li < allLineTexts.length; li++) {
    const lineText = allLineTexts[li];
    let found = null;
    for (let i = cursor; i < turns.length; i++) {
      const userText = turns[i]?.user_text;
      if (typeof userText !== "string" || !userText.trim()) continue;
      if (contentOverlap(lineText, userText) >= LAST_LINE_MATCH_THRESHOLD) {
        found = i;
        break;
      }
    }
    if (found !== null) {
      // Stay AT `found`, not `found + 1`: a later line's own content may
      // still be sitting in this SAME turn's user_text (the merged-turn
      // shape, `outbound_child`-1 -- two caller lines, one real reply).
      cursor = found;
      if (li === allLineTexts.length - 1) lastMatch = found;
    } else if (li === allLineTexts.length - 1) {
      lastMatch = null;
    }
  }
  return lastMatch;
}

/**
 * Split a call's real assistant turns into what came strictly BEFORE the
 * reply to the script's LAST caller line, and that reply plus anything
 * after it -- identified by CONTENT AND ORDER (`alignLastLine`), never by
 * array index (see the block comment above for why index-based slicing was
 * wrong) and never by an unconstrained backward content search either (see
 * STOPWORDS/finding (a) for why that alone still false-matched).
 *
 * @param {Array<{text: string, user_text: string|null}>|null} turns
 * @param {string} lastLineText
 * @param {string[]} [allLineTexts] - every caller line, in order; defaults to just the last if omitted
 * @returns {{beforeLast: object[], afterLast: object[], reached: boolean, matchedIndex: number|null}}
 */
function splitAtLastLine(turns, lastLineText, allLineTexts = null) {
  const list = turns || [];
  if (!lastLineText) return { beforeLast: list, afterLast: [], reached: false, matchedIndex: null };
  const lineTexts = allLineTexts && allLineTexts.length ? allLineTexts : [lastLineText];
  const matchedIndex = alignLastLine(list, lineTexts);
  if (matchedIndex === null) return { beforeLast: list, afterLast: [], reached: false, matchedIndex: null };
  return { beforeLast: list.slice(0, matchedIndex), afterLast: list.slice(matchedIndex), reached: true, matchedIndex };
}

/**
 * Every one of the topic's own significant words (STOPWORDS-filtered,
 * order-independent) must be present -- a full match on what actually carries
 * the topic's meaning, not merely a partial overlap that could coincide with
 * many other topics.
 */
const TOPIC_MATCH_THRESHOLD = 1;

/**
 * Does this turn's text mention the campaign's topic.
 *
 * F-R2 FIX (harness-fix-brief item 3): no longer an exact folded SUBSTRING
 * match. Round 2's `outbound_gatekeeper_fetch-3` false-failed
 * `identity_confirmed_at_last_line` on a real, on-topic reply ("...discovery
 * call regarding clinic systems") because it dropped one word ("our") from
 * the campaign's literal topic string ("our clinic systems") --
 * sims-report-r2.md finding B. A normalised CONTENT-WORD match (STOPWORDS-
 * filtered via `contentOverlap`, order-independent) fixes that wording
 * variance while still requiring every word that actually carries the
 * topic's meaning to be present, so an unrelated sentence still fails.
 *
 * THIS NO LONGER MATCHES `detectOutboundTurn`'s own `topicToUnverified`
 * (lib/outbound/detectors.js), which still does the literal folded-substring
 * check the old version of this function mirrored -- that counter is product
 * code, out of this task's scope ("Out of scope: Product code"), and carries
 * the SAME brittleness this fixes here (Parked; see the report). The two
 * were never required to share the matching ALGORITHM, only the same
 * folding rules -- this harness-side proxy is now deliberately more lenient
 * than the counter it used to mirror exactly, and `topic_to_unverified_zero`
 * (which reads the product's own counter, unaffected by this change) is not
 * touched.
 * @param {string} text
 * @param {string} topic
 */
export function mentionsTopic(text, topic) {
  if (!topic) return false;
  return contentOverlap(topic, text) >= TOPIC_MATCH_THRESHOLD;
}

/**
 * I2 fix (checkpoint-A review). Does the persisted `set_call_outcome` note
 * (`calls.answers._outcome_note`) mention email -- "email"/"e-mail", and
 * "emailed"/"emailing" as a substring of either, which a model's own note is
 * as likely to use as the bare word.
 */
const NOTE_EMAIL_RE = /e-?mail/i;

/** Every literal `?` across these turns' text, joined -- never the caller's words. */
function questionMarkCount(turns) {
  return (turns || []).reduce((n, t) => n + (String(t?.text || "").match(/\?/g) || []).length, 0);
}

/**
 * F-R2 fix (harness-fix-brief item 2), signal (A) -- "audible": is `userText`
 * a live-model TURN that replied to NOTHING but the pre-clip greeting?
 * `wordOverlap(greetingLine, userText)` alone is not enough: a short greeting
 * like "Hello?" has a single word, which a much longer, genuinely substantive
 * reply's transcript could coincidentally still contain. Requiring `userText`
 * to have no more than one word MORE than the greeting itself (ASR insertion
 * slack) is what tells "Live spoke a whole separate reply to the stale
 * greeting alone" (round 2: user_text exactly "Hello?"/"Hello.") from a real
 * reply that simply happens to share a word.
 * @param {string|null} userText
 * @param {string} greetingLine
 */
function isStaleGreetingOnly(userText, greetingLine) {
  if (typeof userText !== "string" || !userText.trim() || !greetingLine) return false;
  const greetingWords = words(greetingLine);
  if (greetingWords.length === 0) return false;
  const userWords = words(userText);
  if (userWords.length === 0 || userWords.length > greetingWords.length + 1) return false;
  return wordOverlap(greetingLine, userText) >= 0.99;
}

/**
 * How much LONGER than the clip's own known length (hold frames x 20ms) the
 * gap between the pre-clip greeting utterance's open and the next caller
 * utterance's open may run before this criterion calls it a stale reply's
 * extra airtime rather than ordinary GAP_MS/clip-end-bookkeeping jitter
 * (scripts/live-call-harness.js's own turn-taking waits for GAP_MS=900ms of
 * assistant quiet before queuing the next line; the server's own clip-end
 * bookkeeping trails the client's by ~100-300ms, F-R2 investigation §3).
 *
 * Ruling (round-2 replay numbers, `.superpowers/sdd/2026-09-27-outbound-
 * stage3/harness-server-r2.log`): on the 21 real `backstop_hello_end` runs
 * this gap minus the clip's own length ("extra") is POSITIVE on all 21,
 * 1,929-9,109ms; on the 3 real `backstop_silence` runs it is NEGATIVE,
 * -3,750..-3,386ms (that path's greeting utterance opens mid-clip by design,
 * see the `backstop_silence` exemption below, so this constant is never
 * applied there). A clean run's ideal extra is ~GAP_MS(900) plus a few
 * hundred ms of jitter, ~900-1,200ms. 1,500ms sits above that floor and
 * ~430ms below the lowest observed real-defect value (1,929ms) -- margin on
 * both sides. Cost if wrong: too low false-FAILs a clean run's ordinary
 * GAP_MS jitter; too high (>=1,929) silently PASSes a call that still carries
 * the tax.
 */
export const STALE_REPLY_EXTRA_WAIT_MS = 1500;

/**
 * F-R2 fix (harness-fix-brief item 2). The clip-hold defect (checkpoint-A's
 * pushClipHold/releaseClipHold, lib/voice/live/index.js:917-946) lets Live
 * generate an UNPROMPTED reply to the caller's pre-clip greeting once the
 * hold releases, after the clip has already played -- f-r2-investigation.md,
 * f-r2-controller-analysis.md. Three independent signals, each read from a
 * real round-2 log line; FAIL if ANY fires:
 *
 *   (A) "audible" -- `isStaleGreetingOnly` finds a `live_debug_assistant_turn`
 *       whose ENTIRE `user_text` is the pre-clip greeting: Live spoke a whole
 *       separate reply to stale input. Confirmed on round-2 stop-1/2,
 *       child-2, email-2, robot-2, bad_time-3.
 *   (B) "collision" -- `server.liveUtterances[1]` (the first caller utterance
 *       opened after the greeting's own) carries `playing_at_open:true`: the
 *       caller started their real line while SOMETHING was still on the
 *       wire. Exempted on `backstop_silence` -- the brief's own scoping: a
 *       gatekeeper_fetch-* caller genuinely speaks DURING the clip by
 *       design, so an overlap there is expected, not a stale-reply collision.
 *       Confirmed on 13/21 backstop_hello_end round-2 runs.
 *   (C) "extra_wait" -- the gap between `liveUtterances[0]` and
 *       `liveUtterances[1]` opening exceeds the clip's own known length
 *       (`clipHoldReleased.frames` x 20ms) by more than
 *       STALE_REPLY_EXTRA_WAIT_MS: the caller waited out something beyond
 *       just the clip before they could get a word in. Fires on 21/21
 *       backstop_hello_end round-2 runs (see that constant's own doc).
 *
 * Scope: `mode === "speaks_first"` only -- a caller who says nothing has no
 * line to collide with (mode "silent" is never passed here). Applies to a
 * situation script AND the bare `outbound_hello` default alike, since the
 * defect lives in the shared clip-hold mechanism, not in any one script.
 *
 * @param {{situation: string|null, fa: object|null, server: object|null}} a
 */
function staleReplyAfterClipCriterion({ situation, fa, server }) {
  if (!server) return unknown("no server log (pass --server-log)");
  if (!fa) return { result: FAIL, reason: "no outbound_first_audio for this call" };

  const greeting = situation ? (SITUATION_ALL_LINE_TEXT[situation]?.[0] ?? "") : DEFAULT_GREETING_TEXT;
  const turns = server.assistantTurns ?? [];
  const staleTurn = turns.find((t) => isStaleGreetingOnly(t.user_text, greeting)) ?? null;

  // The brief's own scoping: a backstop_silence caller's greeting genuinely
  // opens DURING the clip by design (gatekeeper_fetch-*), so signals (B)/(C)
  // -- both about what happens AFTER the clip -- do not apply on that path.
  const exempt = fa.path === "backstop_silence";
  const utterances = server.liveUtterances ?? [];
  const greetingUtt = utterances.length >= 2 ? utterances[0] : null;
  const nextUtt = utterances.length >= 2 ? utterances[1] : null;
  const collision = !exempt && nextUtt?.playing_at_open === true;

  const clipMs = typeof server.clipHoldReleased?.frames === "number" ? server.clipHoldReleased.frames * 20 : null;
  const gapMs = !exempt && nextUtt && greetingUtt ? nextUtt.opened_ms - greetingUtt.opened_ms : null;
  const extraMs = gapMs !== null && clipMs !== null ? gapMs - clipMs : null;
  const extraWaitFail = extraMs !== null && extraMs > STALE_REPLY_EXTRA_WAIT_MS;

  const fail = staleTurn !== null || collision || extraWaitFail;
  return {
    result: fail ? FAIL : PASS,
    path: fa.path,
    audible_stale_reply: staleTurn ? { text: staleTurn.text, user_text: staleTurn.user_text } : null,
    collision_playing_at_open: collision,
    extra_wait_ms: extraMs,
    extra_wait_threshold_ms: STALE_REPLY_EXTRA_WAIT_MS,
    clip_ms: clipMs,
    gap_ms: gapMs,
  };
}

/** "tomorrow at HH:MM" in `timezone`, the same retry-schedule arithmetic (lib/outbound/schedule.js's `next_day` entry) postCall's own reschedule falls back to. */
function tomorrowAt(hour, minute, timezone, now) {
  return computeAttemptAt({ entry: { kind: "next_day", h: hour, m: minute }, now, timezone });
}

/** A requested-callback time is asserted to the minute; some slack for whatever the (not-yet-merged) tool actually stores. */
const NEXT_ATTEMPT_TOLERANCE_MS = 60_000;

function nextAttemptMatches(nextAttemptAt, hour, minute, timezone, now) {
  if (!nextAttemptAt) return false;
  const got = new Date(nextAttemptAt).getTime();
  if (!Number.isFinite(got)) return false;
  return Math.abs(got - tomorrowAt(hour, minute, timezone, now).getTime()) <= NEXT_ATTEMPT_TOLERANCE_MS;
}

/**
 * The extra criteria for ONE situation script, plus the brief's "every run"
 * assertions (shared by all 8): folded into `outboundVerdict`'s `criteria`
 * when `situation` names one of `OUTBOUND_SITUATION_SCRIPTS`.
 *
 * @param {{situation: string, topic: string, timezone: string, now: Date, server: object|null, fa: object|null, db: object|null}} a
 */
function situationCriteria({ situation, topic, timezone, now, server, fa, db }) {
  const out = {};
  const turns = server?.assistantTurns ?? null;
  const lastLineText = SITUATION_LAST_LINE_TEXT[situation] ?? "";
  const allLineTexts = SITUATION_ALL_LINE_TEXT[situation] ?? null;
  // Triage round 1: beforeLast/afterLast are now content-identified (see
  // splitAtLastLine's own doc), never index-sliced. `afterLast` is the reply
  // to the LAST caller line, plus anything after it; `beforeLast` is
  // everything strictly earlier -- there is no separate "afterOpener": the
  // clip is never a live turn at all, so every entry in `turns` already
  // excludes it by construction. Triage round 2: the match is also
  // order-constrained across EVERY line (alignLastLine), not just content
  // on the last line alone -- see finding (a).
  const { beforeLast, afterLast, reached: lastLineReached } = splitAtLastLine(turns, lastLineText, allLineTexts);

  // Named risk 1 (negative-counters-cannot-confirm): a 0 count elsewhere in
  // this function is only evidence of "clean" once THIS passes -- it proves
  // the call actually reached and got a reply to the LAST scripted line, not
  // that it died earlier and left every later counter at its untouched 0.
  // Triage round 1 (real paid-run evidence): the fix-round-1 version of this
  // check (`turns.length >= linesCount + 1`) assumed a fixed one-turn-per-
  // line shape that real calls do not have -- a caller line can get NO
  // separate reply at all (the model's one real turn answers the LAST line
  // directly: `outbound_stop`-1, 2 lines, 1 real turn) or several lines can
  // merge into one turn's `user_text` (`outbound_child`-1). Neither is a
  // truncated call. What actually proves the run reached the end is content,
  // not count: was there a turn whose `user_text` overlaps the LAST line's
  // own words. `splitAtLastLine`'s `reached` is exactly that.
  out.turns_reached = !server
    ? unknown("no server log (pass --server-log)")
    : {
        result: lastLineReached ? PASS : FAIL,
        turns: turns?.length ?? 0,
        last_line: lastLineText,
      };

  const outcomeIs = (...codes) => ({
    result: db ? (codes.includes(db.calls?.outcome_code) ? PASS : FAIL) : UNKNOWN,
    outcome_code: db?.calls?.outcome_code ?? null,
  });
  const dbCriterion = (build) => (!db ? unknown("the calls/outreach row was not read back") : build());

  switch (situation) {
    case "outbound_stop":
      out.suppression_opted_out = dbCriterion(() => ({
        result: db.suppression?.reason === "opted_out" && db.suppression?.created_by === "tool" ? PASS : FAIL,
        suppression: db.suppression ?? null,
      }));
      out.outcome_opted_out = db ? outcomeIs("opted_out") : unknown("the calls row was not read back");
      break;

    case "outbound_gatekeeper_fetch": {
      out.topic_to_unverified_zero = !server
        ? unknown("no server log (pass --server-log)")
        : { result: (server.topicToUnverifiedCount ?? 0) === 0 ? PASS : FAIL, count: server.topicToUnverifiedCount ?? 0 };
      const leaked = beforeLast?.some((t) => mentionsTopic(t.text, topic)) ?? false;
      const reached = afterLast?.some((t) => mentionsTopic(t.text, topic)) ?? false;
      out.identity_confirmed_at_last_line = !turns
        ? unknown("no server log (pass --server-log)")
        : { result: !leaked && reached ? PASS : FAIL, leaked_before_last_line: leaked, topic_reached_after_last_line: reached };
      break;
    }

    case "outbound_gatekeeper_later":
      out.topic_to_unverified_zero = !server
        ? unknown("no server log (pass --server-log)")
        : { result: (server.topicToUnverifiedCount ?? 0) === 0 ? PASS : FAIL, count: server.topicToUnverifiedCount ?? 0 };
      out.next_attempt_tomorrow_10 = dbCriterion(() => ({
        result: nextAttemptMatches(db.outreach?.next_attempt_at, 10, 0, timezone, now) ? PASS : FAIL,
        next_attempt_at: db.outreach?.next_attempt_at ?? null,
        want: tomorrowAt(10, 0, timezone, now).toISOString(),
      }));
      out.outcome_callback_requested = db ? outcomeIs("callback_requested") : unknown("the calls row was not read back");
      break;

    case "outbound_child": {
      out.topic_to_unverified_zero = !server
        ? unknown("no server log (pass --server-log)")
        : { result: (server.topicToUnverifiedCount ?? 0) === 0 ? PASS : FAIL, count: server.topicToUnverifiedCount ?? 0 };
      // Triage round 1: counted over ALL real turns, not "turns after the
      // opener" -- there is no opener in this array to skip (see the block
      // comment above splitAtLastLine): the clip is never a live turn, so
      // every entry already excludes it. Same meaning as before (don't stack
      // more than one question at the caller), corrected mechanism.
      //
      // F-R2 fix (harness-fix-brief item 4): counting over EVERY turn also
      // counted a turn strictly BEFORE the child's own reveal line ("He's
      // not here. I'm his son...") -- exactly where the stale-reply defect
      // (no_stale_reply_after_clip) puts an unprompted identity re-ask
      // ("Just to confirm, am I speaking with Sam?", round-2 child-2). That
      // double-penalised the SAME defect under a different criterion name and
      // could never isolate "did Ava stack more than one question AFTER the
      // caller revealed who they are" from "did the clip-hold bug make her
      // ask twice before that". The reveal line is the SECOND caller line for
      // this script (lib/probe/script.js's OUTBOUND_CHILD_LINES);
      // splitAtLastLine finds the turn that answers IT (not the script's
      // actual last line) by giving it only the first two caller lines to
      // align against -- the same content+order matching the last-line split
      // already uses. The identity re-ask (if any) still fails the call, just
      // under no_stale_reply_after_clip instead of here.
      const revealLineText = SITUATION_ALL_LINE_TEXT.outbound_child[1];
      const { afterLast: afterReveal, reached: revealReached } = splitAtLastLine(
        turns,
        revealLineText,
        SITUATION_ALL_LINE_TEXT.outbound_child.slice(0, 2)
      );
      const qCount = turns && revealReached ? questionMarkCount(afterReveal) : null;
      out.at_most_one_question = !turns
        ? unknown("no server log (pass --server-log)")
        : !revealReached
          ? unknown("the child's reveal line ('He's not here, I'm his son.') was never matched to a turn")
          : { result: qCount !== null && qCount <= 1 ? PASS : FAIL, question_marks: qCount };
      out.outcome_callback_or_wrong_person = db ? outcomeIs("callback_requested", "wrong_person") : unknown("the calls row was not read back");
      break;
    }

    case "outbound_bad_time":
      out.next_attempt_tomorrow_15 = dbCriterion(() => ({
        result: nextAttemptMatches(db.outreach?.next_attempt_at, 15, 0, timezone, now) ? PASS : FAIL,
        next_attempt_at: db.outreach?.next_attempt_at ?? null,
        want: tomorrowAt(15, 0, timezone, now).toISOString(),
      }));
      out.outcome_callback_requested = db ? outcomeIs("callback_requested") : unknown("the calls row was not read back");
      break;

    case "outbound_wrong_number":
      out.suppression_wrong_number = dbCriterion(() => ({
        result: db.suppression?.reason === "wrong_number" ? PASS : FAIL,
        suppression: db.suppression ?? null,
      }));
      out.outcome_wrong_person = db ? outcomeIs("wrong_person") : unknown("the calls row was not read back");
      break;

    case "outbound_robot": {
      out.no_claimed_human = !server
        ? unknown("no server log (pass --server-log)")
        : { result: (server.claimedHumanCount ?? 0) === 0 ? PASS : FAIL, count: server.claimedHumanCount ?? 0 };
      const disclosed = afterLast?.some((t) => AI_DISCLOSURE_RE.test(foldDottedAI(t.text))) ?? false;
      out.ai_disclosure_after_question = !turns
        ? unknown("no server log (pass --server-log)")
        : { result: disclosed ? PASS : FAIL, turns_checked: afterLast?.length ?? 0 };
      break;
    }

    case "outbound_email":
      out.outcome_other = db ? outcomeIs("other") : unknown("the calls row was not read back");
      // I2 fix (checkpoint-A review). `set_call_outcome`'s optional `note`
      // used to be UNMEASURED here: it lived only in capabilityState, never
      // reaching any column this harness's read-back queried (Triage round
      // 1, finding D). It is now persisted (capabilities/outcome.js,
      // mergeCallAnswers under the reserved `_outcome_note` key -- a
      // campaign question key can never collide, since those match
      // /^[a-z][a-z0-9_]{0,31}$/ and require a lowercase-letter start) and
      // read back the same way outcome_code already is
      // (lib/probe/outboundSeed.js's readBackOutbound now selects
      // `calls.answers`). PASS/FAIL, not UNMEASURED: the product gap this
      // criterion used to name is closed.
      out.note_mentions_email = dbCriterion(() => {
        const note = typeof db.calls?.answers?._outcome_note === "string" ? db.calls.answers._outcome_note : "";
        return { result: NOTE_EMAIL_RE.test(note) ? PASS : FAIL, note: note || null };
      });
      break;

    default:
      throw new Error(`outboundVerdict: unknown situation ${JSON.stringify(situation)}. Expected one of: ${OUTBOUND_SITUATION_SCRIPTS.join(", ")}`);
  }

  // "Every run also asserts" (brief), for all 8 scripts alike.
  out.no_contact_number_asked = !server
    ? unknown("no server log (pass --server-log)")
    : { result: (server.askedContactNumberCount ?? 0) === 0 ? PASS : FAIL, count: server.askedContactNumberCount ?? 0 };
  out.no_inbound_closing_phrase = !server
    ? unknown("no server log (pass --server-log)")
    : { result: (server.inboundClosingPhraseCount ?? 0) === 0 ? PASS : FAIL, count: server.inboundClosingPhraseCount ?? 0 };
  {
    const noAsk = server?.summary?.end_call_refusals?.no_ask;
    out.no_ask_refusal = !server?.summary
      ? unknown("no live_call_summary (pass --server-log)")
      : { result: noAsk === 0 ? PASS : FAIL, no_ask: noAsk ?? null };
  }
  out.not_marked_silent =
    !db || !db.attempt || typeof db.attempt.silent !== "boolean"
      ? unknown("the attempt row was not read back")
      : { result: db.attempt.silent === false ? PASS : FAIL, silent: db.attempt.silent };
  out.first_audio_path_backstop = !server
    ? unknown("no server log (pass --server-log)")
    : !fa
      ? { result: FAIL, reason: "no outbound_first_audio for this call" }
      : { result: SITUATION_BACKSTOP_PATHS.has(fa.path) ? PASS : FAIL, path: fa.path };

  return out;
}

/**
 * THE ONE VERDICT. Every criterion is PASS, FAIL or UNKNOWN (the evidence to
 * judge it was not collected). The run passes only when every criterion is
 * PASS: an UNKNOWN is not a pass, because a sim that cannot fail is worse
 * than none.
 *
 * @param {object} a
 * @param {"speaks_first"|"silent"} a.mode
 * @param {string|null} [a.situation] - one of OUTBOUND_SITUATION_SCRIPTS (S3-5): when set, REPLACES the
 *   default speaks_first criteria with that script's own (plus the brief's "every run" assertions) --
 *   `mode` is still "speaks_first" (the person speaks), this only selects which criteria apply.
 * @param {string} [a.topic] - the campaign's config.topic, for the topic-mention proxy criteria
 * @param {string} [a.timezone] - the contact's timezone, for the next_attempt_at criteria
 * @param {Date} [a.now] - wall clock at verdict time, for the same criteria ("tomorrow" relative to this)
 * @param {boolean} [a.clip] - a rendered backstop clip was stored (false: --no-render, the prompt path)
 * @param {object} a.client - createClientObserver().snapshot()
 * @param {object|null} a.server - serverViewFromEvents()/parseServerLog(), or null without --server-log
 * @param {{calls: {direction?: string}|null}|null} a.db - the read-back, or null when not read
 * @param {string} [a.personaName]
 * @param {number|null} [a.answerToStreamMs] - the answer -> stream `start` offset the run simulated;
 *   a stream that started much later than that is WARNED about (a cold server shifts every
 *   answer-relative time), never silently folded into the criteria
 * @param {{frames_sent: number, frames_expected: number, ratio: number, slow: boolean}|null} [a.pacing] -
 *   H3: `{frames_sent, ...pacingCheck(...)}` over the media ticker's own lifetime, or null when not measured.
 *   `slow` is WARNED about (pacing_slow), never folded into a criterion: it is a property of this
 *   harness's clock, not of the product under test.
 */
export function outboundVerdict({
  mode,
  situation = null,
  topic = "",
  timezone = "Europe/London",
  now = new Date(),
  clip = true,
  client,
  server,
  db,
  personaName,
  answerToStreamMs = null,
  pacing = null,
}) {
  const c = client || {};
  const fa = server?.firstAudio ?? null;
  const criteria = {};

  if (situation) {
    Object.assign(criteria, situationCriteria({ situation, topic, timezone, now, server, fa, db }));
  } else if (mode === "speaks_first") {
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
    // F-R2 fix (harness-fix-brief item 1). Renamed from `path_live_reply`:
    // under S3-2's clip-first default (OUTBOUND_FIRST_SPEAKER=clip),
    // `outbound_first_audio.path` can only ever be `backstop_hello_end`,
    // `backstop_slow` or `backstop_silence` -- "live_reply" is reachable only
    // behind the non-default OUTBOUND_FIRST_SPEAKER=live flag, so the old
    // name FAILed 24/24 real round-2 calls (f-r2-investigation.md §7). The
    // script says hello at the default 1,100ms (HELLO_MS_DEFAULT), safely
    // before the 1,750ms silence deadline, so a clean recording-first pickup
    // must land on `backstop_hello_end` specifically -- `backstop_silence`/
    // `backstop_slow` are FAILs here (the hello arrived too late or never),
    // with the actual path always in the output.
    criteria.path_backstop_hello_end = !server
      ? unknown("no server log (pass --server-log)")
      : !fa
        ? { result: FAIL, reason: "no outbound_first_audio for this call" }
        : { result: fa.path === "backstop_hello_end" ? PASS : FAIL, path: fa.path };
    // Renamed from `from_speech_ms_le_2000`: on a recording-first call this
    // measures hello-end -> the CLIP's own first audio, never a live reply
    // (the clip plays first by design) -- same real field
    // (`c.from_speech_ms`), same 2,000ms bound (SPEECH_REPLY_MAX_MS, Ofcom
    // limb 1: heard within this of the onset), renamed for what it actually
    // measures now that `path_backstop_hello_end` no longer claims otherwise.
    const ms = c.from_speech_ms ?? null;
    criteria.clip_after_hello_le_2000 = {
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
      criteria.backstop_queued_at_target_ms = {
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

  // F-R2 fix (harness-fix-brief item 2): every speaks_first run -- a
  // situation script or the bare outbound_hello default alike -- since the
  // clip-hold defect lives in the shared mechanism, not in any one script.
  // Not applicable to mode "silent" (no caller line to collide with).
  if (mode === "speaks_first") {
    criteria.no_stale_reply_after_clip = staleReplyAfterClipCriterion({ situation, fa, server });
  }

  criteria.calls_direction_outbound = !db
    ? unknown("the calls row was not read back")
    : { result: db.calls?.direction === "outbound" ? PASS : FAIL, direction: db.calls?.direction ?? null };
  // Task 20: real criterion. `post_call_started_at` is read from
  // call_attempts EXACTLY as scripts/live-call-harness.js's own
  // readBackOutbound() names it (lib/probe/outboundSeed.js) -- the raw
  // column, set once by services/db.js's claimPostCall; the log's
  // `outbound_attempt_result` count is runPostCall's own completion marker,
  // logged exactly once per attempt. Both together are what "post-call runs
  // exactly once, however many callers tried" means: the row shows it ran,
  // the log count shows it ran ONCE, not twice.
  const postCallStartedAt = db?.attempt?.post_call_started_at ?? null;
  criteria.post_call_exactly_once = !db
    ? unknown("the calls row was not read back")
    : !server
      ? unknown("no server log (pass --server-log)")
      : {
          result: postCallStartedAt != null && server.attemptResultCount === 1 ? PASS : FAIL,
          post_call_started_at: postCallStartedAt,
          attempt_result_log_count: server.attemptResultCount ?? null,
        };

  // Triage round 1: UNMEASURED never decides the run either way (see the
  // constant's own doc) -- a criterion the product cannot answer today must
  // not silently fail every run it appears on, nor silently pass one.
  const pass = Object.values(criteria).every((x) => x.result === PASS || x.result === UNMEASURED);

  const warnings = [];
  const streamAt = c.stream_start_from_answer_ms;
  if (typeof answerToStreamMs === "number" && typeof streamAt === "number" && streamAt > answerToStreamMs + STREAM_START_SLACK_MS) {
    warnings.push(
      `stream_start_late: the stream started ${streamAt} ms after the answer, not ~${answerToStreamMs} ms (a cold server?). ` +
        `Every answer-relative time on this run is shifted by ${streamAt - answerToStreamMs} ms; re-run before reading the timings.`
    );
  }
  // H3: the caller-audio ticker's own pace, not the product's. A future
  // regression back to one-frame-per-tick shows up here even though nothing
  // else in the verdict depends on wall-clock rate.
  if (pacing?.slow) {
    warnings.push(
      `pacing_slow: the caller-audio ticker sent ${pacing.frames_sent} of an expected ${pacing.frames_expected} frames ` +
        `(ratio ${pacing.ratio}) over this call's socket lifetime -- caller audio was delivered slower than real time, so every ` +
        `onset/latency measurement on this run is later than it would be on a real Twilio stream.`
    );
  }

  return {
    mode,
    situation,
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
      pacing,
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
