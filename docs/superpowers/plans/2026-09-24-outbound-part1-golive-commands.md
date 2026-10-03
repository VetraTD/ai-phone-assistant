# Outbound Part 1 go-live: the exact production commands

**Needs the owner's YES before any command in Section A runs. Section B needs a second YES before round 1.**
Everything here runs in Git Bash from `C:\Users\nithi\VetraTD\ai-phone-assistant`. Read-only checks are marked `(read)`.

## What ships

| | |
|---|---|
| Production now | revision `voice-uk-prod-00093-tjr`, image `voice:695b4d9`, 100% of traffic (read with `gcloud run services describe` on 2026-09-26) |
| Ships | `voice:96e356b`, which is `feat/outbound-stage2` HEAD `96e356b` |
| Diff range | `695b4d9..96e356b`, 112 commits. Outbound Part 1 (tables, dialler, door, first seconds, post-call, admin script), the Spanish goodbye fix (`63dd858`), and today's six go-live items plus one review fix round (opus review, then a scoped re-review: all findings addressed) |
| Outbound | **OFF** (`OUTBOUND_ENABLED=false`). Only `+14699338887` (your handset) can be dialled, and only after Section B |
| Inbound | Behaviour-identical by test: 0 inbound prompt snapshots changed since `44e31ba`. The Spanish goodbye regex is fixed (it never matched before) |
| Gate at `96e356b` | root `264+1 files / 5392 passed / 4 skipped / 3 todo (gate worktree)`; test:db `34 files / 472 passed`; census `63 rows`; migration rehearsal PASS (below) |

**Migration rehearsal (local, 2026-09-26):**
- Setup: a scratch DB built from `schema.sql@695b4d9` with migrations up to 041 recorded as applied, then the real `scripts/migrate.js`.
- Timings: 042 took 144 ms, 043 12 ms, 044 30 ms, 045 17 ms.
- Result: the schema fingerprint equals the `schema.sql` fold.
- The 9 new tenant tables are FORCE RLS with vetra_app SELECT/INSERT/UPDATE/DELETE. The 4 directory tables have no RLS, and vetra_app has no privileges on them.
- 695b4d9's own calls INSERT and call_state merge still work on the migrated schema, so rolling back the service is safe.

**Production size (read today):** 2 routable tenants, 182 `calls` rows (136 on +18176011171, 46 on +441372656055). Migration 043 validates its CHECK and 4 foreign keys against those rows while holding an exclusive lock. At this size that takes milliseconds, so no quiet window is needed.

**Account B (read today):**
- The production secret `twilio-auth-token-alt` authenticates with account B's SID `AC7253…ab09` (HTTP 200).
- The account-A token does not (HTTP 401).
- `+18176011171` is on account B, and its voice webhook points at this service's `/twilio/live-voice`.

## Section A: deploy (outbound stays OFF)

```bash
export CLOUDSDK_CONFIG=~/.gcloud-vetra2
P=vetra-uk-edc8ca; R=europe-west2; SHA=96e356b
SA_APP=voice-uk-prod@vetra-uk-edc8ca.iam.gserviceaccount.com
SA_TASKS=outbound-tasks@vetra-uk-edc8ca.iam.gserviceaccount.com
BASE_URL=https://voice-uk-prod-462445274080.europe-west2.run.app   # no trailing slash; equals the service's BASE_URL
IMG=us-central1-docker.pkg.dev/vetra-core-edc8ca/vetra/voice:$SHA
```

**A1. Turn on Cloud Tasks for the project.** It is the alarm clock that tells the service when to dial. It is not enabled today; Scheduler already is.
```bash
gcloud services enable cloudtasks.googleapis.com --project=$P
```

**A2. Create the robot identity `outbound-tasks`.** Cloud Tasks and Scheduler use it to call the service's internal routes, and the service accepts only tokens minted for this identity.
```bash
gcloud iam service-accounts create outbound-tasks --project=$P --display-name="Outbound Tasks/Scheduler invoker"
gcloud run services add-iam-policy-binding voice-uk-prod --region=$R --project=$P --member=serviceAccount:$SA_TASKS --role=roles/run.invoker
```

**A3. Create the dispatch queue.** At most 1 new task per second and 5 at once, each tried at most 3 times.
```bash
gcloud tasks queues create outbound-dispatch --location=$R --project=$P --max-dispatches-per-second=1 --max-concurrent-dispatches=5 --max-attempts=3
```

**A4. Let the service put tasks on the queue, and sign them as `outbound-tasks`.**
```bash
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA_APP --role=roles/cloudtasks.enqueuer --condition=None
gcloud iam service-accounts add-iam-policy-binding $SA_TASKS --project=$P --member=serviceAccount:$SA_APP --role=roles/iam.serviceAccountUser
```

**A5. Store account B's Account SID as a secret, readable only by the service.**
- Why: it pairs with the existing `twilio-auth-token-alt`, and the pair lets the service dial from `+18176011171`.
- The value is read from local `.env` (`TWILIO_ACCOUNT_SID`, which is account B's, shape-checked as `AC7253…ab09`) and piped in. It is never printed.
- It uses the same replication as `twilio-auth-token-alt` (user-managed, europe-west2).
```bash
SID_B=$(grep -E '^TWILIO_ACCOUNT_SID=' .env | head -1 | cut -d= -f2- | tr -d '\r"'); [[ "$SID_B" == AC7253*ab09 ]] || { echo "wrong SID shape"; exit 1; }
printf '%s' "$SID_B" | gcloud secrets create twilio-account-sid-alt --project=$P --replication-policy=user-managed --locations=$R --data-file=-; unset SID_B
gcloud secrets add-iam-policy-binding twilio-account-sid-alt --project=$P --member=serviceAccount:$SA_APP --role=roles/secretmanager.secretAccessor
```

**A6. Build the image** in Cloud Build, from the committed tree. Check first: `git status --porcelain --untracked-files=no` is empty, and `git rev-parse --short HEAD` = `$SHA`. The smoke steps now also load `@google-cloud/tasks` and `outbound-admin.js`.
```bash
gcloud builds submit --config=cloudbuild.yaml --project=vetra-core-edc8ca \
  --service-account=projects/vetra-core-edc8ca/serviceAccounts/vetra-deployer@vetra-core-edc8ca.iam.gserviceaccount.com \
  --substitutions=_TAG=$SHA
```

**A7. Point the migrate JOB at the new image, and give it the allow-list.**
- This cannot change a live call: the job only runs when we execute it.
- The allow-list is needed because `outbound-admin trigger --consent-manual` refuses any number that is not on it.
```bash
gcloud run jobs update vetra-migrate-uk-prod --image=$IMG --project=$P --region=$R --update-env-vars=OUTBOUND_TEST_ALLOWLIST=+14699338887
```

**A8. Preflight, read-only, BEFORE migrating.** It prints numbers only.
```bash
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/db-inspect.js,--outbound-preflight --project=$P --region=$R --wait
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/migrate.js,--status --project=$P --region=$R --wait
```
**STOP and ask you if:**
- the tenant walk is incomplete;
- `confirm_identity_integrations` is not 0 (I1: an inbound tenant tool with that name must still reach its webhook);
- `--status` shows anything pending other than exactly 042, 043, 044 and 045.

All 13 new tables should show `absent` at this point.

**A9. Migrate, then re-check.** Every change is additive: new tables, new nullable columns, and a CHECK that existing rows already satisfy.
```bash
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/migrate.js --project=$P --region=$R --wait
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/migrate.js,--status --project=$P --region=$R --wait   # expect pending: none
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/db-inspect.js,--outbound-preflight --project=$P --region=$R --wait   # expect every table ok
```
**STOP and ask you if** any table shows `MISMATCH`.

**A10. Deploy the service.** This creates one new revision, with outbound OFF.
- It uses the new image, 6 new environment settings and 1 new secret.
- Every existing setting and secret is kept (`--update-*` only adds or changes).
- The new revision takes 100% of traffic once it is Ready.
```bash
gcloud run services update voice-uk-prod --image=$IMG --project=$P --region=$R \
  --update-env-vars=GIT_COMMIT_SHA=$SHA,OUTBOUND_ENABLED=false,OUTBOUND_TEST_ALLOWLIST=+14699338887,OUTBOUND_TASKS_QUEUE=projects/vetra-uk-edc8ca/locations/europe-west2/queues/outbound-dispatch,OUTBOUND_TASKS_SA=$SA_TASKS,OUTBOUND_MAX_CONCURRENT=3,OUTBOUND_INBOUND_RESERVE=2 \
  --update-secrets=TWILIO_ACCOUNT_SID_ALT=twilio-account-sid-alt:latest
```

**A11. Create the 5-minute sweep, LAST, so it never calls a revision without the route.**
- The sweep rescues any dial whose task was lost, and runs post-call backstops.
- The audience is exactly `BASE_URL`, which is what the service checks.
- The deadline is 600 s: the sweep works inline, over up to 100 rows.
```bash
gcloud scheduler jobs create http outbound-sweep --location=$R --project=$P --schedule="*/5 * * * *" --time-zone=Etc/UTC \
  --http-method=POST --uri="$BASE_URL/internal/outbound/sweep" \
  --oidc-service-account-email=$SA_TASKS --oidc-token-audience="$BASE_URL" --attempt-deadline=600s
```

**A12. Verify.**
- `(read)` The new revision is Ready and takes 100% of traffic, on image `$SHA`. `curl -s $BASE_URL/` shows `Build: $SHA`.
- `(read)` An env/secret diff against the table below: nothing removed, only the listed additions.
- `(read)` The boot log does NOT contain `outbound_internal_routes_disabled`.
- `(read)` After the first sweep: `outbound_sweep` shows `reenqueued: 0`, with no errors.
- The render check, paid at about $0.003 (reserve `P1-DEPLOY` $0.01). It runs on this PC, renders one opener clip in Gemini Live with `gemini-3.8-live`, and prints the byte count and the verification verdict:
  `NODE_EXTRA_CA_CERTS=C:\Users\nithi\.gcloud-vetra2\ca-bundle.pem LIVE_MODEL=gemini-3.8-live node scripts/probes/outbound-render-check.mjs --persona Ava --business-name "Digile Media" --first-name Nithin --caller-id +18176011171 --run` (dry run already checked for free: "Hi, is that Nithin? It's Ava, an AI assistant from Digile Media.", 64/120 chars, en-US, voice Kore)
- You place one ordinary inbound call to **+1 817 601 1171**. I read its `live_call_summary`: it must say `direction:"inbound"`, with no errors.

### Env/secret diff (service)
| | Before (00093-tjr) | After |
|---|---|---|
| Image | `voice:695b4d9` | `voice:96e356b` |
| `GIT_COMMIT_SHA` | `695b4d9` | `96e356b` |
| New env | none | `OUTBOUND_ENABLED=false`, `OUTBOUND_TEST_ALLOWLIST=+14699338887`, `OUTBOUND_TASKS_QUEUE=…/queues/outbound-dispatch`, `OUTBOUND_TASKS_SA=outbound-tasks@…`, `OUTBOUND_MAX_CONCURRENT=3`, `OUTBOUND_INBOUND_RESERVE=2` |
| New secret | none | `TWILIO_ACCOUNT_SID_ALT` → `twilio-account-sid-alt:latest` |
| Unchanged | the other 26 env vars (27 today, one of which is GIT_COMMIT_SHA) and all 7 secret refs (including `TWILIO_AUTH_TOKEN_ALT`, `LIVE_MODEL=gemini-3.8-live`, `BASE_URL`) | same |
| Not set (by design) | `OUTBOUND_MEDIA_URL_SECRET`, which derives from the existing signing key under its own label | same |

Migrate job: image `695b4d9` → `96e356b`, plus `OUTBOUND_TEST_ALLOWLIST=+14699338887`.

### Rollback
```bash
gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00093-tjr=100 --region=$R --project=$P
gcloud scheduler jobs pause outbound-sweep --location=$R --project=$P
```
- Traffic goes back to the old revision, which comes with its old settings, in seconds.
- Migrations 042-045 stay. The rehearsal showed the old code works on the new schema.
- The queue, the robot identity and the secret are unused by the old revision and harmless.
- The migrate job can stay on the new image; it only runs when executed.

## Section B: round-1 setup (second YES; all through the migrate job, dry run first, then `--confirm`)
Tenant `+18176011171` ("Digile Media", America/Chicago).
1. `outbound --phone +18176011171 --enabled true --max 1`: switches outbound on for this one test tenant (still behind the global OFF switch and the allow-list).
2. For each scenario:
   - `campaign … --name "R1-Snn …" --template-key speed_to_lead --compliance-class solicited --audience business --config <b64>`, then `status --status active`.
   - Config: the `speed_to_lead` template with these changes:
     - `caller_id` `+18176011171`;
     - calling window `08:00-21:00` every day;
     - scenario 8 only: `transfer {to: "+14699338887", when: "Daily 08:00-21:00", whisper: false}`.
   - One campaign per scenario, because the trigger's idempotency key is per campaign, per number, per UTC day.
3. On your "ready":
   - `trigger --phone +18176011171 --campaign-id <id> --contact-phone +14699338887 --timezone America/Chicago --first-name Nithin --consent-manual`;
   - after 2 minutes, `gcloud scheduler jobs run outbound-sweep --location=$R --project=$P` so it dials in about 3 minutes instead of up to 7.
4. After each call: `status --status paused` on that scenario's campaign, so no retry ever dials.
5. After scenario 9 only, with its own YES: `unsuppress --phone +18176011171 --contact-phone +14699338887`.

## Section C: Stage 3 additions (deploy 2, DRAFT, YES-gated)

**Status: C0–C9 EXECUTED 2026-09-29 (CDT).** Production = `voice-uk-prod-00095-nhs`, image
`voice:e451d91` (`sha256:e2acdeef04f9…`, Cloud Build `c9356532`), 100% traffic, `OUTBOUND_ENABLED=false`,
allow-list `+14699338887`; migrations 046–050 applied (125 ms total); both secrets mounted; one
log-match alert policy → nithinjd06@gmail.com; inbound smoke call OK; R1 S1b/S03/S10 on config v2.
Four corrections found while running it are marked **[AS RUN]** below. Previous revision for C10:
`voice-uk-prod-00094-87t`. Started by the S3-11
implementer (the original C1/C2 secret + alert draft), consolidated here into the full ordered
list for the whole stage-3 branch. Every command needs its own explicit YES; this is a draft for
the controller/owner to review and refine, not a rehearsed sequence like Sections A/B.

**What this deploy carries.** The half-1 deploy never ran — production is still
`voice-uk-prod-00094-87t` @`96e356b` (the Part 1/stage-2 revision, 100% traffic,
`OUTBOUND_ENABLED=false`, allow-list `+14699338887`). This single deploy therefore ships ALL of
stage 3 at once: S3-1 through S3-11, the F-R2 first-seconds fix, and the harness-verdict fix —
`96e356b..$SHA`, base `b797487`.

`SHA` = the final code head **`e451d91`** (all 6 half-2 tasks, the F-R2 fix, the harness fix, the
final opus review's fix wave W1–W3 and its residuals; final gate GREEN at e451d91: root 6114 passed /
5 skipped, test:db 579, census 63/63, inbound prompt snapshots unchanged since b797487). Later commits
on the branch are docs/spend-JSON only; building from the branch HEAD at deploy time is equivalent —
confirm with `git diff --stat e451d91 HEAD -- . ':!docs' ':!*.md' ':!scripts/probes/spend*.json'` (empty).

Gates along the way: HALF 1 stop (`eba8fab`) root 268+1 files/5673 passed, test:db 35/492, census
63/63; half-2 final task (`d88807c`) root 275+1 files/6010 passed/4 skipped/2 todo, test:db 40
files/567 passed, census 63/63 — inbound prompt snapshots unchanged since `b797487` (0 non-outbound
files) at every gate. Sims: round 1 1/24 (harness-instrument-dominated, superseded), round 2 15/24
(post first-seconds triage); SET A (post-half-2, at `bb63d71`) 1/3 PASS with one real caller-facing
defect confirmed open (see "What this build still carries" below) — SET B (against the final
fix-wave code) has not run.

Uses the SAME workaround as every other GCP command in this repo (memory gcp-notices-go-nowhere:
`admin@vetratd.com` is Account Restricted, and no Essential Contacts existed before that memory's
fix):
```bash
export CLOUDSDK_CONFIG=~/.gcloud-vetra2
P=vetra-uk-edc8ca; R=europe-west2; SHA=e451d91
SA_APP=voice-uk-prod@vetra-uk-edc8ca.iam.gserviceaccount.com
BASE_URL=https://voice-uk-prod-462445274080.europe-west2.run.app
IMG=us-central1-docker.pkg.dev/vetra-core-edc8ca/vetra/voice:$SHA
```

**C0. Preflight (read).**
```bash
git status --porcelain --untracked-files=no   # expect empty
git rev-parse --short HEAD                    # expect $SHA
```

**C1. Build the image.** Same Cloud Build pattern as Section A6; the smoke steps already load
`@google-cloud/tasks`/`outbound-admin.js` from Part 1.
```bash
gcloud builds submit --config=cloudbuild.yaml --project=vetra-core-edc8ca \
  --service-account=projects/vetra-core-edc8ca/serviceAccounts/vetra-deployer@vetra-core-edc8ca.iam.gserviceaccount.com \
  --substitutions=_TAG=$SHA
```

**C2. Point the migrate job at the new image.** Allow-list unchanged from Part 1; repeating it is
idempotent.
```bash
gcloud run jobs update vetra-migrate-uk-prod --image=$IMG --project=$P --region=$R \
  --update-env-vars=OUTBOUND_TEST_ALLOWLIST=+14699338887
```

**C3. Preflight, read-only, BEFORE migrating.**
```bash
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/db-inspect.js,--outbound-preflight --project=$P --region=$R --wait
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/migrate.js,--status --project=$P --region=$R --wait
```
**STOP and ask the owner if `--status` shows anything pending other than EXACTLY, in this order:**
`046_outbound_transfer_miss`, `047_outbound_missing_goal`, `048_outbound_erasure`,
`049_outbound_triggers`, `050_outbound_outbox_schedule`. (Renumbered mid-build from the plan's
original 047/048/049 — Ruling R-renumber-2, spec §19 update below — the files on disk already carry
these final numbers; `migration-seq-proof.log` proves this exact order applies clean on top of the
production-equivalent 45-migration baseline, with a schema fold that matches a fresh `schema.sql`
build byte-for-byte at `580ceca`.)

**Warning:** run migrations ONLY through this migrate-job image.

**[AS RUN] Build the image from the MAIN checkout, not a fresh/gate worktree.** Production recorded
the checksums of the main checkout's CRLF working copies of `database/002`–`012` (11 files,
`git ls-files --eol` → `i/lf w/crlf`; e.g. 002 applied `6c748514d207` = main checkout, LF =
`b8581abc4e39`). An image built from an LF worktree makes `migrate.js --status` exit 1 with "An
already-applied migration has been EDITED" for 002–012 (read-only, nothing written). The first C1
build (`61171415`, from the gate worktree) hit exactly this; the rebuild from the main checkout
(`c9356532`) passed. The Dockerfile COPYs named directories only, so untracked files in the main
checkout never enter the image. The earlier version of this warning had the direction backwards.

**C4. Migrate, then re-check.** Every one of 046–050 is additive or loosening, confirmed by reading
all five files: 046 adds a nullable `bytea` column; 047 and 048 widen an existing CHECK to accept
new values (existing rows already satisfy it); 048 also `DROP`s a `NOT NULL` (loosens, never
tightens) and adds a nullable column + a partial unique index that only fires when the new nullable
column is populated; 049 adds a nullable column plus a `NOT NULL DEFAULT '{}'` column (Postgres
backfills the default on every existing row) and three new objects (a directory table + trigger +
`SECURITY DEFINER` function) that nothing pre-stage-3 reads; 050 adds one new no-RLS routing table +
trigger + function, with no column change on any existing table. Nothing here can break the
currently-running `96e356b` revision.
```bash
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/migrate.js --project=$P --region=$R --wait
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/migrate.js,--status --project=$P --region=$R --wait   # expect pending: none
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/db-inspect.js,--outbound-preflight --project=$P --region=$R --wait   # expect every table ok
```
**STOP and ask the owner if any table shows `MISMATCH`.**

**C5. Secrets: `connections-webhook-key` → `CONNECTIONS_WEBHOOK_KEY`, `suppression-hash-key` →
`SUPPRESSION_HASH_KEY`.** Both are 32 random bytes, base64-encoded, generated locally and piped
straight to `gcloud` — never printed, never in shell history or a log. Same replication style as
`twilio-account-sid-alt` (Section A5): user-managed, `europe-west2`.

*Why `SUPPRESSION_HASH_KEY` must exist before this revision ever takes an outbound call, for any
tenant with even one suppression row on file:* `services/db.js`'s `isSuppressed` (the gate's
do-not-call check) THROWS when the key is missing (Ruling S3-11b, fail closed — memory
`plan-verbatim-code-fails-open`). Dispatch's transaction rolls back and Cloud Tasks retries, so no
illegal dial can happen — but post-call also calls the suppression path, and **sims-report-A run 2
hit exactly this failure on the local harness** (which doesn't mount the key by default):
`outbound_postcall_run_failed "SUPPRESSION_HASH_KEY is missing"`, the outreach stuck `'dialing'`
forever, never reaching `'waiting'`. Mount both secrets in the SAME deploy step as the new revision
(C6), never after it.

*Rotation note (S3-11 report):* rotating `SUPPRESSION_HASH_KEY` later invalidates every
previously-erased suppression's hash — a phone number erased under the old key stops being
findable by the gate. A one-way loss of protection, not a routine rotation.
```bash
openssl rand -base64 32 | gcloud secrets create connections-webhook-key --project=$P --replication-policy=user-managed --locations=$R --data-file=-
gcloud secrets add-iam-policy-binding connections-webhook-key --project=$P --member=serviceAccount:$SA_APP --role=roles/secretmanager.secretAccessor

openssl rand -base64 32 | gcloud secrets create suppression-hash-key --project=$P --replication-policy=user-managed --locations=$R --data-file=-
gcloud secrets add-iam-policy-binding suppression-hash-key --project=$P --member=serviceAccount:$SA_APP --role=roles/secretmanager.secretAccessor
```
**STOP and ask the owner first:** this makes `SUPPRESSION_HASH_KEY` load-bearing for EVERY future
Art. 17 erasure request that finds a matching suppression row — confirm this deploy step runs
before, or together with, the next Art. 17 request this tenant might receive, not after.

**C6. New revision.** `OUTBOUND_ENABLED` stays `false`; the allow-list is unchanged; no other env
change. Mounts both new secrets.
```bash
gcloud run services update voice-uk-prod --image=$IMG --project=$P --region=$R \
  --update-env-vars=GIT_COMMIT_SHA=$SHA \
  --update-secrets=CONNECTIONS_WEBHOOK_KEY=connections-webhook-key:latest,SUPPRESSION_HASH_KEY=suppression-hash-key:latest
```
**Verify (read):**
- The new revision is Ready and takes 100% of traffic, on image `$SHA`. `curl -s $BASE_URL/` shows
  `Build: $SHA`.
- Env/secret diff against production today: nothing removed; added = `GIT_COMMIT_SHA` (value) and
  the two new secret refs. `OUTBOUND_ENABLED` still reads `false`; `OUTBOUND_TEST_ALLOWLIST` still
  reads `+14699338887`.
- The boot log does NOT contain `outbound_internal_routes_disabled`.
- One ordinary inbound call by the owner to +1 817 601 1171; its `live_call_summary` says
  `direction:"inbound"`, no errors.

**C7. Alerting: `outbound_stuck_dialing` + the S3-8/S3-9 counters that are actually alertable, one
explicit email channel.** Checked every counter S3-8/S3-9 added (`lib/voice/metrics.js`) against
whether it is ALSO written to Cloud Logging with a matching event name — a bare `bumpCounter()`
with no `log.*()` call is invisible to a log-based Cloud Monitoring metric:

| Counter | Logged with a matching event name? | Alertable today |
|---|---|---|
| `outbound_stuck_dialing` (`lib/outbound/dispatch.js:534`) | `log.error("outbound_stuck_dialing", ...)` | yes |
| `outbound_webhook_writeoutbox_failed` (S3-8, `postCall.js:235`) | `log.error(...)` | yes |
| `outbound_webhook_enqueue_failed` (S3-8 fix round 1, `postCall.js:226`) | `log.error(...)` | yes |
| `outbound_webhook_reenqueue_failed` (S3-8 fix round 1, `internalRoutes.js:565`) | `log.error(...)` | yes |
| `outbound_trigger_enqueue_failed` (S3-9 fix round 1, `triggerRoute.js:386`) | `log.error(...)` | yes |
| `outbound_webhook_dead` (S3-8; fix wave W3 added `log.error`) | `log.error("outbound_webhook_dead", ...)` | yes |
| `outbound_secret_missing` (fix wave W3, boot-time check, `internalRoutes.js:~350`) | `log.error(...)` with `{key}` (never the value) | yes |
| `outbound_webhook_key_unavailable` (W3, first delivery attempt without CONNECTIONS_WEBHOOK_KEY) | `log.error(...)` | yes |
| `outbound_internal_dispatch_failed` (dispatch refused/failed, e.g. missing SUPPRESSION_HASH_KEY) | `log.error(...)` | yes |
| `outbound_postcall_run_failed` (post-call failed, e.g. missing SUPPRESSION_HASH_KEY once a suppression row exists — sim set A run 2) | `log.error(...)` | yes |

`outbound_secret_missing` firing right after the deploy means a secret was not mounted: STOP, mount
it (C2), redeploy. Without SUPPRESSION_HASH_KEY every opted-out call's post-call fails closed.

Memory `gcp-notices-go-nowhere`: no Essential Contacts existed on this org before that memory's own
fix, and a Cloud Monitoring alert needs its own channel regardless — create one explicitly.
```bash
# Confirm the destination address with the owner before running.
gcloud alpha monitoring channels create --project=$P \
  --display-name="Outbound stuck-dialing / webhook alerts" \
  --type=email --channel-labels=email_address=<OWNER_EMAIL>
# Note the returned channel resource name (projects/.../notificationChannels/NNNNNN) as $CHANNEL.

for m in outbound_stuck_dialing outbound_webhook_writeoutbox_failed outbound_webhook_enqueue_failed outbound_webhook_reenqueue_failed outbound_trigger_enqueue_failed outbound_webhook_dead outbound_secret_missing outbound_webhook_key_unavailable outbound_internal_dispatch_failed outbound_postcall_run_failed; do
  gcloud logging metrics create "$m" --project=$P \
    --description="lib/outbound: $m, logged via log.error" \
    --log-filter="resource.type=\"cloud_run_revision\" jsonPayload.event=\"$m\""
  gcloud alpha monitoring policies create --project=$P \
    --display-name="Outbound: $m" \
    --notification-channels=$CHANNEL \
    --condition-display-name="$m logged" \
    --condition-filter="resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/$m\"" \
    --condition-threshold-comparison=COMPARISON_GT --condition-threshold-value=0 \
    --condition-threshold-duration=0s \
    --aggregation-alignment-period=300s --aggregation-per-series-aligner=ALIGN_COUNT
done
```
**[AS RUN] The loop above was NOT run: its `--condition-threshold-*` / `--aggregation-*` flags do not
exist** in `gcloud alpha monitoring policies create` (checked against `--help`). Owner chose ONE
log-match policy instead (no log-based metrics): channel `notificationChannels/6677425848858041560`
(email nithinjd06@gmail.com), policy `alertPolicies/15114942414748467079` "Outbound: alertable error
logged", created with `--policy-from-file` = `{combiner: OR, conditions: [{conditionMatchedLog:
{filter: resource.type="cloud_run_revision" AND resource.labels.service_name="voice-uk-prod" AND
jsonPayload.event=(<the 10 events above, OR-ed>), labelExtractors: {event:
"EXTRACT(jsonPayload.event)"}}}], alertStrategy: {notificationRateLimit: {period: 300s}, autoClose:
1800s}, notificationChannels: [<channel>]}`. The filter was proven with `gcloud logging read` first.

**(Original note)** STOP and ask the owner: the `policies create` flags above are a DRAFT, never run against a real
Cloud Monitoring API in this session — read them back against `gcloud alpha monitoring policies
create --help` before running, and confirm firing on ANY occurrence in a 5-minute window is the
sensitivity wanted (every one of these counters is expected near zero in production).

**C8. Cloud Tasks: no new queue, no new IAM.** Checked both new enqueue paths directly:
`lib/outbound/tasks.js`'s `createWebhookDeliveryEnqueuer` (S3-8) is constructed in
`lib/outbound/internalRoutes.js:325` with `queuePath: cfg.tasksQueue, serviceAccountEmail:
cfg.tasksSa` — the SAME `OUTBOUND_TASKS_QUEUE`/`OUTBOUND_TASKS_SA` config the Part 1 dispatch
enqueuer already uses; `triggerRoute.js`'s enqueue call (S3-9 fix round 1) reuses the identical
`outboundDeps.enqueue` closure via `setEnqueue`, not a second queue or a second Cloud Tasks client.
**None needed.** The `outbound-dispatch` queue and the `outbound-tasks` service account created in
Section A2/A3 already cover both. Operational note, not a required change: this deploy adds a
delivery task per outbox row onto that SAME queue (`--max-dispatches-per-second=1
--max-concurrent-dispatches=5`, Section A3) — worth the owner knowing the queue now carries more
traffic than Part 1 sized it for, though nothing here requires a rate-limit change today.

**C9. R1 campaign config updates: S01b, S03, S10.** `TEMPLATES.speed_to_lead` now carries
`goal: "qualify_then_book"` + `why_allowed` by default (S3-6). Re-running the UNEDITED
`.superpowers/sdd/2026-09-24-outbound-part1/r1-config.mjs` (not touched by S3-6, per its own
report) already produces a config with both new required keys filled in — no script change needed.
Scenario numbers → campaign ids (`.superpowers/sdd/2026-09-24-outbound-part1/r1-ids.txt`): S01b (a
re-run of scenario 1's config, per that session's Ruling GL-8) → `ed6113b6-c458-4527-a968-57720aedd55c`,
S03 → `8b73d7d5-b08e-4e1c-b70e-2abc4f9efac1`, S10 → `859bf1ce-94c4-4f90-8748-adfa70b8f965`.
```bash
node .superpowers/sdd/2026-09-24-outbound-part1/r1-config.mjs 1     # -> R1-S01 config (used for S01b's campaign id)
node .superpowers/sdd/2026-09-24-outbound-part1/r1-config.mjs 3     # -> R1-S03 config
node .superpowers/sdd/2026-09-24-outbound-part1/r1-config.mjs 10    # -> R1-S10 config
```
For each (`<ID>` = the campaign id above, `<B64>` = that scenario's printed config), dry run first,
through the migrate job (same job, same shape as Section B):
```bash
gcloud run jobs execute vetra-migrate-uk-prod --project=$P --region=$R --wait \
  --args=scripts/outbound-admin.js,campaign,--phone,+18176011171,--config,<B64>,--campaign-id,<ID>
# then, with the owner's second YES:
gcloud run jobs execute vetra-migrate-uk-prod --project=$P --region=$R --wait \
  --args=scripts/outbound-admin.js,campaign,--phone,+18176011171,--config,<B64>,--campaign-id,<ID>,--confirm
```
**[AS RUN] The commands above are refused as written** — `campaign` validates `--name`,
`--template-key`, `--compliance-class` and `--audience` even on an update (the three immutable ones
are validated, then not written, M8a; `name` IS written). Run with, e.g. for S10:
`--args=scripts/outbound-admin.js,campaign,--phone,+18176011171,--name,R1-S10,--template-key,speed_to_lead,--compliance-class,solicited,--audience,business,--config,<B64>,--campaign-id,<ID>[,--confirm]`.
`<B64>` is the SECOND line `r1-config.mjs` prints (the first is the scenario label). All three went
to version 2 on 2026-09-29.

This writes a new `campaign_versions` row (version+1) on the existing campaign; it does not resume
or fire it. Resuming (`status --status active --confirm`) and firing are the phone-check session's
job — see `.superpowers/sdd/2026-09-27-outbound-stage3/next-session-prompt-stage3-deploy-and-phone-check.md`.

**C10. Rollback.**
```bash
gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00094-87t=100 --region=$R --project=$P
gcloud scheduler jobs pause outbound-sweep --location=$R --project=$P   # if anything dials unexpectedly
```
Migrations 046–050 stay (all confirmed additive/loosening in C4) — `96e356b` never reads any of the
five new/loosened columns or the three new routing tables, so it keeps working unmodified, the same
guarantee Part 1's own rollback relied on. The two new secrets and the webhook delivery queue
traffic are unused by the old revision and harmless.

## Section D: Stage 4 (deploy 3, DRAFT, YES-gated)

**Status: D0-D7 RUN 2026-09-30 (see [AS RUN] below); D8 not run.** Every command needs its own explicit YES. Stage 4
deploys ONLY after the 2026-09-30 phone check (window 08:00+ CDT) has been done and passed.

**2026-09-30: phone check ran, stage 4 NOT deployed (owner decision).** Hello: timing PASS, but the
assistant gave no reason for the call before asking questions (D-R2-1) and doubled part of a sentence
(D-R2-2). Silent: PASS. Gatekeeper: 10:00-next-day reschedule PASS, but a real defect (D-R2-3):
`confirm_identity` from the discarded stale reply to "Hello?" still ran during the opener clip
(`UNHEARD_REFUSED_TOOLS` in `lib/voice/live/index.js` covers only `end_call`/`request_transfer`), so
the gatekeeper was offered "a 30-minute discovery call". Root cause of the inbound-style behaviour:
the outbound prompt is the receptionist prompt plus an appended outbound block. Owner decision: give
outbound its OWN prompt (shared company rules + a separate outbound job prompt, one switch by
direction, inbound byte-identical) and fix D-R2-3, gate, then run this section ONCE with the new SHA
(not 2d02d11) and re-run the Hello + Gatekeeper calls
(`.superpowers/sdd/2026-09-29-outbound-stage4/next-session-prompt-fixes-then-deploy.md`). Owner pre-answers for that run: keep the Italian eve rule; D8 deploy backend + frontend,
read-first; D9 owner confirms no tenant tool webhook exists; D6 from the owner's handset, expect the
callback line (the handset has `waiting` outreach from the phone check).
**2026-09-30 (later): the fixes are BUILT and gated; this section now deploys `b4d462d`.** Outbound has
its own prompt (shared company rules in `services/gemini.js` + the outbound job prompt in
`lib/outbound/prompt.js`; `buildSystemInstruction` switches by direction; all 110 inbound prompt
snapshots byte-identical, and the Opus review compared old vs new inbound output over 87,780 inputs:
0 differences). D-R2-3 fixed (an unheard generation's `confirm_identity` is refused). Paid sims
P1-SIM-S5 ($0.31): reason before the first question 4/4, silent PASS, stop PASS, gatekeeper: a
GARBLED gatekeeper reply was still taken as "yes, it's me" in 2 of 5 runs -- owner decision: ship
prompt-only and WATCH it in the Gatekeeper call below (backlog LVX165). Ledger:
`.superpowers/sdd/2026-09-30-outbound-own-prompt/`. Re-test campaigns: NEW R2-Hello (S20) and
R2-Gatekeeper (S21), config from `r1-config.mjs 20|21` (call_reason "You filled in our enquiry
form about growing your clinic, so I'm following up on that."); S1b/S03/S10 stay paused.
Rollback target: `voice-uk-prod-00095-nhs` @`e451d91` (production today, `OUTBOUND_ENABLED=false`).
`SHA` = `b4d462d` (final code head of `feat/outbound-stage4`, base `e451d91`; later commits are
docs/spend JSON only — `git log --oneline b4d462d..HEAD -- . ':!docs' ':!scripts/probes/spend-gptlive.json' ':!.superpowers'`
must print nothing; if the branch HEAD is a later docs commit, build from HEAD, it carries the same code).

**[AS RUN] 2026-09-30 ~20:09-20:35 CDT: D0-D7 DONE, `b4d462d` is production.** Built from the main checkout at
HEAD `f6e5ca0` (docs-only after `b4d462d`), tag `b4d462d`, build `10dbc09d` all steps SUCCESS, digest
`sha256:5e78f6a3b377...`. D3: pending exactly `051`, preflight 13 ok. D4: `051` applied, pending none. D5:
revision **`voice-uk-prod-00096-n5p`** 100%, env diff = `GIT_COMMIT_SHA` only (scripted diff), `Build: b4d462d`,
boot clean. D6 (owner handset): `direction=inbound`, callback line recognised (S10 outreach), no ERROR. D7:
policy now 16 events, same channel. **D8 NOT RUN (owner):** the live dashboard backend is `e1419d9` (2026-09-08),
not `2d02d11`, so a backend deploy would ship 10 commits, including four outbound capability cards
(qualification / outcome / callback / opt_out) on every tenant's Settings page; deploy the dashboard later,
after hiding outbound-only packs there. D9: owner confirmed no tenant tool webhook. Doc fix: `policies
describe/update` take the BARE id `15114942414748467079`; `alertPolicies/<id>` doubles the path and 404s.
Re-test campaigns created (draft): S20 R2-Hello `c488edd2-8776-46d5-ad25-92d3032ce37f`, S21 R2-Gatekeeper
`d7766147-23d0-46cf-9c1c-ea855d874e4a`. Rollback target stays `voice-uk-prod-00095-nhs`.

**[AS RUN] R2 calls, 2026-10-01 ~10:11-10:25 CDT: Hello PASS (close not reached), Gatekeeper PASS.** A first
attempt at 20:42 CDT on 09-30 was refused `outside_floor` (no dial): the US floor
(`lib/outbound/legalFloor.js` `US_WINDOWS`) is Mon-Sat 08:00-20:00, Sun 12:00-20:00 local, so the effective
window for a US contact is 08:00-20:00 whatever the campaign window says. Hello (S20): confirmed, then the
`call_reason` sentence BEFORE the first question, the clinic-name question, the offer; the owner hung up before
the close; no phone-number ask, no "anything else", no doubled sentence. Gatekeeper (S21): the garbled
"He's out, try tomorrow at ten" produced NO `confirm_identity` at all, no reason, no offer; callback booked
(Cloud Task `scheduleTime` 2026-10-02T15:00:00Z = 10:00 CDT), outcome `callback_requested`. LVX165 did not
reproduce (N=1; watch stays). Both campaigns paused. Spend P1-LIVE-R2 $0.0763 (P1 $2.6626 / $10).
Ops notes: a resumed campaign's re-armed row waits the same 120 s grace before a forced sweep picks it up.

**What stage 4 changes for a caller.**
- (Outbound test calls only while `OUTBOUND_ENABLED=false`.) The assistant now follows an outbound
  call plan: confirm the person, say why it is calling in one sentence BEFORE any question, ask the
  campaign's questions, offer the next step, close without "anything else". It never asks for a
  phone number, never tells a gatekeeper the reason, and a polite "no thanks" ends the call. The
  reason is the campaign's new `call_reason` (optional; a neutral fallback otherwise). The tenant's
  inbound custom rules and capability notes no longer reach outbound calls (campaign `notes` do).
  Inbound calls are unchanged.
- A lead we tried to reach who rings us back within 14 days is recognised on the inbound call: the
  assistant knows why we rang, asks whatever qualification questions are still unanswered, and the
  waiting outreach is closed as `called_back` so no retry dials them mid-conversation. A normal
  inbound caller sees no change.
- A person who says "stop calling me" while our opener clip is still playing and then hangs up is no
  longer lost if the live model returned no transcript: the audio is transcribed once by Deepgram (EU
  endpoint) and the opt-out is honoured. If that also fails the lead is closed `held_for_review`
  (never silently re-dialled) and an ERROR is logged.
- EU numbers (27 member states) can now be dialled inside a strict window: Mon-Fri, 10:00-13:00 and
  14:00-20:00 in the called country's local time, no national public holidays, 19:00 end on the eve
  of a holiday. Neighbours, overseas territories and every other country code stay refused. GB and
  US are unchanged. Detail: `docs/outbound-eu-calling-floor.md`.
- A tenant's tool webhook now goes through the SSRF-vetted client: redirects are refused and the
  response is capped at 64 KiB (see D9).

**What stage 4 changes for Ilija (the operator).**
- Call log: a Direction filter (all / inbound / outbound), an outbound pill and an outcome pill on
  each card, and the qualification answers (and the outcome) in the call details. The CSV export
  gains Direction and Outcome columns (inserted mid-row, so anyone parsing by position must re-map).
- New outcome/close reason `held_for_review`: leads the system could not verify as "not an opt-out".
  They are closed, not retried; Ilija re-adds one by hand if it turns out fine. Watch the held rate
  in the pilot: a noise-only drain (a cough, then hang-up) also lands here.
- New alert emails for the three new error events (D7).
- Art. 15 (subject access) export now also covers the outbound tables.

**Inputs checked for this section (2026-09-30).** No new env var or secret this stage: `.env.example`
is byte-identical to `e451d91`, and no reviewed diff adds a `process.env`/`env.*` read outside tests
and scripts. `DEEPGRAM_API_KEY` is already mounted. One new migration: `051_outbound_held_for_review`.
Gate at the final code head `b4d462d` (2026-09-30): root 282 files / 6602 passed / 3 skipped / 1 todo
(run with `NODE_EXTRA_CA_CERTS=.superpowers/sdd/2026-09-29-outbound-stage4/norton-roots.pem` -- without it
the real-local-TLS tests fail on Norton's loopback re-signing on THIS machine only); test:db 43 files /
617 passed; census 63/63; dashboard backend 150 (only the generated schema line changed; frontend
untouched since `8ff4239`); inbound prompt snapshots unchanged; full corpus:sabotage at `b4d462d`: 60 v + exactly the 3 baseline x;
see `.superpowers/sdd/2026-09-30-outbound-own-prompt/progress.md`.
Earlier gate at `2d02d11`: root 280+1 files / 6457 passed / 5 skipped / 1 todo; test:db 43 / 617;
dashboard frontend 63, eslint 25 pre-existing, build OK. Paid sim S4-2
`outbound_stop_midclip_hangup`: PASS 11/11 via the Deepgram fallback at `fe18b76` (P1-SIM-S4, $0.05);
the later fix wave hardened the same path (hang-up before Live opens, read-back) without changing it.

```bash
export CLOUDSDK_CONFIG=~/.gcloud-vetra2
# This machine (Norton) also needs the Windows-roots CA bundle for gcloud:
export CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=~/.gcloud-vetra2/ca-bundle.pem   # or win-roots.pem, whichever the stage-3 deploy used
P=vetra-uk-edc8ca; R=europe-west2; SHA=b4d462d
SA_APP=voice-uk-prod@vetra-uk-edc8ca.iam.gserviceaccount.com
BASE_URL=https://voice-uk-prod-462445274080.europe-west2.run.app
IMG=us-central1-docker.pkg.dev/vetra-core-edc8ca/vetra/voice:$SHA
```

**D0. Preflight (read).** Three conditions, all must hold.
```bash
cd /c/Users/nithi/VetraTD/ai-phone-assistant          # the MAIN checkout, not a worktree
git status --porcelain --untracked-files=no           # expect empty
git rev-parse --short HEAD                            # expect $SHA
git ls-files --eol database/002_*.sql | head -3       # expect w/crlf (see D1)
gcloud run services describe voice-uk-prod --project=$P --region=$R \
  --format='value(status.latestReadyRevisionName,status.traffic)'   # expect voice-uk-prod-00095-nhs, 100%
gcloud run services describe voice-uk-prod --project=$P --region=$R --format=export > /tmp/stage4-before.yaml
```
Keep `/tmp/stage4-before.yaml`: D5's env diff compares against it. Also confirm with the owner that
the 2026-09-30 phone check has been done and PASSED. **STOP if it has not.**

**D1. Build the image from the MAIN checkout.** Production recorded the checksums of the main
checkout's CRLF working copies of `database/002`-`012` (`i/lf w/crlf`); an image built from an LF
worktree makes `migrate.js --status` fail with "An already-applied migration has been EDITED"
(Section A/C, and the C1 rebuild). Do not build from a gate worktree. Untracked files never enter the
image.
```bash
gcloud builds submit --config=cloudbuild.yaml --project=vetra-core-edc8ca \
  --service-account=projects/vetra-core-edc8ca/serviceAccounts/vetra-deployer@vetra-core-edc8ca.iam.gserviceaccount.com \
  --substitutions=_TAG=$SHA
```
Check: the build succeeds, all smoke steps pass, and `$IMG` exists in Artifact Registry.

**D2. Point the migrate job at the new image.**
```bash
gcloud run jobs update vetra-migrate-uk-prod --image=$IMG --project=$P --region=$R \
  --update-env-vars=OUTBOUND_TEST_ALLOWLIST=+14699338887
```

**D3. Status + preflight, read-only, BEFORE migrating.**
```bash
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/migrate.js,--status --project=$P --region=$R --wait
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/db-inspect.js,--outbound-preflight --project=$P --region=$R --wait
```
**STOP and ask the owner if `--status` shows anything pending other than EXACTLY
`051_outbound_held_for_review`** (file: `database/051_outbound_held_for_review.sql`), or exits 1 with
"EDITED" (wrong build source, see D1), or if any preflight table shows `MISMATCH`.

**D4. Apply 051.** It drops and re-adds `outreach_close_reason_check` with every existing value
(including 047's `missing_goal` and 048's `erased`, `no_legal_floor`) plus `held_for_review`; it
loosens a CHECK, so every existing row still satisfies it. Rehearsed locally: applied on top of 050,
idempotent on re-run, and the `schema.sql` fold matches.
```bash
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/migrate.js --project=$P --region=$R --wait
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/migrate.js,--status --project=$P --region=$R --wait   # expect pending: none
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/db-inspect.js,--outbound-preflight --project=$P --region=$R --wait   # every table ok
```
Order note: the migration runs BEFORE the service update (D5). The old revision never writes
`held_for_review`, so the loosened CHECK is harmless to it.

**D5. New revision.** No new env vars or secrets; only `GIT_COMMIT_SHA` changes.
```bash
gcloud run services describe voice-uk-prod --project=$P --region=$R \
  --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep -E "DEEPGRAM_REGION|OUTBOUND_ENABLED|OUTBOUND_TEST_ALLOWLIST"
```
**STOP and ask the owner if `DEEPGRAM_REGION=eu` is not set on the live revision.** S4-2 sends the
held caller audio (the words of a possible "stop calling me") to Deepgram; without the region switch
`deepgramEnvironment` falls back to the US endpoint, which is a data-residency change for a UK/EU
tenant. Only when confirmed:
```bash
gcloud run services update voice-uk-prod --image=$IMG --project=$P --region=$R \
  --update-env-vars=GIT_COMMIT_SHA=$SHA
```
Verify (read):
- New revision Ready, 100% of traffic, image `$SHA`; `curl -s $BASE_URL/` shows `Build: $SHA`.
- Env diff against `/tmp/stage4-before.yaml`: **empty except `GIT_COMMIT_SHA`** (no secret refs
  added or removed). `OUTBOUND_ENABLED` still `false`; `OUTBOUND_TEST_ALLOWLIST` still `+14699338887`;
  `DEEPGRAM_API_KEY` still mounted; `DEEPGRAM_REGION=eu`. **STOP on any other difference.**
- Note (review finding): the voice service runs with `cpu_idle=true`, so the post-hang-up Deepgram
  call runs with no request in flight. If it is CPU-throttled, the 5 s bound expires and the lead
  lands on the `held_for_review` branch (safe, but visible as ERRORs). No change is required; watch
  D7's alert for it.

**D6. Smoke.** One ordinary inbound call by the owner to +1 817 601 1171: the greeting, a question and
hang-up behave as before (callback recognition must not change a normal inbound call: the owner's own
handset is recognised as a callback only if an outreach to it is `waiting` and within 14 days, so
close or wait out any test outreach first, or expect the callback line).
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="voice-uk-prod" AND resource.labels.revision_name="<NEW_REVISION>"' \
  --project=$P --freshness=15m --limit=50 --format='value(jsonPayload.event,severity)'
```
Check: boot log has no `outbound_internal_routes_disabled` and no `outbound_secret_missing`; the
call's `live_call_summary` says `direction:"inbound"`; no `outbound_callback_recognized` and no
`outbound_callback_lookup_failed` lines for an ordinary caller. **STOP and roll back (D10) on any
ERROR from the new revision.**

**D7. Alerting: add the six new events to the ONE log-match policy.** The policy is
`alertPolicies/15114942414748467079` "Outbound: alertable error logged" (email channel
`notificationChannels/6677425848858041560`), filter on `jsonPayload.event`, currently the 10 events
in C7. Add, all logged with `log.error`:
`outbound_optout_unverified_hold` (`lib/outbound/postCall.js`, a lead closed held_for_review),
`outbound_optout_unverified_marker_failed` (`lib/voice/live/index.js`, `postCall.js`; the marker could
not be written, the lead may be re-dialled), `outbound_holiday_table_stale`
(`lib/outbound/legalFloor.js`; the EU holiday table is out of range for a country/year, calls to it
are refused; the table covers 2026-2030, a hard cliff at 2031-01-01), and from the final fix wave:
`outbound_optout_unverified_hint_dropped` (`lib/voice/live/index.js`; the in-process hold hint could
not reach post-call and the marker retry ran), `dsr_export_failed` (`server.js`; an Art. 15 export
failed — cause class only, e.g. a missing SUPPRESSION_HASH_KEY), `qualification_answer_no_callsid`
(`capabilities/qualification.js`; logged via `log.error` with a warn severity field — it matches the
policy by name and should stay at zero).
Not added (warn/info only): `outbound_callback_close_skipped`, `outbound_callback_lookup_failed`,
`outbound_clip_hold_stt` (info), `outbound_clip_hold_drain_row_unverified` (info),
`outbound_clip_hold_voiced_dropped`.

First prove the new filter matches (read; it should print zero or historical rows, not an error):
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="voice-uk-prod" AND jsonPayload.event=("outbound_optout_unverified_hold" OR "outbound_optout_unverified_marker_failed" OR "outbound_holiday_table_stale" OR "outbound_optout_unverified_hint_dropped" OR "dsr_export_failed" OR "qualification_answer_no_callsid")' \
  --project=$P --freshness=30d --limit=5
gcloud alpha monitoring policies describe alertPolicies/15114942414748467079 --project=$P --format=json > /tmp/policy-before.json
```
Edit `/tmp/policy-before.json` into `/tmp/policy-after.json`: in
`conditions[0].conditionMatchedLog.filter` extend the `jsonPayload.event=(...)` OR-list with the
six names; keep `labelExtractors`, `alertStrategy` and `notificationChannels` exactly as they are
(drop only the read-only `name`/`creationRecord`/`mutationRecord` fields if the API rejects them).
Then, with the owner's YES:
```bash
gcloud alpha monitoring policies update alertPolicies/15114942414748467079 --project=$P \
  --policy-from-file=/tmp/policy-after.json
gcloud alpha monitoring policies describe alertPolicies/15114942414748467079 --project=$P --format='value(conditions[0].conditionMatchedLog.filter)'
```
Check: the describe output lists 16 events and the same channel. **STOP if `update` reports the
policy replaced with a different channel or condition count.** (Same caveat as C7: read the flags
against `gcloud alpha monitoring policies update --help` first; only `--policy-from-file` has been
used against this policy so far.)

**D8. Dashboard (call log, S4-4). DRAFT: CONFIRM THE TARGET WITH THE OWNER BEFORE ANY COMMAND.**
*2026-09-30 note (read-first rule "STOP if more than S4-4"):* since `2d02d11` the dashboard tree gains
exactly ONE line beyond S4-4 -- `AI-phone-dashboard/backend/src/generated/campaignSchema.json`
`"call_reason": 200` (the generated schema copy, drift-tested; no dashboard code reads it yet). Show
the owner this before D8 and let them decide; it is inert data, not a feature.
The call log change spans the dashboard backend (`AI-phone-dashboard/backend/src/routes/calls.js`,
the `direction` filter) and the frontend. The voice image does not contain them. Deploy routes found
in the repo (none verified on attempt 2 for this stage; the cutover doc says the 2026-08-31 deploy
was a LOCAL build plus `deploy-hosting.js`, and `cloudbuild.frontend.yaml` "has not run on attempt
2"):
```bash
# Backend image (source root is the backend dir; .gcloudignore excludes AI-phone-dashboard from the root):
gcloud builds submit AI-phone-dashboard/backend --config=cloudbuild.dashboard.yaml \
  --project=vetra-core-edc8ca \
  --service-account=projects/vetra-core-edc8ca/serviceAccounts/vetra-deployer@vetra-core-edc8ca.iam.gserviceaccount.com \
  --substitutions=_TAG=$(git rev-parse --short HEAD)
gcloud run services update dashboard-api-uk-prod \
  --image=us-central1-docker.pkg.dev/vetra-core-edc8ca/vetra/dashboard:<TAG> --project=$P --region=$R
# Frontend: the APP target (never publish to Firebase without VITE_BUILD_TARGET=app; docs/app-domain-cutover.md)
cd AI-phone-dashboard/frontend
VITE_BUILD_TARGET=app VITE_API_URL=<dashboard-api url> VITE_FIREBASE_API_KEY=... \
VITE_FIREBASE_AUTH_DOMAIN=... VITE_FIREBASE_PROJECT_ID=... npx vite build
grep -rl "landing-hero-cta" dist/assets/*.js && echo "ABORT: marketing build"
grep -rl "localhost:3001"   dist/assets/*.js && echo "ABORT: localhost baked in"
node scripts/deploy-hosting.js --dir dist --site vetra-core-edc8ca --project vetra-core-edc8ca
```
**STOP and ask the owner:** (a) which backend deploy route is current (the image name/tag in the
`gcloud run services update` line above is a placeholder: read it from
`gcloud run services describe dashboard-api-uk-prod` first, and note the dashboard API service may
live in project `vetra-uk-edc8ca` while the image registry is `vetra-core-edc8ca`); (b) whether the
frontend goes to Firebase Hosting `vetra-core-edc8ca` (app target) and whether `vetratd.com` on Vercel
auto-deploys from `main` (merging this branch to `main` rebuilds the MARKETING site; that is a
separate decision); (c) the real values of the `VITE_*` variables (public, but not in this repo).
Deploy the backend BEFORE the frontend (an old backend ignores `direction`, a new frontend would show
unfiltered rows). Without D8, everything else in this section still works; only Ilija's Direction
filter, pills and answers are missing.

**D9. Owner pre-deploy check: tenant tool-webhook URLs that redirect.** S4-3 moved the inbound tool
webhook (`integrations/webhook.js`) onto `fetchVetted`, which REFUSES redirects (so a URL that today
answers `301`/`302` to its real address will fail with "The endpoint redirected the request.") and
caps the body at 64 KiB ("The response was too large."). Before D5, list every enabled webhook
integration and test each URL for a redirect. The read path is the migrate job's `db-inspect.js`,
but it has NO integrations listing today (its flags: `--counts`, `--business`, `--calls`,
`--appointments`, `--recording-claims`, `--outbound-preflight`, `--status`). **Could not be
determined from the repo:** how to list `integrations` rows read-only without a code change. Options
for the owner: (1) add a tiny `--webhooks` read to `db-inspect.js` (prints `business_id`, `name`,
`enabled` and the URL host only, never headers or bodies) and build it into the D1 image, or
(2) ask each tenant contact. The query it would run:
```sql
SELECT business_id, name, enabled, config->>'url' AS url FROM integrations WHERE provider = 'webhook';
```
Then for each URL (from the owner's machine, no tenant data sent): `curl -sI -o /dev/null -w '%{http_code} %{redirect_url}\n' <url>`.
Any `3xx` means: fix the stored URL to the final address BEFORE D5. **STOP and ask the owner if any
URL redirects.** Note the `provider` value and `config.url` key are read from
`integrations/webhook.js` (`config.url`) and `database/schema.sql`; confirm the `provider` literal
against a real row.

**D10. Rollback.**
```bash
gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00095-nhs=100 --region=$R --project=$P
gcloud scheduler jobs pause outbound-sweep --location=$R --project=$P   # only if anything dials unexpectedly
```
Migration 051 can STAY: it only widens the CHECK, `e451d91` never reads or writes `held_for_review`,
and any row already closed `held_for_review` is a lead the old revision will not touch (closed
outreach rows are not dialled). The three alert events are simply never emitted by the old image;
leave the policy as it is. Dashboard: roll the backend back to its previous revision with
`gcloud run services update-traffic dashboard-api-uk-prod` and republish the previous frontend; an
old dashboard ignores the new fields, so this is only needed if the new call log misbehaves.

**D11. What `OUTBOUND_ENABLED=true` still needs (NOT part of this deploy).** Stage 4 leaves outbound
OFF. Turning it on for anyone but the owner's handset additionally needs:
- Test round 2 (the owner-run phone rounds against the stage-4 revision, including a callback: ring
  the handset, let it go unanswered or hang up, ring back, and confirm the callback recognition line;
  and one EU-number dry run of the calling-hours floor).
- The Ilija setup session (his campaigns, calling windows, consent basis, webhook URL).
- D1/T1 verified live (the stage-3 hold-and-drain and transfer paths on a real call; the S4-2 sim
  proved the mid-clip fallback against the real Deepgram API on the local harness, not on production).
- Owner sign-offs, none applied by the software: the EU values in `docs/outbound-eu-calling-floor.md`
  (its 16-item list: e.g. Ireland/Spain/Italy/Netherlands/Portugal hours, B2B exemptions, France's
  opt-in rule and 4-calls-per-30-days cap, de-facto holidays such as Swedish Midsummer Eve), and the
  NANPA area-code list (`US_MAINLAND_NANP` unchanged; nationalnanpa.com was unreachable, 0 changes
  verified, 18 likely-missing codes such as 510, 562, 812 are UNVERIFIED in
  `.superpowers/sdd/2026-09-29-outbound-stage4/nanpa-check.md`).
- A decision on the 2031 cliff: the EU holiday table ends 2030-12-31; after that every EU contact is
  refused `no_legal_floor` (fails closed). Regenerate before then
  (`scripts/outbound/gen-eu-holidays.mjs`, date-holidays@3.37.0).

## Section E: the AI answers live (deploy 4, DRAFT, YES-gated)

**Status: E0-E5 RUN 2026-10-01 ~17:15-17:35 CDT; E6 2 of 3 calls PASS, the Hold call FAILED (see [AS RUN]).**

**[AS RUN] 2026-10-01 (owner: "do everything now").** E0 PASS. E1 build `98e6ac49` SUCCESS, `voice:f1f6d50` digest
`sha256:bbe2aa29...`. E2 pending: none. E3 **`voice-uk-prod-00097-4f5`** 100%, `Build: f1f6d50`, env diff = image +
`GIT_COMMIT_SHA` only, boot clean. E5 policy 18 events. E4 smoke PASS (inbound, callback line, no ERROR). New test
campaigns S22 R3-Hello `ba18bc95`, S23 R3-Gatekeeper `09f175e1`, S24 R3-Hold `7cb62d32` (all PAUSED after their call).
- Hello PASS: first reply 1,457 ms after speech end with the AI intro + name check; reason before the first
  question; the read-back REFUSED "dust khane", read back, corrected, saved "Best Klinik" after the yes.
- Gatekeeper PASS: intro, "returning Nithin's enquiry", no reason/confirm/offer, callback task 10:00 CDT next day.
- Hold FAIL, two defects: (A) the f1f6d50 tool-reply wording made the AI re-introduce itself straight after
  "Sure, thank you." (Live continues the turn after a tool reply); (B) AMD `machine_end_beep` 29 s into the call
  (business greeting + hold-music beep) -> voicemail branch -> no clip -> call hung up mid-hold (pre-existing;
  with a clip it would have played the voicemail into the hold). Owner: fix both next session, redeploy, re-run
  the Hold call. Production stays on 00097-4f5 (outbound OFF; inbound fine). Rollback target `00096-n5p`.

Previous status: DRAFT 2026-10-01. Every command needs its own explicit YES.
Spec `docs/superpowers/specs/2026-10-01-outbound-live-first-line-design.md`, plan
`docs/superpowers/plans/2026-10-01-outbound-live-first-line.md`, ledger
`.superpowers/sdd/2026-10-01-outbound-live-first-line/progress.md` (every ruling made during the build).
`SHA` = f1f6d50 (final code head of `feat/outbound-stage4`; later commits must be docs/spend only --
`git log --oneline f1f6d50..HEAD -- . ':!docs' ':!scripts/probes/spend-gptlive.json' ':!.superpowers'` prints
nothing). Rollback target: `voice-uk-prod-00096-n5p` @`b4d462d` (production today, `OUTBOUND_ENABLED=false`).

**What changes for the person we call (outbound test calls only while `OUTBOUND_ENABLED=false`).**
- No recorded opener. The AI's own live reply is the first thing heard: it answers what they said, says
  "this is Ava, an AI assistant calling from {business}", and checks it is the right person unless they
  already said so (never the reason before that). Measured on real calls: ~1.5-1.8 s after they stop.
- They say nothing: the AI says "Hello?" heard ~3 s after the answer; then the usual silence ladder.
- "Hold on, I'll get him": "Sure, thank you.", then silence (no nudges, nothing said to hold music, nothing
  the model says on hold reaches the line) until a person speaks; it then introduces itself again; 120 s cap
  (call ends, outcome `other`, note "hold timeout", retry schedule applies).
- A campaign question marked `confirm` is read back before it is saved (max 2 refused saves, then saved and
  logged `qualification_answer_uncertain`). R2 configs 20/21 mark `clinic_name`.
- `speed_to_lead`'s default opener is now "Hi, it's {persona_name}, an AI assistant from {business_name}. Is that
  {first_name}?" (the spec's longer sentence broke the 120-character budget for business names of 23+ characters; this
  keeps the old 45-character capacity). Existing campaigns keep their own opener; in live mode it is rendered INTO the
  prompt as the intro (used only if it says "AI" and names the business).
- "stop calling me" then a hang-up before Live transcribed it: the same Deepgram one-shot (EU) on the
  buffered audio as in clip mode, else `held_for_review`.
- Inbound: unchanged (110 prompt snapshots byte-identical). Clip mode (`OUTBOUND_FIRST_SPEAKER=clip`): its
  prompt and tool list are byte-identical to `b4d462d` (pinned by the `speed-to-lead-clip` snapshots).

**Inputs checked.** No migration. No new env var or secret: `OUTBOUND_FIRST_SPEAKER` already exists (unset
or `live` = the new default; `clip` = the rollback; anything else = clip + a warn log). `.env.example`
gains only a comment. Gate: root 286 files all green (6,770 passed / 3 skipped / 1 todo at 68adfba; at 531b869 the run
was reaped by Claude Code for memory just after its last file -- every one of the 286 per-file lines is a pass, the
summary line never printed), test:db 43 files / 618 passed at 976c4d9 (code = 531b869), census 63/63,
liveCorpusReplay 164/164, corpus:sabotage skipped (no gate file changed), outbound prompt snapshots: clip
byte-identical to b4d462d, inbound unchanged. f1f6d50 changes one tool-reply string after that (its one pinning test
updated; targeted 264 green). Paid sims P1-SIM-S6 ~$0.343 in all (sims report in the ledger dir).

```bash
export CLOUDSDK_CONFIG=~/.gcloud-vetra2
export CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=~/.gcloud-vetra2/ca-bundle.pem
P=vetra-uk-edc8ca; R=europe-west2; SHA=f1f6d50
BASE_URL=https://voice-uk-prod-462445274080.europe-west2.run.app
IMG=us-central1-docker.pkg.dev/vetra-core-edc8ca/vetra/voice:$SHA
```

**E0. Preflight (read).** As D0, expecting `voice-uk-prod-00096-n5p` at 100%. Then the one value this
deploy depends on:
```bash
gcloud run services describe voice-uk-prod --project=$P --region=$R \
  --format='value(spec.template.spec.containers[0].env)' | tr ';' '\n' | grep -E "OUTBOUND_FIRST_SPEAKER|OUTBOUND_ENABLED|DEEPGRAM_REGION"
gcloud run services describe voice-uk-prod --project=$P --region=$R --format=export > /tmp/stageE-before.yaml
```
`OUTBOUND_FIRST_SPEAKER` must be ABSENT or `live`. **STOP and ask the owner if it is `clip`** (the new
image would keep playing the recording) **or any other value** (a typo falls back to clip, with
`outbound_first_speaker_invalid` warnings). `OUTBOUND_ENABLED=false`, `DEEPGRAM_REGION=eu` as before.

**E1. Build from the MAIN checkout** (CRLF migration checksums -- D1's reason):
```bash
gcloud builds submit --config=cloudbuild.yaml --project=vetra-core-edc8ca \
  --service-account=projects/vetra-core-edc8ca/serviceAccounts/vetra-deployer@vetra-core-edc8ca.iam.gserviceaccount.com \
  --substitutions=_TAG=$SHA
```

**E2 = D2/D3 minus the migration.** No D3/D4: nothing pending. Read-only check that this is still true:
```bash
gcloud run jobs update vetra-migrate-uk-prod --image=$IMG --project=$P --region=$R
gcloud run jobs execute vetra-migrate-uk-prod --args=scripts/migrate.js,--status --project=$P --region=$R --wait   # expect pending: none
```
**STOP if anything is pending.**

**E3. New revision.** Only `GIT_COMMIT_SHA` changes.
```bash
gcloud run services update voice-uk-prod --image=$IMG --project=$P --region=$R --update-env-vars=GIT_COMMIT_SHA=$SHA
```
Verify as D5: Ready, 100%, `Build: $SHA`, env diff against `/tmp/stageE-before.yaml` empty except
`GIT_COMMIT_SHA`. **STOP on any other difference.**

**E4. Smoke = D6** (one ordinary inbound call to +1 817 601 1171; `direction:"inbound"`, no ERROR).

**E5. Alerting (D7 shape): add the two new ERROR events to the ONE policy** (bare id
`15114942414748467079` -- `alertPolicies/<id>` doubles the path and 404s): `outbound_disclosure_missing`
(`lib/voice/live/index.js`: the first live reply did not say it is an AI) and `outbound_live_unresponsive`
(`lib/outbound/liveFirstLine.js`: Live never answered, the call was ended). 16 -> 18 events.
Not added (warn/info): `outbound_first_reply_slow` (warn: > 2 s from the end of speech),
`outbound_first_reply`, `outbound_hold_*`, `outbound_silence_hello`, `outbound_live_early_audio_stt`,
`qualification_answer_uncertain`, `outbound_first_speaker_invalid` (warn).
```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="voice-uk-prod" AND jsonPayload.event=("outbound_disclosure_missing" OR "outbound_live_unresponsive")' --project=$P --freshness=30d --limit=5
gcloud alpha monitoring policies describe 15114942414748467079 --project=$P --format=json > /tmp/policy-before.json
# edit -> /tmp/policy-after.json (extend the jsonPayload.event OR-list only), then with the owner's YES:
gcloud alpha monitoring policies update 15114942414748467079 --project=$P --policy-from-file=/tmp/policy-after.json
gcloud alpha monitoring policies describe 15114942414748467079 --project=$P --format='value(conditions[0].conditionMatchedLog.filter)'   # expect 18 events, same channel
```

**E6. Real calls (owner's US handset, 08:00-20:00 CDT -- the US floor, not 21:00).** Campaigns S20/S21
(paused; resume one at a time; recreate from `r1-config.mjs 20|21` if `clinic_name.confirm` is wanted on
the Hello call) and a hold campaign (S20's config is fine):
1. **Hello** -- answer, say "Hello?": first sound is the AI ~1.5-2 s after you stop, with "AI assistant",
   the business and "am I speaking with Nithin?"; confirm; reason before the first question; give a clinic
   name and expect it read back. Then once say nothing on pickup: "Hello?" at ~3 s.
2. **Gatekeeper** -- "He's out, try tomorrow at ten": intro, no reason, no identity confirmed, callback 10:00
   next day.
3. **Hold-transfer** -- "Hold on, I'll get him" + 20-30 s of silence or music (try one with sung words),
   then "Hi, it's Nithin": "Sure, thank you.", silence throughout, then the intro again.
Read per call: `outbound_first_reply` (`from_speech_end_ms`), `outbound_hold_entered/released`,
`outbound_disclosure_missing` (expect none), the attempt row's `silent` (expect false).
What the paid sims (P1-SIM-S6, `.superpowers/sdd/2026-10-01-outbound-live-first-line/sims-report.md`) did NOT
prove, so these calls must: (a) the re-intro after a hold -- hold_transfer-3 (all hold fixes in) held cleanly
(10 s, 0 AI frames) but the new person got the reason with NO intro (`outbound_disclosure_missing` fired; 1 of 2
hold runs); f1f6d50 puts the restart-with-intro rule in wait_on_hold's reply, unverified by a sim -- the hold call is
its first real check (expect "Hi Nithin, this is Ava, an AI assistant ..." after the hold, and no
`outbound_disclosure_missing`); (b) the silent pickup: sims gave the full intro once, "Hello?" (2.95 s) once --
owner accepts either.

**E7. Rollback.** Fastest, no image change: `--update-env-vars=OUTBOUND_FIRST_SPEAKER=clip` (today's
recording returns: the dispatcher renders the opener again from the next dial; the clip prompt and tools
are byte-identical to `b4d462d`). Not byte-identical for campaigns CREATED from the new default template: their
recorded line is the new intro wording (S20/S21 and every older campaign keep their own opener). Or the previous revision:
```bash
gcloud run services update voice-uk-prod --project=$P --region=$R --update-env-vars=OUTBOUND_FIRST_SPEAKER=clip
gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00096-n5p=100 --region=$R --project=$P
```
No migration to undo. The two alert events are simply never emitted by the old image.

**Before any real lead (not this deploy):** the UK reading of the 2-second rule (from the END of the
person's speech, which also decides the `silent` flag and its 72 h hold -- ruling R8) goes to counsel with
the other items in `docs/outbound-eu-calling-floor.md`.

## Section F: the Hold-call fixes (deploy 5, DRAFT, YES-gated)

**Status: F0-F4 RUN 2026-10-01 ~23:00-23:55 CDT (owner YES for F1-F3); F6 Hold call PASS 2026-10-02 11:19 CDT.**

**F6 [AS RUN] 2026-10-02.** Call A (S24, CA1ff2c6...): owner answered "Hello" -- no hold exercised; booked a test
discovery call (Mon 5 Oct 4:30 PM, US test tenant; owner to cancel). Call B, the Hold test (S22 resume re-armed
yesterday's Hello outreach, CAc3a400...): PASS -- first reply 1,297 ms with the AI intro; "Hold on a sec" ->
wait_on_hold -> only "Sure, thank you."; 50.4 s hold, nothing said to the music; AMD `machine_end_other` at 38 s
**ignored** (`outbound_amd_ignored_conversation`) -- no hang-up; after the hold "Hi Nithin, this is Ava, an AI
assistant calling from Digile Media"; no `outbound_disclosure_missing`; outcome qualified_no_booking -> outreach
closed, no redial; 0 ERROR. S22/S24 paused.

**[AS RUN] 2026-10-01.** F0 PASS (00097-4f5 100%, OUTBOUND_FIRST_SPEAKER absent, OUTBOUND_ENABLED=false,
DEEPGRAM_REGION=eu). F1 build `3c9dd1a4` SUCCESS, `voice:a2aa121` digest `sha256:becde991...`. F2 pending: none
(applied 50). F3 **`voice-uk-prod-00098-278`** 100%, Ready, `GET /` -> `Build: a2aa121`, env diff = image +
`GIT_COMMIT_SHA` (+ nonce) only, boot clean, no ERROR. F4 smoke PASS (CAd152b7..., `direction` inbound,
`outbound_callback_recognized` = the waiting test outreach, `postcall_verify` ok, no ERROR; WARN
`live_repeated_phrase` + `live_debug_transcript_enabled` pre-existing). Gate at a2aa121: corpus:sabotage 60 v + the 3
baseline x; root 285/286 files in the gate worktree (the 1 needs gitignored caller audio; passes in the main tree);
test:db 43/626 @7e53a04; census 63/63. Rollback target `voice-uk-prod-00097-4f5`.
`SHA` = a2aa121 (code head of `feat/outbound-stage4`; later commits must be docs/spend only --
`git log --oneline a2aa121..HEAD -- . ':!docs' ':!scripts/probes/spend-gptlive.json' ':!.superpowers'` prints
nothing). Production today: `voice-uk-prod-00097-4f5` @f1f6d50, `OUTBOUND_ENABLED=false`. Rollback target:
`voice-uk-prod-00097-4f5` (or `00096-n5p`, or `OUTBOUND_FIRST_SPEAKER=clip`). Ledger: the "Hold fixes session"
block in `.superpowers/sdd/2026-10-01-outbound-live-first-line/progress.md` (rulings R33-R40).

**What changes for the person we call (outbound test calls only while `OUTBOUND_ENABLED=false`).**
- "Hold on": the AI says "Sure, thank you." and nothing more (the f1f6d50 early re-intro is gone). When the person
  comes back, Live's own answer releases the hold if their speech started after >= 1 s of quiet; otherwise their
  words do (as before). The AI then introduces itself again: the first `confirm_identity` after a hold runs with
  "Introduce yourself first" at the head of its reply (sim P1-SIM-S7 #3 PASS).
- A late AMD "machine" verdict after a real exchange (measured on audio, `calls.answers._exchanged`) is ignored:
  no hang-up mid-hold, no voicemail over a live call (`outbound_amd_ignored_conversation`, info). Clip mode never
  writes the marker, so the rollback keeps today's AMD behaviour.
- "I've scheduled a callback for ..." after a successful `schedule_callback` is no longer an unbacked-claim alert
  (live gate + post-call); a booking claim beside it still is.
- No auto-redial after a real conversation with the confirmed person, unless they asked for or booked a callback;
  a gatekeeper-only talk and a hold timeout keep the retry schedule.
- Inbound: unchanged (every change is gated on an outbound call).

**Inputs checked.** No migration (only `calls.answers` keys `_exchanged`, `_identity_confirmed`). No new env var
or secret. New warn-level event `outbound_amd_exchange_check_failed` (not added to the alert policy; ask).
Gate: root @b22c0a5 286 files / 6,852 passed; after the review fix pass + gate: targeted 66 files / 2,601,
test:db 43 / 626, census 63/63; corpus:sabotage + root at a2aa121 -- see [AS RUN]. Paid sims P1-SIM-S7 $0.1267.

```bash
export CLOUDSDK_CONFIG=~/.gcloud-vetra2
export CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=~/.gcloud-vetra2/ca-bundle.pem
P=vetra-uk-edc8ca; R=europe-west2; SHA=a2aa121
IMG=us-central1-docker.pkg.dev/vetra-core-edc8ca/vetra/voice:$SHA
```

**F0. Preflight (read)** as E0: `voice-uk-prod-00097-4f5` at 100%; `OUTBOUND_FIRST_SPEAKER` absent,
`OUTBOUND_ENABLED=false`, `DEEPGRAM_REGION=eu`; export `/tmp/stageF-before.yaml`.
**F1. Build from the MAIN checkout** (E1's command, `_TAG=$SHA`).
**F2. Migrate job image + `--status`** (expect pending: none; STOP otherwise).
**F3. New revision**, only `GIT_COMMIT_SHA` changes; verify Ready, 100%, `Build: $SHA`, env diff against
`/tmp/stageF-before.yaml` = image + `GIT_COMMIT_SHA` only.
**F4. Smoke** = one inbound call from the owner's handset (`direction:"inbound"`, no ERROR).
**F6. The Hold call (owner's US handset, 08:00-20:00 CDT).** S24 R3-Hold `7cb62d32` (paused): dry-run then
`status active` via the migrate job (`r1-job.sh`), `r1-fire.sh 24`, pause right after. Owner: "Reception?" ->
"Hold on, I'll get him" -> 20-30 s of music with a beep -> "Hi, it's Nithin". Expect: intro + ask for Nithin ->
"Sure, thank you." + silence -> no hang-up -> the intro again -> no `outbound_disclosure_missing`; read
`outbound_hold_*`, `outbound_hold_intro_prompted`, `outbound_amd*` by callSid.
**F7. Rollback**: `gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00097-4f5=100
--region=$R --project=$P`. No migration to undo; the new `calls.answers` keys are inert to the old image.

## Section G: receptionist fixes from the 2026-10-02 calls (deploy 6, DRAFT, YES-gated)

**Status: G0-G4 RUN 2026-10-02 ~15:30-16:12 CDT (owner YES for G1-G4).**

**[AS RUN] 2026-10-02.** G0 PASS (00098-278 100%, OUTBOUND_FIRST_SPEAKER absent, OUTBOUND_ENABLED=false,
DEEPGRAM_REGION=eu, stageG-before.yaml in the session scratchpad). G1 build `bab6daad` SUCCESS (30 s),
`voice:b772acb` digest `sha256:11e4e824...`. G2 migrate job -> b772acb, execution `dd74h`: pending none / applied
50. G3 **`voice-uk-prod-00099-lkq`** 100%, Ready, `GET /` -> `Build: b772acb`, env diff = image + `GIT_COMMIT_SHA` +
nonce only, no boot ERROR. G4 smoke PASS (CAfd993a...a6364722, 21:10Z): inbound, greeting -> answer -> "anything
else?" -> goodbye, `end_call` refused once then allowed (ask gate), 0 `record_answer`, `postcall_verify` ok; the
handset matched S20's waiting outreach `b9d70e34` (`outbound_callback_recognized`, closed called_back) and no
leftover question was asked; WARN `live_debug_transcript_enabled` (pre-existing) + `live_greeting_respoken` (1 cut).
Gate at b772acb: corpus:sabotage 67 rows = 64 v + the 3 baseline x; root 285/287 files in the gate worktree (1
worktree-only, 1 skipped), 6,947 tests; test:db 43/629; census 67/67. Rollback target `voice-uk-prod-00098-278`.

`SHA` = b772acb (code head of `feat/outbound-stage4`; later commits must be
docs/spend/ledger only -- `git log --oneline b772acb..HEAD -- . ':!docs' ':!scripts/probes/spend-gptlive.json'
':!.superpowers'` prints nothing). Production today: `voice-uk-prod-00098-278` @a2aa121, `OUTBOUND_ENABLED=false`.
Rollback target: `voice-uk-prod-00098-278`. Ledger: the "Receptionist fixes 2026-10-02" block in
`.superpowers/sdd/2026-10-01-outbound-live-first-line/progress.md`.

**What changes for callers (inbound and outbound).**
- A one-word yes the transcript wrote in another language ("Ja.", "bien", "Ah, ya.", "Mhm.", "go on"), when it IS
  the caller's whole turn and not a question, now counts as agreement to a read-back (CA1ff2c6, CAffb5c7). Never
  inside a sentence; a negation still wins.
- A write the write-order ceiling released and another gate then held (spelling, qualification, requirements) is
  no longer refused again by the write-order gate on its retry (CA1ff2c6 102.2 s). A completed action clears that
  state with the stash.
- Outbound, booking for the verified contact: full name on file -> booked under it, **no name or spelling
  question** (`outbound_name_from_file`); first name only -> asks the **surname** only
  (`outbound_surname_spell_asked`); someone else's name, a new surname, or inbound -> unchanged.
  `outbound-admin trigger --last-name` sets the surname (migrate job image).
- Returned call (inbound lead whose outreach is waiting): the leftover campaign questions are asked only if they
  rang back about our call or to book, and are **dropped entirely when they already have an upcoming
  appointment** (`outbound_callback_questions_suppressed`). Inbound with no waiting outreach: byte-identical.

**Inputs checked.** No migration (`contacts.last_name` exists since 042). No new env var or secret. New counters
only (no new ERROR events, alert policy unchanged). Paid sim P1-SIM-S8 $0.0924 (booking with the name on file:
booked "Sam Shah", no spelling ask). Gate at b772acb: see [AS RUN].

```bash
export CLOUDSDK_CONFIG=~/.gcloud-vetra2
export CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=~/.gcloud-vetra2/ca-bundle.pem
P=vetra-uk-edc8ca; R=europe-west2; SHA=b772acb
IMG=us-central1-docker.pkg.dev/vetra-core-edc8ca/vetra/voice:$SHA
```

**G0. Preflight (read)** as E0: `voice-uk-prod-00098-278` at 100%; `OUTBOUND_FIRST_SPEAKER` absent,
`OUTBOUND_ENABLED=false`, `DEEPGRAM_REGION=eu`; export `/tmp/stageG-before.yaml`.
**G1. Build from the MAIN checkout** (E1's command, `_TAG=$SHA`; CRLF migration checksums).
**G2. Migrate job image + `--status`** (expect pending: none; STOP otherwise). This image is also the first with
`outbound-admin trigger --last-name`.
**G3. New revision**, only `GIT_COMMIT_SHA` changes; verify Ready, 100%, `Build: $SHA` from `GET /`, env diff
against `/tmp/stageG-before.yaml` = image + `GIT_COMMIT_SHA` only. STOP on any other difference.
**G4. Smoke** = one inbound call from the owner's handset to +1 817 601 1171 (`direction:"inbound"`, no ERROR;
if an outreach is waiting for the handset, expect the returned-call line).
**G5. Saturday test round** = `docs/superpowers/plans/2026-10-03-saturday-test-round.md`.
**G6. Rollback**: `gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00098-278=100
--region=$R --project=$P`. No migration to undo. A surname set with `--last-name` stays on the contact and is
inert to the old image.

## Section H: batch-2 receptionist fixes from the 2026-10-02 evening round (deploy 7, owner YES for an unattended run)

**Status: DRAFT 2026-10-02 ~23:40 CDT.** Owner YES (opening batch, ~21:30 CDT): deploy unattended IF the gate is clean
(census all land; corpus:sabotage = only the 3 baseline x; root + test:db green apart from the known worktree-only
fail) AND the final review has no Critical left after the fix pass; any failed step -> roll back to
`voice-uk-prod-00099-lkq` and verify. The smoke call (H4) waits for the owner.

`SHA` = c755f56 (code head of `feat/outbound-stage4`; later commits must be docs/spend/ledger only --
`git log --oneline c755f56..HEAD -- . ':!docs' ':!scripts/probes/spend-gptlive.json' ':!.superpowers'` prints
nothing). Production today: `voice-uk-prod-00099-lkq` @b772acb, `OUTBOUND_ENABLED=false`. Rollback target:
`voice-uk-prod-00099-lkq`. Ledger: the "Batch 2 2026-10-02 night" block in
`.superpowers/sdd/2026-10-01-outbound-live-first-line/progress.md`.

**What changes for callers (inbound and outbound).**
- **Mangled yes after a proper read-back (O3 CA9c2d26 "nada más").** When the assistant's previous turn read the
  details back and the model then writes, a caller answer that is not a clear refusal (one en+es list: no, wait,
  maybe, let me think, can't, never, forget it, espere, tal vez, para nada ...), not a question, not a bare "um",
  not unreadable, and not a different time counts as agreement -- but only if that read-back NAMED the slot being
  written. Cancellations (no slot) keep the strict rule; the existing ceiling still releases them on the next
  attempt. Post-call messages, the recovery gate and the silent-turn token still need a clear yes; the engine's
  own retry still needs a clear yes. Counter `write_order_released_unreadable_after_readback`, probe field
  `agreed_after_readback`.
- **"no speech" at a hold (O1 CA591a92).** Nothing the model says after its `wait_on_hold` call is played: the ack
  ("Sure, thank you.") is spoken before the call (3 paid sims), and the continuation is dropped. Log
  `outbound_hold_ack_audio {pre_tool_chunks, post_tool_chunks, played, reason}`.
- **Goodbye.** The caller's own clear close ("that's all, thanks", "no thanks", "bye", "eso es todo") answers
  "anything else?"; a bare "thank you" does not, and neither does a close that is really the answer to a read-back.
  Counters `end_call_ask_satisfied_by_caller_close`, `live_goodbye_exit_caller_closed`.
- **Outbound, any name on file -> no spelling question.** First name only: booked under the model's name (first +
  the surname it heard) or the first name alone (`outbound_name_first_only_used`); full name and no name unchanged.
- **Booking polish (outbound live mode).** "Does that work for you?" closing a turn that names exactly one time is a
  read-back; the booking step says to read the time back as a question and never say "booked" before the tool
  succeeds. 4c (restating a requested time as the question) NOT done -- revisit after Monday.

**Inputs checked.** No migration. No new env var or secret. New counters and one INFO log only (no new ERROR events;
alert policy unchanged). Paid sims P1-SIM-S9 3 x Hold $0.1236 (probe ledger cap 25.50, owner-approved). Gate at
b2a7082: see [AS RUN].

```bash
export CLOUDSDK_CONFIG=~/.gcloud-vetra2
export CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE=~/.gcloud-vetra2/ca-bundle.pem
P=vetra-uk-edc8ca; R=europe-west2; SHA=c755f56
BASE_URL=https://voice-uk-prod-462445274080.europe-west2.run.app
IMG=us-central1-docker.pkg.dev/vetra-core-edc8ca/vetra/voice:$SHA
```

**H0. Preflight (read)** as G0: `voice-uk-prod-00099-lkq` at 100%; `OUTBOUND_FIRST_SPEAKER` absent,
`OUTBOUND_ENABLED=false`, `DEEPGRAM_REGION=eu`; export `stageH-before.yaml` (session scratchpad).
**H1. Build from the MAIN checkout** (E1's command, `_TAG=$SHA`; CRLF migration checksums). The main tree must equal
HEAD apart from the untracked `.impeccable/` and `docs/VetraTD-Pricing-Model.xlsx`.
**H2. Migrate job image + `--status`** (expect pending: none; STOP otherwise -- nothing to roll back yet).
**H3. New revision**, only `GIT_COMMIT_SHA` changes; verify Ready, 100%, `Build: $SHA` from `GET /`, env diff
against `stageH-before.yaml` = image + `GIT_COMMIT_SHA` + nonce only, and 0 ERROR on the new revision over ~5 min.
**Any failure after traffic moved -> H6 at once, then verify `00099-lkq` 100% and `Build: b772acb`.**
**H4. Smoke** (owner, morning) = one inbound call from the owner's handset to +1 817 601 1171 (`direction:"inbound"`,
no ERROR; if an outreach is waiting for the handset, expect the returned-call line).
**H5. Re-test round** = `docs/superpowers/plans/2026-10-03-retest-round.md`.
**H6. Rollback**: `gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00099-lkq=100
--region=$R --project=$P`. No migration to undo; the migrate job image can stay (no pending migrations either way).

## What this build still carries (half-1 deferred Minors + parked, plus half-2's own; not fixed by
this deploy)

See `.superpowers/sdd/2026-09-27-outbound-stage3/progress.md`'s "HALF 1 DONE" block for the
half-1 list (m1, N3, N4, N5, F-R2-open-question, the two parked items, X1) — F-R2 itself (the
"talking over the clip" open question) is now CLOSED as a real, caller-facing Important defect, not
merely a question: **the SET A regression sim (post-half-2, `bb63d71`) reproduced it directly** —
`outbound_hello` FAILed `no_stale_reply_after_clip`: on a caller who says "Hello?" then goes silent,
Live's stale reply (a full opener repeat, "…calling on behalf of Harness Test Clinic.") streamed
long, `outbound_stale_discard_timeout` fired at 2004 ms but LIFTED the discard mid-generation, and
the tail played audibly, logged as heard, followed by "Are you still there?" — the exact regression
the F-R2 rounds were built to close, still open on the script that has NO caller speech during the
clip to latch onto (the fix's mechanism is voice-triggered). **This is the top item for the final
fix wave**, per the sims report's own direction: never lift the discard mid-generation; keep
discarding the stale generation until its own close, with a hard mute cap for a missing close.
SET A also found a second, unrelated FAIL: `outbound_stop`'s `post_call_exactly_once` — an opt-out
call's post-call step never started (`post_call_started_at: null`), looks tied to the opt-out tool
path racing the call's exit, not a stale-reply/clip issue.

Also outstanding from half 2 (deferred Minors, none fixed by this deploy — see `progress.md`'s
per-task minor lists for the full set): the NANPA Canada/Caribbean area-code list needs
owner/counsel verification before a campaign reaches those numbers (S3-7); the qualification
pack's questions still aren't visible in `lib/outbound/prompt.js`'s `outboundCallBlock` free text
beyond the `prompt()` clause S3-10's fix round 1 added (parked, not a gap — `prompt()` closes the
Critical); `exportCallerData` (Art. 15) still doesn't read outbound calling's own tables (S3-11
parked); the outbox redaction SQL is hand-matched to `buildResultsPayload`'s current shape with no
drift test (S3-8 minor).
