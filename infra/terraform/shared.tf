# ---------------------------------------------------------------------------
# The control plane: one image, one pipeline, both stacks.
#
# This project holds no patient data, which is what makes sharing it safe. The
# spec's reasoning: staff credentials, the static bundle, the Terraform module,
# the pipeline and the test suite carry no PHI and gain nothing from being
# duplicated per region.
#
# One registry, one image, deployed to four Cloud Run services. Two registries
# would mean two images, which eventually means two slightly different images.
#
# UNDER THE 6 -> 4 MERGE this project also holds the log sinks' destination
# buckets. That is the one genuinely uncomfortable consequence of the collapse —
# Cloud Build's deploy credentials and the audit trail in the same blast radius
# — and it is why the sinks themselves are created at the ORG node (logging.tf)
# rather than in this project, and why the deployer's roles below stop well
# short of anything that could reach a log bucket.
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "images" {
  project       = local.project_id_for_stack["shared"]
  location      = var.us_region
  repository_id = "vetra"
  format        = "DOCKER"
  description   = "Container images for every voice stack. Pulled read-only by each regional runtime."

  # C-9. Keep the tagged releases, expire the noise. Without a policy, a
  # registry accumulates every build forever and the storage bill grows quietly.
  cleanup_policies {
    id     = "keep-tagged"
    action = "KEEP"
    condition {
      tag_state = "TAGGED"
    }
  }

  cleanup_policies {
    id     = "expire-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "2592000s" # 30 days
    }
  }

  depends_on = [google_project_service.this]
}

# ---------------------------------------------------------------------------
# Cloud Build's identity.
#
# Given permission to deploy into the regional projects, because the pipeline
# lives in shared and the services do not. This is a deliberate cross-project
# grant, and it is narrow: it can deploy revisions and act as the runtime
# service accounts, and it cannot read a database, a secret, or a log bucket.
#
# The compensating-control table for the merge names the last of those
# explicitly: Artifact Registry push + Cloud Run deploy, NOT storage.admin on
# the log bucket. Read the roles below as that list.
# ---------------------------------------------------------------------------
resource "google_service_account" "deployer" {
  project      = local.project_id_for_stack["shared"]
  account_id   = "vetra-deployer"
  display_name = "Cloud Build deployer"
  description  = "Builds the image in shared and deploys revisions into the regional projects. Holds no data access and no access to the audit trail."

  depends_on = [google_project_service.this]
}

# Per PROJECT, not per stack. A merged staging project would otherwise get the
# same (project, role, member) binding twice — two Terraform resources managing
# one IAM member, which flaps on every plan and where a `destroy` of one silently
# revokes the other.
resource "google_project_iam_member" "deployer_run_admin" {
  for_each = toset(local.active_regional_project_keys)

  project = google_project.this[each.value].project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# Deploying a Cloud Run service that runs AS a service account requires
# permission to impersonate it. Scoped to the one runtime account for that one
# stack — not granted project-wide, which in a merged project would hand the
# deployer both lanes' identities from a single binding.
resource "google_service_account_iam_member" "deployer_actas_runtime" {
  for_each = local.active_regional_stacks

  service_account_id = google_service_account.runtime[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_push_images" {
  project = local.project_id_for_stack["shared"]
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_logs" {
  project = local.project_id_for_stack["shared"]
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# ---------------------------------------------------------------------------
# Terraform state.
#
# This module manages the bucket its own state lives in, which sounds circular
# and is not: the first apply runs on LOCAL state, creates this bucket, and then
# `terraform init -migrate-state` moves state into it. After that the backend
# block in versions.tf takes over and the bucket is just another managed
# resource.
#
# THIS IS NOT OPTIONAL AND THE REASON IS NO LONGER HYPOTHETICAL. B0a ran on
# local state, created six projects and three org policies, and that state file
# is gone — searched for and not found anywhere on the workstation. The
# resources survived; Terraform's knowledge of them did not, and recovering it
# costs an adoption apply (imports.tf). Remote state is what stops that being a
# recurring tax, and with two founders it is also the only way both machines can
# apply without clobbering each other's view.
# ---------------------------------------------------------------------------
resource "google_storage_bucket" "tfstate" {
  project  = local.project_id_for_stack["shared"]
  name     = "${var.project_prefix}-tfstate-${local.project_suffix}"
  location = var.us_region

  # State contains resource metadata and occasionally secrets. Versioning is the
  # difference between a bad apply being an inconvenience and being an outage.
  versioning {
    enabled = true
  }

  uniform_bucket_level_access = true

  # A public state bucket is a full map of the infrastructure. This is belt and
  # braces on top of uniform access.
  public_access_prevention = "enforced"

  lifecycle_rule {
    condition {
      num_newer_versions = 20
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.this]
}
