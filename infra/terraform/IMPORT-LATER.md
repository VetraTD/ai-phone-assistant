# Resources created outside Terraform, to import later

Terraform cannot run on the deploy workstation: the provider gRPC handshake fails, probably because Norton interferes. Every resource below was created with `gcloud` (`CLOUDSDK_CONFIG=~/.gcloud-vetra2`).

**Before the next `terraform apply`:**
- add each resource to the right `.tf` file with an `import {}` block, as `imports.tf` does;
- pass the image tag that is actually live (`gcloud run services describe voice-uk-prod --format="value(spec.template.spec.containers[0].image)"`), or the apply rolls production back;
- carry the service's env/secret additions below into `cloud-run.tf`, or the apply removes them.

## Outbound Part 1 go-live (2026-09-26)

Commands: `docs/superpowers/plans/2026-09-24-outbound-part1-golive-commands.md`, Section A. Status: owner YES 2026-09-26; each row shows whether it has been created.

| Resource | Created by | Terraform type | Import ID | Status |
|---|---|---|---|---|
| API `cloudtasks.googleapis.com` on `vetra-uk-edc8ca` | `gcloud services enable` | `google_project_service` | `vetra-uk-edc8ca/cloudtasks.googleapis.com` | created 2026-09-26 |
| Service account `outbound-tasks` | `gcloud iam service-accounts create` | `google_service_account` | `projects/vetra-uk-edc8ca/serviceAccounts/outbound-tasks@vetra-uk-edc8ca.iam.gserviceaccount.com` | created 2026-09-26 |
| `roles/run.invoker` for `outbound-tasks` on service `voice-uk-prod` | `gcloud run services add-iam-policy-binding` | `google_cloud_run_v2_service_iam_member` | `projects/vetra-uk-edc8ca/locations/europe-west2/services/voice-uk-prod roles/run.invoker serviceAccount:outbound-tasks@vetra-uk-edc8ca.iam.gserviceaccount.com` | created 2026-09-26 |
| Cloud Tasks queue `outbound-dispatch` (europe-west2; 1/s, 5 concurrent, 3 attempts) | `gcloud tasks queues create` | `google_cloud_tasks_queue` | `projects/vetra-uk-edc8ca/locations/europe-west2/queues/outbound-dispatch` | created 2026-09-26 |
| `roles/cloudtasks.enqueuer` for `voice-uk-prod@` on the project | `gcloud projects add-iam-policy-binding` | `google_project_iam_member` | `vetra-uk-edc8ca roles/cloudtasks.enqueuer serviceAccount:voice-uk-prod@vetra-uk-edc8ca.iam.gserviceaccount.com` | created 2026-09-26 |
| `roles/iam.serviceAccountUser` for `voice-uk-prod@` on `outbound-tasks` | `gcloud iam service-accounts add-iam-policy-binding` | `google_service_account_iam_member` | `projects/vetra-uk-edc8ca/serviceAccounts/outbound-tasks@vetra-uk-edc8ca.iam.gserviceaccount.com roles/iam.serviceAccountUser serviceAccount:voice-uk-prod@vetra-uk-edc8ca.iam.gserviceaccount.com` | created 2026-09-26 |
| Secret `twilio-account-sid-alt` (user-managed, europe-west2): account B's Account SID | `gcloud secrets create` | `google_secret_manager_secret` (+ a version; the VALUE stays out of state, as for the other runtime secrets) | `projects/vetra-uk-edc8ca/secrets/twilio-account-sid-alt` | created 2026-09-26 |
| `roles/secretmanager.secretAccessor` for `voice-uk-prod@` on `twilio-account-sid-alt` | `gcloud secrets add-iam-policy-binding` | `google_secret_manager_secret_iam_member` | `projects/vetra-uk-edc8ca/secrets/twilio-account-sid-alt roles/secretmanager.secretAccessor serviceAccount:voice-uk-prod@vetra-uk-edc8ca.iam.gserviceaccount.com` | created 2026-09-26 |
| Scheduler job `outbound-sweep` (europe-west2, `*/5 * * * *` UTC, POST `/internal/outbound/sweep`, OIDC as `outbound-tasks`, audience = BASE_URL, deadline 600 s) | `gcloud scheduler jobs create http` | `google_cloud_scheduler_job` | `projects/vetra-uk-edc8ca/locations/europe-west2/jobs/outbound-sweep` | created 2026-09-26 |

**Settings changed on existing resources.** These are not imports, but `cloud-run.tf` and `migrate-job.tf` must match them:
- Service `voice-uk-prod`:
  - env `OUTBOUND_ENABLED=false`, `OUTBOUND_TEST_ALLOWLIST`, `OUTBOUND_TASKS_QUEUE`, `OUTBOUND_TASKS_SA`, `OUTBOUND_MAX_CONCURRENT=3`, `OUTBOUND_INBOUND_RESERVE=2`;
  - secret env `TWILIO_ACCOUNT_SID_ALT` from `twilio-account-sid-alt:latest`;
  - image tag.
- Job `vetra-migrate-uk-prod`: image tag, plus env `OUTBOUND_TEST_ALLOWLIST`.
- `secrets.tf` defines `twilio-auth-token-alt` but has no `twilio-account-sid-alt`; add it beside it.
