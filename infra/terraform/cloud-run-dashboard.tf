# ---------------------------------------------------------------------------
# The dashboard backend on Cloud Run.
#
# The API the clinic's browser talks to — calls, appointments, analytics,
# onboarding, settings, knowledge, capabilities. Until this exists every one of
# those lives only on Railway, so D7 cannot happen: you cannot cancel Railway
# while the only copy of the dashboard API is on it.
#
# ---------------------------------------------------------------------------
# Why a separate resource rather than another key in cloud-run.tf's for_each
# ---------------------------------------------------------------------------
#
# The two services share a scaling map and almost nothing else. Different port,
# different image, a completely different environment, no Twilio or speech
# secrets, no caller allowlist, and an ingress question with a different answer.
# Folding it in would mean a conditional on nearly every block, and the reader
# would have to hold both services in their head to understand either.
#
# ---------------------------------------------------------------------------
# ONE PER REGION, and that is forced rather than chosen
# ---------------------------------------------------------------------------
#
# It needs the database, and Cloud SQL here is private-IP only inside one VPC
# per project. A single shared instance in `vetra-shared` could not reach either
# regional database — and should not: `shared` deliberately holds no PHI, and a
# service that queries patient records is not a control-plane component.
# ---------------------------------------------------------------------------

variable "dashboard_image_tag" {
  description = <<-EOT
    Tag of the DASHBOARD image to run. Built by cloudbuild.dashboard.yaml, which
    submits AI-phone-dashboard/backend as its own source root.

    Separate from `image_tag`, which is the voice image, because the two have
    independent lifecycles — a dashboard change should not force a new voice
    revision, and vice versa.

    PIN A COMMIT SHA, never `latest`. A floating tag already cost three failed
    deploys where the container ran previous code and every failure looked like
    a real bug, because it was — in old code.
  EOT
  type        = string
  default     = "latest"

  validation {
    condition     = var.dashboard_image_tag != ""
    error_message = "dashboard_image_tag must be set; blank would resolve to no image at all."
  }
}

locals {
  dashboard_image = "${var.us_region}-docker.pkg.dev/${local.project_id_for_stack["shared"]}/${google_artifact_registry_repository.images.repository_id}/dashboard:${var.dashboard_image_tag}"

  # The same two filters cloud-run.tf applies to the voice service, and the
  # second is C-12 again: a service pointed at a database that does not exist is
  # a plan-time error, not a degraded service.
  #
  # NOT filtered on `wire_runtime_secrets`. The voice service genuinely cannot
  # boot without its secrets — server.js exits on a missing speech credential,
  # and a phone that answers and says nothing is worse than one that does not
  # answer. This one can: without SMTP the contact form and the digest return
  # 503 "not configured" and every other route works. A dashboard that can show
  # a clinic its calls but not email them a summary is degraded, not broken.
  deployable_dashboard_services = {
    for k, v in local.cloud_run_scaling : k => v
    if endswith(k, "/dashboard-api")
    && contains(keys(local.active_sql_instances), var.stack_projects[v.stack])
  }
}

resource "google_cloud_run_v2_service" "dashboard" {
  for_each = local.deployable_dashboard_services

  project  = each.value.project
  location = each.value.region
  name     = each.value.service

  deletion_protection = false

  # Called by a browser from the internet, so it has to accept external traffic.
  # Authentication is the Identity Platform bearer token checked in
  # src/middleware/authMiddleware.js, not a network ACL — the same shape as the
  # voice service, where the check is a Twilio signature.
  #
  # This becomes INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER once B5's load balancer
  # fronts it, which is the better posture and needs DNS first.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = each.value.service_account
    # 60s, not the voice service's 3600. That number exists because the voice
    # request IS the call — a held-open Media Streams WebSocket. A dashboard
    # request is a query; an hour-long one is a leak, not a long conversation.
    timeout = "60s"

    max_instance_request_concurrency = var.cloud_run_concurrency

    scaling {
      # Always 0/true here: C-11 gives a warm instance to exactly one service,
      # and it is not this one. Nobody is holding a phone waiting for a settings
      # page. The same benign `scaling` drift cloud-run.tf documents at length
      # applies — read the diff rather than trusting an empty one.
      min_instance_count = each.value.min_instances
      max_instance_count = each.value.max_instances
    }

    vpc_access {
      network_interfaces {
        network    = google_compute_network.this[var.stack_projects[each.value.stack]].id
        subnetwork = google_compute_subnetwork.this[each.value.stack].id
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.dashboard_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # CPU throttled between requests. The pairing rule in cost-controls.tf
        # runs the other way too: `cpu_idle = false` only buys something
        # alongside a warm instance, and this service has none.
        cpu_idle = true
      }

      ports {
        container_port = 3001
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      # P2, same reasoning as the voice service. Cloud Run injects no build
      # metadata, so without this the dashboard reports `Build: unknown` too —
      # and the dashboard image is the one that already cost three failed
      # deploys running previous code behind a floating tag. See the note above
      # `variable "git_commit_sha"` in migrate-job.tf.
      env {
        name  = "GIT_COMMIT_SHA"
        value = local.dashboard_build_sha
      }

      # -------------------------------------------------------------------
      # The database, through the Cloud SQL connector.
      #
      # No DATABASE_URL, and there could not be one: the instance is private-IP
      # only and has no password, because B2 created no `google_sql_user` on the
      # grounds that a password in a resource is a password in state. Until
      # 2026-08-22 this backend understood ONLY a connection string, which meant
      # it could not have reached a GCP database however it was deployed — see
      # AI-phone-dashboard/backend/src/db/cloudSqlPool.js.
      #
      # CLOUD_SQL_IAM_USER is the runtime service account with the
      # `.gserviceaccount.com` suffix removed, which is the form Cloud SQL wants
      # for an IAM principal. It holds `vetra_app` by role membership, so
      # migration 029's row-level security applies to it — it is NOT a
      # superuser, and the dashboard's 48 queries depend on `withTenant` for
      # exactly that reason.
      # -------------------------------------------------------------------
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

      # -------------------------------------------------------------------
      # Identity Platform (B3).
      #
      # THE PROJECT THAT ISSUES THE TOKENS, which is `vetra-shared` and not the
      # project this service runs in. Both halves of the verification come from
      # it — `aud` must equal it and `iss` must be
      # https://securetoken.google.com/<this> — and `securetoken` is ONE signer
      # shared by every Firebase project on earth, so this value is the only
      # thing between us and a token minted in a stranger's free project.
      #
      # Setting it to `each.value.project` would compare against the wrong
      # project and fail every login, after a deploy that changed nothing about
      # auth.
      # -------------------------------------------------------------------
      env {
        name  = "IDENTITY_PLATFORM_PROJECT_ID"
        value = local.project_id_for_stack["shared"]
      }

      # SESSION_MAX_AGE_MINUTES is deliberately NOT set here.
      #
      # §164.312(a)(2)(iii)'s server-side ceiling defaults to 30 minutes in both
      # servers, and the voice service does not set it either. Pinning it in
      # Terraform for one service and not the other would leave two deployments
      # enforcing the same control by different means, which is how they drift.
      #
      # Worth making explicit eventually — a compliance control that can only be
      # changed by an apply is better than one that lives in a default — but as
      # ONE change covering both services, not half of one here.

      # -------------------------------------------------------------------
      # CORS. A browser calls this from another origin, so the list matters.
      #
      # Built from `dashboard_domains`. The backend's own default is
      # vetratd.com and www — see src/server.js — so an empty list here leaves
      # that default in place rather than admitting everybody.
      #
      # AND THAT DEFAULT IS WHY THIS IS NOT OPTIONAL ANY MORE. The SPA is
      # served from Firebase Hosting at `<shared>.web.app` (2026-08-23), which
      # is not vetratd.com, so with `dashboard_domains` empty the deployed
      # dashboard loads, renders its sign-in form, and is refused on every
      # single API call. Measured in a real browser rather than reasoned about:
      #
      #   Access to fetch at '.../api/me' from origin
      #   'https://vetra-shared-c3a3bd.web.app' has been blocked by CORS policy
      #
      # It is invisible until somebody signs in — the login page makes no API
      # call — so the page looks completely healthy while nothing behind it
      # works. Note the failure shape at the server end too: `cors` passes an
      # Error to its callback for a rejected origin and Express turns that into
      # a **500**, not a 403, so the logs read as a server fault rather than a
      # policy decision. Same class as the twilio signature finding.
      # -------------------------------------------------------------------
      dynamic "env" {
        for_each = length(var.dashboard_domains) > 0 ? [1] : []
        content {
          name  = "CORS_ORIGINS"
          value = join(",", [for d in var.dashboard_domains : "https://${d}"])
        }
      }

      # The dashboard backend links to itself in the Art. 15 appointment export
      # mail (routes/appointments.js), which is the one dashboard route that
      # moves PHI out of the system — so the link matters more here than on the
      # voice side, not less.
      dynamic "env" {
        for_each = var.dashboard_url != "" ? [1] : []
        content {
          name  = "DASHBOARD_URL"
          value = var.dashboard_url
        }
      }

      # SMTP, for the contact form and the digest. Not credentials — a
      # hostname, a port and an address. SMTP_PASS is the only secret and comes
      # from Secret Manager below.
      dynamic "env" {
        for_each = var.smtp_config
        content {
          name  = env.key
          value = env.value
        }
      }

      # Only the secrets this service actually uses. Deliberately NOT the voice
      # service's list: a dashboard with a Twilio auth token or a speech
      # credential is a wider blast radius for no purpose, and in a covered
      # project a non-covered vendor credential is a boundary violation whatever
      # holds it.
      dynamic "env" {
        for_each = var.wire_runtime_secrets ? {
          for name, cfg in var.runtime_secrets : name => cfg
          if contains(cfg.lanes, local.stacks[each.value.stack].lane)
          && cfg.env_var == "SMTP_PASS"
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
        # src/server.js awaits the Cloud SQL pool BEFORE it listens, so this
        # window covers the connector's certificate fetch and first connection
        # rather than just node starting. A service that opens its port before
        # the database is reachable would be marked healthy and return 500s that
        # look like application bugs.
        initial_delay_seconds = 5
        timeout_seconds       = 5
        period_seconds        = 5
        failure_threshold     = 12
        tcp_socket {
          port = 3001
        }
      }
    }
  }

  depends_on = [google_project_service.this]
}

# Public, for the same reason the voice service is: a browser cannot present a
# Google IAM identity. The token check is in the application. Domain Restricted
# Sharing blocks `allUsers` by default and the per-project exception org-policies
# .tf applies is what permits it — one project at a time, never at the org node.
resource "google_cloud_run_v2_service_iam_member" "dashboard_public_invoker" {
  for_each = local.deployable_dashboard_services

  project  = google_cloud_run_v2_service.dashboard[each.key].project
  location = google_cloud_run_v2_service.dashboard[each.key].location
  name     = google_cloud_run_v2_service.dashboard[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "dashboard_services" {
  description = "Dashboard backend services and their URLs. VITE_API_URL points at one of these."
  value = {
    for k, v in google_cloud_run_v2_service.dashboard : k => {
      name = v.name
      uri  = v.uri
    }
  }
}
