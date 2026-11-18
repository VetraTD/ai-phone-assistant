// Percentiles and the raw-result recorder shared by every probe.
//
// p50 is reported as the headline everywhere because that is what the 940 ms
// cascade baseline is (docs/receptionist-backlog.md section 0). Comparing a
// mean here against a p50 there would manufacture a difference out of nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RAW_DIR = path.join(HERE, "..", "raw");

export function pct(samples, p) {
  const s = [...samples].filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  if (s.length === 1) return s[0];
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return Math.round(lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo));
}
export const p50 = (s) => pct(s, 50);
export const p95 = (s) => pct(s, 95);
export const mean = (s) => (s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null);

/**
 * Abort-after-3-consecutive-socket-errors guard (PLAN.md rule 7). A counter
 * that resets on success, so an intermittent blip does not kill a run but a
 * genuinely dead endpoint stops the night instead of burning it on retries.
 */
export function errorGuard(limit = 3) {
  let streak = 0;
  return {
    ok() { streak = 0; },
    fail(err) {
      streak++;
      if (streak >= limit) {
        const e = new Error(`ABORT: ${streak} consecutive socket errors — last: ${err?.message || err}`);
        e.name = "SocketErrorStreak";
        throw e;
      }
      return streak;
    },
    get streak() { return streak; },
  };
}

export function writeRaw(name, data) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const p = path.join(RAW_DIR, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  return p;
}

export function readRaw(name) {
  try { return JSON.parse(fs.readFileSync(path.join(RAW_DIR, `${name}.json`), "utf8")); }
  catch { return null; }
}
