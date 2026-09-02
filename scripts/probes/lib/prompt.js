// ---------------------------------------------------------------------------
// The REAL system prompt and the REAL tool declarations.
//
// PLAN.md / owner instruction: "Use the REAL system prompt and the real tool
// declarations from services/gemini.js:489 (buildCallTools). A probe against a
// toy prompt measures a toy." Both vendors bill for and condition on the
// prefix, so a 40-token toy prompt would understate cost and overstate speed
// on every arm simultaneously.
//
// Fixture: `appointments-availability` (Brightwork Family Dental) — the test
// business the rest of the estate uses, and the only fixture that exercises
// booking + availability + an identity requirement, which is what makes the
// prompt its realistic ~3.5k tokens with 6 tools rather than a stub.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { FIXTURES } from "../../../tests/fixtures/businessConfigs.js";
import { buildSystemInstruction, buildCallTools } from "../../../services/gemini.js";

export const FIXTURE_KEY = "appointments-availability";

const fixture = FIXTURES[FIXTURE_KEY];
if (!fixture) throw new Error(`missing fixture ${FIXTURE_KEY}`);

/**
 * OPEN HOURS OVERRIDE — a judgement call, recorded here because it changes what
 * the probes measure.
 *
 * The fixture ships Mon-Fri 09:00-17:00 America/Chicago. This run happens at
 * ~01:30 local, so the unmodified fixture reports the office CLOSED, and the
 * first validation turn came back "Our office is currently closed, but I can
 * collect your details" — the after-hours message path. That path is shorter,
 * skips booking entirely, and calls fewer tools, so it would have understated
 * both the turn count and the cost on every arm at once.
 *
 * The caller fixtures are a booking conversation ("I'd like to book an
 * appointment", "Do you have anything Tuesday morning?", "Tuesday at ten works
 * for me"), so the office being open is what makes the script coherent. Only
 * the hours are changed; the prompt is still built by the real
 * buildSystemInstruction from the real config, through the real code path.
 */
const ALWAYS_OPEN = Object.fromEntries(
  ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [
    d,
    { open: "00:00", close: "23:59", closed: false },
  ])
);

export const BUSINESS_CONFIG = { ...fixture.config, businessHours: ALWAYS_OPEN };
export const BUSINESS_EXTRAS = fixture.extras;

/**
 * The joined static prefix + dynamic tail, exactly as a live call builds it.
 * `step: "greeting"` and `intent: null` is the opening state of a real call,
 * which is the state all five scripted turns start from.
 */
export const SYSTEM_PROMPT = buildSystemInstruction(
  "greeting",
  null,
  BUSINESS_CONFIG,
  BUSINESS_EXTRAS
);

/** Gemini shape: exactly what services/gemini.js hands the live model. */
export const GEMINI_TOOLS = buildCallTools(BUSINESS_CONFIG, { markerMode: false });

/**
 * OpenAI Realtime shape. Same declarations, flattened — Realtime takes
 * `{type:"function", name, description, parameters}` rather than Gemini's
 * `{functionDeclarations:[...]}` wrapper. The schemas themselves are passed
 * through untouched so both vendors see an identical tool surface; anything
 * else would make the two arms incomparable.
 */
export const OPENAI_TOOLS = GEMINI_TOOLS.functionDeclarations.map((d) => ({
  type: "function",
  name: d.name,
  description: d.description,
  parameters: d.parameters,
}));

export const TOOL_NAMES = GEMINI_TOOLS.functionDeclarations.map((d) => d.name);

export const PROMPT_STATS = {
  chars: SYSTEM_PROMPT.length,
  approx_tokens: Math.round(SYSTEM_PROMPT.length / 4),
  tools: TOOL_NAMES.length,
  business: BUSINESS_CONFIG.businessName,
  fixture: FIXTURE_KEY,
};

/** The five-turn conversation both L1/L2/L3 drive, per PLAN.md's fixture table. */
export const CONVERSATION_TURNS = [
  "clean_open",
  "rep_time_q",
  "rep_digits",
  "rep_confirm",
  "rep_close",
];
