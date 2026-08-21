# ---------------------------------------------------------------------------
# Who can reach what.
#
# There are two founders. One administers the infrastructure; the other works on
# the website and the build pipeline. A website role has no reason to reach
# vetra-us-prod, where patient data lives, and this file is where that stops
# being a policy and starts being an IAM binding.
#
# In a single project the audit question "who could access PHI?" answers "both
# of us, always". Here it answers "one of us, and here is the binding".
# ---------------------------------------------------------------------------

# Owners: full access to every project. Per PROJECT — a merged project is one
# grant, not two.
resource "google_project_iam_member" "owners" {
  for_each = {
    for pair in setproduct(keys(local.projects), var.owner_principals) :
    "${pair[0]}/${pair[1]}" => { project = pair[0], member = pair[1] }
  }

  project = google_project.this[each.value.project].project_id
  role    = "roles/owner"
  member  = each.value.member
}

# ---------------------------------------------------------------------------
# Shared-only principals: the shared project, and nothing else.
#
# Deliberately NOT roles/owner even there — the two roles below are what a
# build pipeline actually needs, which is to push images and run builds. There
# is no binding here for any PHI-bearing project, and that absence is the point
# of the file.
#
# Under the merge, the shared project also holds the log sinks' destination
# buckets. That is why these are two narrow roles rather than owner: a build
# principal that could reach the audit trail would defeat the reason the sink
# was moved to the org node in the first place. Neither role grants
# `storage.admin` or `logging.admin`.
# ---------------------------------------------------------------------------
resource "google_project_iam_member" "shared_only_artifacts" {
  for_each = toset(var.shared_only_principals)

  project = local.project_id_for_stack["shared"]
  role    = "roles/artifactregistry.writer"
  member  = each.value
}

resource "google_project_iam_member" "shared_only_builds" {
  for_each = toset(var.shared_only_principals)

  project = local.project_id_for_stack["shared"]
  role    = "roles/cloudbuild.builds.editor"
  member  = each.value
}

# ---------------------------------------------------------------------------
# Runtime service accounts.
#
# Each regional runtime gets exactly what a voice service needs in its OWN
# project, and nothing in any other. `voice-us` reaching into `vetra-uk-prod`
# is not prevented by configuration here — there simply is no binding for it.
#
# Secret Manager access is granted per-secret in B4, not project-wide. A runtime
# that can read every secret in its project is one env-var mistake away from the
# thing C6 exists to prove impossible — and in the merged staging project, where
# both credential sets live side by side, project-wide secret access would erase
# the boundary entirely.
#
# `roles/redis.editor` is NOT in this list. C-3 replaced Memorystore with a
# Postgres table, and a role granted for a service nobody provisions is how the
# service ends up provisioned.
# ---------------------------------------------------------------------------
locals {
  runtime_roles = [
    "roles/cloudsql.client",
    "roles/aiplatform.user",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/cloudtrace.agent",
  ]
}

resource "google_project_iam_member" "runtime" {
  for_each = {
    for pair in setproduct(keys(local.active_regional_stacks), local.runtime_roles) :
    "${pair[0]}/${pair[1]}" => { stack = pair[0], role = pair[1] }
  }

  project = local.project_id_for_stack[each.value.stack]
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.runtime[each.value.stack].email}"
}

# The runtimes pull their container image from the shared registry. Read-only,
# and it is the only binding any runtime holds outside its own project.
resource "google_project_iam_member" "runtime_pull_images" {
  for_each = local.active_regional_stacks

  project = local.project_id_for_stack["shared"]
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.runtime[each.key].email}"
}
