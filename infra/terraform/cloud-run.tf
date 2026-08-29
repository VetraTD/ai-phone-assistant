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

variable "smtp_config" {
  description = <<-EOT
    Non-secret SMTP settings, as plain environment variables.

    A hostname, a port and a from-address are not credentials, and putting them
    in Secret Manager would dilute a list whose value is that everything on it
    is genuinely sensitive. SMTP_PASS is the only secret here.

    SMTP_USER is not optional: lib/bootChecks.js treats a half-configured
    credential pair as FATAL, on the grounds that nobody sets half of one on
    purpose and the result is email that is silently dropped. A deploy with
    SMTP_PASS and no SMTP_USER does not start.
  EOT
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# `staging_caller_allowlist` LIVED HERE AND IS GONE, along with the staging
# stacks it gated. Recorded rather than silently deleted, because the control it
# implemented is still the right one if a shared-account environment ever comes
# back: a non-production voice service on the SAME Twilio account as the
# production number must refuse every caller but a named test list, or a patient
# misdialling by one digit reaches a build with no residency guarantee and no
# production retention story. Attempt 2 has no such environment — staging is
# local Docker Postgres, which no phone number points at — so the variable had
# exactly one reader (`env == "staging"`) that can no longer be true.
# ---------------------------------------------------------------------------

variable "twilio_sms_from" {
  description = <<-EOT
    The number caller-facing SMS is SENT FROM, per stack. E.164.

    Per stack rather than global because each stack authenticates as a different
    Twilio account, and OUTBOUND SMS REQUIRES THE `From` NUMBER TO BELONG TO THE
    AUTHENTICATING ACCOUNT. Staging holds a SUBACCOUNT's credentials, so a
    production number here fails with Twilio 21606 — "not a valid, SMS-capable
    inbound phone number ... for your account" — which reads as a bad number and
    is a wrong account.

    Unset means the channel is OFF, and that is a supported state rather than a
    misconfiguration: services/notifications.js `sendSms` returns early with
    `twilio_sms_from_missing`, and lib/bootChecks announces `sms_channel_off` at
    boot so it is visible instead of silent.

    ---------------------------------------------------------------------------
    SETTING THIS DOES NOT MEAN A TEXT ARRIVES
    ---------------------------------------------------------------------------
    A US long code needs A2P 10DLC registration, and a toll-free number needs
    toll-free verification, before carriers accept traffic at all. Twilio shows
    this per number as Traffic Status: `Messaging disabled`, INDEPENDENTLY of
    `Voice enabled` — the same number can answer calls and refuse to text.
    Unregistered sends fail with 30034.

    So this variable makes the send ATTEMPT possible and observable. Whether the
    message is delivered is O23a's question, not this one, and conflating the two
    is how a working consent gate gets debugged for an afternoon.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for n in values(var.twilio_sms_from) : can(regex("^\\+[1-9][0-9]{1,14}$", n))])
    error_message = "Every value must be E.164 (+ then 1-15 digits). Twilio rejects anything else as a `From`."
  }
}

variable "vertex_location" {
  description = <<-EOT
    `VERTEX_LOCATION` for the voice service.

    "us", "eu" and "global" ALL resolve to the same global Vertex host
    (services/gemini.js:191), so they differ in label only -- they do not differ
    in where inference happens. "global" is the honest one, and the inference
    leg is a DISCLOSED international transfer in the privacy notice and Art. 30
    record.

    A REAL region (e.g. "europe-west2") is different in kind: it pins the host
    and therefore genuinely pins processing. It is not usable today because the
    regional host serves only gemini-2.5-flash and 404s gemini-3.6-flash.
    Re-probe monthly; the day a 3.x model lands there, this variable is the
    whole change.

    Everything else -- Cloud SQL, Deepgram EU, KMS, secrets, compute -- stays in
    europe-west2 regardless of this value.
  EOT
  type        = string
  default     = "global"

  validation {
    condition     = var.vertex_location != ""
    error_message = "vertex_location must be set; empty disables Vertex and the service will not boot."
  }
}

variable "db_pool_max" {
  description = <<-EOT
    Postgres pool size PER VOICE INSTANCE (`DB_POOL_MAX`).

    The ceiling this has to respect is the instance's `max_connections`, which
    is a property of the TIER and must be read off the instance -- `db-g1-small`
    measured 50 on 2026-08-28. The arithmetic that matters is

      voice_instances x db_pool_max
        + dashboard_instances x dashboard_db_pool_max
        + the migrate job
        + superuser_reserved_connections
        + whatever cloudsqladmin is holding
      <= max_connections

    Raise the TIER before raising this. Lowering it below 10 is the wrong lever:
    Phase 3b measured one instance reaching 10 at 10 concurrent calls, so a
    smaller pool queues callers on connection acquisition.
  EOT
  type        = number
  default     = 10

  validation {
    condition     = var.db_pool_max >= 1 && var.db_pool_max <= 100
    error_message = "db_pool_max must be between 1 and 100."
  }
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

  # Cloud Run's URL in the format https://SERVICE-PROJECTNUMBER.REGION.run.app,
  # which resolves what would otherwise be circular: server.js needs BASE_URL to
  # build the Twilio webhook URLs it prints and serves, and BASE_URL is the
  # service's own address.
  #
  # Composing it beats a two-phase apply (deploy, read the URI, apply again),
  # which leaves a window where the service is running with a placeholder.
  #
  # ⚠ IT IS NOT THE ONLY URL, AND `.uri` RETURNS THE OTHER ONE. Verified on the
  # live service 2026-08-25 — `run.googleapis.com/urls` lists BOTH the
  # project-number form above and an opaque-hash form
  # (`voice-us-staging-7aaa2qfltq-uc.a.run.app`), and `status.url` — which is
  # what `google_cloud_run_v2_service.uri` and the console show — is the HASH.
  # Both hostnames serve the same revision, so the difference is invisible until
  # the Twilio signature is checked, which is computed over the exact URL string.
  # THE WEBHOOK MUST BE THE VALUE BELOW. See the cloud_run_services output.
  #
  # This corrects the ledger's standing fact that Cloud Run here issues "one
  # form or the other per project and does not let you choose": it issues both.
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
      #
      # KNOWN BENIGN DRIFT, and it is deliberately not suppressed.
      #
      # When min_instance_count is 0 — the API default — Cloud Run omits the
      # field from its response, and the provider reads that as "the value I set
      # is gone". Every plan therefore shows:
      #
      #   ~ scaling { - min_instance_count = 0 -> null
      #               - manual_instance_count = 0 -> null }
      #
      # Applying it changes nothing and the diff comes straight back. Sending
      # `null` instead of 0 does not help; the mismatch is between the provider
      # and the API, not in this value.
      #
      # `lifecycle { ignore_changes }` would silence it and is the wrong trade:
      # min_instance_count is C-11, the difference between a warm instance and a
      # cold start landing on a caller, and between $0 and ~$45/month. Hiding
      # the one field whose drift would actually matter, to tidy a cosmetic
      # diff, is how a cost control stops being enforced.
      #
      # So: this module's plan is NOT clean while a service runs at min 0. Read
      # the diff rather than trusting an empty one. It disappears for production,
      # where min is 1.
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
        # ALWAYS `true` in attempt 2, and the reasoning is entirely in
        # cost-controls.tf above `variable "cloud_run_services"`. Short
        # version: `cpu_idle = false` alongside min_instances = 1 is ~$70/month
        # on this line, against a whole-estate budget of ~$55-80. The instance
        # still stays resident; what is given up is the CPU un-throttle on the
        # first request after an idle gap, which is a fraction of a cold start
        # and is UNMEASURED. Verify on a live call, on turn ONE, not on a p50.
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

      # P2. Cloud Run injects no build metadata at all, so `GET /` would report
      # `Build: unknown` on every deployed revision. See the long note above
      # `variable "git_commit_sha"` in migrate-job.tf.
      env {
        name  = "GIT_COMMIT_SHA"
        value = local.voice_build_sha
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

      # -------------------------------------------------------------------
      # C-3 / Phase 3a. Where the shared call-state slice lives.
      #
      # `var.call_state_store` has existed since attempt 1 and reached NOTHING
      # but `local.cloud_sql_plan` and an output. A variable that is validated,
      # documented, defaulted to "postgres" and never rendered onto the service
      # is not a setting — it is a comment that typechecks.
      #
      # This is the same failure shape as DEEPGRAM_REGION below, and that one is
      # worth re-reading: the variable existed, a test proved the FUNCTION
      # returned the EU host, and nothing set the env var, so every caller's
      # audio would have gone to the US while the tests stayed green.
      #
      # Unset, `lib/callState.js` defaults to the in-process Map. On more than
      # one instance that is the live bug Phase 3a exists to close:
      # `/twilio/status` lands on an instance that never held the WebSocket,
      # reads empty state, and silently produces no call summary, no missed-call
      # notification, and a spam tag on every short call where the caller spoke.
      # Nothing logs an error. So a missing value here does not fail the deploy,
      # it un-does the phase.
      #
      # Passed through verbatim rather than mapped: `lib/callState.js` accepts
      # "postgres" and "memorystore" — this module's vocabulary — alongside "pg"
      # and "memory", precisely so the value that is correct HERE is also correct
      # THERE. It refuses anything else at boot rather than guessing, because
      # guessing "memory" is the silent failure above.
      # -------------------------------------------------------------------
      env {
        name  = "CALL_STATE_STORE"
        value = var.call_state_store
      }

      # -------------------------------------------------------------------
      # P7. The connection pool, sized from the instance rather than guessed.
      #
      # THIS WAS SET NOWHERE UNTIL PHASE 4, so both services took services/db.js's
      # default of 10 and `instances x DB_POOL_MAX` was 20 x 10 = 200 against a
      # measured ceiling of 50. Third instance of the same shape as
      # CALL_STATE_STORE above and DEEPGRAM_REGION below: a value the code reads
      # and the module never sent.
      #
      # MEASURED on vetra-uk 2026-08-28, off the instance, not assumed:
      #   max_connections = 50, superuser_reserved_connections = 3,
      #   cloudsqladmin holding 3. So ~44 slots for application roles.
      #
      # KEPT AT 10 DELIBERATELY. Phase 3b measured one instance REACHING 10 at
      # 10 concurrent calls, so a smaller pool makes calls queue for a
      # connection -- and on this product latency is the thing being sold. The
      # ceiling is respected by lowering max_instance_count instead, which costs
      # nothing while ElevenLabs refuses concurrent call 11 anyway.
      #
      # Connections do NOT scale with callers: the same 10 served 10, 20 AND 30
      # concurrent calls, because the pool caps and calls queue on it.
      # -------------------------------------------------------------------
      env {
        name  = "DB_POOL_MAX"
        value = tostring(var.db_pool_max)
      }

      # -------------------------------------------------------------------
      # The compliance tier. `standard` EVERYWHERE, ON BOTH LANES.
      #
      # ATTEMPT 1 SET THIS PER LANE — `us` was `hipaa`, `uk` was `standard` —
      # and that whole branch is dead config describing a market this business
      # is not in. THERE IS NO GCP BAA and there is not going to be one for
      # this: Twilio's BAA is $2,000/month, which closes US healthcare on its
      # own, and without Twilio covered the rest of the chain is moot.
      #
      # `DEPLOYMENT_MODE=hipaa` STAYS IN THE CODE AND IN THE TESTS AND IS
      # DEPLOYED NOWHERE. That is deliberate and it is not dead weight: the
      # covered-vendor guard, the credential-boundary refusal and the CMEK
      # assertions are all still exercised by the suite, so the posture can be
      # switched on later without rebuilding it. What is NOT paid for is
      # running it — Google STT v2, CMEK-on-speech and a second speech vendor.
      #
      # Both lanes therefore run the same stack: Deepgram + ElevenLabs + Vertex.
      #
      # ⚠ SETTING `deployment_mode = "hipaa"` IS NOT A ONE-LINE CHANGE, however
      # much this looks like one. A hipaa process REFUSES TO BOOT with a
      # Deepgram credential present (`checkCoveredVendors`), and secrets.tf
      # still scopes `deepgram-api-key` and `elevenlabs-api-key` to the UK lane
      # only — so flipping this while lighting `us-prod` produces a US service
      # that either crash-loops or has no ears and no voice. See the parked
      # finding in the Phase 2 ledger section.
      # -------------------------------------------------------------------
      env {
        name  = "DEPLOYMENT_MODE"
        value = var.deployment_mode
      }

      # A SINGLE region, never `global`. lib/voice/sttGoogle.js refuses `global`
      # at construction and checkSttConfig refuses it at boot, for the reason
      # VERTEX_LOCATION already carries: a global endpoint may process audio in
      # any region on earth, which voids the data-location control while looking
      # like a sensible value.
      #
      # Matches the project's own region, which is also where speech.tf puts the
      # CMEK key ring — a key in another region is not a key Speech can use, and
      # the error names neither.
      env {
        name  = "STT_LOCATION"
        value = local.projects[var.stack_projects[each.value.stack]].region
      }

      # SMTP identity. Not secrets — a hostname, a port and an address — and
      # keeping them out of Secret Manager keeps that list to things that are
      # actually credentials. Only SMTP_PASS is a secret.
      #
      # SMTP_USER matters more than it looks: bootChecks makes a half-configured
      # pair FATAL, so pushing SMTP_PASS without it is a service that will not
      # start. The first deploy did exactly that.
      dynamic "env" {
        for_each = var.smtp_config
        content {
          name  = env.key
          value = env.value
        }
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

      # -------------------------------------------------------------------
      # Token verification for this service's STAFF routes.
      # -------------------------------------------------------------------
      # The voice server is not only a webhook target. Behind
      # requireBusinessAccess it also serves the two data-subject-rights
      # endpoints — GET  /api/businesses/:id/callers/:phone/export (Art. 15)
      # and DELETE /api/businesses/:id/callers/:phone (Art. 17) — plus the
      # Twilio number routes.
      #
      # Without this, `lib/bootChecks.js` announces `auth_not_configured` and
      # every one of those routes returns 401 to everybody. That went unnoticed
      # because CALLS ARE COMPLETELY UNAFFECTED: the phone works, and the
      # statutory endpoints behind it do not. Found 2026-08-23 by reading a boot
      # notice, not by any test.
      #
      # `shared`, NOT `each.value.project`, and this is the same trap the
      # dashboard's copy documents: Identity Platform lives in vetra-shared, the
      # token's `aud` is that project and its `iss` is
      # https://securetoken.google.com/<that project>, and `securetoken` is ONE
      # signer shared by every Firebase project on earth. This value is the only
      # thing between us and a token minted in a stranger's free project.
      # Pointing it at the running project would fail every request while
      # looking like a deploy that changed nothing about auth.
      env {
        name  = "IDENTITY_PLATFORM_PROJECT_ID"
        value = local.project_id_for_stack["shared"]
      }

      # Caller-facing SMS. Emitted only for a stack that has a number, so an
      # unset stack keeps the channel off loudly (`sms_channel_off` at boot)
      # rather than shipping an empty string that Twilio would reject per
      # message, at send time, on the phone path.
      dynamic "env" {
        for_each = lookup(var.twilio_sms_from, each.value.stack, "") != "" ? [1] : []
        content {
          name  = "TWILIO_SMS_FROM"
          value = var.twilio_sms_from[each.value.stack]
        }
      }

      # Where an owner notification tells them to go. Emitted only when set, so
      # an unset stack keeps bootChecks' `dashboard_url_missing` notice rather
      # than shipping an empty string that would render as a link to nowhere.
      #
      # Not derived from dashboard_domains[0]: that list is an unordered
      # allow-list for CORS and Identity Platform, and giving its first element
      # a second meaning would make adding a domain silently repoint every
      # notification. The variable's own validation checks the two agree.
      dynamic "env" {
        for_each = var.dashboard_url != "" ? [1] : []
        content {
          name  = "DASHBOARD_URL"
          value = var.dashboard_url
        }
      }

      # ⚠ THE HOST DECIDES RESIDENCY. THE LOCATION IN THE PATH DOES NOT.
      #
      # This read `lane == "uk" ? "eu" : "us"`, justified by "never `global`,
      # which routes anywhere on earth and voids the residency claim". P1's
      # re-probe on 2026-08-28 measured that distinction out of existence:
      #
      #   - `aiplatform.googleapis.com` (the global host) serves gemini-3.6-flash
      #     for ANY path location -- including `locations/madeup-region-9`, which
      #     returned 200 SERVED. The path segment is not validated, so a 200 on
      #     `locations/eu` is NOT evidence of EU processing.
      #   - `europe-west2-aiplatform.googleapis.com` (a REGIONAL host) is
      #     genuinely region-pinned and serves ONLY gemini-2.5-flash; 3.6-flash
      #     404s there.
      #   - services/gemini.js:191 lists "us", "eu" AND "global" as
      #     VERTEX_GLOBAL_HOST_LOCATIONS -- all three reach the same host, so the
      #     lane ternary above produced two labels for one behaviour.
      #
      # So `eu` was not buying residency; it was asserting it. That is the same
      # shape as P9 -- a control that exists in a comment and not in fact -- and
      # it is worse here, because the privacy notice and the Art. 30 record are
      # supposed to DISCLOSE this leg as an international transfer.
      #
      # `global` is the honest label for what this deployment does, and
      # services/gemini.js:174 says so in as many words. Decided by the owner
      # 2026-08-28; VERTEX_FORBIDDEN_LOCATIONS is now empty so nothing refuses it.
      #
      # A real region still pins the host, so this becomes a genuine residency
      # control the day europe-west2's REGIONAL host serves a 3.x model. That is
      # worth re-probing monthly, and is why this is a variable now.
      env {
        name  = "VERTEX_LOCATION"
        value = var.vertex_location
      }

      # -----------------------------------------------------------------------
      # WHICH DEEPGRAM ENDPOINT THE AUDIO GOES TO. Added at U1, 2026-08-25, and
      # it had NEVER BEEN SET BY ANY TERRAFORM.
      #
      # `lib/voice/sttDeepgram.js` reads DEEPGRAM_REGION and defaults it to
      # "us", so a UK service without this streams every caller's audio to
      # `wss://api.deepgram.com` — processed in the United States. Its own
      # docstring says the value is "set per Cloud Run service in B4"; B4 set
      # STT_LOCATION, VERTEX_LOCATION and DEEPGRAM_API_KEY and not this one.
      #
      # NOTHING WOULD HAVE SURFACED IT. `tests/deepgramRegion.test.js` proves
      # `deepgramEnvironment()` returns the EU host when the variable is "eu" —
      # the function, not the caller, and never that anything sets the variable.
      # Calls would connect, transcribe and sound correct, and the residency
      # claim the whole UK lane is built on would be false. The same shape as
      # eval/run.js's guard: green tests around a function nothing invoked.
      #
      # `eu` is the only value that switches; anything else falls through to the
      # US host, so this is written as an explicit two-way choice rather than
      # passed through from a variable somebody could set to "uk" or "gb".
      # -----------------------------------------------------------------------
      env {
        name  = "DEEPGRAM_REGION"
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

# ---------------------------------------------------------------------------
# PUBLIC INVOKER. Deliberate, and this is the reasoning.
#
# Cloud Run denies unauthenticated requests by default, which is a good default
# and the wrong one here: Twilio calls this webhook from its own infrastructure
# with no Google credential, so IAM cannot be the gate. Without this binding the
# service returns 403 to Twilio and every call fails.
#
# WHAT REPLACES IAM, and it is not nothing:
#
#   1. Twilio request signatures. `twilioValidation` in server.js verifies every
#      request with HMAC over the exact URL and body using the auth token, and
#      it is ON unless TWILIO_VALIDATE_SIGNATURE is explicitly "false". A
#      request without a valid signature gets 403 before any handler runs.
#   2. CALLER_ALLOWLIST on staging, which refuses every caller but two test
#      numbers even if the signature is valid.
#   3. The service holds no data of its own. Everything is behind a private-IP
#      database that is not reachable from the internet at any price.
#
# Note the coupling this creates, because it is easy to break: the signature is
# computed over the FULL URL, so BASE_URL must exactly match the URL Twilio was
# configured with. A mismatch produces 403s that look like a credential problem
# and are a string problem.
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  for_each = local.deployable_services

  project  = google_cloud_run_v2_service.this[each.key].project
  location = google_cloud_run_v2_service.this[each.key].location
  name     = google_cloud_run_v2_service.this[each.key].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "cloud_run_services" {
  description = <<-EOT
    Deployed services and their URLs.

    ⚠ `uri` IS NOT THE URL TO PUT IN TWILIO. `twilio_webhook_base` is.

    A Cloud Run service here answers on TWO hostnames — verified on the live
    us-staging service, whose `run.googleapis.com/urls` annotation lists both:

      https://voice-us-staging-536266051432.us-central1.run.app   project-number
      https://voice-us-staging-7aaa2qfltq-uc.a.run.app            opaque hash

    Both resolve, so a mistake here does not fail as a 404. `uri` returns the
    HASH form. `BASE_URL` in the container is the PROJECT-NUMBER form, because
    that is the one this module can compose before the service exists.

    The Twilio signature is an HMAC over the FULL request URL, and server.js
    rebuilds that URL as `BASE_URL + req.originalUrl`. Configure the webhook
    with the hash form and every signature comparison is over a different
    string: 403 on every call, including genuine ones, reading as a bad auth
    token. That is the failure this repository has already had once from a
    signature path that refused everything.
  EOT
  value = {
    for k, v in google_cloud_run_v2_service.this : k => {
      name          = v.name
      uri           = v.uri
      min_instances = v.template[0].scaling[0].min_instance_count
      secrets_wired = var.wire_runtime_secrets

      # What BASE_URL is set to inside the container, and therefore the only
      # host Twilio may be pointed at. Voice webhook: <this>/twilio/voice.
      twilio_webhook_base = local.service_base_url[k]
    }
  }
}
