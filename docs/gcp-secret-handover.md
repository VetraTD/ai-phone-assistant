# Secret handover — moving credentials into Secret Manager

Everything else in B4 exists: the secrets, their per-secret IAM, the Cloud Run
service definition, the VPC route, the database and its schema. What is missing
is the credential values, and they are the one thing Terraform cannot produce.

**Nothing needs to be pasted anywhere.** The values are already in `.env`, and
`scripts/push-secrets.js` moves them without passing through a clipboard, a
terminal, or a chat transcript. It prints names, lengths and provenance — never
a value.

## The staging subaccount

Staging shares an environment with nothing, but it was about to share a Twilio
ACCOUNT with production. Two separate problems come from that:

| | |
|---|---|
| **Inbound** | A patient misdialling by one digit reaches a staging build — the one environment whose residency is not enforced and whose database sits outside the production backup and retention story. |
| **Outbound** | Production credentials let staging send SMS from the production number and place real calls. |

`CALLER_ALLOWLIST` (lib/callerAllowlist.js) closes the first. **A subaccount is
what closes the second**, and it is why these instructions have two files.

Put the subaccount credentials in `.env.staging`:

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Only those two. Everything else — Deepgram, SMTP — comes from `.env`.

`.env.*` is gitignored. It was NOT until this was written: only the bare `.env`
was listed, so a `.env.staging` holding live credentials would have been
committed to a public repository.

## Push

```bash
node scripts/push-secrets.js --project vetra-us-staging-c3a3bd   --from .env --from .env.staging --dry-run
```

Later files win, so the subaccount SID and token override the production ones
while Deepgram and SMTP still come from the base file. The dry run reports which
file each value came from — a production token and a subaccount token are
indistinguishable by length, so provenance is the only thing that can tell you
the override actually took.

Expect to see `from .env.staging` beside both Twilio rows. If you see `.env`,
the override did not apply and you are about to push production credentials.

Then drop `--dry-run`.

`--from`, not `--env-file`: Node 20.6+ has a built-in `--env-file` and claims
the argument before the script sees it, failing with `node.exe: .env.staging:
not found` — which looks like a missing file and is a flag collision.

## Deploy

```bash
cd infra/terraform
terraform apply   -var='wire_runtime_secrets=true'   -var='staging_caller_allowlist=["+1YOURNUMBER"]'
```

**Staging refuses every caller until that list has a number in it.** Deliberate:
an environment nobody should dial by accident should start closed, and the cost
of being too strict is adding your own number.

## What is deliberately NOT here

**`elevenlabs-api-key` does not exist in any US project.** Not blank — not
created. `lanes = ["uk"]` in `secrets.tf`, so there is no secret to grant,
nothing to read, and nothing to leak. That is the property the entire US/UK
project split exists to make structural rather than aspirational: a
misconfiguration in the US lane yields voicemail, not a disclosure to a vendor
with no BAA.

`scripts/check-credential-boundary.js` verifies it from the outside against the
live project and fails a deploy if it is ever wrong.

**No database password.** The runtime authenticates as its own IAM identity. The
only database password in the system belongs to the migration job, is generated
by Terraform, and is never read by anything that serves a call.
