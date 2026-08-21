# ---------------------------------------------------------------------------
# The projects, their APIs, and the per-stack runtime service accounts.
#
# Note the two different for_each sources below, and that the difference is the
# point of this refactor:
#
#   local.projects               billing / quota / IAM boundaries. Four today.
#   local.active_regional_stacks logical stacks that serve calls. Two today,
#                                four once C-1's UK toggle goes on.
# ---------------------------------------------------------------------------

# Only consulted when var.project_id_suffix is empty — see locals.tf. Kept as a
# resource rather than deleted so a genuinely new organization can still bring
# the module up without hand-picking a suffix.
resource "random_id" "project_suffix" {
  byte_length = 3
}

resource "google_project" "this" {
  for_each = local.projects

  name            = each.value.display
  project_id      = "${var.project_prefix}-${each.key}-${local.project_suffix}"
  org_id          = var.org_id
  billing_account = var.billing_account

  # PREVENT, not DELETE, and this was changed after reading a real plan.
  #
  # The original reasoning for DELETE was that `terraform destroy` should be
  # complete — a half-destroy leaves an orphan project that collides with its
  # own recreate. That is true and it is the smaller problem.
  #
  # What the plan showed is that adopting these projects would flip them from
  # the provider's PREVENT default to DELETE, putting "delete four GCP
  # projects" one `terraform destroy` away, in a repo whose own operating rules
  # list creating or deleting a project as something that needs the owner
  # present. A deleted project also holds its ID for 30 DAYS, and the ledger
  # already has a decision recording that exact collision.
  #
  # And this session is the evidence: state is the fragile half, projects are
  # the durable half. B0a's state vanished and every project survived. A
  # configuration that lets a lost or confused state take the projects with it
  # has the risk backwards.
  #
  # C-1's workflow still works — "provision UK, run the gates, destroy the UK
  # resources, keep the project" is a `-target`ed destroy of resources, and
  # PREVENT does not block any of it.
  #
  # NOTE EITHER WAY: removing a stack from var.stack_projects removes its
  # project from the config. With PREVENT the destroy is refused loudly; with
  # DELETE it would have gone through. The 6 -> 4 collapse is still not done by
  # deleting anything — the vacated projects are the restore path, and an
  # unbilled project costs nothing. `terraform state rm` them, then edit the map.
  deletion_policy = var.project_deletion_policy

  labels = merge(var.labels, {
    lane = each.value.lane
    env  = each.value.env
    phi  = each.value.phi ? "true" : "false"
    # Which stacks actually live here. On a merged project this is the only
    # place the console tells the truth about what it contains.
    stacks = join("_", each.value.stacks)
  })

  # Google auto-creates a default VPC with permissive firewall rules on every
  # new project. The org policy in org-policies.tf suppresses that, and this
  # makes the dependency explicit so ordering cannot drift.
  auto_create_network = false

  depends_on = [google_org_policy_policy.skip_default_network]
}

# Enabling a service is eventually consistent and frequently races the first
# resource that needs it. `disable_dependent_services` is left at its default so
# that removing an API from the list does not silently take out something else
# still using it.
resource "google_project_service" "this" {
  for_each = merge([
    for pk, pv in local.projects : {
      for api in pv.apis : "${pk}/${api}" => { project = pk, api = api }
    }
  ]...)

  project = google_project.this[each.value.project].project_id
  service = each.value.api

  # Leaving services enabled on destroy is deliberate: disabling an API can
  # cascade into deleting resources that outlive this module.
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Runtime service accounts.
#
# One per regional STACK, not per project — a merged staging project holds two
# of them, `voice-us-staging` and `voice-uk-staging`. That is deliberate and it
# is the only part of the credential boundary the merge preserves: the two
# stacks share a project, so they share the project's secrets, but they do not
# share an identity, so IAM and the audit trail can still tell them apart.
#
# Created here rather than in B4 so that IAM, secrets and CMEK grants all have a
# principal to reference before any workload exists.
#
# Note what is NOT here: no service account KEYS. The org policy forbids
# creating them, and Cloud Run obtains credentials from the metadata server
# instead. A downloaded key is a long-lived credential that cannot be rotated by
# revoking a session, which is exactly the thing a HIPAA posture should not own.
# ---------------------------------------------------------------------------
resource "google_service_account" "runtime" {
  for_each = local.active_regional_stacks

  project      = local.project_id_for_stack[each.key]
  account_id   = "voice-${each.value.lane}-${each.value.env}"
  display_name = "${each.value.display} — Cloud Run runtime"
  description  = "Runtime identity for the ${each.value.lane} ${each.value.env} voice stack. Keyless: credentials come from the metadata server."

  depends_on = [google_project_service.this]
}
