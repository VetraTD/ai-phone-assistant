# Secret handover — the 4 values Lane B is waiting on

Everything else in B4 exists: the secrets, their per-secret IAM, the Cloud Run
service definition, the VPC route, the database and its schema. What is missing
is the credential values, and they are the one thing that cannot come from
Terraform — they live in a Twilio console and a mailbox.

Paste them once. Then one `terraform apply` deploys the service.

## Why the service is not deployed yet

`server.js` exits on a missing `DEEPGRAM_API_KEY`:

> Missing required env: DEEPGRAM_API_KEY. The Media Streams voice pipeline
> requires Deepgram for real-time speech-to-text — there is no fallback mode.

That is correct. A voice service that cannot hear is not degraded; it is a phone
that answers and says nothing. So no service is created until the secrets are
wired, rather than a crash-looping revision being presented as progress.

## The commands

```bash
export CLOUDSDK_CONFIG="$HOME/.gcloud-vetratd"
P=vetra-us-staging-c3a3bd

printf '%s' 'DEEPGRAM-KEY-HERE'  | gcloud secrets versions add deepgram-api-key   --project=$P --data-file=-
printf '%s' 'TWILIO-SID-HERE'    | gcloud secrets versions add twilio-account-sid --project=$P --data-file=-
printf '%s' 'TWILIO-TOKEN-HERE'  | gcloud secrets versions add twilio-auth-token  --project=$P --data-file=-
printf '%s' 'SMTP-PASSWORD-HERE' | gcloud secrets versions add smtp-password      --project=$P --data-file=-
```

`printf`, not `echo`: `echo` appends a newline and the newline becomes part of
the secret. This project has already lost a day to exactly that — a leading
newline in a Supabase cell made every business answer as "our office".

## Then

```bash
cd infra/terraform
terraform apply -var='wire_runtime_secrets=true'
```

Or set `wire_runtime_secrets = true` in `terraform.tfvars` and apply.

## What is NOT on this list, and why

**`elevenlabs-api-key` does not exist in any US project.** Not "left blank" —
not created. It carries `lanes = ["uk"]` in `secrets.tf`, so there is no secret
to grant, nothing to read, and nothing to leak. That is the property the entire
US/UK project split exists to make structural: a misconfiguration in the US lane
yields voicemail, not a disclosure to a vendor with no BAA.

`scripts/check-credential-boundary.js` verifies it from the outside, against the
live project, and fails a deploy if it is ever wrong.

**No database password.** The runtime authenticates as its own IAM identity. The
only database password in the system belongs to the migration job, is generated
by Terraform, and is never read by anything that serves a call.

## The staging caveat

These are STAGING secrets. Per the compensating-control table, staging must
never receive production Twilio credentials — use a test/probe number. The
merged staging project cannot enforce region pinning, so "no real caller data in
staging" is a rule rather than a constraint, and this is where that rule is kept
or broken.
