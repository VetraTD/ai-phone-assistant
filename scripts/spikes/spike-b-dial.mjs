#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SPIKE B -- outbound Part 1, spec section 9.4. THROWAWAY.
//
// One real outbound call per run, placed the way the spec says the engine will
// place them: calls.create with async AMD (DetectMessageEnd), status callbacks,
// Timeout=25, and on answer a BIDIRECTIONAL <Connect><Stream> into which a
// pre-rendered opener clip is pushed as mu-law frames -- the opener mechanism
// of section 9.3. On a machine_end_* verdict the call is redirected through the
// REST API to <Play> a clip then hang up -- the voicemail mechanism of 9.4.
//
// What it measures, per call, all as a timeline relative to calls.create:
//   ring time (initiated -> ringing -> answered), the /answer webhook, stream
//   start, first opener frame sent, the opener's mark echoed back (= played),
//   first caller speech energy on the inbound track, the AMD verdict and its
//   MachineDetectionDuration, and completion.
//
// Safety: every HTTP callback's Twilio signature is validated; every route sits
// under a random path segment; each call is hard-capped at 60 s through the
// REST API; the tunnel and server are torn down in `finally`. Credentials are
// read into memory and never printed: account A (+441372656055) from Secret
// Manager, account B (+18176011171) from .env. The number dialled is an
// argument, never stored in the repo.
//
// Usage (from the repo root; Norton needs the CA bundle):
//   node scripts/spikes/spike-b-dial.mjs --check --to <e164>           # read-only, free
//   node scripts/spikes/spike-b-dial.mjs --route A|B --to <e164> --scenario B1 \
//        --clip <opener.ulaw> --out <dir>                                # ONE paid call
// ---------------------------------------------------------------------------
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { execSync, spawn } from "node:child_process";
import express from "express";
import twilio from "twilio";
import { WebSocketServer } from "ws";
import { decodeMulaw } from "../../lib/voice/mulaw.js";
import { commit, reserveP1, p1Spent } from "../probes/lib/spendLive.js";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const TO = arg("to", "");
const ROUTE = arg("route", "");
const SCENARIO = arg("scenario", "B1");
const CLIP = arg("clip", "");
const OUT = arg("out", "");
const PORT = parseInt(arg("port", "4466"), 10);
const RING_S = Math.min(Math.max(parseInt(arg("ring", "25"), 10) || 25, 15), 60);
const PROBE = "P1-SPIKE-B";
const HARD_CAP_MS = 60_000;
const E164 = /^\+[1-9]\d{6,14}$/;

const ROUTES = {
  A: { from: "+441372656055", label: "account A (Secret Manager)" },
  B: { from: "+18176011171", label: "account B (.env)" },
};

function die(msg, code = 1) { console.error(`\n  ${msg}\n`); process.exit(code); }
if (!E164.test(TO)) die("--to <+E164> is required");

// ---------------------------------------------------------------------------
// Credentials, into memory only.
// ---------------------------------------------------------------------------
function secret(name) {
  const env = { ...process.env, CLOUDSDK_CONFIG: process.env.CLOUDSDK_CONFIG || path.join(process.env.USERPROFILE || process.env.HOME, ".gcloud-vetra2") };
  return execSync(`gcloud secrets versions access latest --secret=${name} --project=vetra-uk-edc8ca`, {
    env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  }).trim();
}
function creds(route) {
  if (route === "A") return { sid: secret("twilio-account-sid"), token: secret("twilio-auth-token") };
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) die("account B credentials missing from .env");
  return { sid, token };
}

// ---------------------------------------------------------------------------
// --check: read-only. Who owns which number, and can account A dial the
// destination's country. Costs nothing and dials nothing.
// ---------------------------------------------------------------------------
async function check() {
  const iso = TO.startsWith("+44") ? "GB" : TO.startsWith("+1") ? "US" : null;
  for (const route of ["A", "B"]) {
    const r = ROUTES[route];
    try {
      const c = creds(route);
      const client = twilio(c.sid, c.token);
      const owned = await client.incomingPhoneNumbers.list({ phoneNumber: r.from, limit: 5 });
      console.log(`${route} ${r.label}: account ${c.sid.slice(0, 6)}...${c.sid.slice(-4)} owns ${r.from}: ${owned.length > 0}`);
      if (iso) {
        const p = await client.voice.v1.dialingPermissions.countries(iso).fetch();
        console.log(`${route}   dialing permission ${iso}: lowRisk=${p.lowRiskNumbersEnabled} highRiskSpecial=${p.highRiskSpecialNumbersEnabled} highRiskTollfraud=${p.highRiskTollfraudNumbersEnabled}`);
      }
    } catch (e) {
      console.log(`${route} ${r.label}: CHECK FAILED -- ${String(e.message).slice(0, 160)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The tunnel. A cloudflared quick tunnel; the URL is random per run.
// ---------------------------------------------------------------------------
function startTunnel() {
  return new Promise((resolve, reject) => {
    const proc = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => reject(new Error("cloudflared gave no URL in 30s")), 30_000);
    const onData = (d) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(timer); resolve({ proc, url: m[0] }); }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => { clearTimeout(timer); reject(new Error(`cloudflared exited ${code}`)); });
  });
}

// ---------------------------------------------------------------------------
// One call.
// ---------------------------------------------------------------------------
function wavPcm16FromUlaw(ulaw) {
  const s = Int16Array.from(decodeMulaw(ulaw));
  const data = Buffer.from(s.buffer, s.byteOffset, s.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function dial() {
  if (!ROUTES[ROUTE]) die("--route A|B is required for a dial");
  if (!CLIP || !fs.existsSync(CLIP)) die("--clip <opener .ulaw from spike A> is required");
  if (!OUT) die("--out <dir> is required");
  fs.mkdirSync(OUT, { recursive: true });

  const clip = fs.readFileSync(CLIP);
  const vmWav = wavPcm16FromUlaw(clip);
  const { sid, token } = creds(ROUTE);
  const client = twilio(sid, token);
  const from = ROUTES[ROUTE].from;

  // Worst case: a 60 s international call plus AMD plus stream minutes.
  reserveP1(PROBE, 0.25);

  const secretSeg = crypto.randomBytes(8).toString("hex");
  const t = {}; // timeline, ms since calls.create
  let t0 = null;
  const mark = (k, extra) => { const ms = t0 ? Date.now() - t0 : null; if (!(k in t)) t[k] = ms; if (extra) console.log(`  [${ms}ms] ${k} ${JSON.stringify(extra)}`); else console.log(`  [${ms}ms] ${k}`); };
  const events = [];
  let callSid = null;
  let base = null;
  let hardCap = null;
  let completed = false;

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const signed = (req) => {
    const url = base + req.originalUrl;
    const ok = twilio.validateRequest(token, req.header("X-Twilio-Signature") || "", url, req.body || {});
    if (!ok) console.log(`  SIGNATURE FAILED on ${req.path}`);
    return ok;
  };

  app.post(`/${secretSeg}/answer`, (req, res) => {
    if (!signed(req)) return res.status(403).end();
    mark("answer_webhook");
    const wss = base.replace(/^https:/, "wss:") + `/${secretSeg}/stream`;
    res.type("text/xml").send(
      `<Response><Connect><Stream url="${wss}"><Parameter name="direction" value="outbound"/></Stream></Connect></Response>`
    );
  });
  app.post(`/${secretSeg}/status`, (req, res) => {
    if (!signed(req)) return res.status(403).end();
    const b = req.body;
    events.push({ at: t0 ? Date.now() - t0 : null, kind: "status", status: b.CallStatus, duration: b.CallDuration, sipCode: b.SipResponseCode });
    mark(`status_${b.CallStatus}`, { duration: b.CallDuration, sip: b.SipResponseCode });
    if (b.CallStatus === "in-progress" && !hardCap) {
      hardCap = setTimeout(() => client.calls(callSid).update({ status: "completed" }).catch(() => {}), HARD_CAP_MS);
    }
    if (["completed", "busy", "no-answer", "failed", "canceled"].includes(b.CallStatus)) completed = true;
    res.status(204).end();
  });
  app.post(`/${secretSeg}/amd`, async (req, res) => {
    if (!signed(req)) return res.status(403).end();
    const b = req.body;
    events.push({ at: t0 ? Date.now() - t0 : null, kind: "amd", answeredBy: b.AnsweredBy, machineDetectionDuration: b.MachineDetectionDuration });
    mark("amd", { answeredBy: b.AnsweredBy, machineDetectionDuration: b.MachineDetectionDuration });
    res.status(204).end();
    try {
      if (/^machine_end_/.test(b.AnsweredBy || "")) {
        await client.calls(callSid).update({ twiml: `<Response><Play>${base}/${secretSeg}/vm.wav</Play><Hangup/></Response>` });
        mark("voicemail_redirect_sent");
      } else if (b.AnsweredBy === "fax") {
        await client.calls(callSid).update({ status: "completed" });
      }
    } catch (e) { mark("amd_action_failed", { error: String(e.message).slice(0, 120) }); }
  });
  app.get(`/${secretSeg}/vm.wav`, (req, res) => { mark("vm_wav_fetched"); res.type("audio/wav").send(vmWav); });

  const server = http.createServer(app);
  const wssrv = new WebSocketServer({ server, path: `/${secretSeg}/stream` });
  wssrv.on("connection", (ws) => {
    mark("ws_connected");
    let streamSid = null;
    let heard = false;
    let played = false;
    let openerTimer = null;
    // The opener: pushed at once in 20 ms chunks, then a mark. Twilio buffers
    // and plays in order, and echoes the mark when playback reaches it -- that
    // echo is "the caller has heard the opener".
    const playOpener = (why) => {
      if (played || !streamSid) return;
      played = true;
      if (openerTimer) clearTimeout(openerTimer);
      mark("first_frame_sent", { trigger: why });
      for (let i = 0; i < clip.length; i += 160) {
        ws.send(JSON.stringify({ event: "media", streamSid, media: { payload: clip.subarray(i, i + 160).toString("base64") } }));
      }
      ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "opener_end" } }));
    };
    ws.on("close", () => { if (openerTimer) clearTimeout(openerTimer); });
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.event === "start") {
        streamSid = m.start.streamSid;
        mark("stream_start", { direction: m.start.customParameters?.direction });
        // Spec §9.3.2: play on the first sign of caller speech ("Hello?"),
        // or after 1.5 s of silence. Call 1 of 2026-09-24 played at stream
        // start and the owner reported "it did not let me say hello" --
        // `--play-immediately` keeps that behaviour for comparison only.
        if (has("play-immediately")) playOpener("immediate");
        else openerTimer = setTimeout(() => playOpener("silence_1500ms"), 1500);
      } else if (m.event === "media" && !heard) {
        // First caller speech: mean absolute amplitude of the inbound frame.
        const pcm = decodeMulaw(Buffer.from(m.media.payload, "base64"));
        let sum = 0; for (const s of pcm) sum += Math.abs(s);
        if (sum / pcm.length > 900) { heard = true; mark("first_caller_energy"); playOpener("caller_speech"); }
      } else if (m.event === "mark") {
        mark(`mark_echo_${m.mark?.name}`);
      } else if (m.event === "stop") {
        mark("stream_stop");
      }
    });
  });

  await new Promise((r) => server.listen(PORT, r));
  let tunnel = null;
  try {
    tunnel = await startTunnel();
    base = tunnel.url;
    // Wait for the quick tunnel's DNS to resolve before Twilio needs it.
    for (let k = 0; k < 30; k++) {
      try { const r = await fetch(`${base}/${secretSeg}/vm.wav`, { method: "GET" }); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    delete t.vm_wav_fetched;
    console.log(`  tunnel ready (${ROUTE}: ${from} -> destination ending ${TO.slice(-4)}), scenario ${SCENARIO}`);

    t0 = Date.now();
    const call = await client.calls.create({
      to: TO,
      from,
      url: `${base}/${secretSeg}/answer`,
      method: "POST",
      statusCallback: `${base}/${secretSeg}/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      machineDetection: "DetectMessageEnd",
      asyncAmd: "true",
      asyncAmdStatusCallback: `${base}/${secretSeg}/amd`,
      asyncAmdStatusCallbackMethod: "POST",
      // Spec §9.4 says 25. Call 2 of 2026-09-24 rang 24 s and ended
      // no-answer BEFORE the carrier's voicemail picked up -- so --ring lets
      // the spike measure when voicemail actually answers.
      timeout: RING_S,
    });
    callSid = call.sid;
    mark("created");

    const until = Date.now() + 120_000;
    while (!completed && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    if (!completed) { mark("timeout_forcing_hangup"); await client.calls(callSid).update({ status: "completed" }).catch(() => {}); }
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    if (hardCap) clearTimeout(hardCap);
    try { tunnel?.proc?.kill(); } catch {}
    wssrv.close();
    server.close();
  }

  // Price: Twilio fills call.price some seconds after completion.
  let price = null, duration = null, status = null;
  for (let k = 0; k < 20 && callSid; k++) {
    const c = await client.calls(callSid).fetch();
    status = c.status; duration = Number(c.duration || 0);
    if (c.price != null) { price = Math.abs(Number(c.price)); break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  const amdUsd = 0.0075;
  const streamUsd = 0.004 * Math.ceil((duration || 0) / 60);
  const usd = (price ?? 0.05) + amdUsd + streamUsd;
  commit({ probe: PROBE, arm: ROUTE, label: `dial-${SCENARIO}`, usd, estimated: price == null, twilio_price: price, duration_s: duration });

  const result = { at: new Date().toISOString(), route: ROUTE, from, to_last4: TO.slice(-4), scenario: SCENARIO, callSid, status, duration_s: duration, twilio_price_usd: price, recorded_usd: Number(usd.toFixed(4)), timeline_ms: t, events };
  const file = path.join(OUT, `spike-b-${SCENARIO}-${ROUTE}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`\n  result -> ${file}`);
  console.log(`  timeline ${JSON.stringify(t)}`);
  console.log(`  committed $${usd.toFixed(4)}; Part 1 spent $${p1Spent().toFixed(4)}`);
}

if (has("check")) await check();
else await dial();
process.exit(0);
