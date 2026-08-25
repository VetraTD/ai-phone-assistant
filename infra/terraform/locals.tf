# ---------------------------------------------------------------------------
# Stacks, and the projects they land in.
#
# There are two levels here and keeping them straight is the whole file:
#
#   STACK    a logical unit — "the UK staging environment". Six of them, fixed
#            by the design, described once below rather than six times.
#
#   PROJECT  a GCP billing, quota and IAM boundary. Derived from the stacks by
#            `var.stack_projects`. Six of them when that map is the identity;
#            four when two stacks are told to share.
#
# They were 1:1 until the billing account's 5-linked-project cap forced two of
# the no-PHI stacks to share. Deriving projects from stacks rather than writing
# them out means the collapse and the restore are both a tfvars edit.
#
# Projects are SIBLINGS under the organization. GCP has no such thing as a
# sub-project; nesting is done with folders, which hold no resources.
# ---------------------------------------------------------------------------

locals {
  # `in:us-locations` and `in:eu-locations` are Google's value groups for the
  # gcp.resourceLocations constraint. They are the enforcement behind the entire
  # two-region design: with them, creating a resource in the wrong continent is
  # an API rejection rather than a code review someone has to catch.
  #
  # ⚠ THE CONSTRAINT IS ENFORCED PER SERVICE, AND CLOUD LOGGING IS NOT ONE OF
  # THEM. Two log buckets already sit in `europe-west2` inside `vetra-shared`,
  # whose location set has never permitted it — so they were created despite the
  # policy rather than because of it. Verified 2026-08-25 while chasing the
  # Brexit finding below. So this is a real control with a coverage gap, and the
  # gap is invisible: the services it does not cover fail open and silently.
  # Do not read "the org policy enforces the two-region design" as universal.
  us_locations = ["in:us-locations"]
  eu_locations = ["in:eu-locations"]

  # ---------------------------------------------------------------------------
  # THE UK IS NOT IN `in:eu-locations`, AND THAT SENTENCE IS THE WHOLE COMMENT.
  #
  # Found 2026-08-25 by the first apply that ever tried to create something in a
  # UK project. It failed:
  #
  #   Constraint constraints/gcp.resourceLocations violated for
  #   [orgpolicy:projects/693741698596] attempting to create a secret in
  #   [europe-west2]
  #
  # `in:eu-locations` is Google's value group for the EUROPEAN UNION.
  # `europe-west2` is LONDON. The UK left the EU, so Google's EU group does not
  # contain it — measured rather than inferred: the effective policy on
  # `uk-prod` expands to 66 values, 36 of them `europe-west*`, and NOTHING
  # matching `west2` appears anywhere in the list. What is allowed is
  # europe-west1/3/4/8/9/10/12 — Belgium, Frankfurt, Netherlands, Milan, Paris,
  # Berlin, Turin — every one of them an EU member state.
  #
  # This blocked EVERY regional resource in the UK lane, not just the secret the
  # apply happened to reach first: Cloud SQL, Cloud Run, the KMS key ring and
  # the subnet would each have been refused in turn. It has been latent since
  # B0w wrote the org policies and was unreachable while
  # `enable_uk_resources` was off.
  #
  # THE CHOICE MADE, 2026-08-25, by the owner: keep London and widen the group,
  # rather than move the stack to europe-west1. Moving would have needed no
  # policy change at all and costs ~10 ms — but it turns the answer to "where is
  # my data" from "London" into "Belgium, which the UK recognises as adequate",
  # and the UK residency claim is what makes this lane a sales asset. This file
  # already carries one claim that had to be downgraded to a disclosed transfer
  # (Identity Platform); a second voluntary downgrade to avoid a one-line edit
  # is a poor trade.
  #
  # THIS IS NOT THE CONSTRAINT BEING WEAKENED. Its job is to make "a UK resource
  # in America" an API rejection rather than a code review, and it still does
  # that: `in:europe-west2-locations` adds London and nothing else. The group
  # was a B0w default chosen before anyone had thought about Brexit, not a
  # decision being overridden.
  # ---------------------------------------------------------------------------
  uk_locations = ["in:eu-locations", "in:europe-west2-locations"]

  common_apis = [
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]

  # Everything a voice stack needs to serve a call. Vertex, STT and TTS are here
  # rather than in shared because the US lane's model and speech traffic must
  # stay inside the US project's location constraint.
  #
  # `redis.googleapis.com` is deliberately ABSENT — see cost-controls.tf, C-3.
  # Memorystore is not being provisioned, and an API enabled "just in case" is
  # how a $70-100/month instance gets created by someone who assumed the
  # decision had gone the other way.
  regional_apis = concat(local.common_apis, [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "aiplatform.googleapis.com",
    "speech.googleapis.com",
    "texttospeech.googleapis.com",
    "cloudscheduler.googleapis.com",
  ])

  # -------------------------------------------------------------------------
  # APIs Terraform calls THROUGH the quota project.
  #
  # `user_project_override = true` routes every API call Terraform makes for
  # quota and billing through `bootstrap_project_id` — which is now `shared`.
  # Google requires the API to be enabled ON THAT PROJECT even though the
  # resource lands elsewhere entirely.
  #
  # THIS LIST IS A SUPERSET OF WHAT THE SHARED PROJECT ITSELF RUNS, and that is
  # correct rather than sloppy: `sqladmin` is here because Terraform creates a
  # Cloud SQL instance in ANOTHER project, not because anything in `shared`
  # holds a database.
  #
  # It is written as one list because the alternative is what actually happened
  # — three separate applies, each dying on a different missing API, each with
  # a 403 that names this project and reads as a permissions problem:
  #
  #   Error 403: Organization Policy API has not been used in project ...
  #   Error 403: Cloud Billing Budget API has not been used in project ...
  #   Error 403: Cloud SQL Admin API has not been used in project ...
  #
  # Enabling an API is free. Add to this list whenever the module starts
  # managing a new kind of resource, BEFORE the apply rather than after it.
  # -------------------------------------------------------------------------
  terraform_quota_apis = [
    "orgpolicy.googleapis.com",
    "cloudbilling.googleapis.com",
    "billingbudgets.googleapis.com",
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "cloudkms.googleapis.com",
    "run.googleapis.com",
    "cloudscheduler.googleapis.com",
    "storage.googleapis.com",
    # The budget notification channels. Terraform CALLS the Monitoring API to
    # create them, so it belongs on this list even though it is already enabled
    # on vetra-shared for other reasons — the standing rule is that this list
    # covers every API Terraform calls, not every API the project runs, and it
    # has fired as a 403 naming the quota project three times already.
    "monitoring.googleapis.com",
    # B3. Terraform creates the Identity Platform config and its API key, so both
    # are calls made THROUGH the quota project even though the resources land in
    # `shared`. Added before the apply rather than after the third 403.
    "identitytoolkit.googleapis.com",
    "apikeys.googleapis.com",
    # Fifth occurrence of this trap. Terraform now manages org-node Essential
    # Contacts, so it CALLS this API through the quota project even though the
    # contacts hang off the organization and not off any project.
    "essentialcontacts.googleapis.com",
  ]

  shared_apis = concat(local.common_apis, local.terraform_quota_apis, [
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "secretmanager.googleapis.com",
  ])

  logging_apis = concat(local.common_apis, [
    "storage.googleapis.com",
  ])

  # -------------------------------------------------------------------------
  # The six stacks.
  # -------------------------------------------------------------------------
  stacks = {
    us-prod = {
      display   = "Vetra US Prod"
      lane      = "us"
      env       = "prod"
      region    = var.us_region
      locations = local.us_locations
      apis      = local.regional_apis
      phi       = true
    }
    us-staging = {
      display   = "Vetra US Staging"
      lane      = "us"
      env       = "staging"
      region    = var.us_region
      locations = local.us_locations
      apis      = local.regional_apis
      phi       = false
    }
    uk-prod = {
      display   = "Vetra UK Prod"
      lane      = "uk"
      env       = "prod"
      region    = var.uk_region
      locations = local.uk_locations
      apis      = local.regional_apis
      phi       = true
    }
    uk-staging = {
      display   = "Vetra UK Staging"
      lane      = "uk"
      env       = "staging"
      region    = var.uk_region
      locations = local.uk_locations
      apis      = local.regional_apis
      phi       = false
    }
    shared = {
      display = "Vetra Shared"
      lane    = "shared"
      env     = "shared"
      region  = var.us_region
      # Both continents. This stack holds Artifact Registry, Cloud Build and
      # Identity Platform, and it serves BOTH regional stacks — a UK Cloud Run
      # service pulling an image from a US registry is fine, because container
      # images are not patient data. Constraining it to one continent would
      # force a second registry for no safety gain.
      locations = concat(local.us_locations, local.uk_locations)
      apis      = local.shared_apis
      phi       = false
    }
    logging = {
      display = "Vetra Logging"
      lane    = "logging"
      env     = "logging"
      region  = var.us_region
      # Both continents, deliberately, because this stack holds TWO regional
      # sets of log buckets rather than one. UK logs landing in a US bucket
      # would be a transfer, so the sinks are split by origin — see logging.tf.
      locations = concat(local.us_locations, local.uk_locations)
      apis      = local.logging_apis
      phi       = false
    }
  }

  # -------------------------------------------------------------------------
  # Projects, derived.
  #
  # A project's attributes are the UNION of the stacks living in it, which is
  # the only safe direction to combine them: a project hosting a US stack and a
  # UK stack must permit both continents and enable both stacks' APIs, and it
  # holds PHI if ANY of its stacks does. Taking a first-stack-wins shortcut here
  # would quietly under-permit a merged project and over-claim its posture.
  # -------------------------------------------------------------------------
  project_keys = distinct(values(var.stack_projects))

  stacks_in_project = {
    for pk in local.project_keys : pk => sort([
      for sk, target in var.stack_projects : sk if target == pk
    ])
  }

  projects = {
    for pk, members in local.stacks_in_project : pk => {
      # A project named after a stack takes that stack's display name, unless
      # overridden. A project hosting more than one stack should be overridden —
      # see var.project_display_names.
      display = lookup(var.project_display_names, pk, local.stacks[pk].display)

      # `lane`/`env` become labels. A merged project genuinely has no single
      # value for either, and saying so is better than picking one: a console
      # filter on `env=staging` should not silently hide half of what is there.
      lane = length(members) == 1 ? local.stacks[members[0]].lane : "multi"
      env  = length(members) == 1 ? local.stacks[members[0]].env : "multi"

      region    = local.stacks[pk].region
      locations = distinct(flatten([for sk in members : local.stacks[sk].locations]))
      apis      = distinct(flatten([for sk in members : local.stacks[sk].apis]))
      phi       = anytrue([for sk in members : local.stacks[sk].phi])
      stacks    = members

      # Whether ANY stack here is production. Sizing, HA and warm-instance
      # decisions all key off this, and `anytrue` is the only safe direction:
      # a project that holds one prod stack is a prod project, whatever else is
      # in it. (Today nothing else can be — the validation on var.stack_projects
      # forbids a prod stack from sharing — but the derivation should not depend
      # on that staying true.)
      has_prod = anytrue([for sk in members : local.stacks[sk].env == "prod"])
    }
  }

  # The project a given stack lives in, as a project ID. Every resource that is
  # per-STACK reaches its project through this, so nothing has to know whether
  # the shape is four or six.
  project_id_for_stack = {
    for sk, pk in var.stack_projects : sk => google_project.this[pk].project_id
  }

  # -------------------------------------------------------------------------
  # Regional stacks — the four that serve calls and hold a VPC. `shared` and
  # `logging` have no network of their own.
  #
  # `active_regional_stacks` is the same set minus anything C-1 has switched
  # off. Everything that provisions per-stack infrastructure iterates over the
  # ACTIVE set; everything that describes the design iterates over all four.
  # -------------------------------------------------------------------------
  regional_stacks = {
    for k, v in local.stacks : k => v if contains(["us", "uk"], v.lane)
  }

  # C-1, per UK STACK rather than per lane. `enable_uk_resources` is a list of
  # stack keys precisely so `uk-prod` can be built without `uk-staging` — see
  # the long note above the variable in cost-controls.tf. Naming uk-staging here
  # adds a stack to the us-staging project, which rewrites that project's VPC
  # description, which forces the network to be replaced, which replaces the
  # Cloud SQL instance under it.
  active_regional_stacks = {
    for k, v in local.regional_stacks : k => v
    if v.lane != "uk" || contains(var.enable_uk_resources, k)
  }

  # Distinct PROJECTS holding at least one active regional stack. Used for the
  # bindings that are per-project rather than per-stack — granting the same
  # (project, role, member) twice is two Terraform resources fighting over one
  # IAM binding, which flaps on every plan.
  active_regional_project_keys = distinct([
    for sk in keys(local.active_regional_stacks) : var.stack_projects[sk]
  ])

  # Project IDs are immutable and carry a suffix. Losing state must not rename
  # them, so a pinned suffix wins over a generated one — see var.project_id_suffix.
  project_suffix = var.project_id_suffix != "" ? var.project_id_suffix : random_id.project_suffix.hex
}
