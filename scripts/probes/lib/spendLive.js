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

/**
 * Authorised by the owner for this round only. Not raisable by me.
 *
 * 2026-09-15: $5.00, for the GPT-Live gate round.
 * 2026-09-15 (later, in session): raised to $25.00 by the owner, in writing, to
 *   cover the gemini-3.8-live comparison round -- the T-gates, the repaired
 *   booking harness, and the agentic multi-step arms on BOTH vendors. $3.40 of
 *   the original $5.00 was already spent when it was raised, so the headroom
 *   this round actually has is ~$21.60, not $25.00.
 */
export const CAP_USD = 25.0;

/** Voice layer: USD per SECOND of session wall clock. */
export const LIVE_USD_PER_SECOND = 0.05 / 60;

/** Backend and fallback models: USD per MILLION tokens. */
export const RATES = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2, source: "OpenAI pricing, 2026-07-30 cut" },
  "gpt-5.6-terra": { input: 2.0, output: 12.0, source: "OpenAI pricing, 2026-07-30 cut" },
  // Gemini 2.5 native audio, for the residency-path comparison. Token-billed,
  // not wall-clock billed -- the two vendors meter differently and the report
  // must not pretend otherwise.
  "gemini-live-2.5-flash-native-audio": {
    audio_in: 3.0, audio_out: 12.0, text_in: 0.5, text_out: 2.0, cached_in: 0.05,
    source: "analysis doc 4.1",
  },
  // gemini-3.8-live, GA 2026-09-15. Google's launch post quotes $0.005/min of
  // audio in and $0.018/min out, and states those are derived from $3/1M input
  // and $12/1M output -- i.e. the SAME per-token audio rates as 2.5. The
  // per-minute figure is the derived one, so pricing stays per-token here and
  // the two Gemini arms remain comparable line for line.
  //
  // The 2026-09-15 pilot (probe M38) priced this model on the 2.5 card with
  // HARDCODED token counts rather than usageMetadata, so its $0.093 is a guess,
  // not a measurement. Anything quoting it must say so.
  "gemini-3.8-live": {
    audio_in: 3.0, audio_out: 12.0, text_in: 0.5, text_out: 2.0, cached_in: 0.05,
    source: "Google launch post 2026-09-15 ($0.005/min in, $0.018/min out, from $3/$12 per 1M)",
    assumed: ["text_in", "text_out", "cached_in"],
  },
  "gemini-3.8-live-extended-thinking": {
    audio_in: 3.0, audio_out: 12.0, text_in: 0.5, text_out: 2.0, cached_in: 0.05,
    source: "same card as gemini-3.8-live; thinking tokens NOT separately priced here",
    assumed: ["text_in", "text_out", "cached_in"],
  },

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

/**
 * Fallback pricing for a Gemini Live session whose usageMetadata never arrived.
 *
 * WHY THIS EXISTS. The first T1 smoke run priced one of two sessions at exactly
 * $0.0000 because usageMetadata had not arrived before the socket closed. A
 * session that billed and reported nothing still cost money, and recording zero
 * understates the round -- which is harness defect #7 from the 2026-09-01 round
 * ("usage overwritten instead of accumulated, under-reporting a multi-turn call
 * 3-4x") wearing a different hat.
 *
 * Google publishes gemini-3.8-live at $0.005 per minute of audio IN and $0.018
 * per minute of audio OUT, so measured audio duration prices the session
 * directly without guessing a tokens-per-second ratio. Every caller MUST mark
 * the result estimated, because it is.
 *
 * @param {object} args
 * @param {number} [args.inSeconds]  - caller audio actually sent
 * @param {number} [args.outSeconds] - model audio actually received
 */
export const GEMINI_LIVE_USD_PER_MIN = { audio_in: 0.005, audio_out: 0.018 };

export function priceGeminiByMinutes({ inSeconds = 0, outSeconds = 0 }) {
  const usd =
    (inSeconds / 60) * GEMINI_LIVE_USD_PER_MIN.audio_in +
    (outSeconds / 60) * GEMINI_LIVE_USD_PER_MIN.audio_out;
  return {
    usd,
    estimated: true,
    breakdown: { inSeconds, outSeconds, ...GEMINI_LIVE_USD_PER_MIN },
    source: "Google launch post 2026-09-15, per-minute audio rates",
  };
}

/**
 * Price a TOKEN-billed session (Gemini). Kept separate from priceLive() because
 * conflating a per-second bill with a per-token one is how a cost comparison
 * quietly becomes wrong.
 */
export function priceTokens(model, usage = {}) {
  const rates = RATES[model];
  if (!rates) return { usd: 0, unpriced_tokens: 0, error: `no rate card for ${model}` };
  let usd = 0, unpriced = 0;
  const breakdown = {};
  for (const [k, tokens] of Object.entries(usage)) {
    if (!tokens || typeof tokens !== "number") continue;
    const rate = rates[k];
    if (typeof rate !== "number") { unpriced += tokens; continue; }
    const line = (tokens / 1e6) * rate;
    breakdown[k] = { tokens, rate, usd: line };
    usd += line;
  }
  return { usd, breakdown, unpriced_tokens: unpriced };
}
