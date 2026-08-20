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
    An existing project used only as the quota/billing project for API calls
    Terraform makes before the six projects exist. This is the project the trial
    signup created. It holds no infrastructure and is deleted after the first
    successful apply — but not before the GCP BAA has been re-verified, since it
    is the project the BAA was accepted from.
  EOT
  type        = string
}

variable "project_prefix" {
  description = "Prefix for generated project IDs. Project IDs are globally unique and immutable."
  type        = string
  default     = "vetra"
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
