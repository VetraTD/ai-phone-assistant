# ---------------------------------------------------------------------------
# B4 — Secret Manager.
#
# ---------------------------------------------------------------------------
# The secrets are created EMPTY, on purpose
# ---------------------------------------------------------------------------
#
# Terraform creates the secret and its IAM; it does not create a version. There
# is nothing here for Terraform to put in one — these are third-party
# credentials that exist in a Twilio console and a mailbox, and routing them
# through this file would mean routing them through Terraform state, a plan
# output and a terminal.
#
# So the handover is one console session: paste each value once, and the next
# revision picks it up. Everything around them — which project, which service
# account can read which secret, which lane gets which vendor — is settled here.
#
# A missing version is not silent. Cloud Run refuses to start a revision whose
# secret cannot be resolved, so a forgotten value is a failed deploy rather than
# a service that boots and drops every notification.
#
# ---------------------------------------------------------------------------
# WHICH LANE GETS WHICH SECRET IS THE WHOLE POINT
# ---------------------------------------------------------------------------
#
# `voice-us` holds no ElevenLabs key. That is the property the entire
# US/UK project split exists to make structural rather than aspirational: a
# misconfiguration in the US lane yields voicemail, not a disclosure to a vendor
# with no BAA. Here it is `lanes = ["uk"]` on one entry, and the absence of a
# `google_secret_manager_secret` in the US project is what enforces it — there
# is no secret to grant, so there is nothing to leak.
#
# tests/infra/credentialBoundary.test.js and scripts/check-credential-boundary.js
# check the same property from the outside, against the live project, because a
# rule that only exists in the file that could break it is not a check.
# ---------------------------------------------------------------------------

variable "runtime_secrets" {
  description = <<-EOT
    Secrets each runtime needs, and which lanes may hold them.

    `lanes` is the credential boundary. An entry listing only "uk" is never
    created in a US project, so the US runtime cannot be granted it, cannot read
    it, and cannot leak it — regardless of what any code does.

    `env_var` is the name the application reads, so the mapping from a secret to
    the variable it lands in is visible in one place rather than inferred from a
    Cloud Run service definition.
  EOT
  type = map(object({
    env_var = string
    lanes   = list(string)
    purpose = string
  }))

  default = {
    twilio-auth-token = {
      env_var = "TWILIO_AUTH_TOKEN"
      lanes   = ["us", "uk"]
      purpose = "Twilio API credential. Also the voice credential, not only SMS."
    }
    twilio-account-sid = {
      env_var = "TWILIO_ACCOUNT_SID"
      lanes   = ["us", "uk"]
      purpose = "Twilio account identifier. Not secret in the strict sense, kept alongside the token so the pair cannot drift."
    }
    smtp-password = {
      env_var = "SMTP_PASS"
      lanes   = ["us", "uk"]
      purpose = "Owner notification email. D1-mail moves this to the M365 mailbox on vetratd.com."
    }
    deepgram-api-key = {
      env_var = "DEEPGRAM_API_KEY"
      lanes   = ["uk"]
      purpose = "Speech-to-text. UK ONLY, as of Google STT v2 landing. The US lane transcribes with Google Speech-to-Text v2 (BAA-covered) and must hold no Deepgram credential at all — checkCoveredVendors refuses to boot a hipaa process that has one, which is exactly what kept US staging on `standard`. This list is now the same kind of boundary as elevenlabs-api-key's."
    }
    elevenlabs-api-key = {
      env_var = "ELEVENLABS_API_KEY"
      lanes   = ["uk"]
      purpose = "Text-to-speech. UK ONLY. No BAA, so it must never exist in a US project — this single-element list is the credential boundary the whole project split exists for."
    }
  }
}

locals {
  # (secret x project) for every ACTIVE regional stack whose lane is allowed to
  # hold it. Keyed by stack rather than project so a merged staging project
  # still gets one grant per runtime identity.
  runtime_secret_grants = merge([
    for sk, sv in local.active_regional_stacks : {
      for name, cfg in var.runtime_secrets : "${sk}/${name}" => {
        stack      = sk
        secret     = name
        env_var    = cfg.env_var
        project_id = local.project_id_for_stack[sk]
      } if contains(cfg.lanes, sv.lane)
    }
  ]...)

  # The secrets themselves are per PROJECT, not per stack — a merged staging
  # project holding both lanes' stacks holds the union of their secrets, which
  # is exactly the rehearsal gap the compensating-control table names and why
  # the CI gate checks production directly.
  runtime_secrets_by_project = merge([
    for sk, sv in local.active_regional_stacks : {
      for name, cfg in var.runtime_secrets : "${local.project_id_for_stack[sk]}/${name}" => {
        project_key = var.stack_projects[sk]
        project_id  = local.project_id_for_stack[sk]
        secret      = name
        region      = local.projects[var.stack_projects[sk]].region
        purpose     = cfg.purpose
      } if contains(cfg.lanes, sv.lane)
    }
  ]...)
}

resource "google_secret_manager_secret" "runtime" {
  for_each = local.runtime_secrets_by_project

  project   = each.value.project_id
  secret_id = each.value.secret

  labels = merge(var.labels, { managed = "terraform" })

  replication {
    # Pinned to the project's region rather than automatic. Secret Manager
    # replication is a property of the SECRET, not of the project, so
    # `gcp.resourceLocations` does not police it — an automatically replicated
    # UK credential would sit in the one place the org policy cannot see.
    user_managed {
      replicas {
        location = each.value.region
      }
    }
  }

  # NO google_secret_manager_secret_version. See the header: the values are
  # third-party credentials and they arrive by hand, once.
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each = local.runtime_secret_grants

  project   = each.value.project_id
  secret_id = google_secret_manager_secret.runtime["${each.value.project_id}/${each.value.secret}"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime[each.value.stack].email}"
}

output "secrets_awaiting_values" {
  description = <<-EOT
    Secrets that exist with no version. Cloud Run will refuse to start a
    revision that references one, so this list is the deploy checklist.

    Add a value with:
      printf '%s' 'THE-VALUE' | gcloud secrets versions add SECRET --project=PROJECT --data-file=-
  EOT
  value = sort([
    for k, v in local.runtime_secrets_by_project : "${v.project_id}/${v.secret}"
  ])
}
