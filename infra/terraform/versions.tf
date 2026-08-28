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

  # ---------------------------------------------------------------------------
  # STATE. The backend block is COMMENTED OUT, and that is the correct state for
  # a phase-4 first apply rather than an oversight.
  #
  # It cannot be otherwise: the state bucket is a resource THIS MODULE CREATES
  # (shared.tf), so the first apply necessarily runs on LOCAL state, creates the
  # bucket, and only then can `terraform init -migrate-state` move state into
  # it. An active backend block naming a bucket that does not exist fails at
  # `init`, before anything can create it.
  #
  # It named `vetra-tfstate-c3a3bd` until attempt 2. THAT BUCKET IS GONE with
  # the rest of the attempt-1 estate, and so is the state in it. Attempt 2
  # starts from a fresh bucket in `core`, with a fresh suffix.
  #
  # ⚠ DO THE MIGRATION. Do not leave it. B0a ran on local state, created six
  # projects and three org policies, and the state file is gone — not on the
  # workstation anywhere. The resources outlived Terraform's knowledge of them,
  # and recovering that cost an adoption apply (imports.tf). With two founders
  # it is doubly not optional: local state means only one machine can ever apply
  # without clobbering the other's view.
  #
  # PHASE 4, after the first apply:
  #   1. read `tfstate_bucket` from the outputs
  #   2. uncomment the block below and paste the name in
  #   3. terraform init -migrate-state
  #
  # backend "gcs" {
  #   bucket = "vetra-tfstate-<suffix>"
  #   prefix = "root"
  # }
  # ---------------------------------------------------------------------------
}

# `billing_project` is the project Terraform's own API calls are billed and
# quota'd against — it is NOT where resources land.
#
# ⚠ IT MUST HAVE EVERY API IN `local.terraform_quota_apis` ENABLED ON IT BEFORE
# THE FIRST APPLY, even though the resources land elsewhere entirely. Skipping
# that fails with a 403 SERVICE_DISABLED that NAMES THIS PROJECT and reads like
# a permissions problem:
#
#   Cloud Resource Manager API has not been used in project ... or it is
#   disabled
#
# Attempt 1 recorded this trap FIVE times, each as a separate failed apply on a
# different missing API, and it fired again on 2026-08-28. Enable the WHOLE
# list in one go — see the README's bootstrap section. Enabling an API is free.
#
# ATTEMPT 2 ORDERING: none of the three projects exist at the first apply, so
# this points at the scratch project, and moves to `core` afterwards. Repoint
# BEFORE deleting anything, never after: Terraform routes every call through
# this project, so deleting it first breaks every subsequent run.
provider "google" {
  billing_project       = var.bootstrap_project_id
  user_project_override = true
}

provider "google-beta" {
  billing_project       = var.bootstrap_project_id
  user_project_override = true
}
