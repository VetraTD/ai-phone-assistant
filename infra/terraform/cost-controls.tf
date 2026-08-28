# ---------------------------------------------------------------------------
# Cost controls C-1 .. C-11, as configuration.
#
# ---------------------------------------------------------------------------
# Why some of these are outputs rather than resources
# ---------------------------------------------------------------------------
#
# Half of what follows describes Cloud SQL and Cloud Run, which this module
# does not create. That is not an oversight and it is not a TODO: B0a's defining
# property is that it is a FREE apply. GCP bills most managed services for
# capacity that EXISTS, not capacity that is USED — an empty Cloud SQL instance
# costs the same as a busy one — so creating a database here would start a meter
# weeks before the code that talks to it is ready, and would change what the
# owner is authorising when they type `apply`.
#
# But "decide these DURING provisioning, not after" is exactly right, and a
# decision that lives only in a ledger row gets re-litigated by whoever writes
# B2. So the decisions are encoded HERE, as a machine-readable provisioning plan
# that B2 and B4 consume — `terraform output cloud_sql_plan` is the input to the
# resources they create, not a suggestion. Changing the number of instances or
# turning HA on becomes a visible diff in this file rather than an argument in a
# session.
#
# The controls that ARE structural in this module — C-1's toggle, C-6's absent
# connector, C-9's registry cleanup policy, C-8's exclusions — are enforced in
# locals.tf, network.tf, shared.tf and logging.tf respectively.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# C-1 — WHICH REGIONAL STACKS GET RESOURCES. Default: the UK only.
# ---------------------------------------------------------------------------
# ATTEMPT 2 REPLACED `enable_uk_resources` WITH THIS, AND THE REPLACEMENT IS NOT
# COSMETIC. The old variable gated the UK lane and nothing else, because in
# attempt 1 the US was live and the UK was the lane being held back. Attempt 2
# inverts the polarity — the UK is the only market and `us-prod` is DARK — and
# under a UK-only gate `us-prod` stayed unconditionally ACTIVE. The first apply
# would have built a VPC, a Cloud SQL instance (~$98/month, more than the whole
# budget) and a Google STT KMS key ring THAT CAN NEVER BE DELETED, for a lane
# nobody is serving. A gate named after one lane stops being a gate the moment
# the other lane is the one you want held back.
#
# ---------------------------------------------------------------------------
# U1, 2026-08-25 — THIS WAS A BOOL, AND `= true` PLANNED A DESTROY OF A
# DATABASE. The estate that happened on is gone; THE MECHANISM IS NOT, and it
# is why this is a list of stack keys rather than a bool or a lane name.
#
# network.tf composes a VPC's `description` from the sorted list of ACTIVE
# stacks in its project. Activating a second stack in an existing project
# rewrote that string:
#
#   "Private network for us-staging. ..."
#     -> "Private network for uk-staging, us-staging. ..."
#
# `description` on google_compute_network FORCES REPLACEMENT, and the
# replacement cascades down everything anchored to the network id:
#
#   google_compute_network.this[...]                       must be replaced
#     -> google_compute_global_address.private_services     must be replaced
#     -> google_service_networking_connection.private_...   must be replaced
#     -> google_sql_database_instance.this[...]             MUST BE REPLACED
#
# A ONE-WORD CHANGE TO A DESCRIPTION STRING DESTROYS THE DATABASE UNDER IT.
#
# Attempt 2 does not expose that trap TODAY, because every project holds exactly
# one stack and adding the other lane creates a new project rather than
# rewriting an existing VPC's description. IT COMES BACK the moment two stacks
# are ever pointed at one project in var.stack_projects. Read a plan for
# `google_compute_network ... must be replaced` before applying one, always.
# ---------------------------------------------------------------------------
variable "active_stacks" {
  description = <<-EOT
    Which REGIONAL stacks get resources provisioned, by stack key (`uk-prod`,
    `us-prod`). Default `["uk-prod"]` — the UK lane only.

    THE PROJECTS ARE NOT AFFECTED. All three are created either way; that is
    settled and not reopened, because a project is the credential and residency
    boundary and an empty project costs nothing. This governs what goes INSIDE
    them: VPC, subnet, peering range, runtime service account, IAM, secrets, and
    (via cloud_sql_plan / cloud_run_scaling) the database and Cloud Run services.

    `us-prod` is DARK on purpose. The US lane is built and tested and provisioned
    nowhere — there is no GCP BAA, Twilio's is $2,000/month, and US healthcare is
    closed. Adding "us-prod" here is the one line that lights it, and it costs a
    Cloud SQL instance from the moment it is applied.

    ⚠ NAMING BOTH LANES ROUGHLY DOUBLES THE BILL and buys nothing while the US
    has no customers. The budget is ~$55-80/month for the whole estate.
  EOT
  type        = list(string)
  default     = ["uk-prod"]

  validation {
    # An unknown key is a SILENT no-op — the filter in locals.tf simply never
    # matches it — so `["uk_prod"]` would plan zero resources and read as "the
    # UK stack already exists".
    condition = alltrue([
      for k in var.active_stacks : contains(["uk-prod", "us-prod"], k)
    ])
    error_message = "active_stacks must name regional stack keys: \"uk-prod\" and/or \"us-prod\". An unknown key would be silently ignored."
  }

  validation {
    condition     = length(var.active_stacks) > 0
    error_message = "active_stacks cannot be empty — with no regional stack active the module provisions three empty projects and nothing that answers a phone. If that is genuinely what you want, say so by commenting out the resources rather than by emptying this."
  }
}

# ---------------------------------------------------------------------------
# C-2 and C-11 — Cloud Run scaling. Consumed by B4.
#
# C-2:  staging runs at min-instances 0.
# C-11: of the production services, only the VOICE one runs warm.
#
# Both come from the same observation, which is worth stating once because it
# is the only reason warm instances exist here at all: a cold start is roughly a
# second of silence, and the thing that makes that unacceptable is a HUMAN BEING
# HOLDING A PHONE. Nobody is on the phone with staging. Nobody is on the phone
# with the dashboard's settings page. Four warm services were being bought to
# solve a problem exactly one of them has.
#
# ---------------------------------------------------------------------------
# ⚠ `cpu_idle` IS THE BUDGET, AND ATTEMPT 2 REVERSES ATTEMPT 1'S ANSWER HERE.
#
# `cpu_idle = false` is Cloud Run's "CPU always allocated". Attempt 1 paired it
# with min_instances = 1 on the reasoning that a warm instance with throttled
# CPU is not warm, because the first request still waits for the CPU to be
# un-throttled — buying one without the other buys nothing.
#
# The reasoning is sound and the price is not affordable. `min_instances = 1`
# with `cpu_idle = false` is ~$70/month ON THAT LINE ALONE, against a whole-
# estate budget of ~$55-80/month. It is not a line item; it IS the budget.
#
# SO: `min_instances = 1` with `cpu_idle = true`. The instance stays resident —
# no container start, no Node boot, no module graph, no pool construction — and
# what is given up is the CPU un-throttle on the first request after an idle
# gap. That is a fraction of a cold start, not a cold start.
#
# WHAT THIS BUYS IS UNMEASURED AND MUST NOT BE WRITTEN DOWN AS MEASURED. The
# only honest test is a live call after an idle period, watching the FIRST turn
# rather than a steady-state p50 — the whole effect is on the first request and
# a warm harness would average it away. Measured p50 today is 3,062 ms end to
# end, so a several-hundred-millisecond regression on turn one is inside the
# noise of every instrument currently pointed at this and would be invisible to
# all of them. If turn one is audibly worse on a real call, the fix is one bool
# and ~$70/month, and that is a decision to take with the recording in hand.
# ---------------------------------------------------------------------------
variable "cloud_run_services" {
  description = <<-EOT
    The Cloud Run services each regional stack runs, and which of them is
    latency-critical enough to keep warm.

    `warm_in_prod = true` means min-instances 1 with CPU always allocated, in
    production only. Exactly one service should have it, and if a second one
    ever does, the justification is "a caller is waiting on it", not "it feels
    slow".
  EOT
  type = map(object({
    warm_in_prod = bool
    reason       = string
  }))

  default = {
    voice = {
      warm_in_prod = true
      reason       = "A cold start lands mid-call, on a caller who is listening to silence."
    }
    dashboard-api = {
      warm_in_prod = false
      reason       = "Nobody is holding a phone waiting for a settings page. A cold start here is a slow page load."
    }
  }
}

variable "cloud_run_timeout_seconds" {
  description = <<-EOT
    Request timeout. 3600 because the voice service's request IS the call — the
    Twilio Media Streams WebSocket is held open for the call's duration, and a
    shorter timeout hangs up on a long conversation.
  EOT
  type        = number
  default     = 3600
}

variable "cloud_run_max_instances" {
  description = <<-EOT
    Upper bound on autoscaling, per service. This is a COST CEILING as much as a
    capacity one: with concurrency 10 and no ceiling, a retry storm or a bad
    actor dialling in a loop scales the bill rather than shedding load.
  EOT
  type = object({
    prod    = number
    staging = number
  })
  default = {
    prod    = 20
    staging = 3
  }
}

# ---------------------------------------------------------------------------
# C-4 and C-5 — Cloud SQL. Consumed by B2.
#
# C-4: staging shares ONE instance, one database per stack.
# C-5: no HA (regional) at launch.
#
# The instance map below is keyed by PROJECT, not by stack, and that single
# choice is what implements C-4 — two stacks sharing a project share its
# instance and take a database each. It also survives the 4 -> 6 restore with no
# edit: put `uk-staging` back in its own project and it necessarily gets its own
# instance, because a project is what an instance belongs to.
# ---------------------------------------------------------------------------
variable "cloud_sql_high_availability" {
  description = <<-EOT
    Whether production Cloud SQL instances run REGIONAL (HA) rather than ZONAL.
    Default false. Regional roughly DOUBLES the instance cost.

    HA IS NOT A HIPAA REQUIREMENT, and this is the part that gets assumed
    wrongly. §164.308(a)(7) asks for a data backup plan, a disaster recovery
    plan and emergency mode operation. Point-in-time recovery, automated
    backups and the restore test Lane C gates on (C7) satisfy all three. HA
    buys you a shorter outage, which is an availability choice — buy it when
    downtime costs more than the second instance does, and not before.
  EOT
  type        = bool
  default     = false
}

variable "cloud_sql_tier" {
  description = "Machine tier per environment. Staging is deliberately the smallest thing that runs the schema."
  type = object({
    prod    = string
    staging = string
  })
  default = {
    prod    = "db-custom-2-7680"
    staging = "db-g1-small"
  }
}

variable "cloud_sql_backup_retention_days" {
  description = <<-EOT
    Automated backup retention, production only. Staging holds no data worth
    recovering — that is the rule the merged staging project is backed by — so
    it takes the minimum.

    Not six years. §164.316(b)(2)(i)'s six years is about Security Rule
    DOCUMENTATION, not about data or backups. See var.audit_log_retention_days
    for the same trap in the other direction.
  EOT
  type = object({
    prod    = number
    staging = number
  })
  default = {
    prod    = 35
    staging = 7
  }
}

# ---------------------------------------------------------------------------
# C-3 — Postgres instead of Memorystore for the shared call-state slice.
#
# Recorded here rather than only in the ledger because the way this decision
# gets undone is someone provisioning Redis in B2 without knowing it was made.
# The absence of `redis.googleapis.com` from local.regional_apis and of
# `roles/redis.editor` from local.runtime_roles is the enforcement; this is the
# explanation those two absences point at.
#
# WHAT IS ACTUALLY SHARED (lib/callStateStore.js, A4): three scalars —
# `dbCallId`, `businessId`, `sawCallerFinal` — behind a three-method interface
# (get / merge / delete) keyed by call SID. Read once at `start`, written at
# call boundaries, and `sawCallerFinal` is a latch written on one transition.
# ZERO per-turn reads and ZERO per-turn writes.
#
# That finding is what made Memorystore latency-free. It is equally what makes
# it unnecessary. See the ledger's C-3 entry for the costing.
# ---------------------------------------------------------------------------
variable "call_state_store" {
  description = <<-EOT
    Where the shared call-state slice lives. "postgres" (C-3) or "memorystore".

    Changing this to "memorystore" is a $70-100/month decision and should come
    with a measurement showing the Postgres boundary write is a problem. A4's
    store interface makes the swap a single adapter either way, which is why
    this can be a variable instead of an argument.
  EOT
  type        = string
  default     = "postgres"

  validation {
    condition     = contains(["postgres", "memorystore"], var.call_state_store)
    error_message = "call_state_store must be \"postgres\" or \"memorystore\"."
  }
}

# ---------------------------------------------------------------------------
# C-6 — Direct VPC egress. Structural: see the closing comment in network.tf,
# and the test that fails the build if a connector reappears.
# ---------------------------------------------------------------------------
variable "cloud_run_vpc_egress" {
  description = <<-EOT
    How Cloud Run reaches the private-IP database. "direct" (C-6) or
    "connector".

    A Serverless VPC Access connector is a managed group of real VM instances
    billed per instance-hour whether or not a packet crosses it — roughly $30-40
    each, so four of them is $120-160/month. Direct VPC egress reaches the same
    private IPs, allocates from the subnet in network.tf, and has no fixed
    charge.
  EOT
  type        = string
  default     = "direct"

  validation {
    condition     = contains(["direct", "connector"], var.cloud_run_vpc_egress)
    error_message = "cloud_run_vpc_egress must be \"direct\" or \"connector\"."
  }
}

# ---------------------------------------------------------------------------
# The derived provisioning plan. This is what B2 and B4 read.
# ---------------------------------------------------------------------------
locals {
  # C-4 / C-5. One instance per PROJECT holding active regional stacks; one
  # database per stack in it.
  cloud_sql_plan = {
    for pk in local.active_regional_project_keys : pk => {
      project_id = google_project.this[pk].project_id
      instance   = "vetra-${pk}"
      region     = local.projects[pk].region
      tier       = local.projects[pk].has_prod ? var.cloud_sql_tier.prod : var.cloud_sql_tier.staging

      # C-5. Only production is even a candidate for HA, and only if the
      # variable says so. Staging is never regional.
      availability_type = (local.projects[pk].has_prod && var.cloud_sql_high_availability) ? "REGIONAL" : "ZONAL"

      # §164.308(a)(7)'s backup plan, and C7's restore test operates on this.
      point_in_time_recovery = local.projects[pk].has_prod
      backup_retention_days  = local.projects[pk].has_prod ? var.cloud_sql_backup_retention_days.prod : var.cloud_sql_backup_retention_days.staging

      # One network per project — see network.tf. This is exactly why: a Cloud
      # SQL instance peers to ONE VPC, so a shared staging instance needs the
      # stacks sharing it to share a network too.
      private_network = google_compute_network.this[pk].id

      # C-4 in one line: the databases of every ACTIVE stack in this project.
      # One entry today for each prod project; two for merged staging once the
      # UK toggle is on.
      databases = [
        for sk in local.projects[pk].stacks : {
          name  = "vetra_${replace(sk, "-", "_")}"
          stack = sk
        } if contains(keys(local.active_regional_stacks), sk)
      ]

      # C-3. Named per instance so B2 cannot provision Redis for one stack and
      # a table for another.
      call_state_store = var.call_state_store
    }
  }

  # C-2 / C-11. Every (active stack x service) pair, with the warm decision
  # already made.
  cloud_run_scaling = merge([
    for sk, sv in local.active_regional_stacks : {
      for svc, cfg in var.cloud_run_services : "${sk}/${svc}" => {
        stack   = sk
        service = "${svc}-${sv.lane}-${sv.env}"
        project = local.project_id_for_stack[sk]
        region  = sv.region

        # C-2 is the `sv.env == "prod"` half; C-11 is the `cfg.warm_in_prod`
        # half. Both must be true to buy a warm instance.
        min_instances = (sv.env == "prod" && cfg.warm_in_prod) ? 1 : 0

        # ALWAYS TRUE. See the long note above this variable block: attempt 1
        # set this to `false` alongside min_instances = 1, and that pairing is
        # ~$70/month, which is the entire estate budget. Kept as a field rather
        # than inlined into cloud-run.tf so reversing it after a live call is
        # one line here and not a hunt through the service definition.
        cpu_idle = true

        max_instances   = sv.env == "prod" ? var.cloud_run_max_instances.prod : var.cloud_run_max_instances.staging
        timeout_seconds = var.cloud_run_timeout_seconds
        vpc_egress      = var.cloud_run_vpc_egress
        subnetwork      = google_compute_subnetwork.this[sk].id
        service_account = google_service_account.runtime[sk].email
        warm_rationale  = (sv.env == "prod" && cfg.warm_in_prod) ? cfg.reason : "Scales to zero: ${cfg.reason}"
      }
    }
  ]...)
}
