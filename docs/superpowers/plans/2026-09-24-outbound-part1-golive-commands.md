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
