# ---------------------------------------------------------------------------
# Logging: aggregated at the ORG node, split into two streams.
#
# ---------------------------------------------------------------------------
# 1. Why the sinks moved to the organization
# ---------------------------------------------------------------------------
#
# §164.312(b) asks for audit controls, and the answer to "who touched patient
# data" has to survive the project that produced it. A project-level sink does
# not: whoever holds admin on the project holds admin on the sink, so a
# compromised — or fat-fingered — prod project can stop shipping its own audit
# trail, and nothing downstream can tell the difference between "no events" and
# "no longer sending".
#
# That was already a weak point. The 6 -> 4 merge makes it a real one, because
# the destination now lives in `vetra-shared`, alongside Cloud Build's deploy
# credentials. Anything that compromises the build pipeline is one project-admin
# step away from the trail that would record it.
#
# `google_logging_organization_sink` is created at the org node with
# `include_children = true`. A project admin cannot delete it, cannot edit its
# filter, and cannot exclude their own project from it. Only an Organization
# Admin can, and that is one identity, audited separately.
#
# ---------------------------------------------------------------------------
# 2. Why two streams and not one — and why NOTHING here is Bucket-Locked
# ---------------------------------------------------------------------------
#
# The compensating-control table calls for Bucket Lock on the audit
# destination, retention 400 days. Bucket Lock makes deletion impossible for the
# retention period — that is the whole feature, and it is IRREVERSIBLE. Applied
# to a bucket receiving application logs, a single regression in the PHI
# scrubber would create UNDELETABLE PHI: unerasable under GDPR Art. 17, and a
# permanent, unfixable disclosure under HIPAA.
#
# So the streams are severed BEFORE the lock ever gets applied:
#
#   AUDIT — `cloudaudit.googleapis.com` only. Google-generated, structurally
#   free of application field names. Long retention. This is the stream that is
#   eventually Bucket-Locked, and it is safe to lock precisely because the
#   application never writes into it.
#
#   APPLICATION — everything the services emit. Short retention, exclusion
#   filters, and NEVER LOCKED. If the scrubber regresses, this bucket can be
#   purged.
#
# **THIS FILE DELIBERATELY DOES NOT SET BUCKET LOCK.** The `locked` argument is
# absent from both bucket configs below and that absence is the decision, not an
# omission. Locking is a later, separate, owner-present step, done once the
# scrubber has run against real traffic — see the ledger. Terraform will happily
# apply an irreversible retention policy from an unattended session, which is
# exactly the kind of thing that should never be one `apply` away.
#
# ---------------------------------------------------------------------------
# 3. Why the destinations are still split by continent
# ---------------------------------------------------------------------------
#
# Logs from a UK call are UK personal data even after scrubbing, so a single US
# bucket receiving them would be a transfer. Four sinks, not two: {EU, US} x
# {audit, application}. The EU filter names the EU projects exactly; the US
# filter is its NEGATION, so a project nobody remembered to list is captured
# rather than silently dropped.
#
# KNOWN CONSEQUENCE OF THE MERGE, recorded rather than hidden: `uk-staging`
# shares a project with `us-staging`, and log routing can only see the project.
# UK staging logs therefore land in the US bucket. That is acceptable only
# because staging is barred from receiving production Twilio credentials and
# real caller data at all — the same rule the residency story already rests on —
# and it reverts the moment `uk-staging` gets its project back.
# ---------------------------------------------------------------------------

variable "audit_log_retention_days" {
  description = <<-EOT
    Retention for the Cloud Audit Log buckets.

    400 days, matched to the retention schedule. Note what HIPAA actually
    requires: §164.316(b)(2)(i)'s six years applies to Security Rule
    DOCUMENTATION — policies, risk analyses, training records — not to PHI and
    not to logs. Do not read six years into this number. Retaining
    call-adjacent logs longer than they are useful enlarges the breach surface
    rather than the compliance posture.

    Cloud Audit Logs are also free to store for up to 400 days, which is why
    this number and that one are the same number.
  EOT
  type        = number
  default     = 400
}

variable "application_log_retention_days" {
  description = <<-EOT
    Retention for the application log buckets. C-8.

    30 days. These are for debugging a call that went wrong this week, and the
    honest retention for that is weeks. They are the stream most likely to
    contain something the scrubber missed, so short retention here is a privacy
    control as much as a cost one — the rare axis where cheaper IS more
    compliant, since HIPAA minimum-necessary and GDPR storage-limitation both
    push the same way.
  EOT
  type        = number
  default     = 30
}

variable "log_exclusions" {
  description = <<-EOT
    C-8. Noise dropped at INGESTION rather than stored and then ignored.

    The first 50 GB/month of ingestion is free and $0.50/GB after that, and a
    voice app that logs per turn can pass 50 GB without anyone deciding to. Each
    entry is applied twice: to the application sink, and to each project's
    _Default sink, which is where the volume actually is.

    `filter` is Logging query syntax. Keep these NARROW — an exclusion is a log
    line that no longer exists anywhere, and the failure mode is discovering
    during an incident that the thing you need was excluded as noise.
  EOT
  type = map(object({
    filter      = string
    description = string
  }))

  default = {
    debug-severity = {
      # `severity = "DEBUG"`, NOT `severity < INFO`, and the difference cost a
      # debugging session.
      #
      # Cloud Logging severities: DEFAULT(0) DEBUG(100) INFO(200). Unstructured
      # container stdout — every `console.log`, every plain `print` — arrives as
      # DEFAULT, which is BELOW DEBUG. So `severity < INFO` silently swallowed
      # all of it, and the first migration job failure showed up as a single
      # line reading "Container called exit(1)" with the actual error nowhere.
      #
      # This is precisely the failure this variable's own comment warns about:
      # discovering during an incident that the thing you needed was excluded as
      # noise. Structured logs via lib/logger.js set an explicit severity and
      # were never affected, which is what made it look like a logging outage
      # rather than a filter.
      filter      = "severity = \"DEBUG\""
      description = "DEBUG only. Useful attached to a debugger, not worth storing for a month."
    }
    health-checks = {
      filter      = "resource.type=\"cloud_run_revision\" AND httpRequest.requestUrl:\"/health\""
      description = "Load-balancer and uptime probes. One line per check per service, forever, saying nothing changed."
    }
    load-balancer-success = {
      filter      = "resource.type=\"http_load_balancer\" AND httpRequest.status<400"
      description = "Successful static-asset fetches from the dashboard SPA's CDN. Errors are kept; 200s on a JS bundle are not diagnostic."
    }
  }
}

locals {
  # The two destinations, by continent.
  log_regions = {
    us = var.us_region
    eu = var.uk_region
  }

  # Projects whose logs must stay in the EU. Derived from the stacks, so a
  # stack moving between projects moves its routing with it — and a project
  # hosting BOTH lanes is deliberately NOT here, because it cannot honour the
  # constraint (see the header).
  eu_only_project_ids = sort([
    for pk, pv in local.projects :
    google_project.this[pk].project_id
    if alltrue([for sk in pv.stacks : local.stacks[sk].lane == "uk"])
  ])

  # `resource.labels.project_id = ("a" OR "b")`, or a filter that matches
  # nothing when the list is empty. An empty `= ()` is a syntax error, and the
  # UK toggle being off is not a reason for the EU sink to start swallowing
  # everything.
  eu_project_predicate = length(local.eu_only_project_ids) > 0 ? format(
    "resource.labels.project_id = (%s)",
    join(" OR ", [for p in local.eu_only_project_ids : "\"${p}\""])
  ) : "resource.labels.project_id = \"\""

  audit_filter = "logName:\"cloudaudit.googleapis.com\""

  # Everything that is NOT an audit log. Written as the negation of the audit
  # filter so the two streams partition the logs rather than overlapping — an
  # entry copied into both buckets is billed twice and, worse, would put
  # application output into the bucket that eventually gets Bucket-Locked.
  application_filter = "NOT ${local.audit_filter}"

  sink_streams = {
    audit = {
      filter         = local.audit_filter
      retention_days = var.audit_log_retention_days
      description    = "Cloud Audit Logs. Google-generated. The stream that is eventually Bucket-Locked."
      exclusions     = {}
    }
    app = {
      filter         = local.application_filter
      retention_days = var.application_log_retention_days
      description    = "Application output. NEVER Bucket-Locked — a scrubber regression must remain deletable."
      exclusions     = var.log_exclusions
    }
  }

  # {us,eu} x {audit,app} — four buckets, four org sinks.
  sink_matrix = merge([
    for region_key, region in local.log_regions : {
      for stream_key, stream in local.sink_streams : "${region_key}-${stream_key}" => {
        region_key = region_key
        region     = region
        stream_key = stream_key
        stream     = stream
      }
    }
  ]...)
}

# ---------------------------------------------------------------------------
# Destinations. Log buckets in the logging project — which, under the merge, is
# the shared project.
#
# Note again: no `locked` argument. See the header.
# ---------------------------------------------------------------------------
resource "google_logging_project_bucket_config" "sink_target" {
  for_each = local.sink_matrix

  project        = local.project_id_for_stack["logging"]
  location       = each.value.region
  bucket_id      = "vetra-${each.value.stream_key}-${each.value.region_key}"
  retention_days = each.value.stream.retention_days
  description    = "${each.value.stream.description} Origin: ${upper(each.value.region_key)} projects. Kept in-region."

  depends_on = [google_project_service.this]
}

# ---------------------------------------------------------------------------
# The sinks themselves, at the ORG node.
#
# `include_children = true` makes one sink cover every project under the org,
# including projects created after it. That is the property a per-project sink
# cannot have: a seventh project added next month is captured without anyone
# remembering to wire it up.
# ---------------------------------------------------------------------------
resource "google_logging_organization_sink" "aggregated" {
  for_each = local.sink_matrix

  name        = "vetra-${each.value.stream_key}-${each.value.region_key}"
  org_id      = var.org_id
  description = "Aggregated at the org node so no project admin can remove their own trail. ${each.value.stream.description}"

  include_children = true

  destination = "logging.googleapis.com/projects/${local.project_id_for_stack["logging"]}/locations/${each.value.region}/buckets/${google_logging_project_bucket_config.sink_target[each.key].bucket_id}"

  # EU sinks take the named EU projects; US sinks take everything else. The
  # negation is deliberate — a new project defaults to being captured, which is
  # the safe direction to be wrong in.
  filter = join(" AND ", concat(
    [each.value.stream.filter],
    [each.value.region_key == "eu" ? "(${local.eu_project_predicate})" : "NOT (${local.eu_project_predicate})"],
  ))

  # Creating a sink at the org node needs `logging.sinks.create` ON the org, and
  # no role this principal holds by default carries it — see
  # google_organization_iam_member.logging_config_writer in iam.tf. Without this
  # dependency the first apply fails on all four sinks with a 403 that reads as
  # a broken configuration.
  depends_on = [google_organization_iam_member.logging_config_writer]

  # C-8. Exclusions on the application stream only; nothing is ever excluded
  # from the audit trail.
  dynamic "exclusions" {
    for_each = each.value.stream.exclusions

    content {
      name        = exclusions.key
      description = exclusions.value.description
      filter      = exclusions.value.filter
    }
  }
}

# The sink writes across a project boundary, so its generated identity needs
# permission on the destination. Without this the sink exists, reports healthy,
# and silently drops every entry.
resource "google_project_iam_member" "sink_writer" {
  for_each = local.sink_matrix

  project = local.project_id_for_stack["logging"]
  role    = "roles/logging.bucketWriter"
  member  = google_logging_organization_sink.aggregated[each.key].writer_identity
}

# ---------------------------------------------------------------------------
# C-8, the half that actually saves money.
#
# The aggregated sinks above are a COPY. Every entry still lands in its origin
# project's `_Default` bucket, and that is intentional — an operator debugging
# their own project should not have to go to another project to read a log. But
# it means the noise is stored twice, and _Default is where the volume is.
#
# A project-level exclusion drops the entry from `_Default` before it is stored.
# It does NOT affect the aggregated sinks, which have their own copy of the same
# filters — so excluding here cannot blind the audit trail.
# ---------------------------------------------------------------------------
resource "google_logging_project_exclusion" "default_sink_noise" {
  for_each = merge([
    for pk in keys(local.projects) : {
      for ek, ev in var.log_exclusions : "${pk}/${ek}" => {
        project = pk
        name    = ek
        filter  = ev.filter
        desc    = ev.description
      }
    }
  ]...)

  project     = google_project.this[each.value.project].project_id
  name        = each.value.name
  description = "C-8: ${each.value.desc}"
  filter      = each.value.filter

  depends_on = [google_project_service.this]
}
