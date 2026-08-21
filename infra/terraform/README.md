# Terraform root module — B0w

Six GCP projects, their org policies, networks, IAM and control plane.

**Partially applied, and its state was lost.** B0a (2026-08-21) created three
org-node policies and six projects, then died on the billing account's
5-linked-project cap. It ran on LOCAL state and that file no longer exists
anywhere on the workstation — so the resources are real and Terraform does not
know about them. `imports.tf` adopts them back; read it before planning.

## Before you run anything

Three environment variables. Each one, forgotten, produces a confusing failure
rather than an obvious one — and the first is the one that was wrong for a day
without anybody noticing.

```bash
# 1. THE IDENTITY, FOR gcloud.
export CLOUDSDK_CONFIG="$HOME/.gcloud-vetratd"

# 2. THE IDENTITY, FOR TERRAFORM. These are NOT the same thing. See below.
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.gcloud-vetratd/application_default_credentials.json"

# 3. Norton's loopback proxy MITMs Terraform's own plugin channel.
export TF_DISABLE_PLUGIN_TLS=1
```

### `CLOUDSDK_CONFIG` DOES NOT STEER TERRAFORM. This is the important one.

`CLOUDSDK_CONFIG` relocates **gcloud's** configuration directory. The Terraform
Google provider does not run gcloud — it is Go, and it resolves Application
Default Credentials through the Go auth library, which looks for
`%APPDATA%\gcloudpplication_default_credentials.json` and **does not honour
`CLOUDSDK_CONFIG` at all.** That is a Python-library behaviour.

On this workstation the default ADC belongs to a **personal account**, whose own
quota project is `physicianmessagingapp`. So every `terraform plan` run with
only `CLOUDSDK_CONFIG` set authenticates as the wrong person, and it does not
say so — it fails with:

```
Error 403: Caller does not have required permission to use project
vetra-shared-c3a3bd. Grant the caller the roles/serviceusage.serviceUsageConsumer
role ... reason: USER_PROJECT_DENIED
```

which reads as a missing IAM binding and is not. `admin@vetratd.com` already
holds `roles/owner` on that project; a different identity was asking.

`GOOGLE_APPLICATION_CREDENTIALS` is honoured by the Go library and takes
precedence over the well-known path, so setting it explicitly is the fix.

**Verify the identity Terraform will actually use, not the one gcloud shows:**

```bash
# gcloud's view — necessary, NOT sufficient
gcloud organizations list                     # must print 564252011558

# Terraform's view — this is the one that matters
gcloud auth application-default print-access-token >/dev/null && echo "ADC ok"
```

### Reauthentication: `invalid_rapt`

The org enforces reauthentication for sensitive operations, so the ADC refresh
token goes stale on a schedule and Terraform stops with:

```
oauth2: "invalid_grant" "reauth related error (invalid_rapt)"
```

It is not a permissions problem and it cannot be fixed from a script — the
remedy is **interactive**:

```bash
CLOUDSDK_CONFIG="$HOME/.gcloud-vetratd" gcloud auth application-default login
```

Expect to do this again. An unattended session cannot get past it, which is the
point of the control.



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
gcloud services enable   orgpolicy.googleapis.com   cloudresourcemanager.googleapis.com   cloudbilling.googleapis.com   iam.googleapis.com   iamcredentials.googleapis.com   compute.googleapis.com   servicenetworking.googleapis.com   artifactregistry.googleapis.com   --project=<bootstrap_project_id>   # today: vetra-shared-c3a3bd
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
**Six stacks. FOUR projects today** — see `var.stack_projects`, and the ledger's
"SIX IS THE TARGET. FOUR IS WHAT IS BILLED".

| Project | Stacks it holds | Locations enforced |
|---|---|---|
| `vetra-us-prod` | us-prod. Cloud Run, Cloud SQL | `in:us-locations` |
| `vetra-uk-prod` | uk-prod, europe-west2. Empty until C-1's toggle | `in:eu-locations` |
| `vetra-us-staging` | us-staging **and uk-staging** | both — see below |
| `vetra-shared` | Artifact Registry, Cloud Build, Identity Platform, TF state, **and the log buckets** | both |

`vetra-uk-staging` and `vetra-logging` still EXIST, unbilled. Do not delete
them — they are the restore path, and relinking is cheaper than recreating.

**The merge's one real cost:** a project gets ONE `gcp.resourceLocations`
policy, so the merged staging project permits both continents and is not
region-pinned. Unavoidable with one project, and it reverts on its own when
`uk-staging` gets its own project back.

Plus, per ACTIVE regional stack: a subnet with flow logs and a keyless runtime
service account; per regional PROJECT: a VPC with no default network, and a
reserved range and peering for private-IP Cloud SQL. **No Serverless VPC Access
connector — see C-6 in `cost-controls.tf`.**

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
