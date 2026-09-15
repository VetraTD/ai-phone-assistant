// ---------------------------------------------------------------------------
// Spend meter for the GPT-Live round (2026-09-15).
//
// A SEPARATE FILE AND A SEPARATE CAP from lib/spend.js on purpose. That meter
// is at $9.152 against a cap the owner raised to $11.00 across three earlier
// rounds; pointing this round at it would leave ~$1.85 of headroom and make a
// breach look like this round's fault. Owner authorised $5.00 for this round,
// standalone.
//
// WHAT IS DIFFERENT ABOUT BILLING HERE, and why this is not a copy of spend.js:
//
//   GPT-Live bills the voice layer by WALL-CLOCK SECONDS -- $0.05/minute,
//   billed per second -- whether anyone is speaking or not. Every earlier probe
//   in this directory billed tokens, so a hung socket cost nothing and nobody
//   needed to care. Here a socket left open by a crashed script bills until
//   somebody notices, which is why `reserve()` takes a DURATION and every
//   caller is expected to close in a `finally`.
//
//   Backend (delegated Responses) tokens are billed separately and are the
//   smaller line. They are priced per million, as usual.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SPEND_FILE = path.join(HERE, "..", "spend-gptlive.json");

/** Authorised by the owner 2026-09-15 for this round only. Not raisable by me. */
export const CAP_USD = 5.0;

/** Voice layer: USD per SECOND of session wall clock. */
export const LIVE_USD_PER_SECOND = 0.05 / 60;

/** Backend and fallback models: USD per MILLION tokens. */
export const RATES = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2, source: "OpenAI pricing, 2026-07-30 cut" },
  "gpt-5.6-terra": { input: 2.0, output: 12.0, source: "OpenAI pricing, 2026-07-30 cut" },
  // Present only for the owner-authorised fallback if the Live transport is dead.
  "gpt-realtime-2.1": {
    audio_in: 32.0, audio_out: 64.0, cached_audio_in: 0.4,
    text_in: 4.0, text_out: 16.0, cached_text_in: 0.4,
    source: "analysis doc 4.1 (audio); text rates ASSUMED",
    assumed: ["text_in", "text_out", "cached_text_in"],
  },
};

export class BudgetExceeded extends Error {
  constructor(msg) { super(msg); this.name = "BudgetExceeded"; }
}

function blank() {
  return {
    cap_usd: CAP_USD,
    spent_usd: 0,
    entries: [],
    started_at: new Date().toISOString(),
    _: "GPT-Live round, 2026-09-15. Voice layer billed per wall-clock second; backend billed per token.",
  };
}

export function load() {
  try { return JSON.parse(fs.readFileSync(SPEND_FILE, "utf8")); } catch { return blank(); }
}

function save(state) {
  fs.writeFileSync(SPEND_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function spent() { return load().spent_usd; }
export function remaining() { return CAP_USD - spent(); }

/**
 * Check before opening a session. Throws rather than returning false: a probe
 * that "handles" a budget breach by continuing is the failure mode this exists
 * to prevent.
 *
 * @param {string} label
 * @param {number} maxSeconds - worst-case session duration, NOT the expected one.
 *   The per-session abort is 120s, so pass 120 unless the caller enforces less.
 * @param {number} [backendUsdGuess=0.01] - worst-case delegated token spend
 */
export function reserve(label, maxSeconds, backendUsdGuess = 0.01) {
  const estimateUsd = maxSeconds * LIVE_USD_PER_SECOND + backendUsdGuess;
  const state = load();
  const projected = state.spent_usd + estimateUsd;
  if (projected > CAP_USD) {
    throw new BudgetExceeded(
      `BUDGET: ${label} would take spend to $${projected.toFixed(4)} against the ` +
      `$${CAP_USD.toFixed(2)} cap (spent $${state.spent_usd.toFixed(4)}, ` +
      `worst case $${estimateUsd.toFixed(4)} for ${maxSeconds}s). Aborting.`
    );
  }
  return { spent: state.spent_usd, projected, remaining: CAP_USD - state.spent_usd };
}

/**
 * Price one Live session.
 *
 * `seconds` comes from session.usage.updated, whose docstring says the value is
 * a SESSION TOTAL and must not be summed across events. We therefore take the
 * last one seen, and fall back to measured wall clock if the server never sent
 * one -- a session that billed but reported nothing still cost money, and
 * recording zero would understate the bill.
 *
 * @param {object} args
 * @param {number} args.seconds - cumulative Live audio seconds (server-reported)
 * @param {number} [args.wallClockSeconds] - fallback if seconds is missing
 * @param {string} [args.backendModel]
 * @param {{input?:number, output?:number}} [args.backendTokens]
 */
export function priceLive({ seconds, wallClockSeconds, backendModel, backendTokens }) {
  const billedSeconds = typeof seconds === "number" && seconds > 0 ? seconds : (wallClockSeconds || 0);
  const estimated = !(typeof seconds === "number" && seconds > 0);
  const voiceUsd = billedSeconds * LIVE_USD_PER_SECOND;

  let backendUsd = 0;
  const breakdown = { voice: { seconds: billedSeconds, usd: voiceUsd, estimated } };
  if (backendModel && backendTokens) {
    const r = RATES[backendModel];
    if (r) {
      const inUsd = ((backendTokens.input || 0) / 1e6) * r.input;
      const outUsd = ((backendTokens.output || 0) / 1e6) * r.output;
      backendUsd = inUsd + outUsd;
      breakdown.backend = {
        model: backendModel,
        input: backendTokens.input || 0,
        output: backendTokens.output || 0,
        usd: backendUsd,
      };
    } else {
      breakdown.backend = { model: backendModel, usd: 0, error: `no rate card for ${backendModel}` };
    }
  }
  return { usd: voiceUsd + backendUsd, breakdown, estimated };
}

/**
 * Record actual spend. Called after EVERY session including failed ones -- a
 * session that errored mid-way still billed for the seconds it held open.
 *
 * The TypeError guard is carried over from lib/spend.js deliberately: on
 * 2026-09-07 a probe passed price()'s whole return object through as `usd`, the
 * reduce produced a string, `.toFixed` threw on every subsequent call, and
 * forty paid sessions were lost before anyone read the message.
 */
export function commit(entry) {
  if (entry?.usd !== undefined && typeof entry.usd !== "number") {
    throw new TypeError(
      `commit(): usd must be a number, got ${typeof entry.usd}. ` +
      "priceLive() returns an object -- pass priceLive(...).usd, not priceLive(...)."
    );
  }
  const state = load();
  state.entries.push({ at: new Date().toISOString(), ...entry });
  state.spent_usd = Number(state.entries.reduce((s, e) => s + (e.usd || 0), 0).toFixed(6));
  state.updated_at = new Date().toISOString();
  save(state);
  return state.spent_usd;
}

export function totalFor(probe) {
  return load().entries.filter((e) => e.probe === probe).reduce((s, e) => s + (e.usd || 0), 0);
}

export function summary() {
  const s = load();
  return {
    cap: CAP_USD,
    spent: s.spent_usd,
    remaining: CAP_USD - s.spent_usd,
    sessions: s.entries.length,
    byProbe: s.entries.reduce((acc, e) => {
      acc[e.probe || "?"] = Number(((acc[e.probe || "?"] || 0) + (e.usd || 0)).toFixed(6));
      return acc;
    }, {}),
  };
}
