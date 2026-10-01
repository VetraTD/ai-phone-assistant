#!/usr/bin/env node
/**
 * Drive a whole call on the speech-to-speech front-end without a phone.
 *
 * Signs the Twilio webhook, POSTs it to /twilio/live-voice, takes the `wss` URL
 * out of the returned TwiML, opens that socket, and either sits silent or
 * SPEAKS A SCRIPT at it, then reports what came back and what moved in the
 * counters.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists at all
 * ---------------------------------------------------------------------------
 *
 * A harness of this shape was built on 2026-09-03 while diagnosing why every
 * deployed call was silent. It found in two minutes what four phone calls could
 * not explain -- and it was never committed. The backlog then described it as
 * an available tool, which is worse than not having it: the next person reads
 * the entry, goes looking, and finds nothing.
 *
 * ---------------------------------------------------------------------------
 * Two modes, and they answer different questions
 * ---------------------------------------------------------------------------
 *
 * SILENT (default). Sends digital silence. `usage.audio_in` comes back 0 and the
 * vendor's own VAD never hears anything, so the model greets -- the greeting is
 * kicked by the server, not by the caller -- and then waits forever. Nothing it
 * reports about turn-taking, endpointing, barge-in or reply latency is evidence
 * about a real call. What it DOES answer, for about a cent: is the deployed
 * route alive end to end, does the greeting arrive, is the audio correctly
 * framed, did anything cut it.
 *
 * SPOKEN (`--script <name>`). Streams pre-synthesised mu-law caller speech, so
 * the vendor VAD does fire and the model actually converses. This can drive a
 * booking, a cancellation, a spelling refusal -- the paths the P0 defects live
 * on -- and assert on the COUNTER DELTA rather than on anything heard.
 *
 * Even in spoken mode, two limits stand and neither is small:
 *
 *   1. Between utterances it sends digital silence. A real line sends room
 *      noise. Endpointing behaviour under silence is not endpointing behaviour
 *      under noise, so turn-taking numbers from here remain indicative only.
 *   2. IT CANNOT HEAR. It receives audio, not text, so it can never assert that
 *      the assistant said the right thing. Every assertion is a counter or a
 *      database row. Read the deployment's `live_debug_assistant_turn` log
 *      before believing a green run.
 *
 * And the standing risk with any scripted caller: it DESYNCS. A prompt change
 * that reorders the questions leaves the caller answering the previous one, and
 * the run still completes and still produces numbers.
 *
 * ---------------------------------------------------------------------------
 * It spends real money
 * ---------------------------------------------------------------------------
 *
 * An accepted socket opens a real Gemini Live session on the deployment's own
 * credentials. Silent mode is roughly a cent. A spoken script runs two to four
 * minutes and costs more like a real call -- and cost on the Live path is
 * QUADRATIC in call length, so a long script is not linearly more expensive.
 * Hence --confirm for a non-loopback target, and hence the estimate printed
 * before anything opens.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   node scripts/live-call-harness.js --synth --script demo_booking
 *   node scripts/live-call-harness.js --base https://host --to +1817... --confirm
 *   node scripts/live-call-harness.js --base https://host --script demo_booking \
 *       --debug-token "$DEBUG_TOKEN" --out run.jsonl --confirm
 *
 *   --base <url>      server base URL (default http://localhost:$PORT)
 *   --to <e164>       the number dialled; this is what resolves the TENANT
 *   --from <e164>     the caller. On staging CALLER_ALLOWLIST decides whether
 *                     it is answered at all
 *   --script <name>   speak a script: demo_booking, demo_cancel, diagnostic,
 *                     representative. Omit for silent mode
 *   --synth           synthesise the script's caller audio and exit
 *   --tts <engine>    google (default) or elevenlabs, for --synth
 *   --caller-voice <v> override the TTS voice
 *   --gap <ms>        silence from the assistant that ends its turn (default 900)
 *   --reply-wait <ms> how long to wait for a reply before moving on (default 12000)
 *   --hold <ms>       silent-mode call length (default 20000)
 *   --debug-token <t> read /api/debug/latency before and after, print the delta
 *   --out <file>      write every received event to a JSONL file
 *   --confirm         required for a non-loopback --base
 *
 *   --hangup-after <label>      hang up once that scripted line's audio has
 *                               finished sending
 *   --hangup-delay-ms <ms>      wait this long after it first (default 0)
 *   --hangup-on-counter <name>  hang up the instant that counter rises above
 *                               its pre-call value. Needs --debug-token
 *   --hangup-arm-after <label>  only START polling that counter after this
 *                               line. /api allows 60 requests a minute, so a
 *                               poll that runs all call gets 429ed
 *   --hangup-poll-ms <ms>       how often to read the counters (default 250)
 *   --hangup-poll-window-ms <ms> how long to keep polling after the arming
 *                               line before giving up (default 12000). The
 *                               budget is 60 reads a minute, total
 *   --expect-counter <name[:n]> repeatable. Exit 1 unless the counter moved by
 *                               at least n (default 1). Needs --debug-token
 *
 * The hangup flags exist because the windows that matter are three seconds wide
 * and a human cannot hit them -- LVX121's write path has never executed, and
 * eleven real calls on 2026-09-12 could not tell old code from new on LVX125 or
 * LVX126. Example, the LVX121 recipe:
 *
 *   node scripts/live-call-harness.js --script demo_booking --to +44... \
 *     --debug-token "$DEBUG_TOKEN" \
 *     --hangup-on-counter consent_agreement_recorded \
 *     --expect-counter recover_booked
 *
 * Both modes:
 *   --dry-run          print the exact requests it WOULD send, and stop: no
 *                      socket, no render, no reserve/commit
 *   --p1-probe <name>  outbound Part 1 spend (scripts/probes/lib/spendLive.js):
 *                      reserveP1(name, 0.05) before, commit({probe, usd}) after,
 *                      usd priced from the server's live_call_summary usage (and
 *                      the render sessions' usage) when --server-log is given,
 *                      otherwise the full 0.05 reserve
 *   --server-log <f>   the server's stdout, redirected to a file: read after the
 *                      call for outbound_* events and live_call_summary
 *
 * ---------------------------------------------------------------------------
 * --outbound: a simulated OUTBOUND call (Task 15). LOCAL ONLY.
 * ---------------------------------------------------------------------------
 *
 * The person's side of a call dispatch placed: it seeds an attempt in the
 * LOCAL database (refused unless DATABASE_URL is localhost:55432), renders the
 * backstop clip exactly as dispatch would (a paid Gemini Live render), then
 * POSTs a signed /twilio/outbound-answer, opens the stream with the TwiML's
 * <Parameter>s, and either says "Hello?" or stays silent -- then reads the
 * call back from Postgres and prints ONE JSON verdict line
 * ({"kind":"outbound_harness_verdict",...}) with a PASS/FAIL per criterion.
 * It cleans up what it seeded.
 *
 *   DATABASE_URL=postgresql://vetra:vetra_local_dev@localhost:55432/vetra \
 *   node scripts/live-call-harness.js --outbound --base http://localhost:3000 \
 *     --server-log server.log --p1-probe P1-HARNESS [--silent]
 *
 *   --outbound         drive /twilio/outbound-answer instead of /twilio/live-voice
 *   --silent           the person says nothing (default: "Hello?" at --hello-ms)
 *   --script <name>    speak a multi-line SITUATION instead of one "Hello?" (S3-5):
 *                      outbound_stop, outbound_gatekeeper_fetch, outbound_gatekeeper_later,
 *                      outbound_child, outbound_bad_time, outbound_wrong_number,
 *                      outbound_robot, outbound_email, and (final wave W1)
 *                      outbound_double_hello, outbound_stop_midclip_hangup,
 *                      outbound_business_greeting (lib/probe/script.js; a line
 *                      with afterPreviousMs is spoken over the clip on a timer,
 *                      hangUpAfterMs hangs up after its line). An INBOUND
 *                      script name (demo_booking, ...) is refused -- LOCAL ONLY, same as
 *                      every other --outbound mode. The first line plays at --hello-ms,
 *                      same as the default single "Hello?"; each later line plays once
 *                      Ava's reply to the one before it has been quiet for --gap
 *                      (default 900 ms), the same turn-taking --script uses inbound.
 *                      Synthesise once: --synth --script <name>
 *   --hello-ms <ms>    when the person says their FIRST line, from the simulated answer
 *                      (default HELLO_MS_DEFAULT -- 1100, lib/probe/outboundHarness.js.
 *                      CHANGED from 1870 (S3-5 triage round 2, Important finding (b)):
 *                      1870 lands AFTER S3-2's own silence deadline (~1750ms, measured on
 *                      all 24 real paid runs), so it always produced backstop_silence,
 *                      never hello_end/slow -- the "owner's measured value" was measured
 *                      on real phone calls before that deadline was tightened, and now
 *                      postdates it on every run). With no --script the audio is the
 *                      outbound_hello script: --synth --script outbound_hello
 *   --answer-to-stream-ms <ms>  when the stream `start` is sent after the answer
 *                      (default 330: spike B measured 319-334 ms on real calls;
 *                      a local server would otherwise start the stream ~90 ms
 *                      after the answer and shift every deadline)
 *   --amd human|unknown  also POST a signed /twilio/outbound-amd at --amd-ms
 *                      (default 3000). Machine verdicts are REFUSED: they make
 *                      the server call Twilio REST on a fake CallSid
 *   --call-sid <sid>   use an existing attempt instead of seeding one
 *   --no-render        skip the render: no clip, so the prompt path runs
 *   --keep-seed        do not delete the seeded rows afterwards
 *   --hold <ms>        call length from the answer (default 20000; a multi-line
 *                      --script needs more room -- see the S3-5 report for the
 *                      recommended value per script)
 */
import "dotenv/config";
import { WebSocket } from "ws";
import { appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolveScriptLines, buildProbeScript, synthesizeCallerAudio, OUTBOUND_SITUATION_SCRIPTS, OUTBOUND_SCRIPT_CONFIG } from "../lib/probe/script.js";
import {
  buildInboundAnswerRequest,
  buildOutboundAnswerRequest,
  buildOutboundStatusRequest,
  buildOutboundAmdRequest,
  parseAmdFlag,
  parseTwiml,
} from "../lib/probe/twilioRequests.js";
import {
  assertLocalDatabase,
  isLoopbackBase,
  dispatchLines,
  createPlayoutClock,
  createClientObserver,
  decodeLogBuffer,
  parseServerLog,
  outboundVerdict,
  inferFirstSpeaker,
  verdictClient,
  priceHarnessRun,
  createSpendGuard,
  pickHarnessNumbers,
  harnessCallSid,
  HARNESS_RESERVE_USD,
  detectLeadIn,
  scheduleCallerClip,
  startMediaTicker,
  markMediaTickerEnd,
  pacingCheck,
  HELLO_MS_DEFAULT,
} from "../lib/probe/outboundHarness.js";
import * as spendLive from "./probes/lib/spendLive.js";
import {
  makeHangupPlan,
  hangupArmed,
  hangupDecision,
  pollArmed,
  counterValue,
  parseExpectation,
  checkExpectations,
} from "../lib/probe/hangup.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
/** Every occurrence of a repeatable flag, in order. `opt` returns only the first. */
const opts = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const die = (msg) => {
  console.error(msg);
  process.exit(2);
};

const PORT = process.env.PORT || 3000;
const BASE = opt("base", `http://localhost:${PORT}`).replace(/\/$/, "");
const TO = opt("to", process.env.ASSISTANT_NUMBER || "+15550000000");
// No environment fallback on purpose. A caller number is a per-run choice, and
// on staging CALLER_ALLOWLIST decides whether it is answered at all -- so it
// belongs on the command line where it is visible, not in a variable somebody
// set months ago. (Adding one would also fail tests/envInventory.test.js, which
// refuses an undocumented variable.)
const FROM = opt("from", "+15551230000");
const SCRIPT_NAME = opt("script", "");
const GAP_MS = Number.parseInt(opt("gap", "900"), 10);
const REPLY_WAIT_MS = Number.parseInt(opt("reply-wait", "12000"), 10);
const HOLD_MS = Number.parseInt(opt("hold", "20000"), 10);
/**
 * Hard ceiling on a scripted call, and it is a COST control as much as a
 * safety one -- spend on this path is quadratic in call length, so a run that
 * overruns is not linearly more expensive.
 *
 * It was 81 s of arithmetic derived from the script length, and that was the
 * wrong shape: the first spoken run was cut off after four of eight lines,
 * before it ever reached the booking, because the assistant's turns run five to
 * twenty seconds each and the estimate assumed six. A number the operator can
 * see and set beats a formula that is quietly wrong.
 */
const MAX_CALL_MS = Number.parseInt(opt("max-call-ms", "180000"), 10);
const OUT = opt("out", "");
const DEBUG_TOKEN = opt("debug-token", "");

/**
 * HANGING UP ON PURPOSE, on a boundary a human cannot hit.
 *
 * LVX121's write path has never executed because the window it needs -- a
 * recorded agreement with no row yet -- was measured at 2.7 seconds on a clean
 * call. Eleven real calls on 2026-09-12 also failed to discriminate old code
 * from new on LVX125 and LVX126, for the same reason.
 *
 * The decision itself lives in lib/probe/hangup.js so it can be tested without
 * spending a call on it; everything here is the timers and the socket.
 */
const HANGUP_AFTER = opt("hangup-after", "");
const HANGUP_ARM_AFTER = opt("hangup-arm-after", "");
const HANGUP_ON_COUNTER = opt("hangup-on-counter", "");
const HANGUP_DELAY_MS = Number.parseInt(opt("hangup-delay-ms", "0"), 10);
const HANGUP_POLL_MS = Number.parseInt(opt("hangup-poll-ms", "250"), 10);
const HANGUP_POLL_WINDOW_MS = Number.parseInt(opt("hangup-poll-window-ms", "12000"), 10);
const hangupPlan = makeHangupPlan({
  afterLabel: HANGUP_AFTER,
  onCounter: HANGUP_ON_COUNTER,
  delayMs: HANGUP_DELAY_MS,
  armAfterLabel: HANGUP_ARM_AFTER,
  pollWindowMs: HANGUP_POLL_WINDOW_MS,
});
/** Repeatable. Each one turns a printed number into a pass/fail exit code. */
let EXPECTATIONS = [];
try {
  EXPECTATIONS = opts("expect-counter").map(parseExpectation);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const AUTH_TOKEN = opt("auth-token", process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN_ALT || "");

// Both modes (Task 15).
const DRY_RUN = flag("dry-run");
const SERVER_LOG = opt("server-log", "");
const P1_PROBE = opt("p1-probe", "");
// --outbound only.
const OUTBOUND = flag("outbound");
const OUTBOUND_SILENT = flag("silent");
const HELLO_MS = Number.parseInt(opt("hello-ms", String(HELLO_MS_DEFAULT)), 10);
/**
 * When Twilio's stream `start` arrives after the answer. Spike B measured
 * 319-334 ms on real calls, and the product's silence deadline assumes it
 * (FIRST_SECONDS_DEFAULTS.answerToStreamMs, rounded up to 350). A local
 * server answers and upgrades in ~90 ms, which would put a hello at
 * answer + 1,870 ms AFTER the stream + 1,650 deadline -- a failure of the
 * simulation, not of the product. So `start` is held until this offset.
 */
const ANSWER_TO_STREAM_MS = Number.parseInt(opt("answer-to-stream-ms", "330"), 10);
const AMD_MS = Number.parseInt(opt("amd-ms", "3000"), 10);
const CALL_SID_ARG = opt("call-sid", "");
const NO_RENDER = flag("no-render");
const KEEP_SEED = flag("keep-seed");
/** The AccountSid the webhooks carry, exactly as the inbound mode has always sent it. */
const HARNESS_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACharness0000000000000000000000000";

/** 160 bytes of 0xFF is exactly one 20 ms Twilio frame of mu-law SILENCE. */
const SILENT_FRAME_BYTES = Buffer.alloc(160, 0xff);
const FRAME_BYTES = 160;
const FRAME_MS = 20;

// ---------------------------------------------------------------------------
// --synth: make the caller audio, spend nothing else, exit.
// ---------------------------------------------------------------------------
if (flag("synth")) {
  if (!SCRIPT_NAME) die("--synth needs --script <name>.");
  const lines = resolveScriptLines(SCRIPT_NAME);
  // Either engine works, and both are a DIFFERENT voice from the assistant's,
  // which is what keeps self-echo out of anything measured. Google emits 8 kHz
  // mu-law natively; the ElevenLabs path exists because Google credentials are
  // not always present.
  let synthesizeMulaw;
  let voiceName;
  if (opt("tts", "google") === "elevenlabs") {
    const { synthesizeMulawOnce } = await import("../services/elevenlabs.js");
    if (!process.env.ELEVENLABS_API_KEY) die("ELEVENLABS_API_KEY is not set.");
    voiceName = opt("caller-voice", "onwK4e9ZLuTAKqWW03F9");
    synthesizeMulaw = (text, voiceId) => synthesizeMulawOnce({ voiceId, text });
  } else {
    const google = await import("../services/googleTts.js");
    if (!google.isConfigured()) {
      die(
        "Google TTS is not configured. Set GOOGLE_APPLICATION_CREDENTIALS or " +
          "GOOGLE_TTS_API_KEY, or pass --tts elevenlabs."
      );
    }
    synthesizeMulaw = google.synthesizeMulaw;
    voiceName = opt("caller-voice", "en-US-Chirp3-HD-Charon");
  }
  const { written, skipped } = await synthesizeCallerAudio({ synthesizeMulaw, voiceName, force: flag("force"), lines });
  console.log(`Caller audio for "${SCRIPT_NAME}": ${written.length} written, ${skipped.length} already cached.`);
  console.log(`${lines.length} lines in test-audio/caller/`);
  process.exit(0);
}

// --p1-probe names a Part 1 ledger entry; reserveP1 refuses anything else, and
// that refusal belongs here, before a request is sent, not after a call.
if (P1_PROBE && !P1_PROBE.startsWith(spendLive.P1_PREFIX)) {
  die(`--p1-probe ${JSON.stringify(P1_PROBE)} must start with "${spendLive.P1_PREFIX}" (e.g. P1-HARNESS).`);
}

/** --outbound's own refusals, all before anything is seeded, rendered or spent. */
let OUTBOUND_AMD = null;
// S3-5: the refusal used to be unconditional ("--script is inbound only").
// It now admits exactly the outbound situation scripts (lib/probe/script.js)
// -- an INBOUND script name (demo_booking, diagnostic, ...) is still refused,
// because those speak a caller answering an inbound call, not a person
// picking up one Ava placed.
const OUTBOUND_SCRIPT_NAMES = new Set([...OUTBOUND_SITUATION_SCRIPTS, "outbound_hello"]);
if (OUTBOUND) {
  if (SCRIPT_NAME && !OUTBOUND_SCRIPT_NAMES.has(SCRIPT_NAME)) {
    die(
      `--outbound --script "${SCRIPT_NAME}" is not an outbound script.\n\n` +
        `Expected one of: ${[...OUTBOUND_SCRIPT_NAMES].join(", ")}.\n` +
        `An inbound script name speaks a caller answering an inbound call, not a\n` +
        `person picking up one Ava placed.`
    );
  }
  if (SCRIPT_NAME && OUTBOUND_SILENT) die(`--outbound --script speaks; --silent is for when nobody does. Pick one.`);
  if (HANGUP_AFTER || HANGUP_ARM_AFTER || HANGUP_ON_COUNTER || EXPECTATIONS.length) {
    die("--hangup-* and --expect-counter are inbound only.");
  }
  if (!isLoopbackBase(BASE)) {
    die(
      `--outbound drives a LOCAL server only (got --base ${BASE}).\n\n` +
        `It seeds the local database and reads the call back from it; a remote server\n` +
        `could see neither. --confirm does not change this.`
    );
  }
  if (!Number.isFinite(HELLO_MS) || HELLO_MS < 0) die(`--hello-ms must be a whole number of ms (got ${opt("hello-ms", "")}).`);
  if (!Number.isFinite(AMD_MS) || AMD_MS < 0) die(`--amd-ms must be a whole number of ms (got ${opt("amd-ms", "")}).`);
  if (!Number.isFinite(ANSWER_TO_STREAM_MS) || ANSWER_TO_STREAM_MS < 0) {
    die(`--answer-to-stream-ms must be a whole number of ms (got ${opt("answer-to-stream-ms", "")}).`);
  }
  try {
    OUTBOUND_AMD = parseAmdFlag(opt("amd", ""));
  } catch (err) {
    die(err.message);
  }
  try {
    assertLocalDatabase(process.env.DATABASE_URL);
  } catch (err) {
    die(`${err.message}\n\nSet DATABASE_URL=postgresql://vetra:vetra_local_dev@localhost:55432/vetra for this command.`);
  }
}

const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
if (!isLoopback && !flag("confirm")) {
  die(
    `Refusing to drive a call against ${BASE} without --confirm.\n\n` +
      `An accepted socket opens a real Gemini Live session on that deployment's\n` +
      `credentials. Silent mode is roughly a cent; a spoken script costs more like\n` +
      `a real call, and cost on this path is QUADRATIC in length. Pass --confirm if\n` +
      `that is what you mean.`
  );
}

if (!AUTH_TOKEN) {
  die(
    `No Twilio auth token to sign with.\n\n` +
      `/twilio/live-voice validates the signature against TWILIO_AUTH_TOKEN or\n` +
      `TWILIO_AUTH_TOKEN_ALT. Set one, or pass --auth-token. The token must belong\n` +
      `to the account that owns ${TO}: there are two accounts here, and a number\n` +
      `signed with the wrong one is a 403 that reads like a dead route.`
  );
}

/**
 * The INBOUND script, as frames. Empty in silent mode, and also skipped
 * under --outbound (S3-5): mainOutbound() builds its own `scriptLines` from
 * the same SCRIPT_NAME, on its own schedule (never before --dry-run's early
 * return), and main() -- the only reader of this one -- never runs on that
 * path (see the dispatch at the foot of this file).
 */
const script = !OUTBOUND && SCRIPT_NAME ? buildProbeScript(resolveScriptLines(SCRIPT_NAME)) : [];

// Validated HERE and not discovered mid-call, for the reason resolveScriptLines
// throws on an unknown script name rather than quietly running the default: a
// run that cost model tokens and answered nothing is worse than one that never
// started.
if (HANGUP_AFTER) {
  if (!SCRIPT_NAME) die("--hangup-after names a scripted line, so it needs --script <name>.");
  if (!script.some((l) => l.label === HANGUP_AFTER)) {
    die(
      `--hangup-after "${HANGUP_AFTER}" is not a line in the "${SCRIPT_NAME}" script.\n` +
        `Labels in this script: ${script.map((l) => l.label).join(", ")}`
    );
  }
}
if (HANGUP_ARM_AFTER) {
  if (!SCRIPT_NAME) die("--hangup-arm-after names a scripted line, so it needs --script <name>.");
  if (!script.some((l) => l.label === HANGUP_ARM_AFTER)) {
    die(
      `--hangup-arm-after "${HANGUP_ARM_AFTER}" is not a line in the "${SCRIPT_NAME}" script.\n` +
        `Labels in this script: ${script.map((l) => l.label).join(", ")}`
    );
  }
  if (!HANGUP_ON_COUNTER) die("--hangup-arm-after only arms the counter poll, so it needs --hangup-on-counter.");
}
if ((HANGUP_ON_COUNTER || EXPECTATIONS.length) && !DEBUG_TOKEN) {
  die(
    `--hangup-on-counter and --expect-counter both read /api/debug/latency, so they\n` +
      `need --debug-token. Without it the counters are the one thing this harness\n` +
      `cannot see, and it would hang up on a signal it never received.`
  );
}

const callSid = `CA${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
const streamSid = `MZ${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
/** Inbound --p1-probe: set when the socket opens -- from then a Live session may be billing. */
let inboundSocketOpened = false;

if (OUT) writeFileSync(OUT, "");
const record = (obj) => {
  if (OUT) appendFileSync(OUT, `${JSON.stringify(obj)}\n`);
};

/** Read the counters, or null if no token was given / the read failed. */
let counterReadFailure = null;
async function readCounters() {
  if (!DEBUG_TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/api/debug/latency`, { headers: { "x-debug-token": DEBUG_TOKEN } });
    if (!res.ok) {
      // WHY IT RECORDS WHY IT FAILED. This used to return null for every
      // failure and the report guessed "did not answer with that token". On
      // 2026-09-12 that guess was wrong twice, and each wrong guess cost a
      // call: the first run really was a bad token (a trailing CR off a CRLF
      // .env), the second was 429 because /api allows 60 requests a minute and
      // the counter poll was making 400. Both printed the same sentence.
      counterReadFailure =
        res.status === 429
          ? `HTTP 429 RATE LIMITED. /api allows 60 requests a minute (server.js) and the counter poll exceeded it. Raise --hangup-poll-ms, or arm the poll later with --hangup-arm-after.`
          : res.status === 404
            ? `HTTP 404. This endpoint 404s on a bad or missing token BY DESIGN, so it means DEBUG_ENDPOINTS is not "true", or the token is wrong -- check for a trailing carriage return if it came out of a CRLF .env.`
            : `HTTP ${res.status}`;
      return null;
    }
    const j = await res.json();
    counterReadFailure = null;
    return { bootId: j.bootId, counters: j.turnTaking || {} };
  } catch (err) {
    counterReadFailure = `${err?.cause?.code || err?.message || "request failed"} -- is the server up on ${BASE}?`;
    return null;
  }
}

/**
 * The webhook Twilio would send, signed the way Twilio signs it.
 *
 * The signature covers the EXACT url including scheme and host, so --base has
 * to match what the server believes its own BASE_URL is. A mismatch there is a
 * 403 indistinguishable from a wrong token.
 */
/**
 * The request is built by lib/probe/twilioRequests.js, byte-identical to the
 * inline construction it replaced (tests/outboundHarnessRequests.test.js).
 */
function inboundAnswerRequest() {
  return buildInboundAnswerRequest({
    base: BASE,
    callSid,
    from: FROM,
    to: TO,
    accountSid: HARNESS_ACCOUNT_SID,
    authToken: AUTH_TOKEN,
  });
}

async function answerCall() {
  const req = inboundAnswerRequest();
  const res = await fetch(req.url, req.init);
  return { status: res.status, body: await res.text() };
}

// parseTwiml moved, unchanged, to lib/probe/twilioRequests.js: the free outbound
// test (tests/liveOutboundHarness.test.js) parses the door's TwiML with it.

/** A request as the one printable line --dry-run shows. */
function printRequest(step, req) {
  console.log(JSON.stringify({ step, method: req.init.method, url: req.url, headers: req.init.headers, body: req.init.body }));
}

/**
 * Spend accounting for --p1-probe, in either mode. Reserved before anything
 * can spend; committed once, with a numeric usd, when the run is priced -- or
 * from the exit hook if the process ends first (a crash, a process.exit on a
 * refused webhook): the full reserve if a session could have opened, $0 if
 * none did. commit() is synchronous, which is what makes an exit hook enough.
 *
 * @param {{mode: string, callSid: () => string, sessionMayHaveOpened: () => boolean}} a
 */
function startSpend({ mode, callSid: sidOf, sessionMayHaveOpened }) {
  if (!P1_PROBE) return null;
  const guard = createSpendGuard({ probe: P1_PROBE, spend: spendLive });
  try {
    guard.reserve();
  } catch (err) {
    die(`${err.message}\nNothing was sent and nothing was spent.`);
  }
  console.log(`spend      reserved $${HARNESS_RESERVE_USD.toFixed(2)} under ${P1_PROBE}`);
  process.on("exit", () => {
    if (guard.committed()) return;
    const fallback = sessionMayHaveOpened()
      ? { usd: null, reason: "the run ended before it could be priced" }
      : { usd: 0, basis: "no_session" };
    const entry = guard.commit(fallback, { callSid: sidOf(), mode });
    if (entry) console.log(`spend      committed $${entry.usd.toFixed(4)} (${entry.basis}) under ${P1_PROBE}`);
  });
  return guard;
}

/**
 * The server's log, re-read until this call's live_call_summary is in it (the
 * session writes it at teardown, just after our socket closes), or the wait
 * runs out. null when no --server-log was given.
 */
async function readServerLogFor(sid, { waitMs = 6000 } = {}) {
  if (!SERVER_LOG) return null;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const view = existsSync(SERVER_LOG)
      ? parseServerLog(decodeLogBuffer(readFileSync(SERVER_LOG)), { callSid: sid })
      : null;
    if ((view && view.summary) || Date.now() >= deadline) {
      if (!view) console.error(`server log ${SERVER_LOG} does not exist`);
      else if (!view.summary) console.error(`server log: no live_call_summary for ${sid} after ${waitMs} ms`);
      return view;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  const scriptSeconds = script.reduce((n, l) => n + l.mulaw.length / 8000, 0);
  console.log(`base       ${BASE}`);
  console.log(`to         ${TO}   (resolves the tenant)`);
  console.log(`from       ${FROM}`);
  console.log(`callSid    ${callSid}`);
  if (SCRIPT_NAME) {
    console.log(`script     ${SCRIPT_NAME} — ${script.length} lines, ${scriptSeconds.toFixed(1)} s of caller speech`);
    console.log(`ceiling    ${(MAX_CALL_MS / 1000).toFixed(0)} s (--max-call-ms). It hangs up sooner if the script finishes.`);
    console.log(`estimate   a real call's worth of spend, and cost on this path is QUADRATIC in length`);
  } else {
    console.log(`script     (none) — silent mode, ~1 cent`);
  }
  console.log("");

  // --dry-run (Task 15): the exact request, and nothing else -- no counters,
  // no socket, no reserve.
  if (DRY_RUN) {
    printRequest("answer", inboundAnswerRequest());
    return;
  }

  // --p1-probe (Task 15). A session can only have opened once the socket did.
  const spend = startSpend({ mode: "inbound", callSid: () => callSid, sessionMayHaveOpened: () => inboundSocketOpened });

  const before = await readCounters();

  const t0 = Date.now();
  const { status, body } = await answerCall();
  const webhookMs = Date.now() - t0;
  record({ at: 0, kind: "webhook", status, body });

  if (status !== 200) {
    console.error(`/twilio/live-voice returned ${status} in ${webhookMs} ms\n${body}`);
    if (status === 403) {
      console.error(
        `\n403 means the signature did not verify. Three things produce it and they are\n` +
          `indistinguishable from here: the wrong auth token (there are two accounts), a\n` +
          `--base that does not match the server's own BASE_URL, or a proxy rewriting the\n` +
          `URL. Check BASE_URL on the deployment first.`
      );
    }
    process.exit(1);
  }

  const parsed = parseTwiml(body);
  if (!parsed) {
    console.log(`webhook    200 in ${webhookMs} ms, but NOT a <Connect><Stream>:\n`);
    console.log(body);
    console.log(
      `\nThat is a real answer, not a failure of this script. Either CALLER_ALLOWLIST\n` +
        `refused ${FROM}, or ${TO} resolved to no business and the unrouted voicemail\n` +
        `branch answered. Neither reaches the assistant.`
    );
    process.exit(1);
  }

  console.log(`webhook    200 in ${webhookMs} ms`);
  console.log(`stream     ${parsed.url.replace(/\/[^/]+$/, "/<token>")}`);
  console.log(`params     ${JSON.stringify(parsed.customParameters)}`);
  console.log("");

  const stats = {
    connectMs: null,
    firstMediaMs: null,
    mediaFrames: 0,
    mediaBytes: 0,
    marksReceived: 0,
    marksEchoed: 0,
    clears: 0,
    framesSent: 0,
    speechFramesSent: 0,
    linesSpoken: 0,
    turnsWithNoReply: 0,
    wrongStreamSid: 0,
    closeCode: null,
    closeReason: "",
    // H3: the media ticker's own wall-clock window (startMediaTicker's
    // startMs, and Date.now() when stopAllTimers actually stops it) --
    // the pacing check reads elapsed = mediaTickerEndMs - mediaTickerStartMs,
    // never a later "now" (the DB read-back wait would inflate it).
    mediaTickerStartMs: null,
    mediaTickerEndMs: null,
    // Which side ended the call, and when. Without this a deliberate hangup is
    // indistinguishable in the report from the ceiling cutting the run short,
    // and those two mean opposite things about every counter below.
    hangupReason: null,
    hangupAtMs: null,
  };
  /** @type {{line: string, spokeAtMs: number, replyMs: number|null, replySeconds: number}[]} */
  const turns = [];

  const openedAt = Date.now();
  const ws = new WebSocket(parsed.url);

  /**
   * When the audio we have been handed would finish playing.
   *
   * Twilio holds a buffer and sends `mark` back only once the audio ahead of it
   * has actually reached the caller. Echoing marks IMMEDIATELY would be a lie in
   * the direction that matters: end_call arms on a mark, so an instant echo makes
   * a hang-up look clean that would in reality cut the goodbye off.
   */
  let playoutUntil = 0;
  let markTimers = [];

  /**
   * Every timer this run owns, so a close can stop all of them.
   *
   * Learned the hard way on the first spoken run: the server closed the socket
   * when the model called end_call, and the 20 ms ticker and the hang-up watcher
   * were only ever cleared on the paths where THIS side decided to stop. The
   * call had finished, the event loop had not, and the process sat there past
   * five minutes without printing a word -- including the bootId warning that
   * would have said the counters were void.
   */
  const timers = new Set();
  const every = (fn, ms) => {
    const t = setInterval(fn, ms);
    timers.add(t);
    return t;
  };
  const later = (fn, ms) => {
    const t = setTimeout(fn, ms);
    timers.add(t);
    return t;
  };
  const stopAllTimers = () => {
    // H3: the media ticker stops sending frames HERE (clearInterval, above),
    // not whenever the socket eventually closes a moment later -- this is the
    // instant that ends the ticker's own wall-clock window.
    //
    // t1 (review of 049cd83): first-write-wins (lib/probe/outboundHarness.js's
    // markMediaTickerEnd has the full rationale) -- a deliberate hang-up
    // calls this TWICE, and the second call must not push the window's end
    // later than the ticker actually stopped.
    markMediaTickerEnd(stats);
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    timers.clear();
    for (const t of markTimers) clearTimeout(t);
    markTimers = [];
  };

  /** Assistant audio activity, which is how a turn boundary is detected. */
  let lastAssistantMediaAt = 0;
  let assistantFramesThisTurn = 0;
  /**
   * Did the CEILING end this call, or did the assistant?
   *
   * Not cosmetic. An unfinished script means something different in each case:
   * the ceiling cutting it short makes every counter inconclusive, whereas the
   * assistant calling end_call before the last line means the conversation
   * genuinely finished early and the counters are exactly as good as any other
   * run's. The first version conflated them and cried "CUT SHORT" at a call the
   * model had ended properly.
   */
  let hitCeiling = false;

  /**
   * When the --hangup-after line's audio will have finished sending, or null.
   *
   * The END of the line and not the start: hanging up while the caller's own
   * audio is still streaming means the model never heard the turn, so the
   * agreement ledger records nothing and the recovery declines never_agreed --
   * a stand-down that looks exactly like a broken harness.
   */
  let hangupAfterEndedAt = null;
  /** When the --hangup-arm-after line finished, or null. Gates the poll. */
  let hangupArmEndedAt = null;
  /** The most recent counter read, for the --hangup-on-counter trigger. */
  let liveCounters = null;

  /** Caller audio still to send, as 160-byte frames. */
  let outQueue = [];
  let cursor = 0; // next line index
  let finished = false;

  /**
   * Turn-taking, and it is deliberately crude.
   *
   * "The assistant has stopped for GAP_MS" is the whole rule. It is not what a
   * real caller does and it is not what the endpointer does -- it is just enough
   * to keep a scripted conversation moving without talking over the reply, which
   * would make every counter unreadable.
   */
  function maybeSpeakNext(now) {
    if (finished || outQueue.length > 0 || cursor >= script.length) return;
    const waitedSinceTurnStart = now - (turns.at(-1)?.endedAt ?? openedAt);
    const heardSomething = assistantFramesThisTurn > 0;
    const assistantQuiet = heardSomething && now - lastAssistantMediaAt >= GAP_MS;
    const gaveUp = !heardSomething && waitedSinceTurnStart >= REPLY_WAIT_MS;
    if (!assistantQuiet && !gaveUp) return;

    if (gaveUp) stats.turnsWithNoReply += 1;
    const line = script[cursor];
    cursor += 1;
    for (let i = 0; i < line.mulaw.length; i += FRAME_BYTES) {
      outQueue.push(line.mulaw.subarray(i, i + FRAME_BYTES));
    }
    const replyMs = heardSomething ? turns.at(-1)?.replyMs ?? null : null;
    turns.push({
      line: line.label,
      spokeAtMs: now - openedAt,
      replyMs,
      replySeconds: Number(((assistantFramesThisTurn * FRAME_MS) / 1000).toFixed(1)),
      endedAt: now + (line.mulaw.length / FRAME_BYTES) * FRAME_MS,
    });
    if (HANGUP_AFTER && line.label === HANGUP_AFTER) hangupAfterEndedAt = turns.at(-1).endedAt;
    if (HANGUP_ARM_AFTER && line.label === HANGUP_ARM_AFTER) hangupArmEndedAt = turns.at(-1).endedAt;
    console.log(
      `speak      ${line.label}  (heard ${((assistantFramesThisTurn * FRAME_MS) / 1000).toFixed(1)} s back${gaveUp ? ", NO REPLY" : ""})`
    );
    stats.linesSpoken += 1;
    assistantFramesThisTurn = 0;
  }

  /**
   * Say goodbye once, stop every timer, and let the socket close.
   *
   * The `stop` event is what a real caller hanging up produces, and the server
   * handles it as finish("twilio_stop") -- the same teardown, running the same
   * post-call chain. That is what makes a deliberate hangup evidence about
   * production rather than about this script.
   */
  function hangUp(reason = "script_finished") {
    if (finished) return;
    finished = true;
    stats.hangupReason = reason;
    stats.hangupAtMs = Date.now() - openedAt;
    stopAllTimers();
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: "stop", streamSid, stop: { callSid } }));
      setTimeout(() => ws.close(), 500);
    }
  }

  ws.on("open", () => {
    inboundSocketOpened = true; // --p1-probe: from here a Live session may be billing
    stats.connectMs = Date.now() - openedAt;
    ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    ws.send(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        streamSid,
        start: {
          streamSid,
          accountSid: process.env.TWILIO_ACCOUNT_SID || "ACharness",
          callSid,
          tracks: ["inbound"],
          customParameters: parsed.customParameters,
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        },
      })
    );

    // Turn-taking decision, on its own timer: whether enough quiet has passed
    // to speak the next line depends only on the current wall clock against
    // GAP_MS/REPLY_WAIT_MS, so unlike the media ticker below it does not need
    // to catch up on missed ticks -- it just re-checks "now" a little less
    // often than asked for, same as before H3.
    every(() => {
      maybeSpeakNext(Date.now());
    }, FRAME_MS);

    // ONE ticker (H3), paced by WALL CLOCK, not by counting ticks: a real
    // line always sends a frame every 20 ms, whether or not anybody is
    // talking -- so this draws from the caller queue when there is speech to
    // send and from silence when there is not, rather than starting and
    // stopping. A stream that goes quiet is a different input to the
    // vendor's VAD than a stream carrying silence. `startMediaTicker`
    // (lib/probe/outboundHarness.js) is the SAME helper the outbound mode
    // uses below, so this ticker and that one cannot drift apart again.
    const mediaTicker = startMediaTicker({
      every,
      frameMs: FRAME_MS,
      getSent: () => stats.framesSent,
      sendFrame: () => {
        if (ws.readyState !== ws.OPEN) return;
        const frame = outQueue.shift();
        const payload = frame ? frame : SILENT_FRAME_BYTES;
        if (frame) stats.speechFramesSent += 1;
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: {
              track: "inbound",
              chunk: String(stats.framesSent + 1),
              timestamp: String(stats.framesSent * FRAME_MS),
              payload: payload.toString("base64"),
            },
          })
        );
        stats.framesSent += 1;
      },
    });
    stats.mediaTickerStartMs = mediaTicker.startMs;


    // Silent mode runs for --hold. A script runs until it has said everything
    // and heard the last reply out (the watcher below), with --max-call-ms as
    // the ceiling rather than the plan.
    later(() => {
      hitCeiling = true;
      hangUp("ceiling");
    }, SCRIPT_NAME ? MAX_CALL_MS : HOLD_MS);

    // Poll the counters only when something is waiting on them. Each read is a
    // round trip to the server under test, and on a 150 ms tick that is a lot
    // of them -- worth it only for the one trigger that needs them.
    if (hangupPlan.onCounter) {
      every(async () => {
        if (finished) return;
        // Armed by a scripted line, not running for the whole call: /api
        // allows 60 requests a minute and a 150 ms poll makes 400. The
        // budget went in nine seconds of a hundred-second call, and every
        // later read came back 429. See pollArmed.
        if (!pollArmed(hangupPlan, hangupArmEndedAt, Date.now())) return;
        const c = await readCounters();
        if (c) liveCounters = c;
      }, HANGUP_POLL_MS);
    }

    // A script that finishes early should hang up rather than burn budget: the
    // cost of this path is quadratic in call length.
    every(() => {
      // BEFORE the SCRIPT_NAME guard below, deliberately: a silent-mode run can
      // still use the counter trigger, and that is the cheapest way to ask what
      // the teardown does when the caller never spoke at all.
      if (hangupArmed(hangupPlan) && !finished) {
        const d = hangupDecision({
          plan: hangupPlan,
          now: Date.now(),
          spokenEndedAt: hangupAfterEndedAt,
          counterBefore: before ? counterValue(before.counters, hangupPlan.onCounter) : null,
          counterNow: liveCounters ? counterValue(liveCounters.counters, hangupPlan.onCounter) : null,
          bootIdStable: Boolean(before && liveCounters && before.bootId === liveCounters.bootId),
        });
        if (d.hangUp) {
          console.log(`hangup     ${d.reason} at ${Date.now() - openedAt} ms`);
          hangUp(d.reason);
          return;
        }
      }
      if (!SCRIPT_NAME || finished) return;
      const spokeEverything = cursor >= script.length && outQueue.length === 0;
      const quietFor = Date.now() - lastAssistantMediaAt;
      if (spokeEverything && assistantFramesThisTurn > 0 && quietFor >= GAP_MS * 2) {
        hangUp("script_finished");
      }
    }, 200);
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const at = Date.now() - openedAt;
    if (msg.streamSid && msg.streamSid !== streamSid) stats.wrongStreamSid += 1;

    if (msg.event === "media" && msg.media?.payload) {
      const bytes = Buffer.from(msg.media.payload, "base64").length;
      stats.mediaFrames += 1;
      stats.mediaBytes += bytes;
      lastAssistantMediaAt = Date.now();
      assistantFramesThisTurn += 1;
      if (stats.firstMediaMs === null) {
        stats.firstMediaMs = at;
        console.log(`first audio ${at} ms`);
      }
      playoutUntil = Math.max(playoutUntil, Date.now()) + FRAME_MS;
      record({ at, kind: "media", bytes });
      return;
    }

    if (msg.event === "mark" && msg.mark?.name) {
      stats.marksReceived += 1;
      record({ at, kind: "mark", name: msg.mark.name });
      const delay = Math.max(0, playoutUntil - Date.now());
      markTimers.push(
        setTimeout(() => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: msg.mark.name } }));
          stats.marksEchoed += 1;
        }, delay)
      );
      return;
    }

    if (msg.event === "clear") {
      // Twilio discards its buffer AND the marks queued behind it. A harness
      // that echoed them anyway would hide exactly the case the leak guard
      // exists for.
      stats.clears += 1;
      playoutUntil = Date.now();
      for (const t of markTimers) clearTimeout(t);
      markTimers = [];
      console.log(`clear      at ${at} ms  <- something cut the audio`);
      record({ at, kind: "clear" });
      return;
    }

    record({ at, kind: msg.event || "unknown", msg });
  });

  ws.on("error", (err) => console.error(`websocket error: ${err?.message}`));

  await new Promise((resolve) => {
    ws.on("close", (code, reason) => {
      // The SERVER closing is the normal end of a scripted call -- the model
      // calls end_call and the goodbye plays out. Stopping the timers here and
      // not only on our own hang-up path is what lets the process exit and
      // print, which is the difference between a result and a hang.
      finished = true;
      stopAllTimers();
      stats.closeCode = code;
      stats.closeReason = reason?.toString() || "";
      resolve();
    });
  });

  const after = await readCounters();

  const outMs = stats.mediaFrames * FRAME_MS;
  console.log("");
  console.log(`connect    ${stats.connectMs} ms`);
  console.log(`first audio ${stats.firstMediaMs === null ? "NEVER" : `${stats.firstMediaMs} ms`}`);
  console.log(`audio out  ${stats.mediaFrames} frames, ${stats.mediaBytes} bytes, ~${(outMs / 1000).toFixed(1)} s`);
  console.log(`frames in  ${stats.framesSent} (${stats.speechFramesSent} speech, ${stats.framesSent - stats.speechFramesSent} silence)`);
  if (stats.mediaTickerStartMs !== null && stats.mediaTickerEndMs !== null) {
    const pacing = pacingCheck({
      framesSent: stats.framesSent,
      elapsedMs: stats.mediaTickerEndMs - stats.mediaTickerStartMs,
      frameMs: FRAME_MS,
    });
    console.log(
      `pacing     ${stats.framesSent}/${pacing.frames_expected} frames (ratio ${pacing.ratio})` +
        (pacing.slow ? `  <- PACING_SLOW: caller audio was sent slower than real time` : "")
    );
  }
  const deliberate =
    stats.hangupReason && stats.hangupReason !== "ceiling" && stats.hangupReason !== "script_finished";
  if (SCRIPT_NAME) {
    const unfinished = stats.linesSpoken < script.length;
    const note = !unfinished
      ? ""
      : deliberate
        ? `   <- HUNG UP DELIBERATELY (${stats.hangupReason}): the remaining lines were never meant to be spoken`
        : hitCeiling
          ? `   <- CUT SHORT BY THE CEILING: raise --max-call-ms, and treat every counter below as inconclusive`
          : `   <- the ASSISTANT ended the call first; the counters stand`;
    console.log(
      `lines      ${stats.linesSpoken}/${script.length} spoken, ${stats.turnsWithNoReply} sent with no reply heard${note}`
    );
  }
  if (stats.hangupReason) {
    console.log(`hangup     ${stats.hangupReason} at ${stats.hangupAtMs} ms`);
  }
  console.log(`marks      ${stats.marksReceived} received, ${stats.marksEchoed} echoed`);
  console.log(`clears     ${stats.clears}`);
  console.log(`streamSid  ${stats.wrongStreamSid === 0 ? "echoed correctly" : `WRONG on ${stats.wrongStreamSid} messages`}`);
  console.log(`close      ${stats.closeCode} ${stats.closeReason}`);
  if (OUT) console.log(`events     ${OUT}`);

  if (before && after) {
    console.log("");
    if (before.bootId !== after.bootId) {
      console.log(`COUNTERS UNUSABLE: bootId changed (${before.bootId} -> ${after.bootId}).`);
      console.log(`The process restarted mid-run, which resets every counter to zero.`);
    } else {
      const moved = Object.keys(after.counters)
        .filter((k) => (after.counters[k] || 0) !== (before.counters[k] || 0))
        .sort();
      console.log(`counter delta (bootId ${after.bootId}):`);
      if (!moved.length) console.log(`  (nothing moved)`);
      for (const k of moved) console.log(`  ${k}  ${before.counters[k] || 0} -> ${after.counters[k] || 0}`);
    }
  } else if (DEBUG_TOKEN) {
    console.log(`\ncounter delta unavailable: ${counterReadFailure || "/api/debug/latency did not answer."}`);
  }

  // THE PART THAT MAKES THIS RUN ABLE TO FAIL.
  //
  // Without it the harness prints a report and exits 0 whatever happened, which
  // is a sim that cannot fail -- and a green run that means nothing is worse
  // than no run, because somebody acts on it.
  if (EXPECTATIONS.length) {
    console.log("");
    if (!before || !after || before.bootId !== after.bootId) {
      console.log(`EXPECTATIONS UNCHECKABLE: the counters could not be read, or the server`);
      console.log(`restarted mid-run and every counter reset underneath it.`);
      console.log(`An unverified expectation is not a met one.`);
      process.exitCode = 1;
    } else {
      const r = checkExpectations(EXPECTATIONS, before.counters, after.counters);
      for (const f of r.failures) {
        console.log(`  EXPECTED ${f.name} to move by ${f.min}, moved ${f.moved}`);
      }
      if (r.ok) console.log(`expectations  all ${EXPECTATIONS.length} met`);
      process.exitCode = r.ok ? 0 : 1;
    }
  }

  console.log("");
  if (stats.firstMediaMs === null) {
    console.log(
      `NO AUDIO CAME BACK. The socket opened, so the token and the tenant are fine;\n` +
        `the session did not speak. That is the shape LVX37 produced -- read the\n` +
        `deployment's log for live_debug_leak_text, and diff the deployed environment\n` +
        `against the local .env before building a hypothesis.`
    );
  } else if (!SCRIPT_NAME) {
    console.log(
      `Silent mode: the frames sent were digital silence, so usage.audio_in is 0 and\n` +
        `the vendor VAD never fired. Nothing above is evidence about turn-taking,\n` +
        `barge-in or reply latency on a real call.`
    );
  } else {
    console.log(
      `THIS HARNESS CANNOT HEAR. It receives audio, not text, so nothing above says\n` +
        `the assistant said the right thing -- only what the counters did. Read the\n` +
        `deployment's live_debug_assistant_turn log before believing a green run, and\n` +
        `check whether the caller lines still line up with the questions asked: a\n` +
        `scripted caller desyncs silently after a prompt change.\n` +
        `Between utterances this sends silence, not room noise, so turn-taking numbers\n` +
        `remain indicative rather than measurements.`
    );
  }

  // --p1-probe (Task 15): priced from this call's live_call_summary usage when
  // --server-log is given; the full reserve otherwise.
  if (spend) {
    const view = await readServerLogFor(callSid);
    const priced = priceHarnessRun({ sessionOpened: inboundSocketOpened, callSummary: view?.summary ?? null, renderSessions: [] });
    const entry = spend.commit(priced, { callSid, mode: "inbound" });
    console.log(`\nspend      committed $${entry.usd.toFixed(4)} (${entry.basis}${entry.reason ? `: ${entry.reason}` : ""}) under ${P1_PROBE}`);
  }
}

// ===========================================================================
// --outbound (Task 15): the person's side of a call dispatch placed.
// ===========================================================================

/** POST one signed request; the HTTP status, or the transport error as text. */
async function postSigned(req) {
  try {
    const res = await fetch(req.url, req.init);
    await res.text();
    return res.status;
  } catch (err) {
    return `error: ${err?.cause?.code || err?.message || "request failed"}`;
  }
}

/**
 * The call itself, from the answer POST to the terminal status callback.
 *
 * "The answer" is the moment the answer POST is SENT: that is when Twilio
 * would have seen the pickup, and every client-side time is measured from it.
 *
 * `scriptLines` is the outbound script (lib/probe/script.js, already run
 * through buildProbeScript): one line for the pre-existing default ("Hello?",
 * the outbound_hello script) or several for an S3-5 situation script. Only
 * the FIRST line is scheduled by its own timer (`--hello-ms`, H2's lead-in
 * arithmetic, unchanged from before this task); line 2 onward are queued by
 * `maybeSpeakNext` once Ava's reply to the line before it has gone quiet for
 * `--gap` -- the SAME rule main()'s inbound `--script` mode uses, so the two
 * turn-taking implementations cannot drift apart in what "the model replied"
 * means.
 *
 * @returns {Promise<{observer: ReturnType<typeof createClientObserver>, stats: object}>}
 */
async function runOutboundCall({ seed, common, parties, mode, scriptLines = [], leadIn = { leadInMs: 0, leadInFrames: 0 } }) {
  const observer = createClientObserver({ leadInMs: leadIn.leadInMs });
  const playout = createPlayoutClock({ frameMs: FRAME_MS });
  const stats = {
    answerStatus: null,
    answerHttpMs: null,
    twimlNotStream: null,
    inProgressStatus: null,
    amdStatus: null,
    completedStatus: null,
    socketOpened: false,
    connectMs: null,
    framesSent: 0,
    speechFramesSent: 0,
    marksReceived: 0,
    marksEchoed: 0,
    clears: 0,
    wrongStreamSid: 0,
    hangupReason: null,
    closeCode: null,
    closeReason: "",
    durationSeconds: null,
    // H3: see the matching fields in main()'s stats -- same meaning, same
    // pacingCheck at report time.
    mediaTickerStartMs: null,
    mediaTickerEndMs: null,
    // F-R2 harness-fix round 2 (review Important #2): assistant audio the
    // CLIENT actually received -- not elapsed wall time -- between the
    // pre-clip greeting's own line and the caller's first post-clip
    // (substantive) line. Set once, the first time maybeSpeakNext actually
    // sends line index 1, from the SAME assistantFramesThisTurn counter the
    // console's own "heard X.Xs back" line already prints (so this can never
    // disagree with what the operator sees). Null for a single-line script
    // (mode "speaks_first" with no --script), where there is no second line
    // to wait for.
    heardBeforeFirstPostClipLineMs: null,
  };
  const outboundStreamSid = `MZ${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

  const answeredAt = Date.now();
  observer.answered(answeredAt);
  const answerReq = buildOutboundAnswerRequest({ ...common, ...parties });
  let body = "";
  try {
    const res = await fetch(answerReq.url, answerReq.init);
    stats.answerStatus = res.status;
    body = await res.text();
  } catch (err) {
    stats.answerStatus = `error: ${err?.cause?.code || err?.message}`;
  }
  stats.answerHttpMs = Date.now() - answeredAt;
  console.log(`answer     ${stats.answerStatus} in ${stats.answerHttpMs} ms`);
  const parsed = stats.answerStatus === 200 ? parseTwiml(body) : null;
  if (!parsed) {
    // The door's miss path (a <Say> and a hang-up) is an answer, not a stream.
    stats.twimlNotStream = body || null;
    if (stats.answerStatus === 200) console.log(`answer     NOT a <Connect><Stream>:\n${body}`);
    return { observer, stats };
  }
  console.log(`stream     ${parsed.url.replace(/\/[^/]+$/, "/<token>")}`);
  console.log(`params     ${JSON.stringify(parsed.customParameters)}`);

  // `in-progress` right after the answer, as Twilio sends it -- not awaited
  // before the socket opens, which would delay the stream by a round trip.
  const inProgress = postSigned(buildOutboundStatusRequest({ ...common, ...parties, status: "in-progress" })).then((s) => {
    stats.inProgressStatus = s;
  });
  const amdPosts = [];

  const ws = new WebSocket(parsed.url);
  const timers = new Set();
  let markTimers = [];
  const every = (fn, ms) => {
    const t = setInterval(fn, ms);
    timers.add(t);
  };
  const later = (fn, ms) => {
    const t = setTimeout(fn, Math.max(0, ms));
    timers.add(t);
  };
  const stopAllTimers = () => {
    // H3: same rule as main()'s stopAllTimers -- this is when the media
    // ticker actually stops sending, not whenever the socket later closes.
    // t1: first-write-wins (see main()'s own stopAllTimers doc) -- a
    // deliberate hang-up calls this twice.
    markMediaTickerEnd(stats);
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    timers.clear();
    for (const t of markTimers) clearTimeout(t);
    markTimers = [];
  };
  let outQueue = [];
  let finished = false;

  // S3-5: multi-line turn-taking. Line 0 is scheduled by its own timer
  // below (unchanged); `cursor` starts at 1 so `maybeSpeakNext` only ever
  // sends line 2 onward. For the pre-existing single-line case
  // (scriptLines.length === 1) `cursor >= scriptLines.length` is true from
  // the start, so `maybeSpeakNext` is a permanent no-op and this call's
  // behaviour is byte-identical to before this task.
  let cursor = 1;
  let assistantFramesThisTurn = 0;
  let lastAssistantMediaAt = 0;
  /** @type {{label: string, endedAt: number}[]} */
  const turns = [];
  const multiLine = scriptLines.length > 1;

  /**
   * Queue the next line once Ava's reply to the one before it has been
   * quiet for GAP_MS, or once REPLY_WAIT_MS has passed with no reply heard
   * at all -- the inbound `--script` rule (main()'s own maybeSpeakNext),
   * reused rather than re-derived so the two cannot disagree about what
   * "the model replied" means.
   */
  // Final wave W1: set once the first line sent by ORDINARY turn-taking has
  // gone -- the caller's first post-clip line. A timed line (afterPreviousMs,
  // spoken over the clip by design) is not it.
  let heardBeforeCaptured = false;
  // 2026-10-01 (lib/probe/script.js pauseAfterQuietMs): the caller is away
  // (on hold) -- once Ava has gone quiet, wait this much longer, and count any
  // assistant audio that reaches us meanwhile (the hold must keep it at 0).
  let holdPauseStartedAt = null;
  let holdPauseFrames = 0;

  function maybeSpeakNext(now) {
    if (finished || outQueue.length > 0 || cursor >= scriptLines.length || turns.length === 0) return;
    const nextLine = scriptLines[cursor];
    const waitedSinceTurnStart = now - turns.at(-1).endedAt;
    const heardSomething = assistantFramesThisTurn > 0;
    const timed = typeof nextLine.afterPreviousMs === "number";
    let gaveUp = false;
    if (timed) {
      // Final wave W1 (lib/probe/script.js): sent this long after the
      // previous line ENDED, whatever Ava is doing -- the caller talks over
      // the clip by design.
      if (waitedSinceTurnStart < nextLine.afterPreviousMs) return;
    } else {
      const assistantQuiet = heardSomething && now - lastAssistantMediaAt >= GAP_MS;
      gaveUp = !heardSomething && waitedSinceTurnStart >= REPLY_WAIT_MS;
      if (!assistantQuiet && !gaveUp) return;
      const pauseMs = typeof nextLine.pauseAfterQuietMs === "number" ? nextLine.pauseAfterQuietMs : 0;
      if (pauseMs > 0) {
        if (holdPauseStartedAt === null) {
          holdPauseStartedAt = now;
          holdPauseFrames = 0;
        }
        if (now - holdPauseStartedAt < pauseMs) return;
        stats.holdPause = { ms: now - holdPauseStartedAt, assistantFramesDuring: holdPauseFrames };
        holdPauseStartedAt = null;
      }

      // F-R2 harness-fix round 2: the FIRST line sent by ordinary turn-taking
      // is exactly "the caller's first post-clip line" -- the one place to
      // capture what the console is about to print. (It was `cursor === 1`
      // until the final wave added timed lines, which are never it.)
      if (!heardBeforeCaptured) {
        heardBeforeCaptured = true;
        stats.heardBeforeFirstPostClipLineMs = assistantFramesThisTurn * FRAME_MS;
      }
    }

    cursor += 1;
    for (let i = 0; i < nextLine.mulaw.length; i += FRAME_BYTES) outQueue.push(nextLine.mulaw.subarray(i, i + FRAME_BYTES));
    const lineMs = (nextLine.mulaw.length / FRAME_BYTES) * FRAME_MS;
    turns.push({ label: nextLine.label, endedAt: now + lineMs });
    console.log(
      `speak      ${nextLine.label}  (${timed ? `timed, ${nextLine.afterPreviousMs} ms after the last line` : `heard ${((assistantFramesThisTurn * FRAME_MS) / 1000).toFixed(1)} s back${gaveUp ? ", NO REPLY" : ""}`})`
    );
    if (!timed) assistantFramesThisTurn = 0;
    // Final wave W1: the caller hangs up this long after this line ends.
    if (typeof nextLine.hangUpAfterMs === "number") later(() => hangUp("script_hangup"), lineMs + nextLine.hangUpAfterMs);
  }

  function hangUp(reason) {
    if (finished) return;
    finished = true;
    stats.hangupReason = reason;
    stopAllTimers();
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: "stop", streamSid: outboundStreamSid, stop: { callSid: seed.callSid } }));
      setTimeout(() => ws.close(), 500);
    }
  }

  ws.on("open", () => {
    stats.socketOpened = true;
    stats.connectMs = Date.now() - answeredAt;
    ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    // `start` at answer + --answer-to-stream-ms, as Twilio's arrives (see
    // ANSWER_TO_STREAM_MS). Later than that if the socket itself was slower.
    later(() => startStream(), answeredAt + ANSWER_TO_STREAM_MS - Date.now());
  });

  function startStream() {
    if (finished || ws.readyState !== ws.OPEN) return;
    ws.send(
      JSON.stringify({
        event: "start",
        sequenceNumber: "1",
        streamSid: outboundStreamSid,
        start: {
          streamSid: outboundStreamSid,
          accountSid: common.accountSid,
          callSid: seed.callSid,
          tracks: ["inbound"],
          customParameters: parsed.customParameters,
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        },
      })
    );
    observer.streamStarted(Date.now());

    // The first line's VOICE starts at --hello-ms after the answer, not the
    // FILE (H2): the clip's own lead-in silence (leadIn.leadInMs) is sent
    // earlier, so the voiced frame -- the one at index leadIn.leadInFrames --
    // lands on the ticker below at --hello-ms. True whether the script is
    // one line ("Hello?") or several (an S3-5 situation).
    const { fileStartMs } = scheduleCallerClip(HELLO_MS, leadIn.leadInMs);
    if (mode === "speaks_first" && scriptLines[0]) {
      const firstLine = scriptLines[0];
      const firstFrames = [];
      for (let i = 0; i < firstLine.mulaw.length; i += FRAME_BYTES) firstFrames.push(firstLine.mulaw.subarray(i, i + FRAME_BYTES));
      later(() => {
        outQueue.push(...firstFrames);
        // Baseline for maybeSpeakNext's "quiet since the line before this
        // one ended" -- irrelevant when scriptLines.length === 1 (cursor is
        // already >= scriptLines.length so maybeSpeakNext never reads it).
        turns.push({ label: firstLine.label, endedAt: Date.now() + firstFrames.length * FRAME_MS });
      }, answeredAt + fileStartMs - Date.now());
    }

    // S3-5: line 2 onward, once each of Ava's replies has gone quiet --
    // registered ONLY for a multi-line script, so the pre-existing
    // single-"Hello?" timing is untouched by this task.
    if (multiLine) {
      every(() => maybeSpeakNext(Date.now()), FRAME_MS);
      // A script that finishes early hangs up rather than burn budget on a
      // path that is already known to be spoken out (cost on this path is
      // quadratic in call length, the same reason main()'s inbound mode
      // does this).
      every(() => {
        if (finished) return;
        const spokeEverything = cursor >= scriptLines.length && outQueue.length === 0;
        const quietFor = Date.now() - lastAssistantMediaAt;
        if (spokeEverything && assistantFramesThisTurn > 0 && quietFor >= GAP_MS * 2) hangUp("script_finished");
      }, 200);
    }

    // ONE ticker (H3), as the inbound mode: paced by WALL CLOCK, not by
    // counting ticks -- see startMediaTicker (lib/probe/outboundHarness.js),
    // the SAME helper the inbound mode registers above.
    const mediaTicker = startMediaTicker({
      every,
      frameMs: FRAME_MS,
      getSent: () => stats.framesSent,
      sendFrame: () => {
        if (ws.readyState !== ws.OPEN) return;
        const frame = outQueue.shift();
        if (frame) {
          // Onset is the first VOICED frame (leadIn.leadInFrames-th sent), not
          // simply the first frame of the file -- that first frame may be lead-in
          // silence the clip's own recording carries, not anything the person said.
          if (stats.speechFramesSent === leadIn.leadInFrames) observer.helloOnset(Date.now());
          stats.speechFramesSent += 1;
        }
        ws.send(
          JSON.stringify({
            event: "media",
            streamSid: outboundStreamSid,
            media: {
              track: "inbound",
              chunk: String(stats.framesSent + 1),
              timestamp: String(stats.framesSent * FRAME_MS),
              payload: (frame || SILENT_FRAME_BYTES).toString("base64"),
            },
          })
        );
        stats.framesSent += 1;
      },
    });
    stats.mediaTickerStartMs = mediaTicker.startMs;

    if (OUTBOUND_AMD) {
      later(() => {
        amdPosts.push(
          postSigned(buildOutboundAmdRequest({ ...common, answeredBy: OUTBOUND_AMD, durationMs: AMD_MS })).then((s) => {
            stats.amdStatus = s;
          })
        );
      }, answeredAt + AMD_MS - Date.now());
    }
    later(() => hangUp("hold"), answeredAt + HOLD_MS - Date.now());
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const now = Date.now();
    if (msg.streamSid && msg.streamSid !== outboundStreamSid) stats.wrongStreamSid += 1;
    observer.fromServer(msg, now);
    if (msg.event === "media" && msg.media?.payload) {
      playout.onMedia(now);
      // S3-5: turn-taking bookkeeping only -- unused (and harmless) when
      // scriptLines.length === 1, since maybeSpeakNext never runs then.
      lastAssistantMediaAt = now;
      assistantFramesThisTurn += 1;
      if (holdPauseStartedAt !== null) holdPauseFrames += 1;
      return;
    }
    if (msg.event === "mark" && msg.mark?.name) {
      // Paced, exactly as the inbound mode: Twilio echoes a mark once the
      // audio ahead of it has played. The first-audio mark has nothing ahead
      // of it, so it echoes at once -- and that echo is what the server
      // measures from_answer_ms / from_speech_ms at (O-7).
      stats.marksReceived += 1;
      markTimers.push(
        setTimeout(() => {
          if (ws.readyState !== ws.OPEN) return;
          ws.send(JSON.stringify({ event: "mark", streamSid: outboundStreamSid, mark: { name: msg.mark.name } }));
          stats.marksEchoed += 1;
        }, playout.markDelay(now))
      );
      return;
    }
    if (msg.event === "clear") {
      // Twilio drops its buffer and the marks behind it: they never echo.
      stats.clears += 1;
      playout.onClear(now);
      for (const t of markTimers) clearTimeout(t);
      markTimers = [];
    }
  });

  ws.on("error", (err) => console.error(`websocket error: ${err?.message}`));
  await new Promise((resolve) => {
    ws.on("close", (code, reason) => {
      finished = true;
      stopAllTimers();
      stats.closeCode = code;
      stats.closeReason = reason?.toString() || "";
      resolve();
    });
  });

  await inProgress;
  await Promise.all(amdPosts);
  stats.durationSeconds = Math.max(0, Math.round((Date.now() - answeredAt) / 1000));
  stats.completedStatus = await postSigned(
    buildOutboundStatusRequest({ ...common, ...parties, status: "completed", durationSeconds: stats.durationSeconds })
  );
  return { observer, stats };
}

async function mainOutbound() {
  const mode = OUTBOUND_SILENT ? "silent" : "speaks_first";
  const databaseUrl = process.env.DATABASE_URL;
  // S3-5: which of the 8 situation scripts this run is, or null for the
  // pre-existing default (silent, or the single "Hello?" of outbound_hello).
  // The refusal above already limits SCRIPT_NAME to OUTBOUND_SCRIPT_NAMES.
  const situation = mode === "speaks_first" && SCRIPT_NAME && SCRIPT_NAME !== "outbound_hello" ? SCRIPT_NAME : null;
  const scriptName = situation || "outbound_hello";

  // The caller's audio, checked before anything is seeded or spent.
  /** @type {{label: string, mulaw: Buffer}[]} */
  let scriptLines = [];
  // H2: the real fixture carries lead-in silence before the voice starts
  // (Google TTS's own recording latency); leadInFrames/leadInMs let the
  // schedule and the onset both account for it. { leadInMs: 0, leadInFrames: 0 }
  // (silent mode, --dry-run) is exactly the OLD behaviour: no adjustment.
  let leadIn = { leadInMs: 0, leadInFrames: 0 };
  if (mode === "speaks_first" && !DRY_RUN) {
    try {
      scriptLines = buildProbeScript(resolveScriptLines(scriptName));
    } catch (err) {
      die(`${err.message}\n\nSynthesise it once (Google TTS, a few characters): node scripts/live-call-harness.js --synth --script ${scriptName}`);
    }
    const firstLine = scriptLines[0];
    leadIn = detectLeadIn(firstLine.mulaw, { frameBytes: FRAME_BYTES, frameMs: FRAME_MS });
    if (!leadIn.voiced) {
      console.log(`lead_in    WARNING: no frame of ${scriptName}.ulaw's first line reached the RMS threshold -- treating lead_in_ms as 0`);
    }
    console.log(`lead_in    ${leadIn.leadInMs} ms (${leadIn.leadInFrames} frames of ${leadIn.frames}, voiced=${leadIn.voiced})`);
  }

  const { default: pg } = await import("pg");
  const db = await import("../services/db.js");
  const { seedOutboundAttempt, loadOutboundAttempt, renderAttemptClips, openerClipBytes, readBackOutbound, cleanupOutboundSeed, dispatchRowFor, HARNESS_FIRST_NAME } =
    await import("../lib/probe/outboundSeed.js");

  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  let seed = null;
  let cleanup = null;
  try {
    if (CALL_SID_ARG) {
      seed = await loadOutboundAttempt({ db, callSid: CALL_SID_ARG });
    } else {
      const { callerId, contact } = pickHarnessNumbers();
      // 2026-10-01: a script's own campaign config (OUTBOUND_SCRIPT_CONFIG, e.g. the read-back sim's confirm question).
      seed = await seedOutboundAttempt({ admin, db, databaseUrl, callSid: harnessCallSid(), callerId, contact, configPatch: OUTBOUND_SCRIPT_CONFIG[SCRIPT_NAME] });
    }
    console.log(`base       ${BASE}`);
    console.log(
      `mode       ${mode}${
        mode === "speaks_first"
          ? ` (${situation ? `${scriptName}, ${resolveScriptLines(scriptName).length} lines` : `"Hello?"`} at ${HELLO_MS} ms)`
          : ""
      }${OUTBOUND_AMD ? `, AMD ${OUTBOUND_AMD} at ${AMD_MS} ms` : ""}`
    );
    console.log(`callSid    ${seed.callSid}   (${seed.seeded ? "seeded" : "existing attempt"})`);
    console.log(`attempt    ${seed.attemptId} #${seed.attemptNo}, outreach ${seed.outreachId}, campaign ${seed.campaignId} v${seed.campaignVersion}`);
    console.log(`business   ${seed.businessId} "${seed.businessName}", caller_id ${seed.callerId} -> contact ${seed.contact}`);
    console.log("");

    const common = { base: BASE, callSid: seed.callSid, accountSid: HARNESS_ACCOUNT_SID, authToken: AUTH_TOKEN };
    const parties = { callerId: seed.callerId, contact: seed.contact };
    const plan = dispatchLines({ row: dispatchRowFor(seed), attemptNo: seed.attemptNo });

    if (DRY_RUN) {
      console.log(`render     ${NO_RENDER ? "SKIPPED (--no-render): the prompt path" : "WOULD render via createLiveRenderAudio (Gemini Live, paid)"}`);
      console.log(JSON.stringify({ step: "render_lines", lines: plan.lines, refused: plan.refused }));
      printRequest("answer", buildOutboundAnswerRequest({ ...common, ...parties }));
      printRequest("status_in_progress", buildOutboundStatusRequest({ ...common, ...parties, status: "in-progress" }));
      if (OUTBOUND_AMD) printRequest(`amd_at_${AMD_MS}ms`, buildOutboundAmdRequest({ ...common, answeredBy: OUTBOUND_AMD, durationMs: AMD_MS }));
      console.log(
        JSON.stringify({
          step: "stream_start",
          at_ms_after_answer: ANSWER_TO_STREAM_MS,
          url: "<the Stream url from the answer's TwiML>",
          start: {
            callSid: seed.callSid,
            tracks: ["inbound"],
            customParameters: "<the answer TwiML's <Parameter>s, via parseTwiml>",
            mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
          },
          caller:
            mode === "speaks_first"
              ? situation
                ? `${resolveScriptLines(scriptName).length} lines (${scriptName}), first at ${HELLO_MS} ms after the answer`
                : `"Hello?" (outbound_hello) at ${HELLO_MS} ms after the answer`
              : "silence",
          hang_up_at_ms: HOLD_MS,
        })
      );
      printRequest("status_completed", buildOutboundStatusRequest({ ...common, ...parties, status: "completed", durationSeconds: Math.round(HOLD_MS / 1000) }));
      if (P1_PROBE) console.log(`spend      --dry-run: no reserveP1, no commit`);
      return;
    }

    // Spend: reserved before the first paid step (the render). Anything after
    // it that ends the process early commits from the exit hook.
    // `callStarted` is set BEFORE the answer POST: from that moment a Live
    // session may open server-side, whatever this process then manages to see.
    const state = { rendered: false, callStarted: false };
    const spend = startSpend({ mode: `outbound_${mode}`, callSid: () => seed.callSid, sessionMayHaveOpened: () => state.rendered || state.callStarted });

    let render = null;
    if (!NO_RENDER) {
      state.rendered = true;
      render = await renderAttemptClips({ db, seed, env: process.env });
      for (const s of render.sessions) {
        console.log(
          `render     ${s.kind}: ${s.outcome} in ${s.render_ms ?? "?"} ms, overlap ${s.overlap}, word_ratio ${s.word_ratio}, ` +
            `usage before turnComplete: ${s.usage_before_turn_complete}`
        );
      }
      console.log(`stored     opener ${render.stored.opener ?? "none"} bytes, voicemail ${render.stored.voicemail ?? "none"} bytes`);
    }
    // Judged by what the session will FIND, not by what this run did: a
    // --call-sid attempt may already carry a clip, and a render may not store.
    const clipBytes = await openerClipBytes({ admin, callSid: seed.callSid });
    const clip = clipBytes > 0;
    console.log(`clip       ${clip ? `${clipBytes} bytes stored: the clip path` : "none stored: the prompt path"}`);

    state.callStarted = true;
    const { observer, stats } = await runOutboundCall({ seed, common, parties, mode, scriptLines, leadIn });

    // N2 fix (harness residual wave, wave-W1-rereview.md). The old fixed
    // 1.5s wait here raced the clip-hold drain (beginClipHoldDrain waits up
    // to CLIP_HOLD_DRAIN_MAX_MS, ~2s, before finishAttemptSession/post-call
    // even start) plus whatever post-call itself then takes to write
    // suppression/outcome/outreach: suppression_opted_out, outcome_opted_out
    // and post_call_exactly_once could all read the DB before post-call had
    // actually run. Bounded poll instead, on post-call's own real completion
    // evidence: the `outbound_attempt_result` log line, post-call's LAST
    // act (lib/outbound/postCall.js's runPostCall logs it only after every
    // write -- suppression, outcome, outreach, the outbox rows -- has
    // already committed; the same event `post_call_exactly_once` itself
    // reads) when --server-log is given; otherwise the weaker but still
    // real `post_call_started_at` DB column (services/db.js's
    // claimPostCall), the only completion-adjacent signal available with no
    // server log at all. Capped so a call that genuinely never reaches
    // post-call cannot hang the harness.
    {
      const deadline = Date.now() + 15000;
      for (;;) {
        const reached = SERVER_LOG
          ? existsSync(SERVER_LOG) && parseServerLog(decodeLogBuffer(readFileSync(SERVER_LOG)), { callSid: seed.callSid }).attemptResultCount >= 1
          : (await readBackOutbound({ admin, callSid: seed.callSid })).attempt?.post_call_started_at != null;
        if (reached || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const dbRead = await readBackOutbound({ admin, callSid: seed.callSid });
    const server = await readServerLogFor(seed.callSid);

    // S3-5: the situation criteria (opted_out/wrong_number/callback rows) --
    // read directly here rather than adding to lib/probe/outboundSeed.js's
    // readBackOutbound(), which every other --outbound mode also calls.
    // Scoped to THIS run's own business_id/outreach_id (seedOutboundAttempt
    // creates a fresh business per run), so a leftover row from an earlier
    // run -- or from a DIFFERENT business that happens to reuse the same
    // phone number -- can never be read back as this run's own (named risk
    // 3: cross-run contamination).
    let dbExtra = dbRead;
    if (situation) {
      const [suppressionRes, outreachRes] = await Promise.all([
        admin.query(`SELECT reason, created_by FROM suppressions WHERE business_id = $1 AND phone_e164 = $2`, [seed.businessId, seed.contact]),
        admin.query(`SELECT next_attempt_at, outcome, state, close_reason FROM outreach WHERE id = $1`, [seed.outreachId]),
      ]);
      dbExtra = { ...dbRead, suppression: suppressionRes.rows[0] ?? null, outreach: outreachRes.rows[0] ?? null };
    }

    // H3: measured over the ticker's own lifetime (mediaTickerStartMs ->
    // mediaTickerEndMs, set when stopAllTimers actually stopped it) -- never
    // against "now" here, which is already ~1.5 s later than the call ended.
    const pacing =
      stats.mediaTickerStartMs !== null && stats.mediaTickerEndMs !== null
        ? {
            frames_sent: stats.framesSent,
            ...pacingCheck({
              framesSent: stats.framesSent,
              elapsedMs: stats.mediaTickerEndMs - stats.mediaTickerStartMs,
              frameMs: FRAME_MS,
            }),
          }
        : null;

    const verdict = outboundVerdict({
      mode,
      ...(situation
        ? {
            situation,
            topic: seed.config?.topic || "",
            callReason: seed.config?.call_reason || "",
            // Ruling (S3-5): the harness's own business is always seeded
            // Europe/London (lib/probe/outboundSeed.js), and triggerOutreach
            // is always called with timezone: null, so contactTimezone()
            // would resolve to Europe/London here too -- hardcoded rather
            // than re-derived, since re-deriving it needs a contact row this
            // script never reads. Cost if the harness's own fixture ever
            // changes timezone: a wrong "tomorrow HH:MM" expectation, caught
            // immediately by the criterion it feeds failing every run.
            timezone: "Europe/London",
            now: new Date(),
          }
        : {}),
      clip,
      // F-R2 harness-fix round 2: the opener clip's own known length,
      // independent of the product's clip-hold internals (review Important
      // #1) -- `clipBytes` is already read above to decide `clip` itself,
      // reused rather than re-derived so the two can never disagree about
      // whether/how big the stored clip is.
      clipBytes,
      client: verdictClient(observer.snapshot(), stats),
      server,
      db: dbExtra,
      personaName: seed.personaName,
      answerToStreamMs: ANSWER_TO_STREAM_MS,
      pacing,
      // 2026-10-01: the mode the SERVER ran, read from what it logged.
      firstSpeaker: inferFirstSpeaker(server),
      firstName: HARNESS_FIRST_NAME,
    });
    console.log(`first-speaker ${inferFirstSpeaker(server)}${server?.firstReply ? ` (first reply: ${JSON.stringify(server.firstReply)})` : ""}`);

    const priced = priceHarnessRun({
      sessionOpened: stats.socketOpened,
      callSummary: server?.summary ?? null,
      renderSessions: render?.sessions ?? [],
    });
    const committed = spend ? spend.commit(priced, { callSid: seed.callSid, mode: `outbound_${mode}` }) : null;

    if (seed.seeded && !KEEP_SEED) cleanup = await cleanupOutboundSeed({ admin, seed });

    const { events: _events, ...serverView } = server || {};
    console.log(
      JSON.stringify({
        kind: "outbound_harness_verdict",
        pass: verdict.pass,
        mode,
        situation,
        clip,
        callSid: seed.callSid,
        warnings: verdict.warnings,
        criteria: verdict.criteria,
        measurements: verdict.measurements,
        render: render ? { lines: render.lines, refused: render.refused, stored: render.stored, total_ms: render.total_ms, failed: render.failed, sessions: render.sessions } : null,
        server: server ? { ...serverView, summary_usage: server.summary?.usage ?? null, summary_model: server.summary?.model ?? null, summary: undefined } : null,
        db: dbExtra,
        requests: {
          answer: stats.answerStatus,
          in_progress: stats.inProgressStatus,
          amd: stats.amdStatus,
          completed: stats.completedStatus,
          not_a_stream: stats.twimlNotStream,
        },
        socket: {
          connect_ms: stats.connectMs,
          frames_sent: stats.framesSent,
          frames_expected: pacing?.frames_expected ?? null,
          speech_frames_sent: stats.speechFramesSent,
          marks_received: stats.marksReceived,
          marks_echoed: stats.marksEchoed,
          clears: stats.clears,
          wrong_stream_sid: stats.wrongStreamSid,
          hangup: stats.hangupReason,
          close: `${stats.closeCode} ${stats.closeReason}`.trim(),
          duration_s: stats.durationSeconds,
        },
        spend: P1_PROBE ? { probe: P1_PROBE, reserved_usd: HARNESS_RESERVE_USD, priced, committed } : null,
        cleanup: seed.seeded ? (KEEP_SEED ? "kept (--keep-seed)" : cleanup) : "not seeded (--call-sid)",
      })
    );
    process.exitCode = verdict.pass ? 0 : 1;
  } finally {
    if (seed?.seeded && !KEEP_SEED && !cleanup) {
      cleanup = await cleanupOutboundSeed({ admin, seed }).catch((err) => ({ clean: false, error: err?.message }));
      console.log(`cleanup    ${JSON.stringify(cleanup)}`);
    }
    await admin.end().catch(() => {});
    await db.close().catch(() => {});
  }
}

(OUTBOUND ? mainOutbound : main)().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
