// ---------------------------------------------------------------------------
// G0 -- validate the harness before spending anything on the vendor.
//
// WHY THIS EXISTS, in one paragraph: probe rounds 1 and 2 declared SIX tools
// where production declares TEN. No model in either round was ever offered
// check_appointment_availability, so none of them ever checked a slot, every
// transcript looped on "new or existing patient", and a published quality
// verdict had to be fully retracted the following day. Six harness defects were
// found that round against about four vendor defects.
//
// So: assert the rig is real, then DELIBERATELY BREAK each assertion and
// confirm it trips. A test that has never failed is not a passing test, it is
// an untested one. Costs $0 -- no sockets are opened here.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { SYSTEM_PROMPT, OPENAI_TOOLS, TOOL_NAMES, PROMPT_STATS, BUSINESS_CONFIG, BUSINESS_EXTRAS } from "./lib/prompt.js";
import { buildAllDeclarations } from "../../services/gemini.js";
import { FRONTEND_INSTRUCTIONS, BACKEND_INSTRUCTIONS, RESPONSES_DELEGATION } from "./lib/livePrompt.js";
import { FIXTURE_DIR, GROUND_TRUTH, loadUlaw } from "./lib/audio.js";
import { CAP_USD, spent, remaining } from "./lib/spendLive.js";

const FIXTURES = [
  "clean_open", "trailing_lead_in", "no_terminal_punct", "name_spelling",
  "rep_time_q", "rep_confirm", "rep_digits", "rep_close", "barge_in", "partial_digits",
];

const REQUIRED_TOOLS = [
  "check_appointment_availability", "book_appointment", "end_call", "set_call_intent",
];

/**
 * The count is NOT hardcoded, and this is the first thing G0 found.
 *
 * The assertion was written as `=== 10`, inherited from the round-3 correction
 * ("production declares 10"). It failed on the first run against 11, because
 * `add_appointment_note` shipped on 2026-09-05 (b63442c) after that round. The
 * harness was right and the constant was stale.
 *
 * So the check now compares the probe's tool list against production's own
 * union, `buildAllDeclarations` in services/gemini.js -- which carries the
 * comment "A second union drifts from this one the first time a capability is
 * added. There is one union, and this is it." scripts/probes/lib/prompt.js is
 * exactly that second union. It agrees today; this check is what notices when
 * it stops agreeing, without anybody having to remember a number.
 */
class HarnessError extends Error {}

/** Each check takes its subject as an argument so sabotage can pass a broken one. */
const CHECKS = {
  tools_match_production(names) {
    if (!Array.isArray(names)) throw new HarnessError("tool names not an array");
    const truth = buildAllDeclarations(BUSINESS_CONFIG, BUSINESS_EXTRAS, false).map((d) => d.name);
    const missing = truth.filter((t) => !names.includes(t));
    const extra = names.filter((t) => !truth.includes(t));
    if (missing.length || extra.length) {
      throw new HarnessError(
        `probe tool list has drifted from production's buildAllDeclarations: ` +
        `${missing.length} missing (${missing.join(",") || "-"}), ` +
        `${extra.length} extra (${extra.join(",") || "-"}). ` +
        "Rounds 1-2 ran with 6 of production's tools and the verdict had to be retracted."
      );
    }
    for (const t of REQUIRED_TOOLS) {
      if (!names.includes(t)) throw new HarnessError(`missing required tool: ${t}`);
    }
    return `${names.length} tools, matching production exactly`;
  },

  tool_schemas(tools) {
    if (!Array.isArray(tools) || !tools.length) throw new HarnessError("no tool declarations");
    for (const t of tools) {
      if (t.type !== "function") throw new HarnessError(`tool ${t.name}: type is ${t.type}, not "function"`);
      if (!t.name) throw new HarnessError("a tool declaration has no name");
      if (!t.parameters || typeof t.parameters !== "object") {
        throw new HarnessError(`tool ${t.name}: no parameters schema`);
      }
    }
    return `${tools.length} declarations well-formed for delegation.responses.tools`;
  },

  real_prompt(prompt) {
    if (typeof prompt !== "string") throw new HarnessError("prompt is not a string");
    if (prompt.length < 8000) {
      throw new HarnessError(
        `backend prompt is ${prompt.length} chars; the real production prefix is ~12k. ` +
        "A short prompt is the spike's ten-line prompt, which is what made LVX4 look like a model refusal."
      );
    }
    return `backend prompt ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`;
  },

  prompt_is_split(pair) {
    const { frontend, backend } = pair;
    if (frontend === backend) {
      throw new HarnessError("frontend and backend prompts are identical -- the migration guide says split, not copy");
    }
    if (frontend.length > 2000) {
      throw new HarnessError(
        `frontend prompt is ${frontend.length} chars; the voice model is documented as having a small context window`
      );
    }
    return `frontend ${frontend.length} chars, backend ${backend.length} chars`;
  },

  fixtures_real(labels) {
    const report = [];
    for (const label of labels) {
      const p = path.join(FIXTURE_DIR, `${label}.ulaw`);
      if (!fs.existsSync(p)) throw new HarnessError(`fixture missing: ${p}`);
      const buf = fs.readFileSync(p);
      if (buf.length < 4000) throw new HarnessError(`fixture ${label} is ${buf.length} bytes -- too short to be real audio`);
      if (buf.slice(0, 4).toString() === "RIFF") {
        throw new HarnessError(`fixture ${label} has a RIFF header; raw mu-law expected, a WAV header would be sent as audio`);
      }
      if (!GROUND_TRUTH[label]) throw new HarnessError(`fixture ${label} has no GROUND_TRUTH entry -- WER cannot be computed`);
      report.push(`${label} ${buf.length}B ${(buf.length / 8000).toFixed(2)}s`);
    }
    return report.join(", ");
  },

  delegation_shape(d) {
    if (d?.type !== "responses") throw new HarnessError(`delegation.type is ${d?.type}, expected "responses"`);
    if (!d.responses?.model) throw new HarnessError("delegation.responses.model missing");
    if (!d.responses?.instructions) throw new HarnessError("delegation.responses.instructions missing");
    const want = buildAllDeclarations(BUSINESS_CONFIG, BUSINESS_EXTRAS, false).length;
    if (!Array.isArray(d.responses?.tools) || d.responses.tools.length !== want) {
      throw new HarnessError(`arm R declares ${d.responses?.tools?.length} tools to the backend, production has ${want}`);
    }
    return `arm R: ${d.responses.model}, ${want} tools, parallel_tool_calls=${d.responses.parallel_tool_calls}`;
  },

  budget_headroom(state) {
    if (state.remaining <= 0) throw new HarnessError(`no budget left: $${state.spent} of $${state.cap}`);
    if (state.remaining < 3.0) {
      throw new HarnessError(
        `only $${state.remaining.toFixed(2)} left of $${state.cap}; the round's worst case is $3.76`
      );
    }
    return `$${state.remaining.toFixed(2)} of $${state.cap.toFixed(2)} available`;
  },
};

/**
 * Each sabotage must trip its own check. If a sabotage PASSES, the check is
 * decorative and the harness is not validated.
 */
const SABOTAGE = {
  tools_match_production: () => TOOL_NAMES.slice(0, 6),          // the actual round-1/2 defect
  tool_schemas: () => [{ type: "function", name: "x" }],         // no parameters
  real_prompt: () => "You are a receptionist. Be helpful.",      // the spike's ten-line prompt
  prompt_is_split: () => ({ frontend: SYSTEM_PROMPT, backend: SYSTEM_PROMPT }),
  fixtures_real: () => ["clean_open_DOES_NOT_EXIST"],
  delegation_shape: () => ({ type: "responses", responses: { model: "m", instructions: "i", tools: [] } }),
  budget_headroom: () => ({ cap: CAP_USD, spent: 4.9, remaining: 0.1 }),
};

const SUBJECTS = {
  tools_match_production: () => TOOL_NAMES,
  tool_schemas: () => OPENAI_TOOLS,
  real_prompt: () => BACKEND_INSTRUCTIONS,
  prompt_is_split: () => ({ frontend: FRONTEND_INSTRUCTIONS, backend: BACKEND_INSTRUCTIONS }),
  fixtures_real: () => FIXTURES,
  delegation_shape: () => RESPONSES_DELEGATION,
  budget_headroom: () => ({ cap: CAP_USD, spent: spent(), remaining: remaining() }),
};

function main() {
  const results = { checks: {}, sabotage: {}, ok: true };

  console.log("G0 -- harness validation. No sockets, $0.\n");
  console.log("real checks");
  for (const [name, fn] of Object.entries(CHECKS)) {
    try {
      const detail = fn(SUBJECTS[name]());
      results.checks[name] = { pass: true, detail };
      console.log(`  PASS  ${name}: ${detail}`);
    } catch (err) {
      results.checks[name] = { pass: false, error: err.message };
      results.ok = false;
      console.log(`  FAIL  ${name}: ${err.message}`);
    }
  }

  console.log("\nsabotage -- each of these MUST trip its check");
  for (const [name, broken] of Object.entries(SABOTAGE)) {
    let tripped = false;
    let msg = "";
    try {
      CHECKS[name](broken());
    } catch (err) {
      tripped = err instanceof HarnessError;
      msg = err.message;
    }
    results.sabotage[name] = { tripped, message: msg };
    if (tripped) {
      console.log(`  TRIPPED  ${name}: ${msg.split("\n")[0].slice(0, 90)}`);
    } else {
      results.ok = false;
      console.log(`  NOT TRIPPED  ${name}  <-- this check is decorative; the harness is NOT validated`);
    }
  }

  console.log(`\nprompt stats: ${JSON.stringify(PROMPT_STATS)}`);
  console.log(`fixtures: ${FIXTURES.length}`);
  const durations = FIXTURES.map((l) => loadUlaw(l).seconds);
  console.log(`fixture audio total: ${durations.reduce((a, b) => a + b, 0).toFixed(2)}s`);

  fs.writeFileSync(
    "scripts/probes/results-g0.json",
    JSON.stringify({ at: new Date().toISOString(), ...results }, null, 2) + "\n"
  );

  console.log(`\nG0 ${results.ok ? "PASSED" : "FAILED"}`);
  if (!results.ok) process.exit(1);
}

main();
