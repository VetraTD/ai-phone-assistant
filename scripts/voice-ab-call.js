#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import twilio from "twilio";

// ---------------------------------------------------------------------------
// Play a blind listening pack down a real phone line.
//
// The whole argument for this test is that telephony bandwidth erases most of
// what separates these models — which cannot be judged through monitors at
// 48kHz. This calls your handset and plays the shuffled pack through the
// actual carrier codec, which is the condition the decision will live under.
//
// Clips are announced by index only. A <Say> would inject a fifth TTS voice
// into a TTS comparison, so the announcements are numbers spoken by the same
// engine that made the caller audio for Test 1 — neutral relative to all four
// candidates, and identical between them.
//
// Usage:
//   node scripts/voice-ab-call.js --run blind-2026-08-03-s1 --to +15551234567
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
}

const runId = opt("--run", "");
const to = opt("--to", process.env.LISTENING_TEST_NUMBER || "");
const from = opt("--from", process.env.PROBE_NUMBER || process.env.ASSISTANT_NUMBER || "");
const port = Number.parseInt(opt("--port", "4455"), 10);
const publicBase = (opt("--base", process.env.PROBE_BASE_URL || process.env.BASE_URL) || "").replace(/\/$/, "");

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

if (!runId) die("--run <runId> is required (the folder under voice-previews/).");
if (!to) die("--to <+E164> is required — the handset to call.");
if (!from) die("--from <+E164> is required (or set PROBE_NUMBER).");
if (!publicBase.startsWith("https://")) {
  die("A public https base URL is required so Twilio can fetch the clips (--base or BASE_URL).");
}

const dir = path.resolve("voice-previews", runId);
if (!fs.existsSync(dir)) die(`No such run: ${dir}`);

const clips = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".wav"))
  .sort(); // filenames are zero-padded in playback order

if (!clips.length) die(`No .wav clips in ${dir}`);

// Serve the clips over a short-lived local route. A random path segment keeps
// the pack from being trivially guessable while it is exposed.
const secret = Math.random().toString(36).slice(2, 12);
const app = express();
app.use(`/pack/${secret}`, express.static(dir, { extensions: ["wav"] }));

app.post(`/twiml/${secret}`, (req, res) => {
  const verbs = clips
    .map((file, i) => {
      const n = i + 1;
      // A short pause is deliberately longer than it feels necessary: the ear
      // needs a reset between clips or the second of any pair is judged
      // against the memory of the first rather than on its own.
      return (
        `<Pause length="1"/>` +
        `<Say voice="Polly.Matthew">Clip ${n}</Say>` +
        `<Pause length="1"/>` +
        `<Play>${publicBase}/pack/${secret}/${file}</Play>`
      );
    })
    .join("");
  res.type("text/xml").send(`<Response>${verbs}<Pause length="1"/><Say voice="Polly.Matthew">End of pack.</Say></Response>`);
});

const server = app.listen(port, async () => {
  console.log(`\n  Serving ${clips.length} clips from ${dir}`);
  console.log(`  Local port ${port}; Twilio will fetch via ${publicBase}\n`);

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) die("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required.");

  const client = twilio(accountSid, authToken);
  try {
    const call = await client.calls.create({
      to,
      from,
      url: `${publicBase}/twiml/${secret}`,
      method: "POST",
    });
    console.log(`  Calling ${to} — ${call.sid}`);
    console.log(`  Score into ${path.join(dir, "SCORECARD.md")} as you listen.`);
    console.log(`  Do not open answer-key.json until every row is filled in.\n`);
    console.log(`  Press Ctrl+C when the call ends to stop serving the clips.\n`);
  } catch (err) {
    console.error(`\n  Call failed: ${err.message}\n`);
    server.close();
    process.exit(1);
  }
});
