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
 */
import "dotenv/config";
import { WebSocket } from "ws";
import twilio from "twilio";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolveScriptLines, buildProbeScript, synthesizeCallerAudio } from "../lib/probe/script.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
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
const AUTH_TOKEN = opt("auth-token", process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN_ALT || "");

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

/** The script, as frames. Empty in silent mode. */
const script = SCRIPT_NAME ? buildProbeScript(resolveScriptLines(SCRIPT_NAME)) : [];

const callSid = `CA${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
const streamSid = `MZ${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

if (OUT) writeFileSync(OUT, "");
const record = (obj) => {
  if (OUT) appendFileSync(OUT, `${JSON.stringify(obj)}\n`);
};

/** Read the counters, or null if no token was given / the read failed. */
async function readCounters() {
  if (!DEBUG_TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/api/debug/latency`, { headers: { "x-debug-token": DEBUG_TOKEN } });
    if (!res.ok) return null;
    const j = await res.json();
    return { bootId: j.bootId, counters: j.turnTaking || {} };
  } catch {
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
async function answerCall() {
  const url = `${BASE}/twilio/live-voice`;
  const params = {
    AccountSid: process.env.TWILIO_ACCOUNT_SID || "ACharness0000000000000000000000000",
    CallSid: callSid,
    From: FROM,
    To: TO,
    CallStatus: "ringing",
    Direction: "inbound",
    ApiVersion: "2010-04-01",
  };
  const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature },
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.text() };
}

/**
 * Pull the stream URL and the <Parameter> values out of the TwiML.
 *
 * Returns null for any TwiML that is not a <Connect><Stream> -- the refusal and
 * the unrouted-voicemail branches are both valid answers and both mean the call
 * never reaches the assistant, so they are reported rather than parsed.
 */
function parseTwiml(xml) {
  const stream = xml.match(/<Stream\s+url="([^"]+)"/);
  if (!stream) return null;
  const customParameters = {};
  for (const m of xml.matchAll(/<Parameter\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
    customParameters[m[1]] = m[2]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
  }
  return { url: stream[1], customParameters };
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
    console.log(
      `speak      ${line.label}  (heard ${((assistantFramesThisTurn * FRAME_MS) / 1000).toFixed(1)} s back${gaveUp ? ", NO REPLY" : ""})`
    );
    stats.linesSpoken += 1;
    assistantFramesThisTurn = 0;
  }

  /** Say goodbye once, stop every timer, and let the socket close. */
  function hangUp() {
    if (finished) return;
    finished = true;
    stopAllTimers();
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: "stop", streamSid, stop: { callSid } }));
      setTimeout(() => ws.close(), 500);
    }
  }

  ws.on("open", () => {
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

    // ONE ticker. A real line always sends a frame every 20 ms, whether or not
    // anybody is talking -- so this draws from the caller queue when there is
    // speech to send and from silence when there is not, rather than starting
    // and stopping. A stream that goes quiet is a different input to the
    // vendor's VAD than a stream carrying silence.
    every(() => {
      if (ws.readyState !== ws.OPEN) return;
      const now = Date.now();
      maybeSpeakNext(now);

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
    }, FRAME_MS);


    // Silent mode runs for --hold. A script runs until it has said everything
    // and heard the last reply out (the watcher below), with --max-call-ms as
    // the ceiling rather than the plan.
    later(hangUp, SCRIPT_NAME ? MAX_CALL_MS : HOLD_MS);

    // A script that finishes early should hang up rather than burn budget: the
    // cost of this path is quadratic in call length.
    every(() => {
      if (!SCRIPT_NAME || finished) return;
      const spokeEverything = cursor >= script.length && outQueue.length === 0;
      const quietFor = Date.now() - lastAssistantMediaAt;
      if (spokeEverything && assistantFramesThisTurn > 0 && quietFor >= GAP_MS * 2) hangUp();
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
  if (SCRIPT_NAME) {
    const cutShort = stats.linesSpoken < script.length;
    console.log(
      `lines      ${stats.linesSpoken}/${script.length} spoken, ${stats.turnsWithNoReply} sent with no reply heard` +
        (cutShort ? `   <- CUT SHORT: raise --max-call-ms, and treat every counter below as inconclusive` : "")
    );
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
    console.log(`\ncounter delta unavailable: /api/debug/latency did not answer with that token.`);
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
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
