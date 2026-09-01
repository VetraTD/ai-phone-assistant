# ---------------------------------------------------------------------------
# Uptime and failure alerting. Added 2026-09-01, and until then there was NONE.
#
# Measured before writing this: zero uptime checks and zero notification
# channels in all three projects, and both live budgets carried an EMPTY
# `monitoringNotificationChannels` list. So the estate could stop answering the
# phone, or spend the month's budget in a day, and the first notification either
# way would have been a customer or a card statement.
#
# ---------------------------------------------------------------------------
# WHY THIS IS FOUR KINDS OF ALERT AND NOT ONE UPTIME CHECK
# ---------------------------------------------------------------------------
#
# `GET /` returns a static string and a build SHA. It opens no database
# connection and calls no vendor, so it answers 200 while every call on the
# service fails. It stayed green through a two-second-per-turn regression on
# 2026-09-01 that made the product materially worse.
#
# An uptime check therefore proves the process is listening and nothing more.
# The alerts that catch a service which is UP AND BROKEN are the log-based ones
# below, and they are the reason this file is not six lines long.
#
# ---------------------------------------------------------------------------
# WHAT IS DELIBERATELY NOT ALERTED ON
# ---------------------------------------------------------------------------
#
# `intent_marker_leaks`, `tts_fallback_turns`, `llm_stalls` and
# `internal_term_leaks` are the counters that would catch a DEGRADED call, and
# they are in-process only: `lib/voice/metrics.js` keeps them in a module-level
# object served at `/api/debug/latency`. They never reach the logs, so no
# log-based metric can see them. Alerting on them needs them emitted first —
# recorded here rather than quietly omitted, because a monitoring file that
# looks complete is worse than one that says what it misses.
# ---------------------------------------------------------------------------

variable "ops_alert_emails" {
  description = <<-EOT
    Addresses that receive OPERATIONAL alerts — the service being down, or up
    and failing. Separate from `budget_alert_emails` on purpose: a cost alert
    can wait for office hours and a dead phone line cannot.

    USE AN ADDRESS SOMEBODY DEMONSTRABLY READS. An email channel competes with
    inbox noise at 03:00 in a way SMS does not; when a real clinic depends on
    this, move the down-alert to a channel that interrupts.
  EOT
  type        = list(string)
  default     = []
}

variable "alert_on_call_silence_hours" {
  description = <<-EOT
    Raise an alert when NO call has started for this many hours. 0 disables it.

    Default 0, and that is a judgement rather than an oversight: on a demo
    estate taking a handful of calls a day, silence is the normal state and this
    alert would fire nightly until somebody muted it — which is how a whole
    alerting setup gets ignored. Turn it on when a tenant has predictable
    traffic, and set it above their longest normal quiet period, not below.
  EOT
  type        = number
  default     = 0
}

locals {
  # Channels are per-project because an alert policy can only notify channels
  # in its own project, and the policies below live beside the service they
  # watch rather than in a central one.
  ops_channel_targets = merge([
    for k, v in local.deployable_services : {
      for email in var.ops_alert_emails :
      "${v.project}|${email}" => { project = v.project, email = email }
    }
  ]...)

  # The events worth waking someone for. Each one means calls are failing while
  # the service still answers `GET /` — which is precisely the gap an uptime
  # check cannot cover.
  #
  # Chosen from the events the code ACTUALLY emits (verified against
  # `log.error(` call sites), not from a wish list: a metric filtering on an
  # event name nothing logs is a permanently green alert.
  voice_failure_events = {
    tts_el_breaker_open = {
      summary = "ElevenLabs breaker opened — every caller now hears the Google fallback voice"
      detail  = "The breaker stays open for 60s and applies to everyone, not just the call that tripped it."
    }
    stt_reconnect_exhausted = {
      summary = "Speech-to-text gave up reconnecting — the caller is talking to nothing"
      detail  = "Deepgram's stream died and could not be re-established. The call continues and transcribes nothing."
    }
    no_business_found = {
      summary = "A call arrived on a number that routes to no tenant"
      detail  = "Either a number was pointed here without a business_directory row, or a row was lost. The caller reaches a generic answer."
    }
    db_unscoped_query_refused = {
      summary = "A database write was refused for having no tenant scope"
      detail  = "Row-level security rejected it. Historically this class of failure was silent and lost transcripts and messages."
    }
  }
}

# ---------------------------------------------------------------------------
# Notification channels.
# ---------------------------------------------------------------------------
resource "google_monitoring_notification_channel" "ops" {
  for_each = local.ops_channel_targets

  project      = each.value.project
  display_name = "Ops alerts — ${each.value.email}"
  type         = "email"

  labels = {
    email_address = each.value.email
  }

  # Pinned on rather than left to a console toggle, for the same reason
  # budget.tf pins its own: a channel that exists and is disabled is
  # indistinguishable from no alarm, and looks configured.
  enabled = true
}

# ---------------------------------------------------------------------------
# Is it answering at all?
# ---------------------------------------------------------------------------
resource "google_monitoring_uptime_check_config" "voice" {
  for_each = length(var.ops_alert_emails) > 0 ? local.deployable_services : {}

  project      = each.value.project
  display_name = "${each.value.service} reachable"
  timeout      = "10s"

  # Five minutes, not one. The check runs from six locations, so a one-minute
  # period is 8,640 probes a day against a service billed for CPU while it
  # serves them — and nothing here is fixed inside five minutes anyway.
  period = "300s"

  http_check {
    path           = "/"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = each.value.project
      # The project-number form, matching BASE_URL and the Twilio webhook. The
      # opaque-hash form from `.uri` also serves, but pinning the check to the
      # hostname the product actually uses means a check that passes is evidence
      # about the URL Twilio calls.
      host = replace(local.service_base_url[each.key], "https://", "")
    }
  }

  # Asserting the BODY, not just the status code. A 200 from an infrastructure
  # error page is still a 200; this string comes from server.js's own handler,
  # so matching it proves the application answered.
  content_matchers {
    content = "AI phone assistant is running."
    matcher = "CONTAINS_STRING"
  }
}

resource "google_monitoring_alert_policy" "voice_unreachable" {
  for_each = google_monitoring_uptime_check_config.voice

  project      = each.value.project
  display_name = "${local.deployable_services[each.key].service} is not answering"
  combiner     = "OR"

  conditions {
    display_name = "Uptime check failing from more than one location"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\"",
        "resource.type=\"uptime_url\"",
        "metric.label.\"check_id\"=\"${each.value.uptime_check_id}\"",
      ])

      # Counting FAILURES across locations and requiring more than one. A single
      # probe location failing is usually that location, not the service, and an
      # alerting setup that cries wolf gets muted — after which it is worse than
      # nothing because it also looks configured.
      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }

      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "60s"

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [
    for c in google_monitoring_notification_channel.ops :
    c.id if c.project == each.value.project
  ]

  documentation {
    content   = <<-EOT
      The voice service stopped answering, or stopped returning its own body.

      This is the phone line. Twilio will play "an application error has
      occurred" to every caller until it recovers.

      First checks:
        gcloud run services describe ${local.deployable_services[each.key].service} \
          --project ${each.value.project} --region ${local.deployable_services[each.key].region}
        curl -s ${local.service_base_url[each.key]}/

      The fastest mitigation is repointing the Twilio number back at the
      previous deployment — under five minutes, and it does not need this
      service to be healthy first.
    EOT
    mime_type = "text/markdown"
  }
}

# ---------------------------------------------------------------------------
# Is it up and failing? — the alerts an uptime check cannot give you.
# ---------------------------------------------------------------------------
resource "google_logging_metric" "voice_failure" {
  for_each = length(var.ops_alert_emails) > 0 ? {
    for pair in setproduct(keys(local.deployable_services), keys(local.voice_failure_events)) :
    "${pair[0]}|${pair[1]}" => {
      svc_key = pair[0]
      event   = pair[1]
    }
  } : {}

  project = local.deployable_services[each.value.svc_key].project
  name    = "voice/${each.value.event}"

  filter = join(" AND ", [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"${local.deployable_services[each.value.svc_key].service}\"",
    "jsonPayload.event=\"${each.value.event}\"",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "voice_failure" {
  for_each = google_logging_metric.voice_failure

  project      = each.value.project
  display_name = local.voice_failure_events[split("|", each.key)[1]].summary
  combiner     = "OR"

  conditions {
    display_name = "${each.value.name} occurred"

    condition_threshold {
      filter = join(" AND ", [
        "metric.type=\"logging.googleapis.com/user/${each.value.name}\"",
        "resource.type=\"cloud_run_revision\"",
      ])

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }

      # Any occurrence at all. These are not rate-limited failures where a
      # trickle is normal — each one means a specific caller got a broken call,
      # so the honest threshold is one.
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      trigger {
        count = 1
      }
    }
  }

  notification_channels = [
    for c in google_monitoring_notification_channel.ops :
    c.id if c.project == each.value.project
  ]

  documentation {
    content   = local.voice_failure_events[split("|", each.key)[1]].detail
    mime_type = "text/markdown"
  }
}

# ---------------------------------------------------------------------------
# Silence. Off by default — see the variable for why.
# ---------------------------------------------------------------------------
resource "google_logging_metric" "call_started" {
  for_each = var.alert_on_call_silence_hours > 0 ? local.deployable_services : {}

  project = each.value.project
  name    = "voice/call_started"

  filter = join(" AND ", [
    "resource.type=\"cloud_run_revision\"",
    "resource.labels.service_name=\"${each.value.service}\"",
    "jsonPayload.event=\"call_started\"",
  ])

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "call_silence" {
  for_each = google_logging_metric.call_started

  project      = each.value.project
  display_name = "No calls have started in ${var.alert_on_call_silence_hours}h"
  combiner     = "OR"

  conditions {
    display_name = "call_started absent"

    # ABSENCE, not a threshold. "Zero calls" produces no data points rather than
    # a zero, so a threshold condition on this metric would never evaluate and
    # would sit green through exactly the outage it exists to catch.
    condition_absent {
      filter = join(" AND ", [
        "metric.type=\"logging.googleapis.com/user/${each.value.name}\"",
        "resource.type=\"cloud_run_revision\"",
      ])

      duration = "${var.alert_on_call_silence_hours * 3600}s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = [
    for c in google_monitoring_notification_channel.ops :
    c.id if c.project == each.value.project
  ]

  documentation {
    content   = "No call has started for ${var.alert_on_call_silence_hours} hours. Either nobody rang, or the number stopped reaching this service — the two are indistinguishable from inside, which is why this alert exists."
    mime_type = "text/markdown"
  }
}
