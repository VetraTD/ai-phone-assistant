/**
 * Pure helpers for scripts/chat.js — argv parsing and terminal-line
 * formatting. Extracted so the formatter (the one non-trivial piece of
 * rendering logic — tool-call lines, incl. long-arg truncation) can be unit
 * tested without spinning up readline or a real Gemini call.
 */

/** Recognised --flags and how many argv slots they consume (all take 1 value, except --list-fixtures). */
const VALUE_FLAGS = {
  "--fixture": "fixture",
  "--model": "model",
  "--thinking-budget": "thinkingBudget",
  "--max-output-tokens": "maxOutputTokens",
  "--temperature": "temperature",
  "--seed-appointments": "seedAppointments",
};
const NUMERIC_KEYS = new Set(["thinkingBudget", "maxOutputTokens", "temperature", "seedAppointments"]);
const MODEL_OVERRIDE_KEYS = new Set(["model", "thinkingBudget", "maxOutputTokens", "temperature"]);

/**
 * Parse scripts/chat.js's argv (process.argv.slice(2)) into options.
 * Unknown flags are ignored — this is a small dev tool, not a CLI framework.
 * @param {string[]} argv
 * @returns {{ fixture: string|null, listFixtures: boolean, modelOverrides: object, seedAppointments: number }}
 */
export function parseArgs(argv) {
  const opts = { fixture: null, listFixtures: false, modelOverrides: {}, seedAppointments: 0 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list-fixtures") {
      opts.listFixtures = true;
      continue;
    }
    const key = VALUE_FLAGS[arg];
    if (!key) continue;
    const raw = argv[++i];
    const value = NUMERIC_KEYS.has(key) ? Number(raw) : raw;
    if (key === "seedAppointments") {
      opts.seedAppointments = Number.isFinite(value) ? value : 0;
    } else if (MODEL_OVERRIDE_KEYS.has(key)) {
      if (typeof value === "string" || Number.isFinite(value)) opts.modelOverrides[key] = value;
    } else if (raw !== undefined) {
      // Dangling `--fixture` as the last argv token (no value follows) leaves
      // `raw` undefined — keep the documented `fixture: string|null` shape
      // instead of assigning `undefined`.
      opts.fixture = value;
    }
  }
  return opts;
}

/** First fixture (in declaration order) whose config takes appointments. */
export function defaultFixtureName(fixtures) {
  for (const [name, fx] of Object.entries(fixtures)) {
    if (fx.config?.allowedTasks?.includes("book_appointment")) return name;
  }
  return Object.keys(fixtures)[0] ?? null;
}

/** One-line "--list-fixtures" summary for a fixture entry. */
export function summarizeFixture(name, fixture) {
  const tasks = fixture?.config?.allowedTasks?.join(", ") || "(none)";
  return `${fixture?.config?.businessName ?? "?"} — ${tasks}`;
}

/** Render a value for a tool-call line, truncating long strings to `max` chars. */
export function truncateValue(value, max = 60) {
  if (value === undefined) return "undefined";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Render a tool call's args as a compact `{key: val, ...}` string. */
export function formatArgs(args) {
  if (!args || typeof args !== "object" || Object.keys(args).length === 0) return "{}";
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${truncateValue(v)}`);
  return `{${parts.join(", ")}}`;
}

/**
 * One dimmed line for a tool call + its (possibly missing) result, in call order.
 * @param {{name:string, args?:object}} call
 * @param {{success?:boolean, message?:string}|undefined} result
 */
export function formatToolCallLine(call, result) {
  const status = result ? (result.success ? "success" : "failure") : "pending";
  const message = result?.message ? ` ${result.message}` : "";
  return `  [tool] ${call.name}(${formatArgs(call.args)}) → ${status}${message}`;
}

/** The "(step: X, intent: Y, 1.2s)" status line printed after each reply. */
export function formatStatusLine(state, totalMs) {
  const secs = typeof totalMs === "number" ? (totalMs / 1000).toFixed(1) : "?";
  return `  (step: ${state?.step ?? "?"}, intent: ${state?.intent ?? "none"}, ${secs}s)`;
}

/**
 * N fake appointments spread one-per-day over the next week, for
 * --seed-appointments. Kept deterministic-ish (relative to `now`) rather than
 * pinned to a fixed date, since it only feeds a manual test session.
 * @param {number} n
 * @param {object} [opts]
 * @param {string|null} [opts.businessId]
 * @param {number} [opts.now]
 */
export function makeSeedAppointments(n, { businessId = null, now = Date.now() } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const day = new Date(now + (i + 1) * 24 * 60 * 60 * 1000);
    day.setUTCHours(10 + (i % 6), 0, 0, 0);
    rows.push({
      business_id: businessId,
      client_name: `Test Patient ${i + 1}`,
      client_phone: "+15550001111",
      scheduled_at: day.toISOString(),
      status: "scheduled",
    });
  }
  return rows;
}
