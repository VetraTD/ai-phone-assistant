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

variable "staging_caller_allowlist" {
  description = <<-EOT
    E.164 numbers permitted to call a STAGING voice service. Everyone else is
    answered with "this number is not in service" and hung up on.

    Empty by default, which refuses every caller. That is deliberate: staging
    shares a Twilio account with production, and the cost of an over-restrictive
    staging service is a tester adding their own number, while the cost of an
    open one is a real patient's speech reaching an environment outside the
    production retention and backup story.

    Never set for production — the variable is only read on staging services,
    and an allowlist in production would refuse real callers.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for n in var.staging_caller_allowlist : can(regex("^\\+[1-9][0-9]{1,14}$", n))])
    error_message = "Every entry must be E.164 (+ then 1-15 digits). Twilio delivers `From` in E.164, so anything else can never match and would produce an allowlist that admits nobody."
  }
}

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

      # -------------------------------------------------------------------
      # The compliance tier. EVERY US STACK IS `hipaa` AGAIN, staging included.
      #
      # It was not. The first staging deploy refused to boot on `hipaa`:
      #
      #   FATAL non_covered_credential_present: DEEPGRAM_API_KEY is set in a
      #   DEPLOYMENT_MODE=hipaa process. Deepgram has no BAA.
      #
      # That was the guard working, and it was the ledger's UNASSIGNED WORK
      # surfacing exactly where it said it would: the US lane had no
      # BAA-covered speech-to-text. Staging was dropped to `standard` to get a
      # service up at all, and the recorded cost was that staging stopped
      # rehearsing the hipaa vendor guard.
      #
      # Google STT v2 now exists behind the sttStream.js seam, so the covered
      # lane HAS ears and the Deepgram credential is no longer in a US project
      # at all — `deepgram-api-key` is UK-only in secrets.tf. Nothing here waits
      # on the Deepgram BAA any more; that answer would change the UK lane's
      # options and nothing about this line.
      #
      # THIS FLIP IS THE MIGRATION'S OBJECTIVE PROOF. Staging ran `standard`
      # ONLY because a hipaa process refused to boot with a Deepgram credential
      # present. If a `hipaa` staging service boots and serves a call, the
      # blocker is gone — and if it does not, no amount of passing tests says
      # otherwise.
      # -------------------------------------------------------------------
      env {
        name  = "DEPLOYMENT_MODE"
        value = local.stacks[each.value.stack].lane == "us" ? "hipaa" : "standard"
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
      # The staging caller allowlist. THE COMPENSATING CONTROL FOR THE MERGE.
      #
      # The control table says staging must never take production Twilio
      # credentials — "probe/test numbers only, backed by a boot-time refusal
      # for any caller number outside the test allowlist". Staging is about to
      # be handed the same Twilio ACCOUNT the production number lives on, so a
      # patient misdialling by one digit could otherwise reach a staging build:
      # the one environment whose residency cannot be enforced and whose
      # database sits outside the production backup and retention story.
      #
      # Set on staging, UNSET in production. Absence means no restriction, and
      # that direction matters — a control that fails closed in production would
      # refuse real callers, which is the outage this exists to prevent causing.
      #
      # An empty list on staging is not a mistake either: it refuses everyone
      # until somebody adds the tester's number, which is the correct default
      # for an environment nobody should be dialling by accident.
      # -------------------------------------------------------------------
      dynamic "env" {
        for_each = local.stacks[each.value.stack].env == "staging" ? [1] : []
        content {
          name  = "CALLER_ALLOWLIST"
          value = join(",", var.staging_caller_allowlist)
        }
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

      # `us`/`eu`, never a single region and never `global`. Probed 2026-08-21:
      # no single Vertex region serves gemini-3.6-flash, and `global` routes
      # anywhere on earth, which voids the residency claim.
      env {
        name  = "VERTEX_LOCATION"
        value = local.stacks[each.value.stack].lane == "uk" ? "eu" : "us"
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
