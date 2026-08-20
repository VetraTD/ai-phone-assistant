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

  # State lives in the bucket created by ./bootstrap, which is the one resource
  # in this repository made outside this module. Terraform cannot store state in
  # a bucket it has not created yet, and with two founders local state is not an
  # option — it would mean only one machine could ever run an apply without
  # corrupting the other's view.
  #
  # Commented until ./bootstrap has run once. Then uncomment, `terraform init
  # -migrate-state`, and never think about it again.
  #
  # backend "gcs" {
  #   bucket = "vetra-tfstate-<suffix>"   # from bootstrap output
  #   prefix = "root"
  # }
}

provider "google" {
  billing_project       = var.bootstrap_project_id
  user_project_override = true
}

provider "google-beta" {
  billing_project       = var.bootstrap_project_id
  user_project_override = true
}
