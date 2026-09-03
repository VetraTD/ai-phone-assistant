#!/usr/bin/env node
/**
 * Drive a whole call on the speech-to-speech front-end without a phone.
 *
 * Signs the Twilio webhook, POSTs it to /twilio/live-voice, takes the `wss`
 * URL out of the returned TwiML, opens that socket, sends `start` and mu-law
 * frames, and reports what came back.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists at all
 * ---------------------------------------------------------------------------
 *
 * A harness of this shape was built on 2026-09-03 while diagnosing why every
 * deployed call was silent. It found in two minutes what four phone calls could
 * not explain -- and it was never committed. The backlog then described it as
 * an available tool for a day, which is worse than not having it: the next
 * person reads the entry, goes looking, and finds nothing.
 *
 * So: committed, with its limits in the file rather than only in a doc.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CANNOT TELL YOU, and this is the important half
 * ---------------------------------------------------------------------------
 *
 * IT SENDS DIGITAL SILENCE. 0xFF mu-law is silence, `usage.audio_in` comes back
 * 0, and the vendor's own VAD never hears anything. A real line sends noise.
 *
 * That means NOTHING this reports about turn-taking, endpointing, barge-in,
 * interruption or reply latency is evidence about a real call. The model will
 * usually greet (the greeting is kicked by the server, not by the caller) and
 * then wait forever, because as far as it is concerned nobody has spoken.
 *
 * What it CAN answer, and answers cheaply:
 *
 *   - Is the deployed route alive end to end -- signature accepted, tenant
 *     resolved, token minted, socket upgraded, session opened?
 *   - Does the greeting arrive, and how long does it take?
 *   - Is the audio non-empty and correctly framed (160 bytes, 20 ms)?
 *   - Does the streamSid echo back correctly?
 *   - Does a `clear` arrive -- i.e. did the leak guard cut something?
 *   - What does the call close with?
 *
 * ---------------------------------------------------------------------------
 * It spends real money
 * ---------------------------------------------------------------------------
 *
 * An accepted socket opens a real Gemini Live session on the deployment's own
 * credentials. It is cheap -- roughly a cent for a short run, against ~$0.15
 * for a three-minute phone call -- but it is not free, and cost on the Live
 * path is quadratic in call length. Hence --confirm for a non-loopback target,
 * and hence --hold defaulting to something short.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   node scripts/live-call-harness.js
 *   node scripts/live-call-harness.js --base https://host --to +1817... --confirm
 *   node scripts/live-call-harness.js --hold 30000 --out run.jsonl --confirm
 *
 *   --base <url>     server base URL (default http://localhost:$PORT)
 *   --to <e164>      the number dialled; this is what resolves the TENANT
 *   --from <e164>    the caller. On staging CALLER_ALLOWLIST is active and an
 *                    unlisted caller is refused before anything is allocated
 *   --hold <ms>      how long to stay on the call (default 20000)
 *   --auth-token <t> Twilio auth token to sign with. Defaults to
 *                    TWILIO_AUTH_TOKEN, then TWILIO_AUTH_TOKEN_ALT
 *   --out <file>     write every received event to a JSONL file
 *   --confirm        required for a non-loopback --base
 */
import "dotenv/config";
import { WebSocket } from "ws";
import twilio from "twilio";
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
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
const HOLD_MS = Number.parseInt(opt("hold", "20000"), 10);
const OUT = opt("out", "");
const AUTH_TOKEN = opt("auth-token", process.env.TWILIO_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN_ALT || "");

const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);
if (!isLoopback && !flag("confirm")) {
  console.error(
    `Refusing to drive a call against ${BASE} without --confirm.\n\n` +
      `An accepted socket opens a real Gemini Live session on that deployment's\n` +
      `credentials. It is cheap -- roughly a cent -- but it is real, and cost on\n` +
      `this path is quadratic in call length. Pass --confirm if that is what you mean.`
  );
  process.exit(2);
}

if (!AUTH_TOKEN) {
  console.error(
    `No Twilio auth token to sign with.\n\n` +
      `/twilio/live-voice validates the signature against TWILIO_AUTH_TOKEN or\n` +
      `TWILIO_AUTH_TOKEN_ALT. Set one, or pass --auth-token. Note the token must\n` +
      `belong to the account that owns ${TO}: there are two accounts here, and a\n` +
      `number signed with the wrong one is a 403 that reads like a dead route.`
  );
  process.exit(2);
}

/** 160 bytes of 0xFF is exactly one 20 ms Twilio frame of mu-law SILENCE. */
const SILENT_FRAME = Buffer.alloc(160, 0xff).toString("base64");
const FRAME_MS = 20;

const callSid = `CA${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
const streamSid = `MZ${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

if (OUT) writeFileSync(OUT, "");
const record = (obj) => {
  if (OUT) appendFileSync(OUT, `${JSON.stringify(obj)}\n`);
};

/**
 * The webhook Twilio would send, signed the way Twilio signs it.
 *
 * The signature covers the EXACT url including scheme and host, so BASE has to
 * match what the server believes its own BASE_URL is. A mismatch there is a
 * 403 that looks identical to a wrong token.
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
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body: new URLSearchParams(params).toString(),
  });
  const body = await res.text();
  return { status: res.status, body };
}

/**
 * Pull the stream URL and the <Parameter> values out of the TwiML.
 *
 * Returns null for any TwiML that is not a <Connect><Stream> -- the refusal and
 * the unrouted-voicemail branches are both valid responses and both mean the
 * call never reaches the assistant, so they are reported rather than parsed.
 */
function parseTwiml(xml) {
  const stream = xml.match(/<Stream\s+url="([^"]+)"/);
  if (!stream) return null;
  const customParameters = {};
  for (const m of xml.matchAll(/<Parameter\s+name="([^"]+)"\s+value="([^"]*)"\s*\/>/g)) {
    customParameters[m[1]] = m[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  }
  return { url: stream[1], customParameters };
}

async function main() {
  console.log(`base       ${BASE}`);
  console.log(`to         ${TO}   (resolves the tenant)`);
  console.log(`from       ${FROM}`);
  console.log(`callSid    ${callSid}`);
  console.log("");

  const t0 = Date.now();
  const { status, body } = await answerCall();
  const webhookMs = Date.now() - t0;
  record({ at: 0, kind: "webhook", status, body });

  if (status !== 200) {
    console.error(`/twilio/live-voice returned ${status} in ${webhookMs} ms\n${body}`);
    if (status === 403) {
      console.error(
        `\n403 means the signature did not verify. Three things produce it and they\n` +
          `are indistinguishable from here: the wrong auth token (there are two\n` +
          `accounts), a --base that does not match the server's own BASE_URL, or a\n` +
          `proxy rewriting the URL. Check BASE_URL on the deployment first.`
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
    wrongStreamSid: 0,
    closeCode: null,
    closeReason: "",
  };

  const openedAt = Date.now();
  const ws = new WebSocket(parsed.url);

  /**
   * When the audio we have been handed would finish playing.
   *
   * Twilio holds a buffer and sends `mark` back only once the audio ahead of it
   * has actually reached the caller. Echoing marks IMMEDIATELY would be a lie
   * in the direction that matters: end_call arms on a mark, so an instant echo
   * makes a hang-up look clean that would in reality cut the goodbye off.
   */
  let playoutUntil = 0;
  /** Mark timers, so a `clear` can drop them the way Twilio drops its buffer. */
  let markTimers = [];

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

    // Inbound audio at Twilio's real cadence. Silent, and that is the whole
    // limitation of this tool -- see the header.
    const timer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: {
            track: "inbound",
            chunk: String(stats.framesSent + 1),
            timestamp: String(stats.framesSent * FRAME_MS),
            payload: SILENT_FRAME,
          },
        })
      );
      stats.framesSent += 1;
    }, FRAME_MS);

    setTimeout(() => {
      clearInterval(timer);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ event: "stop", streamSid, stop: { callSid } }));
        setTimeout(() => ws.close(), 500);
      }
    }, HOLD_MS);
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
      const t = setTimeout(() => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: msg.mark.name } }));
        stats.marksEchoed += 1;
      }, delay);
      markTimers.push(t);
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

  ws.on("error", (err) => {
    console.error(`websocket error: ${err?.message}`);
  });

  await new Promise((resolve) => {
    ws.on("close", (code, reason) => {
      stats.closeCode = code;
      stats.closeReason = reason?.toString() || "";
      resolve();
    });
  });

  const outMs = stats.mediaFrames * FRAME_MS;
  console.log("");
  console.log(`connect    ${stats.connectMs} ms`);
  console.log(`first audio ${stats.firstMediaMs === null ? "NEVER" : `${stats.firstMediaMs} ms`}`);
  console.log(`audio out  ${stats.mediaFrames} frames, ${stats.mediaBytes} bytes, ~${(outMs / 1000).toFixed(1)} s`);
  console.log(`frames in  ${stats.framesSent} (silent)`);
  console.log(`marks      ${stats.marksReceived} received, ${stats.marksEchoed} echoed`);
  console.log(`clears     ${stats.clears}`);
  console.log(`streamSid  ${stats.wrongStreamSid === 0 ? "echoed correctly" : `WRONG on ${stats.wrongStreamSid} messages`}`);
  console.log(`close      ${stats.closeCode} ${stats.closeReason}`);
  if (OUT) console.log(`events     ${OUT}`);

  console.log("");
  if (stats.firstMediaMs === null) {
    console.log(
      `NO AUDIO CAME BACK. The socket opened, so the token and the tenant are fine;\n` +
        `the session did not speak. That is the shape LVX37 produced -- read the\n` +
        `deployment's log for live_debug_leak_text, and diff the deployed environment\n` +
        `against the local .env before building a hypothesis.`
    );
  } else {
    console.log(
      `Reminder: the frames sent were SILENT, so usage.audio_in is 0 and the vendor\n` +
        `VAD never fired. Nothing above is evidence about turn-taking, barge-in or\n` +
        `reply latency on a real call.`
    );
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
