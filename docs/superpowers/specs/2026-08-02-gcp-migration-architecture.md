# GCP Migration — Target Architecture

**Date:** 2026-08-02
**Status:** Design document. Nothing here is implemented. No GCP resources exist yet.
**Supersedes:** `2026-07-22-gcp-migration-design.md` (baseline figures stale)
**Companion:** `2026-08-02-ideal-architecture.md` — the unconstrained "best stack" analysis. It
carries one action item for this document: **Gemini 3.1 Flash TTS ranks #2 on the Artificial
Analysis blind Speech Arena, above ElevenLabs v3.** If it is BAA-covered via Vertex, it replaces
Chirp 3 HD as the healthcare voice recommendation in §3 and §7.
**Effort assumption:** 40h/wk, solo
**Vendor facts verified:** 2026-08-02

---

## Decisions settled 2026-08-03

Four owner decisions that change what follows. Sections written before this block have been
updated to match; where they disagree, this block wins.

1. **Clinic v1 launches without athenahealth.** Scope is answer, take messages, route/transfer,
   answer FAQs, and book into Vetra's internal calendar via the existing
   `adapters/scheduling/internal`. Still full PHI, still needs every BAA — but it removes
   athenahealth partner onboarding (weeks-to-months, with their own security review) from the
   critical path. The application is still filed immediately; athena becomes v2.
2. **One codebase, two deployments** — not one deployment with runtime routing, and not two
   codebases. See §1.
3. **GCP for all infrastructure, best-of-breed for AI vendors.** Infrastructure layers are
   invisible to callers, so consolidating them costs no quality and buys one vendor and a free
   BAA. The three layers that *are* the product — STT, TTS, LLM — stay best-of-breed per
   deployment.
4. **Order of work:** meeting prep → cheap latency wins (`2026-08-02-ideal-architecture.md` §12
   items 1-5, ~1-2 weeks) → this migration. Clinic live in roughly 7 weeks.

---

## Context

A family clinic is the committed first customer. Day-one scope is "AI answers our main line" —
caller identity, name, phone, reason for calling — which is a full PHI surface, so we become a
HIPAA Business Associate on the first live call, with or without an EHR integration.

Three things force this migration:

1. **A live compliance defect.** `services/gemini.js:40-45` calls Gemini through the AI Studio
   developer endpoint (`new GoogleGenAI({ apiKey })`). That endpoint is not covered by any Google
   BAA at any tier. Full transcripts, caller names, and DOB pass through it today.
2. **BAA fees on the current stack.** Supabase ($949) + Railway ($1,000) + Vercel ($370) +
   Sentry ($80) = **$2,399/mo** to obtain BAAs. Google Cloud's BAA is free, self-serve in the
   Console, and covers all regions and network paths.
3. **Five PHI paths leak outside any BAA** (§5). All pre-existing, all must close before a clinic
   takes a live call.

This document also settles how one architecture serves healthcare and non-healthcare businesses
without maintaining two of everything, and what the migration takes in wall-clock time.

**Current constraints:** pre-launch, no live tenants, no production data to reconcile.

---

## 1. The core architectural decision

**One codebase, two deployments. Infrastructure consolidated on GCP; AI vendors best-of-breed per
deployment.**

Two alternatives were considered and rejected.

**Two separate codebases** — non-healthcare on Supabase/Railway/Vercel with ElevenLabs, healthcare
on GCP — saves nothing. GCP runs ~$50-100/mo against today's *non-BAA* base plans at ~$65-90/mo.
It costs two databases, two auth systems, two deploy pipelines, two secret stores, two test suites,
and every feature shipped twice, permanently. The healthcare copy, being the smaller one, becomes
the less-exercised one — and that is the copy where a bug is a reportable incident.

**One deployment with a runtime `phi_mode` column** is cheaper still, but fails on cost and on
isolation. Twilio Editions are account-level, so a single Twilio account means Security Edition
pricing applies to *every* tenant's minutes, including the plumber's. And isolation would depend
on a code path being correct rather than on physical separation.

### The chosen shape

Same repository, same test suite, same deploy pipeline. Two Cloud Run services differing only in
environment configuration and vendor accounts.

| | Standard deployment | BAA deployment |
|---|---|---|
| Code | identical | identical |
| Tests | one suite, run once | same suite |
| Telephony | Twilio, standard account | Twilio, Security Edition account |
| STT | Deepgram, pay-as-you-go key | Deepgram, BAA key (or Google STT v2 if contract-gated) |
| TTS | ElevenLabs Flash v2.5, or whatever wins the A/B | Gemini 3.1 Flash TTS via Vertex (pending BAA confirmation), else Chirp 3 HD |
| LLM | Vertex AI, or Groq if it wins the bakeoff | Vertex AI |
| Database | Cloud SQL | Cloud SQL, separate instance |
| Infrastructure | GCP | GCP |

A healthcare tenant cannot reach a non-covered vendor, because it is served by a different service
with different credentials — not because a conditional evaluated correctly. Drift between the two
is *configuration* drift, which is visible in a diff, rather than *code* drift, which is not.
Tenant reclassification is repointing a phone number and moving rows, not a migration project.

Cost of the second deployment: roughly $15-30/mo of Cloud Run, plus a second set of vendor
accounts.

### Why infrastructure consolidates and AI vendors do not

Infrastructure layers — database, auth, secrets, cron, CI, logging, static hosting — are invisible
to a caller. GCP is at or near best-in-class on all of them and wins outright on Secret Manager, so
consolidating costs zero quality and buys one vendor, one bill, one IAM model, and a free BAA.

The three layers that *are* the product are different. Google's streaming STT runs 500ms-1s against
Deepgram's 200-300ms; Chirp 3 HD's time-to-first-audio is ~200ms against ElevenLabs Flash's ~75ms;
Vertex is competitive on LLM quality but slower to first token than Groq or Cerebras. Those get
chosen on merit per deployment. Full analysis in `2026-08-02-ideal-architecture.md`.

### Existing seams this reuses

Per-deployment vendor selection is environment configuration, but the per-*tenant* seams already in
the code still carry voice choice within a deployment:

- `lib/voice/session.js` `resolveVoice` already reads a per-business `voice_provider` and forces the
  Google TTS path
- `lib/voice/ttsHealth.js` is already a process-wide vendor circuit breaker
- `adapters/scheduling/index.js:40` `resolveSchedulingAdapter` already routes per tenant

### Data-handling differences between deployments

Vendor selection is environment config. These behavioral differences remain code, gated by a
deployment-level flag:

| Surface | Standard deployment | BAA deployment |
|---|---|---|
| Calendar sync | Full detail | Bare "Vetra appointment" block + dashboard deep-link |
| Email / SMS notify | Detail permitted | Link-only: "1 new call summary — [login]" |
| Tenant webhooks | Allowed | Blocked unless a downstream BAA is on file |
| Transcript retention | Standard | Bounded, documented |
| Vendor failure | Degrade to a covered TTS | **Fail closed** — voicemail, never a non-covered vendor |

Both deployments run on GCP, because the BAA is free and hosting a plumber there costs nothing
extra. Divergence is confined to environment configuration plus the five behaviors above, and the
same test suite covers both by running the behavioral tests under each flag value.

---

## 2. Target architecture

```
                         PSTN
                          │
                    Twilio  (Programmable Voice + Media Streams
                          │   — BAA requires Security/Enterprise Edition)
                          │  WSS + signed HTTP webhooks
                          ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Cloud Run: voice service                                    │
   │  min-instances=1 · CPU always allocated · timeout=3600       │
   │  concurrency ~10-20 · Direct VPC egress                      │
   │  server.js + lib/voice/* unchanged in behavior               │
   └──┬──────────┬───────────┬──────────────┬────────────┬────────┘
      │          │           │              │            │
      ▼          ▼           ▼              ▼            ▼
  Deepgram   Vertex AI   ElevenLabs /    Cloud SQL    Memorystore
   (STT)     (Gemini     Chirp 3 HD      PostgreSQL   (only if the
             3.6 Flash)  per deploy      16, private  callState audit
                                         IP, CMEK,    requires it)
                                         PITR
      ┌───────────────────────────────────────────────────────────┐
      │  Cloud Run: dashboard API   (scale-to-zero, no WS)        │
      │  Cloud Storage + Cloud CDN + HTTPS LB : SPA               │
      │  Identity Platform : staff auth                           │
      │  Cloud Scheduler → calendar sync (replaces setInterval)   │
      │  Secret Manager · Cloud KMS · Cloud Logging               │
      │  Cloud Monitoring · Error Reporting · Audit Logs          │
      │  Artifact Registry · Cloud Build                          │
      └───────────────────────────────────────────────────────────┘
                          │
                    athenahealth  (separate BAA — critical path)
```

### Service mapping

| Today | Target | Nature of change |
|---|---|---|
| Supabase Postgres | **Cloud SQL for PostgreSQL 16** — private IP, CMEK, PITR | Same engine. `pg_dump` / `pg_restore`. No Supabase-specific SQL exists to translate. |
| `@supabase/supabase-js` (30 `.from()` + 1 `.rpc()` in `services/supabase.js`) | **`pg` Pool** in `services/db.js` | Rewrite internals; exported signatures byte-identical. |
| Supabase Auth | **Identity Platform** | Confirmed HIPAA-covered. bcrypt hash import via Firebase Admin `importUsers`. |
| Railway | **Cloud Run** ×2 (voice, dashboard API) | Container in, HTTPS+WSS out. Four settings must be right (§4.2). |
| Vercel (SPA + marketing) | **Cloud Storage + Cloud CDN + external HTTPS LB** | Static build. Marketing pages are routes inside the same SPA — they cannot be split. |
| Sentry | **Cloud Error Reporting** | Weaker UI, free, in-BAA. PHI tags removed at the same time. |
| `.env` / Railway vars (100+ names) | **Secret Manager** | IAM-scoped, versioned, access-audited. |
| Gemini via AI Studio key | **Vertex AI**, ADC via service account | Client init change. Same model (`gemini-3.6-flash`, GA on Vertex). |
| Brevo + Gmail SMTP | **Kept, but PHI removed from message bodies** | Fix the content, not the vendor — link-only notifications take email out of the PHI surface entirely. |
| `setInterval` calendar worker | **Cloud Scheduler → HTTP endpoint** | Required, not optional: a scale-to-zero Cloud Run instance kills the timer. |
| Hand-applied SQL (22 files) | **`node-pg-migrate`** with a `schema_migrations` ledger | Existing files imported as-is. |
| No CI | **Cloud Build** + Artifact Registry | No `.github/` exists today. |
| No IaC | **Terraform**, one root module | Needed for staging/prod parity and for change-management questions on security questionnaires. |

---

## 3. Why GCP, and what stays off it

**Why GCP over AWS or Azure.** All three offer a free BAA. GCP wins because Gemini is already the
model — Vertex is a client-init change, where AWS would force an LLM swap and a full prompt re-tune
on top of the infrastructure migration. Cloud Run is also the closest thing to Railway's developer
experience among hyperscaler container products, and Chirp 3 HD is the strongest TTS available under
a free BAA.

**Twilio stays.** GCP has no PSTN. Twilio Programmable Voice and SIP are HIPAA-eligible, but Twilio's
own documentation states "HIPAA Accounts require Twilio Security Edition or Enterprise Edition" and
publishes no price — it is a sales conversation.

**Telnyx is the alternative, and it is not ready to be the primary carrier.** Two disqualifiers:
bidirectional media streaming is **not** on their HIPAA-eligible list (Programmatic Voice/Call
Recording, Messaging, Chat, Contact Center), and their HIPAA architecture guide directs transcription
destinations to be "Telnyx-hosted" — the opposite of streaming to your own Cloud Run. Add two
multi-hour voice outages (December 2025 backbone, February 2026 media pipeline) and it is the wrong
bet for a product whose entire value is answering the phone. Its advantages are real (~$0.007/min vs
Twilio's ~$0.014, lowest p50/p95 carrier round-trip in a June 2026 benchmark, no published edition
gate on the BAA), so it belongs in the file as a future second carrier for failover — for everyone,
not as a healthcare-only split.

**Recommendation: one carrier, Twilio, for all tenants.** Get both quotes in week 1; the Telnyx
quote is negotiating leverage. If Twilio's Edition price is genuinely prohibitive, move *everyone*.

### Voice vendors for the BAA deployment

**Chirp 3 HD for TTS.** Free under the BAA already being signed, already integrated
(`lib/voice/ttsStream.js:148` defaults to `en-US-Chirp3-HD-Aoede`, `services/googleTts.js` handles
mulaw 8k with an LRU cache, `lib/voice/voiceLocale.js` locale-matches per call), and costs
$0.033/call against ElevenLabs' ~$0.10.

**Cartesia Sonic 3.5 sounds better but is the wrong first move.** 40ms time-to-first-audio against
ElevenLabs Flash's ~75ms, and the strongest streaming prosody of the BAA-plausible options. But its
BAA is Enterprise-tier only — a new fixed monthly fee, which recreates the exact problem this
migration exists to eliminate, to close a quality gap nobody has measured. Measure first; escalate
with data.

**ElevenLabs cannot be the healthcare voice at any price.** Their HIPAA eligibility is scoped to
**ElevenLabs Agents**, their own orchestration loop, on Enterprise tier with Zero Retention Mode.
Taking it means deleting `session.js`, `turnManager`, `echoGuard`, `inboundVad`, the capability
packs, and the eval harness, and running the product inside their loop.

**Deepgram for STT if the BAA is affordable.** Deepgram will provide a BAA to "qualifying customers
upon request"; the tier gate is not published. Their ladder is pay-as-you-go ($0.0077/min, no
minimum), Growth ($4,000+ annual *prepaid usage*, not a fee — ~615,000 minutes at $0.0065/min), and
Enterprise (custom). Deepgram is meaningfully better than Google STT on noisy 8kHz telephony audio
and 300-700ms faster. If they demand an enterprise contract, Google STT v2 is the free-BAA fallback
behind the same `lib/voice/sttStream.js` seam — costs latency, not a rewrite.

### Cost model

Per 3-minute call (estimates):

| Stack | STT | TTS | LLM | Telephony | **$/call** |
|---|---|---|---|---|---|
| Today (Deepgram + ElevenLabs) | $0.023 | ~$0.10 | $0.056 | ~$0.04 | **$0.22** |
| BAA deployment (Deepgram + Chirp) | $0.023 | $0.033 | $0.056 | ~$0.04 | **$0.15** |
| All-Google fallback (STT v2 + Chirp) | $0.048 | $0.033 | $0.056 | ~$0.04 | **$0.18** |

Fixed monthly: **$2,399 today → ~$50-100** (Cloud Run min-instance ~$15-30, Cloud SQL smallest tier
~$25-50, HTTPS load balancer ~$18, everything else metered). The one unpriced line is Twilio's
Edition fee.

### BAA ledger

| Vendor | BAA status | Gate | Fixed cost |
|---|---|---|---|
| Google Cloud (all listed products) | Covered | Click-through in Console | $0 |
| Twilio | Eligible | Security or Enterprise Edition | **Unpriced — quote required** |
| Deepgram | On request | "Qualifying customers", tier unpublished | Unknown; Growth is $4k/yr prepaid usage |
| Cartesia | Enterprise tier only | Sales | Unknown, four figures likely |
| ElevenLabs | Agents product only | Enterprise + Zero Retention Mode | Incompatible with our architecture |
| Brevo | None at any price | — | Removed from the PHI path by design |
| athenahealth | Required | Partner onboarding + security review | **Critical path — weeks to months** |

Confirmed on Google's covered-products list: Cloud Run, Cloud SQL, Cloud Storage, Secret Manager,
Cloud KMS, Cloud Logging, Cloud Monitoring, Error Reporting, Speech-to-Text, Text-to-Speech,
Identity Platform, Firestore, Pub/Sub, Cloud Tasks, Cloud Scheduler, Memorystore, Artifact Registry,
Cloud Build, BigQuery. Vertex AI is BAA-covered; AI Studio never is. **Firebase Hosting is not on
the list** — see §4.5.

---

## 4. Component detail

### 4.1 Database — Cloud SQL

PostgreSQL 16, **private IP only**, reached over Direct VPC egress. **CMEK** via Cloud KMS rather
than Google-managed keys: costs nothing meaningful and materially strengthens the encryption
safe-harbor argument, since properly encrypted ePHI is not "unsecured PHI" and a compromise does not
trigger breach notification under §164.404. Automated backups with point-in-time recovery. Smallest
shared-core tier to start; resizing is one command.

`database/` holds `schema.sql` (11 tables) plus 22 numbered migrations `002`–`023`, every one headed
"Run this in the Supabase SQL Editor." Replace with **`node-pg-migrate`**, importing existing files
as the initial migrations without rewriting their contents. Applying schema changes by hand to a
database holding PHI is itself a finding a clinic's security questionnaire will raise.

No Supabase-specific SQL exists — no RLS, no policies, no `auth.users` references, no storage
buckets, no realtime publications, no extensions. One PL/pgSQL function
(`create_appointment_if_available`, uses `pg_advisory_xact_lock` and `make_interval`) ports as-is.

**Tenant isolation.** Zero `CREATE POLICY` statements exist, and `services/supabase.js:14` connects
with the service key, which bypasses RLS regardless. Isolation is application-code `business_id`
predicates only. This is pre-existing, not migration-caused — but the migration touches every query,
so it is the cheapest moment to close it. Write cross-tenant negative tests **before** the rewrite so
they validate behavior rather than document it. Adopt RLS with a per-request `SET LOCAL
app.business_id` as defense in depth.

### 4.2 Compute — Cloud Run

Two services with different profiles. The voice service holds long-lived Twilio Media Stream
WebSockets; the dashboard API is request/response and can scale to zero.

Four settings on the voice service:

1. **`min-instances = 1`** — scale-to-zero terminates instances holding live calls.
2. **CPU always allocated** — the default throttles CPU between requests, starving mid-call
   background work: LLM turns, TTS prefetch, `turnManager` timers, the `audioOut` pump.
3. **`timeout = 3600`** — Cloud Run's maximum request duration is 60 minutes (default 5). A
   WebSocket is a request. Set `CALL_MAX_DURATION_MINUTES` below this so calls end gracefully rather
   than being severed by the platform.
4. **Concurrency ~10-20, CPU 2** — the default of 80 concurrent requests per instance means 80
   simultaneous calls pumping audio through one Node event loop. Start low, measure, raise.

#### The stateful-call problem — the biggest technical risk in this migration

`lib/callState.js` holds per-call state in an in-process `Map` keyed by Twilio CallSid, and
`README.md` states plainly that running multiple instances without sticky sessions "will corrupt or
drop in-progress calls." On Railway that was one instance. On Cloud Run, `POST /twilio/voice`, the
WebSocket upgrade, and `POST /twilio/status` are three separate requests that can land on three
different instances.

Resolve by audit, not by guessing:

- The WebSocket handler owns the live session object (sockets, timers, audio queue). That is
  inherently one instance per call and is fine.
- `POST /twilio/voice` returns TwiML from a database lookup — should already be stateless.
- `POST /twilio/status` (`server.js:305-389`) does `db.completeCall`, missed-call notification,
  Gemini summary generation from the stored transcript, and latency rollup. Verify it reads
  **nothing** from `callState`.

If the audit is clean, no shared store is needed. If it finds cross-request dependencies, move the
shared *facts* (businessId, callerPhone, outcome flags, transcript sequence) to **Memorystore** —
HIPAA-covered — while the live session object stays in process. Do not attempt to serialize the
session object; it holds sockets.

Also delete the dead `lib/mediaStream.js` legacy pipeline (1,079 lines) and the `PIPELINE_V2` escape
hatch during containerization. Carrying an unmaintained second pipeline into a compliance-scoped
deployment is pure liability.

### 4.3 Data access layer

`services/supabase.js` is 1,039 lines, 33 exports, 30 `.from()` call sites and one `.rpc()`. No
Storage, no Realtime, no Edge Functions anywhere in the repo — the two hardest things to replace do
not exist.

The dashboard backend is **already migrated**: `AI-phone-dashboard/backend/src/db/index.js` is an
8-line `pg` Pool over `DATABASE_URL`, all routes use parameterized raw SQL, and tenant resolution is
server-side from the authenticated user (`getBusinessIdForUser(authUserId)`). It needs a
connection-string change and nothing else. Supabase appears there only in
`middleware/authMiddleware.js` for token verification.

Approach: rename to `services/db.js`, rewrite internals against `pg`, **keeping every exported
function's name, parameters, and return shape byte-identical**. Callers in `lib/voice/*`,
`services/*`, `capabilities/*`, and `server.js` do not change.

This is the strongest argument for migrating rather than rewriting: the **1,088-test root suite is a
behavioral contract over exactly this interface.** If the tests pass unmodified, the data layer is
correct. Any assertion that must be edited is a defect signal, not a chore.

No ORM, no query builder — a new abstraction layered on top of a rewrite doubles the surface where
behavior can silently change. Parameterized queries throughout. `pg.Pool` sized against Cloud Run
concurrency, tolerant of instance recycling, using the Cloud SQL connector.

Also update the 7 remaining `.from()` sites in `scripts/` (`provision-demo-line.js`,
`provision-number.js`, `verify-capabilities.js`, `test-buy-number.js`).

### 4.4 Authentication — Identity Platform

**Confirmed HIPAA-covered**, which resolves the open question left by the July spec. Call sites to
convert:

| Location | API |
|---|---|
| `AI-phone-dashboard/backend/src/middleware/authMiddleware.js:14` | `supabase.auth.getUser(token)` → Firebase Admin `verifyIdToken` |
| `frontend/src/Login.jsx:21,49` | `signInWithPassword`, `resetPasswordForEmail` |
| `frontend/src/Signup.jsx:20` | `signUp` |
| `frontend/src/resetPassword.jsx:30,44` | `updateUser`, `signOut` |
| `frontend/src/App.jsx:510,515,774,793,875` | `getSession`, `onAuthStateChange`, `signOut` |
| `frontend/src/api.js:11`, `numberAPI.js:15` | `getSession` |
| `frontend/src/supabaseClient.js` | client init — delete |

**Alternative worth weighing before starting: Better Auth, self-hosted.** It runs entirely inside
your own Postgres, so there is no identity vendor and nothing to sign a BAA with — BAA-neutral by
construction rather than BAA-covered. Costs $0, keeps user tables in the same database as
everything else, and its organization plugin supplies multi-tenant orgs, members, invitations and
RBAC out of the box. Identity Platform is less code to own; Better Auth is fewer vendors. Decide in
phase 0; the conversion surface is identical either way.

Near one-to-one shape match, different SDK surface. Supabase stores bcrypt hashes in `auth.users`;
Firebase Admin `importUsers` accepts bcrypt directly, so staff accounts transfer without forced
password resets. **Verify against a real export early** — the fallback (forced reset at pre-launch
user counts) is acceptable but must not be discovered on cutover day.

The `users` table is a plain application table with no foreign key to `auth.users`; the linkage is
resolved in application code. That makes this cleaner than it looks.

### 4.5 Frontend hosting

`AI-phone-dashboard/frontend` is React 19 + Vite 7 and contains **both** the marketing site (`/`,
`/contact`, `/terms`, `/privacy`, `/recording-disclosure`, `/acceptable-use`) and the dashboard
(`/app`, lazy-loaded). They cannot be split without splitting the app.

Target: **Cloud Storage + Cloud CDN behind an external HTTPS load balancer.** Cloud Storage is on the
covered-products list; Firebase Hosting is not. The SPA is static and never receives PHI server-side
— PHI flows browser↔Cloud Run API — so Firebase Hosting would be defensible, but Cloud Storage
removes the argument entirely for ~$18/mo of load balancer.

Port the `vercel.json` SPA rewrite (`/(.*)` → `/index.html`) to a load balancer URL map rule. Update
the hardcoded CORS allow-lists at `server.js:91-99` and `AI-phone-dashboard/backend/src/server.js:27-39`,
and remove the `VERCEL_URL` fallback at `AI-phone-dashboard/backend/src/routes/calendar.js:43`.

Self-host the Google Fonts currently loaded from `fonts.googleapis.com` in `index.html` — a
third-party request from an authenticated clinic dashboard is an unnecessary question to answer on a
security questionnaire.

`Vetra-desktop` is an unmodified Tauri scaffold pointed at the same Vite output; it needs nothing
beyond the new frontend URL.

### 4.6 LLM — Vertex AI

Highest-priority item in the migration and the smallest diff:

```js
// services/gemini.js:40 — current, can never be BAA-covered
new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// target
new GoogleGenAI({ vertexai: true, project: GCP_PROJECT, location: 'us-central1' })
```

Authentication moves from an API key to Application Default Credentials via the Cloud Run service
account. Model, prompts, generation config, and tool definitions are unchanged — `gemini-3.6-flash`
is GA on Vertex.

Two Vertex-specific requirements:

- **Request the abuse-monitoring / prompt-logging exception.** Without it, or without invoiced
  billing, prompts flagged by safety classifiers may be retained up to 30 days for abuse review.
  Filing has lead time — do it in week 1.
- **Context caching is not implemented.** The July spec worried about 24-hour cache retention; in
  fact the code only *reads* `usageMetadata.cachedContentTokenCount` for a debug log
  (`services/gemini.js:1212-1216`). There is no `caches.create` and no `cachedContent` request field
  anywhere. The latency-versus-retention tradeoff evaporates. Confirm implicit-caching behavior under
  the BAA and move on.

This change also covers the post-call summary path (`generateSummaryAndSentiment`,
`services/gemini.js:1324`), which sends the **entire transcript** — currently to AI Studio.

### 4.7 Background work

The 90-second `setInterval` calendar-sync worker
(`AI-phone-dashboard/backend/src/server.js:189-220`) cannot survive a scale-to-zero Cloud Run
service. Replace with **Cloud Scheduler** hitting an authenticated endpoint that calls
`syncPendingAppointments()`. The code comment at `:182-188` already anticipates this.

Fire-and-forget work inside `POST /twilio/status` (summary generation, notifications) currently races
the HTTP response. On Cloud Run with CPU throttled between requests this becomes unreliable — either
keep CPU always allocated on that service or move the work to **Cloud Tasks**.

---

## 5. PHI leak closures

All five are pre-existing. All five sit in files this migration already touches.

1. **Google Calendar sync.** `AI-phone-dashboard/backend/src/services/calendarSync.js:76-98` writes
   `summary: "Vetra: {client_name}"` plus a description containing `Phone:`, `Notes:`, and `Call ID:`
   into the business owner's **personal** Google Calendar. Consumer Google accounts carry no BAA.
   In the BAA deployment, write a bare "Vetra appointment" block with a dashboard deep-link.

2. **Email and SMS notifications.** `services/notifications.js` sends patient name, phone,
   appointment time, and full call summaries over SMTP defaulting to `smtp.gmail.com`
   (`formatAppointmentEmail:142`, `formatCallSummaryEmail:196`);
   `AI-phone-dashboard/backend/src/routes/appointments.js:100-155` sends the same digest via Brevo,
   which offers no BAA at any price. **Fix the content, not the vendor:** link-only notifications
   remove email from the PHI surface entirely and make an email-provider BAA unnecessary. The same
   rule applies to `sendCallerSms` (`notifications.js:318-334`), which additionally carries TCPA
   exposure at $500-$1,500 per message with no statutory cap.

3. **Error-tracker PHI.** `lib/sentry.js:19-27` promotes every context key to a Sentry tag.
   `services/notifications.js:332` sends `toNumber` — the caller's own phone number. `:116` sends
   email subjects containing caller names and appointment times. Moving to Cloud Error Reporting does
   not fix this; the fields must be removed. Add an allowlist at the `captureException` boundary.

4. **Unauthenticated PHI endpoints.** `server.js:400-409`
   `GET /api/businesses/:id/callers/:phone` returns a caller's prior call summaries and upcoming
   appointments given only a business UUID and a phone number — rate-limited, but unauthenticated.
   `:436-476` notification routes likewise. Either require authentication or move them behind the
   dashboard API.

5. **Tenant-defined webhooks.** `integrations/webhook.js:89-96` POSTs `caller_phone` plus whatever
   the model collected (name, DOB, reason) to any HTTPS URL a tenant configures, with arbitrary
   tenant-supplied headers forwarded. Block in the BAA deployment unless a downstream BAA is
   recorded.

**Structured-log scrubbing rides along.** `lib/voice/session.js:2311` logs `businessPhone` and
`callerPhone`; `:2407-2413` logs `callerNumber` and `businessName`; `server.js:228` logs
`callerNumber`. Deepgram and Google TTS debug lines log transcript excerpts. On Cloud Logging these
persist. Add a PHI allowlist to `lib/logger.js` and a test that fails the build when a PHI-typed
field can reach a logger.

---

## 6. Secrets and credential hygiene

All values move from `.env` and Railway environment variables into **Secret Manager**, mounted into
Cloud Run via IAM-scoped service accounts. Distinct service accounts per service, least privilege, no
secret readable without an audited IAM grant.

Rotate during the move rather than migrating known-leaked values into a new secret store:
**`BREVO_API_KEY` and the Google OAuth client secret** were exposed by a since-fixed axios
error-logging bug and must be assumed compromised. Also review existing `calendar_connections` rows —
the old unsigned OAuth-state flow was takeover-able before the `oauth_states` nonce table landed.

Housekeeping while in the file: delete `TYPING_SOUND_URL` (set in `.env`, referenced nowhere) and the
unused `@sendgrid/mail` dependency.

---

## 7. Sequence and timeline

Ordered so the riskiest work happens against a system carrying no traffic, and each step is
independently verifiable. **Pre-launch with no live tenants means no dual-run, no reconciliation
window, and no data-migration one-way door** — a substantial de-risking versus migrating later.

| Phase | Work | Effort | Gate |
|---|---|---|---|
| **0. Foundation** | Accept the GCP BAA. Create prod + staging projects, enable APIs, IAM, service accounts. Terraform root module. File the Vertex abuse-monitoring exception. Open Twilio Edition, Telnyx, and Deepgram BAA conversations. Start athenahealth production onboarding. Spike the Supabase→Firebase bcrypt import. | 3-4 days | BAA shows accepted with acceptor and timestamp. `terraform plan` applies clean to staging. |
| **1. Vertex** | `services/gemini.js` client init → Vertex + ADC. Capture the `GET /api/debug/latency` baseline **before** touching anything. | 1 day | Root suite green. `npm run eval` at or above 23/24 hard. One live test call on existing infrastructure. |
| **2. Cloud SQL** | Provision (private IP, CMEK, PITR). Stand up `node-pg-migrate`, import `schema.sql` + `002`–`023`. Write cross-tenant negative tests first. | 3-4 days | Schema diffed against Supabase, identical. Negative tests demonstrably fail against the current service-key client. |
| **3. Data layer** | `services/supabase.js` → `services/db.js` on `pg`. Update the 7 `scripts/` call sites. Dashboard backend connection string. | 6-8 days | **1,088 tests pass with zero assertion edits.** Any edit is a defect. |
| **4. Auth** | Identity Platform. Export bcrypt hashes, `importUsers`, convert the 8 frontend/backend call sites. | 3-4 days | Staff log in with existing passwords. Reset flow works end to end. |
| **5. Containerize + Cloud Run** | Dockerfiles (none exist). `callState` cross-request audit; Memorystore only if required. Delete `lib/mediaStream.js` and `PIPELINE_V2`. Deploy both services with the four settings from §4.2. Artifact Registry + Cloud Build. | 5-6 days | Live call against a dev Twilio number over the Cloud Run URL. Concurrency tested with ≥5 simultaneous calls. |
| **6. Frontend + background** | SPA to Cloud Storage + CDN + LB. CORS allow-lists. Cloud Scheduler for calendar sync. Cloud Logging + Error Reporting. | 3-4 days | Dashboard loads, authenticates, reads and writes. Scheduler fires and syncs. |
| **7. Second deployment + voice A/B** | Stand up the BAA Cloud Run service from the same image with its own vendor accounts and a deployment-level flag. Blind A/B of BAA-eligible voices against the 8 ElevenLabs voices, plus `npm run eval` on both. Fail-closed behavior. | 4-5 days | Tests prove the BAA deployment cannot reach a non-covered vendor, including under circuit-breaker failure. Both deployments serve a live test call. |
| **8. PHI closures** | All five from §5, plus log scrubbing. | 4-5 days | A CI check fails the build when a PHI-typed value can reach a logger or an error tracker. |
| **9. Hardening** | RLS in Cloud SQL. Audit logging for PHI access (§164.312(b), Required — not addressable). Backup restore test into a scratch instance. Latency comparison against the phase-1 baseline. | 4-5 days | Restore verified and documented. Latency within tolerance of baseline. |
| **10. Cutover** | Secrets to Secret Manager plus rotations. `pg_dump`/`pg_restore` (test data only). Repoint Twilio webhooks. Hold old infrastructure warm one week, then cancel Supabase, Railway, Vercel, Sentry. | 2-3 days | Live call end to end on GCP. Row counts match per table. Old credentials confirmed dead. |

**Engineering total: ~7-8 weeks at 40h/wk**, including realistic buffer. Phases 1 and 2 are
independent and can overlap. Phase 4 is the schedule risk and should be spiked in phase 0 even though
it lands mid-sequence.

**Minimum path to a live clinic is shorter.** With v1 scoped without athenahealth, the phases a
clinic genuinely blocks on are 0, 1, 2, 3, 5, 7, 8 and 10 — roughly **4-5 weeks**. Phase 4
(Identity Platform) can defer because the dashboard auth store holds workforce credentials, not
patient data; phase 6's frontend hosting carries no PHI; phase 9's RLS and audit logging are
defense in depth that should land before scale, not before the first call. Deferring them is a
scheduling choice to make deliberately and record in the risk analysis, not a permanent decision.

### Parallel tracks, not on the code critical path

- **athenahealth production access.** Partner onboarding is weeks-to-months and includes their own
  security review, and we hold sandbox/preview credentials only. **As of 2026-08-03 this is no
  longer the gate on the clinic** — v1 ships on `adapters/scheduling/internal` with no EHR
  integration. File the application on day one anyway; athena is v2, and starting late costs
  months later.
- **Compliance paperwork.** HHS SRA Tool risk analysis (free), policy set, incident response plan,
  contingency plan, workforce training records, a downstream-BAA register, and cyber liability
  insurance bound before the first clinic call. DIY from templates; roughly 2-3 weeks of
  non-engineering time.
- **Consent and recording disclosure.** A non-interruptible opening disclosure on 100% of calls
  (requires a carve-out in the barge-in taper), per-call consent logging with a disclosure version,
  and a working human escape hatch. Driven by all-party recording-consent statutes, which are a larger
  near-term legal exposure than HIPAA itself: real-time STT to a third party may be interception under
  CIPA-style laws, and "we don't store audio" likely does not exempt it. The
  `/recording-disclosure` page exists; the in-call behavior does not. Note also that CA AB 3030
  exempts administrative topics but attaches the moment the agent discusses clinical information —
  keep the agent on scheduling, intake, and routing.

---

## 8. Verification

The test suite is the primary instrument, not a formality.

- **1,088 root tests green with zero assertion changes** after the data-layer rewrite. This is the
  contract. Modified assertions mean interface drift.
- **`npm run eval`** (24 scenarios) at or above the current 23/24 hard, 21/24 judge — run before
  Vertex, after Vertex, and after the voice bakeoff. Costs money per run; budget for ~10 runs.
- **Live call verification** per `docs/LOCAL_TESTING.md` against a dev Twilio number before
  production webhooks move.
- **Concurrency test** — at least 5 simultaneous calls against one Cloud Run instance, watching for
  audio-pump starvation and event-loop lag.
- **Latency comparison** — `GET /api/debug/latency` with `DEBUG_ENDPOINTS=true`, baselined before
  phase 1 and compared at every phase. Vertex, Cloud SQL round-trips, and VPC hops all sit on the
  critical path; a regression must be caught before a clinic hears it.
- **Cross-tenant isolation tests** — a query scoped to tenant A cannot return tenant B's rows, at both
  the application and RLS layers.
- **Deployment isolation tests** — the behavioral flag suite runs under both values, and the BAA
  deployment's configuration is asserted to contain no non-covered vendor credentials. Include the
  failure case: with the TTS circuit breaker open, the BAA deployment must reach voicemail, never a
  non-covered vendor.
- **Restore test** — restore a backup into a scratch instance and verify integrity. Required evidence
  for the §164.308(a)(7) contingency plan. Do it once, document it.

---

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **`callState` in-process memory breaks across Cloud Run instances** | **High** — the biggest technical unknown | Audit every access path before containerizing. Memorystore for shared facts if the audit is not clean. Test with concurrent calls, not one. |
| **Twilio Security Edition pricing is prohibitive** | High, unpriced | Quote in week 1; Telnyx quote as leverage. If it breaks the model, move all tenants — and get written confirmation that Telnyx covers bidirectional media streaming first. |
| Data-layer rewrite drifts the interface | Medium | The 1,088-test suite is the gate. Any edited assertion is treated as a defect. |
| bcrypt hash import into Identity Platform fails | Medium | Verify against a real export in phase 0, not phase 4. Fallback is a forced reset at pre-launch user counts. |
| Chirp 3 HD is audibly worse than ElevenLabs | Medium | Blind A/B before commitment. Escalate to a Cartesia BAA with data if it loses. Non-healthcare tenants are unaffected either way. |
| Latency regression from Vertex / VPC / Cloud SQL | Medium | Baseline before phase 1; compare at every phase. |
| Deepgram's BAA requires an enterprise contract | Low | Google STT v2 behind the same `sttStream.js` seam. Costs latency, not a rewrite. |
| Schedule pressure from the waiting clinic causes skipped verification | **High as of 2026-08-03** | Dropping athena from v1 removed the slack this plan used to have — the migration *is* now the gate on clinic revenue. Compensate with the phase gates in §8, not with optimism. The 1,088-test contract and the live-call verification are not negotiable under schedule pressure. |
| Two deployments drift apart | Medium | Divergence is confined to environment configuration plus five flagged behaviors (§1). Run the behavioral suite under both flag values in the same CI job. Any code path that reads the deployment flag outside those five surfaces is a defect. |

**Rollback.** Old infrastructure stays warm and intact through phase 10. Rollback at any point is
repointing Twilio webhooks back to Railway. With no live tenants there is no divergent-data one-way
door — the property that makes migrating *now* far cheaper than migrating later.

---

## 10. Decisions — settled and open

**Settled 2026-08-03:**

1. **Split model:** one codebase, two Cloud Run deployments, differing by environment configuration
   and vendor accounts. Not a runtime column; not two codebases.
2. **Infrastructure:** all GCP, both deployments. AI vendors chosen on merit per deployment.
3. **Clinic v1 scope:** no athenahealth. Internal scheduling only.
4. **Telephony:** Twilio both sides — standard account for the standard deployment, Security
   Edition for the BAA deployment, so non-healthcare minutes never pay Edition pricing. Quote
   Twilio and Telnyx in week 1; the Telnyx quote is leverage, not a plan.
5. **Frontend hosting:** Cloud Storage + CDN + LB (in-BAA) over Firebase Hosting (not on the covered
   products list).

**Still open, resolve during phase 0:**

- **Which voice the BAA deployment uses.** Gemini 3.1 Flash TTS ranks #2 on the Artificial Analysis
  blind Speech Arena — above ElevenLabs v3 — and is presumably BAA-covered via Vertex. Confirm that,
  then A/B it against Chirp 3 HD. Chirp's problem is latency (~200ms TTFA vs ElevenLabs Flash's
  ~75ms), not quality.
- **Deepgram's BAA tier and price.** Determines whether the BAA deployment keeps Deepgram or falls
  back to Google STT v2 and eats 300-700ms.
- **Twilio Security Edition price.** The only unpriced line in the compliant stack.

---

## 11. Deliberately out of scope

- **`session.js` decomposition** (2,606 lines). Worth doing; do it after the migration so the test
  suite validates one change at a time.
- **Per-tenant envelope encryption** with KMS-wrapped keys, and a caller-level export/delete path.
- **Model changes.** Vertex makes future swaps a config edit under the same BAA. Drive that decision
  with the eval harness, not intuition.
- **Retention policy design** beyond bounding it. HIPAA's 6-year retention applies to Security Rule
  *documentation*, not PHI — do not build long transcript retention.
- **`Vetra-desktop`** — an unmodified Tauri scaffold with no application-specific code.

---

## Appendix: what changed since the 2026-07-22 spec

The earlier spec's baseline figures are stale across the board, and three of its conclusions are now
wrong:

| Claim in the July spec | Current reality |
|---|---|
| 480 tests | 1,088 root tests, plus 92 dashboard backend and 17 frontend |
| `services/supabase.js` is 791 lines, ~28 `.from()` of 35 | 1,039 lines, 30 `.from()` of 37, plus 1 `.rpc()` |
| 19 migrations | 22 migrations, `002`–`023` |
| `session.js` is 2,035 lines | 2,606 lines |
| Identity Platform BAA coverage unknown | **Confirmed covered** |
| Context caching retains inputs 24h; must decide the tradeoff | **Caching is not implemented** — only the debug counter is read. No tradeoff exists |
| Firebase Hosting for the SPA | **Not on the covered-products list**; use Cloud Storage + CDN + LB |
| Model is Gemini 2.5 Flash | `gemini-3.6-flash`, GA on Vertex |
| Marketing site treated as separable | It is routes inside the dashboard SPA and cannot be split |
| Tenant vendor routing deferred to a follow-on spec | Folded in as §1, because it is the mechanism that makes one architecture serve both markets |
| `callState` single-instance constraint | Not mentioned at all; it is now the highest technical risk |
| Five PHI leak paths | Two were named (Sentry `toNumber`, Brevo). Calendar sync, unauthenticated endpoints, and tenant webhooks were not |
