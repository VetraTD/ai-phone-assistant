terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }

  # State lives in the bucket this module creates (shared.tf). That sounds
  # circular and is not: the FIRST apply runs on local state, creates the
  # bucket, and then `terraform init -migrate-state` moves state into it. With
  # two founders local state is not an option long-term — it would mean only one
  # machine could ever run an apply without corrupting the other's view.
  #
  # Commented until the first apply has succeeded. Then paste in the
  # `tfstate_bucket` output, `terraform init -migrate-state`, and never think
  # about it again.
  #
  # backend "gcs" {
  #   bucket = "vetra-tfstate-<suffix>"   # from bootstrap output
  #   prefix = "root"
  # }
}

# `billing_project` is the project Terraform's own API calls are billed and
# quota'd against — it is NOT where resources land. Before the six projects
# exist there is only the bootstrap project to point at, which is why
# `bootstrap_project_id` is a variable rather than a hard-coded value.
#
# TRAP, and the reason this comment exists: O3c deletes the bootstrap project
# once the GCP BAA has been re-verified. The moment it goes, EVERY Terraform run
# fails on a quota project that no longer exists. Repoint this variable at the
# `shared` project ID from the outputs BEFORE deleting it, not after.
#
# The quota project must also have each API enabled that Terraform calls through
# it — see the bootstrap section of the README. That is not obvious and it fails
# with a 403 SERVICE_DISABLED naming the bootstrap project, which reads like a
# permissions problem and is not.
provider "google" {
  billing_project       = var.bootstrap_project_id
  user_project_override = true
}

provider "google-beta" {
  billing_project       = var.bootstrap_project_id
  user_project_override = true
}
