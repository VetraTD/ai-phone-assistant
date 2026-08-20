# ---------------------------------------------------------------------------
# The six projects, their APIs, and their runtime service accounts.
# ---------------------------------------------------------------------------

# Project IDs are globally unique across all of GCP and IMMUTABLE once created —
# only the display name can change later. A random suffix avoids a first apply
# that fails because someone, somewhere, already owns `vetra-us-prod`.
resource "random_id" "project_suffix" {
  byte_length = 3
}

resource "google_project" "this" {
  for_each = local.projects

  name            = each.value.display
  project_id      = "${var.project_prefix}-${each.key}-${random_id.project_suffix.hex}"
  org_id          = var.org_id
  billing_account = var.billing_account

  # Terraform owns these projects. Without this, `terraform destroy` leaves the
  # project behind and the next apply collides with its own leftovers.
  deletion_policy = "DELETE"

  labels = merge(var.labels, {
    lane = each.value.lane
    env  = each.value.env
    phi  = each.value.phi ? "true" : "false"
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
# One per regional project, used by that project's Cloud Run services. They are
# created here rather than in B4 so that IAM, secrets and CMEK grants all have a
# principal to reference before any workload exists.
#
# Note what is NOT here: no service account KEYS. The org policy forbids
# creating them, and Cloud Run obtains credentials from the metadata server
# instead. A downloaded key is a long-lived credential that cannot be rotated by
# revoking a session, which is exactly the thing a HIPAA posture should not own.
# ---------------------------------------------------------------------------
resource "google_service_account" "runtime" {
  for_each = local.regional_projects

  project      = google_project.this[each.key].project_id
  account_id   = "voice-${each.value.lane}-${each.value.env}"
  display_name = "${each.value.display} — Cloud Run runtime"
  description  = "Runtime identity for the ${each.value.lane} voice service. Keyless: credentials come from the metadata server."

  depends_on = [google_project_service.this]
}
