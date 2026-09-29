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

**Status: no command below has been run against a real GCP project.** Started by the S3-11
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

**Warning:** run migrations ONLY through this migrate-job image. The local checkout's
`database/001`–`045` are CRLF in the working tree (`git ls-files --eol` shows `i/lf w/crlf`); the
image and the gate worktree are LF. Running `scripts/migrate.js` from this checkout reports 042–045
as "drifted" against the LF-recorded checksums — a false alarm from the checkout, not a real schema
problem; don't "fix" it by running from there.

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
**STOP and ask the owner:** the `policies create` flags above are a DRAFT, never run against a real
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
