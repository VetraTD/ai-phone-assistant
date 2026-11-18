# GCP Migration — Design Spec

**Date:** 2026-07-22
**Status:** SUPERSEDED by `2026-08-02-gcp-migration-architecture.md`. Baseline figures here (480
tests, 791-line `services/supabase.js`, 19 migrations, Gemini 2.5 Flash) are stale, and three
conclusions have since been disproven — see that document's appendix. Kept for provenance.
**Branch:** to be cut from `feat/voice-v2`
**Related:** [[receptionist-overhaul-plan]], [[voice-v2-test-call-fixes]]

---

## 1. Why

A medical clinic is committed as the first customer, with day-one scope of "AI answers our
main line" using the athenahealth integration for patient lookup and scheduling. That is a
full PHI surface: caller identity, DOB, phone number, appointment reason. We become a HIPAA
Business Associate on the first live call.

Three findings drive this migration.

**1. The current Gemini path can never be BAA-covered.** We call Gemini through the AI Studio
developer API (`@google/genai` with `GEMINI_API_KEY`). Google's Gemini API Additional Terms
state "Do not submit sensitive, confidential, or personal information to the Unpaid
Services," and the AI Studio endpoint is absent from Google's HIPAA covered-products list at
every tier. The paid tier stops training on inputs but grants no BAA. This is a live
compliance defect, not an optimization.

**2. Our current hosts charge for BAAs that GCP gives away.** Verified 2026-07-21:

| Vendor | BAA gate | Fixed $/mo |
|---|---|---|
| Supabase | Team plan ($599) + HIPAA add-on (~$350) | $949 |
| Railway | $1,000/mo committed spend, 1-year commitment | $1,000 |
| Vercel | Pro ($20) + HIPAA add-on ($350) | $370 |
| Sentry | Business tier | $80 |
| **Total** | | **$2,399** |

**3. The Google Cloud BAA is free and self-serve.** Accepted by click-through in the Cloud
Console (IAM & Admin → Google Cloud Platform HIPAA Business Associate Addendum), no payment
step, no sales call. It covers every service this migration targets: Cloud Run, Cloud SQL,
Cloud Storage, Secret Manager, Cloud Logging, Cloud Monitoring, Cloud KMS, Vertex AI
(Gemini), Speech-to-Text, Text-to-Speech.

Post-migration fixed cost for the same capability is approximately **$0** plus metered usage,
against $2,399/mo today.

### Why GCP and not AWS or Azure

All three offer a free BAA. GCP wins on one decisive point: **we are already on Gemini, and
Vertex AI is a client-initialization change.** Moving to AWS would mean swapping the LLM to
Claude on Bedrock and re-tuning every prompt against a different model on top of the
infrastructure migration. AWS's one real advantage — telephony inside the same BAA via Chime
SDK — only pays off if we also leave Twilio, which is a separate and much larger project.

Secondary: Cloud Run is the closest equivalent to Railway's developer experience of any
hyperscaler container product, and Chirp 3 HD is the strongest text-to-speech available under
a free BAA.

---

## 2. Goals

- Every service that touches PHI is covered by an executed BAA.
- Gemini calls move to Vertex AI. No PHI ever transits the AI Studio endpoint.
- Fixed monthly infrastructure cost returns to roughly zero.
- The voice pipeline's observable behavior is unchanged. All 480 existing tests pass
  against the migrated data layer without modification to their assertions.
- Secrets leave `.env` files and live in Secret Manager with IAM and audit logging.
- A real migration runner replaces the 19 loose SQL files in `database/`.

## 3. Non-goals

Explicitly out of scope for this spec. Each is named in §10 as follow-on work so it is not
lost.

- **No rewrite of the voice pipeline.** `lib/voice/*` is behavior-critical, was debugged
  against 14 live calls, and is verified by 480 tests. It moves unchanged.
- **No decomposition of `session.js`** (2035 lines) in this spec. Worth doing; do it after
  the migration so the test suite is validating one change at a time.
- **No PHI redaction / logging-scrub program.** Separate spec.
- **No consent, disclosure, or recording-law work.** Separate spec.
- **No tenant vendor routing** (`phi_mode`, healthcare TTS/STT). Separate spec, depends on
  this one.
- **No compliance paperwork** (risk analysis, policies, training). Parallel non-engineering
  track.
- **No model change.** The turn model stays Gemini 2.5 Flash with `thinkingBudget: 0`.
  Vertex makes future model changes a config edit under the same BAA; that decision is
  deferred and should be driven by an eval harness, not intuition.
- **No telephony change.** Twilio stays. A Security Edition quote is being pursued
  separately and does not block this work.

---

## 4. Target architecture

```
        PSTN
          │
      Twilio  (Programmable Voice, Media Streams — separate BAA, Security Edition)
          │  WSS
          ▼
   ┌──────────────────────────────────────────────┐
   │  Cloud Run: voice service                    │
   │  min-instances=1, CPU always allocated       │
   │  lib/voice/* unchanged                       │
   └───┬───────────┬───────────┬──────────────┬───┘
       │           │           │              │
       ▼           ▼           ▼              ▼
   Deepgram    Vertex AI    ElevenLabs    Cloud SQL
    (STT)      (Gemini)       (TTS)       (Postgres,
                                           private IP,
                                           CMEK)
       │
   ┌───┴──────────────────────────────────────────┐
   │  Cloud Run: dashboard API                    │
   │  Firebase Hosting: dashboard SPA             │
   │  Identity Platform: staff auth               │
   │  Secret Manager · Cloud Logging · Cloud KMS  │
   └──────────────────────────────────────────────┘
```

STT and TTS vendors are shown as they exist today. Routing them per tenant is the follow-on
spec; this migration only ensures the seams (`lib/voice/sttStream.js`,
`lib/voice/ttsStream.js`, `lib/voice/ttsHealth.js`) survive intact so that routing is a
configuration change later.

### Service mapping

| Today | Target | Nature of change |
|---|---|---|
| Supabase Postgres | Cloud SQL for PostgreSQL 16 | Same engine. Data moves by `pg_dump`/`pg_restore`. |
| `@supabase/supabase-js` query builder | `pg` via a thin repository layer | Rewrite internals of one module; exported interface unchanged. |
| Supabase Auth | Identity Platform | Hardest piece. Different SDK, user import required. |
| Railway | Cloud Run | Container in, HTTPS+WSS out. Three settings must be right (§5.4). |
| Vercel | Firebase Hosting | Static SPA build + CDN. |
| Sentry | Cloud Error Reporting | Weaker UI, free, in-BAA. |
| `.env` / Railway vars | Secret Manager | Versioned, IAM-scoped, access-audited. |
| Gemini via AI Studio key | Gemini via Vertex AI | Client init + auth change. Same model. |
| Brevo (no BAA at any price) | Removed | See §5.8. |

---

## 5. Component migrations

### 5.1 Database — Cloud SQL

Provision PostgreSQL 16 with:

- **Private IP only**, no public IP. Cloud Run reaches it over a Serverless VPC connector.
- **CMEK** (customer-managed encryption key) via Cloud KMS rather than Google-managed keys.
  This costs nothing meaningful and materially strengthens the HIPAA encryption safe-harbor
  argument: properly encrypted ePHI is not "unsecured PHI," so a compromise does not trigger
  breach notification under §164.404.
- Automated backups with point-in-time recovery enabled.
- Instance sizing: start at the smallest shared-core tier. Call volume for one clinic does
  not justify more, and it is a one-command resize.

Data transfer is a straight `pg_dump` from Supabase and `pg_restore` into Cloud SQL. Both are
stock PostgreSQL; no schema translation is required.

**Migration runner.** `database/` currently holds `schema.sql` plus 19 numbered files applied
by hand. Replace with `node-pg-migrate` (or an equivalent with a `schema_migrations` ledger).
Existing files are imported as the initial migrations without rewriting their contents. This
is in scope because applying schema changes by hand to a database holding PHI is itself a
finding a clinic's security questionnaire will ask about.

### 5.2 Data access layer

`services/supabase.js` (791 lines) contains ~28 of the repo's 35 `.from()` call sites. No use
of Supabase Storage or Realtime was found, which removes the two hardest things to replace.

**The dashboard backend is already migrated.** `AI-phone-dashboard/backend/src/db/index.js`
uses `new Pool()` from `pg` with parameterized raw SQL, and its routes resolve the tenant
server-side from the authenticated user (`getBusinessIdForUser(authUserId)` in
`routes/analytics.js:12`) rather than trusting a caller-supplied path parameter. That is the
correct pattern, it already works against Postgres, and it only needs a connection-string
change. Supabase appears in that codebase solely for auth token verification
(`middleware/authMiddleware.js`, using `SUPABASE_ANON_KEY`). Scope of the data-layer rewrite is
therefore `services/supabase.js` alone.

Approach: rename to `services/db.js` and rewrite the internals against `pg`, **keeping every
exported function's name, parameters, and return shape byte-identical.** Callers in
`lib/voice/*`, `services/*`, and `server.js` do not change.

This is the single strongest argument for migrating rather than rewriting: the 480-test suite
is a behavioral contract over exactly this interface. If the tests pass unmodified, the data
layer is correct. Any test that has to be edited to accommodate the new layer is a signal that
the interface drifted and should be treated as a defect, not a chore.

Use parameterized queries throughout. Do not introduce a query builder or ORM in this
migration — a new abstraction layered on top of a rewrite doubles the surface where behavior
can silently change.

Connection pooling: `pg.Pool` sized against Cloud Run's concurrency setting, with the Cloud
SQL connector. Cloud Run instances are ephemeral; the pool must tolerate instance recycling.

### 5.3 Authentication — the hard part

Supabase Auth is used across the dashboard:

| Call site | API |
|---|---|
| `AI-phone-dashboard/backend/src/middleware/authMiddleware.js:14` | `supabase.auth.getUser(token)` |
| `frontend/src/Login.jsx:21,49` | `signInWithPassword`, `resetPasswordForEmail` |
| `frontend/src/Signup.jsx:20` | `signUp` |
| `frontend/src/resetPassword.jsx:30,44` | `updateUser`, `signOut` |
| `frontend/src/App.jsx:510,515,774,793,875` | `getSession`, `onAuthStateChange`, `signOut` |
| `frontend/src/api.js:11`, `numberAPI.js:15` | `getSession` |

Target is **Identity Platform** (Google Cloud's productization of Firebase Authentication).
It provides email/password, password reset, JWT issuance, an `onAuthStateChanged` equivalent,
and server-side token verification through the Firebase Admin SDK — a near one-to-one shape
match, with a different SDK surface.

**User migration.** Supabase stores bcrypt password hashes in `auth.users`. Firebase Admin's
`importUsers` accepts bcrypt hashes directly, so existing staff accounts transfer without
forcing password resets. This must be verified against a real export before cutover; if it
fails, the fallback is a forced password reset for all users, which is acceptable at current
scale (pre-launch, low user count) but should not be discovered on cutover day.

**Open compliance question.** Identity Platform did not appear on the covered-products list
surfaced during research. This is likely immaterial: dashboard users are *clinic staff*, so
the auth store holds workforce credentials, not patient data, and an identity provider that
never receives PHI is not a business associate. That reasoning is defensible but must be
written into the risk analysis rather than assumed. Confirm Identity Platform's BAA status
before cutover and record the outcome either way. If it is not covered and the reasoning is
rejected, the fallback is email/password in our own Cloud SQL database with `bcrypt` and
short-lived JWTs — more code, no third party, unambiguously compliant.

### 5.4 Compute — Cloud Run

The voice service holds long-lived WebSocket connections for Twilio Media Streams. Three
Cloud Run defaults are actively hostile to that and must be changed:

1. **`min-instances = 1`.** Scale-to-zero terminates instances with active calls on them.
   Non-negotiable. Costs a few dollars a month.
2. **CPU always allocated.** The default throttles CPU between requests, which starves
   mid-call background work — LLM turn processing, TTS prefetch, timers in `turnManager.js`.
   With a WebSocket held open the request is technically in flight, but this setting should be
   explicit rather than relied upon.
3. **Request timeout.** Cloud Run caps maximum request duration (understood to be 60 minutes;
   **verify against current Cloud Run limits at implementation time**). A call exceeding the
   cap is dropped. Decide explicitly whether to accept this or handle it — for a receptionist,
   a 60-minute call is pathological and gracefully ending it is arguably correct behavior, but
   it must be a decision rather than a surprise.

Two services deploy separately: the voice service and the dashboard API. They have different
scaling profiles — the voice service needs warm instances and long connections; the dashboard
API is request/response and can scale to zero.

### 5.5 Frontend

`AI-phone-dashboard/frontend` builds to static assets and deploys to Firebase Hosting. The
only source change is swapping the Supabase auth client for the Identity Platform client
across the seven files listed in §5.3.

### 5.6 Secrets

All credentials move from `.env` and Railway environment variables into Secret Manager,
mounted into Cloud Run at deploy time via IAM-scoped service accounts. No secret value is
committed, and no secret is readable without an audited IAM grant.

This migration is also the moment to complete a still-outstanding action from
[[receptionist-overhaul-plan]]: **rotate `BREVO_API_KEY` and the Google OAuth client secret**,
which were exposed by a since-fixed axios error-logging bug and must be assumed compromised.
Rotate them as part of the move rather than migrating known-leaked values into a new secret
store.

### 5.7 LLM — Vertex AI

The highest-priority item in this spec and the smallest diff.

```js
// services/gemini.js — current, cannot be BAA-covered
new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// target
new GoogleGenAI({ vertexai: true, project: GCP_PROJECT, location: 'us-central1' })
```

Authentication changes from an API key to Application Default Credentials via the Cloud Run
service account. The model, prompts, generation config, and tool definitions are unchanged.

Two Vertex-specific requirements for genuine zero retention:

- **Context caching retains inputs for up to 24 hours by default.** `services/gemini.js`
  uses a cached prefix for latency. Under a BAA this must either be disabled or explicitly
  accepted and documented, with retention bounded. Resolve before PHI flows, because it
  trades directly against latency and that tradeoff should be made deliberately.
- **Prompt logging for abuse monitoring** applies unless the project uses invoiced billing or
  has been granted an abuse-monitoring exception through Support. Request the exception during
  migration; it has lead time.

Separately, and worth checking while in this file: `buildSystemInstruction(step, intent, cfg,
extras)` constructs the system instruction per turn. Cached prefixes only pay off when the
prefix is byte-stable, so a prompt that varies by step and intent may be producing many cache
entries or missing cache entirely. `cachedContentTokenCount` is already logged at
`services/gemini.js:1105`. Read it before and after migration; a cache that is not hitting is
costing both latency and tokens today.

### 5.8 Error tracking and notifications

**Sentry → Cloud Error Reporting.** A real downgrade in UI quality, taken because it is free
and inside the BAA. `lib/sentry.js` and `lib/logger.js` are the integration points.

One defect to fix during the move, not after: `services/notifications.js:333` calls
`captureException(err, { toNumber, kind })`, sending a caller's phone number to the error
tracker. A phone number held on behalf of a clinic is PHI. No error-tracking vendor plan makes
this acceptable; only removing it does. Fix it here because the file is being touched anyway;
the systematic scrubbing program is a separate spec.

**Brevo is removed rather than replaced.** Brevo offers no BAA at any price. The follow-on
notifications spec replaces detail-bearing staff emails with link-only notifications
("You have 1 new call summary — [login link]"), which removes email from the PHI surface
entirely and makes an email-provider BAA unnecessary. Until that spec lands, this migration
carries the Brevo dependency forward unchanged — no PHI-bearing email is newly introduced,
and no live clinic traffic exists yet.

---

## 6. Cutover plan

Ordered so that each step is independently verifiable and the riskiest work happens against a
system that is not yet carrying live traffic.

| # | Step | Verification |
|---|---|---|
| 0 | Accept the GCP BAA in Cloud Console. Create project, enable APIs, configure IAM. | BAA shows accepted, with acceptor and timestamp. |
| 1 | Migrate Gemini to Vertex. | Full test suite green; a live test call completes on the existing infrastructure. |
| 2 | Provision Cloud SQL (private IP, CMEK, PITR). Stand up the migration runner. Apply `schema.sql` + `001`–`019`. | Schema in Cloud SQL matches Supabase, diffed. |
| 3 | Rewrite `services/supabase.js` → `services/db.js` against `pg`. | **480 tests pass with no assertion edited.** Any edit is a defect. |
| 4 | Migrate auth to Identity Platform; import users. | Staff log in with existing passwords. Reset flow works end to end. |
| 5 | Containerize both services. Deploy to Cloud Run with the three settings from §5.4. | Live test call against a dev Twilio number over ngrok, then against the Cloud Run URL. |
| 6 | Deploy the SPA to Firebase Hosting. | Dashboard loads, authenticates, reads and writes. |
| 7 | Move all secrets to Secret Manager. Rotate `BREVO_API_KEY` and the Google OAuth client secret. | No secret remains in `.env` or Railway. Old credentials confirmed dead. |
| 8 | `pg_dump` / `pg_restore` production data. | Row counts match per table. Spot-check appointments and transcripts. |
| 9 | Repoint Twilio webhooks. | Live call end to end on GCP. |
| 10 | Hold old infrastructure warm for one week, then decommission. | Cancel Supabase, Railway, Vercel, Sentry. |

Steps 1 and 2 are independent and can proceed in parallel. Step 4 is the schedule risk and
should start early even though it lands late.

---

## 7. Verification

The test suite is the primary instrument. Specific gates:

- **480 tests green with zero assertion changes** after the data-layer rewrite. This is the
  contract. Modified assertions mean interface drift.
- **Live call verification** per the procedure in `docs/LOCAL_TESTING.md`, against a dev
  Twilio number, before production webhooks are repointed.
- **Latency comparison.** Capture `GET /api/debug/latency` (`DEBUG_ENDPOINTS=true`) before and
  after. Vertex, Cloud SQL round-trips, and VPC-connector hops all sit on the critical path;
  a regression must be caught before a clinic hears it. Record the baseline before step 1.
- **A restore test.** Restore a backup into a scratch instance and confirm integrity. This is
  required for the §164.308(a)(7) contingency plan and is evidence a clinic's questionnaire
  will ask for. Do it once, document it.
- **Cross-tenant isolation tests.** Assert that a query scoped to tenant A cannot return
  tenant B's rows. No RLS exists today (§8), so these tests are not guarding against a
  migration regression — they are closing a gap that is already open. Write them before the
  rewrite so they are validating behavior rather than documenting it.

---

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Tenant isolation has no database-level backstop — and never did.** Verified 2026-07-22: `database/` contains **zero** `CREATE POLICY` statements and no `ROW LEVEL SECURITY`, and `services/supabase.js:12` connects with `SUPABASE_SERVICE_KEY`, which bypasses RLS regardless. Isolation is enforced entirely by `business_id` predicates in application code. | **High**, but *pre-existing* — not introduced by this migration | Migration risk is therefore low: there is no RLS to lose. The standing risk is real and independent. Add cross-tenant negative tests during the rewrite, and adopt RLS in Cloud SQL as defense in depth — the migration is the cheapest moment to do it, since every query is being touched anyway. |
| Auth migration fails or bcrypt import does not work | Medium | Verify the import against a real export early. Fallback is a forced password reset at current low user count. |
| Cloud Run WebSocket behavior differs from Railway under load | Medium | Live call testing at step 5, before any traffic moves. Verify timeout, min-instances, and CPU allocation empirically rather than from documentation. |
| Latency regression from VPC connector or Vertex | Medium | Baseline before step 1; compare at every stage. |
| Identity Platform is not BAA-covered and the workforce-credentials argument is rejected | Low | Fallback to self-hosted auth in Cloud SQL. Scoped, known work. |
| Context caching must be disabled for zero retention, costing latency | Medium | Measure the cache hit rate first. If the cache is not hitting today, disabling it costs nothing. |
| Migrating with a clinic waiting creates schedule pressure to skip verification | Medium | athenahealth production access is the actual critical path (weeks-to-months, partner onboarding, not yet started). This migration is not the constraint and should not be rushed to feel productive. |

**Rollback.** Old infrastructure stays warm and intact through step 10. Rollback at any point
is repointing Twilio webhooks back to Railway. The one-way door is step 8's data transfer —
after production writes land in Cloud SQL, rolling back means reconciling divergent
databases. Keep the window between step 8 and step 9 short.

---

## 9. Open items

1. **Confirm Identity Platform's BAA coverage.** Record the answer and the reasoning in the
   risk analysis regardless of outcome.
2. **Verify Cloud Run's current maximum request timeout** against live documentation, and
   decide explicitly how calls exceeding it are handled.
3. **Request the Vertex abuse-monitoring / prompt-logging exception.** Has lead time; start
   early.
4. **Decide the context-caching tradeoff** — disable for zero retention, or accept and
   document bounded retention. Measure the current cache hit rate first.
5. **Obtain a Twilio Security Edition quote.** Does not block this migration, but it is the
   only remaining unpriced line item in the compliant stack and it gates the go-live date.

---

## 10. Out of scope — follow-on specs

Named so they are not lost. Rough dependency order:

1. **PHI logging and redaction** — allowlist-based structured logging, error-tracker
   scrubbing, a CI check that fails the build when a PHI-typed value can reach a logger, and
   removal of WebSocket frame dumps from any path reachable in production.
2. **Consent and disclosure** — the non-interruptible opening disclosure (a carve-out in the
   barge-in taper), per-call consent logging with a disclosure version, and a working human
   escape hatch. Driven by all-party recording-consent exposure and state AI-disclosure law,
   which is a larger near-term legal risk than HIPAA itself.
3. **Notifications rework** — link-only staff notifications; a decision on patient-facing
   SMS (`sendCallerSms`), whose tenant-editable templates are a TCPA exposure at $500–$1,500
   per call with no statutory cap.
4. **Tenant vendor routing** — `phi_mode`, fail-closed, gating subprocessor selection and
   retention. Depends on this migration.
5. **Retention and encryption** — per-tenant envelope encryption with KMS-wrapped keys,
   audit logging of PHI access (Required under §164.312(b), not addressable), and a
   caller-level export/delete path.
6. **`session.js` decomposition** — 2035 lines. Delete the dead `lib/mediaStream.js` legacy
   pipeline and its `PIPELINE_V2` escape hatch at the same time.
7. **Eval harness** — 30–50 real turns drawn from stored transcripts, weighted toward failed
   calls, scoring tool-call correctness, slot extraction, and phrasing. Converts model and
   prompt decisions from taste into data. Cheap config levers should be measured through it
   first: `temperature: 0.4` is low for conversational warmth, and a scoped thinking budget on
   booking turns is a cheaper experiment than a model tier change.
8. **Compliance paperwork** (non-engineering, parallel) — HHS SRA Tool risk analysis, policy
   set, incident response, contingency plan, training records, downstream BAAs, cyber
   liability insurance bound before the first clinic goes live.
