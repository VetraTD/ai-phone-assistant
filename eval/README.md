# Conversation eval suite

A behavior test-bench for the receptionist brain. Each **scenario** drives a
simulated caller against the **real** production brain — the same prompt
assembly, tool dispatch, and reply-state reducer a live call uses
(`lib/harness/textSession.js`), minus audio, Twilio, Deepgram, ElevenLabs, and
Supabase. Capability reads/writes and post-turn notifications are served by the
in-memory fakes in `lib/harness/fakeDeps.js`.

Grading is two-tier:

- **Hard assertions** — deterministic `(ctx) => {pass, name, detail}` closures
  built from `eval/asserts.js`. They alone gate the process exit code. This is
  the measurement instrument, so it must be trustworthy: every helper is pure
  and unit-tested (`tests/evalAsserts.test.js`).
- **LLM judge** — an advisory pass/fail per `judge` question, scored by a pinned
  model (`eval/judge.js`). It never affects the exit code; it's signal for the
  human reading the report.

A full JSON report lands in `eval/results/`; a per-scenario table and verbatim
failure transcripts print to the console.

## Running

```bash
npm run chat                     # interactive REPL against the same brain (manual poking)
npm run eval                     # all scenarios, default model
npm run eval -- --filter cancel  # only scenarios whose NAME contains "cancel"
npm run eval -- --tag freetext   # only scenarios carrying the "freetext" TAG
npm run eval -- --judge          # ALSO run the advisory judge (off by default; see Cost)
npm run eval -- --concurrency 3  # scenarios in parallel (default 2)
npm run eval -- --model gemini-2.5-pro --temperature 0   # one-off model override
```

`--filter` matches on the scenario `name`; `--tag` matches an entry in its
`tags` array. Both narrow the set before anything runs (and before any spend).

`npm run chat` (`scripts/chat.js`) is the same harness in a REPL — type caller
turns, watch the receptionist reply and the tool calls. Use it to sanity-check a
new scenario's wording before you commit assertions to it.

### Model matrix

```bash
npm run eval -- --matrix --filter availability-before-book
npm run eval -- --matrix --matrix-file ./my-configs.json --tag booking
```

`--matrix` runs the (filtered) suite once per candidate model config, configs
**sequential** (so latency numbers reflect one config at a time), scenarios
within a config at `--concurrency`. Each config gets a one-call servability
preflight first, so a not-yet-GA model name is skipped cleanly instead of
burning the whole suite. `--matrix-file <path>` overrides the built-in default
config list with a JSON array of
`{label, model, temperature?, thinkingBudget?, maxOutputTokens?}` objects. The
judge always stays on its own pinned model regardless of the matrix. Results
land in one `eval/results/matrix-<ts>.json` with a comparison table.

## Cost expectations

**Measured 2026-08-29, from the usage recorded in `eval/results/*.json`. The
figures that used to be here ("roughly 90 turns", "a few cents") were wrong by
more than an order of magnitude, and that understatement is part of why a
month of iteration turned into a surprising bill.**

One full run of the suite:

| | |
|---|---|
| assistant turns | **~241** |
| prompt tokens (assistant only) | **~1.16M** |
| output tokens | ~7.6k |
| avg prompt per turn | **~4,840** |
| all-in with judge + persona caller | **~1.7M** |

Input dominates completely — roughly 93% of the bill — because the ~3,000-token
static prefix is re-sent on **every turn**. Output is a rounding error.

At the rate implied by one real month of billing (~$1.15 per 1M tokens;
re-derive it rather than trusting this), that is **~$1.50-2.00 per run** and
**~$10 for a 5-run band**. `--matrix` multiplies by the number of configs
(**×N**).

**How to not spend that:**

- `--filter`/`--tag` are nearly free and are the right default for iterating.
  The `regression` tag alone is a handful of scenarios.
- **The advisory judge is OFF by default** (changed 2026-08-30). It re-sends the
  whole transcript once per question for every scenario, and it **never affects
  the exit code** — the hard asserts alone decide pass/fail. Opt in with
  `--judge` for the run that decides a merge; leave it off for the dozens of
  runs that do not. (`--no-judge` still parses, so old scripts keep working.)
- **Every run now prints what it cost** at the end, and the same figures are
  written into the results JSON as `cost`. Assistant tokens only — the persona
  caller and the judge are separate clients whose usage never reaches the turn
  records, and that gap is roughly the ~1.16M vs ~1.7M difference in the table
  above.
- Running with `GEMINI_EXPLICIT_CACHE=true` caches the ~3,000-token prefix the
  harness otherwise re-sends on every one of its ~240 turns. The printed cost
  report shows the cached share and what it saved.
- Reserve full 5-run bands (`scripts/eval-band.js`) for merge decisions. A
  single run cannot tell a regression from noise anyway — identical code has
  scored 40, 38, 40, 38, 38.

## Adding a scenario

Drop a `NN-name.js` in `eval/scenarios/` with a default export. Study
`01`–`03` for the shape. The fields:

```js
export default {
  name: "my-scenario",                 // --filter matches this
  tags: ["freetext", "regression"],    // --tag matches an entry
  fixture: "appointments-db",          // a key in tests/fixtures/businessConfigs.js
  configPatch: { /* deep-merged over fixture.config */ },
  extrasPatch: { /* merged over fixture.extras (integrations, knowledge, …) */ },
  seedAppointments: [ /* pre-loaded rows for the fake store */ ],
  caller: {
    mode: "scripted",                  // fixed turns…
    turns: ["Hi, …", "Thanks!"],
    // …or persona: a sim-caller LLM improvises toward a goal
    // mode: "persona", persona: "You are …", goal: "…", maxTurns: 8,
  },
  hard: [ (ctx) => A.toolCalled(ctx, "book_appointment") ],
  judge: [ "Did the receptionist confirm the booking before ending the call?" ],
};
```

**`ctx` shape** the runner assembles for hard asserts: `toolCalls` (flat, in
order), `toolResults`, `turns` (`{caller, reply, toolCalls, …}`), `transcript`,
`finalState`, `store`.

**Assert helpers** (`eval/asserts.js`, all deterministic): `toolCalled` /
`toolNotCalled` / `toolCalledTimes` / `toolCalledAtMost`, `toolCalledWith` /
`toolNotCalledWith` (arg predicate), `toolOrder` / `toolBefore`,
`toolSucceeded`, `replySomewhereMatches` / `replyNeverMatches`,
`replyMatchesBeforeTool` (ordering: "asked before it acted"),
`toolNotCalledBeforeTurn`, `turnsAtMost`.

**Assertion design.** Keep hard asserts robust — a live-gated hard assert must
not flake. A good pattern (see `04`, `11`) is a **safety floor** the model
passes even doing nothing (e.g. "never booked the taken slot"), with the
positive/happy-path behavior carried by the advisory judge. Make each hard
assert **load-bearing** for what the scenario claims to test: if the thing under
test were removed, the assert should fail. A caller who *volunteers* the answer
you're checking makes the assert pass without exercising the feature — have the
caller prompt for it instead (see the free-text scenarios `21`–`24`).

**Time.** The brain reads the real wall clock, so express "next Tuesday at 3 PM"
/ "open now" **relative** to now via `eval/scenarioUtils.js` (`nextWeekdayAt`,
`spokenSlot`, `hoursOpenNow`, `slotMatches`, …) or the scenario passes at 2 PM
and fails at 2 AM.

## The free-text convention

Every operator-authored free-text field that reaches the model
(`generalInfo`, `customInstructions`, a capability's `notes`, knowledge-base
Q/A, a webhook `description`, …) must be:

1. **Delimiter-wrapped at injection** — inside `[BEGIN BUSINESS CONFIG] … [END
   BUSINESS CONFIG]` so PROMPT SAFETY can tell the model to treat it as data,
   never instructions. The structural invariant is enforced by
   **`tests/promptFreeText.test.js`** (it fails the moment a new field is
   injected raw). The two deliberate exceptions — the greeting context line and
   the custom identity `ask` script — are asserted OUTSIDE the delimiters there.
2. **Length-bounded** at validation (`lib/capabilities/configSchema.js`,
   `services/gemini.js` for webhook descriptions), so a runaway field can't
   bloat every prompt.
3. **Covered by a scenario here** — a `freetext`-tagged scenario proving the
   field actually reaches and steers the model. The `21`–`24` scenarios cover
   the operator channels: messages notes, quotes notes, custom-identity `ask`
   phrasing, and webhook descriptions. When you add a new free-text field, add a
   scenario that is load-bearing on it (strip the field → the hard assert
   fails), and re-run `--tag regression`.

## Env knobs

Overrides read at generation time (`services/gemini.js` `resolveGenerationConfig`);
CLI flags take precedence over env, env over the built-in defaults.

| Var | Default | Effect |
|---|---|---|
| `GEMINI_MODEL` | `gemini-3.6-flash` | Receptionist model. `--model` overrides. |
| `GEMINI_TEMPERATURE` | `0.4` | Sampling temperature. `--temperature` overrides. |
| `GEMINI_THINKING_BUDGET` | `0` | Thinking-token budget; `0` = no thinking, minimize latency. `--thinking-budget` overrides. |
| `GEMINI_MAX_OUTPUT_TOKENS` | `200` | Output cap per turn. Truncation telemetry (`MAX_TOKENS` turns) in the report tracks how often this bites. |
| `GEMINI_HISTORY_MAX_TURNS` | `20` | How many prior turns are replayed into the prompt. |
| `EVAL_JUDGE_MODEL` | `gemini-2.5-flash` | Model for the advisory LLM judge. 2.5-flash retires 2026-10-16 — bump this default before then. |
| `EVAL_SIMCALLER_MODEL` | `gemini-2.5-flash` | Model for the simulated caller in `mode: "sim"` scenarios. 2.5-flash retires 2026-10-16 — bump this default before then. |
| `ELEVENLABS_MODEL` | — | TTS model id (live pipeline only; inert in the text harness). |
| `ELEVENLABS_DISABLE_PREVIOUS_TEXT` | — | Drops the prior-text continuity hint sent to ElevenLabs (live pipeline only). |
| `STT_ENDPOINTING_MS` | — | Deepgram end-of-speech silence window (live pipeline only). |

The `ELEVENLABS_*` / `STT_*` knobs shape live-call audio behavior and have no
effect on the text-only eval; they're listed here as the single reference table.
