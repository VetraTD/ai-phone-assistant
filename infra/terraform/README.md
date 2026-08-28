# Terraform root module

THREE GCP projects, their org policies, networks, IAM and control plane.

## Status: RESHAPED FOR ATTEMPT 2, APPLIED NOWHERE

**Attempt 1's estate does not exist.** Google suspended org `564252011558`,
billing `01C71E-7C0893-377AE9` and every `*-c3a3bd` project on 2026-08-25 for an
AUP violation scoped to the owner, cause never disclosed. `admin@vetratd.com` is
not coming back. **If you find a `c3a3bd` anywhere, it names nothing.**

This module was rewritten in Phase 2 (2026-08-28) to describe the replacement
estate. Nothing has been applied against it. **Phase 4 is the first apply, and
it starts from an empty state file and a fresh state bucket.**

| | Attempt 1 | Attempt 2 |
|---|---|---|
| Stacks | six (`{us,uk}-{prod,staging}`, `shared`, `logging`) | **three** (`uk-prod`, `us-prod`, `shared`) |
| Projects | six by design, four by the billing cap | **three** (`uk`, `us`, `core`) |
| Project keys | were also stack keys | **are not** — `uk-prod` lands in `uk` |
| Live market | US | **UK.** `us-prod` is dark; `active_stacks` lights it |
| Compliance tier | `hipaa` on the US lane | **`standard` everywhere.** No GCP BAA |
| Staging | a GCP stack | **local Docker PG16** (`npm run db:up`) |
| Logging | its own project | folded into `core`; the ORG sink is unchanged |
| Billing | free trial, 5-linked-project cap | **paid**, no cap |

**Residue warning.** This directory contains `terraform.tfstate`,
`terraform.tfvars` and ~20 `.tfplan` files from attempt 1, all naming deleted
projects. They are untracked and gitignored. **Do not reuse any of them** — a
stray `terraform.tfvars` is auto-loaded by every `plan`, silently.
`.terraform/terraform.tfstate` also cached the dead GCS backend and made
`terraform init` reach for a bucket that no longer exists; it has been moved
out of the way.

## Before you run anything

Three environment variables. Each one, forgotten, produces a confusing failure
rather than an obvious one — and the first is the one that was wrong for a day
without anybody noticing.

```bash
# 1. THE IDENTITY, FOR gcloud.
#    ~/.gcloud-vetratd is the DEAD org. The default config is a personal
#    account. Isolation is deliberate: it stops an apply landing on the wrong
#    account.
export CLOUDSDK_CONFIG="$HOME/.gcloud-vetra2"

# 2. THE IDENTITY, FOR TERRAFORM. These are NOT the same thing. See below.
#    Terraform reads ONLY ADC — refreshing the gcloud login alone cost a session.
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.gcloud-vetra2/application_default_credentials.json"

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
<bootstrap project>. Grant the caller the roles/serviceusage.serviceUsageConsumer
role ... reason: USER_PROJECT_DENIED
```

which reads as a missing IAM binding and is not. The owner already holds
`roles/owner` on that project; a different identity was asking.

**`TF_DISABLE_PLUGIN_TLS=1` is not optional here either, and its failure looks
nothing like a proxy problem.** Norton MITMs the loopback channel Terraform uses
to talk to its own provider plugins, and without it every command — including
`terraform validate`, which touches no network of its own — dies with:

```
Error: Failed to load plugin schemas
- Failed to obtain provider schema: ... Plugin did not respond: The plugin
  encountered an error, and failed to respond to the
  plugin.(*GRPCProvider).GetProviderSchema call.
```

The plugin binaries are fine; running one directly prints "This binary is a
plugin". Confirmed again 2026-08-28.

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
Error 403: Cloud Resource Manager API has not been used in project
<bootstrap project> before or it is disabled.
```

which reads as a permissions problem and is not.

**This trap fired FIVE separate times in attempt 1 and again on 2026-08-28.**
Every occurrence was the same shape: an apply dies on a 403 naming the quota
project, somebody enables the one API it named, the next apply dies on the next
one. **Enable the WHOLE list in one command, before the first apply.** The list
below is `local.terraform_quota_apis` in `locals.tf` — if you add a resource
type to this module, add its API there too, before applying, not after the 403.

```bash
gcloud services enable \
  cloudresourcemanager.googleapis.com \
  serviceusage.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  orgpolicy.googleapis.com \
  cloudbilling.googleapis.com \
  billingbudgets.googleapis.com \
  compute.googleapis.com \
  servicenetworking.googleapis.com \
  sqladmin.googleapis.com \
  cloudkms.googleapis.com \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com \
  identitytoolkit.googleapis.com \
  apikeys.googleapis.com \
  essentialcontacts.googleapis.com \
  --project=<bootstrap_project_id>
```

Enabling an API is free. **Verify rather than assume:**

```bash
gcloud services list --enabled --project=<bootstrap_project_id>
```

### 2. Do NOT hand-create the three projects

Attempt 1's second bootstrap step was raising the billing account's
5-linked-project cap, because a free-trial account caps there and the module
wanted six. **That constraint is gone: the billing account is PAID and the
module creates three.**

What replaced it is a discipline, not a quota. **Terraform creates the projects.
Nobody creates them by hand.** Attempt 1 ended up adopting hand-made resources
through import blocks because a partial apply left projects Terraform did not
know about, and that cost a session. `imports.tf` still exists for the next time
state is lost, and `adopt_existing_projects` is empty and should stay empty.

**The failure shape is still worth knowing, because it survives the quota.** If
a project is created and its billing attachment then fails, Terraform marks it
`tainted`, which means the next apply **destroys and recreates** it — and a
deleted project holds its ID for 30 days, so the recreate collides with the
corpse of the project it just deleted. Untaint before doing anything else:

```bash
terraform untaint 'google_project.this["core"]'
terraform untaint 'google_project.this["uk"]'
```

Untainted, the next apply sets billing on the existing project in place.

**Nothing else in the module applies until a failure like this is fixed.**
Terraform's dependency graph for a `for_each` resource is per-RESOURCE, not
per-instance: `google_project_service` depends on `google_project`, so one
failed project skips every service enablement and everything downstream.

## First run

```bash
cp terraform.tfvars.example terraform.tfvars   # then fill it in
terraform init
terraform validate
terraform plan                                 # read this. it creates ~60 resources.
```

`plan` is safe and creates nothing. **`apply` is Phase 4 and needs the owner
present.** Read the plan for `must be replaced` before applying any of it —
`google_compute_network` replacement cascades into destroying the Cloud SQL
instance anchored to it, and a one-word change to a VPC `description` is enough
to trigger it.

## After the first apply — three follow-ups, in this order

The first apply runs on local state and creates its own state bucket.

**1. Move the state.**

1. Take `tfstate_bucket` from the outputs.
2. Uncomment the `backend "gcs"` block in `versions.tf` and paste the name in.
3. `terraform init -migrate-state`

With two founders this is not optional. Local state means only one machine can ever apply without clobbering the other's view.

**2. Repoint `bootstrap_project_id` at the `core` project.** Terraform routes
every API call through the bootstrap project, so deleting or losing it first
breaks every future run. Change the tfvars value, `terraform plan` to confirm no
diff, and only then stop using the scratch project. **`core` needs the same full
API list from the bootstrap section enabled on it** — same trap, second project.

**3. Record the project IDs, and pin the suffix BEFORE the apply, not after.**
Project IDs are immutable and carry `project_id_suffix`. Leave it empty and a
`random_id` is generated that lives only in state — which is how attempt 1's
config stopped being able to name its own projects when state was lost. Pin it
in `terraform.tfvars` and write it in the ledger. `terraform output project_ids`
confirms.

**4. Fill in `dashboard_domains` and `dashboard_url`.** Both need the `core`
project ID, which does not exist until step 3. Leaving them at their placeholder
produces a dashboard that loads, renders its sign-in form, and is refused by CORS
on every API call behind it — and the sign-in page makes no API call, so nothing
looks wrong until somebody actually signs in.

## What this module creates

**Three stacks, three projects, 1:1** — see `var.stack_projects`. Project keys
are NOT stack keys: `uk-prod` lands in project `uk`, `shared` lands in `core`.
Project IDs are `vetra-<project key>-<suffix>`.

| Project | Stack it holds | Locations enforced | State |
|---|---|---|---|
| `vetra-uk-<suffix>` | `uk-prod`, europe-west2. Cloud Run, Cloud SQL | `["in:eu-locations", "in:europe-west2-locations"]` | **the only live lane** |
| `vetra-us-<suffix>` | `us-prod`, us-central1 | `in:us-locations` | **DARK** — project created, empty. `active_stacks` lights it |
| `vetra-core-<suffix>` | `shared`. Artifact Registry, Cloud Build, Identity Platform, TF state, **and the log buckets** | both continents | live |

**Every project holds exactly one stack, and that is what makes the residency
pin real.** A project gets ONE `gcp.resourceLocations` policy, so a project
holding two lanes would have to permit both continents — which is what attempt
1's merged staging project did, and its residency was backed by a written rule
instead of an enforcement. That gap is closed by the shape, and it reopens the
moment two stacks are pointed at one project.

### ⚠ `in:eu-locations` DOES NOT CONTAIN `europe-west2`

It is Google's value group for the **European Union**, and the UK left. Measured
on attempt 1's estate: the effective policy expanded to 66 values, 36 of them
`europe-west*`, and **nothing matching `west2` anywhere** — Belgium, Frankfurt,
Netherlands, Milan, Paris, Berlin, Turin, every one an EU member state. A UK
project with only `in:eu-locations` refuses every regional resource in turn:

```
Constraint constraints/gcp.resourceLocations violated for
[orgpolicy:projects/...] attempting to create a secret in [europe-west2]
```

`local.uk_locations` must stay `["in:eu-locations", "in:europe-west2-locations"]`.
**`terraform plan` DOES NOT EVALUATE ORG POLICY**, so a clean plan says nothing
about this and the only way to catch it is to read it.

### Other things a plan cannot show you

- **`storage.uniformBucketLevelAccess` is ENFORCED org-wide** (Google set it,
  along with five other secure-by-default policies, when it auto-provisioned
  this org). Every `google_storage_bucket` must set
  `uniform_bucket_level_access = true`; an ACL-based bucket is refused **at
  apply time**. The two in this module (`loadbalancer.tf` SPA, `shared.tf`
  state) both set it, and no `google_storage_bucket_acl` resource exists.
  Cloud **Logging** buckets are a different resource and are not affected.
- **`iam.disableServiceAccountKeyCreation` is already set by Google**, so this
  module does not declare it. Managing it would be Terraform fighting a policy
  it did not create — and a `destroy` would remove a control nobody here
  turned on.
- **Cloud SQL backups default to the `eu` multi-region**, which is EU-only, so a
  London instance's backups would land outside the UK. `sql.tf` pins
  `backup_configuration.location` to the instance region.
- **Cloud Run issues TWO URL forms.** `.uri` is the opaque-hash form; `BASE_URL`
  is the project-number form. The Twilio signature is an HMAC over the exact URL
  string, so **the webhook must be `twilio_webhook_base`, never `.uri`.**

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
not, ~$98/month at the default tier) and Cloud Run's warm voice instance.
Memorystore is **not provisioned at all** — C-3 puts the shared call-state slice
in Postgres, which is three scalars written at call boundaries and saves
$70-100/month.

**The whole-estate budget is ~$55-80/month, and `cpu_idle` is the budget.**
`min_instances = 1` with `cpu_idle = false` is ~$70/month on that line alone.
Attempt 1 paired them, on the sound reasoning that a warm instance with throttled
CPU still waits for an un-throttle on the first request. **Attempt 2 runs
`min_instances = 1` with `cpu_idle = true` and accepts that un-throttle.** What
it costs is UNMEASURED: the effect is entirely on the first request after an idle
gap, so the only honest test is a live call after a pause, listening to turn ONE
— a steady-state p50 averages it away, and measured p50 is 3,062 ms end to end,
which is wide enough to hide the whole effect.

## Why three projects and not one

One project gets **one** `gcp.resourceLocations` policy. It would have to allow both continents, and then nothing prevents UK caller data landing in `us-central1` except somebody remembering.

Separate projects mean the constraint is per-lane, and creating a resource in the wrong continent becomes an **API rejection**. That is the entire reason the split exists — the rest (IAM separation, blast radius, cost attribution) is real but secondary.

The second reason is the **credential boundary**, and it is why a validation on `var.stack_projects` refuses to let `us-prod` and `uk-prod` share: a US project holds no ElevenLabs key at all. Cloud SQL instances and Identity Platform tenants cannot be moved between projects afterwards, so merging them would be close to permanent.

`us` is created even though it is dark, because **an empty project costs nothing and a project is the boundary**. Lighting the lane later is a tfvars line; creating the boundary later is a migration.

Projects are **siblings** under the organization. GCP has no sub-projects; nesting is done with folders, which hold no resources.

## Things that will bite

- **Org policy propagation is eventually consistent.** `skip_default_network` is a `depends_on` of every project rather than an assumption about ordering, but a first apply can still race. Re-running `apply` is safe and usually resolves it.
- **Service enablement races the first resource that needs it.** Same remedy.
- **Project IDs are immutable.** They carry `project_id_suffix` so a first apply cannot fail on a globally-taken name. **Pin it in tfvars before the apply** — left empty it is a `random_id` that lives only in state, and losing state then renames every project. That is not hypothetical; it happened.
- **A one-word change to a VPC `description` forces network replacement**, which cascades into destroying the Cloud SQL instance anchored to it. `network.tf` composes that description from the sorted list of active stacks in the project, so activating a second stack in an existing project rewrites it. Read every plan for `must be replaced`.
- **`gcp.resourceLocations` will reject resources you did not expect**, which is the point. If a `plan` fails on a location, the fix is the location, never the policy.
- **No service-account keys exist and none can be created** — the org policy forbids it. Workloads use the metadata server. If something asks for a JSON key, that is a design problem, not a permissions problem.

## What is deliberately not here

**Memorystore.** C-3 decided against it; `redis.googleapis.com` is deliberately absent from `local.regional_apis` so nobody enables it "just in case" and then creates a $70-100/month instance assuming the decision went the other way.

**Bucket Lock on the log buckets.** `logging.tf` sets no `locked` argument and that absence is the decision. Bucket Lock is irreversible; applied to application logs, one regression in the PHI scrubber creates **undeletable** personal data — unerasable under GDPR Art. 17. The audit stream is severed from the application stream precisely so that locking the audit half later is safe, and that is an owner-present step, not something one `apply` away.

**`hipaa` anything.** `DEPLOYMENT_MODE=hipaa` stays in the code and the tests and is deployed nowhere. `deployment_mode = "standard"` also gates `speech.tf`, so lighting `us-prod` does not silently provision a KMS key ring — which is the one resource here that **can never be deleted**.

**The Speech-to-Text v2 `Config` PATCH.** No Terraform resource exists for it (hashicorp/terraform-provider-google#18878). `speech.tf` explains what covers the gap. Moot while `deployment_mode` is `standard`.
