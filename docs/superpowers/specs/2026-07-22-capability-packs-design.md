# Capability Packs — generalizing the AI receptionist across businesses

**Status:** implemented 2026-07-22
**Branch:** `feat/voice-v2` → to be executed after merge to `main`
**Supersedes:** the task-module model documented in `database/013_task_modules.sql`

---

## 1. Problem

The service must serve any local SMB — clinics, plumbers, law firms, salons. Today every
business-specific behavior is hardcoded across the engine.

`services/supabase.js:35-44` already splits CORE tasks (always-on) from opt-in MODULE
tasks. But `allowed_tasks` is only an on/off switch. What a module *does* is smeared
across six files:

| Concern | Location today |
|---|---|
| Module list | `services/supabase.js:36` — closed enum |
| Tool registration | `services/gemini.js:109` — `if (allowedTasks.includes("book_appointment"))` |
| Capability sentence | `services/gemini.js:613-639` — if-chain |
| Booking script | `services/gemini.js:872-880` — 5 hardcoded steps |
| Cancel/reschedule script | `services/gemini.js:846-856` — forks on EHR presence |
| Message script | `services/gemini.js:645-656` — 6 hardcoded steps |
| Tool execution | `services/tools.js:329` — one switch, 8 cases |
| EHR detection | `services/gemini.js:388,796` — `provider === "athenahealth"` literal |
| State effects | `services/gemini.js:1046-1070`, `lib/voice/session.js` `applyReply` — `appointmentArgs`, `customerRequestArgs` named explicitly |
| Settings UI | `AI-phone-dashboard/frontend/src/settings/TasksSection.jsx` — hand-written checkboxes |

Adding one capability (billing, insurance, quotes) means editing all six. Doing that five
more times makes `gemini.js` unmaintainable. Worse: none of those edits let Business A and
Business B do the *same* capability differently.

**Outcome sought.** Adding a capability becomes one new file. Making two businesses behave
differently becomes a config change. Swapping athenahealth → Cerner → Google Calendar
becomes an adapter swap with the prompt untouched.

---

## 2. Decisions

1. **Target: any local SMB**, not healthcare-only. Healthcare is one pack among many.
2. **Concierge onboarding now, self-serve later.** The config schema is the contract for
   both. No dashboard UI in this pass.
3. **Hybrid config.** Structured and code-enforced *only* where being ignored causes harm
   (identity, confirmation gates, adapter routing). Free-text prose for everything else.
   Decision test: *"if the AI ignores this, does someone get hurt, sued, or angry?"*
4. **Kinds vs values.** The engine owns ~6 *kinds* of rule. Operators supply unlimited
   *values*. A custom identity field ("dental number") is a new value of an existing kind —
   zero code.
5. **`collect_only` first**, `verify_against` later. Custom fields must be collected before
   a write tool runs; comparing them against a backend record is deferred (needs athena
   production access, weeks-to-months out).
6. **Sequencing:** merge `feat/voice-v2` → this refactor → GCP migration. One variable at a
   time. The athena partner-access wait provides the window, and per-tenant adapter routing
   here directly serves the migration's per-tenant voice-vendor routing.
7. **Scope: move, enforce, prove.** Retrofit existing capabilities with zero behavior
   change, add enforcement, then build a brand-new capability as a falsifiable test.

**Explicitly not doing:** a workflow DSL or node-graph builder. Inventing a JSON keyword per
customer need is the same trap in a new costume.

---

## 3. Architecture

```
ENGINE            hardcoded, never per-tenant
                  lib/voice/* turn-taking, VAD, barge-in, TTS/STT, circuit breakers,
                  step machine, FC loop, fallback, safety guardrails, prompt structure
                    ↑ provides primitives: setStep, notify, refuseTool
CAPABILITY PACKS  one file each, code-declared
                  capabilities/appointments.js | messages.js | transfer.js | quotes.js
                    ↑ reads
TENANT CONFIG     data, per business
                  business_capabilities rows: enabled, adapter, require{}, notes
                    ↓ routes to
ADAPTERS          code, swappable per tenant, one interface per capability kind
                  adapters/scheduling/{internalDb,athenahealth,googleCalendar,webhook}.js
```

### 3.1 The pack contract

```js
// capabilities/appointments.js
export default {
  id: "appointments",
  core: false,                       // true = always on, not opt-in

  configSchema: { ... },             // validates config; later drives generated UI

  adapterKind: "scheduling",         // null for self-contained capabilities

  tools(cfg, ctx) { ... },           // function declarations, incl. { isAction: true }
  prompt(cfg, ctx) { ... },          // { static: {...}, dynamic: { stepGuidance } }
  requirements(cfg) { ... },         // the enforced kinds
  async execute(toolName, args, ctx) { ... },   // {functionResponse, stateEffects}
  onEffect(effect, engineCtx) { ... },          // step transitions, notifications
};
```

### 3.2 The enforced kinds

All the structured config there will ever be. Operators add values; only we add kinds.

| Kind | Meaning |
|---|---|
| `identity` | facts required before a write tool may run — builtin + custom |
| `confirmBeforeWrite` | read-back and explicit yes required |
| `requiredFields` | tool refuses without these args |
| `businessHoursOnly` | no writes while closed |
| `adapter` | which backend this capability writes to |
| `notes` | prose, unenforced, pasted into the prompt |

### 3.3 Custom identity fields

Operator-supplied values of an existing kind. No code per field.

```json
"require": {
  "identity": {
    "builtin": ["name", "dob"],
    "custom": [{
      "key": "dental_number",
      "label": "Dental number",
      "ask": "And your dental number — the six digits on your card?",
      "pattern": "^[0-9]{6}$",
      "verify": "collect_only"
    }]
  },
  "confirmBeforeWrite": true
}
```

`collect_only` means the write tool refuses to run until the field is collected and matches
`pattern`. It does **not** compare the value against a record — that is `verify_against`,
deferred. `verify` is present from day one so upgrading a single field later is a config
change, not a migration or engine edit.

Each adapter publishes `verifiableFields: []`. The (future) settings UI can therefore only
offer guarantees the backend can actually deliver — a business on a webhook adapter cannot
configure verification the webhook cannot perform.

### 3.4 Worked example — two businesses, one codebase

Riverside Family Clinic:

```json
{
  "appointments": {
    "enabled": true,
    "adapter": "athenahealth",
    "require": { "identity": { "builtin": ["name", "dob"] }, "confirmBeforeWrite": true },
    "notes": "Ask morning or afternoon first. Never offer Friday afternoon — Dr. Chen is in surgery."
  },
  "quotes": { "enabled": false }
}
```

Dave's Plumbing:

```json
{
  "appointments": { "enabled": false },
  "quotes": {
    "enabled": true,
    "adapter": "webhook",
    "require": { "identity": { "builtin": ["name", "callback_number"] }, "confirmBeforeWrite": false },
    "notes": "Always ask whether it's an emergency first. Never quote a price over the phone."
  }
}
```

Different capabilities, backends, enforced rules and phrasing. Zero lines of code differ.

---

## 4. Implementation

### Step A — Move, don't change

Rule: byte-identical prompt output, zero behavior change.

**Create:** `capabilities/_contract.js`, `capabilities/index.js` (registry),
`capabilities/appointments.js`, `capabilities/messages.js`, `capabilities/transfer.js`,
`lib/capabilities/promptAssembler.js`, `lib/capabilities/datetime.js`.

**Modify:** `services/gemini.js` (three tool builders collapse to one registry loop;
prompt section bodies come from the assembler), `services/tools.js` (switch → registry
dispatch; `set_call_intent` and `end_call` stay engine-owned), `services/supabase.js`
(`MODULE_TASKS` derived from the registry), `lib/voice/session.js` (named state effects →
generic `capabilityEffects` channel plus per-capability scratchpad).

The prompt assembler **must preserve the static-prefix / dynamic-tail split**
(`gemini.js:523` vs `gemini.js:731`). Gemini implicit caching hits on a stable prefix, so
only step/intent-dependent fragments may land in the tail.

The `session.js` state-effect generalization is the highest-risk edit: the booking
idempotency anchor, the system-note history injection, and the barge-in salvage path all
key off `appointmentArgs` today. It gets its own commit with `tests/session.test.js` as the
gate.

### Step B — Enforcement and config surface

**Create:** `lib/capabilities/requirements.js` (evaluates the kinds before `execute` runs;
generalizes the hand-rolled `appointmentBelongsToCaller` at `tools.js:72` and
`verifyAppointmentIdentity` at `tools.js:289`), `adapters/scheduling/*`,
`database/020_business_capabilities.sql`.

The scheduling adapter interface: `findSlots`, `book`, `cancel`, `reschedule`,
`lookupByCaller`, `verifiableFields`. `adapters/scheduling/athenahealth.js` wraps the
existing 44KB `integrations/athenahealth.js` — logic unchanged, no rewrite.

Table `business_capabilities (business_id, capability_id, enabled, adapter,
adapter_config jsonb, config jsonb)`, backfilled from `businesses.allowed_tasks`, with
**dual-read for one release** so a partial deploy cannot silently disable a business's
capabilities. Separation from the existing `integrations` table: `integrations` holds the
connection and credentials; `business_capabilities.adapter` selects which connection a
capability uses.

### Step C — Prove the seam

Build `capabilities/quotes.js` end to end: caller asks about pricing → AI collects name,
callback number, service description, address → fires a notification or webhook.

Chosen because it is shaped unlike appointments in every dimension that matters: no
external scheduling system, no availability search, no confirmation gate, notification
instead of a DB write, loose identity. With appointments (stateful, strict, adapter-backed)
and messages (stateless, notification-only) that is three distinct shapes — the minimum
needed to know the abstraction is real rather than an appointment framework in disguise.

**Falsifiable test:** implementing `quotes` must not require editing `services/gemini.js`,
`services/tools.js`, or `lib/voice/session.js`. If it does, the seam is wrong and gets
fixed — which is the entire point, and costs three days here instead of three months later.

---

## 4b. What shipped, and what changed along the way

All of the above is implemented. Four things diverged from the plan, each for a
reason worth recording.

**Step C was pulled ahead of Step B.** Migrating the booking path — idempotency
anchor, owner notification, confirmation SMS, barge-in salvage — onto an
abstraction nothing had exercised is backwards. `capabilities/quotes.js` was
built on the new effect channel first, proving it, and the delicate paths
migrated onto something already working. Step C's falsifiable test passed: zero
changes to `services/gemini.js`, `services/tools.js` or `lib/voice/session.js`.

**`lib/mediaStream.js` is not dead.** `server.js` selects it when
`PIPELINE_V2=false`, and it held its own duplicate of every appointment side
effect. Migrating only the v2 pipeline would have left the documented rollback
path silently not notifying owners about bookings and not persisting messages at
all. Both pipelines now share `lib/capabilities/effects.js`; the duplication was
what made the trap possible. That pipeline still has no test harness of its own.

**Packs may not import the registry either.** The original rule was "packs take
no service imports". It is stronger: `capabilities/index.js` imports every pack,
so a pack importing it back is a cycle whose failure depends on load order —
importing a pack directly (as its unit test does) evaluated the registry while
that pack was still in flight. `capabilityConfig` therefore lives in the leaf
requirements module.

**A deliberate behaviour change.** A completed action now wins the step over a
same-turn intent change. Previously a cancel lost and a booking won, purely from
where each sat in `applyReply`.

Defects found and fixed on the way, each caught by a test rather than by review:

| Defect | Consequence had it shipped |
|---|---|
| `BUILTIN_TOOL_NAMES` reserved 4 names while packs declared 13 | a webhook named `request_transfer` silently never runs |
| `normalizeAllowedTasks` treated `[]` and unset alike | no business could say "we do not do appointments" |
| `log.warn` does not exist in `lib/logger.js` | throws exactly when a config is invalid |
| `stepExtras` dropped `integrations` after adapter routing | an EHR clinic told to call a tool it does not have |
| `flushUntil` bounded by tick count, not wall time | intermittent CI failures with no defect behind them |

## 5. Verification

1. `npx vitest run` — 523 existing tests green, unmodified, plus new suites.
2. `tests/promptSnapshot.test.js` — golden-file the full system instruction for three
   fixture configs, written **before** any refactoring; byte-for-byte identical after.
3. Live call on the dev Twilio number + ngrok (`docs/LOCAL_TESTING.md`):
   - Fixture A (clinic): appointments on, identity `["name","dob"]` plus a custom
     `dental_number` — confirm booking is refused at the tool layer without it, not merely
     discouraged in the prompt.
   - Fixture B (plumber): appointments off, quotes on — confirm no appointment tools are
     registered and quote collection completes.
   - Same code path both calls; config is the only difference.
4. `node scripts/watch-call.js` — no turn latency regression from registry dispatch.
5. `git diff --stat` across Step C — zero lines changed in the three engine files.

---

## 6. Deferred

- **Schema-driven dashboard UI.** Every pack declares a `configSchema` and the
  vocabulary is renderable; nothing consumes it yet. Build at 3-4 customers, once
  the schemas have stopped moving. Until then concierge onboarding writes rows
  directly.
- **`verify_against`.** The config field exists and each adapter already
  publishes `verifiableFields`, so upgrading one field is a config change rather
  than a refactor. Needs athena production access to test against.
- **A test harness for `lib/mediaStream.js`**, or a decision to delete it. Its
  effect wiring is verified by inspection and a module-load check only. Given v2
  carries ~40 commits of turn-taking fixes it lacks, the rollback may already be
  a trap for unrelated reasons.
- **Dropping `businesses.allowed_tasks`.** The dual-read exists so a partial
  deploy cannot disable a tenant's capabilities mid-call. Drop it once every
  environment is on migration 020.
- **The dashboard's mirrored reserved-name list.** A separate CJS app that cannot
  import the ESM registry, so the list is duplicated by hand. A test fails when
  the two diverge, but it is still a hand-maintained copy.
- Billing and insurance capabilities — build on the proven pattern.
- Treating the `notes` prose box as a feature-request funnel: themes that recur
  across customers get promoted from prose to enforced kinds.
