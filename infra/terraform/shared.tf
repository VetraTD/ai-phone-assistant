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
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "images" {
  project       = google_project.this["shared"].project_id
  location      = var.us_region
  repository_id = "vetra"
  format        = "DOCKER"
  description   = "Container images for every voice stack. Pulled read-only by each regional runtime."

  # Keep the tagged releases, expire the noise. Without a policy, a registry
  # accumulates every build forever and the storage bill grows quietly.
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
# service accounts, and it cannot read a database or a secret.
# ---------------------------------------------------------------------------
resource "google_service_account" "deployer" {
  project      = google_project.this["shared"].project_id
  account_id   = "vetra-deployer"
  display_name = "Cloud Build deployer"
  description  = "Builds the image in shared and deploys revisions into the regional projects. Holds no data access."

  depends_on = [google_project_service.this]
}

resource "google_project_iam_member" "deployer_run_admin" {
  for_each = local.regional_projects

  project = google_project.this[each.key].project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# Deploying a Cloud Run service that runs AS a service account requires
# permission to impersonate it. Scoped to the one runtime account in that one
# project — not granted project-wide.
resource "google_service_account_iam_member" "deployer_actas_runtime" {
  for_each = local.regional_projects

  service_account_id = google_service_account.runtime[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_push_images" {
  project = google_project.this["shared"].project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer_logs" {
  project = google_project.this["shared"].project_id
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
# Doing it this way rather than with a separate bootstrap project keeps the
# count at the six projects the spec names. With two founders, remote state is
# not optional — local state would mean only one machine could ever apply
# without clobbering the other's view.
# ---------------------------------------------------------------------------
resource "google_storage_bucket" "tfstate" {
  project  = google_project.this["shared"].project_id
  name     = "${var.project_prefix}-tfstate-${random_id.project_suffix.hex}"
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
