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

## Bootstrap: the two things that must exist before the first apply

Both were found by running the apply, not by reading documentation. Both fail
with an error that names the wrong cause.

### 1. Enable Terraform's own APIs on the quota project

`user_project_override = true` routes every API call Terraform makes through
`bootstrap_project_id` for quota and billing. Google requires the API to be
**enabled on that project** — even though the resources land elsewhere. Without
it the first apply dies on:

```
Error 403: Organization Policy API has not been used in project
ultra-glyph-506120-v5 before or it is disabled.
```

which reads as a permissions problem and is not.

```bash
gcloud services enable   orgpolicy.googleapis.com   cloudresourcemanager.googleapis.com   cloudbilling.googleapis.com   iam.googleapis.com   iamcredentials.googleapis.com   compute.googleapis.com   servicenetworking.googleapis.com   artifactregistry.googleapis.com   --project=<bootstrap_project_id>
```

Enabling an API is free.

### 2. Raise the billing account's project quota above 6

A **new self-serve / free-trial Cloud Billing account caps at 5 linked
projects.** This module creates six, and the bootstrap project already occupies
one of the five — so projects 6 and 7 are created and then fail to attach to
billing:

```
Error 400: Precondition check failed.
QuotaFailure: "Cloud billing quota exceeded"
  subject: billingAccounts/<id>
```

Note the shape of that failure, because it is unusually expensive: the projects
**are created** and only the billing attachment fails. Terraform marks them
`tainted`, which means the next apply **destroys and recreates** them — and a
deleted project holds its ID for 30 days while `random_id.project_suffix` does
not change, so the recreate collides with the corpse of the project it just
deleted. If you hit this, untaint before doing anything else:

```bash
terraform untaint 'google_project.this["shared"]'
terraform untaint 'google_project.this["uk-prod"]'
```

Untainted, the next apply sets billing on the existing project in place, which
is what you want.

Check how many projects the account currently carries:

```bash
gcloud billing projects list --billing-account=<billing_account>
```

**Nothing else in the module applies until this is fixed.** Terraform's
dependency graph for a `for_each` resource is per-RESOURCE, not per-instance:
`google_project_service` depends on `google_project`, so two failed projects out
of six skip all 89 service enablements and everything downstream of them. The
apply reports 0 created, which looks like a much bigger problem than it is.

## First run

```bash
cp terraform.tfvars.example terraform.tfvars   # then fill it in
terraform init
terraform validate
terraform plan                                 # read this. it creates ~60 resources.
```

`plan` is safe and creates nothing. **`apply` is B0a and needs the owner's go-ahead.**

## After the first apply — three follow-ups, in this order

The first apply runs on local state and creates its own state bucket.

**1. Move the state.**

1. Take `tfstate_bucket` from the outputs.
2. Uncomment the `backend "gcs"` block in `versions.tf` and paste the name in.
3. `terraform init -migrate-state`

With two founders this is not optional. Local state means only one machine can ever apply without clobbering the other's view.

**2. Repoint `bootstrap_project_id` at the `shared` project.** The bootstrap
project is scheduled for deletion (ledger O3c) once the GCP BAA has been
re-verified. Terraform routes every API call through it, so deleting it first
breaks every future run. Change the tfvars value, `terraform plan` to confirm no
diff, and only then delete. The `shared` project needs the same API list from
the bootstrap section enabled on it.

**3. Record the project IDs.** They are immutable and they carry a random
suffix, so they cannot be reconstructed from the config. `terraform output
project_ids`.

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

## What this costs to apply: approximately nothing

Deliberate, and worth preserving. Everything this module creates is free or
rounds to free:

| Resource | Cost |
|---|---|
| Projects, APIs enabled, IAM, org policies, service accounts | free |
| VPC, subnets, firewall rules | free |
| Reserved peering range + service-networking connection | free |
| Artifact Registry, state bucket, log buckets | storage only — empty, so pennies |
| Subnet flow logs | log ingestion; first 50 GB/month free, and an idle network is nowhere near it |

**The rule this follows: provision paid infrastructure as late as possible.**
GCP bills most managed services for capacity that *exists*, not capacity that is
*used* — an empty Cloud SQL instance costs the same as a busy one. There is no
value in a database running for two weeks while the code that will talk to it is
still being written.

An earlier version of this module created four Serverless VPC Access connectors,
which are real VM instances and would have started a ~$70-80/month meter on the
first apply for infrastructure nothing was using. They moved to `B2`.

**What will cost money, when it arrives:** Cloud SQL (per instance-hour, idle or
not), Memorystore (per GB provisioned, always on), and Cloud Run in prod — where
`min-instances=1` with CPU always allocated is a deliberate latency choice, not a
default. Staging Cloud Run scales to zero and is close to free.

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
