# ---------------------------------------------------------------------------
# Audit logging, split by origin continent.
#
# §164.312(b) asks for audit controls, and the answer to "who touched patient
# data" has to survive the project that produced it. A sink into a separate
# project means a compromised — or fat-fingered — prod project cannot delete its
# own audit trail.
#
# TWO buckets, not one. A single US bucket receiving UK logs would be a
# transfer, and logs from a UK call are UK personal data even after A1.7's
# scrubbing. The location constraint on vetra-logging permits both continents
# precisely so this split can exist inside one project.
# ---------------------------------------------------------------------------

variable "log_retention_days" {
  description = <<-EOT
    Retention for the audit log buckets.

    Note what HIPAA actually requires: §164.316(b)(2)(i)'s six years applies to
    Security Rule DOCUMENTATION — policies, risk analyses, training records —
    not to PHI or to logs. Do not read six years into this number. Retaining
    call-adjacent logs longer than they are useful enlarges the breach surface
    rather than the compliance posture.
  EOT
  type        = number
  default     = 400
}

locals {
  # Which log bucket each regional stack drains into. Keyed by STACK, because
  # residency follows the stack and not the project it happens to share.
  log_bucket_for = {
    us-prod    = "us"
    us-staging = "us"
    uk-prod    = "eu"
    uk-staging = "eu"
  }

  log_bucket_location = {
    us = "us-central1"
    eu = "europe-west2"
  }
}

resource "google_logging_project_bucket_config" "audit" {
  for_each = local.log_bucket_location

  project        = local.project_id_for_stack["logging"]
  location       = each.value
  bucket_id      = "vetra-audit-${each.key}"
  retention_days = var.log_retention_days
  description    = "Audit logs originating in the ${upper(each.key)} stacks. Kept in-region."

  depends_on = [google_project_service.this]
}

resource "google_logging_project_sink" "audit" {
  for_each = local.active_regional_stacks

  project = local.project_id_for_stack[each.key]

  # Named per STACK. Under the merge two stacks share a project, and two sinks
  # with one name in one project is a collision rather than a second sink.
  name        = "vetra-audit-${each.key}"
  description = "Routes ${each.value.lane} ${each.value.env} logs to the ${upper(local.log_bucket_for[each.key])} audit bucket."

  destination = "logging.googleapis.com/projects/${local.project_id_for_stack["logging"]}/locations/${local.log_bucket_location[local.log_bucket_for[each.key]]}/buckets/${google_logging_project_bucket_config.audit[local.log_bucket_for[each.key]].bucket_id}"

  # Data-access logs are the ones that answer "who read what". Admin activity is
  # always captured by Google and needs no filter.
  filter = "logName:\"cloudaudit.googleapis.com\" OR severity>=WARNING"

  # Logs continue to land in the origin project's _Default bucket as well. That
  # is intentional: the sink is a durable copy somewhere the origin cannot
  # reach, not a redirection that leaves operators blind in their own project.
  unique_writer_identity = true
}

# The sink writes across a project boundary, so its generated identity needs
# permission on the destination. Without this the sink exists, reports healthy,
# and silently drops every entry.
resource "google_project_iam_member" "sink_writer" {
  for_each = local.active_regional_stacks

  project = local.project_id_for_stack["logging"]
  role    = "roles/logging.bucketWriter"
  member  = google_logging_project_sink.audit[each.key].writer_identity
}
