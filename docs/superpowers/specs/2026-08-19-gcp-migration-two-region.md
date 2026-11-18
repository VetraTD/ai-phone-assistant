# GCP Migration — Two-Region Compliant Build

**Date:** 2026-08-19 · **Revised:** 2026-08-20 · **Status:** plan, no code written · **Supersedes:** `docs/superpowers/specs/2026-08-02-gcp-migration-architecture.md` on the deployment split, the regulatory scope, and the timeline.

### Revision 2026-08-20 — what changed and why

The architecture, the scope and every verification gate are **unchanged**. Two things changed, both after auditing the actual code rather than estimating from the file sizes:

1. **Durations corrected.** The 2026-08-19 estimates were human-engineer days and were wrong for an agent-driven build. The code audit below shows the port surface is far smaller than line counts implied.
2. **Work re-sorted by dependency, not by phase number.** The old 0→10 ordering grouped work by *system*, which reads well as a document but implies a serial chain that mostly does not exist. Roughly two-thirds of the code needs no GCP project to exist. That work now runs as **Lane A**, starting immediately, in parallel with the owner's Day 1 and with GCP provisioning (**Lane B**).
3. **Entity formation deferred** to first verbal customer commit — owner's decision, 2026-08-20. See "Entity timing" under Part 1.7.
4. **Google Calendar sync is deleted rather than fixed**, after the owner reported it broken in production and the root causes turned out to need a multi-week Google OAuth verification to repair. **Notifications get the opposite treatment** — kept, with a boot-time config assertion and link-only content. See leak paths 1 and 2.
5. **athenahealth split into two filings** — free sandbox signup on Day 1, partner application after Lane C so the security review describes the GCP stack rather than the one being deleted.
6. **A1 re-estimated upward, 1 day → 2.5 days**, after breaking the five leak paths into individually costed items. The original number was optimistic.

Nothing was added to scope, nothing was dropped, and no gate was weakened. See "What the re-sort does not change" at the end of Part 2.

### Code audit findings, 2026-08-20 — evidence behind the new numbers

| Claim | Verified | Consequence |
|---|---|---|
| PostgREST embedded/nested selects in `services/supabase.js` | **Zero** | The one genuinely hard thing to port to raw SQL does not exist |
| PostgREST `.filter()` calls | **Zero** — all 6 `.filter(` hits are `Array.prototype.filter` | No PostgREST filter grammar to translate |
| `.rpc()` calls | **1** — `create_appointment_if_available`, already a PG function | Becomes `SELECT create_appointment_if_available($1,…)` |
| Query verb surface | `eq` ×38, `select` ×20, `update` ×10, `maybeSingle` ×7, `order`/`limit` ×6, `single` ×4, `insert` ×4, plus single-digit `gte/lt/lte/like/ilike/neq/upsert/delete` | Plain-SQL vocabulary. 1,182 lines, small surface |
| Supabase-specific SQL in migrations 002–026 | **Zero.** Every `supabase` hit across `database/*.sql` is a **comment**. No `auth.`, `storage.`, `service_role`, no RLS policies, no Supabase extensions | Migrations run byte-identically on stock PG16 — local **or** Cloud SQL |
| Extension dependencies | `gen_random_uuid()` only — built into Postgres 13+ | No `pgcrypto`/`uuid-ossp` install needed |
| Test files mocking the DB | **12**, in two groups: **6 mock `../services/supabase.js`** (module boundary → byte-identical signatures means a *rename only*), **6 mock `@supabase/supabase-js`** (client boundary → genuinely need rewriting to mock `pg`) | The zero-assertion-edit gate applies to the first group. The second group's rewrites are expected work, not gate violations |
| `lib/callState.js` | **114 lines**, 3 readers outside itself: `server.js:235`, `server.js:394`, `lib/voice/session.js:2716` (plus `lib/mediaStream.js:849`, which is being deleted) | Much smaller refactor than the risk rating implied |
| **All three callState touch points are call boundaries, not per-turn** | `session.js:2716` reads once in the WebSocket `start` handler and holds `state` as a local thereafter; `server.js:235` is `/twilio/voice`; `server.js:394` is `/twilio/status` | **Memorystore adds no per-turn latency.** See "The callState problem" below |
| Dockerfile / docker-compose in repo | **None** | Confirms the 2026-08-19 finding |

---

## Context

Vetra answers phones for small businesses. The committed early customers are **clinics in both the US and the UK**, which puts the product under two separate regulatory regimes at once. Three things force this migration now:

1. **A live compliance defect.** `services/gemini.js:132` calls Gemini through the AI Studio developer endpoint (`new GoogleGenAI({ apiKey })`). That endpoint is covered by **no** Google BAA at any tier. Full transcripts, caller names and DOB pass through it today. There is zero Vertex code anywhere in the repo.
2. **BAA/DPA fees on the current stack.** Supabase ($949) + Railway ($1,000) + Vercel ($370) + Sentry ($80) = **$2,399/mo** to make today's vendors contractable. Google Cloud's BAA is free and self-serve.
3. **No UK data residency exists.** Everything runs in one US region against US vendors. UK patient audio would cross the Atlantic on every turn — a transfer problem and a ~150-200ms-per-hop latency problem on a path whose measured p50 is already 2,607ms.

Current state is favourable: **pre-launch, no live business traffic, no production data to reconcile.** No dual-run, no reconciliation window, no one-way door. Migrating now is far cheaper than migrating later.

---

## Decisions locked in this session

| # | Decision |
|---|---|
| 1 | **Two regional stacks** — US and UK. Forced by data residency and by voice latency, not by preference. |
| 2 | **US stack runs the HIPAA-compliant configuration for every US tenant initially.** A separate `us-standard` lane with ElevenLabs gets added when a non-healthcare US customer justifies it — a third tfvars file, not a refactor. |
| 3 | **UK stack keeps Deepgram + ElevenLabs.** GDPR permits any processor under an Art. 28 DPA; there is no HIPAA-style "covered products" restriction. Deepgram's EU endpoint went GA 2026-01-10. |
| 4 | **BAA-lane STT is Google STT v2.** Zero third-party AI BAAs to negotiate. Costs ~300-700ms versus Deepgram; reversible behind the existing `lib/voice/sttStream.js` seam. |
| 5 | **Cloud Identity Free on `vetratd.com`.** TXT-record verification only — MX records untouched, Microsoft 365 email unaffected. Owner has registrar admin. |
| 6 | **Tenant isolation: RLS + application scoping, both enforced.** Cross-tenant negative tests written *before* the data-layer rewrite. |
| 7 | **Everything moves to GCP; Railway, Supabase, Vercel and Sentry are retired** after a one-week warm hold. |
| 8 | **The whole SPA moves** (marketing + dashboard together — they are one app and cannot be split). |
| 9 | **Blind TTS A/B runs before cutover.** `scripts/voice-ab.js` exists and has never been listened to. |
| 10 | *(2026-08-20)* **Work runs in two parallel lanes, not one serial phase chain.** Lane A is application code with no GCP dependency and starts immediately; Lane B is GCP provisioning and starts on the owner's Day 1. They converge into a single verification pass that keeps every original gate. |
| 11 | *(2026-08-20)* **The five PHI leak paths are fixed first, before any migration work.** They are live defects on `dev` today, they need no GCP, and they are the compliance floor. If everything else slips, the worst exposures are already closed. |
| 12 | *(2026-08-20)* **LLC formation deferred to first verbal customer commit.** The first clinic is the owner's parent's practice. Nothing in the migration or the compliance build requires an entity — only the clinic BAA signature, insurance binding and the athenahealth application do, and all three sit at the end. |
| 13 | *(2026-08-20)* **Google Calendar sync is DELETED, not fixed.** It is the worst PHI leak, it is broken in production, and repairing it needs multi-week Google OAuth verification for a sensitive scope. Deleting is faster than fixing and strictly better for compliance. **Notifications are the opposite call — kept, with the config and content fixed.** |
| 14 | *(2026-08-20)* **athenahealth is split into two filings.** The free developer/sandbox signup happens on Day 1 (no entity, no cost). The **partner application waits until after Lane C**, so the security review describes the GCP stack rather than the Railway/Supabase stack being deleted. |

### Deliberately open, resolve in Lane B1

- Twilio Security Edition price (unpriced, sales-gated — the only unpriced line in the stack)
- Whether `gemini-3.6-flash` is served by the Vertex **EU multi-region** endpoint
- Identity Platform data-location behaviour when serving both stacks
- Whether a UK Art. 27 representative or a UK subsidiary is the right structure (solicitor question)

---

## Regulatory scope — what actually applies

Being explicit here prevents both under-building and weeks wasted on regimes that do not apply.

| Regime | Applies? | Why |
|---|---|---|
| **HIPAA** | **Yes — US clinics only** | You become a Business Associate of a US covered entity on the first live call. Applies regardless of where you sit. |
| **UK GDPR + DPA 2018** | **Yes — UK clinics, and plausibly all processing** | Art. 3(2) targeting test settles it: serving UK clinics means UK data subjects. A UK co-founder may additionally trigger Art. 3(1) establishment. |
| **EU GDPR** | Only if EU (non-UK) customers appear | Not yet. Same controls satisfy it if they do. |
| **Call-recording consent (CIPA-style)** | **Yes — high near-term risk, US** | Streaming live audio to a third-party STT may be interception under all-party-consent statutes. "We don't store audio" likely does not exempt it. |
| **UK recording law** | Yes | Notification + lawful basis + an Art. 9(2)(h) condition for health data. |
| **TCPA** | Yes — US SMS | $500-$1,500 per message, no statutory cap. `sendCallerSms` is live. |
| **CA AB 3030** | Yes if CA clinics | Administrative topics exempt; attaches the moment the agent discusses clinical information. Keep the agent on scheduling/intake/routing. |
| **42 CFR Part 2** | Only if a clinic does substance-use treatment | Stricter than HIPAA. **Ask each US clinic.** |
| **NHS DSPT** | Only if a UK clinic is NHS-linked | Ask each UK clinic. |
| **SOC 2** | Not required | Will get asked for eventually. Not now. |

**The regimes cost in different places.** HIPAA restricts *which vendors may exist*. GDPR permits any vendor under a DPA but demands **data-subject rights (export + erasure), a DPIA, Art. 30 records, ICO registration, and 72-hour breach notice** — of which the DSR export/delete path is genuine new engineering the 2026-08-02 spec explicitly placed out of scope.

---

## Target architecture

```
        US callers                                    UK callers
            │                                              │
  Twilio US acct  (Security Edition, BAA)      Twilio UK acct (standard, DPA)
  media edge: us1                              media edge: ie1
            │  WSS + signed webhooks                       │
            ▼                                              ▼
 ┌──────────────────────────────┐          ┌──────────────────────────────┐
 │ Cloud Run: voice-us          │          │ Cloud Run: voice-uk          │
 │ us-central1                  │          │ europe-west2 (London)        │
 │ DEPLOYMENT_MODE=hipaa        │          │ DEPLOYMENT_MODE=gdpr         │
 │ min-inst=1 · CPU always      │          │ min-inst=1 · CPU always      │
 │ timeout=3600 · conc 10-20    │          │ timeout=3600 · conc 10-20    │
 │ NO 11Labs/Deepgram secret    │          │ full vendor set              │
 └──┬────────┬─────────┬────────┘          └──┬────────┬─────────┬────────┘
    │        │         │                      │        │         │
 Google   Vertex    Chirp3-HD             Deepgram  Vertex    11Labs
 STT v2   (US)      /Gemini TTS           EU endpt  (EU multi- Flash
                                                     region)
    │        │         │                      │        │         │
    └────────┴─────────┴──► Cloud SQL 16 ◄────┴────────┴─────────┘
              (us-central1)        (europe-west2)
        private IP · CMEK · PITR · RLS · audit logging
                        │                      │
         Memorystore (shared call facts) ──────┘
                        │
 ┌────────────────────────────────────────────────────────────────┐
 │ SHARED CONTROL PLANE                                           │
 │  Cloud Run: dashboard-api ×2 (one per region, scale-to-zero)   │
 │  Identity Platform — one project, per-region tenants           │
 │  Cloud Storage + Cloud CDN + HTTPS LB : one SPA bundle         │
 │      (region claim on the user record picks the API base)      │
 │  Secret Manager ×2 sets · Cloud KMS · Cloud Scheduler          │
 │  Cloud Logging · Monitoring · Error Reporting · Audit Logs     │
 │  Artifact Registry · Cloud Build — ONE image, ONE test suite   │
 │  Terraform: one root module, applied per stack with tfvars     │
 └────────────────────────────────────────────────────────────────┘
                        │
                 athenahealth (v2 only — separate BAA, weeks-to-months)
```

### Why the split is where it is

- **Regional split is non-negotiable.** UK health data in `us-central1` is a transfer problem, and transatlantic hops add ~150-200ms per leg to a turn that already measures 2,607ms p50.
- **Within the US, the Cloud Run service is the credential boundary.** Secrets mount per-service and identity is a per-service service account; there is no smaller unit. `voice-us` simply holds no ElevenLabs key, so a misconfiguration produces voicemail rather than a reportable disclosure.
- **The control plane is shared** because staff credentials, the static bundle, the Terraform module, the pipeline and the test suite carry no patient data and gain nothing from duplication.

### Service mapping

| Today | Target | Nature of change |
|---|---|---|
| Supabase Postgres | **Cloud SQL PG16** ×2 — private IP, CMEK, PITR | Same engine. `pg_dump`/`pg_restore`. No Supabase-specific SQL exists to translate. |
| `@supabase/supabase-js` (`services/supabase.js`, 1,182 lines, 30 `.from()` + 1 `.rpc()`) | **`pg` Pool** in `services/db.js` | Internals rewritten; **every exported signature byte-identical**. |
| Supabase Auth (13 call sites, 7 files) | **Identity Platform** | bcrypt hash import via Firebase Admin `importUsers`. |
| Railway | **Cloud Run** ×4 (voice ×2, dashboard-api ×2) | Four settings must be right (see B4). |
| Vercel | **Cloud Storage + Cloud CDN + HTTPS LB** | Cloud Storage is on the covered-products list; Firebase Hosting is not. |
| Sentry | **Cloud Error Reporting** | Weaker UI, free, in-scope. PHI tags removed at the same time. |
| `.env` (95 `process.env` names in code, 81 documented) | **Secret Manager**, IAM-scoped | Reconcile the 14-name drift first. |
| Gemini via AI Studio key | **Vertex AI** via ADC | Client-init change. Region differs per stack. |
| Brevo + Gmail SMTP | **Kept, PHI removed from bodies** | Link-only notifications take email out of scope entirely. Plus a boot-time config assertion — both send paths currently fail silently. |
| `setInterval` calendar worker | **DELETED** *(changed 2026-08-20)* | Was “Cloud Scheduler → HTTP endpoint”. The feature is being removed, so no Scheduler job is needed for it. Cloud Scheduler remains provisioned for future background jobs. |
| Hand-applied SQL, 25 files (002-026) | **`node-pg-migrate`** + `schema_migrations` | Existing files imported as-is. |
| No CI, no Dockerfile, no IaC | **Cloud Build + Artifact Registry + Terraform** | None of these exist today. Confirmed by unbounded `find`. |

---

## Part 1 — What the owner sets up, before any code

Ordered by lead time. Items 1-3 unblock everything; 4-8 run in parallel and are the real schedule risk.

### 1. Google identity and the GCP org — Day 1, ~1 hour

1. Go to the Cloud Identity **Free** signup (not Workspace, not a personal Gmail). Free tier, up to 50 users.
2. Enter `vetratd.com`. Choose **TXT-record verification**. **Do not accept any prompt to change MX records** — Microsoft 365 keeps all email. A TXT record coexists with M365's own `MS=` TXT and its MX records; nothing about mail flow changes.
3. Add the TXT record at the registrar. Verification usually completes in minutes.
4. **Watch for conflicting accounts.** If anyone ever created a "personal Google account" with an `@vetratd.com` address (Analytics, Search Console, a YouTube login), Google forces a conflicting-account resolution during setup. Use the Transfer Tool or rename those accounts.
5. Creating Cloud Identity for the domain automatically creates a **GCP Organization node**. That node is what makes org policies, resource-location constraints and centralized ownership possible — a personal Gmail gets none of it.
6. Create a Cloud Billing account. Use a business card if one exists.

Sign in as an `@vetratd.com` identity from here on. Mail still lands in Microsoft 365 — the Google identity is sign-in only.

### 2. Accept the agreements — Day 1, ~15 minutes

- **Google Cloud BAA** — self-serve, free, accepted in the Console. Requires the org + billing account from step 1. Covers Google Cloud's entire infrastructure across all regions and network paths, but **only for products on the covered-products list**. The BAA obliges you to not use non-covered products with PHI.
- **Google Cloud Data Processing Addendum** — the GDPR-side agreement. Also free and self-serve.

Screenshot both acceptance records with acceptor and timestamp. They are evidence for the risk analysis and for the clinics' diligence.

### 3. Projects and org policy — Day 1, automatable after the org exists

Six projects: `vetra-us-prod`, `vetra-us-staging`, `vetra-uk-prod`, `vetra-uk-staging`, `vetra-shared` (Identity Platform, Artifact Registry, Cloud Build), `vetra-logging` (log sink). Terraform creates all of them; the owner only needs to have created the org and billing account.

Org policies to set at the org node: disable service-account key creation, restrict resource locations per project, require Shielded VMs, disable default network creation.

### 4. Twilio — Day 1, **longest lead time, start first**

- **US account:** request a **Security Edition** quote and a HIPAA BAA. Editions are account-level and sales-gated with no published price. This is the single unpriced line in the stack. Ask specifically whether the Edition is a flat platform fee or a per-minute uplift — the answer changes the economics of ever adding a `us-standard` lane.
- **UK account:** a separate Twilio account for UK numbers. Standard terms plus Twilio's **DPA** (free, standard). No Edition needed — Security Edition is a HIPAA product.
- Set the **media edge region** explicitly on each account: `us1` for the US stack, `ie1` for the UK stack. Media Streams default to US1 regardless of where the number lives.
- Get a **Telnyx quote too**, purely as negotiating leverage. Telnyx is *not* a viable primary carrier — bidirectional media streaming is absent from their HIPAA-eligible list and they had multi-hour voice outages in Dec 2025 and Feb 2026.

### 5. Vertex AI data handling — Day 1, has approval lead time

Two independent paths to zero prompt retention; **start both**, keep whichever lands first:

- File the **abuse-monitoring / prompt-logging exception** form. Without it, prompts flagged by safety classifiers can be retained up to 30 days for abuse review.
- Set up **invoiced billing**, which achieves the same outcome without an approval queue but requires Google credit approval.

### 6. Vendor DPAs for the UK stack — Day 1-2, low friction

Deepgram (plus EU-endpoint access at `api.eu.deepgram.com`), ElevenLabs, Twilio, Google. All standard, all free, all self-serve or a short email. Record every one in the sub-processor register.

### 7. Legal and corporate — parallel track, starts Day 1

- **Form the US entity — deferred to first verbal commit (decided 2026-08-20).** ~$300 and 1-5 business days in most states (California is slower and carries an $800/yr minimum franchise tax). It does not block the build, but it *does* block the clinic contracts: sign a BAA personally and you personally are the Business Associate, with HIPAA civil penalties tiering to ~$2.1M/yr, criminal exposure for knowing wrongful disclosure, and no corporate veil between that and personal assets.

  **Entity timing.** The first clinic is the owner's parent's practice. Family relationship changes nothing legally — HIPAA does not care, and a covered entity that discloses PHI to a business associate without a BAA in place is itself in violation. What the relationship *does* change is the odds of being sued by the client; it does nothing about OCR enforcement, state AG action, or breach-notification cost.

  **The hard line:** no real patient call goes through the system until the LLC exists, the clinic BAA is signed, and cyber liability is bound. Those three are one gate, not three. Everything before that gate runs on synthetic data and the owner's own phone — which is already how the plan is built (pre-launch, no production data).

  **File the LLC the moment the clinic verbally commits**, not after go-live. Formation is days, but only if it starts.

  What actually needs the entity, and when: clinic BAA signature (day before go-live) · cyber liability insurance (sole-prop cyber policies exist but price and limits are worse) · Twilio US Security Edition (sales may want business details — ask during the quote, do not assume) · Vertex invoiced billing (Google credit approval likely wants a business — fall back to the abuse-monitoring exception form, which does not) · athenahealth **partner** application (the free developer/sandbox tier needs none of this — sign up Day 1).

  What does **not** need it: all six GCP projects, the Google BAA and DPA (self-serve, accept as an individual, re-accept as the LLC later), Twilio UK + DPA, every vendor DPA, ICO registration (sole-trader tier), every compliance document, and 100% of the engineering.

  **Handover gotchas.** Google's payments-profile type (individual vs business) **cannot be changed after creation** — expect to create a new billing account with a business profile and relink the six projects (one Terraform edit). The BAA is per-organization, not per-billing-account, so it survives the swap; re-accept as the LLC anyway so the counterparty name is right, and screenshot again. Pre-formation contracts do not auto-transfer — the LLC must adopt them and the signer stays liable absent a novation. Note that `POST /api/businesses/:id/phone-numbers/buy` is currently unauthenticated and spends money on the personal Twilio account until Lane A closes it.
- **UK structure** — Art. 27 representative or a UK subsidiary, given a UK co-founder and UK customers. Solicitor question, not an engineering one.
- **ICO registration** (data protection fee, small-org tier).
- **Cyber liability insurance**, bound before the first clinic call. Requires the entity.
- **athenahealth — split into two filings** *(changed 2026-08-20)*.
  - **Day 1: the free developer / sandbox signup.** No entity, no cost, no commitment. Gets the API docs and a sandbox to build against.
  - **After Lane C: the formal partner application.** Their review asks you to describe your infrastructure and security posture. Filing today would submit a posture built on Railway + Supabase + Vercel, with an AI endpoint under no BAA and five open PHI leak paths — a system being deleted within two weeks. Filing after Lane C describes the GCP stack, the signed BAA, CMEK, private IP, audit logging and access control. The delay is ~2-3 weeks; a weak first submission costs more than that in re-review.
  - **Ask before either: what does the first clinic actually use?** If the practice runs on eClinicalWorks, Practice Fusion, DrChrono, Tebra, Epic — or a paper book — then athenahealth is the wrong integration and the partner program is months spent on something customer #1 does not need. One-sentence answer; ask it on Day 1.

### 8. Compliance paperwork — parallel track, ~2-3 weeks non-engineering

DIY from templates; no compliance platform. Claude drafts all of these, owner reviews and adopts:

HHS SRA Tool risk analysis (free) · **DPIA** (mandatory for large-scale special-category processing) · Art. 30 Records of Processing · policy set · incident response plan · contingency plan · workforce training records · downstream sub-processor register · retention schedule.

---

## Part 2 — Two lanes, and who does what

*Restructured 2026-08-20.* Automation split is explicit. "Claude" means fully automatable from this repo; "Owner" means it needs a card, a signature, a phone, or a pair of ears.

The old 0→10 phase numbering grouped work by system. It read as a dependency chain and mostly is not one. The single question that reorders it: **does this need a GCP project to exist?** For roughly two-thirds of the code, no.

Three lanes. **A and B run concurrently.** C is a single verification pass where they converge.

### Lane A — application code · no GCP dependency · starts immediately

Runs against local Postgres 16 and a local Redis. The root test suite is the gate at every step.

**Sequence matters here.** A0 is first because a latency baseline captured after the first change is worthless. A1.x is second because those are **live defects on `dev` today**, not migration work — if everything downstream slipped a month, the worst exposures would already be closed. Within A1, deletion (A1.1) comes before the fixes, because removing a leak path is faster and carries no risk of a subtle bug. A5 depends on A3. Everything else is order-insensitive.

| # | Work | Old phase | Days | Gate |
|---|---|---|---|---|
| **A0** | **Latency + eval baseline, before anything is touched.** `GET /api/debug/latency`, probe harness, `npm run eval` ×2 | 1 | 0.25 | Baseline recorded. **Check ElevenLabs quota first** — one probe run costs ~15k characters. **Do not push while a probe runs** — a push is a deploy is a restart |
| **A1.1** | **DELETE Google Calendar sync** *(decision 2026-08-20 — was "fix", now "remove")*. Drop the sync worker (`AI-phone-dashboard/backend/src/server.js:170-200`), the write path and manual route (`routes/calendar.js`), the OAuth flow, and `services/calendarSync.js` (172 lines). **Keep** the `calendar_connections` table and migration 021's `google_event_id` columns — dropping columns is riskier than leaving them unused | 8 | 0.25 | No code path can write to a Google Calendar. Dashboard shows no dead calendar UI |
| **A1.2** | **Notifications — config assertion.** `sendEmail` (`:111`) and `sendSms` (`:131`) **silently `return`** when unconfigured: no log, no error, no warning. Add a boot-time assertion that fails loudly when notifications are enabled but SMTP / `TWILIO_SMS_FROM` are missing | 8 | 0.25 | Server refuses to boot silent-broken. A missing credential is impossible to ship unnoticed |
| **A1.3** | **Notifications — link-only content.** Formatters at `:173-237` and subjects at `:256`/`:297` carry name, phone, notes, times and **full call summaries**. Replace with "You have a new appointment — view it in your dashboard" + deep link. Same for the Brevo digest at `AI-phone-dashboard/backend/src/routes/appointments.js:101-159` | 8 | 0.5 | No PHI in any body or subject. **Email leaves HIPAA scope entirely — no Brevo BAA needed, ever** |
| **A1.4** | **Error-tracker allowlist** at the `captureException` boundary. `lib/sentry.js:21-23` promotes every context key to a tag, unfiltered; `notifications.js:364` sends the caller's own phone number | 8 | 0.25 | No PHI-typed field reaches the error tracker, before or after the Error Reporting swap |
| **A1.5** | **Close the two open endpoint groups.** `GET|PUT /api/businesses/:id/notifications` (`server.js:550-590`) and `GET|POST /api/businesses/:id/phone-numbers/{available,buy}` (`:596`, `:622`). **`buy` spends real money on the Twilio account** | 8 | 0.5 | Regression tests in the shape of `tests/callersRoute.test.js`. Unauthenticated request returns 401, never data and never a purchase |
| **A1.6** | **Block tenant webhooks in `hipaa` mode** unless a downstream BAA is recorded. `integrations/webhook.js:89-96` POSTs `caller_phone` plus **raw LLM tool-call arguments** to any tenant URL | 8 | 0.25 | `hipaa` mode cannot dispatch a webhook without a recorded BAA |
| **A1.7** | **Log scrubbing.** `lib/logger.js` `emit()` at `:63-79` spreads fields verbatim to stdout; caller phones reach logs at `lib/voice/session.js:2714` and `server.js:327` | 8 | 0.5 | CI check fails the build when a PHI-typed field can reach a logger or error tracker |
| **A2** | Local PG16 + `node-pg-migrate` + `schema_migrations`, import 002-026 as-is. Fix the stale `schema.sql:7,16` header still claiming "002 through 018". **Cross-tenant negative tests written first** | 2 | 0.75 | Negative tests demonstrably **FAIL** against the current service-key client. A passing negative test is testing nothing |
| **A3** | `services/supabase.js` → `services/db.js` on `pg`. 33 exports, **signatures byte-identical**. 4 `scripts/` call sites, 6 client-boundary test files rewritten to mock `pg`, dashboard backend connection string | 3 | 2-3 | **Root suite green with ZERO assertion edits** in the 6 module-boundary mocks. Any edited assertion there is a defect. The 6 client-boundary rewrites are expected work |
| **A4** | `callState` → store interface + in-memory adapter. **Multi-process local test**: two node processes against one shared store, reproducing the three-instances scenario | 5 | 0.75 | Status handler on a *different* process produces the summary, fires the missed-call notification, and tags spam correctly |
| **A5** | GDPR DSR caller-level export + erasure endpoints, plus the admin path (depends on A3) | 8 | 1 | Export returns every PHI-bearing row for a caller; erasure leaves none |
| **A6** | `DEPLOYMENT_MODE` guard module, `businesses.compliance_tier`, boot-time credential assertion, per-call tripwire, mode-aware TTS fail-closed | 7 | 0.75 | Env-fixture tests prove `hipaa` mode cannot construct a non-covered vendor client, **including with the circuit breaker open** |
| **A7** | Dockerfiles ×2 — root is ESM, dashboard backend is CommonJS. Local `docker build` + `docker run` | 5 | 0.5 | Both images boot and serve locally |
| **A8** | Vertex client change: `services/gemini.js:132` → `{ vertexai: true, project, location }` + ADC. Port `services/geminiCache.js` explicit caching — `cachedContent` is **mutually exclusive with `systemInstruction` and `tools`** | 1 | 0.5 | **Code only. Cannot be verified without GCP — gated in Lane C1** |
| **A9** | Merge `origin/main` (the friend's website overhaul; local `dev` is 4 commits behind). CORS allow-lists at `server.js:91-99` and dashboard `:27-39`, drop the `VERCEL_URL` fallback. Self-host Google Fonts | 6 | 0.5 | Suite green after merge; no external font request in the built bundle |
| **A10** | Delete `lib/mediaStream.js` (1,079 lines) and the `PIPELINE_V2` hatch | 5 | 0.25 | Suite green |

**Lane A total: 8-10 days.** A3 carries the variance — see Risks.

*Estimate correction 2026-08-20:* A1 was originally priced at **1 day** for all five leak paths plus log scrubbing. Broken out honestly it is **2.5 days** — the original number was too optimistic, and saying so is cheaper than discovering it mid-build. Deleting calendar sync rather than fixing it claws back part of that. Note **A1.5** carries a hidden design decision: the root server has **no auth scheme at all**, so closing those two endpoint groups means wiring in verification of the dashboard's existing token, not just adding a guard.

### Lane B — GCP · gated on Owner Day 1 · overlaps Lane A

| # | Work | Old phase | Days | Gate |
|---|---|---|---|---|
| **B0** | Terraform root module: 6 projects, APIs, IAM, service accounts, VPC, org policies, Artifact Registry, Cloud Build. **Writing needs no GCP — start during Lane A.** Applying needs Day 1 | 0 | 1 write + 0.5 apply | `terraform plan` applies clean to both staging stacks |
| **B1** | **Run first, the moment projects exist.** ① Verify `gemini-3.6-flash` on the Vertex **EU multi-region** endpoint ② Supabase→Firebase **bcrypt import spike** against a real export | 0 | 0.5 | Model responds, or the UK model choice changes here rather than in week 4. Hashes import without forced resets, or the fallback is confirmed acceptable |
| **B2** | Cloud SQL PG16 ×2 and Memorystore ×2 — private IP, CMEK, PITR. Swap A4's in-memory adapter for the Memorystore adapter | 2 / 5 | 0.5 | Schema diffed against Supabase, identical, both regions |
| **B3** | Identity Platform, one project, per-region tenants. `importUsers` with bcrypt. Convert 13 call sites across 7 files; delete `supabaseClient.js` | 4 | 1 | Staff log in with existing passwords; reset flow end to end |
| **B4** | Cloud Run ×4 with the four required settings (`min-instances=1`, CPU always allocated, `timeout=3600`, concurrency 10-20). Secret Manager ×2 sets **with rotation**. Cloud Scheduler provisioned | 5 / 6 / 10 | 1 | Services boot. **Note:** the `setInterval` calendar worker this was originally sized to replace is **deleted in A1.1**, so Scheduler has no job to run at cutover — it is provisioned for future background work, and the "a scale-to-zero instance kills the timer" hazard now applies to nothing. Any *new* background job must use Scheduler, never `setInterval` |
| **B5** | SPA → Cloud Storage + Cloud CDN + HTTPS LB. Port the `vercel.json` rewrite to an LB URL map | 6 | 0.5 | Dashboard loads, authenticates, reads and writes in both regions |

**Lane B total: 4-5 days**, most of it overlapping Lane A.

### Lane C — convergence verification · **needs the Owner**

This is the serialization point. No amount of speed in A or B moves it.

| # | Verification | Needs |
|---|---|---|
| **C1** | **Vertex live.** `npm run eval` ×2 per mode, compare aggregates via `npm run eval:compare`. Budget ~10 runs; the suite is noisier than a ±2-verdict effect | Real money, wall-clock |
| **C2** | **Live call per region** against a dev Twilio number, before production webhooks move | Owner's phone |
| **C3** | **≥5 concurrent calls per region.** The callState proof. Watch audio-pump starvation and event-loop lag. Never certify from a single call | Owner + deployed Cloud Run |
| **C4** | **Latency vs the A0 baseline.** Vertex, Cloud SQL round-trips and VPC hops all sit on the critical path | Deployed stack |
| **C5** | **Blind TTS A/B at 8kHz mulaw over a handset.** `scripts/voice-ab.js` exists and has never been listened to | **Owner's ears** |
| **C6** | **Deployment isolation.** `voice-us` configuration asserted to hold no non-covered vendor credential, *including* the circuit-breaker-open case, which must reach voicemail | Deployed stack |
| **C7** | **Restore test.** Restore a backup into a scratch instance, verify integrity. Required evidence for §164.308(a)(7). Once, documented | Deployed stack |
| **C8** | **Cross-tenant isolation** at both the application and RLS layers. RLS + `SET LOCAL app.business_id`. PHI-access audit logging (§164.312(b), Required) | Deployed stack |
| **C9** | `npm run sim:cutoff` after any turn-taking-adjacent change. Any sim number quoted between 2026-08-04 and 2026-08-05 measured the greeting guard, not turn-taking | — |

**Lane C total: 2-3 days.**

### Lane D — cutover · Owner + Claude · 1-2 days

Secrets → Secret Manager with rotation (**`BREVO_API_KEY` and the Google OAuth client secret must be assumed compromised** — an axios error-logging bug leaked them; reconcile the 14-name drift first: 95 `process.env` names in code, 81 documented). `pg_dump`/`pg_restore` per region. Repoint Twilio webhooks. Live call end to end per region; row counts match per table. **Warm hold one week** with Railway intact, then cancel Railway, Supabase, Vercel, Sentry.

### What the re-sort does *not* change

Stated explicitly because the re-sort was accepted on the condition that it sacrifices neither compliance nor performance:

- **Every gate from the 2026-08-19 plan survives, unweakened.** Zero-assertion-edit contract, live call per region, ≥5 concurrent calls, deployment isolation with the breaker open, restore test, cross-tenant tests at both layers, latency vs baseline, eval at or above current. Nothing was traded for speed.
- **The compliance floor moves *earlier*, not later.** The five PHI leak paths are A1 — first, ahead of all migration work — instead of phase 8. They are live defects today.
- **The performance guardrail moves earlier too.** The latency baseline is A0, captured before the first line changes. Without it every later comparison is meaningless.
- **The cheap unknowns still resolve first.** The EU model check and the bcrypt spike are B1, run the moment projects exist — not discovered in week 4.
- **Architecture, regulatory scope and vendor decisions are untouched.**

**What the re-sort *does* cost:** Lane A accumulates code that meets real infrastructure only at Lane C, so bisect is slightly worse than gating each phase in sequence. The test suite runs continuously, so this work is not unverified — it is unverified *against real infrastructure*, which is the narrower claim. Two items genuinely cannot be verified before convergence and are called out as such: **A8 (Vertex)**, which needs a project and ADC to execute at all, and **A4 (callState)**, whose whole purpose is surviving multi-instance Cloud Run. A4's multi-process local test is the mitigation — it makes C3 a confirmation rather than a discovery.

### The `callState` problem — real, confirmed, and smaller than first rated

`lib/callState.js:2` holds per-call state in an in-process `Map`, with a module-level TTL sweeper at `:100-107`. The 2026-08-02 spec assumed `POST /twilio/status` read nothing from it. **That is false.** `server.js:395-400` reads:

| Field | Consequence on a cold instance |
|---|---|
| `state.dbCallId` | Gates the whole summary block at `:451` — **no call summary is generated at all** |
| `state.businessId` | Gates the missed-call notification at `:419` |
| `state.sawCallerFinal` | **Legitimate short calls get mis-tagged as spam** (`:470-474`) |

On multi-instance Cloud Run, `POST /twilio/voice`, the WebSocket upgrade and `POST /twilio/status` are three requests that can land on three instances. This is a **correctness bug, not a degradation**, and it is not optional to fix.

Fix: move the shared *facts* (`businessId`, `dbCallId`, `callerPhone`, outcome flags, transcript sequence) to **Memorystore** — HIPAA-covered. The live session object stays in process; it holds sockets and must not be serialized.

**Update 2026-08-20 — smaller than feared, and free of latency cost.** The reader audit resolves both open worries:

- **Surface is small.** 114 lines, three readers outside the module: `server.js:235` (`/twilio/voice`), `server.js:394` (`/twilio/status`), `lib/voice/session.js:2716` (WebSocket `start`). `lib/mediaStream.js:849` is the fourth and that file is being deleted anyway.
- **No per-turn read exists.** All three touch points are **call boundaries**. `session.js:2716` reads once inside the `start` handler and holds `state` as a local variable for the rest of the call, mutating it in process. **Memorystore therefore adds nothing to the per-turn hot path** — which matters on a turn already measured at ~3,062ms p50.
- **Design constraint, stated so it is not violated later:** read once at `start`, write at call boundaries, **never per-turn**. A per-turn Redis round trip would be a latency regression on the critical path. The one boundary read that *is* latency-sensitive is `session.js:2716`, which sits on the pickup path before the caller hears the greeting — same-region Memorystore is ~1ms there, negligible against the Supabase round trip the existing code already went out of its way to remove.
- **The pickup path already degrades gracefully.** `session.js:2732` carries a comment anticipating multi-instance operation and re-queries the business when the handoff cannot carry. The **status handler is where it is a hard correctness bug** — that is the one with no fallback.
- **Verification is split.** `A4` writes the store interface with an in-memory adapter and a **multi-process local test** (two node processes, one shared store, reproducing the three-instances scenario). `B2` swaps in the Memorystore adapter. `C3` (≥5 concurrent calls per region) is then a *confirmation*, not a discovery — which is the whole point of doing it in that order.

### The five PHI leak paths — current status verified on `dev`

1. **Google Calendar sync** — **RESOLUTION CHANGED 2026-08-20: delete, do not fix.** `calendarSync.js:90` writes `summary: "Vetra: {client_name}"`; `:79-85` adds `Phone:`, `Notes:`, `Call ID:` into a business owner's **personal** Google Calendar, which carries no BAA and cannot be given one.

   **Owner reported it does not work in production. Root causes found:**
   - The worker calls **`clearInterval(handle)` and permanently self-disables** when migration 021's columns are absent (`AI-phone-dashboard/backend/src/server.js:186-190`). It never retries — dead until process restart.
   - The requested scope is **`calendar.events`**, which Google classifies as **sensitive**. An OAuth consent screen still in **Testing** status — the near-certain state, since publishing was never done — **expires every refresh token after 7 days.** Works for a week, then dies silently forever. This matches the reported symptom exactly.
   - On refresh failure the error is caught, logged to a console nobody reads (`:156-158`), and **retried every 90 seconds indefinitely**. The business owner is never told the calendar disconnected.

   **Why deletion beats fixing:** repairing it properly requires **Google OAuth app verification** for a sensitive scope — a multi-week external review that appears in no version of this plan. Meanwhile the feature is low-value for the actual market: a clinic runs on its practice-management system, not the owner's personal Google Calendar. Deleting is *faster* than fixing and strictly better for compliance. See "Deliberately out of scope" for the rebuild conditions.

   **Two 30-second checks that confirm the diagnosis** (inferred, not verifiable from the repo): Google Cloud Console → APIs & Services → OAuth consent screen → Testing or In production? And: is migration 021 applied on prod?

2. **Notifications** — still present, **keep the feature, fix config and content.** Two distinct defects:
   - **Silent failure (why it looks broken).** `sendEmail` at `:111` opens `if (!mailTransport) return;` and `sendSms` at `:131` opens `if (!twilioClient || !TWILIO_SMS_FROM) return;`. When unconfigured they do **nothing, with no log, no error and no warning**. A missing production credential is indistinguishable from a working system. Fix: boot-time assertion, A1.2.
   - **PHI in content (the compliance defect).** Formatters at `:173-237` carry name, phone, notes, appointment time and **full call summaries**; subject lines at `:256` and `:297` carry PHI too. Brevo digest still live at `AI-phone-dashboard/backend/src/routes/appointments.js:101-159`.

   Fix the **content**, not the vendor — link-only notifications remove email from scope entirely, so **no Brevo BAA is ever required.** Do not delete this feature: it is how an owner learns a call happened, and it already carries tests (`tests/notifications.gate.test.js`, `tests/notifications.sms.test.js`).
3. **Error-tracker PHI** — still present. `lib/sentry.js:21-23` promotes every context key to a tag, unfiltered. `notifications.js:364` sends `toNumber` — the caller's own phone number. Moving to Error Reporting does not fix this; add an allowlist at the `captureException` boundary.
4. **Unauthenticated endpoints** — **partially fixed.** `GET /api/businesses/:id/callers/:phone` is gone (tombstoned at `server.js:505-523`, regression test at `tests/callersRoute.test.js`). **Still open:** `GET|PUT /api/businesses/:id/notifications` (`server.js:550-590`) and `GET|POST /api/businesses/:id/phone-numbers/{available,buy}` (`:596`, `:622`) — same UUID-as-bearer-token hole, and **`buy` spends money on the Twilio account**. The root server has no auth scheme at all.
5. **Tenant webhooks** — still present. `integrations/webhook.js:89-96` POSTs `caller_phone` plus **the raw LLM tool-call arguments** — name, notes, symptoms, whatever the model collected — to any tenant-configured HTTPS URL. Only guard is SSRF blocking. Block in `hipaa` mode unless a downstream BAA is recorded.

**Log scrubbing rides along.** `lib/logger.js` has no allowlist and no scrubbing — `emit()` at `:63-79` spreads fields verbatim to stdout. Caller phone numbers still reach logs at `lib/voice/session.js:2714`, `server.js:327`, and `lib/mediaStream.js:846`. On Cloud Logging these persist.

### New work GDPR adds that the old spec excluded

- **Data-subject rights**: caller-level export and erasure endpoints, plus an admin path to service a request within one month.
- **DPIA** covering both stacks.
- **Sub-processor register** with a change-notification obligation to clinics.
- **Bounded retention, enforced** — not merely documented. Note that HIPAA's six-year retention applies to Security Rule *documentation*, not PHI; do not build long transcript retention.
- **72-hour ICO breach notification** runbook.

---

## Part 3 — Timeline

*Revised 2026-08-20.* The 2026-08-19 version said "4 weeks of engineering." That number folded three different clocks into one column: writing speed, cloud provisioning wall-clock, and owner availability. Separated, the picture changes.

| Day | Lane A — app code (no GCP) | Lane B — GCP | Owner |
|---|---|---|---|
| **1** | **A0** baseline · **A1.1** delete calendar sync · **A1.2-A1.3** notifications config + link-only content | **B0** write Terraform (no GCP needed to write) | **Day 1 list:** Cloud Identity, BAA + DPA, billing · Twilio US quote + UK account · Vertex exception form · vendor DPAs · **athena sandbox signup** · **ask the clinic the three questions** |
| **2-3** | **A1.4-A1.7** error tracker, open endpoints, webhooks, log scrubbing · **A2** local PG + migrations + negative tests | **B0** cont. | Twilio conversations open · two 30-second prod checks on the calendar-sync root cause |
| **4-6** | **A3** data-layer rewrite — the biggest single block | **B0** apply → **B1** EU model check + bcrypt spike (**run first**) · **B2** Cloud SQL + Memorystore | Solicitor on UK structure · ICO registration · insurance quotes |
| **7-8** | **A4** callState + multi-process test · **A5** DSR · **A6** mode guard | **B3** Identity Platform + auth call sites | Compliance drafts reviewed |
| **9-10** | **A7** Dockerfiles · **A8** Vertex (code only) · **A9** merge `origin/main` + CORS + fonts · **A10** delete `mediaStream.js` | **B4** Cloud Run ×4 + Secret Manager + Scheduler · **B5** Storage + CDN + LB | — |
| **11-13** | — | — | **Lane C.** C2 live call ×2 regions · **C3 ≥5 concurrent ×2** · C1 eval ×2/mode · C4 latency vs A0 · **C5 TTS A/B — owner's ears** · C6 isolation · C7 restore · C8 cross-tenant |
| **14-15** | **Lane D** cutover | | Repoint webhooks · row-count reconcile · warm hold starts |

**Realistic call: ~2-3 weeks to built, verified and cut over on staging + production infrastructure.** Code-complete with the suite green lands around day 10. *(Was "~2 weeks, day 9" before A1 was broken out honestly — see the Lane A estimate correction.)*

**What still takes 4-6 weeks, and it is not code:** Twilio Security Edition sales cycle · LLC formation (now deferred to first verbal commit) · cyber liability binding · DPIA sign-off · clinic BAA signature. The engineering finishes and waits on paperwork, which is the correct order — not the reverse.

**Three clocks, named separately so they stop being confused:**

1. **Writing speed** — fast, and the 2026-08-19 estimates priced it at human-engineer rates.
2. **Cloud provisioning wall-clock** — Cloud SQL instances ~10-15 min each, VPC peering for private IP is fiddly, IAM and org-policy propagation is eventually consistent. Not compressible, but hours, not weeks.
3. **Owner bandwidth** — every gate reading "live call", plus the TTS A/B, requires deploy → dial → listen → judge. **This is the true serialization point and no amount of speed elsewhere moves it.** It is why Lane C gets its own three days rather than being scattered.

**Two dependencies that can break the schedule and should be watched weekly:** the Twilio Edition quote, and `gemini-3.6-flash` availability on the Vertex EU endpoint. The second has a cheap contingency — pin the UK stack to a model the EU endpoint does serve, and re-run the eval suite — but discovering it in week 4 rather than day 3 is expensive. It is **B1**, deliberately the first thing that runs once projects exist.

---

## Part 4 — Verification

The test suite is the primary instrument, not a formality.

- **Root suite (82 files, 23,448 LOC) green with zero assertion edits** after the A3 data-layer rewrite — in the **6 module-boundary mocks**. This is the contract; a modified assertion there means interface drift. The **6 client-boundary mocks** (`vi.mock("@supabase/supabase-js")`) are rewritten to mock `pg`, which is expected work, not a gate violation.
- **`npm run eval`** at or above current, run before Vertex, after Vertex, and after the voice bakeoff. Costs real money per run; budget ~10 runs. Require **2 runs per mode** and compare aggregates — the suite is noisier than a ±2-verdict effect, and `npm run eval:compare` does the diff and the leak sweep.
- **Live call verification per region** against a dev Twilio number before production webhooks move.
- **Concurrency test** — ≥5 simultaneous calls against one Cloud Run instance, watching for audio-pump starvation and event-loop lag. This is what would catch a `callState` regression.
- **Latency comparison** against the **A0** baseline at every convergence step. Vertex, Cloud SQL round-trips and VPC hops all sit on the critical path.
- **Cross-tenant isolation tests** at both the application and RLS layers.
- **Deployment isolation tests** — `voice-us`'s configuration asserted to contain no non-covered vendor credential, *including* the circuit-breaker-open failure case, which must reach voicemail.
- **Restore test** — restore a backup into a scratch instance and verify integrity. Required evidence for §164.308(a)(7). Do it once, document it.
- **`npm run sim:cutoff`** after any turn-taking-adjacent change. Note any sim number quoted between 2026-08-04 and 2026-08-05 measured the greeting guard, not turn-taking.

**Do not push while a probe is running** — a push is a deploy is a server restart, and a previous probe returned zero turns from twelve calls because a docs commit landed 52 seconds before it dialled.

---

## Part 5 — Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **A3 data-layer rewrite grinds on client semantics** | **Medium-High — now the top *engineering* risk** | Supabase `.single()` throws on no-row; raw `pg` returns an empty `rows` array. Same class of mismatch in `maybeSingle`, error object shapes, and `.update()` return semantics. Each surfaces as a failing assertion, and the zero-assertion-edit contract means the **adapter** gets fixed, not the test. **This is the one line item with real variance: 4 hours to 2 days.** |
| **Twilio Security Edition price is prohibitive** | High, unpriced | Quote on Day 1; Telnyx quote as leverage. Ask flat-fee vs per-minute explicitly. |
| **`gemini-3.6-flash` absent from the Vertex EU endpoint** | Medium-High | **B1** — the first thing that runs once projects exist, ~day 3, not week 4. Contingency is pinning the UK stack to an available model and re-running eval. |
| **`callState` breaks across Cloud Run instances** | **Medium — downgraded 2026-08-20** | Was High. The reader audit found 114 lines, 3 readers, and **no per-turn read** — all three touch points are call boundaries. **A4** builds the store interface with a multi-process local test that reproduces the three-instances scenario, so **C3** confirms rather than discovers. Test with ≥5 concurrent calls, never one. |
| Two items cannot be verified before Lane C | Medium | **A8 (Vertex)** needs a project + ADC to execute at all. **A4 (callState)** needs multi-instance Cloud Run to prove. Both explicitly flagged in Part 2; A4's local multi-process test is the mitigation. Accepted cost of the re-sort. |
| GDPR DSR work was never scoped | Medium | Budgeted into **A5**. Genuine new engineering, not a config change. |
| Two regions double live-call verification | Medium | Both regions get their own live-call and concurrency gates. Do not certify one from the other. |
| bcrypt import into Identity Platform fails | Medium | **B1**, ~day 3, not discovered at B3. Fallback is a forced reset at pre-launch user counts. |
| Chirp 3 HD is audibly worse than ElevenLabs | Medium | Blind A/B before commitment. Gemini 3.1 Flash TTS ranks above ElevenLabs v3 on blind preference, so this may be an upgrade. |
| Entity formation collides with go-live week | Medium — *changed 2026-08-20* | Deliberately deferred to first verbal commit. Formation is 1-5 business days (California slower, $800/yr minimum franchise tax). **File on verbal commit, not after go-live.** Nothing else in the plan waits on it. |
| **Google OAuth verification is an unbudgeted multi-week gate** | Medium — *avoided, not solved* | Publishing an app with the sensitive `calendar.events` scope requires Google review. **A1.1 sidesteps it entirely by deleting the feature.** The risk only returns if calendar sync is ever rebuilt — see "Deliberately out of scope" for the conditions. The same trap applies to any future Gmail or Drive scope, which are *restricted* and additionally require a paid third-party security assessment. |
| **Silent-failure class of defect** | Medium | Both notification send paths return quietly when unconfigured, and the calendar worker permanently self-disables without alerting anyone. Two live features looked working and were not. **A1.2's boot-time assertion is the pattern to apply generally:** a disabled-by-missing-config subsystem must announce itself loudly at startup, never fail silent. |
| Owner bandwidth is the real bottleneck | Medium | Lane C needs a phone, ears and judgement for ~2-3 days. It cannot be parallelised or delegated. Schedule it as a block, not as interruptions. |
| Schedule pressure causes skipped verification | **High** | The migration is the only gate on clinic revenue. Compensate with the gates, not optimism. The zero-assertion-edit contract, the live-call verification and the ≥5-concurrent test are not negotiable — and none of them is what made the old estimate 4 weeks. Gates are cheap; the calendar around them was not. |

**Rollback** is repointing Twilio webhooks back to Railway, which stays warm and intact through Lane D. With no live tenants there is no divergent-data one-way door.

---

## Deliberately out of scope

- **`session.js` decomposition** (3,105 lines). Worth doing; do it after, so the suite validates one change at a time.
- **athenahealth integration** — v2. Clinic v1 books through `adapters/scheduling/internal`. Sandbox signup on Day 1; partner application after Lane C. **Confirm the first clinic's actual EHR before investing in any specific vendor integration.**
- **Rebuilding Google Calendar sync.** Deleted in A1.1. If it ever returns it needs, in this order: a **published, verified** Google OAuth app (multi-week review for the sensitive `calendar.events` scope) · link-only event content with no PHI in the summary or description · a real disconnection signal to the owner when a refresh token dies · and a decision about whether calendar write-back belongs in the EHR adapter instead. Do not rebuild it as a personal-Google-Calendar feature for clinics.
- **A `us-standard` ElevenLabs lane** — added when a non-healthcare US customer justifies it. A third tfvars file.
- **Per-tenant envelope encryption** with KMS-wrapped keys.
- **Model changes.** Vertex makes future swaps a config edit under the same agreements. Drive that with the eval harness.
- **`Vetra-desktop`** — an unmodified Tauri scaffold.
- **Rebuilding the marketing site** — a friend is doing it independently; `origin/main` already carries their overhaul. We merge it, we do not touch it.

---

## Next actions

**Done 2026-08-19:** this document written; `2026-08-02-gcp-migration-architecture.md` and
`2026-08-02-ideal-architecture.md` both banner-marked superseded on the split, the regulatory
scope and the two factual claims that no longer hold.

**Done 2026-08-20:** code audit (findings table at the top); phases re-sorted into Lanes A/B/C/D; durations corrected; entity formation deferred per owner decision; `callState` risk downgraded on evidence.

**Owner, Day 1 — gates Lane B only. Lane A does not wait for it.**

1. Cloud Identity Free signup on `vetratd.com`, TXT verification, **MX untouched**.
2. Create the billing account. Accept the **Google Cloud BAA** and the **Cloud DPA**; screenshot both with acceptor and timestamp.
3. Open the Twilio conversations — US Security Edition quote + BAA (ask **flat fee vs per-minute** explicitly), UK account + DPA. Longest lead time in the whole plan.
4. File the Vertex abuse-monitoring exception. *(Invoiced billing likely needs a business — skip it until the LLC exists; the exception form achieves the same outcome.)*
5. ICO registration (sole-trader tier is fine). Solicitor on the UK structure question.
6. **athenahealth free developer / sandbox signup** — do this one now, it costs nothing and needs no entity. ~~Entity formation~~ and the ~~athenahealth **partner** application~~ are both deferred: the entity to first verbal commit, the partner filing to after Lane C.
7. Ask the first clinic **three** questions that change the build:
   - **Which US state?** California triggers CIPA all-party recording consent *and* AB 3030 AI disclosure.
   - **Any substance-use treatment?** Triggers 42 CFR Part 2, stricter than HIPAA, and would reshape the consent work.
   - **What do they use for scheduling and records today?** This decides the entire v2 integration target and whether athenahealth is even relevant. If the answer is "a paper book" or "Google Calendar", v1's internal scheduling adapter may be the whole product for a while.
8. **Two 30-second prod checks** that confirm the calendar-sync diagnosis: OAuth consent screen in **Testing** or **In production**? And is migration 021 applied? Neither blocks the deletion — they just close out the root cause.

**Claude, Lane A — starts now, no GCP dependency, no owner input needed:**

1. **A0 — capture the `GET /api/debug/latency` baseline before anything changes.** Check ElevenLabs quota first (a probe run costs ~15k characters) and **do not push while a probe runs**.
2. **A1 — the five PHI leak paths + log scrubbing.** These are live defects on `dev` today: a business owner's personal Google Calendar is receiving patient names and phone numbers, and `POST /api/businesses/:id/phone-numbers/buy` is unauthenticated and spends money. Worth fixing whether or not the migration happens.
3. **A2 — local PG16, `node-pg-migrate`, migrations 002-026, cross-tenant negative tests.**
4. **B0 (write only) — Terraform root module.** Writing needs no GCP; applying waits for Day 1.

**The hard line, restated:** no real patient call goes through the system until the LLC exists, the clinic BAA is signed, and cyber liability is bound. Everything before that runs on synthetic data and the owner's own phone.
