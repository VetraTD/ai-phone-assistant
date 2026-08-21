terraform {
  # 1.7 for `for_each` on import blocks (imports.tf). 1.9 for the multiple
  # `validation` blocks on var.stack_projects.
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
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State lives in the bucket this module creates (shared.tf). That sounds
  # circular and is not: the FIRST apply runs on local state, creates the
  # bucket, and then `terraform init -migrate-state` moves state into it.
  #
  # DO THIS. B0a ran on local state, created six projects and three org
  # policies, and the state file is gone — not on the workstation anywhere. The
  # resources outlived Terraform's knowledge of them, and recovering that costs
  # an adoption apply (imports.tf). With two founders it is doubly not optional:
  # local state means only one machine can ever apply without clobbering the
  # other's view.
  #
  # LIVE since 2026-08-21, immediately after the adoption apply created the
  # bucket. The local state file it was migrated from is now dead weight; do not
  # resurrect it.
  backend "gcs" {
    bucket = "vetra-tfstate-c3a3bd"
    prefix = "root"
  }
}

# `billing_project` is the project Terraform's own API calls are billed and
# quota'd against — it is NOT where resources land.
#
# This now points at `vetra-shared`, not at the trial-signup project. The
# bootstrap project was only ever a stand-in for the window before the six
# projects existed, and that window closed when they were created. Repointing
# early also defuses O3c's ordering trap, where deleting the bootstrap project
# breaks every subsequent Terraform run — the README used to say "repoint before
# deleting, not after", which is a rule someone has to remember at the exact
# moment they are busy deleting something.
#
# THE QUOTA PROJECT MUST HAVE EACH API ENABLED that Terraform calls through it,
# even though the resources land elsewhere. `vetra-shared` had NOTHING enabled
# and had to be bootstrapped by hand — see the README. Skipping that fails with
# a 403 SERVICE_DISABLED naming this project, which reads like a permissions
# problem and is not.
provider "google" {
  billing_project       = var.bootstrap_project_id
  user_project_override = true
}

provider "google-beta" {
  billing_project       = var.bootstrap_project_id
  user_project_override = true
}
