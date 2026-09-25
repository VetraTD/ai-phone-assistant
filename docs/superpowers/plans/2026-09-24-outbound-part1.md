# Outbound Calling, Part 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the receptionist a second door. It places calls to allow-listed numbers through the same Gemini Live engine inbound uses, with:
- a consent-and-window gate enforced in code;
- a double-dial lock;
- async answering-machine detection (AMD) and a listen-first opening, with a Live-voiced backstop line;
- retries and exactly-once post-call processing;
- a qualifier, callback, opt-out and outcome;
- a signed results webhook;
- a dashboard;
- a live demo that books into the built-in calendar.

**Architecture:** Postgres (Cloud SQL, RLS) is the source of truth for every lead and attempt. Cloud Tasks wakes the dialer at each attempt's due time, and a 5-minute Cloud Scheduler sweep is the safety net. Answered calls join the EXISTING `/twilio/live-stream/<token>` session through a new `/twilio/outbound-answer` door, carrying an outbound call context resolved by CallSid. Everything outbound is off by default (`OUTBOUND_ENABLED=false`) except allow-listed test numbers. Inbound code paths are untouched when the stream carries no `direction` parameter.

**Tech stack:**
- Node 22 ESM, Express 5, `ws`, `@google/genai` (Gemini Live), `twilio` v5, `pg`
- `@google-cloud/tasks` (NEW), `jsonwebtoken` + `jwks-rsa`. Outbound does **not** use `@google-cloud/text-to-speech`; clips are rendered by Gemini Live (spec D6, revised).
- vitest (root suite, plus `tests/db` against local Postgres 16)
- Dashboard: React 19 / Vite frontend, Express 5 CommonJS backend

**Spec:** `docs/superpowers/specs/2026-09-24-outbound-calling-design.md` (the build contract). Companion page: https://claude.ai/artifact/3379bzmqHG1gVDSQB2mdrv. Where the two disagree, the spec wins. Where this plan corrects the spec (§0.3 below), the correction is flagged for the owner and the spec is amended in the same commit as the task that needs it.

---

## 0. Before anything

### 0.1 Global constraints (copied from the spec, verbatim where quoted)

- **Migrations** start at **042**.
  - Every migration is checksummed and never edited once applied.
  - Every migration is folded into `database/schema.sql` in the same commit. `tests/schema.test.js` and `tests/db/schemaParity.test.js` enforce this.
  - **The migration test loop.** `npm run db:reset` applies ONLY `schema.sql` and records every migration file as already applied (`scripts/migrate.js:290-303`). A reset therefore never runs a new migration. It follows that:
    1. Task 0 runs `db:reset` **before** any `04x` file exists.
    2. Each task's green step runs `npm run db:migrate`, which applies the new file from the migrations directory, then its tests, then `schemaParity`. `schemaParity` builds a scratch database from `schema.sql` and compares it with the migrated one, which is what makes the fold honest.
    3. Every **sabotage** edits the `schema.sql` copy and then runs `db:reset`, because an applied migration file cannot be edited: its checksum would refuse. The revert goes back to `schema.sql` plus `db:reset`, followed by `db:migrate` so the database is back on the file-applied path.
  - **Fold rule for foreign keys to later tables.** A column added to an early table (e.g. `calls`) that REFERENCES a table created later in `schema.sql` is declared inline **without** `REFERENCES`. The constraint is added by `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …` after that later table's section. `tests/schema.test.js:108-122` reads columns from the `CREATE TABLE` body, so the columns must stay inline.
- **Tenant scoping.** Every tenant-scoped write runs inside `withTenant(businessId, …)` / `withTenantSafe`, and every test asserts that the row actually landed.
  - The reason: the service runs as `vetra_app` NOBYPASSRLS, so a tenantless write matches zero rows and reports success.
- **FORCE RLS binds a SECURITY DEFINER function's owner as well.** On Cloud SQL, `postgres` has `rolbypassrls = false`. Any definer function that reads across tenants therefore reads a **routing/directory table with no RLS**, the pattern from migration 033. Every definer test re-owns the function to a NOBYPASSRLS role; see `tests/db/phoneDirectoryBootstrap.test.js:51-80`.
  - Why: with the local superuser as owner, a broken function stays green. This was measured on 2026-09-24 in `tests/db/recordingClaimAudit.test.js`.
- **Env vars:** every new env var goes in `.env.example` in the same task that first reads it. `tests/envInventory.test.js` fails in both directions.
- **Metrics:** every new counter is added to `COUNTER_NAMES` in `lib/voice/metrics.js`, because `bumpCounter` silently drops unknown names.
- **PHI audit:** every new exported function in `services/db.js` goes in `PHI_ACCESS` or `NON_PHI_EXPORTS` (`lib/phiAudit.js`), and a PHI function's body calls `noteAccess("<name>")`. `tests/phiAuditCoverage.test.js` enforces this.
- **Protect inbound:**
  - Every existing golden prompt snapshot in `tests/__snapshots__/prompts/` stays byte-identical (G9).
  - New outbound prompt fixtures go in a **separate** export and test file.
  - An absent `direction` stream parameter means inbound, exactly as today.
- **Defaults** (spec §14):

  | Variable | Default |
  |---|---|
  | `OUTBOUND_ENABLED` | `false` |
  | `OUTBOUND_TEST_ALLOWLIST` | empty |
  | `OUTBOUND_MAX_CONCURRENT` | `8` |
  | `OUTBOUND_INBOUND_RESERVE` | `2` |

  `businesses.outbound_max_concurrent` defaults to `2`.
- **Opener and voicemail rules** (spec §7, revised after the spikes):
  - Each must contain `{business_name}` AND match `/\b(AI|artificial intelligence|automated assistant|virtual assistant)\b/i`.
  - The **opener** (the backstop line) renders to **≤ 120** characters; the **voicemail** to **≤ 300**.
  - A field over budget is **refused, never truncated**.
- **Voice (spec D6, revised):** Ava speaks in the tenant's **Gemini Live voice** throughout. Pre-rendered clips (the backstop and the voicemail) are rendered by a short **Gemini Live** session in that same voice. `services/googleTts.js` is not used on outbound.
- **The first seconds (spec §9.3, revised):**
  - listen first; reply within **2 s of the person starting to speak**;
  - if they say nothing, play a short, **interruptible** backstop line **2.0 s after pickup** and seed it as Live's own turn;
  - a slow-Live safety net fires 1.6 s after speech onset;
  - a first-turn detector checks the disclosure.
- **Calling window** must fall inside **08:00–21:00** local time, every day.
- **Retry schedule:** at most **6** entries, and `give_up_after_days` ≤ **30**. `consent_window_days` defaults to 30, maximum 90.
- **Refused at save in Part 1:** `compliance_class = "marketing_consented"` and `audience = "patient"`.
- **Twilio dial parameters:**
  - `MachineDetection=DetectMessageEnd` and `AsyncAmd=true`.
  - `Timeout=40` on attempts listed in `voicemail_on`, and `25` otherwise. Spike B: US carrier voicemail answered after 26.6 s.
- **Ofcom timing (G2, two limbs):** Ava must be heard within **2,000 ms of the person starting to speak**, or within **2,000 ms of pickup** if they never speak. Breaking the applicable limb makes it a silent call, with a 72 h hold on the outreach.
- **Recording:** none in Part 1 (D3). Every disclosure says **"This call may be transcribed to help us assist you."** (D4, shipped in session 1; `lib/voice/disclosure.js`).
- **Spend:** the Part 1 API budget is **$10** (D8). Before every paid run, call `reserveP1("P1-…", worstUsd)` from `scripts/probes/lib/spendLive.js`; after it, `commit({probe:"P1-…"})`. **Ask the owner before any spend, deploy or call.**
- **Deploy route** (Terraform is broken on this machine):
  - Use `CLOUDSDK_CONFIG=~/.gcloud-vetra2`.
  - Build with Cloud Build `--service-account=projects/vetra-core-edc8ca/serviceAccounts/vetra-deployer@vetra-core-edc8ca.iam.gserviceaccount.com`.
  - Update the migrate job image first, then run migrations through the job.
  - Deploy with `gcloud run services update voice-uk-prod --image=… --update-env-vars=GIT_COMMIT_SHA=<sha>,…`.
  - **Nothing is pushed to git** until the owner confirms whether Railway auto-deploys `main`.
- **Vendor scripts** need `NODE_EXTRA_CA_CERTS=C:\Users\nithi\.gcloud-vetra2\ca-bundle.pem`, because Norton intercepts TLS.
- **Never `git checkout` over uncommitted work.** Commit first. Every sabotage is applied with Edit, confirmed with `grep -c`, and reverted with Edit. Also confirm the revert: `grep -c SABOTAGE` must return `0`.
- **Name collision:** the word "outbound" already means *model-to-caller audio* inside `lib/voice/live/index.js` (`inspectOutbound`, `live_outbound_notes_capped`). New identifiers for outbound CALLING use `dial`/`outreach`/`outboundCall`, and log events use the spec's `outbound_*` names only for the §14 list.

### 0.2 Branches and sessions

| Session | Steps | Branch | Stops for |
|---|---|---|---|
| 2a | Tasks 1–11 (spec steps 2.1–2.2): database, schedule, schema, gate, tasks, dispatch, internal routes, operator script | `feat/outbound-stage2` from the production branch tip | nothing (standalone code, no deploy) |
| 2b | Tasks 12–21 (2.3–2.5): door, session context, opener, AMD, prompt, identity, transfer, post-call, harness | same branch | nothing until Task 22 |
| 2.6 | Task 22: deploy with outbound switched off | same branch | **owner OK to deploy** |
| 2.7 | Task 23: live round 1 | same branch | **owner on their US handset** (spec D7: no UK legs for now) |
| 3 | Tasks 24–31: qualification, outcomes/callback/opt-out, retries plus callback recognition, SMS, results webhook, trigger webhook, booking, live round 2 | `feat/outbound-stage3` from the stage 2 tip | SMS sender; testers; owner decision C3 |
| 4 | Tasks 32–37: dashboard, demo | `feat/outbound-stage4` from the stage 3 tip | owner review |

**Owner decision 2026-09-24: stage 2 runs as TWO sessions, not four.**
- **"Stage 2 build"** covers 2a and 2b (Tasks 0–21) in one session. Checkpoint 2a (full suites plus code review) is a hard stop inside it. Task 0 (2b), the refresh, becomes an in-session step: re-anchor the 2b line references against HEAD and re-record the baselines.
- **"Stage 2 go-live"** covers 2.6 (Task 22, deploy plus decision C17) and 2.7 (Task 23, live round 1, plus fixes from its calls). It runs when the owner is free for about 2 hours.

The reasoning: 2a and 2b have no owner gate between them and share one deploy, so splitting them only adds a handoff. The deploy and the live calls depend on the owner's timing, and should start fresh.

**The split-on-evidence rule** (owner-approved). After Checkpoint 2a, **stop the session and start 2b as a fresh session** if ANY of these is true:
- (a) the checkpoint review found a **Critical** issue, or more than **3 Important** ones;
- (b) the checkpoint fixes changed code in **more than two** tasks;
- (c) the session's context has **already been summarised** at least once.

The stopping session ends as usual: summary, memory, and the exact 2b prompt, starting at "Task 0 (2b)". Otherwise, continue into 2b.

**Each session begins with its "Task 0: refresh".**
- Re-read this plan section against the code as it now stands.
- Update every `file:line` anchor, since earlier sessions move lines.
- Run the root suite (`DATABASE_URL` unset) and `test:db`, and record the counts as that session's baseline.

A session never starts from a red suite. Code for session 2a is complete in this document. Sessions 2b–4 give complete **tests** and exact integration points, plus complete code for new modules. Their edits to large existing files (`lib/voice/live/index.js`, `services/gemini.js`, `server.js`) are anchored and specified but must be applied against the lines as they stand after 2a.

### 0.3 Spec corrections found while planning (flag to the owner at plan approval)

| # | Spec says | Reality (with evidence) | Plan does |
|---|---|---|---|
| C1 | §6.3: definer functions "mirror `app_lookup_business_by_phone`" and read `call_attempts`, `outreach` and `calls` across tenants | FORCE RLS binds the owner; `postgres` cannot bypass it (033:8-31). A definer `SELECT` across tenants returns **0 rows** on Cloud SQL | Three trigger-maintained, no-RLS, app-revoked directory tables (`call_attempt_directory`, `outreach_schedule`, `live_call_registry`), each read only by a definer function (Task 3) |
| C2 | §6.3 `app_open_outreach_by_phone` is a definer function | Inbound already knows the tenant when it needs this, so an ordinary tenant-scoped query works and a definer is unnecessary | A plain `services/db.js` function under `withTenant` (Task 26) |
| C3 | §6.1 `webhook_endpoints.secret_ciphertext` is "encrypted with the existing KMS key" | No app-level KMS helper and no `@google-cloud/kms` dependency exist. The only keys are Terraform CMEK (`sql.tf:150-233`) | **Owner decision.** Recommended: AES-256-GCM in-app, with a 32-byte key from a new Secret Manager secret `outbound-webhook-key` (`OUTBOUND_WEBHOOK_KEY`). This is offline-testable and needs no new API. Alternative: Cloud KMS encrypt/decrypt (a new dependency, IAM, and a network hop per delivery). Task 28 |
| C4 | §9.1 OIDC "reuses the existing `jsonwebtoken` + `jwks-rsa` stack" | The libraries are reusable. `lib/auth/idToken.js` is hard-wired to Identity Platform (issuer, JWKS URI, required `auth_time`) | New sibling module `lib/auth/googleOidc.js` using the same libraries (Task 8) |
| C5 | §14 `OUTBOUND_MEDIA_URL_SECRET` "derived from `MEDIA_STREAM_SECRET` if unset" | The stream token itself derives from `MEDIA_STREAM_SECRET` **or `TWILIO_AUTH_TOKEN`** (`lib/mediaStreamToken.js:68-75`) | Derive from the same `signingKey(env)` source, with a distinct label (Task 12) |
| C6 | §6.2 `call_state` "gains `direction` and `attemptId`" | 038's allow-list raises on any other key, and 038 is checksummed | A new migration replaces `app_call_state_merge`/`_get`, plus `SHARED_FIELDS` and two test fixtures (Task 2) |
| C7 | §9.2 "new `lookupBusinessById` in `services/db.js`" | It does not exist, and the lookup must work before the tenant is known | Resolve the tenant via `app_outbound_attempt_by_call_sid` (which sets scope), then read the business through the EXISTING `fetchBusinessById` / `fetchBusinessCapabilities` (Task 14) |
| C8 | §9.3 the opener plays through "the existing outbound-media path" | `audioOut` playback trips the half-duplex gate (caller frames withheld, `halfDuplex.js:145-214`) and barge `clearAudio` (`index.js:4071-4077`, `4923-4997`), which would cut the opener (§9.3.6 forbids that) | **Superseded by the revised spec §9.3:** the backstop is short and interruptible, so the normal audio and barge path is correct (Task 14) |
| C9 | §9.7 transfer | `redialForTransfer` sets `callerId` to the CALLER's number (`index.js:5156`) and has no timeout or action | Outbound variant per the spec (Task 19). Inbound unchanged |
| C10 | §12.5 delivery uses "the existing SSRF guard from `integrations/webhook.js`" | That guard is not exported and has gaps: IPv4-mapped IPv6, 100.64/10, a DNS-rebinding window, and redirects followed | A new hardened `lib/net/ssrfGuard.js` for results webhooks. The existing integration webhook is **recorded, not changed** (record-and-park) (Task 28) |
| C11 | §3 G2 relies on `services/googleTts.js` | `isConfigured()` is **false** on the serving revision: neither `GOOGLE_APPLICATION_CREDENTIALS` nor `GOOGLE_TTS_API_KEY` is set. The API is enabled | **Moot since spec D6 was revised:** outbound clips are rendered by Gemini Live (Task 14's `liveRender.js`), which already works on the revision. Nothing to change. Recorded in spec §17 |
| C12 | §14 lists gcloud resources | `cloudtasks.googleapis.com` is **not enabled** on `vetra-uk-edc8ca` (Scheduler is) | Task 22 enables it |
| C13 | §6.3 `app_active_call_counts()` returns inbound and outbound counts from `calls` | That would need a new trigger on `calls`, which every inbound call writes. The gate's formula (§10.3 row 10) never reads the inbound half | The outbound-only `app_active_dial_counts()`, fed by a trigger on `call_attempts`. Inbound's write path is untouched. Set `OUTBOUND_MAX_CONCURRENT` to Twilio account A's real limit (Task 3) |
| C14 | §10.2 "a task name derived from `outreach_id` and `next_attempt_at`"; the sweep "re-enqueues"; §6.3 `app_outbound_due(limit)` | Cloud Tasks reserves a finished task's name for up to about an hour, so the sweep's rescue would get ALREADY_EXISTS. The sweep also has no `at` to name the task by | Sweep tasks are named and scheduled at the start of the current 5-minute bucket. The function becomes `app_outbound_due(limit, grace_seconds)`. Dispatch is idempotent. A trigger is therefore dispatched within about 7 minutes (a 5-minute sweep plus 2 minutes of grace), not 5 (Tasks 3, 8, 10) |
| C16 | §10.1 treats a Twilio 429 as "capacity" | The attempt row and the `attempts_made` increment are already committed when `calls.create` runs, so each 429 would use up an attempt and count toward the daily cap | On 429: delete the attempt row and decrement `attempts_made` in one tenant transaction, then retry after 30 s (Task 9) |
| C17 | D7 test caller ID; Live round 1 from `+18176011171` | The production service holds only **account A**'s REST credentials (`twilio-account-sid` / `twilio-auth-token`). `+18176011171` is on **account B**. Webhooks from B already validate (`TWILIO_AUTH_TOKEN_ALT`), but `calls.create` from a B number needs B's SID and token | **Owner decision at Task 22.** Recommended: add secret `twilio-account-sid-alt` and select credentials per caller ID. The account is resolved at campaign save through `incomingPhoneNumbers.list` on each account, which extends Task 5's `caller_id` check. Alternatives: buy a US number on account A, or port `+18176011171` to A |
| C15 | §9.1 `GET /media/outbound/:attemptId/:kind.wav` | Resolving an attemptId before the tenant is known needs another definer function | The path carries the CallSid, and `app_outbound_attempt_by_call_sid` resolves it (Task 12) |

### 0.4 File map

**New:**
- `database/042_outbound_core.sql`: the nine outbound tables, with RLS.
- `database/043_outbound_links.sql`: new columns on `calls`/`businesses`, plus the `call_state` changes.
- `database/044_outbound_directories.sql`: the three directory tables, their triggers and the three definer functions.
- `lib/outbound/config.js`: parses the env into one frozen object.
- `lib/outbound/schedule.js`: the schedule grammar, calling-window arithmetic and jitter.
- `lib/outbound/campaignSchema.js`: the strict campaign config schema, the exported descriptor and template rendering.
- `lib/outbound/templates.js`: the `speed_to_lead` preset.
- `lib/outbound/consent.js`: `consentSatisfies(class, consents, config, now)`.
- `lib/outbound/gate.js`: `evaluateGate(facts)`, pure, applying the 11 checks in order.
- `lib/outbound/tasks.js`: a Cloud Tasks enqueuer with dedupe by task name.
- `lib/outbound/dispatch.js`: the §10.1 dispatch flow, with dependencies injected.
- `lib/outbound/internalRoutes.js`: `/internal/outbound/dispatch` and `/internal/outbound/sweep`.
- `lib/auth/googleOidc.js`: the Google-signed OIDC verifier.
- `scripts/outbound-admin.js`: campaign create/status and trigger, dry-run by default, run through the migrate job.
- `scripts/export-campaign-schema.js`: writes the dashboard copy of the campaign schema.
- Session 2b:
  - `lib/outbound/mediaUrl.js`
  - `lib/outbound/doorRoutes.js`
  - `lib/outbound/amd.js`
  - `lib/outbound/opener.js`
  - `lib/outbound/callContext.js`
  - `lib/outbound/postCall.js`
  - `lib/outbound/detectors.js`
  - `lib/outbound/prompt.js`
- Session 3:
  - `capabilities/qualification.js`
  - `capabilities/outcome.js`
  - `capabilities/callback.js`
  - `capabilities/optOut.js`
  - `lib/outbound/webhookSigner.js`
  - `lib/outbound/outbox.js`
  - `lib/net/ssrfGuard.js`
  - `lib/outbound/secretBox.js`
  - `docs/outbound-webhook-contract.md`
  - `lib/outbound/triggerRoute.js`
- Session 4:
  - dashboard backend `routes/outbound.js`
  - frontend `src/outbound/*`

**Modified:**
- `database/schema.sql` (folds)
- `services/db.js` (new data functions)
- `lib/phiAudit.js` (classification)
- `lib/callStateStore.js:43`
- `server.js` (mount routes)
- `lib/voice/metrics.js` (counters)
- `.env.example`
- `package.json` (`@google-cloud/tasks`)
- `Dockerfile` and `.dockerignore` (the `outbound-admin` script)
- 2b and later: `lib/voice/live/index.js`, `services/gemini.js`, `lib/voice/strings.js`, `services/tools.js`, `capabilities/index.js`, `capabilities/appointments.js`, `adapters/scheduling/internal.js`, `lib/capabilities/requirements.js`, `scripts/live-call-harness.js`, `services/googleTts.js`, `AI-phone-dashboard/**`

**Test commands** (from the repo root):
- Root: `npx vitest run <file>`, with `DATABASE_URL` **unset**.
- DB: `DATABASE_URL=postgresql://vetra:vetra_local_dev@localhost:55432/vetra npx vitest run --config vitest.db.config.js <file>`. First `npm run db:up`, then `npm run db:reset` once per session.
- Full: `npx vitest run` (unset) and `npm run test:db` (set).
- Baselines on 2026-09-24:
  - Root: 217 files, 4,160 passed, 2 skipped. After the session 1 additions, re-baselined in 2a Task 0.
  - DB: 19 files, 233 passed, before session 1's `recordingClaimAudit` file.

---

# STAGE 2 · SESSION 2a: tables, engine, dialer (spec steps 2.1–2.2)

### Task 0 (2a): refresh

- [ ] **Step 1: Branch.** `git switch -c feat/outbound-stage2` from the production branch tip. Confirm with `git status` that the tree is clean.
- [ ] **Step 2: Baseline.** Start the database with `npm run db:up`. Run `DATABASE_URL=… npm run db:reset`. Run `npx vitest run` with `DATABASE_URL` unset, then `npm run test:db` with it set. Record both counts in the session notes. If either is red, stop and ask.
- [ ] **Step 3: Spike results.** Read the spike results in spec §9.3/§9.4 (session 1). They decide Task 14's branch.

---

### Task 1: Migration 042, the outbound tables with RLS

**Files:**
- Create: `database/042_outbound_core.sql`
- Modify: `database/schema.sql` (append the folded section)
- Test: `tests/db/outboundRls.test.js`

**Interfaces:**
- Produces these tables (the columns are exactly spec §6.1): `campaigns`, `campaign_versions`, `contacts`, `consents`, `suppressions`, `outreach`, `call_attempts`, `webhook_endpoints`, `outbox`. Each has `business_id` and a `tenant_isolation` policy.

- [ ] **Step 1: Write the failing RLS test**

```js
// tests/db/outboundRls.test.js
/**
 * Every outbound table refuses a cross-tenant read AND write as vetra_app.
 * Pattern: tests/db/crossTenantIsolation.test.js (SET ROLE vetra_app, scope by
 * set_config). Runs as vetra_app, never as the `vetra` superuser -- a superuser
 * sails past every policy and would make this file green whatever the SQL says.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const A = "0b0b0000-0000-4000-8000-00000000000a";
const B = "0b0b0000-0000-4000-8000-00000000000b";
const TABLES = [
  "campaigns", "campaign_versions", "contacts", "consents", "suppressions",
  "outreach", "call_attempts", "webhook_endpoints", "outbox",
];
let admin;

async function seedTenant(id, tag) {
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [id, `RLS ${tag}`]);
  const camp = await admin.query(
    `INSERT INTO campaigns (business_id, name, template_key, compliance_class, audience, status, current_version)
     VALUES ($1, 'c', 'speed_to_lead', 'solicited', 'business', 'draft', 1) RETURNING id`, [id]);
  const cid = camp.rows[0].id;
  await admin.query(`INSERT INTO campaign_versions (campaign_id, business_id, version, config) VALUES ($1,$2,1,'{}')`, [cid, id]);
  const con = await admin.query(
    `INSERT INTO contacts (business_id, phone_e164, first_name) VALUES ($1, $2, 'Sam') RETURNING id`,
    [id, tag === "A" ? "+447700900001" : "+447700900002"]);
  const contactId = con.rows[0].id;
  await admin.query(
    `INSERT INTO consents (business_id, contact_id, purpose, channels, covers_automated, source, wording_version, wording_text, captured_at, expires_at)
     VALUES ($1,$2,'enquiry_followup','{call}',true,'form','v1','text',now(),now()+interval '30 days')`, [id, contactId]);
  await admin.query(`INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,$2,'manual','dashboard')`,
    [id, tag === "A" ? "+447700900091" : "+447700900092"]);
  const o = await admin.query(
    `INSERT INTO outreach (business_id, campaign_id, campaign_version, contact_id, state, attempts_made, trigger, idempotency_key)
     VALUES ($1,$2,1,$3,'waiting',0,'{}',$4) RETURNING id`, [id, cid, contactId, `k-${tag}`]);
  await admin.query(
    `INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number)
     VALUES ($1,$2,1,'+441372656055','+447700900001')`, [id, o.rows[0].id]);
  await admin.query(
    `INSERT INTO webhook_endpoints (business_id, url, secret_ciphertext, events, active)
     VALUES ($1,'https://example.com/h','\\x00','{call.completed}',true)`, [id]);
  await admin.query(
    `INSERT INTO outbox (business_id, kind, target_id, event_type, payload, idempotency_key, status, attempts, next_attempt_at)
     VALUES ($1,'webhook',gen_random_uuid(),'call.completed','{}',$2,'pending',0,now())`, [id, `ob-${tag}`]);
}

// One client per call: SET LOCAL ROLE and the scope must not leak between
// assertions, and ROLLBACK keeps every probe side-effect free.
async function asApp(businessId, sql, params = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE vetra_app");
    if (businessId) await client.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    const r = await client.query(sql, params);
    await client.query("ROLLBACK");
    return r;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DELETE FROM businesses WHERE id IN ($1,$2)`, [A, B]);
  await seedTenant(A, "A");
  await seedTenant(B, "B");
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id IN ($1,$2)`, [A, B]);
  await admin.end();
});

d("outbound tables: RLS is on and FORCED", () => {
  it.each(TABLES)("%s has ENABLE and FORCE row level security", async (t) => {
    const r = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [t]);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

d("outbound tables: tenant A cannot see or touch tenant B", () => {
  it.each(TABLES)("%s: a scoped read returns only the scoped tenant's rows", async (t) => {
    const r = await asApp(A, `SELECT DISTINCT business_id::text AS b FROM ${t} WHERE business_id IN ($1,$2)`, [A, B]);
    expect(r.rows.map((x) => x.b)).toEqual([A]);
  });

  it.each(TABLES)("%s: an unscoped read returns nothing", async (t) => {
    const r = await asApp(null, `SELECT count(*)::int AS n FROM ${t} WHERE business_id IN ($1,$2)`, [A, B]);
    expect(r.rows[0].n).toBe(0);
  });

  it.each(TABLES)("%s: a cross-tenant UPDATE matches zero rows", async (t) => {
    const r = await asApp(A, `UPDATE ${t} SET business_id = business_id WHERE business_id = $1`, [B]);
    expect(r.rowCount).toBe(0);
  });

  it("a cross-tenant INSERT is refused by WITH CHECK", async () => {
    await expect(
      asApp(A, `INSERT INTO suppressions (business_id, phone_e164, reason, created_by) VALUES ($1,'+447700900099','manual','api')`, [B])
    ).rejects.toThrow(/row-level security/);
  });
});

d("outbound tables: the constraints the engine relies on", () => {
  it("call_attempts (outreach_id, attempt_no) is unique -- the double-dial lock", async () => {
    const o = await admin.query(`SELECT id FROM outreach WHERE business_id = $1`, [A]);
    await expect(
      admin.query(`INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number)
                   VALUES ($1,$2,1,'+441372656055','+447700900001')`, [A, o.rows[0].id])
    ).rejects.toThrow(/duplicate key/);
  });

  it("outreach (business_id, idempotency_key) is unique -- a trigger replayed twice is one outreach", async () => {
    const r = await admin.query(`SELECT campaign_id, contact_id FROM outreach WHERE business_id = $1`, [A]);
    await expect(
      admin.query(`INSERT INTO outreach (business_id, campaign_id, campaign_version, contact_id, state, attempts_made, trigger, idempotency_key)
                   VALUES ($1,$2,1,$3,'waiting',0,'{}','k-A')`, [A, r.rows[0].campaign_id, r.rows[0].contact_id])
    ).rejects.toThrow(/duplicate key/);
  });

  it("refuses an unknown compliance class at the database, not only in code", async () => {
    await expect(
      admin.query(`INSERT INTO campaigns (business_id, name, template_key, compliance_class, audience, status, current_version)
                   VALUES ($1,'x','custom','cold_calling','business','draft',1)`, [A])
    ).rejects.toThrow(/check constraint/);
  });

  it("contacts (business_id, phone_e164) is unique", async () => {
    await expect(
      admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900001')`, [A])
    ).rejects.toThrow(/duplicate key/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `DATABASE_URL=postgresql://vetra:vetra_local_dev@localhost:55432/vetra npx vitest run --config vitest.db.config.js tests/db/outboundRls.test.js`

Expected: FAIL with `relation "campaigns" does not exist` (thrown in `beforeAll`).

- [ ] **Step 3: Write the migration**

```sql
-- database/042_outbound_core.sql
-- ============================================================
-- Migration 042: outbound calling -- the tables (spec §6.1)
-- ============================================================
-- Nine tenant tables. All are ENABLE + FORCE row level security with the
-- 029 tenant_isolation idiom. Grants come from 029's ALTER DEFAULT PRIVILEGES
-- (SELECT, INSERT, UPDATE, DELETE to vetra_app), so nothing is granted here.
--
-- Cross-tenant reads (the sweep, capacity, resolving a CallSid) do NOT happen
-- on these tables -- FORCE RLS binds a definer's owner too (033:8-31). They
-- go through the no-RLS directories of migration 044.

CREATE TABLE IF NOT EXISTS campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name             text NOT NULL,
  template_key     text NOT NULL CHECK (template_key IN ('speed_to_lead','missed_call_callback','reminder','no_show','aftercare','review_request','reactivation','custom')),
  compliance_class text NOT NULL CHECK (compliance_class IN ('solicited','service','marketing_consented')),
  audience         text NOT NULL CHECK (audience IN ('business','patient')),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  current_version  int  NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_business_idx ON campaigns (business_id);

CREATE TABLE IF NOT EXISTS campaign_versions (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version     int  NOT NULL,
  config      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, version)
);

CREATE TABLE IF NOT EXISTS contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone_e164   text NOT NULL,
  first_name   text,
  last_name    text,
  email        text,
  timezone     text,
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS consents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  purpose          text NOT NULL,
  channels         text[] NOT NULL DEFAULT '{}',
  covers_automated boolean NOT NULL DEFAULT false,
  source           text NOT NULL CHECK (source IN ('form','api','inbound_call','manual')),
  source_ref       text,
  wording_version  text,
  wording_text     text,
  captured_at      timestamptz NOT NULL,
  expires_at       timestamptz,
  revoked_at       timestamptz
);
CREATE INDEX IF NOT EXISTS consents_contact_idx ON consents (contact_id);

CREATE TABLE IF NOT EXISTS suppressions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone_e164     text NOT NULL,
  reason         text NOT NULL CHECK (reason IN ('opted_out','wrong_number','complaint','manual','tps')),
  source_call_id uuid,
  created_by     text NOT NULL CHECK (created_by IN ('tool','detector','dashboard','api')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS outreach (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  campaign_version int  NOT NULL,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  state            text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','dialing','in_call','closed')),
  attempts_made    int  NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  last_attempt_at  timestamptz,
  hold_until       timestamptz,
  outcome          text,
  close_reason     text CHECK (close_reason IS NULL OR close_reason IN ('terminal_outcome','attempts_exhausted','give_up_window','consent_missing','consent_expired','consent_not_automated','suppressed','called_back','campaign_deleted','global_disabled','business_disabled','caller_id_invalid')),
  trigger          jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  UNIQUE (business_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS outreach_state_next_idx ON outreach (state, next_attempt_at);
CREATE INDEX IF NOT EXISTS outreach_contact_idx ON outreach (contact_id);

CREATE TABLE IF NOT EXISTS call_attempts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  outreach_id           uuid NOT NULL REFERENCES outreach(id) ON DELETE CASCADE,
  attempt_no            int  NOT NULL,
  twilio_call_sid       text UNIQUE,
  from_number           text NOT NULL,
  to_number             text NOT NULL,
  dialed_at             timestamptz,
  answered_at           timestamptz,
  ended_at              timestamptz,
  twilio_status         text,
  answered_by           text CHECK (answered_by IS NULL OR answered_by IN ('human','machine_start','machine_end_beep','machine_end_silence','machine_end_other','fax','unknown')),
  amd_duration_ms       int,
  first_audio_ms        int,
  silent                boolean NOT NULL DEFAULT false,
  result                text CHECK (result IS NULL OR result IN ('no_answer','busy','failed','canceled','voicemail_left','voicemail_skipped','connected')),
  call_id               uuid REFERENCES calls(id) ON DELETE SET NULL,
  status_completed_at   timestamptz,
  session_finished_at   timestamptz,
  post_call_started_at  timestamptz,
  opener_audio          bytea,
  voicemail_audio       bytea,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outreach_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS call_attempts_to_number_idx ON call_attempts (to_number, dialed_at);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url               text NOT NULL CHECK (url LIKE 'https://%'),
  secret_ciphertext bytea NOT NULL,
  events            text[] NOT NULL DEFAULT '{}',
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('webhook','crm')),
  target_id       uuid NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','dead')),
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  UNIQUE (business_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox (status, next_attempt_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaigns','campaign_versions','contacts','consents','suppressions','outreach','call_attempts','webhook_endpoints','outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (business_id = app_current_business_id()) WITH CHECK (business_id = app_current_business_id())', t);
  END LOOP;
END $$;
```

- [ ] **Step 4: Fold into `database/schema.sql`.** Append a section headed `-- Migration 042: outbound calling -- the tables (spec §6.1)` containing the same DDL. Follow the folding style used for 037 at `schema.sql:951-1011`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npm run db:migrate` (with `DATABASE_URL` set), which applies 042 from the file; `db:reset` would not. Then run the Step 2 command. Expected: PASS, 9 + 27 + 1 + 4 = 41 tests.

Then run: `DATABASE_URL=… npx vitest run --config vitest.db.config.js tests/db/schemaParity.test.js` and `npx vitest run tests/schema.test.js` with `DATABASE_URL` unset. Expected: PASS.

- [ ] **Step 6: Sabotage** (on the `schema.sql` copy; see the migration test loop in §0.1).
  1. With Edit, delete `EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);` from the DO block **in `schema.sql` only**.
  2. Run `db:reset`, then the test. Expected: the `%s has ENABLE and FORCE` rows go RED.
  3. Revert with Edit, and confirm with `grep -c "FORCE ROW LEVEL SECURITY', t" database/schema.sql` (it must be `1`).
  4. Run `db:reset` again, then `db:migrate`, then the test. Expected: GREEN.

- [ ] **Step 7: Commit**

```bash
git add database/042_outbound_core.sql database/schema.sql tests/db/outboundRls.test.js
git commit -m "feat(outbound): migration 042, the nine outbound tables under FORCE RLS"
```

---

### Task 2: Migration 043, the link columns and `call_state` direction

**Files:**
- Create: `database/043_outbound_links.sql`
- Modify:
  - `database/schema.sql` (fold, including replacing the two call_state function bodies at `schema.sql:1217-1298`)
  - `lib/callStateStore.js:43`
  - `tests/db/callStatePgStore.test.js:85`
  - `tests/helpers/callStateCrossProcessSuite.js:100`
- Test: `tests/db/outboundLinks.test.js`

**Interfaces:**
- Produces:
  - `calls.direction` (`'inbound'` default), `calls.campaign_id`, `campaign_version`, `outreach_id`, `attempt_id`, `contact_id`, `answered_by`, `outcome_code`, `answers`;
  - `businesses.outbound_enabled` (false), `businesses.outbound_max_concurrent` (2);
  - `SHARED_FIELDS = ["dbCallId","businessId","sawCallerFinal","direction","attemptId"]`.

- [ ] **Step 1: Write the failing test**

```js
// tests/db/outboundLinks.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const BIZ = "0c0c0000-0000-4000-8000-000000000001";
let admin;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1, 'Links')`, [BIZ]);
});
afterAll(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`SELECT app_call_state_delete('CAlinks0001')`);
  await admin.end();
});

d("migration 043", () => {
  it("an ordinary inbound insert still works and reads direction 'inbound' (existing rows keep their meaning)", async () => {
    const r = await admin.query(
      `INSERT INTO calls (business_id, twilio_call_sid, caller_number, twilio_number) VALUES ($1,'CAlinks-in','+447700900001','+441372656055') RETURNING direction, answers, outcome_code`, [BIZ]);
    expect(r.rows[0]).toEqual({ direction: "inbound", answers: null, outcome_code: null });
  });

  it("refuses a direction that is neither inbound nor outbound", async () => {
    await expect(
      admin.query(`INSERT INTO calls (business_id, twilio_call_sid, direction) VALUES ($1,'CAlinks-bad','sideways')`, [BIZ])
    ).rejects.toThrow(/check constraint/);
  });

  it("businesses default to outbound switched OFF, with a concurrency of 2", async () => {
    const r = await admin.query(`SELECT outbound_enabled, outbound_max_concurrent FROM businesses WHERE id = $1`, [BIZ]);
    expect(r.rows[0]).toEqual({ outbound_enabled: false, outbound_max_concurrent: 2 });
  });

  it("call_state accepts direction and attemptId, and still refuses any other key", async () => {
    await admin.query(`SELECT app_call_state_merge('CAlinks0001', '{"direction":"outbound","attemptId":"att-1"}'::jsonb)`);
    const got = await admin.query(`SELECT app_call_state_get('CAlinks0001', 3600) AS s`);
    expect(got.rows[0].s).toEqual({ direction: "outbound", attemptId: "att-1" });
    await expect(
      admin.query(`SELECT app_call_state_merge('CAlinks0001', '{"history":[]}'::jsonb)`)
    ).rejects.toThrow(/refusing unknown shared field/);
  });

  it("a merge that omits direction leaves it alone (absent is not null)", async () => {
    await admin.query(`SELECT app_call_state_merge('CAlinks0001', '{"sawCallerFinal":true}'::jsonb)`);
    const got = await admin.query(`SELECT app_call_state_get('CAlinks0001', 3600) AS s`);
    expect(got.rows[0].s.direction).toBe("outbound");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL, `column "direction" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- database/043_outbound_links.sql
-- ============================================================
-- Migration 043: outbound calling -- links on existing tables (spec §6.2)
-- ============================================================
-- calls: `caller_number` KEEPS meaning "the other party" and `twilio_number`
-- "our number" on outbound calls too, so the data-subject export/erase paths
-- and analytics keyed on caller_number work unchanged (§6.2).

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS direction text NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound','outbound')),
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS campaign_version int,
  ADD COLUMN IF NOT EXISTS outreach_id uuid REFERENCES outreach(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attempt_id uuid REFERENCES call_attempts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS answered_by text,
  ADD COLUMN IF NOT EXISTS outcome_code text,
  ADD COLUMN IF NOT EXISTS answers jsonb;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS outbound_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS outbound_max_concurrent int NOT NULL DEFAULT 2;

-- call_state: two more shared scalars, written once at session start.
ALTER TABLE call_state
  ADD COLUMN IF NOT EXISTS direction text,
  ADD COLUMN IF NOT EXISTS attempt_id text;
```

After the `ALTER TABLE call_state`, the migration needs `CREATE OR REPLACE` versions of `app_call_state_merge` and `app_call_state_get`. Produce them by copying 038 lines **119-158** and **174-195** **verbatim**, including each function's closing `END;` and `$$;`; that keeps the owner and grants. Then change exactly these lines:

```sql
--   in app_call_state_merge:
  WHERE k NOT IN ('dbCallId', 'businessId', 'sawCallerFinal', 'direction', 'attemptId');
--   the RAISE message's list becomes: dbCallId, businessId, sawCallerFinal, direction, attemptId
  INSERT INTO call_state AS cs (call_sid, db_call_id, business_id, saw_caller_final, direction, attempt_id, updated_at)
  VALUES (p_call_sid, p_patch ->> 'dbCallId', p_patch ->> 'businessId', (p_patch ->> 'sawCallerFinal')::boolean,
          p_patch ->> 'direction', p_patch ->> 'attemptId', now())
  ON CONFLICT (call_sid) DO UPDATE SET
    db_call_id       = CASE WHEN p_patch ? 'dbCallId'       THEN EXCLUDED.db_call_id       ELSE cs.db_call_id       END,
    business_id      = CASE WHEN p_patch ? 'businessId'     THEN EXCLUDED.business_id      ELSE cs.business_id      END,
    saw_caller_final = CASE WHEN p_patch ? 'sawCallerFinal' THEN EXCLUDED.saw_caller_final ELSE cs.saw_caller_final END,
    direction        = CASE WHEN p_patch ? 'direction'      THEN EXCLUDED.direction        ELSE cs.direction        END,
    attempt_id       = CASE WHEN p_patch ? 'attemptId'      THEN EXCLUDED.attempt_id       ELSE cs.attempt_id       END,
    updated_at       = now();
--   in app_call_state_get:
  SELECT jsonb_strip_nulls(jsonb_build_object(
           'dbCallId', cs.db_call_id, 'businessId', cs.business_id, 'sawCallerFinal', cs.saw_caller_final,
           'direction', cs.direction, 'attemptId', cs.attempt_id))
```

- [ ] **Step 4: Update the JavaScript side and the fold.**
  - `lib/callStateStore.js:43` becomes `export const SHARED_FIELDS = Object.freeze(["dbCallId", "businessId", "sawCallerFinal", "direction", "attemptId"]);`
  - `tests/db/callStatePgStore.test.js`:
    - add `direction: "direction", attempt_id: "attemptId"` to the column-to-field map (`:85`);
    - **add `direction, attempt_id` to `readRaw`'s SELECT**, which reads only 3 columns today.
  - `tests/helpers/callStateCrossProcessSuite.js`:
    - it writes only three fields at `:95`, and `:100` asserts the written keys equal `SHARED_FIELDS`, so it goes RED unless updated;
    - add `direction: "outbound", attemptId: "att-6"` to the `CA_cross_slice` payload.
  - **Fold 043 into `schema.sql`**, following the §0.1 fold rule:
    - Declare the nine new `calls` columns **inline in `CREATE TABLE calls`** (`schema.sql:107`) **without** `REFERENCES`.
    - After the 042 section, append:
      ```sql
      ALTER TABLE calls ADD CONSTRAINT calls_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
      ALTER TABLE calls ADD CONSTRAINT calls_outreach_id_fkey FOREIGN KEY (outreach_id) REFERENCES outreach(id) ON DELETE SET NULL;
      ALTER TABLE calls ADD CONSTRAINT calls_attempt_id_fkey  FOREIGN KEY (attempt_id)  REFERENCES call_attempts(id) ON DELETE SET NULL;
      ALTER TABLE calls ADD CONSTRAINT calls_contact_id_fkey  FOREIGN KEY (contact_id)  REFERENCES contacts(id) ON DELETE SET NULL;
      ```
      The constraint names must match what the migration's inline `REFERENCES` produces (Postgres names them `<table>_<column>_fkey`), so the parity fingerprint agrees.
    - Add the `businesses` columns inline in `CREATE TABLE businesses`.
    - Replace the two call_state function bodies in place at `schema.sql:1217-1298`. `schemaParity` compares function **bodies**.

- [ ] **Step 5: Run the tests and confirm they pass.**
  1. Run `db:migrate` (not reset).
  2. Run these four DB tests: `outboundLinks`, `callStatePgStore`, `schemaParity`, `crossTenantIsolation`.
  3. Run `db:reset`, which checks that `schema.sql` alone still applies cleanly after the fold; a `REFERENCES` placed before its target fails here. Then run `db:migrate` again.
  4. Run the root tests `tests/schema.test.js`, `tests/callState*.test.js` and `tests/callStateMultiProcess.test.js`.

  Expected: all PASS.

- [ ] **Step 6: Sabotage.**
  1. Remove `'direction', ` from the allow-list in `schema.sql`'s `app_call_state_merge`.
  2. Run `db:reset` and the test. Expected: "accepts direction" goes RED with `refusing unknown shared field(s): direction`.
  3. Revert, and confirm with `grep -c "'direction', 'attemptId'" database/schema.sql` (it must be `1`).
  4. Run `db:reset`, then `db:migrate`, then re-run the test.

- [ ] **Step 7: Commit**

```bash
git add database/043_outbound_links.sql database/schema.sql lib/callStateStore.js tests/db/outboundLinks.test.js tests/db/callStatePgStore.test.js tests/helpers/callStateCrossProcessSuite.js
git commit -m "feat(outbound): migration 043, call direction and outbound links; call_state carries direction and attemptId"
```

---

### Task 3: Migration 044, directories and the definer functions (corrections C1 and C13)

**C13 (flag to the owner): capacity counts outbound only, from `call_attempts`, with no trigger on `calls`.**
- Spec §6.3's `app_active_call_counts()` counted inbound too, from `calls`. That would need a new trigger on the `calls` table, which every inbound call writes (`createCall` and `completeCall`). That is a new failure mode in inbound's write path.
- The gate's formula (§10.3 row 10) uses only the OUTBOUND count against a static reserve, so the inbound half is never read.
- Once Twilio account A's real concurrency limit is known, set `OUTBOUND_MAX_CONCURRENT` to it. For an Individual profile that is 3, which with a reserve of 2 leaves 1 outbound line.

**Files:**
- Create: `database/044_outbound_directories.sql`
- Modify: `database/schema.sql` (fold)
- Test: `tests/db/outboundDirectories.test.js`

**Interfaces:**
- Produces, all `EXECUTE`-granted to `vetra_app`:
  - `app_outbound_attempt_by_call_sid(p_sid text) RETURNS TABLE(business_id uuid, attempt_id uuid, outreach_id uuid, campaign_id uuid, campaign_version int)`. When it resolves, it sets `app.business_id` for the transaction.
  - `app_outbound_due(p_limit int, p_grace_seconds int) RETURNS TABLE(business_id uuid, outreach_id uuid)`
  - `app_active_dial_counts() RETURNS TABLE(business_id uuid, active int)`

- [ ] **Step 1: Write the failing test.** It re-owns the functions to a NOBYPASSRLS role, which production requires; see `tests/db/phoneDirectoryBootstrap.test.js:51-80`.

```js
// tests/db/outboundDirectories.test.js
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const OWNER = "outdir_owner";
const BIZ = "0d0d0000-0000-4000-8000-000000000001";
const FNS = [
  "app_outbound_attempt_by_call_sid(text)",
  "app_outbound_due(integer, integer)",
  "app_active_dial_counts()",
  "app_sync_outbound_directories()",
  "app_sync_outreach_schedule()",
];
let admin, app, outreachId, dueId, futureId, closedId;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.query(`CREATE ROLE ${OWNER} LOGIN PASSWORD 'probe_only' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${OWNER}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${OWNER}`);
  for (const fn of FNS) await admin.query(`ALTER FUNCTION ${fn} OWNER TO ${OWNER}`);
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);

  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name) VALUES ($1,'Dir')`, [BIZ]);
  const camp = await admin.query(`INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
                                   VALUES ($1,'c','speed_to_lead','solicited','business','active',3) RETURNING id`, [BIZ]);
  const con = await admin.query(`INSERT INTO contacts (business_id, phone_e164) VALUES ($1,'+447700900111') RETURNING id`, [BIZ]);
  const mk = async (key, state, next) => (await admin.query(
    `INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key,next_attempt_at)
     VALUES ($1,$2,3,$3,$4,'{}',$5,$6) RETURNING id`, [BIZ, camp.rows[0].id, con.rows[0].id, state, key, next])).rows[0].id;
  outreachId = await mk("dir-1", "dialing", null);
  dueId = await mk("dir-due", "waiting", new Date(Date.now() - 10 * 60_000));
  futureId = await mk("dir-future", "waiting", new Date(Date.now() + 60 * 60_000));
  closedId = await mk("dir-closed", "closed", new Date(Date.now() - 10 * 60_000));

  app = new pg.Client({ connectionString: APP_URL });
  await app.connect();
});

afterAll(async () => {
  if (!admin) return;
  await app?.end().catch(() => {});
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]).catch(() => {});
  for (const fn of FNS) await admin.query(`ALTER FUNCTION ${fn} OWNER TO vetra`).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`REVOKE ALL ON SCHEMA public FROM ${OWNER}`).catch(() => {});
  await admin.query(`DROP OWNED BY ${OWNER}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${OWNER}`).catch(() => {});
  await admin.end();
});

async function appTx(fn) {
  await app.query("BEGIN");
  try { return await fn(app); } finally { await app.query("ROLLBACK"); }
}

d("outbound directories: honest ownership", () => {
  it("every definer is owned by a role that cannot bypass RLS, like Cloud SQL's postgres", async () => {
    const r = await admin.query(
      `SELECT DISTINCT r.rolbypassrls, r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname IN ('app_outbound_attempt_by_call_sid','app_outbound_due','app_active_dial_counts')`);
    expect(r.rows).toEqual([{ rolbypassrls: false, rolsuper: false }]);
  });

  it.each(["call_attempt_directory", "outreach_schedule", "dial_registry"])(
    "vetra_app cannot read %s directly -- it cannot enumerate", async (t) => {
      await expect(appTx((c) => c.query(`SELECT 1 FROM ${t} LIMIT 1`))).rejects.toThrow(/permission denied/);
    });
});

d("app_outbound_attempt_by_call_sid", () => {
  it("resolves a CallSid to its tenant and attempt with NO scope set, and adopts the tenant", async () => {
    await admin.query(`INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at)
                       VALUES ($1,$2,1,'+441372656055','+447700900111','CAdir0001',now())`, [BIZ, outreachId]);
    const r = await appTx(async (c) => {
      const row = (await c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAdir0001')`)).rows;
      const scope = (await c.query(`SELECT current_setting('app.business_id', true) AS s`)).rows[0].s;
      return { row, scope };
    });
    expect(r.row).toHaveLength(1);
    expect(r.row[0]).toMatchObject({ business_id: BIZ, outreach_id: outreachId, campaign_version: 3 });
    expect(r.scope).toBe(BIZ);
  });

  it("returns nothing for an unknown CallSid", async () => {
    const r = await appTx((c) => c.query(`SELECT * FROM app_outbound_attempt_by_call_sid('CAnope')`));
    expect(r.rows).toEqual([]);
  });
});

d("app_outbound_due", () => {
  it("returns ids only, only for waiting outreach overdue by more than the grace period", async () => {
    const r = await appTx((c) => c.query(`SELECT * FROM app_outbound_due(100, 120)`));
    expect(r.fields.map((f) => f.name)).toEqual(["business_id", "outreach_id"]);
    const ids = r.rows.map((x) => x.outreach_id);
    expect(ids).toContain(dueId);
    expect(ids).not.toContain(futureId);
    expect(ids).not.toContain(closedId);
  });

  it("follows the outreach row: rescheduling into the future removes it from the due list", async () => {
    await admin.query(`UPDATE outreach SET next_attempt_at = now() + interval '1 day' WHERE id = $1`, [dueId]);
    const r = await appTx((c) => c.query(`SELECT outreach_id FROM app_outbound_due(100, 0)`));
    expect(r.rows.map((x) => x.outreach_id)).not.toContain(dueId);
    await admin.query(`UPDATE outreach SET next_attempt_at = now() - interval '10 minutes' WHERE id = $1`, [dueId]);
  });
});

d("app_active_dial_counts", () => {
  it("counts an open attempt and stops counting it when it ends", async () => {
    const before = await appTx((c) => c.query(`SELECT active FROM app_active_dial_counts() WHERE business_id = $1`, [BIZ]));
    expect(before.rows[0]?.active).toBe(1); // CAdir0001 from above
    await admin.query(`UPDATE call_attempts SET ended_at = now(), result = 'connected' WHERE twilio_call_sid = 'CAdir0001'`);
    const after = await appTx((c) => c.query(`SELECT active FROM app_active_dial_counts() WHERE business_id = $1`, [BIZ]));
    expect(after.rows).toEqual([]);
  });

  it("ignores an attempt older than an hour that never ended (a lost status callback cannot block capacity forever)", async () => {
    await admin.query(`INSERT INTO call_attempts (business_id,outreach_id,attempt_no,from_number,to_number,twilio_call_sid,dialed_at)
                       VALUES ($1,$2,2,'+441372656055','+447700900111','CAdir-stale', now() - interval '2 hours')`, [BIZ, outreachId]);
    const r = await appTx((c) => c.query(`SELECT active FROM app_active_dial_counts() WHERE business_id = $1`, [BIZ]));
    expect(r.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL in `beforeAll`: `function app_outbound_attempt_by_call_sid(text) does not exist`.

- [ ] **Step 3: Write the migration**

```sql
-- database/044_outbound_directories.sql
-- ============================================================
-- Migration 044: outbound -- the cross-tenant reads, done the 033 way
-- ============================================================
-- Three questions are asked before a tenant is known, or across all tenants:
--   * which tenant/attempt does this Twilio CallSid belong to (door, callbacks, session)
--   * which outreach is due (the sweep)
--   * how many outbound calls are live (the capacity check)
-- FORCE RLS binds a SECURITY DEFINER function's OWNER (033:8-31), and Cloud
-- SQL's postgres cannot bypass it -- so a definer SELECT on call_attempts or
-- outreach returns 0 rows in production while passing locally as `vetra`.
-- Hence three routing tables with NO row-level security, revoked from the
-- application, kept true by triggers, and read only by the functions below.
-- They hold ids, timestamps and a state word. Never a phone number or a name.

CREATE TABLE IF NOT EXISTS call_attempt_directory (
  twilio_call_sid text PRIMARY KEY,
  attempt_id      uuid NOT NULL,
  business_id     uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS dial_registry (
  attempt_id  uuid PRIMARY KEY,
  business_id uuid NOT NULL,
  dialed_at   timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS outreach_schedule (
  outreach_id     uuid PRIMARY KEY,
  business_id     uuid NOT NULL,
  state           text NOT NULL,
  next_attempt_at timestamptz
);
CREATE INDEX IF NOT EXISTS outreach_schedule_due_idx ON outreach_schedule (state, next_attempt_at);

REVOKE ALL ON call_attempt_directory, dial_registry, outreach_schedule FROM PUBLIC;
REVOKE ALL ON call_attempt_directory, dial_registry, outreach_schedule FROM vetra_app;

-- Keeping them true. SECURITY DEFINER because the writer (vetra_app, under
-- RLS on call_attempts / outreach) has no rights on the directories.
CREATE OR REPLACE FUNCTION app_sync_outbound_directories()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    IF OLD.twilio_call_sid IS NOT NULL THEN
      DELETE FROM call_attempt_directory WHERE twilio_call_sid = OLD.twilio_call_sid;
    END IF;
    DELETE FROM dial_registry WHERE attempt_id = OLD.id;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    IF NEW.twilio_call_sid IS NOT NULL THEN
      INSERT INTO call_attempt_directory (twilio_call_sid, attempt_id, business_id)
      VALUES (NEW.twilio_call_sid, NEW.id, NEW.business_id)
      ON CONFLICT (twilio_call_sid) DO UPDATE SET attempt_id = EXCLUDED.attempt_id, business_id = EXCLUDED.business_id;
    END IF;
    IF NEW.ended_at IS NULL AND NEW.result IS NULL THEN
      INSERT INTO dial_registry (attempt_id, business_id, dialed_at)
      VALUES (NEW.id, NEW.business_id, COALESCE(NEW.dialed_at, now()))
      ON CONFLICT (attempt_id) DO UPDATE SET dialed_at = EXCLUDED.dialed_at;
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS outbound_directories_sync ON call_attempts;
CREATE TRIGGER outbound_directories_sync
  AFTER INSERT OR UPDATE OF twilio_call_sid, ended_at, result, dialed_at OR DELETE ON call_attempts
  FOR EACH ROW EXECUTE FUNCTION app_sync_outbound_directories();

CREATE OR REPLACE FUNCTION app_sync_outreach_schedule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.state = 'closed' THEN
    DELETE FROM outreach_schedule WHERE outreach_id = COALESCE(OLD.id, NEW.id);
  ELSE
    INSERT INTO outreach_schedule (outreach_id, business_id, state, next_attempt_at)
    VALUES (NEW.id, NEW.business_id, NEW.state, NEW.next_attempt_at)
    ON CONFLICT (outreach_id) DO UPDATE SET state = EXCLUDED.state, next_attempt_at = EXCLUDED.next_attempt_at;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS outreach_schedule_sync ON outreach;
CREATE TRIGGER outreach_schedule_sync
  AFTER INSERT OR UPDATE OF state, next_attempt_at OR DELETE ON outreach
  FOR EACH ROW EXECUTE FUNCTION app_sync_outreach_schedule();

CREATE OR REPLACE FUNCTION app_outbound_attempt_by_call_sid(p_sid text)
RETURNS TABLE (business_id uuid, attempt_id uuid, outreach_id uuid, campaign_id uuid, campaign_version int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_biz uuid;
  v_att uuid;
  v_current text := current_setting('app.business_id', true);
BEGIN
  IF p_sid IS NULL OR btrim(p_sid) = '' THEN RETURN; END IF;
  SELECT d.business_id, d.attempt_id INTO v_biz, v_att
    FROM call_attempt_directory d WHERE d.twilio_call_sid = btrim(p_sid);
  IF v_biz IS NULL THEN RETURN; END IF;
  -- Adopt only when no scope is declared (the 033 rule): never repoint a
  -- transaction that already knows its tenant.
  IF v_current IS NULL OR v_current = '' THEN
    PERFORM set_config('app.business_id', v_biz::text, true);
  END IF;
  RETURN QUERY
    SELECT a.business_id, a.id, a.outreach_id, o.campaign_id, o.campaign_version
      FROM call_attempts a JOIN outreach o ON o.id = a.outreach_id
     WHERE a.id = v_att;
END $$;

CREATE OR REPLACE FUNCTION app_outbound_due(p_limit int, p_grace_seconds int)
RETURNS TABLE (business_id uuid, outreach_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.business_id, s.outreach_id
    FROM outreach_schedule s
   WHERE s.state = 'waiting'
     AND s.next_attempt_at IS NOT NULL
     AND s.next_attempt_at <= now() - make_interval(secs => GREATEST(p_grace_seconds, 0))
   ORDER BY s.next_attempt_at
   LIMIT LEAST(GREATEST(p_limit, 1), 500);
$$;

CREATE OR REPLACE FUNCTION app_active_dial_counts()
RETURNS TABLE (business_id uuid, active int)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.business_id, count(*)::int
    FROM dial_registry r
   WHERE r.dialed_at > now() - interval '1 hour'
   GROUP BY r.business_id;
$$;

REVOKE ALL ON FUNCTION app_outbound_attempt_by_call_sid(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_outbound_due(int, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_active_dial_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_outbound_attempt_by_call_sid(text) TO vetra_app;
GRANT EXECUTE ON FUNCTION app_outbound_due(int, int) TO vetra_app;
GRANT EXECUTE ON FUNCTION app_active_dial_counts() TO vetra_app;
```

- [ ] **Step 4: Fold into `schema.sql`.** Also add `call_attempt_directory`, `dial_registry` and `outreach_schedule` to `tests/db/directoryGrants.test.js` wherever it lists tables that must be unreadable by `vetra_app`. Read that file first; it follows the same idiom as `business_directory`.

- [ ] **Step 5: Run the tests and confirm they pass.** Run `db:migrate`, then `outboundDirectories`, `directoryGrants`, `schemaParity`, `outboundRls` and `outboundLinks`. Then run `db:reset` followed by `db:migrate`; the fold must apply on its own. Expected: PASS.

- [ ] **Step 6: Sabotage C1** (this is the reason Task 3 exists). It is applied to the `schema.sql` copy, per the §0.1 loop.
  1. With Edit, change `app_outbound_attempt_by_call_sid`'s lookup **in `schema.sql`** to read `call_attempts` directly: `SELECT a.business_id, a.id INTO v_biz, v_att FROM call_attempts a WHERE a.twilio_call_sid = btrim(p_sid);`.
  2. Run `db:reset` and the test. Expected: "resolves a CallSid … with NO scope" goes **RED** (0 rows), because the owner is NOBYPASSRLS.
  3. Revert, and confirm with `grep -c "FROM call_attempt_directory d" database/schema.sql` (it must be `1`).
  4. Run `db:reset`, then `db:migrate`, then re-run the test.

- [ ] **Step 7: Commit.** Message: `feat(outbound): migration 044, the directories and definer functions that work under FORCE RLS`.

---

### Task 4: `lib/outbound/config.js` and `lib/outbound/schedule.js`, the schedule grammar and calling windows

**Files:**
- Create: `lib/outbound/config.js`, `lib/outbound/schedule.js`
- Test: `tests/outboundSchedule.test.js`, `tests/outboundConfig.test.js`
- Modify: `.env.example` (add `OUTBOUND_ENABLED`, `OUTBOUND_TEST_ALLOWLIST`, `OUTBOUND_MAX_CONCURRENT`, `OUTBOUND_INBOUND_RESERVE`, `OUTBOUND_TASKS_QUEUE`, `OUTBOUND_TASKS_SA`, each with a one-line comment)

**Interfaces:**
- Consumes: `zonedComponentsToUtcMs`, `zonedWeekdayAndMinutes` from `lib/capabilities/datetime.js`.
- Produces:
  - `outboundEnv(env=process.env) → {enabled:boolean, allowlist:Set<string>, maxConcurrent:number, inboundReserve:number, tasksQueue:string|null, tasksSa:string|null, baseUrl:string|null}`
  - `parseScheduleEntry(s) → {kind:"now"}|{kind:"offset",ms}|{kind:"next_day",h,m}|{kind:"day_n",n,h,m}`, which throws `Error("bad schedule entry: …")`
  - `computeAttemptAt({entry, now, lastEndedAt, createdAt, timezone}) → Date`
  - `parseWindow(s) → {start, end}` in minutes, or `null`
  - `dayWindow(callingWindow, weekday) → {start, end}|null`
  - `isInsideWindow(date, callingWindow, tz) → boolean`
  - `nextWindowOpening(date, callingWindow, tz) → Date|null`
  - `applyWindow(date, callingWindow, tz, rand=Math.random) → Date`
  - `contactTimezone(contact, businessTz) → string`

- [ ] **Step 1: Write the failing tests**

```js
// tests/outboundConfig.test.js
import { describe, it, expect } from "vitest";
import { outboundEnv } from "../lib/outbound/config.js";

describe("outboundEnv", () => {
  it("is OFF with the spec defaults when nothing is set", () => {
    const e = outboundEnv({});
    expect(e).toMatchObject({ enabled: false, maxConcurrent: 8, inboundReserve: 2, tasksQueue: null, tasksSa: null });
    expect([...e.allowlist]).toEqual([]);
  });
  it("only the literal 'true' switches it on", () => {
    expect(outboundEnv({ OUTBOUND_ENABLED: "1" }).enabled).toBe(false);
    expect(outboundEnv({ OUTBOUND_ENABLED: "true" }).enabled).toBe(true);
  });
  it("parses the allowlist as E.164 only and drops anything else", () => {
    const e = outboundEnv({ OUTBOUND_TEST_ALLOWLIST: " +14699338887, +447700900123 ,garbage,07700" });
    expect([...e.allowlist].sort()).toEqual(["+14699338887", "+447700900123"]);
  });
  it("refuses a reserve that would leave no outbound line, clamping to a working value", () => {
    expect(outboundEnv({ OUTBOUND_MAX_CONCURRENT: "3", OUTBOUND_INBOUND_RESERVE: "5" }).inboundReserve).toBe(2);
  });
});
```

```js
// tests/outboundSchedule.test.js
import { describe, it, expect } from "vitest";
import {
  parseScheduleEntry, computeAttemptAt, parseWindow, isInsideWindow, nextWindowOpening, applyWindow, contactTimezone,
} from "../lib/outbound/schedule.js";

const LDN = "Europe/London";
const WIN = { mon_fri: "09:00-20:00", sat: "10:00-16:00", sun: null, outside_window: "queue" };

describe("parseScheduleEntry", () => {
  it.each([
    ["now", { kind: "now" }],
    ["+10m", { kind: "offset", ms: 600_000 }],
    ["+3h", { kind: "offset", ms: 10_800_000 }],
    ["next_day 10:00", { kind: "next_day", h: 10, m: 0 }],
    ["day_3 17:30", { kind: "day_n", n: 3, h: 17, m: 30 }],
  ])("%s", (s, want) => expect(parseScheduleEntry(s)).toEqual(want));

  it.each(["", "later", "+0m", "+10s", "next_day 24:00", "next_day 9:00", "day_0 10:00", "day_3 10:60"])(
    "refuses %j", (s) => expect(() => parseScheduleEntry(s)).toThrow(/bad schedule entry/));
});

describe("computeAttemptAt", () => {
  const created = new Date("2026-09-28T09:00:00Z"); // Mon 10:00 BST
  it("now is now", () => {
    const now = new Date("2026-09-28T09:05:00Z");
    expect(computeAttemptAt({ entry: "now", now, createdAt: created, timezone: LDN }).toISOString()).toBe(now.toISOString());
  });
  it("+Nm counts from the END of the previous attempt, not from now", () => {
    const r = computeAttemptAt({ entry: "+10m", now: new Date("2026-09-28T09:30:00Z"), lastEndedAt: new Date("2026-09-28T09:01:00Z"), createdAt: created, timezone: LDN });
    expect(r.toISOString()).toBe("2026-09-28T09:11:00.000Z");
  });
  it("next_day HH:MM is local wall-clock time on the next calendar day", () => {
    const r = computeAttemptAt({ entry: "next_day 10:00", now: new Date("2026-09-28T19:00:00Z"), lastEndedAt: new Date("2026-09-28T19:00:00Z"), createdAt: created, timezone: LDN });
    expect(r.toISOString()).toBe("2026-09-29T09:00:00.000Z"); // 10:00 BST
  });
  it("day_N counts from outreach creation, day 1 = creation day", () => {
    const r = computeAttemptAt({ entry: "day_3 17:30", now: new Date("2026-09-29T12:00:00Z"), createdAt: created, timezone: LDN });
    expect(r.toISOString()).toBe("2026-09-30T16:30:00.000Z"); // Wed 17:30 BST
  });
  it("next_day across the spring-forward night lands on the right UTC instant", () => {
    const r = computeAttemptAt({ entry: "next_day 10:00", now: new Date("2026-03-28T15:00:00Z"), lastEndedAt: new Date("2026-03-28T15:00:00Z"), createdAt: created, timezone: LDN });
    expect(r.toISOString()).toBe("2026-03-29T09:00:00.000Z"); // 10:00 BST on the change day
  });
  it("next_day across the fall-back night lands on the right UTC instant", () => {
    const r = computeAttemptAt({ entry: "next_day 10:00", now: new Date("2026-10-24T14:00:00Z"), lastEndedAt: new Date("2026-10-24T14:00:00Z"), createdAt: created, timezone: LDN });
    expect(r.toISOString()).toBe("2026-10-25T10:00:00.000Z"); // 10:00 GMT
  });
});

describe("calling windows", () => {
  it("parseWindow reads HH:MM-HH:MM into minutes and null into null", () => {
    expect(parseWindow("09:00-20:00")).toEqual({ start: 540, end: 1200 });
    expect(parseWindow(null)).toBeNull();
  });
  it("inside on a weekday afternoon, outside before opening, outside on Sunday", () => {
    expect(isInsideWindow(new Date("2026-09-28T13:00:00Z"), WIN, LDN)).toBe(true);   // Mon 14:00
    expect(isInsideWindow(new Date("2026-09-28T07:30:00Z"), WIN, LDN)).toBe(false);  // Mon 08:30
    expect(isInsideWindow(new Date("2026-09-27T13:00:00Z"), WIN, LDN)).toBe(false);  // Sun
  });
  it("the end is exclusive: 20:00 on the dot is outside", () => {
    expect(isInsideWindow(new Date("2026-09-28T19:00:00Z"), WIN, LDN)).toBe(false);  // Mon 20:00 BST
  });
  it("uses the contact's local clock across the DST change", () => {
    expect(isInsideWindow(new Date("2026-03-29T08:30:00Z"), { ...WIN, sun: "09:00-12:00" }, LDN)).toBe(true);  // 09:30 BST
    expect(isInsideWindow(new Date("2026-03-29T07:30:00Z"), { ...WIN, sun: "09:00-12:00" }, LDN)).toBe(false); // 08:30 BST
  });
  it("nextWindowOpening: Friday night rolls to Saturday 10:00, Saturday evening to Monday 09:00", () => {
    expect(nextWindowOpening(new Date("2026-10-02T20:30:00Z"), WIN, LDN).toISOString()).toBe("2026-10-03T09:00:00.000Z");
    expect(nextWindowOpening(new Date("2026-10-03T16:30:00Z"), WIN, LDN).toISOString()).toBe("2026-10-05T08:00:00.000Z");
  });
  it("nextWindowOpening is null for a window with no open day", () => {
    expect(nextWindowOpening(new Date(), { mon_fri: null, sat: null, sun: null }, LDN)).toBeNull();
  });
  it("applyWindow keeps an inside time and moves an outside one to opening + 0..10 min of jitter", () => {
    const inside = new Date("2026-09-28T13:00:00Z");
    expect(applyWindow(inside, WIN, LDN, () => 0.5).toISOString()).toBe(inside.toISOString());
    expect(applyWindow(new Date("2026-09-28T05:00:00Z"), WIN, LDN, () => 0).toISOString()).toBe("2026-09-28T08:00:00.000Z");
    expect(applyWindow(new Date("2026-09-28T05:00:00Z"), WIN, LDN, () => 0.999).getTime())
      .toBeLessThan(new Date("2026-09-28T08:10:00Z").getTime());
  });
});

describe("contactTimezone", () => {
  it("prefers the contact's own zone, then +44 means London, then the business zone", () => {
    expect(contactTimezone({ timezone: "Europe/Dublin", phone_e164: "+447700900001" }, "America/Chicago")).toBe("Europe/Dublin");
    expect(contactTimezone({ phone_e164: "+447700900001" }, "America/Chicago")).toBe("Europe/London");
    expect(contactTimezone({ phone_e164: "+14699338887" }, "America/Chicago")).toBe("America/Chicago");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run: `npx vitest run tests/outboundSchedule.test.js tests/outboundConfig.test.js`. Expected: FAIL (the modules are missing).

- [ ] **Step 3: Implement**

```js
// lib/outbound/config.js
/**
 * Outbound calling's environment, read once. Spec §14. OFF unless the literal
 * string "true" -- the switch is a safety control, and "1" or "yes" silently
 * meaning ON is how a kill switch stops being one.
 */
const E164 = /^\+[1-9]\d{6,14}$/;

export function outboundEnv(env = process.env) {
  const maxConcurrent = Math.max(1, parseInt(env.OUTBOUND_MAX_CONCURRENT || "8", 10) || 8);
  let inboundReserve = Math.max(0, parseInt(env.OUTBOUND_INBOUND_RESERVE || "2", 10) || 0);
  if (inboundReserve >= maxConcurrent) inboundReserve = Math.max(0, Math.min(2, maxConcurrent - 1));
  const allowlist = new Set(
    String(env.OUTBOUND_TEST_ALLOWLIST || "").split(",").map((s) => s.trim()).filter((s) => E164.test(s))
  );
  return Object.freeze({
    enabled: env.OUTBOUND_ENABLED === "true",
    allowlist,
    maxConcurrent,
    inboundReserve,
    tasksQueue: env.OUTBOUND_TASKS_QUEUE || null,
    tasksSa: env.OUTBOUND_TASKS_SA || null,
    baseUrl: (env.BASE_URL || "").replace(/\/$/, "") || null,
  });
}
```

```js
// lib/outbound/schedule.js
/**
 * Retry-schedule grammar and calling-window arithmetic (spec §8), always on
 * the CONTACT's wall clock. Pure: no I/O, no Date.now() -- `now` and `rand`
 * are arguments, so every test is exact.
 *
 * Reuses lib/capabilities/datetime.js for zone conversion, which already
 * handles the DST-transition day by refining the offset once.
 */
import { zonedComponentsToUtcMs, zonedWeekdayAndMinutes } from "../capabilities/datetime.js";

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseScheduleEntry(s) {
  const bad = () => new Error(`bad schedule entry: ${JSON.stringify(s)}`);
  if (typeof s !== "string") throw bad();
  if (s === "now") return { kind: "now" };
  let m = s.match(/^\+([1-9]\d{0,3})([mh])$/);
  if (m) return { kind: "offset", ms: Number(m[1]) * (m[2] === "m" ? 60_000 : 3_600_000) };
  m = s.match(/^next_day (\d\d:\d\d)$/);
  if (m) { const t = m[1].match(HHMM); if (!t) throw bad(); return { kind: "next_day", h: +t[1], m: +t[2] }; }
  m = s.match(/^day_([1-9]\d?) (\d\d:\d\d)$/);
  if (m) { const t = m[2].match(HHMM); if (!t) throw bad(); return { kind: "day_n", n: +m[1], h: +t[1], m: +t[2] }; }
  throw bad();
}

/** Local calendar date (y, m, d) of an instant in a zone. */
function localDate(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)])
  );
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** The same local date moved by `days` calendar days (DST-safe: calendar arithmetic, not ms). */
function addDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function atLocal(ymd, h, m, tz) {
  return new Date(zonedComponentsToUtcMs({ ...ymd, hour: h, minute: m, second: 0 }, tz));
}

export function computeAttemptAt({ entry, now, lastEndedAt = null, createdAt, timezone }) {
  const e = typeof entry === "string" ? parseScheduleEntry(entry) : entry;
  switch (e.kind) {
    case "now": return new Date(now.getTime());
    case "offset": return new Date((lastEndedAt ?? now).getTime() + e.ms);
    case "next_day": return atLocal(addDays(localDate(lastEndedAt ?? now, timezone), 1), e.h, e.m, timezone);
    case "day_n": return atLocal(addDays(localDate(createdAt, timezone), e.n - 1), e.h, e.m, timezone);
    default: throw new Error(`bad schedule entry kind: ${e.kind}`);
  }
}

export function parseWindow(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).match(/^(\d\d:\d\d)-(\d\d:\d\d)$/);
  if (!m) throw new Error(`bad window: ${JSON.stringify(s)}`);
  const a = m[1].match(HHMM), b = m[2].match(HHMM);
  if (!a || !b) throw new Error(`bad window: ${JSON.stringify(s)}`);
  const start = +a[1] * 60 + +a[2], end = +b[1] * 60 + +b[2];
  if (end <= start) throw new Error(`bad window: ${JSON.stringify(s)}`);
  return { start, end };
}

const WEEKDAY_KEY = { mon: "mon_fri", tue: "mon_fri", wed: "mon_fri", thu: "mon_fri", fri: "mon_fri", sat: "sat", sun: "sun" };

export function dayWindow(callingWindow, shortWeekday) {
  return parseWindow(callingWindow?.[WEEKDAY_KEY[shortWeekday]] ?? null);
}

export function isInsideWindow(date, callingWindow, tz) {
  const { shortWeekday, minutesOfDay } = zonedWeekdayAndMinutes(date.getTime(), tz);
  const w = dayWindow(callingWindow, shortWeekday);
  return !!w && minutesOfDay >= w.start && minutesOfDay < w.end;
}

export function nextWindowOpening(date, callingWindow, tz) {
  const today = localDate(date, tz);
  for (let k = 0; k <= 7; k++) {
    const ymd = addDays(today, k);
    const noon = atLocal(ymd, 12, 0, tz);
    const { shortWeekday } = zonedWeekdayAndMinutes(noon.getTime(), tz);
    const w = dayWindow(callingWindow, shortWeekday);
    if (!w) continue;
    const opening = atLocal(ymd, Math.floor(w.start / 60), w.start % 60, tz);
    if (opening.getTime() > date.getTime()) return opening;
    // Today, already open, not yet closed: "now" is inside, so the opening that matters is the next one.
  }
  return null;
}

export function applyWindow(date, callingWindow, tz, rand = Math.random) {
  if (isInsideWindow(date, callingWindow, tz)) return date;
  const opening = nextWindowOpening(date, callingWindow, tz);
  if (!opening) return date; // no open day at all: the gate refuses such a campaign at save
  return new Date(opening.getTime() + Math.floor(rand() * 10 * 60_000));
}

export function contactTimezone(contact, businessTz) {
  if (contact?.timezone) return contact.timezone;
  if (String(contact?.phone_e164 || "").startsWith("+44")) return "Europe/London";
  return businessTz || "Europe/London";
}
```

- [ ] **Step 4: Run the tests and confirm they pass.** Also run `tests/envInventory.test.js`. Expected: PASS.
- [ ] **Step 5: Sabotage.**
  1. Sabotage `atLocal` to `new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day, h, m))`, i.e. ignore the zone. Confirm the sabotage landed.
  2. Expected: every test whose expectation is in **BST** goes RED (the Monday/Tuesday/Wednesday cases, spring-forward and the window openings).
  3. The **fall-back** `next_day` test (expected `10:00Z`, which is GMT, where the zone offset is zero) stays GREEN. That is correct, and is why the file also carries BST cases.
  4. Revert, and confirm with `grep -c SABOTAGE` (it must be `0`).

  Sabotaging `addDays` into milliseconds is **not** discriminating, because it moves dates, not times. Don't use it as the proof.
- [ ] **Step 6: Commit.** Message: `feat(outbound): schedule grammar and calling windows on the contact's clock`.

---

### Task 5: The campaign schema and the `speed_to_lead` template

**Files:**
- Create:
  - `lib/outbound/campaignSchema.js`
  - `lib/outbound/templates.js`
  - `scripts/export-campaign-schema.js`
  - `AI-phone-dashboard/backend/src/generated/campaignSchema.json` (generated)
- Test: `tests/outboundCampaignSchema.test.js`, `tests/outboundCampaignSchemaExport.test.js`

**Interfaces:**
- Produces:
  - `AI_DISCLOSURE_RE`
  - `CAMPAIGN_LIMITS`
  - `CAMPAIGN_ENUMS`
  - `renderTemplate(tpl, vars) → string`
  - `spokenNumber(e164) → string`
  - `validateCampaign(meta, config, {businessName}) → {ok:true, value}|{ok:false, errors:[{path,message}]}`
  - `buildCampaignSchemaExport() → object`
  - `TEMPLATES.speed_to_lead` and `PURPOSE_BY_TEMPLATE`
  - `WORST_CASE_VARS(meta, config, businessName)`, used for the budget checks

- [ ] **Step 1: Write the failing tests**

```js
// tests/outboundCampaignSchema.test.js
import { describe, it, expect } from "vitest";
import { validateCampaign, renderTemplate, spokenNumber, AI_DISCLOSURE_RE } from "../lib/outbound/campaignSchema.js";
import { TEMPLATES, PURPOSE_BY_TEMPLATE } from "../lib/outbound/templates.js";

const META = { name: "Speed to lead", template_key: "speed_to_lead", compliance_class: "solicited", audience: "business" };
const good = () => ({ ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055" });
const v = (cfg, meta = META) => validateCampaign(meta, cfg, { businessName: "Digile Media" });
const errPaths = (r) => r.errors.map((e) => e.path);

describe("validateCampaign: the template is valid once a caller ID is set", () => {
  it("accepts speed_to_lead + caller_id", () => expect(v(good())).toEqual({ ok: true, value: good() }));
  it("rejects speed_to_lead as shipped, because caller_id is blank", () => expect(errPaths(v(TEMPLATES.speed_to_lead))).toContain("caller_id"));
  it("maps speed_to_lead to the enquiry_followup consent purpose", () => expect(PURPOSE_BY_TEMPLATE.speed_to_lead).toBe("enquiry_followup"));
});

describe("validateCampaign: every refusal (each one is a coded rule because ignoring it hurts someone)", () => {
  it("unknown keys are rejected (strict), not dropped", () => expect(errPaths(v({ ...good(), surprise: 1 }))).toContain("surprise"));
  it("opener without {business_name}", () =>
    expect(errPaths(v({ ...good(), opener: "Hi {first_name}, it's {persona_name}, an AI assistant. Got a minute?" }))).toContain("opener"));
  it("opener without an AI disclosure", () =>
    expect(errPaths(v({ ...good(), opener: "Hi {first_name}, it's {persona_name} from {business_name}. Got a minute?" }))).toContain("opener"));
  it("voicemail without an AI disclosure", () =>
    expect(errPaths(v({ ...good(), voicemail: "Hi {first_name}, {business_name} here, call us back." }))).toContain("voicemail"));
  it("opener that renders over 120 characters with a 30-character first name is refused, never truncated (it is the backstop line)", () =>
    expect(errPaths(v({ ...good(), opener: "Hi {first_name}, {business_name} AI " + "x".repeat(80) }))).toContain("opener"));
  it("voicemail that renders over 300 characters is refused", () =>
    expect(errPaths(v({ ...good(), voicemail: "Hi {first_name}, the AI assistant from {business_name}. " + "x".repeat(260) }))).toContain("voicemail"));
  it("the shipped demo opener fits the 120-character budget with a 30-character first name", () =>
    expect(v(good()).ok).toBe(true));
  it("an unknown placeholder is refused", () =>
    expect(errPaths(v({ ...good(), opener: "Hi {firstname}, AI from {business_name}" }))).toContain("opener"));
  it("a calling window starting before 08:00 is refused", () =>
    expect(errPaths(v({ ...good(), calling_window: { ...good().calling_window, mon_fri: "07:30-20:00" } }))).toContain("calling_window.mon_fri"));
  it("a calling window ending after 21:00 is refused", () =>
    expect(errPaths(v({ ...good(), calling_window: { ...good().calling_window, sat: "10:00-21:30" } }))).toContain("calling_window.sat"));
  it("a window with no open day at all is refused", () =>
    expect(errPaths(v({ ...good(), calling_window: { mon_fri: null, sat: null, sun: null, outside_window: "queue" } }))).toContain("calling_window"));
  it("marketing_consented is refused in Part 1 with a message naming Part 3", () => {
    const r = v(good(), { ...META, compliance_class: "marketing_consented" });
    expect(r.errors.find((e) => e.path === "compliance_class").message).toMatch(/Part 3/);
  });
  it("audience patient is refused in Part 1", () => expect(errPaths(v(good(), { ...META, audience: "patient" }))).toContain("audience"));
  it("more than 6 retry entries", () =>
    expect(errPaths(v({ ...good(), retries: { ...good().retries, schedule: ["now", "+10m", "+1h", "+2h", "+3h", "+4h", "+5h"] } }))).toContain("retries.schedule"));
  it("a malformed retry entry", () =>
    expect(errPaths(v({ ...good(), retries: { ...good().retries, schedule: ["now", "+10s"] } }))).toContain("retries.schedule[1]"));
  it("give_up_after_days over 30", () =>
    expect(errPaths(v({ ...good(), retries: { ...good().retries, give_up_after_days: 31 } }))).toContain("retries.give_up_after_days"));
  it("voicemail_on naming an attempt the schedule does not have", () =>
    expect(errPaths(v({ ...good(), retries: { ...good().retries, voicemail_on: [9] } }))).toContain("retries.voicemail_on"));
  it("consent_window_days over 90", () => expect(errPaths(v({ ...good(), consent_window_days: 91 }))).toContain("consent_window_days"));
  it("notes over 2000 characters are refused, never sliced", () => expect(errPaths(v({ ...good(), notes: "n".repeat(2001) }))).toContain("notes"));
  it("persona_name over 30 characters", () => expect(errPaths(v({ ...good(), persona_name: "p".repeat(31) }))).toContain("persona_name"));
  it("a caller_id that is not E.164", () => expect(errPaths(v({ ...good(), caller_id: "01372 656055" }))).toContain("caller_id"));
  it("opt_out cannot be switched off -- a stop request must always work", () =>
    expect(errPaths(v({ ...good(), capabilities: ["qualification", "appointments"] }))).toContain("capabilities"));
  it("an unknown capability", () => expect(errPaths(v({ ...good(), capabilities: [...good().capabilities, "telepathy"] }))).toContain("capabilities"));
  it("a question key that is not snake_case", () =>
    expect(errPaths(v({ ...good(), questions: [{ key: "Clinic Name", ask: "?", required: true, type: "text" }] }))).toContain("questions[0].key"));
});

describe("renderTemplate / spokenNumber", () => {
  it("fills known placeholders and leaves nothing else changed", () =>
    expect(renderTemplate("Hi {first_name}, {business_name}", { first_name: "Sam", business_name: "Digile" })).toBe("Hi Sam, Digile"));
  it("reads a UK number in national form, grouped for speech", () => expect(spokenNumber("+441372656055")).toBe("01372 656 055"));
  it("AI_DISCLOSURE_RE is the spec's regex", () => expect(AI_DISCLOSURE_RE.source).toBe("\\b(AI|artificial intelligence|automated assistant|virtual assistant)\\b"));
});
```

```js
// tests/outboundCampaignSchemaExport.test.js
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { buildCampaignSchemaExport } from "../lib/outbound/campaignSchema.js";

const FILE = "AI-phone-dashboard/backend/src/generated/campaignSchema.json";

describe("campaign schema export (the dashboard's copy)", () => {
  it("exists and matches what the engine enforces -- run `node scripts/export-campaign-schema.js` if this fails", () => {
    expect(JSON.parse(fs.readFileSync(FILE, "utf8"))).toEqual(buildCampaignSchemaExport());
  });
  it("carries the Part 1 refusals, so the dashboard can grey them out", () => {
    const s = buildCampaignSchemaExport();
    expect(s.refusedInPart1).toEqual({ compliance_class: ["marketing_consented"], audience: ["patient"] });
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Expected: FAIL (the modules are missing).

- [ ] **Step 3: Implement.** Write `lib/outbound/templates.js` exactly as below. Write `lib/outbound/campaignSchema.js` with:
  - `CAMPAIGN_LIMITS = { persona_name: 30, topic: 80, objective: 500, notes: 2000, rendered_opener: 120, rendered_voicemail: 300, question_ask: 200, questions: 10, retries: 6, give_up_after_days: 30, consent_window_days: 90, max_call_minutes: 30, first_name_worst_case: 30 }`. `rendered_opener` is 120 per spec §7 as revised after spike A, since the opener is the short backstop line.
  - `CAMPAIGN_ENUMS = { template_key: [...8], compliance_class: ["solicited","service","marketing_consented"], audience: ["business","patient"], capabilities: ["qualification","appointments","transfer","callback","opt_out","outcome"], question_type: ["text","number","yes_no"], outside_window: ["queue","queue_and_text"], booking_adapter: ["internal"] }`
  - `TEMPLATE_PLACEHOLDERS = ["first_name","persona_name","business_name","topic","caller_id_spoken"]`
  - an `ALLOWED_KEYS` set of the **15** top-level keys in spec §7: `persona_name, caller_id, calling_window, opener, topic, objective, notes, questions, capabilities, booking, transfer, retries, voicemail, consent_window_days, max_call_minutes`
  - `validateCampaign`, which walks each rule from the tests above in order and collects ALL errors, not just the first, because the dashboard shows them all at once. Rendered length is checked with `first_name = "x".repeat(30)` and the real business name, persona, topic and caller ID.
  - `buildCampaignSchemaExport() → { version: 1, limits: CAMPAIGN_LIMITS, enums: CAMPAIGN_ENUMS, placeholders: TEMPLATE_PLACEHOLDERS, aiDisclosurePattern: AI_DISCLOSURE_RE.source, windowBounds: { earliest: "08:00", latest: "21:00" }, refusedInPart1: {...} }`

  `scripts/export-campaign-schema.js` mirrors `scripts/export-capability-schemas.js:22-25,74`: it writes the file only when run directly.

```js
// lib/outbound/templates.js
/**
 * Named presets of the campaign config (spec §7). Part 1 ships speed_to_lead
 * only; the rest arrive with Part 3. caller_id is deliberately blank -- it
 * must be a number on the service's Twilio account, so a template cannot
 * guess it, and a blank one is refused at save.
 */
export const TEMPLATES = Object.freeze({
  speed_to_lead: Object.freeze({
    persona_name: "Ava",
    caller_id: "",
    calling_window: { mon_fri: "09:00-20:00", sat: "10:00-16:00", sun: null, outside_window: "queue" },
    // The SHORT backstop line (spec §9.3, 120-char budget). The reason for the
    // call ({topic}) comes in Ava's next sentence, spoken live.
    opener: "Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.",
    topic: "our clinic systems",
    objective: "Qualify the clinic and book a 30-minute discovery call.",
    notes: "",
    questions: [{ key: "clinic_name", ask: "What's the clinic called?", required: true, type: "text" }],
    capabilities: ["qualification", "appointments", "transfer", "callback", "opt_out", "outcome"],
    booking: { adapter: "internal", length_min: 30 },
    transfer: null,
    retries: { schedule: ["now", "+10m", "+3h", "next_day 10:00", "day_3 17:30"], voicemail_on: [1, 5], text_after_missed: [1], give_up_after_days: 7 },
    voicemail: "Hi {first_name}, it's {persona_name}, the AI assistant from {business_name}, about your enquiry. We'll try again later, or call us back on {caller_id_spoken}.",
    consent_window_days: 30,
    max_call_minutes: 10,
  }),
});

/** Which consent purpose each template needs (spec §13.1 "a matching purpose"). */
export const PURPOSE_BY_TEMPLATE = Object.freeze({
  speed_to_lead: "enquiry_followup",
  missed_call_callback: "callback_request",
  reminder: "appointment_service",
  no_show: "appointment_service",
  aftercare: "appointment_service",
  review_request: "review",
  reactivation: "marketing",
  custom: "custom",
});
```

The spec's example has `transfer: { to, when, whisper }`. Validation accepts either `null` or that exact object: `to` in E.164, `when` matching `/^(Mon-Fri|Mon-Sat|Daily) \d\d:\d\d-\d\d:\d\d$/`, and `whisper` a boolean. `questions` holds 0–10 entries: `key` matches `/^[a-z][a-z0-9_]{0,39}$/`, keys are unique, `ask` is ≤ 200, `required` is a boolean, and `type` is in the enum.

- [ ] **Step 4:** Generate the export with `node scripts/export-campaign-schema.js`, then run both tests. Expected: PASS.
- [ ] **Step 5: Sabotage.** Delete the AI-disclosure check. Confirm. Expected: the two disclosure tests go RED. Revert and confirm.
- [ ] **Step 6: Commit.** Message: `feat(outbound): strict campaign schema, speed_to_lead template, dashboard export with drift test`.

---

### Task 6: `lib/outbound/consent.js` (spec §13.1)

**Files:**
- Create: `lib/outbound/consent.js`
- Test: `tests/outboundConsent.test.js`

**Interfaces:**
- Produces: `consentSatisfies({ complianceClass, purpose, consents, consentWindowDays, hasRelationship, now }) → {ok:true}|{ok:false, reason:"consent_missing"|"consent_expired"|"consent_not_automated"}`

- [ ] **Step 1: Write the failing test**

```js
// tests/outboundConsent.test.js
import { describe, it, expect } from "vitest";
import { consentSatisfies } from "../lib/outbound/consent.js";

const now = new Date("2026-09-28T12:00:00Z");
const c = (o = {}) => ({ purpose: "enquiry_followup", channels: ["call", "sms"], covers_automated: true,
  captured_at: new Date("2026-09-20T12:00:00Z"), expires_at: null, revoked_at: null, ...o });
const sol = (consents, extra = {}) => consentSatisfies({ complianceClass: "solicited", purpose: "enquiry_followup", consents, consentWindowDays: 30, hasRelationship: false, now, ...extra });

describe("solicited", () => {
  it("passes with a matching, automated, in-window, unrevoked consent", () => expect(sol([c()])).toEqual({ ok: true }));
  it("no consent at all -> consent_missing", () => expect(sol([])).toEqual({ ok: false, reason: "consent_missing" }));
  it("a consent for another purpose does not count", () => expect(sol([c({ purpose: "review" })]).reason).toBe("consent_missing"));
  it("a consent without the call channel does not count", () => expect(sol([c({ channels: ["sms"] })]).reason).toBe("consent_missing"));
  it("a revoked consent does not count", () => expect(sol([c({ revoked_at: new Date("2026-09-21T00:00:00Z") })]).reason).toBe("consent_missing"));
  it("consent that never mentioned automated/AI calls -> consent_not_automated", () => expect(sol([c({ covers_automated: false })]).reason).toBe("consent_not_automated"));
  it("captured more than consent_window_days ago -> consent_expired", () => expect(sol([c({ captured_at: new Date("2026-08-01T00:00:00Z") })]).reason).toBe("consent_expired"));
  it("past its own expires_at -> consent_expired", () => expect(sol([c({ expires_at: new Date("2026-09-27T00:00:00Z") })]).reason).toBe("consent_expired"));
  it("one good consent among bad ones is enough", () => expect(sol([c({ covers_automated: false }), c()])).toEqual({ ok: true }));
});

describe("service", () => {
  it("needs an existing relationship, not a consent", () => {
    expect(consentSatisfies({ complianceClass: "service", consents: [], hasRelationship: true, now })).toEqual({ ok: true });
    expect(consentSatisfies({ complianceClass: "service", consents: [c()], hasRelationship: false, now }).reason).toBe("consent_missing");
  });
});

describe("marketing_consented", () => {
  it("is refused outright in Part 1 even if a campaign row somehow carries it", () =>
    expect(consentSatisfies({ complianceClass: "marketing_consented", consents: [c()], hasRelationship: true, now }).ok).toBe(false));
});
```

- [ ] **Step 2: Confirm it fails.** Then implement:

```js
// lib/outbound/consent.js
/**
 * Does this contact's evidence satisfy the campaign's compliance class? Spec
 * §13.1. Pure. The ORDER of reasons is deliberate: "missing" beats "not
 * automated" beats "expired", because the most fundamental gap is the one an
 * operator needs to fix first.
 */
const DAY = 86_400_000;

export function consentSatisfies({ complianceClass, purpose, consents = [], consentWindowDays = 30, hasRelationship = false, now }) {
  if (complianceClass === "service") return hasRelationship ? { ok: true } : { ok: false, reason: "consent_missing" };
  if (complianceClass !== "solicited") return { ok: false, reason: "consent_missing" }; // marketing_consented: Part 3
  const relevant = consents.filter((c) => c.purpose === purpose && (c.channels || []).includes("call") && !c.revoked_at);
  if (!relevant.length) return { ok: false, reason: "consent_missing" };
  const automated = relevant.filter((c) => c.covers_automated === true);
  if (!automated.length) return { ok: false, reason: "consent_not_automated" };
  const windowMs = Math.min(Math.max(consentWindowDays, 1), 90) * DAY;
  const live = automated.filter((c) =>
    now.getTime() - new Date(c.captured_at).getTime() <= windowMs &&
    (!c.expires_at || new Date(c.expires_at).getTime() > now.getTime()));
  return live.length ? { ok: true } : { ok: false, reason: "consent_expired" };
}
```

- [ ] **Step 3: Run it and confirm it passes.** Then sabotage: drop the `covers_automated` filter. Confirm. Expected: the `consent_not_automated` test goes RED. Revert.
- [ ] **Step 4: Commit.** Message: `feat(outbound): consent rules by compliance class`.

---

### Task 7: `lib/outbound/gate.js`, the eligibility gate (spec §10.3)

**Files:**
- Create: `lib/outbound/gate.js`
- Modify: `lib/voice/metrics.js` (add the counters `outbound_gate_refused`, `outbound_gate_later` to `COUNTER_NAMES`)
- Test: `tests/outboundGate.test.js`

**Interfaces:**
- Consumes: `consentSatisfies` (Task 6); `isInsideWindow`, `nextWindowOpening`, `applyWindow`, `computeAttemptAt` (Task 4).
- Produces: `evaluateGate(facts, {rand}) → {verdict:"allow"}|{verdict:"later", reason, at:Date|null}|{verdict:"never", reason}`

`facts` is exactly this shape. Dispatch (Task 9) builds it; tests build it directly.

```js
{
  now: Date,
  env: { enabled, allowlist: Set, maxConcurrent, inboundReserve },
  business: { outbound_enabled, outbound_max_concurrent },
  campaign: { status, compliance_class, template_key, config },   // config = the pinned version's config
  contact: { phone_e164, timezone /* resolved */ },
  outreach: { attempts_made, created_at, hold_until },
  suppressed: boolean,
  consents: Array, hasRelationship: boolean,
  dialsToday: number,
  active: { globalOutbound: number, businessOutbound: number },
  callerIdValid: boolean,
}
```

- [ ] **Step 1: Write the failing test.** There is one test per reason: a base fixture that ALLOWS, with exactly one fact changed per case. There is also an order test and a sabotage-safety test.

```js
// tests/outboundGate.test.js
import { describe, it, expect } from "vitest";
import { evaluateGate } from "../lib/outbound/gate.js";
import { TEMPLATES } from "../lib/outbound/templates.js";

const NOW = new Date("2026-09-28T13:00:00Z"); // Mon 14:00 London
const base = () => ({
  now: NOW,
  env: { enabled: false, allowlist: new Set(["+447700900001"]), maxConcurrent: 8, inboundReserve: 2 },
  business: { outbound_enabled: true, outbound_max_concurrent: 2 },
  campaign: { status: "active", compliance_class: "solicited", template_key: "speed_to_lead",
    config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055" } },
  contact: { phone_e164: "+447700900001", timezone: "Europe/London" },
  outreach: { attempts_made: 0, created_at: new Date("2026-09-28T12:59:00Z"), hold_until: null },
  suppressed: false,
  consents: [{ purpose: "enquiry_followup", channels: ["call"], covers_automated: true, captured_at: new Date("2026-09-28T12:58:00Z"), expires_at: null, revoked_at: null }],
  hasRelationship: false,
  dialsToday: 0,
  active: { globalOutbound: 0, businessOutbound: 0 },
  callerIdValid: true,
});
const gate = (f) => evaluateGate(f, { rand: () => 0 });

describe("evaluateGate: the base case dials", () => {
  it("allows an allow-listed number with the global switch off", () => expect(gate(base())).toEqual({ verdict: "allow" }));
});

describe("evaluateGate: each check refuses on its own (11 reasons)", () => {
  const cases = [
    ["global_disabled", "never", (f) => { f.contact.phone_e164 = "+447700900999"; }],
    ["business_disabled", "never", (f) => { f.business.outbound_enabled = false; }],
    ["campaign_paused", "later", (f) => { f.campaign.status = "paused"; }],
    ["suppressed", "never", (f) => { f.suppressed = true; }],
    ["consent_missing", "never", (f) => { f.consents = []; }],
    ["silent_hold", "later", (f) => { f.outreach.hold_until = new Date("2026-09-30T13:00:00Z"); }],
    ["outside_window", "later", (f) => { f.now = new Date("2026-09-28T20:30:00Z"); f.outreach.created_at = new Date("2026-09-28T20:00:00Z"); f.consents[0].captured_at = f.outreach.created_at; }],
    ["attempts_exhausted", "never", (f) => { f.outreach.attempts_made = 5; }],
    ["give_up_window", "never", (f) => { f.outreach.created_at = new Date("2026-09-10T12:00:00Z"); f.consents[0].captured_at = new Date("2026-09-27T12:00:00Z"); }],
    ["daily_contact_cap", "later", (f) => { f.dialsToday = 3; }],
    ["capacity", "later", (f) => { f.active.businessOutbound = 2; }],
    ["caller_id_invalid", "never", (f) => { f.callerIdValid = false; }],
  ];
  it.each(cases)("%s -> %s", (reason, verdict, mutate) => {
    const f = base(); mutate(f);
    expect(gate(f)).toMatchObject({ verdict, reason });
  });

  it("global capacity: outbound at max - reserve is refused even when the business has room", () => {
    const f = base(); f.active.globalOutbound = 6;
    expect(gate(f)).toMatchObject({ verdict: "later", reason: "capacity" });
  });
});

describe("evaluateGate: 'later' carries a time", () => {
  it("capacity retries 30 s later", () => {
    const f = base(); f.active.businessOutbound = 2;
    expect(gate(f).at.toISOString()).toBe("2026-09-28T13:00:30.000Z");
  });
  it("outside the window retries at the next opening (+ jitter, 0 here)", () => {
    const f = base(); f.now = new Date("2026-09-28T20:30:00Z"); f.outreach.created_at = new Date("2026-09-28T20:00:00Z"); f.consents[0].captured_at = f.outreach.created_at;
    expect(gate(f).at.toISOString()).toBe("2026-09-29T08:00:00.000Z"); // Tue 09:00 BST
  });
  it("daily cap retries at tomorrow's opening", () => {
    const f = base(); f.dialsToday = 3;
    expect(gate(f).at.toISOString()).toBe("2026-09-29T08:00:00.000Z");
  });
  it("a paused campaign holds without a time -- resuming re-enqueues", () => {
    const f = base(); f.campaign.status = "paused";
    expect(gate(f)).toEqual({ verdict: "later", reason: "campaign_paused", at: null });
  });
});

describe("evaluateGate: order -- the first failure decides", () => {
  it("suppressed beats outside_window", () => {
    const f = base(); f.suppressed = true; f.now = new Date("2026-09-28T20:30:00Z");
    expect(gate(f).reason).toBe("suppressed");
  });
  it("global_disabled beats everything", () => {
    const f = base(); f.contact.phone_e164 = "+447700900999"; f.suppressed = true; f.callerIdValid = false;
    expect(gate(f).reason).toBe("global_disabled");
  });
});
```

- [ ] **Step 2: Confirm it fails.** Then implement:

```js
// lib/outbound/gate.js
/**
 * The eligibility gate, spec §10.3. Pure: every input is a fact the
 * dispatcher gathered inside the tenant transaction. Evaluated in the spec's
 * order; the FIRST failure decides. This is enforcement in CODE -- the prompt
 * never decides whether a call may happen.
 */
import { consentSatisfies } from "./consent.js";
import { isInsideWindow, nextWindowOpening, applyWindow } from "./schedule.js";
import { PURPOSE_BY_TEMPLATE } from "./templates.js";

const DAY = 86_400_000;
const never = (reason) => ({ verdict: "never", reason });
const later = (reason, at) => ({ verdict: "later", reason, at });

export function evaluateGate(f, { rand = Math.random } = {}) {
  const cfg = f.campaign.config;
  const tz = f.contact.timezone;
  // 1. kill switch, or the test allow-list
  if (!f.env.enabled && !f.env.allowlist.has(f.contact.phone_e164)) return never("global_disabled");
  // 2. per-business switch
  if (!f.business.outbound_enabled) return never("business_disabled");
  // 3. campaign active (paused holds, never closes)
  if (f.campaign.status !== "active") return later("campaign_paused", null);
  // 4. do-not-call
  if (f.suppressed) return never("suppressed");
  // 5. consent for the compliance class
  const consent = consentSatisfies({
    complianceClass: f.campaign.compliance_class,
    purpose: PURPOSE_BY_TEMPLATE[f.campaign.template_key],
    consents: f.consents,
    consentWindowDays: cfg.consent_window_days ?? 30,
    hasRelationship: f.hasRelationship,
    now: f.now,
  });
  if (!consent.ok) return never(consent.reason);
  // 6. silent-call hold
  if (f.outreach.hold_until && new Date(f.outreach.hold_until) > f.now) {
    return later("silent_hold", applyWindow(new Date(f.outreach.hold_until), cfg.calling_window, tz, rand));
  }
  // 7. calling window, contact's clock
  if (!isInsideWindow(f.now, cfg.calling_window, tz)) {
    return later("outside_window", applyWindow(f.now, cfg.calling_window, tz, rand));
  }
  // 8. attempt budget and give-up window
  if (f.outreach.attempts_made >= cfg.retries.schedule.length) return never("attempts_exhausted");
  if (f.now.getTime() - new Date(f.outreach.created_at).getTime() > cfg.retries.give_up_after_days * DAY) return never("give_up_window");
  // 9. per-contact daily cap, across campaigns
  if (f.dialsToday >= 3) {
    const tomorrow = nextWindowOpening(new Date(f.now.getTime() + 60_000), cfg.calling_window, tz);
    const opening = tomorrow && isSameLocalDay(tomorrow, f.now, tz)
      ? nextWindowOpening(new Date(tomorrow.getTime() + 60_000), cfg.calling_window, tz)
      : tomorrow;
    return later("daily_contact_cap", opening ? new Date(opening.getTime() + Math.floor(rand() * 600_000)) : null);
  }
  // 10. capacity: global outbound < max - reserve, and business outbound < its cap
  if (f.active.globalOutbound >= f.env.maxConcurrent - f.env.inboundReserve ||
      f.active.businessOutbound >= f.business.outbound_max_concurrent) {
    return later("capacity", new Date(f.now.getTime() + 30_000));
  }
  // 11. the caller ID is still ours
  if (!f.callerIdValid) return never("caller_id_invalid");
  return { verdict: "allow" };
}

function isSameLocalDay(a, b, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(a) === fmt.format(b);
}
```

- [ ] **Step 3: Run it and confirm it passes.**
- [ ] **Step 4: Sabotage every check, one at a time.** There are **twelve** `if`s, because check 8 has two: `attempts_exhausted` and `give_up_window`. For each:
  1. Neutralise the condition **in place** by rewriting `if (COND)` as `if (false && /*SABOTAGE*/ (COND))`, using Edit.
     - **Never comment the line out.** Four of the checks are multi-line blocks, and commenting only the `if (…) {` line leaves an unmatched `}`. The file then fails to parse and every row goes red, which proves nothing.
  2. Confirm with `grep -c SABOTAGE lib/outbound/gate.js` (it must be `1`).
  3. Run the test. Expected: that reason's row goes RED, and the other rows still pass. A parse error is a failed sabotage, not a pass.
  4. Revert, and confirm with `grep -c SABOTAGE lib/outbound/gate.js` (it must be `0`).

  Record the 12 results in the commit message body. This is G5's proof.
- [ ] **Step 5: Commit.** Message: `feat(outbound): eligibility gate, 11 checks (12 conditions) in spec order, each shown to fail when removed`.

---

### Task 8: The Google OIDC verifier and the Cloud Tasks enqueuer (corrections C4 and C14)

**C14:** the sweep cannot reuse the dispatch task's name. Cloud Tasks keeps a finished task's name reserved for up to about an hour, so a sweep enqueuing the same `outreach_id + next_attempt_at` name gets ALREADY_EXISTS for exactly the task it exists to rescue. Sweep tasks add a 5-minute bucket suffix. Dispatch is idempotent (the row lock plus the attempt unique key), so an extra delivery is harmless.

**Files:**
- Create: `lib/auth/googleOidc.js`, `lib/outbound/tasks.js`
- Modify: `package.json` (`npm i @google-cloud/tasks@^6`)
- Test: `tests/googleOidc.test.js`, `tests/outboundTasks.test.js`

**Interfaces:**
- Produces:
  - `createGoogleOidcVerifier({ audience, allowedEmails, getPublicKey?, now? }) → { verify(authHeader) → Promise<{ok:true,email}|{ok:false,reason}> }`
  - `createDispatchEnqueuer({ client, queuePath, serviceUrl, serviceAccountEmail }) → { enqueue({businessId, outreachId, at, source:"dispatch"|"sweep"|"reschedule", now}) → Promise<{created:boolean}> }`

- [ ] **Step 1: Write the failing tests**

```js
// tests/googleOidc.test.js
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { createGoogleOidcVerifier } from "../lib/auth/googleOidc.js";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const AUD = "https://voice-uk-prod-462445274080.europe-west2.run.app";
const SA = "outbound-tasks@vetra-uk-edc8ca.iam.gserviceaccount.com";
const sign = (claims, opts = {}) => jwt.sign(
  { iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true, ...claims },
  privateKey, { algorithm: "RS256", keyid: "k1", expiresIn: 300, ...opts });
const verifier = createGoogleOidcVerifier({ audience: AUD, allowedEmails: [SA], getPublicKey: async () => publicKey });

describe("Google OIDC verification for /internal/outbound/*", () => {
  it("accepts a token from the right service account for the right audience", async () =>
    expect(await verifier.verify(`Bearer ${sign({})}`)).toEqual({ ok: true, email: SA }));
  it("refuses a missing header", async () => expect((await verifier.verify(undefined)).ok).toBe(false));
  it("refuses the wrong audience", async () => expect((await verifier.verify(`Bearer ${sign({ aud: "https://evil.example" })}`)).ok).toBe(false));
  it("refuses the wrong service account", async () =>
    expect((await verifier.verify(`Bearer ${sign({ email: "someone@else.iam.gserviceaccount.com" })}`)).ok).toBe(false));
  it("refuses an unverified email", async () => expect((await verifier.verify(`Bearer ${sign({ email_verified: false })}`)).ok).toBe(false));
  it("refuses the wrong issuer", async () => expect((await verifier.verify(`Bearer ${sign({ iss: "https://securetoken.google.com/x" })}`)).ok).toBe(false));
  it("refuses an expired token", async () => expect((await verifier.verify(`Bearer ${sign({}, { expiresIn: -10 })}`)).ok).toBe(false));
  it("refuses alg none", async () => {
    const none = jwt.sign({ iss: "https://accounts.google.com", aud: AUD, email: SA, email_verified: true }, "", { algorithm: "none" });
    expect((await verifier.verify(`Bearer ${none}`)).ok).toBe(false);
  });
});
```

```js
// tests/outboundTasks.test.js
import { describe, it, expect } from "vitest";
import { createDispatchEnqueuer } from "../lib/outbound/tasks.js";

function fakeClient() {
  const made = [];
  return {
    made,
    createTask: async ({ parent, task }) => {
      if (made.some((t) => t.task.name === task.name)) { const e = new Error("exists"); e.code = 6; throw e; }
      made.push({ parent, task }); return [task];
    },
  };
}
const Q = "projects/vetra-uk-edc8ca/locations/europe-west2/queues/outbound-dispatch";
const mk = (client) => createDispatchEnqueuer({ client, queuePath: Q, serviceUrl: "https://svc.example", serviceAccountEmail: "outbound-tasks@x.iam.gserviceaccount.com" });

describe("createDispatchEnqueuer", () => {
  it("creates an OIDC-authenticated POST to /internal/outbound/dispatch scheduled at `at`", async () => {
    const c = fakeClient();
    await mk(c).enqueue({ businessId: "b1", outreachId: "o1", at: new Date("2026-09-28T13:00:00Z"), source: "dispatch" });
    const t = c.made[0].task;
    expect(c.made[0].parent).toBe(Q);
    expect(t.httpRequest.url).toBe("https://svc.example/internal/outbound/dispatch");
    expect(t.httpRequest.oidcToken).toEqual({ serviceAccountEmail: "outbound-tasks@x.iam.gserviceaccount.com", audience: "https://svc.example" });
    expect(JSON.parse(Buffer.from(t.httpRequest.body, "base64").toString())).toEqual({ business_id: "b1", outreach_id: "o1" });
    expect(Number(t.scheduleTime.seconds)).toBe(Date.parse("2026-09-28T13:00:00Z") / 1000);
  });
  it("the same outreach + time enqueued twice is one task (dedupe by name), and says so", async () => {
    const c = fakeClient(); const q = mk(c);
    const at = new Date("2026-09-28T13:00:00Z");
    expect(await q.enqueue({ businessId: "b1", outreachId: "o1", at, source: "dispatch" })).toEqual({ created: true });
    expect(await q.enqueue({ businessId: "b1", outreachId: "o1", at, source: "dispatch" })).toEqual({ created: false });
    expect(c.made).toHaveLength(1);
  });
  it("a sweep re-enqueue gets its own name, so a tombstoned dispatch name cannot block the rescue (C14)", async () => {
    const c = fakeClient(); const q = mk(c);
    const at = new Date("2026-09-28T13:00:00Z");
    await q.enqueue({ businessId: "b1", outreachId: "o1", at, source: "dispatch" });
    expect(await q.enqueue({ businessId: "b1", outreachId: "o1", at, source: "sweep", now: new Date("2026-09-28T13:07:00Z") })).toEqual({ created: true });
  });
  it("any other error propagates", async () => {
    const client = { createTask: async () => { const e = new Error("perm"); e.code = 7; throw e; } };
    await expect(mk(client).enqueue({ businessId: "b1", outreachId: "o1", at: new Date(), source: "dispatch" })).rejects.toThrow("perm");
  });
});
```

- [ ] **Step 2: Confirm both fail.** Then implement:

```js
// lib/auth/googleOidc.js
/**
 * Verify a Google-signed OIDC ID token (Cloud Tasks / Cloud Scheduler
 * calling /internal/outbound/*). Correction C4: lib/auth/idToken.js is the
 * Identity Platform verifier and is hard-wired to securetoken issuers and
 * auth_time; this is its sibling on the same libraries, same RS256-only rule.
 * Default imports, as tests/idToken.test.js enforces for those packages.
 */
import jwt from "jsonwebtoken";
import jwksRsa from "jwks-rsa";

const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";

export function createGoogleOidcVerifier({ audience, allowedEmails, getPublicKey, now = () => Date.now() }) {
  if (!audience) throw new Error("googleOidc: audience is required");
  const allowed = new Set(allowedEmails || []);
  const client = getPublicKey ? null : jwksRsa({ jwksUri: JWKS_URI, cache: true, cacheMaxAge: 3_600_000, rateLimit: true, jwksRequestsPerMinute: 10 });
  const keyFor = getPublicKey || (async (kid) => (await client.getSigningKey(kid)).getPublicKey());

  return {
    async verify(authHeader) {
      const m = /^Bearer\s+(.+)$/.exec(authHeader || "");
      if (!m) return { ok: false, reason: "missing" };
      const decoded = jwt.decode(m[1], { complete: true });
      if (!decoded || decoded.header?.alg !== "RS256") return { ok: false, reason: "alg" };
      try {
        const key = await keyFor(decoded.header.kid);
        const claims = jwt.verify(m[1], key, { algorithms: ["RS256"], audience, issuer: ISSUERS, clockTimestamp: Math.floor(now() / 1000) });
        if (claims.email_verified !== true || !allowed.has(claims.email)) return { ok: false, reason: "email" };
        return { ok: true, email: claims.email };
      } catch (err) {
        return { ok: false, reason: err?.name || "invalid" };
      }
    },
  };
}
```

```js
// lib/outbound/tasks.js
/**
 * Cloud Tasks is the alarm clock (spec §5, §10.2). One queue,
 * `outbound-dispatch`, europe-west2. Dedupe by task NAME: the same outreach at
 * the same due time is one task. Sweep re-enqueues get a 5-minute bucket
 * suffix instead (C14) -- a completed task's name stays reserved for up to an
 * hour, so reusing it would block exactly the rescue the sweep exists for.
 * ALREADY_EXISTS (gRPC 6) is success, reported as {created:false}.
 */
export function createDispatchEnqueuer({ client, queuePath, serviceUrl, serviceAccountEmail }) {
  const url = `${serviceUrl.replace(/\/$/, "")}/internal/outbound/dispatch`;
  return {
    async enqueue({ businessId, outreachId, at, source = "dispatch", now = new Date() }) {
      const due = at instanceof Date ? at : new Date(at);
      const suffix = source === "sweep" ? `-s${Math.floor(now.getTime() / 300_000)}` : "";
      const name = `${queuePath}/tasks/d-${outreachId}-${due.getTime()}${suffix}`;
      const task = {
        name,
        scheduleTime: { seconds: Math.floor(due.getTime() / 1000) },
        httpRequest: {
          httpMethod: "POST",
          url,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify({ business_id: businessId, outreach_id: outreachId })).toString("base64"),
          oidcToken: { serviceAccountEmail, audience: serviceUrl.replace(/\/$/, "") },
        },
      };
      try {
        await client.createTask({ parent: queuePath, task });
        return { created: true };
      } catch (err) {
        if (err?.code === 6) return { created: false };
        throw err;
      }
    },
  };
}
```

- [ ] **Step 3: Run them and confirm they pass.** Sabotage: in the verifier, remove `audience` from the `jwt.verify` options. Confirm. Expected: "wrong audience" goes RED. Revert.
- [ ] **Step 4: Commit.** Message: `feat(outbound): Google OIDC verifier and Cloud Tasks enqueuer with name dedupe`.

---

### Task 9: Data functions and the dispatcher (spec §10.1, G6)

**Files:**
- Modify:
  - `services/db.js` (append an `// --- outbound (spec §10) ---` section)
  - `lib/phiAudit.js` (classify every new export)
  - `lib/voice/metrics.js` (`outbound_dial`, `outbound_dial_failed`, `outbound_gate_refused` already added in Task 7)
- Create: `lib/outbound/dispatch.js`
- Test: `tests/outboundDispatch.test.js` (unit, fakes) and `tests/db/outboundDispatch.test.js` (the real double-dial race)

**Interfaces:**
- Produces, all using `q()` so they run on the tenant client inside `withTenant`. Each PHI function calls `noteAccess`.

  | Function | Classification |
  |---|---|
  | `claimOutreachForDispatch(outreachId) → row\|null` | PHI read [outreach, contacts]. Does `SELECT … FOR UPDATE OF o SKIP LOCKED`, joining the pinned `campaign_versions.config`, `campaigns.status/compliance_class/template_key`, `contacts.*` and `businesses.outbound_enabled/outbound_max_concurrent/timezone/name`. |
  | `isSuppressed(phone) → boolean` | PHI read [suppressions] |
  | `listConsents(contactId) → rows` | PHI read [consents] |
  | `hasServiceRelationship(phone) → boolean` | PHI read [appointments] |
  | `countDialsSince(phone, sinceDate) → number` | PHI read [call_attempts] |
  | `activeDialCounts(businessId) → {globalOutbound, businessOutbound}` | NON_PHI. Calls `app_active_dial_counts()`. |
  | `insertCallAttempt({outreachId, attemptNo, fromNumber, toNumber}) → {id}\|{conflict:true}` | PHI write [call_attempts] |
  | `markOutreachDialing(outreachId)` | PHI write [outreach] |
  | `rescheduleOutreach(outreachId, at)` | PHI write [outreach]. Sets `state='waiting', next_attempt_at=at`. |
  | `closeOutreach(outreachId, closeReason, outcome=null)` | PHI write [outreach] |
  | `setAttemptCallSid(attemptId, sid)` | PHI write [call_attempts] |
  | `failAttempt(attemptId, twilioStatus)` | PHI write [call_attempts] |
  | `storeAttemptAudio(attemptId, {opener, voicemail})` | PHI write [call_attempts] |
  | `outboundDue(limit, graceSeconds) → [{business_id, outreach_id}]` | NON_PHI. Calls `app_outbound_due`. |

  - `createDispatcher(deps) → dispatch({businessId, outreachId}) → Promise<{status:"skipped"|"later"|"closed"|"conflict"|"dialed"|"dial_failed", reason?, at?, callSid?, attemptId?}>`

- [ ] **Step 1: Write the failing unit test** (a fake `db` whose methods record calls, and a fake Twilio client):

```js
// tests/outboundDispatch.test.js
import { describe, it, expect, vi } from "vitest";
import { createDispatcher } from "../lib/outbound/dispatch.js";
import { TEMPLATES } from "../lib/outbound/templates.js";

const NOW = new Date("2026-09-28T13:00:00Z");
function row(over = {}) {
  return {
    id: "o1", business_id: "b1", state: "waiting", attempts_made: 0, created_at: new Date("2026-09-28T12:59:00Z"), hold_until: null,
    campaign_id: "c1", campaign_version: 1, campaign_status: "active", compliance_class: "solicited", template_key: "speed_to_lead",
    config: { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055" },
    contact_id: "k1", phone_e164: "+447700900001", first_name: "Sam", contact_timezone: null,
    outbound_enabled: true, outbound_max_concurrent: 2, business_timezone: "Europe/London", business_name: "Digile Media",
    ...over,
  };
}
function fakeDb(r = row()) {
  const log = [];
  const rec = (name, ret) => vi.fn(async (...a) => { log.push([name, ...a]); return typeof ret === "function" ? ret(...a) : ret; });
  return {
    log,
    withTenant: vi.fn(async (_b, fn) => fn()),
    lockCapacity: rec("lockCapacity", undefined),
    claimOutreachForDispatch: rec("claim", r),
    undoAttempt: rec("undoAttempt", undefined),
    isSuppressed: rec("isSuppressed", false),
    listConsents: rec("listConsents", [{ purpose: "enquiry_followup", channels: ["call"], covers_automated: true, captured_at: new Date("2026-09-28T12:58:00Z"), expires_at: null, revoked_at: null }]),
    hasServiceRelationship: rec("hasRel", false),
    countDialsSince: rec("countDials", 0),
    activeDialCounts: rec("active", { globalOutbound: 0, businessOutbound: 0 }),
    insertCallAttempt: rec("insertAttempt", { id: "a1" }),
    markOutreachDialing: rec("markDialing", undefined),
    rescheduleOutreach: rec("reschedule", undefined),
    closeOutreach: rec("close", undefined),
    setAttemptCallSid: rec("setSid", undefined),
    failAttempt: rec("fail", undefined),
    storeAttemptAudio: rec("storeAudio", undefined),
  };
}
const env = { enabled: false, allowlist: new Set(["+447700900001"]), maxConcurrent: 8, inboundReserve: 2, baseUrl: "https://svc.example" };
const mk = (db, twilio = { calls: { create: vi.fn(async () => ({ sid: "CA123" })) } }, extra = {}) => {
  const enqueue = vi.fn(async () => ({ created: true }));
  const d = createDispatcher({ db, twilio, enqueue, env, now: () => NOW, rand: () => 0, callerIdValid: async () => true, renderAudio: async () => null, log: { info() {}, error() {} }, ...extra });
  return { d, enqueue, twilio };
};

describe("dispatch: the happy path", () => {
  it("locks, gates, inserts attempt N+1, marks dialing, then dials with the spec's AMD parameters", async () => {
    const db = fakeDb(); const { d, twilio } = mk(db);
    const r = await d({ businessId: "b1", outreachId: "o1" });
    expect(r).toMatchObject({ status: "dialed", callSid: "CA123", attemptId: "a1" });
    expect(db.log.map((x) => x[0]).slice(0, 1)).toEqual(["claim"]);
    expect(db.insertCallAttempt).toHaveBeenCalledWith({ outreachId: "o1", attemptNo: 1, fromNumber: "+441372656055", toNumber: "+447700900001" });
    const args = twilio.calls.create.mock.calls[0][0];
    expect(args).toMatchObject({
      to: "+447700900001", from: "+441372656055", machineDetection: "DetectMessageEnd", asyncAmd: "true",
      timeout: 40, // attempt 1 is in the template's voicemail_on [1,5] -> 40 s (spike B: voicemail answered at 26.6 s)
      url: "https://svc.example/twilio/outbound-answer", statusCallback: "https://svc.example/twilio/outbound-status",
      asyncAmdStatusCallback: "https://svc.example/twilio/outbound-amd",
    });
    expect(args.statusCallbackEvent).toEqual(["initiated", "ringing", "answered", "completed"]);
    expect(db.setAttemptCallSid).toHaveBeenCalledWith("a1", "CA123");
    expect(db.lockCapacity).toHaveBeenCalled();
  });
  it("an attempt NOT in voicemail_on rings for 25 s", async () => {
    const db = fakeDb(row({ attempts_made: 1 })); const { d, twilio } = mk(db);
    await d({ businessId: "b1", outreachId: "o1" });
    expect(twilio.calls.create.mock.calls[0][0].timeout).toBe(25);
  });
});

describe("dispatch: nothing dials twice", () => {
  it("a row that is locked elsewhere or no longer waiting is skipped with no side effect", async () => {
    const db = fakeDb(null); const { d, twilio } = mk(db);
    expect(await d({ businessId: "b1", outreachId: "o1" })).toEqual({ status: "skipped" });
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
  it("a unique violation on the attempt insert means another dispatcher won: do nothing", async () => {
    const db = fakeDb(); db.insertCallAttempt = vi.fn(async () => ({ conflict: true }));
    const { d, twilio } = mk(db);
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("conflict");
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
});

describe("dispatch: the gate's verdicts", () => {
  it("'later' reschedules and enqueues at the gate's time, without dialing", async () => {
    const db = fakeDb(row({ outbound_max_concurrent: 2 })); db.activeDialCounts = vi.fn(async () => ({ globalOutbound: 0, businessOutbound: 2 }));
    const { d, enqueue, twilio } = mk(db);
    const r = await d({ businessId: "b1", outreachId: "o1" });
    expect(r).toMatchObject({ status: "later", reason: "capacity" });
    expect(db.rescheduleOutreach).toHaveBeenCalledWith("o1", new Date("2026-09-28T13:00:30Z"));
    expect(enqueue).toHaveBeenCalledWith({ businessId: "b1", outreachId: "o1", at: new Date("2026-09-28T13:00:30Z"), source: "reschedule" });
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
  it("'never' closes with the reason, without dialing", async () => {
    const db = fakeDb(); db.isSuppressed = vi.fn(async () => true);
    const { d, twilio } = mk(db);
    expect(await d({ businessId: "b1", outreachId: "o1" })).toMatchObject({ status: "closed", reason: "suppressed" });
    expect(db.closeOutreach).toHaveBeenCalledWith("o1", "suppressed");
    expect(twilio.calls.create).not.toHaveBeenCalled();
  });
  it("a paused campaign parks the outreach (next_attempt_at NULL, so the sweep stops re-queuing it) with no task", async () => {
    const db = fakeDb(row({ campaign_status: "paused" })); const { d, enqueue } = mk(db);
    expect((await d({ businessId: "b1", outreachId: "o1" })).reason).toBe("campaign_paused");
    expect(db.rescheduleOutreach).toHaveBeenCalledWith("o1", null);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("dispatch: Twilio failures", () => {
  it("a failed calls.create records the attempt failed and schedules the NEXT entry", async () => {
    const db = fakeDb(); const twilio = { calls: { create: vi.fn(async () => { throw Object.assign(new Error("boom"), { status: 400 }); }) } };
    const { d, enqueue } = mk(db, twilio);
    expect((await d({ businessId: "b1", outreachId: "o1" })).status).toBe("dial_failed");
    expect(db.failAttempt).toHaveBeenCalledWith("a1"); // sets result='failed' AND ended_at, which releases capacity
    // next entry is "+10m" from now
    expect(db.rescheduleOutreach).toHaveBeenCalledWith("o1", new Date("2026-09-28T13:10:00Z"));
    expect(enqueue).toHaveBeenCalled();
  });
  it("Twilio's concurrency refusal (HTTP 429) is capacity, +30 s, and does NOT use up an attempt (C16)", async () => {
    const db = fakeDb(); const twilio = { calls: { create: vi.fn(async () => { throw Object.assign(new Error("busy"), { status: 429 }); }) } };
    const { d } = mk(db, twilio);
    await d({ businessId: "b1", outreachId: "o1" });
    expect(db.undoAttempt).toHaveBeenCalledWith("a1", "o1");
    expect(db.failAttempt).not.toHaveBeenCalled();
    expect(db.rescheduleOutreach).toHaveBeenCalledWith("o1", new Date("2026-09-28T13:00:30Z"));
  });
  it("nextScheduled takes the attempt number just made, so post-call (DB row already incremented) gets the same answer", async () => {
    const { nextScheduled } = await import("../lib/outbound/dispatch.js");
    const r = row({ attempts_made: 1 }); // as post-call reads it after attempt 1
    expect(nextScheduled(r, 1, NOW, "Europe/London", () => 0).toISOString()).toBe("2026-09-28T13:10:00.000Z"); // "+10m", not "+3h"
    expect(nextScheduled(r, 5, NOW, "Europe/London", () => 0)).toBeNull(); // five entries: nothing after the 5th
  });
});
```

- [ ] **Step 2: Write the failing DB race test (G6)**

```js
// tests/db/outboundDispatch.test.js
/**
 * G6: duplicate dispatch of the same task produces exactly ONE Twilio call.
 * Real Postgres, real services/db.js, as vetra_app (the smsConsent.test.js
 * idiom: vetra_app LOGIN for the run, DATABASE_URL set before import).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;
const APP_URL = "postgres://vetra_app:probe_only@localhost:55432/vetra";
const BIZ = "0e0e0000-0000-4000-8000-000000000001";
let admin, db, createDispatcher, TEMPLATES, outreachId;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`ALTER ROLE vetra_app LOGIN PASSWORD 'probe_only'`);
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]);
  await admin.query(`INSERT INTO businesses (id, name, timezone, outbound_enabled) VALUES ($1,'Race','Europe/London',true)`, [BIZ]);
  ({ TEMPLATES } = await import("../../lib/outbound/templates.js"));
  const cfg = { ...structuredClone(TEMPLATES.speed_to_lead), caller_id: "+441372656055",
    calling_window: { mon_fri: "08:00-21:00", sat: "08:00-21:00", sun: "08:00-21:00", outside_window: "queue" } };
  const c = await admin.query(`INSERT INTO campaigns (business_id,name,template_key,compliance_class,audience,status,current_version)
                               VALUES ($1,'r','speed_to_lead','solicited','business','active',1) RETURNING id`, [BIZ]);
  await admin.query(`INSERT INTO campaign_versions (campaign_id,business_id,version,config) VALUES ($1,$2,1,$3)`, [c.rows[0].id, BIZ, cfg]);
  const k = await admin.query(`INSERT INTO contacts (business_id, phone_e164, first_name) VALUES ($1,'+447700900321','Sam') RETURNING id`, [BIZ]);
  await admin.query(`INSERT INTO consents (business_id,contact_id,purpose,channels,covers_automated,source,captured_at)
                     VALUES ($1,$2,'enquiry_followup','{call}',true,'manual',now())`, [BIZ, k.rows[0].id]);
  outreachId = (await admin.query(`INSERT INTO outreach (business_id,campaign_id,campaign_version,contact_id,state,trigger,idempotency_key,next_attempt_at)
                                  VALUES ($1,$2,1,$3,'waiting','{}','race-1',now()) RETURNING id`, [BIZ, c.rows[0].id, k.rows[0].id])).rows[0].id;
  process.env.DATABASE_URL = APP_URL;
  db = await import("../../services/db.js");
  ({ createDispatcher } = await import("../../lib/outbound/dispatch.js"));
});

afterAll(async () => {
  if (!admin) return;
  process.env.DATABASE_URL = url;
  await admin.query(`DELETE FROM businesses WHERE id = $1`, [BIZ]).catch(() => {});
  await admin.query(`ALTER ROLE vetra_app NOLOGIN`).catch(() => {});
  await admin.end();
});

d("G6: the double-dial lock under real concurrency", () => {
  it("ten concurrent dispatches of one outreach place exactly one call and write exactly one attempt", async () => {
    const create = vi.fn(async () => { await new Promise((r) => setTimeout(r, 50)); return { sid: `CArace${create.mock.calls.length}` }; });
    const dispatch = createDispatcher({
      db, twilio: { calls: { create } }, enqueue: async () => ({ created: true }),
      env: { enabled: false, allowlist: new Set(["+447700900321"]), maxConcurrent: 8, inboundReserve: 2, baseUrl: "https://svc.example" },
      // FIXED clock inside the 08:00-21:00 window. With `new Date()` this test
      // goes red every evening London time (outside_window -> zero dials).
      now: () => new Date("2026-09-28T13:00:00Z"), rand: () => 0,
      callerIdValid: async () => true, renderAudio: async () => null, log: { info() {}, error() {} },
    });
    const results = await Promise.all(Array.from({ length: 10 }, () => dispatch({ businessId: BIZ, outreachId })));
    expect(create).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "dialed")).toHaveLength(1);
    const attempts = await admin.query(`SELECT count(*)::int AS n FROM call_attempts WHERE outreach_id = $1`, [outreachId]);
    expect(attempts.rows[0].n).toBe(1);                           // the row actually landed (RLS-safe write)
    const o = await admin.query(`SELECT state, attempts_made FROM outreach WHERE id = $1`, [outreachId]);
    expect(o.rows[0]).toEqual({ state: "dialing", attempts_made: 1 });
  });
});
```

- [ ] **Step 3: Confirm both fail.** Then implement `lib/outbound/dispatch.js`:

```js
// lib/outbound/dispatch.js
/**
 * Dispatch one outreach (spec §10.1). Two properties make a retried or
 * duplicated task safe, and G6 tests both against real Postgres:
 *   1. SELECT ... FOR UPDATE SKIP LOCKED -- a concurrent dispatcher skips.
 *   2. UNIQUE (outreach_id, attempt_no) -- if two ever pass 1, the insert loses.
 * Twilio is called AFTER the tenant transaction commits, so a slow Twilio never
 * holds a row lock, and a crash between commit and create leaves an attempt
 * with no CallSid that post-call's sweep closes (Task 20).
 *
 * CAPACITY is serialised: every dispatch transaction first takes one global
 * advisory lock, so two concurrent dispatches for DIFFERENT outreach cannot
 * both read "1 line free" and both dial (Cloud Tasks runs up to 5 at once).
 * The lock is held only for the short transaction, not for the Twilio call.
 * callerIdValid() is inside the transaction but cached for an hour per number,
 * so at most one Twilio REST read per number per hour runs under the lock.
 */
import { evaluateGate } from "./gate.js";
import { computeAttemptAt, applyWindow, contactTimezone } from "./schedule.js";
import { zonedComponentsToUtcMs } from "../capabilities/datetime.js";
import { bumpCounter } from "../voice/metrics.js";

export function createDispatcher({ db, twilio, enqueue, env, now = () => new Date(), rand = Math.random, callerIdValid, renderAudio, log }) {
  return async function dispatch({ businessId, outreachId }) {
    const phase = await db.withTenant(businessId, async () => {
      await db.lockCapacity(); // SELECT pg_advisory_xact_lock(hashtext('outbound_capacity'))
      const r = await db.claimOutreachForDispatch(outreachId);
      if (!r || r.state !== "waiting") return { status: "skipped" };
      const t = now();
      const tz = contactTimezone({ timezone: r.contact_timezone, phone_e164: r.phone_e164 }, r.business_timezone);
      const [suppressed, consents, hasRelationship, dialsToday, active, idOk] = await Promise.all([
        db.isSuppressed(r.phone_e164),
        db.listConsents(r.contact_id),
        r.compliance_class === "service" ? db.hasServiceRelationship(r.phone_e164) : Promise.resolve(false),
        db.countDialsSince(r.phone_e164, startOfLocalDay(t, tz)),
        db.activeDialCounts(businessId),
        callerIdValid(r.config.caller_id),
      ]);
      const verdict = evaluateGate({
        now: t, env,
        business: { outbound_enabled: r.outbound_enabled, outbound_max_concurrent: r.outbound_max_concurrent },
        campaign: { status: r.campaign_status, compliance_class: r.compliance_class, template_key: r.template_key, config: r.config },
        contact: { phone_e164: r.phone_e164, timezone: tz },
        outreach: { attempts_made: r.attempts_made, created_at: r.created_at, hold_until: r.hold_until },
        suppressed, consents, hasRelationship, dialsToday, active, callerIdValid: idOk,
      }, { rand });

      if (verdict.verdict === "never") {
        await db.closeOutreach(outreachId, verdict.reason);
        return { status: "closed", reason: verdict.reason };
      }
      if (verdict.verdict === "later") {
        // at === null (a paused campaign) PARKS the outreach: next_attempt_at
        // NULL is excluded by app_outbound_due, so the sweep stops re-queuing
        // it every 5 minutes. Resuming the campaign sets next_attempt_at=now().
        await db.rescheduleOutreach(outreachId, verdict.at ?? null);
        return { status: "later", reason: verdict.reason, at: verdict.at };
      }
      const ins = await db.insertCallAttempt({ outreachId, attemptNo: r.attempts_made + 1, fromNumber: r.config.caller_id, toNumber: r.phone_e164 });
      if (ins.conflict) return { status: "conflict" };
      await db.markOutreachDialing(outreachId);
      return { status: "dial", attemptId: ins.id, row: r, tz };
    }, { actor: { type: "system", id: "outbound-dispatch" } });

    if (phase.status === "later") {
      if (phase.at) await enqueue({ businessId, outreachId, at: phase.at, source: "reschedule" });
      bumpCounter("outbound_gate_later");
      log.info("outbound_gate_refused", { reason: phase.reason, verdict: "later" });
      return phase;
    }
    if (phase.status === "closed") { bumpCounter("outbound_gate_refused"); log.info("outbound_gate_refused", { reason: phase.reason, verdict: "never" }); return phase; }
    if (phase.status !== "dial") return phase;

    const { row: r, attemptId, tz } = phase;
    const attemptNo = r.attempts_made + 1;
    const base = env.baseUrl;
    let call;
    try {
      call = await twilio.calls.create({
        to: r.phone_e164, from: r.config.caller_id,
        url: `${base}/twilio/outbound-answer`, method: "POST",
        statusCallback: `${base}/twilio/outbound-status`, statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        machineDetection: "DetectMessageEnd", asyncAmd: "true",
        asyncAmdStatusCallback: `${base}/twilio/outbound-amd`, asyncAmdStatusCallbackMethod: "POST",
        // Spec §9.4 (revised after spike B): a US carrier's voicemail answered
        // after 26.6 s, so 25 s never reaches it. 40 s where a message is due.
        timeout: (r.config.retries.voicemail_on || []).includes(attemptNo) ? 40 : 25,
      });
    } catch (err) {
      const t = now();
      const capacity = err?.status === 429;
      const next = capacity
        ? new Date(t.getTime() + 30_000)
        : nextScheduled(r, attemptNo, t, tz, rand);
      await db.withTenant(businessId, async () => {
        // C16: Twilio's concurrency refusal must not use up an attempt or count
        // toward the daily cap -- no call was placed. Any other failure is a
        // real (failed) attempt: result='failed' + ended_at releases capacity.
        if (capacity) await db.undoAttempt(attemptId, outreachId);
        else await db.failAttempt(attemptId);
        if (next) await db.rescheduleOutreach(outreachId, next);
        else await db.closeOutreach(outreachId, "attempts_exhausted");
      }, { actor: { type: "system", id: "outbound-dispatch" } });
      if (next) await enqueue({ businessId, outreachId, at: next, source: "reschedule" });
      bumpCounter("outbound_dial_failed");
      log.error("outbound_dial_failed", { attemptId, status: err?.status ?? null, capacity });
      return { status: "dial_failed", attemptId };
    }

    await db.withTenant(businessId, () => db.setAttemptCallSid(attemptId, call.sid), { actor: { type: "system", id: "outbound-dispatch" } });
    bumpCounter("outbound_dial");
    log.info("outbound_dial", { attemptId, callSid: call.sid, attemptNo });

    // §9.3 step 1: render the backstop line (and the voicemail when due) WHILE
    // it rings, in the tenant's Gemini Live voice (Task 14's liveRender.js;
    // in 2a renderAudio is a no-op).
    try {
      const audio = await renderAudio({ row: r, attemptNo });
      if (audio) await db.withTenant(businessId, () => db.storeAttemptAudio(attemptId, audio), { actor: { type: "system", id: "outbound-dispatch" } });
    } catch (err) {
      log.error("outbound_backstop_render_failed", { attemptId, error: err?.message }); // session logs outbound_backstop_missing (§9.3)
    }
    return { status: "dialed", callSid: call.sid, attemptId };
  };
}

/**
 * The schedule entry after attempt `attemptNoJustMade` (1-based), windowed;
 * null when exhausted. The attempt number is EXPLICIT because dispatch holds
 * the pre-increment row (attempts_made = N-1) while post-call (Task 20) reads
 * the incremented one (attempts_made = N) -- deriving it from the row made
 * post-call skip an entry and never place the last attempt.
 */
export function nextScheduled(r, attemptNoJustMade, t, tz, rand) {
  const entries = r.config.retries.schedule;
  const idx = attemptNoJustMade; // entries[0] was attempt 1, so the next is entries[attemptNoJustMade]
  if (idx >= entries.length) return null;
  const at = computeAttemptAt({ entry: entries[idx], now: t, lastEndedAt: t, createdAt: new Date(r.created_at), timezone: tz });
  return applyWindow(at, r.config.calling_window, tz, rand);
}

/** Local midnight of `t`'s day in `tz`, as an instant. DST-safe via datetime.js. */
export function startOfLocalDay(t, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const [year, month, day] = fmt.format(t).split("-").map(Number);
  return new Date(zonedComponentsToUtcMs({ year, month, day, hour: 0, minute: 0, second: 0 }, tz));
}
```

(The import is already at the top of `dispatch.js`. Add a unit test to `tests/outboundDispatch.test.js`: `startOfLocalDay(new Date("2026-03-29T12:00:00Z"), "Europe/London")` must equal `2026-03-29T00:00:00.000Z`. That instant is still GMT midnight, because the clocks change at 01:00. Also `startOfLocalDay(new Date("2026-07-01T12:00:00Z"), "Europe/London")` must equal `2026-06-30T23:00:00.000Z`.)

The failure test in "a failed calls.create … schedules the NEXT entry" expects `schedule[1] = "+10m"`, i.e. 13:10Z, which falls inside the London window.

Then append the `services/db.js` functions, following the existing `q()`/`one()`/`noteAccess` pattern. For example:

```js
// --- outbound (spec §10) --------------------------------------------------
export async function claimOutreachForDispatch(outreachId) {
  const res = await q(
    `SELECT o.id, o.business_id, o.state, o.attempts_made, o.created_at, o.hold_until,
            o.campaign_id, o.campaign_version, c.status AS campaign_status, c.compliance_class, c.template_key,
            v.config, k.id AS contact_id, k.phone_e164, k.first_name, k.timezone AS contact_timezone,
            b.outbound_enabled, b.outbound_max_concurrent, b.timezone AS business_timezone, b.name AS business_name
       FROM outreach o
       JOIN campaigns c ON c.id = o.campaign_id
       JOIN campaign_versions v ON v.campaign_id = o.campaign_id AND v.version = o.campaign_version
       JOIN contacts k ON k.id = o.contact_id
       JOIN businesses b ON b.id = o.business_id
      WHERE o.id = $1
        FOR UPDATE OF o SKIP LOCKED`, [outreachId]);
  if (res.error) throw res.error;
  const row = one(res);
  noteAccess("claimOutreachForDispatch", { resourceIds: [outreachId], rowCount: res.rowCount || 0 });
  return row;
}

export async function insertCallAttempt({ outreachId, attemptNo, fromNumber, toNumber }) {
  const res = await q(
    `INSERT INTO call_attempts (business_id, outreach_id, attempt_no, from_number, to_number, dialed_at)
     SELECT o.business_id, o.id, $2, $3, $4, now() FROM outreach o WHERE o.id = $1
     ON CONFLICT (outreach_id, attempt_no) DO NOTHING
     RETURNING id`, [outreachId, attemptNo, fromNumber, toNumber]);
  if (res.error) throw res.error;
  noteAccess("insertCallAttempt", { resourceIds: [outreachId], rowCount: res.rowCount || 0 });
  return res.rowCount === 1 ? { id: res.rows[0].id } : { conflict: true };
}

export async function markOutreachDialing(outreachId) {
  const res = await q(
    `UPDATE outreach SET state = 'dialing', attempts_made = attempts_made + 1, last_attempt_at = now(), updated_at = now()
      WHERE id = $1 AND state = 'waiting'`, [outreachId]);
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`markOutreachDialing: expected 1 row, got ${res.rowCount}`); // a tenantless write matches zero rows and must not pass as success
  noteAccess("markOutreachDialing", { resourceIds: [outreachId], rowCount: res.rowCount });
}

export async function activeDialCounts(businessId) {
  const res = await q(`SELECT business_id, active FROM app_active_dial_counts()`);
  if (res.error) throw res.error;
  const rows = res.rows || [];
  return {
    globalOutbound: rows.reduce((s, r) => s + r.active, 0),
    businessOutbound: rows.find((r) => r.business_id === businessId)?.active ?? 0,
  };
}
```

Every other function follows the same three rules:
1. Throw on `res.error`. The dispatcher runs inside `withTenant`, which rolls back.
2. **Assert `rowCount` on every UPDATE** (the tenantless-write trap).
3. Call `noteAccess` with the ids.

The three additions the review required:

```js
export async function lockCapacity() {               // NON_PHI: a lock, no data
  const res = await q(`SELECT pg_advisory_xact_lock(hashtext('outbound_capacity'))`);
  if (res.error) throw res.error;
}

export async function failAttempt(attemptId) {        // PHI write [call_attempts]
  // result + ended_at, not just twilio_status: the dial_registry trigger fires
  // on ended_at/result, and a row left open there blocks capacity for an hour.
  const res = await q(`UPDATE call_attempts SET twilio_status = 'failed', result = 'failed', ended_at = now() WHERE id = $1`, [attemptId]);
  if (res.error) throw res.error;
  if (res.rowCount !== 1) throw new Error(`failAttempt: expected 1 row, got ${res.rowCount}`);
  noteAccess("failAttempt", { resourceIds: [attemptId], rowCount: 1 });
}

export async function undoAttempt(attemptId, outreachId) {   // PHI write [call_attempts, outreach] -- C16
  const del = await q(`DELETE FROM call_attempts WHERE id = $1 AND twilio_call_sid IS NULL`, [attemptId]);
  if (del.error) throw del.error;
  const upd = await q(`UPDATE outreach SET attempts_made = attempts_made - 1, updated_at = now() WHERE id = $1 AND attempts_made > 0`, [outreachId]);
  if (upd.error) throw upd.error;
  if (del.rowCount !== 1 || upd.rowCount !== 1) throw new Error("undoAttempt: expected 1 row each");
  noteAccess("undoAttempt", { resourceIds: [attemptId, outreachId], rowCount: 2 });
}
```

Also, `rescheduleOutreach(outreachId, at)` accepts `at = null`: it parks the outreach, so `app_outbound_due` excludes it.

Classify all 16 functions in `lib/phiAudit.js`. `activeDialCounts`, `outboundDue` and `lockCapacity` go in `NON_PHI_EXPORTS` ("counts, ids or a lock only").

**Metrics:** add `outbound_dial` and `outbound_dial_failed` to `COUNTER_NAMES` in this task. Task 7 added only the gate counters, and `bumpCounter` drops unknown names silently.

- [ ] **Step 4: Run and confirm PASS:** `tests/outboundDispatch.test.js`, `tests/phiAuditCoverage.test.js`, and the DB test `tests/db/outboundDispatch.test.js`.
- [ ] **Step 5: Sabotage G6.** There are three guards, so the sabotage must remove the right ones together.
  1. Remove the **whole** `FOR UPDATE OF o SKIP LOCKED` clause, not just `SKIP LOCKED`. With plain `FOR UPDATE`, the waiting transactions block, then read `state='dialing'`, and the JavaScript state check skips them, so the test stays green.
  2. In the same edit, change `ON CONFLICT (outreach_id, attempt_no) DO NOTHING` to a plain INSERT, and remove the advisory lock call (`lockCapacity`), which also serialises.
  3. Confirm the sabotage landed. Expected: the DB race test goes **RED**. Nine inserts throw `unique_violation`, or `create` is called more than once.
  4. Restore ONLY `ON CONFLICT … DO NOTHING`. Expected: GREEN, with `conflict` for the losers and exactly one dial. That proves the unique key holds on its own.
  5. Restore everything, and confirm with `grep -c "FOR UPDATE OF o SKIP LOCKED" services/db.js` and `grep -c "outbound_capacity" services/db.js` (both must be `1`).
- [ ] **Step 6: Commit.** Message: `feat(outbound): dispatcher with row lock and attempt unique key; G6 proven against real Postgres`.

---

### Task 10: Internal routes, dispatch and sweep, OIDC-guarded

**Files:**
- Create: `lib/outbound/internalRoutes.js`
- Modify:
  - `server.js` (mount before the error handler at ~1409: `registerOutboundInternalRoutes(app, buildOutboundDeps())`)
  - `.env.example` (`OUTBOUND_TASKS_SA` / `OUTBOUND_TASKS_QUEUE`, if not already added)
- Test: `tests/outboundInternalRoutes.test.js` (supertest)

**Interfaces:**
- Produces: `registerOutboundInternalRoutes(app, { verifier, dispatch, db, enqueue, now, log })`
  - `POST /internal/outbound/dispatch` with body `{business_id, outreach_id}`. It returns **200** whatever the dispatch outcome ("do nothing" is a success for a retried task) and **500** only on an unexpected throw, so that Cloud Tasks retries.
  - `POST /internal/outbound/sweep`. For each `outboundDue(100, 120)` row it calls `enqueue({businessId, outreachId, at: bucketStart, source:"sweep", now})`, where `bucketStart = new Date(Math.floor(now/300_000)*300_000)`. The function returns ids only, so `at` has to be supplied; without it the task name and `scheduleTime` are `NaN`. The route returns `{ reenqueued: n }`. Task 20 adds the post-call backstop to it. A new trigger is dispatched within **about 7 minutes** (a 5-minute sweep plus 2 minutes of grace), not 5 (C14).
- Also produces `buildOutboundDeps(env)` in `lib/outbound/internalRoutes.js`. **Every** audience and URL comes from `outboundEnv(env).baseUrl`, which has the trailing slash stripped. The verifier, the enqueuer, the Twilio callbacks and the Scheduler job (Task 22) must all use the same string. A trailing slash in any one of them makes every task return 403. It wires:
  - `createGoogleOidcVerifier({ audience: outboundEnv(env).baseUrl, allowedEmails: [OUTBOUND_TASKS_SA] })`
  - `createDispatchEnqueuer` with `new CloudTasksClient()`
  - `createDispatcher` with `twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)`
  - `callerIdValid`, cached for one hour per number using `incomingPhoneNumbers.list({phoneNumber, limit:1})`

  When `OUTBOUND_TASKS_QUEUE` or `OUTBOUND_TASKS_SA` is unset, the routes are NOT mounted, and boot logs `outbound_internal_routes_disabled`. That is the posture before Task 22.

- [ ] **Step 1: Write the failing supertest.** It covers:
  - the sweep passes a finite `at` (the bucket start) to `enqueue`, never `undefined`;
  - `buildOutboundDeps({BASE_URL: "https://x.example/"})` gives verifier audience `https://x.example` (no trailing slash);
  - 401 without a token;
  - 403 with a verifier that says `{ok:false}`;
  - 200, and the dispatch spy called with `{businessId, outreachId}`, when the token is valid;
  - 400 on a body with a non-uuid id;
  - 500 when dispatch throws;
  - the sweep enqueuing each due row with `source:"sweep"`;
  - the routes being absent (404) when `buildOutboundDeps` returns null.

  The code follows the Task 9 style: an express app, `registerOutboundInternalRoutes(app, fakes)`, and `request(app).post(...)`.
- [ ] **Step 2: Implement.** Use `express.json({ limit: "4kb" })` scoped to these two routes. Validate the uuids with `/^[0-9a-f-]{36}$/`.
- [ ] **Step 3: Run it, then `tests/envInventory.test.js`.** Confirm PASS. Sabotage: skip the verifier call. Expected: the 401/403 tests go RED. Revert.
- [ ] **Step 4: Commit.** Message: `feat(outbound): OIDC-guarded dispatch and sweep routes, mounted only when configured`.

---

### Task 11: `scripts/outbound-admin.js`, the operator path while there is no dashboard

**Files:**
- Create: `scripts/outbound-admin.js`
- Modify: `Dockerfile` (after line 142: `COPY scripts/outbound-admin.js ./scripts/outbound-admin.js`) and `.dockerignore` (`!scripts/outbound-admin.js`)
- Test: `tests/db/outboundAdmin.test.js` (the pattern from `tests/db/importTenant.test.js`: run as a NOSUPERUSER NOBYPASSRLS role)

**Interfaces:**
- Produces, as named exports so the test drives them without a child process:
  - `parseArgs(argv)`
  - `upsertCampaign(client, {businessPhone, meta, config, confirm})`
  - `setCampaignStatus(client, {businessPhone, campaignId, status, confirm})`
  - `setBusinessOutbound(client, {businessPhone, enabled, max, confirm})`
  - `triggerOutreach(client, {businessPhone, campaignId, phone, firstName, consentManual, confirm})`
- The CLI is a dry run by default. Every write:
  - reads the tenant through `app_lookup_business_by_phone` (which sets scope);
  - validates with `validateCampaign`;
  - prints what it WOULD write as one JSON line;
  - writes only with `--confirm`, then reads back and exits 1 on a mismatch.

  `--config <base64>` carries the JSON, for the same reason as `set-business-config.js:114-120`.

  `triggerOutreach --consent-manual` records a `consents` row with `source='manual', covers_automated=true, wording_text='Operator test on the owner\'s own handset'`. It is **refused unless the phone is in `OUTBOUND_TEST_ALLOWLIST`**, so a manual consent can never be fabricated for a real lead.

  The new outreach starts `waiting` with `next_attempt_at = now()`. The 5-minute sweep picks it up. The script does not enqueue itself, so it needs no Cloud Tasks rights.

- [ ] **Step 1: Write the failing DB test.** It covers:
  - the dry run writes nothing (count the rows before and after);
  - `--confirm` creates the campaign plus version 1, and they read back;
  - an invalid config is refused with the validator's paths;
  - a trigger is idempotent: the same phone and campaign twice gives one outreach, keyed `admin:<campaign>:<phone>:<yyyy-mm-dd>`;
  - `--consent-manual` for a number not on the allow-list is refused;
  - all of it runs as the non-bypassing role, and the test asserts the rows landed.
- [ ] **Step 2: Implement.** Model it on `scripts/set-business-config.js` for arguments, base64 and read-back, and on `scripts/import-tenant.js` for named exports and the `if (import.meta.url === …)` main guard.
- [ ] **Step 3: Run it and confirm PASS.** Sabotage: remove the allow-list check on `--consent-manual`. Confirm. Expected: RED. Revert.
- [ ] **Step 4: Commit.** Message: `feat(outbound): operator admin script (dry-run default, read-back verified, allow-list-bound manual consent)`.

---

### Checkpoint 2a

- [ ] Run the full root suite (`DATABASE_URL` unset) and the full `test:db`. Both must be green, and the counts must equal the baseline plus the new tests.
- [ ] `git status tests/__snapshots__/prompts` must be clean (G9).
- [ ] Run `node scripts/export-campaign-schema.js`. It must produce no diff.
- [ ] Run superpowers:requesting-code-review over `feat/outbound-stage2` from the 2a base. Fix the Critical and Important findings, and record the Minor ones.
- [ ] Nothing is deployed and nothing is pushed. Update memory `outbound-calling-plan` with the 2a outcome, and write the session 2b prompt.

---

# STAGE 2 · SESSION 2b: the door and the live-call path (spec steps 2.3–2.5)

**Session 2b changes code every inbound call runs through.** Four rules apply to every task:
1. Each task adds an inbound-unchanged assertion alongside its outbound test.
2. Run the whole root suite after each task, not only at the checkpoint.
3. `tests/__snapshots__/prompts/` must not move.
4. Each task gets its own commit and its own review.

### Task 0 (2b): refresh

- [ ] Re-anchor every `file:line` below against HEAD. Lines move after 2a, especially in `server.js`.
- [ ] Record the baseline for both suites.
- [ ] Read spec §9.3/§9.4, which now carry the spike results.
- [ ] Decide Task 14's arm: **SEEDED** or **FALLBACK**, as the spec now records.

### Task 12: Signed media URLs and the door routes (answer, status)

**Files:**
- Create: `lib/outbound/mediaUrl.js`, `lib/outbound/doorRoutes.js`
- Modify: `server.js` (mount next to `/twilio/live-voice` at ~494), `.env.example` (`OUTBOUND_MEDIA_URL_SECRET`)
- Test: `tests/outboundMediaUrl.test.js`, `tests/outboundDoor.test.js`

**Interfaces:**
- `signMediaUrl({base, callSid, kind, ttlSeconds=600, now, env}) → string`, which returns `${base}/media/outbound/${callSid}/${kind}.wav?exp=<unix>&sig=<hex>`
- `verifyMediaUrl({callSid, kind, exp, sig, now, env}) → {ok}|{ok:false, reason}`
- The key is `HMAC(signingKey(env), "vetra:outbound-media:v1")`, where `signingKey` is exported from `lib/mediaStreamToken.js:68-75` (C5). That means `MEDIA_STREAM_SECRET`, else `TWILIO_AUTH_TOKEN`. If `OUTBOUND_MEDIA_URL_SECRET` is set, it overrides.
- **C15:** the media path carries the **CallSid**, not the attemptId. The route resolves the tenant with `app_outbound_attempt_by_call_sid` (Task 3), which works before the tenant is known. An attemptId would need a fourth definer function.
- `registerOutboundDoorRoutes(app, { validate, db, mintToken, postCall, log, now })`, where `validate` = server.js's `twilioValidationAnyAccount`:
  - `POST /twilio/outbound-answer` resolves the attempt by `CallSid`:
    - on a hit, it returns `<Response><Connect><Stream url="wss://…/twilio/live-stream/<token>"><Parameter name="direction" value="outbound"/></Stream></Connect></Response>`, where `<token> = mintMediaStreamToken(CallSid)`;
    - on a miss, it returns `<Response><Hangup/></Response>` and logs `outbound_context_missing`.
  - `POST /twilio/outbound-status` uses `CallStatus` to set `call_attempts.twilio_status`, plus `answered_at` on `in-progress` and `ended_at` and `status_completed_at` on terminal statuses. For `busy`, `no-answer`, `failed` and `canceled` it sets `result` to `busy`, `no_answer`, `failed` or `canceled` respectively. On terminal statuses it calls `postCall.tryClaim(callSid)` (Task 20). It **never** sends the missed-call text and never applies the spam heuristic (`server.js:851-905`).
  - `GET /media/outbound/:callSid/:kind.wav` verifies the signature, reads `voicemail_audio` under scope, and serves it as `audio/wav` (a μ-law WAV header, format 7, 8 kHz). It returns 403 on a bad signature and 404 when there is no audio.

- [ ] **Step 1: Write the failing tests.**
  - `tests/outboundMediaUrl.test.js`:
    - a round trip verifies;
    - a URL signed for another CallSid does not verify;
    - a URL signed for another kind does not verify;
    - an expired URL does not verify, with reason `expired`;
    - a tampered `exp` does not verify;
    - with no key available (neither secret set), signing throws.
  - `tests/outboundDoor.test.js` (supertest with fake `db`/`validate`):
    - the answer TwiML contains exactly one `<Parameter name="direction" value="outbound"/>` and a token for **that** CallSid;
    - an unknown CallSid gets `<Hangup/>`;
    - a failed signature returns 403;
    - status `in-progress` stamps `answered_at`;
    - status `completed` stamps `status_completed_at` and calls `postCall.tryClaim`;
    - status `no-answer` sets `result='no_answer'`;
    - status `busy` sets `result='busy'` and calls `postCall.tryClaim` exactly as `no-answer` does. This is a decline that the carrier ends outright (spec §9.4);
    - **a spy on `notifications.sendCallerSms` shows it is never called for any status**;
    - the media route returns 403 when the signature is bad and serves bytes starting with `RIFF` when it is good.
- [ ] **Step 2: Implement.** Also export `signingKey` from `lib/mediaStreamToken.js` without changing its behaviour. `tests/mediaStreamToken*.test.js` must stay green.
- [ ] **Step 3: Run, sabotage and commit.**
  - Run: the new tests plus `tests/twilioSignature.test.js` and the inbound `tests/server*.test.js`.
  - Sabotage: remove `validate` from the answer route. Expected: the 403 test goes RED. Revert.
  - Commit: `feat(outbound): door routes (answer, status, signed media) that never touch inbound's missed-call path`.

### Task 13: Async AMD handling and voicemail (spec §9.4)

**Files:**
- Create: `lib/outbound/amd.js`
- Modify: `lib/outbound/doorRoutes.js` (`POST /twilio/outbound-amd`), `lib/outbound/dispatch.js` (`renderAudio` renders the voicemail too on `voicemail_on` attempts)
- Test: `tests/outboundAmd.test.js`

**Interfaces:**
- `decideAmd({answeredBy, attemptNo, voicemailOn, complianceClass}) → {action:"none"|"voicemail"|"hangup"|"wait", result?:string}`:
  - `human` and `unknown` give `none`;
  - `machine_start` gives `wait`;
  - `machine_end_*` gives `voicemail` with result `voicemail_left` if `attemptNo ∈ voicemailOn` and the class permits it (solicited and service do), otherwise `hangup` with result `voicemail_skipped`;
  - `fax` gives `hangup` with result `failed`.
- The route:
  1. records `answered_by` and `amd_duration_ms` (from `MachineDetectionDuration`);
  2. then acts:
     - for `voicemail`, `twilio.calls(CallSid).update({ twiml: "<Response><Play>"+signMediaUrl(...)+"</Play><Hangup/></Response>" })`;
     - for `hangup`, `update({ status: "completed" })`;
  3. writes `result`.

  A machine-answered attempt is excluded from silent-call accounting (Task 20 reads `answered_by`).

- [ ] **Step 1: Write the failing table test.** It covers:
  - all seven `AnsweredBy` values;
  - `voicemail_on` including and excluding the attempt;
  - a `machine_end_beep` on an attempt outside `voicemail_on`, which gives `hangup`/`voicemail_skipped`;
  - through the route, a fake Twilio client receives `update` with a `<Play>` URL whose signature verifies, and whose path carries this CallSid.
- [ ] **Step 2: Implement.** Then run, and sabotage by swapping the `voicemail_on` membership test to always-true. Expected: the "outside voicemail_on" row goes RED. Revert. Commit: `feat(outbound): async AMD routing, voicemail by REST redirect from any instance`.

### Task 14: The session's outbound context (spec §9.2) and the first seconds (spec §9.3, revised after the spikes)

**Files:**
- Create: `lib/outbound/callContext.js`, `lib/outbound/liveRender.js`, `lib/outbound/firstSeconds.js`
- Modify:
  - `lib/voice/live/index.js`: the onStart branch at ~5200-5245; `createCall` at ~5320; `writeCallState` at ~5361; the VAD result at ~4040; model-audio enqueue at ~4149; the kick at ~5534, which is skipped for outbound
  - `services/db.js` (`createCall` accepts an optional `{direction, campaignId, campaignVersion, outreachId, attemptId, contactId}`; existing callers are unchanged)
  - `lib/outbound/internalRoutes.js` (`buildOutboundDeps` wires `renderAudio` to `liveRender.renderLines`)
- Test: `tests/liveOutboundStart.test.js`, `tests/outboundFirstSeconds.test.js`, `tests/outboundLiveRender.test.js`, `tests/outboundCallContext.test.js`

**Correction C8 is superseded by the revised spec.** The backstop is short and **interruptible**, so it uses the normal audio path and the normal barge-in. No `nonInterruptible` flag and no half-duplex change are needed.

**Interfaces:**
- `resolveOutboundContext(callSid, { db }) → Promise<null | { businessId, attemptId, outreachId, campaignId, campaignVersion, config, contact:{firstName, timezone, phone}, triggerSummary, openerText, openerAudio:Buffer|null, attemptNo }>`
  - It uses `app_outbound_attempt_by_call_sid` **inside one `withTenant`-style transaction** (the function adopts scope), then reads the attempt, outreach, contact, version and business under that scope.
  - Correction C7: it uses the existing `fetchBusinessById` / `fetchBusinessCapabilities` (NON_PHI in `lib/phiAudit.js`) with `loadConfig`. There is no new `lookupBusinessById`.
- `renderLines({ lines: {opener, voicemail?}, voiceName, languageCode, connect }) → Promise<{ opener: Buffer, voicemail?: Buffer }>` in NEW `lib/outbound/liveRender.js`. It renders the clips **with Gemini Live in the tenant's voice** (spec D6, revised).
  - For each line, it opens a short Live session through `lib/voice/live/client.js`'s `connectLive`, with the same model and voice as the call: `resolveLiveVoice` and `resolveLiveLanguage` at `index.js:235-289`, given the BUSINESS number, not the contact's.
  - The system prompt is "Speak the user's text exactly, nothing else". The user turn is `Say exactly: "<line>"` with `turnComplete:true`.
  - It collects the 24 kHz PCM, downsamples it to 8 kHz and μ-law encodes it (`lib/voice/mulaw.js` `encodeMulaw`).
  - It **verifies** the output transcript against the line and **refuses** a clip whose word overlap is below 0.9, because the backstop must say the disclosure verbatim. Spike A measured 1.0 on 3/3.
  - Setup took about 140 ms; cost is about $0.002–0.004 per render. Spend is metered in production by the existing `live_call_summary` usage.
  - It is wired as `renderAudio` in `buildOutboundDeps` (Task 10).
- `createFirstSecondsController({ now, backstopAudio, backstopText, audioOut, sendMark, seed, noteToModel, streamStartAtMs, answerToStreamMs = 350, silenceBackstopMs = 2000, slowLiveMs = 1600 }) → { onCallerFrame({voiced, atMs}), onModelAudio(atMs), onAssistantTurnText(text), tick(atMs), firstAudio(): {from_answer_ms, from_speech_ms, path}|null }` in NEW `lib/outbound/firstSeconds.js`. It implements spec §9.3:
  - **Listen first.** Nothing plays while the caller is silent. Caller frames are always forwarded to Live.
  - **Speech onset** (the first `voiced` frame) starts the `slowLiveMs` clock. If model audio arrives first, the path is `live_reply`. If none has arrived `slowLiveMs` after onset, it plays the backstop and seeds it (`backstop_slow`).
  - **Silence:** at `streamStartAtMs + (silenceBackstopMs − answerToStreamMs)` with no onset, it plays the backstop and seeds it (`backstop_silence`).
  - **Seeding** uses `seed(text)`, i.e. `session.sendClientContent({ turns: [{ role: "model", parts: [{ text }] }], turnComplete: false })`. That is S1, the shape spike A proved 3/3. Model audio produced while the backstop plays is dropped until its mark `outbound-backstop-end` echoes.
  - **The backstop is interruptible.** It is enqueued through the normal `audioOut` path, so the existing barge-in (`index.js:4071-4077`) and the vendor `interrupted` handler stop it like any assistant audio (spec §9.3 step 4). `echoGuard.noteSpoken(backstopText)` is fed.
  - **First-turn check:** on the first assistant turn's text (or the backstop text), if `!/\b(AI|artificial intelligence|automated assistant|virtual assistant)\b/i.test(t) || !t.includes(businessName)`, it calls `noteToModel("Tell them now, briefly: you are {persona}, an AI assistant from {business}.")` once and logs `outbound_first_turn_incomplete`.
  - It logs `outbound_first_audio{from_answer_ms, from_speech_ms, path}` and, when used, `outbound_backstop_played`.
- In `index.js`, when `customParameters.direction === "outbound"`:
  - Resolve the context BY CALLSID (`ws.authorizedCallSid` is already bound). **Stream parameters are never used for identity.** With no context: log `outbound_context_missing` and close the socket (1008).
  - Set `state.direction = "outbound"`, `state.outbound = ctx`, `state.callerNumber = ctx.contact.phone` ("the other party", per §6.2), `state.twilioNumber = ctx.config.caller_id`, and `extras.outbound = ctx`.
  - Call `createCall(business.id, callSid, ctx.contact.phone, ctx.config.caller_id, { direction: "outbound", … })`.
  - `writeCallState(callSid, { …, direction: "outbound", attemptId })`.
  - **Do NOT send the greeting kick** (`index.js:5534-5538`). Outbound listens first. Build the controller at stream start. Wire `onCallerFrame` from the VAD result at ~4040, `onModelAudio` at the enqueue site ~4149, and `onAssistantTurnText` from the output transcription. Call `tick` from the existing 20 ms pump.
  - When `openerAudio` is null (the render failed), the silence path sends Live a one-line prompt instead of playing a clip ("The person hasn't spoken. Say: {backstopText}"). Log `outbound_backstop_missing`; G2 is monitored on that call.
  - **Inbound:** `direction` absent means every branch above is skipped, byte for byte, and the kick stays.

- [ ] **Step 1: Write the failing tests**
  - `tests/outboundCallContext.test.js` (fake db):
    - it resolves by CallSid;
    - an unknown CallSid gives null;
    - it never reads `customParameters`: pass a context whose stream params name a different business, and assert they are ignored.
  - `tests/liveOutboundStart.test.js`, using `tests/helpers/liveBoot.js` (`ws.deliver({event:"start", start:{callSid, customParameters:{direction:"outbound"}}})` at `:124-133`):
    - `lookupBusinessByPhone` is **not** called;
    - `createCall` receives `direction:"outbound"` and the link ids;
    - `writeCallState` receives `direction` and `attemptId`;
    - **no kick `sendClientContent` is sent at start**;
    - an unresolvable CallSid closes the socket with 1008 and logs `outbound_context_missing`.
  - **Inbound unchanged:** the same boot with no `direction` calls `lookupBusinessByPhone(businessPhone)` exactly as before, sends the kick exactly as before, and the recorded `createCall` args equal the pre-change shape.
  - `tests/outboundFirstSeconds.test.js` (fake clock, fake `audioOut` recording enqueues and marks, `streamStartAtMs = 0`):
    1. **Listen first:** with no onset, nothing is enqueued before 1,650 ms. At 1,650 ms (2,000 − 350), the backstop is enqueued, `seed` is called once with the backstop text, and the path is `backstop_silence`.
    2. **The person speaks and Live answers:** onset at 1,870 ms (the owner's measured hello), model audio at 2,900 ms. No backstop; the path is `live_reply`; `from_speech_ms = 1030`.
    3. **Slow Live:** onset at 1,000 ms, no model audio. At 2,600 ms (onset + 1,600) the backstop is enqueued and seeded; the path is `backstop_slow`.
    4. **Interruptible:** onset during backstop playback leaves the controller calling NO special-case clear protection. The normal barge path is exercised by the index.js integration test: a voiced run during the backstop calls `audioOut.clear` exactly as it would for any assistant audio.
    5. **Seeded suppression:** model audio arriving before the `outbound-backstop-end` echo is dropped; after the echo it plays.
    6. **First-turn check:** a first assistant turn "Hi, is that Sam?" (no disclosure) calls `noteToModel` once. "Hi Sam, it's Ava, an AI assistant from Digile Media" calls it zero times. A second incomplete turn does not call it again.
    7. A null `backstopAudio` on the silence path sends the one-line prompt and logs `outbound_backstop_missing`.
  - `tests/outboundLiveRender.test.js` (fake `connect` emitting canned 24 kHz PCM and an output transcript):
    - it returns a μ-law buffer of the right length (8 kHz);
    - a transcript that drops "AI assistant" is refused;
    - it uses the voice and language resolved from the business, not the contact.
- [ ] **Step 2: Implement** in this order: `callContext.js`, `liveRender.js`, `firstSeconds.js`, `createCall`'s optional argument (plus a test that the four-argument call is unchanged), then the `index.js` branch. After each file, run the full `tests/live*.test.js` set.
- [ ] **Step 3: Sabotage and commit.**
  1. Set `silenceBackstopMs` to 1500 with `answerToStreamMs` 0, i.e. spike B's behaviour. Expected: test 1 goes RED, because the backstop fires at 1,500 ms and would have clipped the owner's 1,870 ms hello. Revert.
  2. Resolve identity from `customParameters.businessPhone`. Expected: the "never reads customParameters" test goes RED. Revert.
  3. Remove the first-turn check's AI-disclosure test. Expected: test 6 goes RED. Revert.
  4. Commit: `feat(outbound): context by CallSid; listen-first first seconds with a Live-voiced, interruptible backstop`.

### Task 15: The simulated outbound call (harness), which proves Tasks 12–14 end to end

**Files:**
- Modify: `scripts/live-call-harness.js` (the `--outbound` mode)
- Test: `tests/liveOutboundHarness.test.js` (drives the in-process server as `tests/liveHarness*.test.js` already do)

**`--outbound` mode:**
1. Seed a `call_attempts` row for a random CallSid, or accept `--call-sid`.
2. POST a signed `/twilio/outbound-answer` with `Direction=outbound-api` and From/To swapped (`From` = our number).
3. Pass the TwiML `<Parameter>` through to `start.customParameters`, as `parseTwiml` already does (`:367-379`).
4. Speak first ("Hello?" at `--hello-ms`, default 1,870, the owner's measured value), or stay silent with `--silent`.
5. Echo marks back paced, as it already does (`:722-733`).
6. Fake the status callbacks (`in-progress`, then `completed`) and optionally an AMD verdict (`--amd human|machine_end_beep`).

**Assertions:**
- **speaking caller:** no assistant frame before the hello's onset; Live's reply within 2,000 ms of onset (`from_speech_ms`);
- **silent caller:** the backstop at about 2.0 s after the simulated answer (`backstop_silence`), seeded, with no second opener from Live afterwards;
- the `calls` row has `direction='outbound'`;
- post-call runs exactly once (Task 20; this test is completed in Task 20).

Every harness run with a real Live session is a paid run. It needs `reserveP1("P1-HARNESS", 0.05)` per run and the owner's OK before the first batch.

- [ ] Write the test, implement the mode, run it, and commit. Commit: `test(outbound): simulated outbound call through the real door and session`.

### Task 16: Outbound prompt (spec §9.5)

**Files:**
- Create: `lib/outbound/prompt.js`
- Modify: `services/gemini.js` (identity at :894; the dynamic tail at :1370; greeting branch at :1514-1570), `tests/fixtures/businessConfigs.js` (a new `OUTBOUND_FIXTURES` export only)
- Test: `tests/outboundPromptSnapshot.test.js`, with snapshots in `tests/__snapshots__/prompts/outbound/`

**Interfaces:**
- `outboundIdentityLine(config, outbound) → string`, which returns `You are ${persona}, an AI assistant calling on behalf of ${config.businessName}.` plus the existing AI-honesty line.
- `outboundCallBlock(outbound) → string`, which returns `=== OUTBOUND CALL ===` followed by:
  - who (first name) and why (objective, topic, trigger summary);
  - **the first-turn rule (spec §9.3/§9.5):**
    - wait for the person;
    - reply to what they actually said;
    - your first reply must include your name, that you are an AI assistant, and the business name;
    - if a line appears in the conversation as already said by you (the backstop), do not repeat it;
  - identity not yet confirmed: confirming the name is enough for the `business` audience;
  - **the situations table from spec §9.5, rendered as guidance lines:**
    - a gatekeeper gets the vague reason only, and Ava waits if put through;
    - a child or anyone else: share nothing, never ask a child anything, offer a callback;
    - a wrong number: apologise, `wrong_person`;
    - a call screener: name and reason once, then wait;
    - "bad time" gets `schedule_callback`;
    - "how did you get my number" gets the form explanation plus the offer to stop;
    - "stop calling" gets `opt_out`;
    - "are you a robot" gets "yes, an AI assistant";
  - the allowed actions, taken from campaign capabilities;
  - how to end politely.
- `buildStaticSystemPrefix` and `buildDynamicTail` add these ONLY when `extras.outbound` is present. On outbound, the inbound greeting branch (1514-1570) is skipped. `greetingTextFor` is never emitted; the first turn carries the AI disclosure, and the D4 transcription notice is given on request.

- [ ] **Step 1: Write the failing tests:**
  - A test asserts the rendered block contains a guidance line for **every row** of the spec §9.5 situations table (one assertion per row; the voicemail row asserts that it is absent from the prompt, because AMD handles it). A situation cannot then silently disappear from the prompt.
  - `outboundPromptSnapshot` iterates `OUTBOUND_FIXTURES` (speed-to-lead, speed-to-lead with a backstop already seeded, and missed-call-callback **shape only** for Part 3) with `toMatchFileSnapshot("…/outbound/<name>.static.txt" | ".tail.txt" | ".tools.json")`. **The first run writes the snapshots, and a human reviews them once before they are frozen** (G9 wording in the spec).
  - A test asserts the outbound prompt contains no `claimsRecording` match, and states the first-turn rule (persona name, "AI assistant", business name).
  - A test asserts that `buildStaticSystemPrefix(inboundFixture)` is byte-identical to its committed snapshot. The existing `tests/promptSnapshot.test.js` already proves this, so run it unchanged.
- [ ] **Step 2: Implement.** Run `tests/promptSnapshot.test.js` and `git status tests/__snapshots__/prompts/`. Only files under `outbound/` may be new; **zero** existing files may be modified.
- [ ] **Step 3:** Commit: `feat(outbound): outbound identity and OUTBOUND CALL block; inbound snapshots byte-identical`.

### Task 17: Direction-aware strings and the closing sequence (spec §9.5)

**Files:**
- Modify:
  - `lib/voice/strings.js` (`signOff` :496, nudges :479-487, `signOffRe` :912-913, `closingTicRe` :1063-1064, the Spanish versions at :1216/:1222)
  - `lib/voice/live/index.js` (readers at :2313-2318, 2475-2493, 3063, 3092, 4504)
  - `scripts/corpus/sabotage.mjs` (the new entries)
- Test: `tests/outboundStrings.test.js`

**Changes:**
- `getStrings(config, {direction})` returns outbound phrasings:
  - `signOffOutbound(firstName)`: "Thanks for your time, {first_name}. Bye for now."
  - `nudgeOutbound1`: "Are you still there?"
  - The `goodbyeOutbound` family.
- `signOffRe` and `closingTicRe` gain alternations for `thanks for your time` and `speak soon`.
- Inbound strings are unchanged.

**Steps:**
- [ ] Failing tests: each new outbound phrase satisfies the regex that gates `end_call`, and every existing inbound phrase still does (a table of the current `tests/liveGoodbyeExit.test.js:136-177` cases).
- [ ] Implement.
- [ ] Sabotage the **whole** new alternation, the way `scripts/corpus/sabotage.mjs:221-236` does for `farewell-adjective`: remove every added branch at once. Expected: RED. Revert.
- [ ] Commit.

### Task 18: `ctx.party` and `confirm_identity` (spec §9.6)

**Files:**
- Modify:
  - `services/gemini.js` `buildCallTools` (:507-576): declare `confirm_identity({ name_confirmed: boolean })` only when `extras.outbound`, and add it to `callToolNames` for the leak guard (:131-156)
  - `services/tools.js` (an engine-tool case beside `end_call` at :359-373)
  - `lib/voice/live/tools.js:363`, which builds `ctx.party`
  - the `callerPhone` consumers:
    - `lib/capabilities/requirements.js:104-106`
    - `capabilities/appointments.js:861, 2196, 2375`
    - `adapters/scheduling/internal.js:53, 71`
    - `capabilities/messages.js`, `capabilities/quotes.js`, `capabilities/smsConsent.js` (callback number: `party.phone`)
- Test: `tests/outboundParty.test.js`

**Rules:**
- **Inbound:** `ctx.party = { phone: callerPhone, source: "caller_id", verified: true }`, so every consumer behaves exactly as today.
- **Outbound:** `ctx.party = { phone: contact.phone, source: "dialed", verified: false }`. Then `confirm_identity({name_confirmed:true})` sets `verified: true` on the session state.
- `phone_on_file` is satisfied only when `party.verified`.
- `lookupByCaller` returns nothing until verified.
- Bookings write `clientPhone = party.phone`.
- The Live write-order gate (read-back plus yes) is unchanged.

**Steps:**
- [ ] Failing tests:
  - inbound: every existing appointments/requirements test runs unmodified (the regression proof);
  - outbound before confirm: `phone_on_file` is unsatisfied, `lookupByCaller` returns `[]`, and `book` refuses;
  - outbound after confirm: all three pass, and `book` receives `clientPhone === contact.phone`;
  - `confirm_identity` is not declared on inbound calls.
- [ ] Implement.
- [ ] Sabotage: make outbound `verified` start `true`. Expected: RED. Revert.
- [ ] Commit.

### Task 19: Transfer, outbound variant (spec §9.7, C9)

**Files:**
- Modify: `lib/voice/live/index.js` `redialForTransfer` (:5148-5179) and `lib/outbound/doorRoutes.js` (`POST /twilio/outbound-whisper`, `POST /twilio/outbound-transfer-result`)
- Test: `tests/outboundTransfer.test.js`

**Outbound TwiML:**
```xml
<Response><Dial timeout="20" callerId="{campaign caller_id}" action="{base}/twilio/outbound-transfer-result?attempt={id}">
<Number url="{base}/twilio/outbound-whisper?attempt={id}">{transfer.to}</Number></Dial></Response>
```

- The whisper says "Transfer from {persona_name}: {first_name}{, clinic_name if answered}."
- The transfer-result TwiML returns `<Say>{name} will call you back shortly</Say><Hangup/>` when `DialCallStatus != completed`, and records the outcome `callback_requested` with the note `transfer_unanswered`.
- It is allowed only inside `transfer.when`.
- **Inbound TwiML is unchanged.** Assert against a captured copy of today's string.

**Steps:**
- [ ] Failing tests (the outbound TwiML shape, the inbound TwiML unchanged, the window refusal, the unanswered path).
- [ ] Implement, run, sabotage the `callerId` choice, and commit.

### Task 20: Exactly-once post-call, the silent-call rule and the detectors (spec §11, §13.2–13.4)

**Files:**
- Create: `lib/outbound/postCall.js`, `lib/outbound/detectors.js`
- Modify:
  - `lib/voice/live/index.js` `finish()` (:5595): for outbound, persist tool results, stamp `session_finished_at`, and call `postCall.tryClaim`
  - `lib/outbound/internalRoutes.js` (the sweep backstop)
  - `services/db.js` (`claimPostCall`, `finishAttemptSession`, `applyOutreachResult`)
  - `lib/voice/metrics.js`
- Test:
  - `tests/outboundDetectors.test.js`
  - `tests/outboundPostCall.test.js`
  - `tests/db/outboundPostCallClaim.test.js` (the race)

**Interfaces:**
- `claimPostCall(attemptId) → boolean`, one statement:
  ```sql
  UPDATE call_attempts SET post_call_started_at = now()
   WHERE id = $1 AND post_call_started_at IS NULL
     AND status_completed_at IS NOT NULL
     AND (session_finished_at IS NOT NULL OR answered_at IS NULL OR status_completed_at < now() - interval '2 minutes')
   RETURNING id
  ```
  The third branch is the sweep's `outbound_postcall_without_session` backstop.
- `runPostCall({attemptId, businessId}, deps)` runs spec §11 steps 1–7:
  1. clear `opener_audio`/`voicemail_audio`, and set `result`/`ended_at`;
  2. resolve the outcome (`set_call_outcome`, then effects, then `generateSummaryAndSentiment`, extended with the outbound enum);
  3. run the opt-out detector;
  4. persist the answers;
  5. apply the state machine (terminal close / callback time / next schedule entry through `nextScheduled(r, call_attempts.attempt_no, …)` from Task 9). Pass the **attempt's own `attempt_no`**, never the outreach row's `attempts_made`;
  6. text after a missed call (a no-op until Task 27);
  7. write the outbox rows (a no-op until Task 28).
- `detectOptOut({assistantText, callerText}) → {hit:boolean, side:"assistant"|"caller"|null}`. The patterns are exactly §13.3's lists.
- `detectClaimedHuman(assistantText) → boolean`, using `/\b(I'?m|I am) (a )?(real|human|person)\b/i` without a following negation (`not`, `n't`).
- **Silent call (the two limbs, spec §13.4):** a human-answered attempt is silent when either:
  - `from_speech_ms > 2000`, if the person spoke;
  - `from_answer_ms > 2000`, if they never did.

  An attempt answered with no stream is also silent. A silent attempt sets `silent=true`, sets `outreach.hold_until = answered_at + 72h`, and logs `outbound_silent_call`. A machine-answered attempt is excluded. The controller's `firstAudio()` from Task 14 persists `first_audio_ms` (as `from_answer_ms`) at session finish.

**Steps:**
- [ ] **Step 1: Failing tests.**
  - The detectors use transcript fixtures:
    - "stop calling me" on the caller side is a hit;
    - "I've made sure we won't call you again" on the assistant side is a hit;
    - "I'm not a real person, I'm an AI" is NOT claimed-human;
    - "Yes, I'm a real person" is claimed-human.
  - The DB race: status-completed and session-finished land concurrently from two clients, and `runPostCall` executes **once**. Assert with a counter row.
  - Unanswered attempts (`no-answer`, `busy` (a decline the carrier ended), `failed`, `canceled`) run steps 1 and 5–7 only. `busy` and `no-answer` produce the **same** next `next_attempt_at`, asserted in one parameterised test. A decline is never scored `not_interested`.
  - A callback-requested outcome schedules at the requested time.
  - The silent rule, on each limb:
    - human, spoke, `from_speech_ms` 2,300 gives `silent` plus a 72 h hold;
    - human, spoke at 1,870 ms and Live replied 1,030 ms later: `from_speech_ms` 1,030, **not** silent, even though `from_answer_ms` is 2,900;
    - human, never spoke, `from_answer_ms` 2,300 gives `silent`;
    - `machine_end_beep` at any timing is not silent.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Sabotage.**
  - Remove `AND post_call_started_at IS NULL`. Expected: the race test goes RED (it runs twice). Revert.
  - Remove the machine exclusion from the silent rule. Expected: RED. Revert.
  - Sabotage the whole opt-out caller-side pattern list. Expected: RED. Revert.
- [ ] **Step 4:** Finish Task 15's harness assertion ("post-call runs exactly once"). Commit.

### Task 21: Metrics, log names and the checkpoint

- [ ] Write `tests/outboundLogEvents.test.js`. It scans `lib/outbound/**` and `lib/voice/live/index.js` for `log.(info|error)("outbound_…")`, and asserts that **every §14 name that belongs to stages 2 and 3 is emitted somewhere**, i.e. §14 is a **subset** of what is emitted.
  - Equality is wrong: the code legitimately emits extra diagnostics, e.g. `outbound_backstop_render_failed` and `outbound_internal_routes_disabled`.
  - The test makes a "metric on a name nothing logs" impossible (§14), and it is what the alert policies are keyed to.
- [ ] Add `live_call_summary` fields: `direction`, `attempt_id`, `campaign_id` (index.js :5641-5685). Inbound gets `direction:"inbound"`.

**Checkpoint 2b:**
- [ ] The full root suite and `test:db` are green, and `git status tests/__snapshots__/prompts` shows only new `outbound/` files.
- [ ] The simulated outbound call (Task 15) passes 3 runs in a row.
- [ ] requesting-code-review over the 2b diff. Fix the Critical and Important findings.
- [ ] Update memory and write the prompt for Task 22 (the deploy session).

---

# STAGE 2 · STEP 2.6: deploy with outbound switched off (Task 22). **Owner OK required.**

### Task 22: Infrastructure through gcloud, then the image, the migrations and the service

**Files:**
- Modify: `docs/compliance/` (the D2 note, plus retention-schedule rows for the new tables), `infra/terraform/IMPORT-LATER.md` (every resource created here, for a later `terraform import`)
- If the owner picks C17's recommendation: `lib/outbound/twilioAccounts.js` plus a test (credentials selected per caller ID), and the new secret `twilio-account-sid-alt`

- [ ] **Step 1: Owner decision C17** (see §0.3). Live round 1 dials from `+18176011171`, which is on account B, and the service only holds account A's REST credentials.
  - **Recommended:** a `twilio-account-sid-alt` secret, which pairs with the existing `twilio-auth-token-alt`, plus `twilioAccounts.js`.
    - `twilioAccounts.js` resolves the account for each caller ID at campaign save, by listing incoming numbers on each account. The dispatcher uses that account's client.
    - Tests: an A number resolves to A; a B number resolves to B; a number on neither is refused at save (`caller_id_invalid`).
  - **Alternatives:** buy a US number on account A, or port `+18176011171` to A.
  - Implement whichever the owner picks, TDD, before Step 3.
  - (C11, the TTS configuration, needs nothing: outbound clips are rendered by Live.)
- [ ] **Step 2: Write the D2 note** `docs/compliance/outbound-and-the-2026-08-appeal.md`, per spec §2 D2. Add the new tables to the retention schedule (`call_attempts` 6 months), plus the suppression-survives-erasure exception (§13.5).
- [ ] **Step 3: Ask the owner.** Show the exact command list below, the diff range from the production SHA to HEAD, and the rollback. **Wait for yes.**
- [ ] **Step 4: Run the infrastructure commands** (`CLOUDSDK_CONFIG=~/.gcloud-vetra2`; record each in IMPORT-LATER.md):
  ```bash
  gcloud services enable cloudtasks.googleapis.com --project=vetra-uk-edc8ca
  gcloud iam service-accounts create outbound-tasks --project=vetra-uk-edc8ca --display-name="Outbound Tasks/Scheduler invoker"
  gcloud run services add-iam-policy-binding voice-uk-prod --region=europe-west2 --project=vetra-uk-edc8ca \
    --member=serviceAccount:outbound-tasks@vetra-uk-edc8ca.iam.gserviceaccount.com --role=roles/run.invoker
  gcloud tasks queues create outbound-dispatch --location=europe-west2 --project=vetra-uk-edc8ca \
    --max-dispatches-per-second=1 --max-concurrent-dispatches=5 --max-attempts=3
  gcloud projects add-iam-policy-binding vetra-uk-edc8ca \
    --member=serviceAccount:voice-uk-prod@vetra-uk-edc8ca.iam.gserviceaccount.com --role=roles/cloudtasks.enqueuer
  gcloud iam service-accounts add-iam-policy-binding outbound-tasks@vetra-uk-edc8ca.iam.gserviceaccount.com --project=vetra-uk-edc8ca \
    --member=serviceAccount:voice-uk-prod@vetra-uk-edc8ca.iam.gserviceaccount.com --role=roles/iam.serviceAccountUser
  BASE_URL=https://voice-uk-prod-462445274080.europe-west2.run.app   # NO trailing slash -- it must equal outboundEnv().baseUrl exactly
  gcloud scheduler jobs create http outbound-sweep --location=europe-west2 --project=vetra-uk-edc8ca \
    --schedule="*/5 * * * *" --http-method=POST --uri="$BASE_URL/internal/outbound/sweep" \
    --oidc-service-account-email=outbound-tasks@vetra-uk-edc8ca.iam.gserviceaccount.com --oidc-token-audience="$BASE_URL"
  ```
  The `serviceAccountUser` binding is needed because the service mints tasks whose OIDC token is issued **as** `outbound-tasks`.
- [ ] **Step 5: Build and migrate.**
  1. Build: `gcloud builds submit --config=cloudbuild.yaml --substitutions=_TAG=<sha> --service-account=… --project=vetra-core-edc8ca`.
  2. Update the **job** image: `gcloud run jobs update vetra-migrate-uk-prod --image=…:<sha> --project=vetra-uk-edc8ca --region=europe-west2`.
  3. Run `--args=scripts/migrate.js,--status`, then `--args=scripts/migrate.js`, then `--status` again. Expect 042, 043 and 044 to show as applied.
- [ ] **Step 6: Deploy the service** with `gcloud run services update voice-uk-prod --image=…:<sha> --update-env-vars=GIT_COMMIT_SHA=<sha>,OUTBOUND_ENABLED=false,OUTBOUND_TEST_ALLOWLIST=<owner handsets>,OUTBOUND_TASKS_QUEUE=projects/vetra-uk-edc8ca/locations/europe-west2/queues/outbound-dispatch,OUTBOUND_TASKS_SA=outbound-tasks@vetra-uk-edc8ca.iam.gserviceaccount.com,OUTBOUND_MAX_CONCURRENT=<Twilio account A limit>,OUTBOUND_INBOUND_RESERVE=2`.
  - Diff the env names and secret refs before and after.
  - The new revision must be Ready and take 100% of traffic.
  - The boot log must NOT say `outbound_internal_routes_disabled`.
- [ ] **Step 7: Verify.**
  - **Inbound:** one ordinary inbound call on the Digile line. Read `live_call_summary`; it must show `direction:"inbound"`, with no errors.
  - **Sweep:** Scheduler has run, and the sweep log line shows `reenqueued: 0`.
  - **Live render:** render one backstop on the revision through `outbound-admin --render-check`. It calls `liveRender.renderLines` once and prints the byte count and the transcript word overlap only. It is a paid call of about $0.003: `reserveP1("P1-DEPLOY", 0.01)`.
  - Rollback: `gcloud run services update-traffic voice-uk-prod --to-revisions=<previous>=100`. Migrations are additive and stay.
- [ ] **Step 8: Commit** the docs and `IMPORT-LATER.md`. Nothing is pushed.

---

# STAGE 2 · STEP 2.7: live round 1 (Task 23). **Owner on their US handset** (spec D7: no UK legs for now).

### Task 23: Thirteen scenarios, including one inbound call (spec §15)

- [ ] **Setup.** Run it through `scripts/outbound-admin.js`:
  1. Create the campaign from `speed_to_lead` with persona "Ava", **active**. The caller ID follows the Task 22 C17 decision: `+18176011171` if account-B credentials were added.
  2. Set `business-outbound --enabled true --max 1` on the tenant that owns the caller ID. A callback to it must reach that tenant's inbound.
  3. For each run, create an allow-listed trigger with `--consent-manual`.
  4. `reserveP1("P1-LIVE-R1", 1.50)` before the round.
- [ ] **The runs.** For each scenario, the owner says "ready", the trigger fires, the sweep dispatches within about 7 minutes (C14), and Claude reads the logs. **Every answered call records the hello timing**, which tunes the 2.0 s backstop (spec §9.3 step 8).

| # | Owner does | Pass when |
|---|---|---|
| 1 | answers "Hello?" | Ava waits for it, then replies in context within 2 s of onset (`outbound_first_audio.path=live_reply`, `from_speech_ms` ≤ 2000); name + AI + business in the first reply; `calls.direction='outbound'` (G1, G2, G3) |
| 2 | answers "This is {name}, how can I help?" | Ava's reply uses the name and gives the reason; no re-introduction |
| 3 | answers and says nothing | backstop at about 2.0 s after pickup (`backstop_silence`); Live continues without repeating it |
| 4 | lets it go to voicemail | `answered_by=machine_end_*`; message heard after the beep; `result=voicemail_left` (G4) |
| 5 | doesn't answer | `result=no_answer`, or a voicemail answer (see §9.4); next attempt scheduled per the schedule |
| 6 | declines the call | **either** outcome passes (spec §9.4): a **voicemail** attempt if the carrier forwards it (spike B call 3), or `busy`/`no_answer` if it ends the call. Either way the next attempt is scheduled, and it is never scored "not interested" |
| 7 | hangs up during Ava's first line | no silent-call flag (audio was heard); post-call runs once |
| 8 | asks for a human | transfer per §9.7 (or "not in window" handled) |
| 9 | says "stop calling me" | suppression row written before the call ends (tool) or at post-call (detector) (G7) |
| 10 | plays a gatekeeper ("Reception, who's calling?") | asks for the contact by first name, gives only the vague reason, offers a callback or waits if put through |
| 11 | plays someone else ("He's not here, I'm his son") | shares nothing, asks the "child" nothing, offers a callback, outcome `wrong_person` or `callback_requested` |
| 12 | rings back afterwards | inbound unaffected by the outbound row. Recognition itself is Task 26 in stage 3; G8 completes in round 2 |
| 13 | places an ordinary inbound call | inbound unchanged (G9) |

- [ ] **Report per call:** the unit a caller feels (memory: *report-the-unit-a-caller-feels*). File any defect in the backlog, and fix only what blocks the round. Commit the round report to `docs/superpowers/plans/2026-09-24-outbound-part1-live-round-1.md`.

---

# STAGE 3: follow-through (branch `feat/outbound-stage3`)

### Task 0 (3): refresh

Re-anchor the lines, record the baselines, and read the round 1 report.

### Task 24: The `qualification` pack (spec §12.2)

**Files:**
- Create: `capabilities/qualification.js`
- Modify: `capabilities/index.js:50` (append to `PACKS`, then update the order snapshot at `:9-30`), `AI-phone-dashboard/backend/src/routes/settings.js:231` (`BUILTIN_TOOL_NAMES`)
- Test: `tests/qualificationPack.test.js`

**Contract**, following `capabilities/_contract.js:157-176` and using `capabilities/transfer.js` as the smallest template:
- `id:"qualification"`, `label:"Qualification questions"`, `core:false`
- `toolNames:["record_answer"]`, `actionTools:[]`. It is not a write-gated tool: an answer is a note, not a booking.
- `tools(cfg, ctx)` declares `record_answer({key, value})` only when `ctx.outbound?.config.capabilities.includes("qualification")` or inbound callback recognition supplied questions (Task 26).
- `execute`:
  - rejects an unknown key, or a value over 500 characters, with a `functionResponse` error that names the valid keys;
  - on success returns `stateEffects.capabilityState.qualification.answers[key]=value` and `capabilityEffects:[{capability:"qualification",type:"answered",data:{key}}]`.
- **Booking gate:** `appointments`' `book_appointment` is refused ONCE if required keys are missing, with the message naming them. After one refusal, the booking proceeds and the outcome carries `missing_required:[...]`. The ceiling of 1 comes from memories *guards-that-ask-get-declined* and *a-mangled-yes*. Implement it as a requirement in `lib/capabilities/requirements.js` with a per-call counter in `capabilityState` (memory: *prompt-caps-need-counters*).
- `prompt(cfg, ctx)` has `static.capabilities` listing the questions, marked required or optional.

**Steps:**
- [ ] Failing tests:
  - unknown key refused;
  - a 501-character value refused;
  - an answer is recorded into state;
  - `book_appointment` with a missing required answer is refused exactly once, then allowed;
  - an optional question never blocks;
  - an inbound call without recognised questions declares no `record_answer`.
- [ ] Implement.
- [ ] Sabotage the ceiling (unbounded refusals). Expected: RED. Revert.
- [ ] Export the schemas (`node scripts/export-capability-schemas.js`). The drift test must be green.
- [ ] Commit.

### Task 25: The `outcome`, `callback` and `opt_out` packs (spec §12.2, §13.3)

**Files:**
- Create: `capabilities/outcome.js`, `capabilities/callback.js`, `capabilities/optOut.js`
- Modify: `capabilities/index.js`, the dashboard's `BUILTIN_TOOL_NAMES`, `services/db.js` (`insertSuppression` PHI write [suppressions]; `ON CONFLICT DO NOTHING`)
- Test: `tests/outboundPacks.test.js`, `tests/db/outboundSuppression.test.js`

**The three tools:**
- `set_call_outcome({outcome, note?})` takes an enum from §12.2. `booked` and `opted_out` are refused, because effects set those.
- `schedule_callback({when_iso, when_text})`:
  - must fall inside the calling window, on the contact's clock (Task 4), and within 14 days;
  - otherwise it returns `{ok:false, nearest: <ISO>}` for the model to offer.
- `opt_out()`:
  - inserts the suppression **immediately**, inside the tool call's tenant scope (`executeToolCallGuarded` wraps it, `services/tools.js:2301`);
  - sets the outcome to `opted_out`;
  - the `functionResponse` instructs the reply "I've made sure we won't call you again." Per memory *a-refusal-message-is-a-request*, the row is the guarantee, not the words.

**Steps:**
- [ ] Failing tests:
  - enum enforcement;
  - the `booked` refusal;
  - a callback outside the window returns the nearest valid time;
  - a callback 15 days out is refused;
  - **opt_out writes the row before `finish()`**: the DB test asserts the suppression row exists while the session is still open;
  - a second `opt_out` does not error.
- [ ] Implement.
- [ ] Sabotage `opt_out` to defer the write to post-call. Expected: the "before finish" test goes RED. Revert.
- [ ] Commit.

### Task 26: Retries end to end and callback recognition (spec §8, §12.3; correction C2)

**Files:**
- Modify:
  - `lib/outbound/postCall.js` (callback time, voicemail per attempt, give-up)
  - `services/db.js` (`openOutreachForPhone(phone)` is an ordinary tenant-scoped PHI read, per C2; `closeOutreachCalledBack(outreachId)`)
  - `lib/voice/live/index.js` inbound onStart, after the business resolves (~5240): the lookup plus the extras
  - `services/gemini.js` (a `CALLER CONTEXT` addition, only when the lookup hits)
  - `lib/voice/live/index.js` `finish()`: close with `called_back` unless a `schedule_callback` happened
- Test: `tests/outboundJourney.test.js` (a simulated five-attempt journey on a fake clock) and `tests/liveCallbackRecognition.test.js`

**Steps:**
- [ ] **Journey test.** Attempts 1–5 over `["now","+10m","+3h","next_day 10:00","day_3 17:30"]`:
  - voicemail only on attempts 1 and 5;
  - a text after miss 1 (a no-op until Task 27);
  - closed after attempt 5 with `attempts_exhausted`;
  - a `give_up_after_days` breach closes early.

  Assert each `next_attempt_at` exactly.
- [ ] **Recognition test** (liveBoot, inbound): a caller whose number has an open outreach within 14 days gets:
  - the `CALLER CONTEXT` sentence "We called this person on {date} about {topic}. Questions still unanswered: {…}.";
  - `record_answer` declared with the remaining questions;
  - `calls.outreach_id` set;
  - the outreach closed `called_back` at finish.

  **A caller with no open outreach produces a prompt byte-identical to today's** (inbound snapshots unchanged).
- [ ] Implement.
- [ ] Sabotage the 14-day bound. Expected: RED. Revert.
- [ ] Commit.

### Task 27: Text after a missed call (spec §12.4)

**Files:**
- Modify: `services/notifications.js` (a new kind `outbound_missed` in `DEFAULT_SMS_TEMPLATES` :358), `lib/smsConsent.js:74` (placeholders), the dashboard constants copy, `lib/outbound/postCall.js` (step 6)
- Test: `tests/outboundMissedText.test.js`

**Rules:**
- It is only available when `TWILIO_SMS_FROM` is set. Otherwise log `outbound_sms_unavailable` once at boot and do nothing.
- It requires the consent's `channels` to include `sms`.
- The template is ≤ 300 characters and validated like the opener.
- It sends through `sendCallerSms(…, {transactional:false})`.

**Steps:**
- [ ] Failing tests:
  - no sender means no send, plus the boot log;
  - consent without `sms` means no send;
  - attempt ∉ `text_after_missed` means no send;
  - otherwise exactly one send, with the rendered template.
- [ ] Implement.
- [ ] Sabotage the channel check. Expected: RED. Revert.
- [ ] Commit.
- [ ] **Owner:** set up a UK SMS-capable sender and set `TWILIO_SMS_FROM`. Until then the feature stays off, and says so.

### Task 28: The results webhook (spec §12.5; corrections C3 and C10)

**Files:**
- Create:
  - `lib/outbound/secretBox.js`: AES-256-GCM using `OUTBOUND_WEBHOOK_KEY`, a 32-byte base64 key from the new secret `outbound-webhook-key`, **pending the owner's C3 decision**.
  - `lib/outbound/webhookSigner.js`
  - `lib/net/ssrfGuard.js`
  - `lib/outbound/outbox.js`
  - `docs/outbound-webhook-contract.md`
- Modify: `services/db.js` (outbox and endpoint functions), `lib/outbound/postCall.js` (step 7), `lib/outbound/internalRoutes.js` (a delivery task handler, plus the sweep backstop for due outbox rows), `scripts/outbound-admin.js` (`webhook-set`, `webhook-test`)
- Test:
  - `tests/outboundWebhookSigner.test.js`: verify against an **independent** implementation, i.e. Node `crypto.createHmac` computed inline in the test, not by importing the signer.
  - `tests/ssrfGuard.test.js`
  - `tests/outboundOutbox.test.js`
  - `tests/db/outboundOutbox.test.js`

**Contract:**
- Headers: `X-Vetra-Event`, `X-Vetra-Delivery`, and `X-Vetra-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + raw_body)>`.
- Payload: exactly §12.5's JSON.
- Backoff: 1m, 5m, 30m, 2h, 12h, then `dead`.
- Timeout: 6 s.
- `last_error` has no PII: status code or error class only.

**SSRF guard.** It resolves every A/AAAA record and refuses any private address, including:
- 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10;
- `::1`, `fc00::/7`, `fe80::/10`;
- IPv4-mapped `::ffff:x.x.x.x`.

It then **connects to the vetted IP**, with the Host/SNI header set to the hostname, which closes the rebinding window. `redirect: "manual"` means a 3xx is a failure.

**Steps:**
- [ ] Failing tests:
  - the signature matches the independent computation;
  - a tampered body fails to verify;
  - each private range is refused;
  - a redirect is refused;
  - the backoff sequence ends `dead` after 5 attempts;
  - the idempotency key makes a re-insert a no-op;
  - `secretBox` round-trips;
  - a ciphertext from another key fails;
  - **the secret never appears in any log line** (spy on `log.*`).
- [ ] Implement.
- [ ] Sabotage the `::ffff:` check. Expected: RED. Revert.
- [ ] Commit.
- [ ] Record the existing `integrations/webhook.js` guard gaps as a backlog entry (C10). Do not change them.

### Task 29: The generic trigger webhook, `POST /v1/triggers/:triggerToken` (spec §12.1)

**Files:**
- Create: `lib/outbound/triggerRoute.js`
- Modify: `database/045_campaign_trigger_tokens.sql` (the `campaigns.trigger_token_hash` column, folded into `schema.sql`), `services/db.js`, `scripts/outbound-admin.js` (`trigger-token-rotate` prints the token ONCE)
- Test: `tests/outboundTriggerRoute.test.js`, `tests/db/outboundTrigger.test.js`

**Rules:**
- The token is 32 random bytes, stored as `sha256`, and compared in constant time.
- The body is validated (E.164; consent block required unless the class is `service`).
- The route upserts the contact, records the consent, creates the outreach idempotently (`idempotency_key` or `hash(phone + source_ref)`), enqueues it, and returns **202** `{outreach_id}`.
- It has its own rate limit (30/min per token) and a 16 KB body limit.
- **Resolving the token to a tenant needs no tenant scope first:** add `app_campaign_by_trigger_hash(hash)` to a new no-RLS `campaign_trigger_directory`, the Task 3 pattern (C1 again). Its test re-owns the function to a NOBYPASSRLS role.

**Steps:**
- [ ] Failing tests: bad token is 401, missing consent for `solicited` is 422, a replay returns the same `outreach_id`, the route returns 202, and the directory definer test.
- [ ] Implement, sabotage the constant-time comparison (swap it for `===`, with a timing-free test on the comparator function itself), and commit.

### Task 30: Booking on the built-in calendar (spec §12.6)

- [ ] **Test** (`tests/outboundBooking.test.js`):
  - an outbound call after `confirm_identity` books through `adapters/scheduling/internal.js` with `clientPhone = party.phone`;
  - a clash is refused by `create_appointment_if_available`;
  - the booking's effect sets the outcome `booked`.
- [ ] **Implement:** only the effect-to-outcome wiring. Everything else exists after Task 18. Commit.

### Task 31: Live round 2 (plan step 3.7). **Owner, plus 2–3 accent testers.**

- [ ] Set `reserveP1("P1-LIVE-R2", 3.00)` before the round.
- [ ] Run 10–20 calls through the demo qualifier (the Digile-style question set), with 2–3 regional accents and one noisy line.
- [ ] **Pass (G10):** questions asked; answers in `calls.answers` / `contacts.attributes`; a booking in the internal calendar; a signed webhook received at a test endpoint (e.g. a local `webhook-test` receiver behind a quick tunnel).
- [ ] Report per call: the unit a caller feels. Commit the report.

### Checkpoint 3

Same as Checkpoint 2a:
- [ ] Both suites green.
- [ ] Inbound snapshots unchanged.
- [ ] Review, then fix the Critical and Important findings.
- [ ] Update memory and write the prompt for stage 4.

---

# STAGE 4: dashboard and demo (branch `feat/outbound-stage4`)

The dashboard backend is CommonJS Express 5:
- routers are mounted with full paths (`server.js:142-148`);
- auth goes through `middleware/authMiddleware.js`, which sets `req.authUser`;
- tenancy goes through `withTenantHandler`;
- every tenant route must be listed in `PHI_ROUTES` or `NON_PHI_ROUTES` (`phiAudit.js:39,71`, enforced by `__tests__/phiAuditRoutes.test.js`).

The frontend switches pages on `activePage` in `App.jsx:467` and has no router. It uses the `.set-` design system (`Panel`, `Field`, `SaveBar`), and labels live in `LanguageSwitcher.jsx` (en/es/fr). Tests use the dashboard's own vitest: `cd AI-phone-dashboard/backend && npx vitest run`, and the same in `frontend`.

### Task 32: Backend routes, `routes/outbound.js`

The endpoints, all under `withTenantHandler`:
- `GET/POST/PUT /api/outbound/campaigns`. Validation uses the **generated** `campaignSchema.json` rules **and** calls the engine's `validateCampaign` through a small shared copy. Decide in Task 0: either ship `lib/outbound/campaignSchema.js` as a CJS build artifact, or duplicate the validator with a drift test that runs both against the same fixture table. The drift-test route is recommended, matching `capabilityConfigValidation.js`.
- `POST /api/outbound/campaigns/:id/status` (pause/resume; resume re-enqueues through the sweep)
- `GET /api/outbound/outreach?campaign=…` and `GET /api/outbound/outreach/:id` (the timeline: attempts, calls, outcome)
- `POST /api/outbound/outreach/:id/call-now` (sets `next_attempt_at=now()`)
- `POST /api/outbound/outreach/:id/stop` (closes with a manual reason)
- `GET/POST/DELETE /api/outbound/suppressions` (a CSV export for GET, with `?format=csv`)
- `GET/PUT /api/outbound/webhook` (the secret is shown once) and `POST /api/outbound/webhook/test`
- `GET /api/calls?direction=` (`routes/calls.js:17`)
- analytics split by direction (`routes/analytics.js`)
- a per-business kill switch at `PUT /api/outbound/settings` (`outbound_enabled`, `outbound_max_concurrent`, bounded 0–10)

**Steps:**
- [ ] Failing tests with `__tests__/harness.js` (a fake db and fake auth):
  - every route refuses without auth;
  - every write validates;
  - `marketing_consented` is refused;
  - every route is classified in `phiAudit`.
- [ ] Implement and commit.

### Task 33: Campaigns page

A schema-driven editor over `campaignSchema.json`:
- it starts from a template;
- it shows the **character budgets live**, rendering the opener with a 30-character worst-case first name;
- it shows every validation error at once;
- it has pause/resume and the kill switch.

**Steps:**
- [ ] Frontend tests (jsdom):
  - the budget counter turns red over 300;
  - saving with a missing AI disclosure shows the server's error;
  - the Part 1 refusals are greyed out with "arrives in Part 3".
- [ ] Commit.

### Task 34: Leads page

Leads per campaign, with state and next attempt, a timeline per lead, and the "Call now" and "Stop" buttons.

- [ ] Tests, then commit.

### Task 35: Call log and analytics by direction

A direction filter on the call log (`App.jsx:571-583` `callsQueryParams` and `:970-1030`); the outcome and answers shown for outbound; analytics split by direction.

- [ ] Tests, then commit.

### Task 36: Settings: the do-not-call list and the webhook

The do-not-call list (add, remove, CSV export) and the webhook URL plus secret with a test button. **The "Connect GoHighLevel" button is Part 2.**

- [ ] Tests, then commit.

### Task 37: The demo campaign and rehearsal (plan step 4.5)

- [ ] Build a copy of Digile's six-question qualifier as the campaign config, booking into the built-in calendar, with the tenant's British Gemini Live voice (Kore; the owner chose Live's voice by ear in spike A) and the persona "Ava from Digile".
- [ ] Set `reserveP1("P1-DEMO", 1.00)`.
- [ ] **Done when** a full run works twice in a row on the owner's phone.

### Checkpoint 4 / Part 1 done

Every item in G1–G10 (spec §3) is met:

| # | Evidence |
|---|---|
| G1 | Round 1, scenario 1 |
| G2 | `first_audio_ms` ≤ 2000 on every live call |
| G3 | the save-time validation plus the assertion on every played opener |
| G4 | Round 1, scenario 2 |
| G5 | Task 7's twelve sabotages |
| G6 | Task 9's database race |
| G7 | Round 1, scenario 7, plus Task 20's sabotage |
| G8 | Round 2 |
| G9 | snapshots plus inbound calls |
| G10 | Round 2 |

- [ ] Write the Part 1 report and commit it. **Ask the owner** before merging anything toward `main`.

---

## Spec coverage (self-review)

| Spec § | Task(s) |
|---|---|
| §2 D2 appeal note | 22 |
| §2 D3 no recording | global constraint (no `<Record>`; `tests/recordingPathLint.test.js`) |
| §2 D4 disclosure | shipped in session 1 (`lib/voice/disclosure.js`) |
| §2 D5 reactivation refused | 5 (save), 6 (gate) |
| §2 D6 voice | spike A → 14, 37 |
| §2 D8 budget | global constraint, `reserveP1` in 23, 31, 37 |
| §5 architecture, cross-instance rule | 3, 9, 12, 13, 20 |
| §6.1 tables | 1 |
| §6.2 changed tables | 2 |
| §6.3 definer functions | 3 (C1, C13), 26 (C2), 29 |
| §7 campaign config and save rules | 5, 32–33 |
| §8 state machine and schedule grammar | 4, 9, 20, 26 |
| §9.1 routes | 10, 12, 13, 19, 29 |
| §9.2 session start | 14 |
| §9.3 opener | spike A, 14, 15 |
| §9.4 AMD | spike B, 13 |
| §9.5 prompt and strings | 16, 17 |
| §9.6 identity and appointments | 18 |
| §9.7 transfer | 19 |
| §10.1 dispatch | 9 |
| §10.2 enqueueing | 8 (C14), 10 |
| §10.3 gate | 7 |
| §11 post-call | 20 |
| §12.1 trigger | 29 |
| §12.2 packs | 18 (`confirm_identity`), 24, 25 |
| §12.3 callback recognition | 26 |
| §12.4 SMS | 27 |
| §12.5 results webhook | 28 |
| §12.6 booking | 30 |
| §13.1 consent classes | 6, 7 |
| §13.2 disclosure detector | 5, 20 |
| §13.3 opt-out | 20, 25 |
| §13.4 silent calls | 14, 20 |
| §13.5 records | 22 |
| §14 logs, flags, deploy | 4, 10, 21, 22 |
| §15 testing (baseline, units, DB, snapshots, simulated call, live rounds) | Task 0s, every task, 15, 23, 31 |
