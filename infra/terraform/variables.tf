variable "org_id" {
  description = "GCP organization ID for vetratd.com. Numeric, not the domain."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{6,}$", var.org_id))
    error_message = "org_id must be the numeric organization ID (e.g. 564252011558), not the domain name."
  }
}

variable "billing_account" {
  description = "Cloud Billing account ID in XXXXXX-XXXXXX-XXXXXX form."
  type        = string

  validation {
    condition     = can(regex("^[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$", var.billing_account))
    error_message = "billing_account must look like 01C71E-7C0893-377AE9."
  }
}

variable "bootstrap_project_id" {
  description = <<-EOT
    The project Terraform's own API calls are billed and quota'd against. It is
    NOT where resources land.

    Today this is `vetra-shared`, which is where it was always going to end up:
    the trial-signup project (`ultra-glyph-506120-v5`) was only ever a stand-in
    for the window before the six projects existed, and that window has closed.
    Pointing it at `shared` early removes the ordering trap in O3c, where
    deleting the bootstrap project breaks every subsequent Terraform run.

    Whatever this points at needs each API Terraform calls through it ENABLED on
    it — see the bootstrap section of the README. That failure reads as a
    permissions problem and is not.
  EOT
  type        = string
}

variable "project_prefix" {
  description = "Prefix for generated project IDs. Project IDs are globally unique and immutable."
  type        = string
  default     = "vetra"
}

variable "project_id_suffix" {
  description = <<-EOT
    The suffix baked into every project ID: `<prefix>-<key>-<suffix>`.

    Originally a `random_id`, to stop a first apply failing on a globally-taken
    name like `vetra-us-prod`. That purpose is spent — the projects exist, and
    a project ID is IMMUTABLE. Leaving it random meant the IDs were reproducible
    only from Terraform state, so losing state renamed every project. Which is
    exactly what happened: B0a's state is gone and the projects are not.

    Set it to the recorded suffix and the module can be rebuilt from the config
    alone. Leave it empty and a fresh `random_id` is generated, which is correct
    only for a genuinely new organization.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.project_id_suffix == "" || can(regex("^[a-z0-9]{4,12}$", var.project_id_suffix))
    error_message = "project_id_suffix must be 4-12 lowercase alphanumerics, or empty to generate one."
  }
}

# ---------------------------------------------------------------------------
# The stack -> project map. This is the 6/4 dial.
#
# A STACK is a logical unit — "the UK staging environment". A PROJECT is a GCP
# billing and IAM boundary. They were 1:1 until the billing account's 5-project
# cap forced two of them to share, and the whole point of this variable is that
# the collapse and the restore are a tfvars edit rather than a module rewrite.
#
# The DEFAULT here is the six-project target, because that is the design. The
# four-project reality is an override in terraform.tfvars, which is where a
# temporary shape belongs — and deleting two lines from that file is the entire
# restore.
#
# What the merge is allowed to touch: only projects the spec already calls
# "No PHI". `us-prod` and `uk-prod` never share with anything, ever. That
# separation is the credential boundary — `voice-us` holds no ElevenLabs key —
# and Cloud SQL instances and Identity Platform tenants cannot be moved between
# projects afterwards, so a prod merge would be close to permanent.
# ---------------------------------------------------------------------------
variable "stack_projects" {
  description = <<-EOT
    Which project each stack lives in. Keys are the six stacks; values are the
    project each one is provisioned into.

    Identity map = six projects. Point two stacks at one project and they share
    it — that is the 6 -> 4 collapse, and reverting it is deleting the override.

    Merging a stack does NOT delete the project it vacated. An unbilled project
    costs nothing and does not consume the billing quota, so the vacated ones
    are the restore path: relink, do not recreate.
  EOT
  type        = map(string)

  default = {
    us-prod    = "us-prod"
    us-staging = "us-staging"
    uk-prod    = "uk-prod"
    uk-staging = "uk-staging"
    shared     = "shared"
    logging    = "logging"
  }

  validation {
    condition = length(setsubtract(
      ["us-prod", "us-staging", "uk-prod", "uk-staging", "shared", "logging"],
      keys(var.stack_projects)
    )) == 0
    error_message = "stack_projects must name all six stacks: us-prod, us-staging, uk-prod, uk-staging, shared, logging."
  }

  validation {
    condition     = alltrue([for v in values(var.stack_projects) : contains(keys(var.stack_projects), v)])
    error_message = "Every stack must map to a project key that is itself one of the six stack keys — the project inherits that stack's ID and default display name."
  }

  # The credential boundary, as a validation rather than a comment. A merge that
  # put a prod stack in a shared project would silently undo the one property
  # the six-project split exists to make structural.
  validation {
    condition = alltrue([
      for s in ["us-prod", "uk-prod"] :
      length([for k, v in var.stack_projects : k if v == var.stack_projects[s]]) == 1
    ])
    error_message = "us-prod and uk-prod must each have a project to themselves. The prod split is the credential boundary — voice-us holding no ElevenLabs key — and Cloud SQL and Identity Platform cannot be moved between projects afterwards."
  }
}

variable "project_deletion_policy" {
  description = <<-EOT
    What `terraform destroy` is allowed to do to a PROJECT. "PREVENT" or "DELETE".

    PREVENT by default. See the long note in projects.tf: a deleted project
    holds its ID for 30 days, project deletion is on this repo's owner-present
    list, and B0a demonstrated that state is the fragile half while the projects
    are the durable one.

    Set DELETE only for a genuinely disposable environment.
  EOT
  type        = string
  default     = "PREVENT"

  validation {
    condition     = contains(["PREVENT", "DELETE"], var.project_deletion_policy)
    error_message = "project_deletion_policy must be \"PREVENT\" or \"DELETE\"."
  }
}

variable "project_display_names" {
  description = <<-EOT
    Display-name overrides, keyed by PROJECT (not stack). A project hosting two
    stacks should say so — the console is where someone forms their mental model
    of what is running, and "Vetra US Staging" quietly hides a UK stack.

    Unlike the project ID, the display name is mutable. Absent an entry, a
    project takes the display name of the stack it is named after.
  EOT
  type        = map(string)
  default     = {}
}

variable "adopt_existing_projects" {
  description = <<-EOT
    Projects that already exist in GCP and should be ADOPTED into state rather
    than created, keyed by project key. Drives `import` blocks in imports.tf.

    This exists because B0a's local state was lost while the resources it
    created were not. Import blocks are the right shape for that: `plan` renders
    exactly what would be adopted and writes nothing, so the state change
    happens on an apply the owner runs, not on a plan a session runs.

    EMPTY IS THE STEADY STATE. Fill it for the adoption apply, then empty it —
    Terraform errors on an import block targeting an address already in state.
  EOT
  type        = map(string)
  default     = {}
}

variable "adopt_existing_org_policies" {
  description = <<-EOT
    Org-node policy constraints that already exist and should be adopted rather
    than created, e.g. ["iam.disableServiceAccountKeyCreation"]. Same reasoning
    and same lifecycle as adopt_existing_projects.
  EOT
  type        = list(string)
  default     = []
}

variable "owner_principals" {
  description = <<-EOT
    Principals with full access to every project, in `user:email` form.
    The founder who administers the infrastructure.
  EOT
  type        = list(string)
}

variable "shared_only_principals" {
  description = <<-EOT
    Principals granted access to `vetra-shared` ONLY — Artifact Registry and
    Cloud Build — and to no project that can hold PHI.

    This is the per-founder split. A cofounder working on the website and the
    build pipeline has no reason to reach vetra-us-prod, and here that is
    enforced by IAM rather than by remembering. Leave empty if nobody needs it;
    an empty list grants nothing, which is the correct default.
  EOT
  type        = list(string)
  default     = []
}

variable "us_region" {
  description = "Region for the US (HIPAA) stack."
  type        = string
  default     = "us-central1"
}

variable "uk_region" {
  description = "Region for the UK (GDPR) stack. europe-west2 is London."
  type        = string
  default     = "europe-west2"
}

variable "labels" {
  description = "Labels applied to every project."
  type        = map(string)
  default = {
    managed-by = "terraform"
    system     = "vetra-receptionist"
  }
}
