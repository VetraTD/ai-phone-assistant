// ---------------------------------------------------------------------------
// Shared spend meter for the 2026-09-01 speech-to-speech probe run.
//
// PLAN.md rule 1: "$5.00 total ceiling, enforced in code." Enforced here, not
// by anybody remembering to look. Every probe calls `reserve()` before opening
// a session and `commit()` after it closes; `reserve()` throws BudgetExceeded
// when the projected spend would breach the cap, and the probe is expected to
// let that abort the run rather than catch it.
//
// State is persisted to spend.json so the ceiling holds ACROSS probes and
// across process restarts — a per-process counter would let five probes each
// spend $4.90.
//
// Rates are per MILLION tokens, from docs/speech-to-speech-vendor-analysis.md
// section 4.1. Where that table does not carry a rate (OpenAI text-modality
// tokens, which are a small fraction of a speech-to-speech session), the rate
// is marked `assumed: true` and the report says so, because a cost figure
// built partly on an assumed rate is not the same evidence as one built
// entirely on a published one.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SPEND_FILE = path.join(HERE, "..", "spend.json");

/**
 * Raised from $5.00 to $10.00 on 2026-09-02, explicitly authorised by the owner
 * to fund round 3 (tool reliability, plus the VAD/barge/slope arms that rounds
 * 1-2 ran on only one of the two finalists). The original $5.00 covered rounds
 * 1 and 2 and was never breached — $2.2383 of it was spent.
 */
export const CAP_USD = 10.0;

/** USD per million tokens. */
export const RATES = {
  "gemini-3.1-flash-live-preview": {
    audio_in: 3.0, audio_out: 12.0, text_in: 0.75, text_out: 4.5, cached_in: 0.075,
    source: "analysis doc 4.1",
  },
  "gemini-live-2.5-flash-native-audio": {
    audio_in: 3.0, audio_out: 12.0, text_in: 0.5, text_out: 2.0, cached_in: 0.05,
    source: "analysis doc 4.1",
  },
  "gpt-realtime-2.1": {
    audio_in: 32.0, audio_out: 64.0, cached_audio_in: 0.4,
    text_in: 4.0, text_out: 16.0, cached_text_in: 0.4,
    source: "analysis doc 4.1 (audio); text rates ASSUMED",
    assumed: ["text_in", "text_out", "cached_text_in"],
  },
  "gpt-realtime-2.1-mini": {
    audio_in: 10.0, audio_out: 20.0, cached_audio_in: 0.4,
    text_in: 0.6, text_out: 2.4, cached_text_in: 0.06,
    source: "analysis doc 4.1 (audio); text rates ASSUMED",
    assumed: ["text_in", "text_out", "cached_text_in"],
  },
};

export class BudgetExceeded extends Error {
  constructor(msg) { super(msg); this.name = "BudgetExceeded"; }
}

function blank() {
  return { cap_usd: CAP_USD, spent_usd: 0, entries: [], started_at: new Date().toISOString() };
}

export function load() {
  try {
    return JSON.parse(fs.readFileSync(SPEND_FILE, "utf8"));
  } catch {
    return blank();
  }
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
 * @param {string} label
 * @param {number} estimateUsd - worst-case cost of the session about to open
 */
export function reserve(label, estimateUsd) {
  const state = load();
  const projected = state.spent_usd + estimateUsd;
  if (projected > CAP_USD) {
    throw new BudgetExceeded(
      `BUDGET: ${label} would take spend to $${projected.toFixed(4)} against the ` +
      `$${CAP_USD.toFixed(2)} cap (spent $${state.spent_usd.toFixed(4)}, ` +
      `estimate $${estimateUsd.toFixed(4)}). Aborting.`
    );
  }
  return { spent: state.spent_usd, projected, remaining: CAP_USD - state.spent_usd };
}

/**
 * Price a usage record. Unknown keys are summed into `unpriced_tokens` and
 * reported rather than silently dropped — a token nobody could price is a fact
 * about the measurement, and hiding it would understate the bill.
 * @param {string} model
 * @param {object} usage - { audio_in, audio_out, text_in, text_out, cached_audio_in, ... }
 */
export function price(model, usage = {}) {
  const rates = RATES[model];
  if (!rates) return { usd: 0, unpriced_tokens: 0, error: `no rate card for ${model}` };
  let usd = 0;
  let unpriced = 0;
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

/**
 * Record actual spend. Called after every session, including failed ones — a
 * session that errored mid-way still billed for what it consumed.
 */
export function commit(entry) {
  const state = load();
  state.entries.push({ at: new Date().toISOString(), ...entry });
  state.spent_usd = Number(
    state.entries.reduce((s, e) => s + (e.usd || 0), 0).toFixed(6)
  );
  state.updated_at = new Date().toISOString();
  save(state);
  return state.spent_usd;
}

/** Total for one probe, for the report's cost column. */
export function totalFor(probe) {
  return load().entries.filter((e) => e.probe === probe).reduce((s, e) => s + (e.usd || 0), 0);
}

export function reset() { save(blank()); }
