#!/usr/bin/env node
/**
 * N concurrent media-stream WebSockets, opened for real, against a running
 * server.
 *
 * ---------------------------------------------------------------------------
 * What this can answer, and what it cannot
 * ---------------------------------------------------------------------------
 *
 * IT CAN answer: does this process serve N simultaneous calls, how long does
 * pickup take while it is doing so, how many database connections does one
 * instance actually hold at N, and what breaks first. Those are properties of
 * the code, and they are measurable today on a laptop.
 *
 * IT CANNOT answer what the system's concurrency ceiling is. That ceiling is
 * not in this repository:
 *
 *   1. `instances x DB_POOL_MAX` must stay under the Cloud SQL instance's
 *      `max_connections`, and THE INSTANCE DOES NOT EXIST YET. Phase 4 creates
 *      it; the number is read off it, not assumed (ledger P7). What this script
 *      contributes is the LEFT-hand side: `--observe-db` measures how many
 *      connections one instance really holds at N, which is the term everybody
 *      guesses.
 *   2. Vendor caps bind before GCP does — ElevenLabs concurrent requests,
 *      Deepgram concurrent streams, Twilio concurrent calls and CPS, Vertex QPM.
 *      See docs/capacity.md. Those are account settings, not code, and no
 *      amount of local load reveals them.
 *
 * So this is a floor and a shape, not a ceiling. Saying otherwise would be the
 * most expensive kind of wrong: a capacity number nobody can trace to a
 * measurement.
 *
 * ---------------------------------------------------------------------------
 * It spends real money when pointed at a real deployment
 * ---------------------------------------------------------------------------
 *
 * Every accepted socket opens a Deepgram stream and, once audio flows, drives
 * Gemini turns and ElevenLabs synthesis. Against a deployment holding
 * production credentials, N sockets is N calls' worth of vendor spend and N
 * calls' worth of vendor concurrency — including, at a high enough N, tripping
 * the very caps you are trying to characterise, for real callers as well.
 *
 * Hence `--confirm` for any non-loopback target. Localhost with a dev .env is
 * still real vendor spend if those keys are real; the flag is a speed bump on
 * the case that also affects customers.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   node scripts/load-test-calls.js --n 10
 *   node scripts/load-test-calls.js --n 25 --ramp 200 --hold 15000 --audio
 *   node scripts/load-test-calls.js --n 10 --observe-db
 *   node scripts/load-test-calls.js --n 10 --url wss://host/twilio/media-stream --confirm
 *
 *   --n <int>        concurrent sockets (default 5)
 *   --url <url>      media-stream websocket (default ws://localhost:$PORT/twilio/media-stream)
 *   --business <e164> businessPhone custom parameter; must route to a real tenant
 *   --ramp <ms>      delay between opens. The CPS analogue: 0 opens all at once
 *   --hold <ms>      how long to keep each socket open (default 10000)
 *   --audio          stream silent mulaw at Twilio's real 20ms cadence
 *   --observe-db     sample pg_stat_activity during the run (needs DATABASE_URL)
 *   --no-token       open the socket with NO per-call token. Every leg should be
 *                    refused; this is how you check P10 is still closed
 *   --confirm        required for a non-loopback target
 */
import "dotenv/config";
import { WebSocket } from "ws";
import { mintMediaStreamToken } from "../lib/mediaStreamToken.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const N = Number.parseInt(opt("n", "5"), 10);
const PORT = process.env.PORT || 3000;
const URL_ = opt("url", `ws://localhost:${PORT}/twilio/media-stream`);
const BUSINESS = opt("business", "");
const RAMP_MS = Number.parseInt(opt("ramp", "0"), 10);
const HOLD_MS = Number.parseInt(opt("hold", "10000"), 10);
const SEND_AUDIO = flag("audio");
const OBSERVE_DB = flag("observe-db");
const NO_TOKEN = flag("no-token");

const isLoopback = /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(URL_);
if (!isLoopback && !flag("confirm")) {
  console.error(
    `Refusing to load-test ${URL_} without --confirm.\n\n` +
      `Every accepted socket is a real Deepgram stream, real Gemini turns and real\n` +
      `ElevenLabs synthesis on that deployment's credentials, and at a high enough N\n` +
      `it consumes the same vendor concurrency real callers are using. Pass --confirm\n` +
      `if that is what you mean.`
  );
  process.exit(2);
}

if (!Number.isInteger(N) || N < 1) {
  console.error(`--n must be a positive integer, got "${opt("n", "5")}"`);
  process.exit(2);
}

// 160 bytes of mulaw silence is exactly one 20ms Twilio frame at 8kHz. 0xFF is
// mulaw digital silence; 0x00 is full-scale and would be a loud tone, which
// Deepgram would happily transcribe as nothing while billing for it.
const SILENT_FRAME = Buffer.alloc(160, 0xff).toString("base64");
const FRAME_MS = 20;

/** @typedef {{ i:number, openedAt:number, connectedAt:number|null, firstAudioAt:number|null, closeCode:number|null, closeReason:string, error:string|null, outboundFrames:number, marks:number }} Leg */

/** One simulated call. Resolves when its socket closes. */
function runLeg(i) {
  return new Promise((resolve) => {
    /** @type {Leg} */
    const leg = {
      i,
      openedAt: Date.now(),
      connectedAt: null,
      firstAudioAt: null,
      closeCode: null,
      closeReason: "",
      error: null,
      outboundFrames: 0,
      marks: 0,
    };

    const callSid = `CAload${String(i).padStart(4, "0")}${Date.now().toString(36)}`;
    const streamSid = `MZload${String(i).padStart(4, "0")}`;

    // P10: the upgrade now needs a per-call token, minted the same way
    // /twilio/voice mints it. Passing --no-token is how you verify the hole is
    // still closed — every leg should come back refused, and BEFORE the fix
    // every leg was accepted.
    const token = NO_TOKEN ? null : mintMediaStreamToken(callSid);
    const url = token ? `${URL_}/${encodeURIComponent(token)}` : URL_;
    const ws = new WebSocket(url);
    let audioTimer = null;
    let holdTimer = null;

    function finish() {
      if (audioTimer) clearInterval(audioTimer);
      if (holdTimer) clearTimeout(holdTimer);
      resolve(leg);
    }

    ws.on("open", () => {
      leg.connectedAt = Date.now();
      // Twilio's own opening sequence, in order. `start` is what makes the
      // server resolve a tenant and begin the call; without it the socket is
      // open and the server is doing nothing, which would measure the TCP
      // stack rather than the application.
      ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
      ws.send(
        JSON.stringify({
          event: "start",
          sequenceNumber: "1",
          streamSid,
          start: {
            streamSid,
            callSid,
            accountSid: "ACloadtest",
            tracks: ["inbound"],
            mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
            customParameters: { businessPhone: BUSINESS, callerPhone: "+10000000000" },
          },
        })
      );

      if (SEND_AUDIO) {
        let seq = 2;
        audioTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              event: "media",
              sequenceNumber: String(seq++),
              streamSid,
              media: {
                track: "inbound",
                chunk: String(seq),
                timestamp: String(seq * FRAME_MS),
                payload: SILENT_FRAME,
              },
            })
          );
        }, FRAME_MS);
      }

      holdTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "stop", streamSid, stop: { callSid, accountSid: "ACloadtest" } }));
          ws.close();
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
      if (msg.event === "media") {
        leg.outboundFrames++;
        // First byte of greeting audio: the thing a caller actually waits for.
        if (leg.firstAudioAt === null) leg.firstAudioAt = Date.now();
      } else if (msg.event === "mark") {
        leg.marks++;
      }
    });

    ws.on("error", (err) => {
      leg.error = err?.message || String(err);
    });

    ws.on("close", (code, reason) => {
      leg.closeCode = code;
      leg.closeReason = reason?.toString?.() || "";
      finish();
    });
  });
}

/**
 * Watch how many backend connections this instance really holds.
 *
 * This is the measurable half of `instances x DB_POOL_MAX < max_connections`.
 * The right-hand side needs an instance that does not exist yet; the left-hand
 * side is a number this process can simply look at, and it is the one people
 * assume equals DB_POOL_MAX.
 */
async function observeDb(stopSignal) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("--observe-db needs DATABASE_URL. Skipping the connection sample.");
    return null;
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let peak = 0;
  let samples = 0;
  try {
    while (!stopSignal.stopped) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`
      );
      peak = Math.max(peak, rows[0].n);
      samples++;
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    await client.end();
  }
  return { peak, samples };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main() {
  console.log(
    `load-test-calls: ${N} concurrent media streams -> ${URL_}\n` +
      `  ramp ${RAMP_MS}ms between opens, hold ${HOLD_MS}ms, audio ${SEND_AUDIO ? "on" : "off"}` +
      (BUSINESS ? `, businessPhone ${BUSINESS}` : ", businessPhone UNSET (tenant lookup will miss)") +
      `\n`
  );

  if (!BUSINESS) {
    console.log(
      "NOTE: without --business the server cannot resolve a tenant, so each leg exercises\n" +
        "      the socket, the start frame and the failure path — not a full call. That is a\n" +
        "      useful measurement and it is not the same measurement. Say which one you ran.\n"
    );
  }

  if (NO_TOKEN) {
    console.log("--no-token: every leg should be REFUSED. Any accepted socket means P10 is open.\n");
  } else if (!mintMediaStreamToken("CAprobe")) {
    console.log(
      "NOTE: no TWILIO_AUTH_TOKEN or MEDIA_STREAM_SECRET here, so no token can be minted. Legs\n" +
        "      will be refused unless the target runs with TWILIO_VALIDATE_SIGNATURE=false.\n"
    );
  }

  const stopSignal = { stopped: false };
  const dbWatcher = OBSERVE_DB ? observeDb(stopSignal) : Promise.resolve(null);

  const startedAt = Date.now();
  const legs = [];
  for (let i = 0; i < N; i++) {
    legs.push(runLeg(i));
    if (RAMP_MS > 0 && i < N - 1) await new Promise((r) => setTimeout(r, RAMP_MS));
  }
  const results = await Promise.all(legs);
  const wallMs = Date.now() - startedAt;

  stopSignal.stopped = true;
  const db = await dbWatcher;

  const accepted = results.filter((r) => r.connectedAt !== null);
  const refused = results.filter((r) => r.connectedAt === null);
  const gotAudio = accepted.filter((r) => r.firstAudioAt !== null);
  const ttfa = gotAudio.map((r) => r.firstAudioAt - r.openedAt).sort((a, b) => a - b);

  console.log(`--- results (${wallMs} ms wall) ---`);
  console.log(`sockets opened          ${accepted.length} / ${N}`);
  console.log(`sockets refused         ${refused.length}`);
  console.log(`legs that got audio     ${gotAudio.length} / ${accepted.length}`);
  if (ttfa.length) {
    console.log(
      `time to first audio     p50 ${percentile(ttfa, 50)}ms  p95 ${percentile(ttfa, 95)}ms  max ${ttfa[ttfa.length - 1]}ms`
    );
  }
  if (db) {
    console.log(`peak backend connections ${db.peak}  (${db.samples} samples)`);
    console.log(
      `  -> that is ONE instance's real draw. The ceiling is max_connections on a Cloud SQL\n` +
        `     instance that does not exist yet (ledger P7). Do not turn this into a ceiling.`
    );
  }

  // Errors and close codes, grouped. A load test that reports only a pass rate
  // hides the reason, and the reason is the whole output.
  const byClose = new Map();
  for (const r of results) {
    const key = r.error ? `error: ${r.error}` : `close ${r.closeCode}${r.closeReason ? ` (${r.closeReason})` : ""}`;
    byClose.set(key, (byClose.get(key) ?? 0) + 1);
  }
  console.log(`\nhow each leg ended:`);
  for (const [key, count] of [...byClose].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${key}`);
  }

  console.log(
    `\nThis measured ONE process. It is a floor, not a ceiling: the binding constraints are\n` +
      `vendor caps and Cloud SQL max_connections, neither of which is in this repository.\n` +
      `See docs/capacity.md.`
  );

  // Non-zero when anything did not get off the ground, so this is usable in a
  // gate rather than only by eye.
  process.exit(refused.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
