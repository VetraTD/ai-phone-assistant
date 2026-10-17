// ---------------------------------------------------------------------------
// LVX181 fixtures: a drawn-out "ummm" and a complete "Ten works.".
//
// The other test-audio/caller fixtures are made by Google Chirp3-HD
// (en-US-Chirp3-HD-Charon, see synth-absorbers.mjs) -- a PAID call. Not used
// here. These two come from Windows SAPI (Microsoft David, en-US), which is
// free and local, rendered at 8 kHz PCM16 and encoded to mu-law with the
// repo's own encoder so they load through lib/audio.js loadUlaw() unchanged.
//
// A SAPI "ummm" is a synthetic filler and a WEAKER INSTRUMENT than a real
// person hesitating. It is voiced, nasal and about the right length, but it
// has no breath, no creak, no falling-pitch hesitation contour. A model that
// ignores it proves little about a real "ummm"; a model that answers it is a
// finding.
//
// Run: node scripts/probes/lvx181-make-fixtures.mjs
// Cost: $0. Network: none.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { encodeMulaw } from "../../lib/voice/mulaw.js";

const OUT_DIR = path.resolve("test-audio/caller");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lvx181-"));

// text, SAPI rate (-10..10). Rate -10 is what stretches the "mmm" to ~1.3 s;
// at the default rate SAPI says "um" in ~0.6 s.
const SPECS = [
  { label: "lvx181_umm", text: "Ummmmmmmmm", rate: -10 },
  { label: "lvx181_ten_works", text: "Ten works.", rate: 0 },
];
const TARGET_PEAK_FRAME_RMS = 7000; // existing caller fixtures: 6,000-10,000

function sapi(text, rate, wav) {
  const ps = `
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(8000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft David Desktop'); $s.Rate = ${rate}
$s.SetOutputToWaveFile('${wav.replace(/\\/g, "\\\\")}', $fmt); $s.Speak('${text}'); $s.Dispose()`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "inherit" });
}

const frameRms = (pcm, fr = 160) => {
  const out = [];
  for (let i = 0; i + fr <= pcm.length; i += fr) {
    let s = 0;
    for (let j = 0; j < fr; j++) s += pcm[i + j] ** 2;
    out.push(Math.sqrt(s / fr));
  }
  return out;
};

for (const spec of SPECS) {
  const wav = path.join(TMP, `${spec.label}.wav`);
  sapi(spec.text, spec.rate, wav);
  const raw = fs.readFileSync(wav).subarray(44); // 44-byte RIFF header, 8 kHz mono PCM16
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1).slice();

  const rms = frameRms(pcm);
  const peak = Math.max(...rms);
  const thr = Math.max(300, peak * 0.1);
  const first = rms.findIndex((r) => r > thr);
  const last = rms.length - 1 - [...rms].reverse().findIndex((r) => r > thr);
  // keep 60 ms of lead-in, trim everything after the voiced end + 60 ms
  const from = Math.max(0, (first - 3) * 160);
  const to = Math.min(pcm.length, (last + 1 + 3) * 160);
  const gain = TARGET_PEAK_FRAME_RMS / peak;
  const trimmed = Int16Array.from(pcm.subarray(from, to), (v) => Math.max(-32768, Math.min(32767, Math.round(v * gain))));

  const ulaw = encodeMulaw(trimmed);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${spec.label}.ulaw`), ulaw);
  console.log(
    `${spec.label}: ${(trimmed.length / 8000).toFixed(2)} s file, voiced ${((last + 1 - first) * 0.02).toFixed(2)} s ` +
      `(frames>${Math.round(thr)} rms), gain x${gain.toFixed(2)} -> ${ulaw.length} bytes`
  );
}
fs.rmSync(TMP, { recursive: true, force: true });
