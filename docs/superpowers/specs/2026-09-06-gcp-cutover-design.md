# One architecture: the Gemini Live receptionist on GCP

**Written 2026-09-06.** Approved shape: **A — finish the built estate, one GCP
production, no GCP staging.**

This document answers "where does the receptionist live, and what does it take
to run it for a real client." It is a design, not a plan; the implementation
plan follows it.

> Related: `docs/roadmap.md` is the sequence. `docs/readiness.md` is what
> selling requires. `docs/receptionist-backlog.md` is what is broken.
> `docs/superpowers/plans/gcp-migration-ledger.md` is what was already built and
> how.

---

## 0. What changed the question

The brief was "should the database go on GCP, or Supabase, since Railway is
what we have." Four findings reframe it, and each is checkable:

**The Live front-end is already on the database.** `lib/voice/live/index.js:3`
imports `services/db.js`; tools execute through `services/tools.js`. Same
Postgres, same 40 migrations, same RLS as the cascade. There is nothing to
connect. The only open question is *which* Postgres it points at in production.

**GCP is not a proposal.** `git rev-list --left-right --count main...feat/gcp-2`
is `160 0` — the whole migration is merged into `main`. Terraform stands up
three projects, Cloud Run, Cloud SQL `vetra-uk` on private IP with IAM auth (the
runtime holds **no database password**), Secret Manager, Identity Platform, a
load balancer, budget and logging. `voice-uk-prod` answers `+441372656055` today
and passed 8 of 9 verification gates, including 10 concurrent callers.

**Supabase is already retired as auth.** B3 replaced Supabase Auth with Identity
Platform in `AI-phone-dashboard/backend/src/middleware/authMiddleware.js` and
`frontend/src/auth.js`. Moving *to* Supabase would undo shipped work and run two
identity systems. Supabase is a leftover to delete, not an option.

**The actual gap: GCP runs the cascade only.** `infra/terraform/secrets.tf`
holds Twilio, Deepgram and ElevenLabs — no Gemini key, because the cascade
reaches Gemini through Vertex with ADC. `cloud-run.tf` renders no `LIVE_*`
variable. The Live front-end has never been deployed to GCP.

---

## 1. Topology, and what dies

**End state.** One Cloud Run service `voice-uk-prod` in `europe-west2`, serving
both `/twilio/live-voice` (tier 1) and `/twilio/media-stream` (tier 2) from one
image built off `main`. One Cloud SQL `vetra-uk`, private IP, IAM auth. Secrets
in Secret Manager. Rehearsal is local Docker PG16 (`npm run db:up`). No GCP
staging.

**No GCP staging, re-derived rather than inherited.** `infra/terraform/locals.tf:14`
records that the staging stacks were deleted deliberately — ~$27/month of Cloud
SQL to rehearse against. The one thing a staging stack buys that localhost
cannot is a rehearsal of the Cloud SQL / IAM / private-IP path, and that
rehearsal has already happened: Phase 4 executed the migrate job, Phase 5 served
10 concurrent callers, gate 9a restored from backup in 591s. Paying for it
monthly to repeat it is not worth it. Behaviour questions are better answered on
localhost anyway, where the database is readable and "no row" is
distinguishable from "never tried".

**Twilio accounts map one-to-one onto stacks.** Account A (`AC1828…43b6`) ↔
`vetra-uk`. Account B (`AC7253…ab09`) ↔ `vetra-us`, deferred. Twilio signs a
webhook with the auth token of the account that **owns the number**, so a
number from the wrong account produces a 403 on every request — indistinguishable
from a broken validator, which is what P20 recorded.

One account per stack removes a live hazard as a side effect.
`twilioValidationLive` today accepts a signature from `TWILIO_AUTH_TOKEN` **or**
`TWILIO_AUTH_TOKEN_ALT`, while the media-stream signing key is
`MEDIA_STREAM_SECRET || TWILIO_AUTH_TOKEN`. A deployment holding only the ALT
token validates every webhook perfectly and can mint no stream token, so every
call is authenticated, accepted, and **silent**. With one account per stack the
ALT path is unnecessary in production.

**`vetra-us` stays dark, and that is free.** `var.active_stacks` gates it.
Lighting it builds a Cloud SQL instance at roughly $98/month and a KMS key ring
that cannot be deleted. Deferring costs nothing.

**Railway dies, one week after the repoint.** The revert path is a Twilio
webhook change — one API call — and that only works while Railway is still
running. After the week: Railway down, Supabase project deleted, credentials
swept from local `.env` files.

**Test numbers — decision: option 2, purchase deferred.** The owner will
continue using `+441372656055` (Digile Media's real line) for deployment smoke
tests, with the repoint-and-restore ritual in
`docs/live-frontend-RESTORE.md` §3, executed by `scripts/uk-number.js` and
verified by reading the value **back from Twilio**, never by trusting the update.

The alternative — a second UK number on account A, ~£1/month, no lead time
because the account already holds a Twilio-approved UK regulatory bundle and two
validated GB addresses — is deferred until one of these fires:

- a prospect is routed to `+441372656055`
- Digile Media reports a misrouted call
- testing is needed while their line must stay live

Any one of those, buy the number. Writing the triggers down is what makes "when
it becomes a problem" observable instead of a feeling.

**Behaviour testing stays local, and that is correct.** Account B's token is in
the local `.env`, so `+18176011171` through a tunnel reaches the laptop. That is
the right place for prompt, turn-taking and tool questions. It is *not* a
substitute for a deployed call, and the boundary is not theoretical:

- `VOICE_INTENT_MARKER` silenced every deployed call while fourteen laptop calls
  were clean
- three variables the code read were rendered onto no service —
  `CALL_STATE_STORE`, `DEEPGRAM_REGION`, `DB_POOL_MAX`, the last meaning a worst
  case of 400 connections against a `max_connections` of 50
- Norton adds ~2.2s to every cold HTTPS handshake on the development machine:
  `connect_ms` reads 16–22ms deployed against 2,286ms locally, so no latency
  number from that laptop is usable
- `lib/db/cloudSqlPool.js` is a different code path from a `DATABASE_URL`
  connection and never runs locally
- cold start, `cpu_idle`, min-instances warmth and multi-instance call state are
  Cloud Run only

Account B's two numbers go idle and are **parked**, not released.

---

## 2. Which front-end answers, and what is underneath it

| tier | path | state |
|---|---|---|
| 1 | `/twilio/live-voice` — Gemini Live, AI Studio, `gemini-3.1-flash-live-preview` | **never deployed to GCP** |
| 2 | connect-time throw → cascade `<Connect><Stream>` at `/twilio/media-stream` | built 2026-09-04, merged |
| 3 | no stream token mintable → voicemail | built |
| — | mid-call socket drop | **silence. not built.** |

Allowlist refusals and unrouted numbers return from *inside* the try and
deliberately do **not** fall back. Both are decisions, and routing them to the
cascade would serve exactly the caller the control exists to turn away.

### The Live surface: AI Studio, with Vertex as a measured candidate

`LIVE_SURFACE` is rendered explicitly as `aistudio` (§3); the model stays
`gemini-3.1-flash-live-preview`.

**Why not Vertex now.** Every call that has ever worked here was 3.1 on AI
Studio. Vertex serves exactly one Live model — `gemini-live-2.5-flash-native-audio`,
in `europe-west1` and `us-central1` only — and it has never taken a call on this
system. Swapping the model during an infrastructure cutover means a bad call has
two candidate causes and no way to separate them.

**The latency argument for Europe does not exist.** Measured, round 1 and round
2: 3.1 on AI Studio, model leg p50 **1043 ms** (n=25); 2.5 on Vertex
`europe-west1`, model leg p50 **1053 ms**. Ten milliseconds apart, against a
voice-to-voice p50 near 2.8s. Three caveats, because that is not a clean region
A/B: both were measured from the development laptop rather than from Cloud Run;
they are different models, so region and model are confounded; and nobody has
measured one model in two regions, because 3.1 exists in exactly one place.

**AI Studio has no region at all.** `new GenAI({ apiKey })` takes no location,
unlike the Vertex branch's `{ vertexai: true, project, location }`. The Gemini
Developer API is one global endpoint. Where a session terminates is neither
selectable nor promisable to a client.

**"Close to London" tops out at Belgium either way.** `europe-west2` serves no
Live model on any surface — HTTP 400 at the WebSocket upgrade, every candidate,
24 model/region cells probed. A "your data stays in the UK" promise cannot be
met by Gemini Live at all.

**So the case for Vertex is compliance, not performance**, and it has a date
rather than being due today: no one pays, and no member of the public reaches
either front-end. Two things this does not let us skip — 3.1 is `-preview` and
can be withdrawn on Google's schedule, and the DPIA must say the audio leaves
Google Cloud.

**Re-test trigger.** Vertex 2.5 gets a measured round on the corrected 10-tool
harness before the first paying client, or immediately if 3.1 is withdrawn.
`LIVE_SURFACE` and `LIVE_MODEL` are deploy variables, so the switch is a
Terraform edit.

### The failure this cutover invites, and the check that stops it

`createLiveClient` **throws** when `GEMINI_API_KEY` is absent and `LIVE_SURFACE`
is not vertex, but nothing in `/twilio/live-voice`'s try block ever calls it or
contacts a model at all — that route only allowlists the caller, looks up the
business, mints a stream token and returns `<Connect><Stream>`, bumping
`live_connect_ok` before any model is touched. `createLiveClient` runs later,
inside `connectLive`, in the WebSocket handler Twilio opens next. So a missing
key is not caught by the route, and it is not caught by the cascade either: the
call is answered, `live_connect_ok` bumps, the socket opens, `connectLive`
throws, and the handler closes it with no verb behind `<Connect>` for Twilio to
fall back to. **The caller gets pickup, dead air, then a hangup — never the
cascade.**

So this is not two defences. **The boot check (§3) is the only one** — it turns
the misconfiguration into a refused deploy instead of a live one that answers
and fails silently. The deploy gate (§4, §7) is not a second defence; it is a
second *reading*, taken after the fact against a deployment that already
booted: `live_close_clean > 0`, which is unreachable without a real model
session actually opening and closing, alongside `live_connect_fallback == 0`.
`live_connect_ok` alone proves nothing — it bumps in the same place whether the
key is present or absent.

### Mid-call fallback: out of scope here, in before the first paying client

A mid-call socket drop is still silence. Closing it needs an `action` URL on
`<Connect>`, a Twilio mechanism nobody here has tried. Shipping an untested
vendor mechanism *during* a platform migration means a bad call has two
candidate causes; and four fixes on 2026-09-06 each introduced a defect, every
one shipped on a single call's evidence.

What ships instead is the instrument: **log abnormal socket closes on the
deployed service**, so the decision later has a rate behind it.

### The two paths are one system, and that is the point

The maintenance worry — "we would have to connect tier 1 and tier 2 to the same
database and keep changes applied to both" — is already resolved by
construction:

| | shared via |
|---|---|
| database | `services/db.js`, imported directly by both |
| prompt | `buildSystemInstruction` (`lib/voice/live/index.js:6`) |
| tool declarations | `buildAllDeclarations` |
| tool execution | `executeToolCallGuarded` — live's own file: "execute through `services/tools.js`, not a reimplementation" |
| capability packs | `packForTool` |
| notifications, call state, metrics, post-call verify, reply state | shared |
| audio primitives | `audioOut`, `inboundVad`, `echoGuard`, `resample` |

`lib/voice/live/minimalPrompt.js` is **not** the Live prompt — it is the
reduced-prompt arm of the LVX23 bisect, its own header says "NOT a candidate
prompt," and it fires only behind `LIVE_PROMPT=minimal`.

What differs is the transport: Live uses the vendor's VAD plus `halfDuplex`,
`turnEnd` and `leakGuard`; the cascade uses Deepgram STT, `turnManager`,
`endpointArbiter`, `ttsStream` and ElevenLabs. Ears and mouth. The brain is
shared.

**The real risk is the inverse of the one feared:** a change reaches *both*
paths, so an edit aimed at Live can regress the cascade silently. That is
already true and is not added by this work. It is also why the cascade earns its
keep twice — it is the fallback *and* the subject of the eval band, currently
one of the few instruments that can catch a prompt regression at all.

---

## 3. Secrets and the config surface

**The gap.** The Live path reads 20 environment variables. Cloud Run renders
none of them.

| variable | disposition |
|---|---|
| `GEMINI_API_KEY` | **Secret Manager, required.** Add to the `secrets.tf` runtime list and reference from `cloud-run.tf` |
| `LIVE_SURFACE` | render explicitly as `aistudio`, even though it is the default |
| `LIVE_MODEL` | **pin explicitly** to `gemini-3.1-flash-live-preview` |
| `TRANSFER_NUMBER`, `UNROUTED_TRANSFER_NUMBER`, `CALL_MAX_DURATION_MINUTES` | read on the route, rendered nowhere — verify each and render or consciously default |
| the remaining 13 `LIVE_*` behaviour flags | defaults hold; render only values tuned off-default, and say which in the plan |

`LIVE_MODEL` is pinned rather than defaulted because it is a `-preview` model
Google can withdraw on their schedule. `client.js` already says "overridable so
a withdrawal is a variable." Pinning makes the response a Terraform edit rather
than a code change during an outage.

**The durable fix is a boot check.** This bug class has fired three times —
`CALL_STATE_STORE`, `DEEPGRAM_REGION`, `DB_POOL_MAX`, each read by code and
rendered onto no service. `tests/envInventory.test.js` already fails in both
directions, but it compares code against `.env.example` and structurally cannot
see Terraform; the ledger records that reconciling against deployed environments
cannot be done from a workstation.

`lib/bootChecks.js` runs where the environment actually is. Add:

> **`FATAL`** when the service will serve `/twilio/live-voice` and
> `GEMINI_API_KEY` is absent while `LIVE_SURFACE` is not `vertex`.

Same shape as the existing half-configured-SMTP and STT checks. It converts the
worst outcome into a deploy that refuses to start.

---

## 4. Deploy order

The order is load-bearing. It is not one command.

1. `terraform apply -target='google_secret_manager_secret.runtime'` — the
   secret container only, empty. Not the full apply: `cloud-run.tf`'s dynamic
   `env` block references `gemini-api-key` at `version = "latest"`, so applying
   everything here would create the secret **and** roll the voice service onto
   it, empty, in the same step, and Cloud Run refuses a revision whose secret
   cannot be resolved. This is the U2 pattern
   (`gcp-migration-ledger.md`, "FIVE secret values ... and it cannot happen
   before a partial apply"): target the secret, fill it, then apply the rest
2. Push the Gemini key **value** directly —
   `gcloud secrets versions add gemini-api-key --data-file=-` — confirmed by
   reading the version's metadata back, never the value. Not
   `scripts/push-secrets.js`: its `MAPPING` docstring excludes this credential
   on purpose, the same way it excludes `ELEVENLABS_API_KEY` — both are
   UK-lane-only with no BAA, and the script exists precisely so a `--project
   vetra-us-...` invocation cannot inherit either from a shared `.env`
3. `terraform apply` — the rest: the IAM grant and the voice service revision
   carrying `GEMINI_API_KEY`, `LIVE_SURFACE`, `LIVE_MODEL`, now that the secret
   it references has a version
4. Build from `main` **with `--service-account=vetra-deployer`** — the default
   compute service account 403s on the Cloud Build source bucket
5. **Run the migrate job before the service rolls.** At minimum 041
   (`business_live_voice`); confirm the pending set against the instance rather
   than assuming. A service rolling ahead of its schema has bitten this twice
6. Roll the voice service
7. **Assert on the serving revision, not on "a call worked":** `Build:` sha
   matches, `live_close_clean > 0`, `live_connect_fallback == 0`,
   `db_backend cloudsql/IAM`, `call_state_store=pg`, `DEEPGRAM_REGION=eu`.
   Not `live_connect_ok` — it bumps before any model is contacted, so a
   keyless deploy produces it too; `live_close_clean` only bumps after a real
   session opens and closes

Two traps carried in. `image_tag` defaults to `"0000000"`, a tag that does not
exist, so a full apply before the build fails on a missing image. And
`cloudbuild.yaml`'s own migration guard reads `/workspace` rather than `/app`
(P13), so it cannot see the image it claims to check — verify by reading the
image, not by trusting that step.

---

## 5. Cutover and rollback

1. Capture `+441372656055`'s current Twilio configuration field-for-field, first
2. Repoint at `twilio_webhook_base` — **never `.uri`**, which is the trap that
   403s, proven by signing over the `.uri` host and getting a 403
3. Deployment smoke test, then a real call
4. Railway warm for one week. The revert is one Twilio API call and works only
   while Railway is running
5. Behaviour testing continues on the local rig against account B throughout
6. After the week: Railway down, Supabase project deleted, credentials swept

Routing any number needs a `businesses.phone_number` row holding the exact E.164
string — `app_lookup_business_by_phone` matches exactly. Note that the
`businesses` trigger **deletes every `business_directory` row for a business on
any `phone_number` UPDATE**, so a hand-added row is temporary; a second imported
tenant is the durable form.

---

## 6. What "production ready" still adds

Scoped separately so it can be cut. None of it is required for the cutover
itself; all of it is required before a paying client.

| item | size | note |
|---|---|---|
| Uptime alerting | small | `budget.tf` alerts on **cost only**. Nothing reports the voice service being down, and Phase 5 proved it can serve 10 concurrent callers — which means it can stop serving them unobserved |
| CI | small | no `.github/workflows`; the suites run only when someone runs them locally |
| Dashboard frontend home | medium | `DASHBOARD_URL` on the live service is a 404. Vercel cannot deploy this repo — private org repository on the Hobby plan. Firebase Hosting was previously costed at $0 |
| Mid-call fallback | medium | deferred above; counter ships now |
| Dashboard PHI-access audit | medium | the dashboard backend writes no `phi_access` record at all, while the voice service emits them normally. §164.312(b) exists principally to detect access by workforce members, so the coverage is the wrong way round. Compliance-shaped, parked |

---

## 7. Testing and verification

**Every claim in the deploy gate is a read, not an inference.**

- Suites green before the build: root, db, sim, dashboard backend, dashboard
  frontend, plus `terraform fmt` exit 0 and `validate` Success
- New boot check: sabotage-verified in **both** directions — absent key must
  fail the boot, present key must not
- Post-roll: the six assertions in §4 step 7, read off the serving revision
- The call: book on call 1, and call 1 must be the **cold** one — `cpu_idle`
  evidence only appears on turn one after an idle gap, and a second call spends
  it for ~15 minutes
- Restore verified by reading `+441372656055` back from Twilio

**What this design does not claim.** It does not close phase 1's outstanding
leg: a UK business ringing from a UK handset. It does not measure Vertex 2.5. It
does not close the mid-call silence. Each is written down above with the trigger
that reopens it.

---

## 8. Decisions, for the record

| # | decision | why |
|---|---|---|
| 1 | GCP, not Supabase, not Railway | the estate is built, merged and serving; Supabase Auth is already replaced |
| 2 | One production, no GCP staging | the Cloud SQL/IAM rehearsal is already done; localhost answers behaviour questions better |
| 3 | Account A ↔ `vetra-uk`, account B ↔ `vetra-us`, US deferred | Twilio signs with the owning account's token; `vetra-us` dark is free |
| 4 | Live on AI Studio, 3.1 | it is the only surface the model exists on, and the Europe latency argument measures 10 ms |
| 5 | Tier 2 kept | already built and deployed; costs nothing; also carries the eval band |
| 6 | Mid-call fallback deferred, counter now | untested vendor mechanism, wrong thing to ship during a cutover |
| 7 | Test number: option 2, purchase deferred | owner's call; triggers written down in §1 |
| 8 | `GEMINI_API_KEY` absence is FATAL at boot | otherwise tier 2 masks it and the cutover silently does nothing |
