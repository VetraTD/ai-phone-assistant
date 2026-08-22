# ---------------------------------------------------------------------------
# B4 — Cloud Run services.
#
# Built from `local.cloud_run_scaling` (cost-controls.tf), so C-2, C-6 and C-11
# arrive as values rather than as intentions somebody has to remember:
#
#   C-2   staging runs at min-instances 0.
#   C-11  of the production services, only VOICE runs warm. A cold start is
#         about a second of silence, and the only place that is unacceptable is
#         a human holding a phone.
#   C-6   Direct VPC egress. No Serverless VPC Access connector, ever.
#
# ---------------------------------------------------------------------------
# Secrets are wired by a FLAG, and it starts off
# ---------------------------------------------------------------------------
#
# Cloud Run refuses to start a revision whose secret cannot be resolved, and the
# secrets in secrets.tf are deliberately created with no versions — the values
# are third-party credentials that arrive by hand.
#
# So a service that referenced them today would simply fail to deploy, and the
# deployment path would stay unproven until the last credential was pasted.
# `var.wire_runtime_secrets` inverts that: deploy now, prove the image boots,
# reaches its database and serves a health check, then flip one flag once the
# values exist.
#
# The application is built for this. lib/bootChecks.js announces missing
# configuration loudly and refuses only on combinations that cannot be what
# anyone intended, so a service with no Twilio credential boots, says so, and
# answers nothing — which is the correct behaviour for a staging service nobody
# has dialled yet.
# ---------------------------------------------------------------------------

variable "wire_runtime_secrets" {
  description = <<-EOT
    Whether Cloud Run services reference the Secret Manager secrets.

    FALSE until the secrets have versions. A revision referencing an empty
    secret does not deploy at all, which would block proving the deployment path
    on a credential nobody has pasted yet.

    Flip to true after adding values (see the `secrets_awaiting_values` output)
    and apply. That is a new revision, not a rebuild.
  EOT
  type        = bool
  default     = false
}

variable "cloud_run_concurrency" {
  description = <<-EOT
    Requests per instance. Low, because a voice request is not a request: the
    Twilio Media Streams WebSocket is held open for the whole call, and each one
    carries an audio pump and a Deepgram connection. Packing many onto one
    instance is what C3's concurrency gate exists to catch.
  EOT
  type        = number
  default     = 10
}

locals {
  # Two filters, and the second one is C-12 showing up where it was always
  # going to.
  #
  #   /voice     the dashboard backend has its own Dockerfile and cloudbuild.yaml
  #              does not build it yet, so a service for it would fail on an
  #              image that was never pushed.
  #
  #   has a DB   C-12 deliberately does not create the production database until
  #              D3, and a voice service pointed at an instance that does not
  #              exist is not a degraded service — it is a plan-time error, which
  #              is how this was found. The production service arrives with its
  #              database, together, rather than one waiting on the other.
  #   secrets    the voice service CANNOT boot without them, and that is
  #              correct rather than an obstacle. server.js exits on a missing
  #              DEEPGRAM_API_KEY with "there is no fallback mode", which is
  #              true — a voice service that cannot hear is not degraded, it is
  #              a phone that answers and says nothing. So no service is created
  #              until the secrets are wired, instead of creating one that
  #              crash-loops and calling it progress.
  deployable_services = {
    for k, v in local.cloud_run_scaling : k => v
    if endswith(k, "/voice")
    && contains(keys(local.active_sql_instances), var.stack_projects[v.stack])
    && var.wire_runtime_secrets
  }

  # Cloud Run's URL is deterministic in the current format —
  # https://SERVICE-PROJECTNUMBER.REGION.run.app — which resolves what would
  # otherwise be circular: server.js needs BASE_URL to build the Twilio webhook
  # URLs it prints and serves, and BASE_URL is the service's own address.
  #
  # Composing it beats a two-phase apply (deploy, read the URI, apply again),
  # which leaves a window where the service is running with a placeholder.
  service_base_url = {
    for k, v in local.cloud_run_scaling : k =>
    "https://${v.service}-${google_project.this[var.stack_projects[v.stack]].number}.${v.region}.run.app"
  }
}

resource "google_cloud_run_v2_service" "this" {
  for_each = local.deployable_services

  project  = each.value.project
  location = each.value.region
  name     = each.value.service

  deletion_protection = false

  # Cloud Run's own ingress control. The voice service is called by Twilio from
  # the internet, so it has to accept external traffic — authentication is
  # Twilio's request signature, checked in the application, not a network ACL.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = each.value.service_account
    timeout         = "${each.value.timeout_seconds}s"

    max_instance_request_concurrency = var.cloud_run_concurrency

    scaling {
      # C-2 and C-11 together. Staging is 0; production voice is 1.
      min_instance_count = each.value.min_instances
      max_instance_count = each.value.max_instances
    }

    # C-6. Direct VPC egress — the job in migrate-job.tf proved this path
    # reaches the private-IP database.
    vpc_access {
      network_interfaces {
        network    = google_compute_network.this[var.stack_projects[each.value.stack]].id
        subnetwork = google_compute_subnetwork.this[each.value.stack].id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.voice_image

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        # `cpu_idle = false` is CPU always allocated, and it is paired with
        # min_instances = 1 deliberately: a warm instance with throttled CPU is
        # not warm, because the first request still waits for the CPU to be
        # un-throttled. Buying one without the other buys nothing.
        cpu_idle = each.value.cpu_idle
      }

      ports {
        container_port = 3000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      # Its own address. server.js exits without this, because every Twilio
      # webhook URL it hands out is built from it and a wrong one is a call that
      # rings and goes nowhere.
      env {
        name  = "BASE_URL"
        value = local.service_base_url[each.key]
      }

      # No DATABASE_URL. The runtime connects through the Cloud SQL connector
      # with IAM authentication — no password exists — and bootChecks refuses
      # outright if both are set, because two databases named is ambiguity
      # rather than redundancy.
      env {
        name  = "CLOUD_SQL_INSTANCE"
        value = google_sql_database_instance.this[var.stack_projects[each.value.stack]].connection_name
      }

      env {
        name  = "CLOUD_SQL_DATABASE"
        value = "vetra_${replace(each.value.stack, "-", "_")}"
      }

      env {
        name  = "CLOUD_SQL_IAM_USER"
        value = trimsuffix(google_service_account.runtime[each.value.stack].email, ".gserviceaccount.com")
      }

      # The compliance tier. `hipaa` makes lib/compliance.js refuse a
      # non-covered vendor at client construction, and bootChecks refuse to
      # start at all if such a credential is present — the second line of
      # defence behind the secret simply not existing in this project.
      env {
        name  = "DEPLOYMENT_MODE"
        value = local.stacks[each.value.stack].lane == "us" ? "hipaa" : "standard"
      }

      # Vertex, not the Gemini Developer API. The API-key path is AI Studio,
      # which the Google Cloud BAA does not cover, and an uncovered LLM call
      # carries the caller's entire utterance.
      env {
        name  = "VERTEX_ENABLED"
        value = "true"
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = each.value.project
      }

      # `us`/`eu`, never a single region and never `global`. Probed 2026-08-21:
      # no single Vertex region serves gemini-3.6-flash, and `global` routes
      # anywhere on earth, which voids the residency claim.
      env {
        name  = "VERTEX_LOCATION"
        value = local.stacks[each.value.stack].lane == "uk" ? "eu" : "us"
      }

      dynamic "env" {
        for_each = var.wire_runtime_secrets ? {
          for name, cfg in var.runtime_secrets : name => cfg
          if contains(cfg.lanes, local.stacks[each.value.stack].lane)
        } : {}

        content {
          name = env.value.env_var
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.runtime["${each.value.project}/${env.key}"].secret_id
              version = "latest"
            }
          }
        }
      }

      startup_probe {
        # The container has to open a port before Cloud Run will route to it,
        # and server.js now awaits the Cloud SQL pool before listening — so this
        # timeout covers certificate fetch and first connection, not just node
        # starting.
        initial_delay_seconds = 5
        timeout_seconds       = 5
        period_seconds        = 5
        failure_threshold     = 12
        tcp_socket {
          port = 3000
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.runtime,
    google_project_iam_member.run_agent_pull_images,
    google_sql_user.runtime_iam,
  ]
}

output "cloud_run_services" {
  description = "Deployed services and their URLs."
  value = {
    for k, v in google_cloud_run_v2_service.this : k => {
      name          = v.name
      uri           = v.uri
      min_instances = v.template[0].scaling[0].min_instance_count
      secrets_wired = var.wire_runtime_secrets
    }
  }
}
