# Terraform root module — B0w

Six GCP projects, their org policies, networks, IAM and control plane.

**This module has never been applied.** Writing it needs no GCP; applying it is `B0a`.

## Before you run anything

Two environment variables. Both matter, and forgetting either produces a confusing failure rather than an obvious one.

```bash
# 1. The VetraTD identity, isolated from your personal gcloud setup.
#    Without this, Terraform authenticates as whatever the default config holds
#    — which on this machine is a personal account that cannot see the org.
export CLOUDSDK_CONFIG="$HOME/.gcloud-vetratd"

# 2. Norton's loopback proxy MITMs Terraform's own plugin channel. See below.
export TF_DISABLE_PLUGIN_TLS=1
```

### Why `TF_DISABLE_PLUGIN_TLS` — and what it costs

Without it, every Terraform command on this workstation fails with:

```
Plugin did not respond ... GetProviderSchema
tls: failed to verify certificate: x509: certificate signed by unknown authority
plugin address: 127.0.0.1:10000
```

Terraform talks to its providers over gRPC on loopback, secured by **AutoMTLS**:
Terraform mints a certificate, hands it to the plugin, and each side trusts the
other's explicitly. Norton's loopback filter proxy (`nllMonFltProxy` — it is what
sets the global `SSLKEYLOGFILE`) intercepts that connection and presents its own
certificate instead. Terraform correctly refuses it.

`TF_DISABLE_PLUGIN_TLS=1` turns off encryption **on the local plugin channel
only**. Traffic to Google's APIs is unaffected and still TLS.

**The cost, stated plainly:** the plugin channel carries Terraform state, which
can contain secrets, and unencrypted loopback traffic is readable by another
process on the same machine. That requires local code execution to exploit, so
the risk on a developer workstation is modest — but it is not zero.

**The proper fix is a Norton exclusion for `terraform.exe`**, which removes the
interception rather than working around it. Do that and this variable can go.

**This is workstation-only.** Cloud Build running Terraform inside GCP has no
Norton and needs none of this. Nothing here follows the code into production.

Note also: do **not** set `SSL_CERT_FILE`. It replaces Go's entire root store and
breaks the same plugin handshake in a different way — an earlier attempt at
"fixing Norton" that made things worse.

Verify the identity is the right one before proceeding — this must print `564252011558`:

```bash
gcloud organizations list
```

## First run

```bash
cp terraform.tfvars.example terraform.tfvars   # then fill it in
terraform init
terraform validate
terraform plan                                 # read this. it creates ~60 resources.
```

`plan` is safe and creates nothing. **`apply` is B0a and needs the owner's go-ahead.**

## After the first apply — move the state

The first apply runs on local state and creates its own state bucket. Then:

1. Take `tfstate_bucket` from the outputs.
2. Uncomment the `backend "gcs"` block in `versions.tf` and paste the name in.
3. `terraform init -migrate-state`

With two founders this is not optional. Local state means only one machine can ever apply without clobbering the other's view.

## What this module creates

| Project | Holds | Locations enforced |
|---|---|---|
| `vetra-us-prod` | US HIPAA stack — Cloud Run, Cloud SQL, Memorystore | `in:us-locations` |
| `vetra-us-staging` | US staging | `in:us-locations` |
| `vetra-uk-prod` | UK GDPR stack, europe-west2 | `in:eu-locations` |
| `vetra-uk-staging` | UK staging | `in:eu-locations` |
| `vetra-shared` | Artifact Registry, Cloud Build, Identity Platform, TF state | both |
| `vetra-logging` | Two regional audit log buckets | both |

Plus, per regional stack: a VPC with no default network, a subnet with flow logs, a reserved range and peering for private-IP Cloud SQL, a Serverless VPC Access connector, and a keyless runtime service account.

## Why six projects and not one

One project gets **one** `gcp.resourceLocations` policy. It would have to allow both continents, and then nothing prevents UK patient data landing in `us-central1` except somebody remembering.

Six projects means the constraint is per-stack, and creating a resource in the wrong continent becomes an **API rejection**. That is the entire reason the split exists — the rest (IAM separation, blast radius, cost attribution) is real but secondary.

Projects are **siblings** under the organization. GCP has no sub-projects; nesting is done with folders, which hold no resources.

## Things that will bite

- **Org policy propagation is eventually consistent.** `skip_default_network` is a `depends_on` of every project rather than an assumption about ordering, but a first apply can still race. Re-running `apply` is safe and usually resolves it.
- **Service enablement races the first resource that needs it.** Same remedy.
- **Project IDs are immutable.** They carry a random suffix so a first apply cannot fail on a globally-taken name. Record them from the outputs; you cannot rename later.
- **`gcp.resourceLocations` will reject resources you did not expect**, which is the point. If a `plan` fails on a location, the fix is the location, never the policy.
- **No service-account keys exist and none can be created** — the org policy forbids it. Workloads use the metadata server. If something asks for a JSON key, that is a design problem, not a permissions problem.

## What is deliberately not here

Cloud SQL, Memorystore, Cloud Run services, Secret Manager secrets and Identity Platform tenants. Those are `B2`–`B5`, and they are separate because this module has to be applyable and verifiable on its own before anything stateful exists.
