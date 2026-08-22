# ---------------------------------------------------------------------------
# Speech-to-Text v2 — the covered lane's ears.
#
# The US lane transcribes with Google STT v2 because no BAA covers Deepgram.
# That is settled (decision log, 2026-08-19) and it is what makes a `hipaa`
# process able to serve a call at all: server.js used to exit WITHOUT a
# Deepgram key while bootChecks exits WITH one in hipaa mode, and no
# configuration satisfied both.
#
# ---------------------------------------------------------------------------
# WHAT TERRAFORM CANNOT DO HERE, AND WHY THE GAP IS NAMED RATHER THAN HIDDEN
# ---------------------------------------------------------------------------
#
# The Speech-to-Text v2 per-location `Config` resource — the one that carries
# `kms_key_name` — HAS NO TERRAFORM RESOURCE. The Google provider does not
# implement any of the v2 surface (hashicorp/terraform-provider-google#18878 is
# still open). There is no `google_speech_config`, no `google_speech_recognizer`.
#
# So the CMEK key below is created, rotated and granted here, and the one
# PATCH that points Speech at it is applied by `npm run stt:cmek`. The
# enforcement is NOT the script — a step somebody has to remember is not a
# control. lib/voice/sttGoogle.js `assertSttEncryption()` reads the live Config
# at boot and REFUSES TO START a covered deployment whose kms_key_name is
# empty, so the failure mode of forgetting is a service that will not come up,
# not a service that quietly sends unencrypted audio.
#
# Why CMEK is the control at all: the requirement was to assert the UNLOGGED
# pricing tier in code rather than in a comment, because the "Logged" tier
# ($0.012/min against $0.016) means Google may retain the audio. There is no
# field for it. Verified against the shipped protos — the string "logging" does
# not occur anywhere in the v1 or v2 Speech protos — while the live Cloud
# Billing catalog confirms both SKUs exist. The tier is a project-level program
# opt-in with no API surface, so the assertable control is encryption of the
# audio at rest under a key this org holds and can destroy.
# ---------------------------------------------------------------------------

locals {
  # Only the lanes that actually run Google STT. The UK keeps Deepgram, so
  # provisioning a key ring there would cost money for a service that never
  # calls it — and a key ring cannot be deleted, ever.
  speech_stacks = {
    for sk, sv in local.active_regional_stacks : sk => sv if sv.lane == "us"
  }
}

# Regional, and the region must match STT_LOCATION. A key in another region is
# not a key Speech can use, and the error names neither.
resource "google_kms_key_ring" "speech" {
  for_each = local.speech_stacks

  project  = local.project_id_for_stack[each.key]
  name     = "vetra-speech-${each.key}"
  location = local.projects[var.stack_projects[each.key]].region

  # Key rings cannot be deleted. Terraform will remove one from state and
  # report success, leaving a name that can never be used again.
  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.this]
}

resource "google_kms_crypto_key" "speech" {
  for_each = local.speech_stacks

  name     = "vetra-speech-${each.key}"
  key_ring = google_kms_key_ring.speech[each.key].id
  purpose  = "ENCRYPT_DECRYPT"

  # 90 days, matching the SQL key. Rotation creates a new VERSION; anything
  # already encrypted stays readable under the version that encrypted it.
  rotation_period = "7776000s"

  # DESTROYING THIS KEY MAKES THE AUDIT TRAIL'S AUDIO PERMANENTLY UNREADABLE.
  lifecycle {
    prevent_destroy = true
  }
}

# Speech encrypts as a Google-managed service agent, not as the runtime service
# account. The agent does not exist until something asks for it.
resource "google_project_service_identity" "speech" {
  provider = google-beta
  for_each = local.speech_stacks

  project = local.project_id_for_stack[each.key]
  service = "speech.googleapis.com"

  depends_on = [google_project_service.this]
}

# EXPECT THIS TO FAIL ON A FIRST APPLY AND SUCCEED ON A RE-APPLY — the same
# propagation race documented at length on google_kms_crypto_key_iam_member.sql:
#
#   Error 400: Service account service-<n>@gcp-sa-speech.iam.gserviceaccount.com
#   does not exist., badRequest
#
# The ordering is right; the agent is simply not visible to IAM yet. The
# message reads as a typo in an email address. Deliberately not papered over
# with a time_sleep.
resource "google_kms_crypto_key_iam_member" "speech" {
  for_each = local.speech_stacks

  crypto_key_id = google_kms_crypto_key.speech[each.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.speech[each.key].email}"
}

# ---------------------------------------------------------------------------
# What the runtime is allowed to do with Speech.
#
# `roles/speech.client` and NOT `roles/speech.editor`: client carries
# `speech.recognizers.recognize` (transcribe) and `speech.adaptations.execute`
# (the inline phrase set that boosts a business's own terms), and nothing that
# creates or deletes a recognizer. Granted here rather than added to
# local.runtime_roles because that list applies to every stack, and the UK lane
# transcribes with Deepgram — a role granted for a service nobody calls is the
# same mistake as `roles/redis.editor`.
# ---------------------------------------------------------------------------
resource "google_project_iam_member" "runtime_speech_client" {
  for_each = local.speech_stacks

  project = local.project_id_for_stack[each.key]
  role    = "roles/speech.client"
  member  = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

# ---------------------------------------------------------------------------
# Reading the encryption posture, without being able to change it.
#
# `assertSttEncryption()` reads the location's Config at boot and refuses to
# start when it carries no CMEK key. That read needs `speech.config.get`, and
# that permission is in EXACTLY ONE predefined role: `roles/speech.admin` —
# verified, not assumed. Neither client nor editor has it.
#
# Granting admin would hand the runtime `speech.config.update` as well, so the
# process whose boot check enforces CMEK would also be able to switch CMEK off.
# A control the controlled party can disable is not a control.
#
# So: a custom role holding one permission. The runtime may see whether the
# audit-grade encryption is on and has no way to turn it off.
# ---------------------------------------------------------------------------
resource "google_project_iam_custom_role" "speech_config_reader" {
  for_each = local.speech_stacks

  project     = local.project_id_for_stack[each.key]
  role_id     = "vetraSpeechConfigReader"
  title       = "Vetra Speech Config Reader"
  description = "Read the Speech-to-Text v2 location config (CMEK state) and nothing else. Boot-time assertion only."
  permissions = ["speech.config.get"]
}

resource "google_project_iam_member" "runtime_speech_config_reader" {
  for_each = local.speech_stacks

  project = local.project_id_for_stack[each.key]
  role    = google_project_iam_custom_role.speech_config_reader[each.key].id
  member  = "serviceAccount:${google_service_account.runtime[each.key].email}"
}

output "speech_cmek_keys" {
  description = <<-EOT
    The CMEK key each US stack's Speech-to-Text config must point at.

    Terraform cannot make that assignment: the Google provider implements no
    part of the Speech v2 API (#18878). Apply it with:

        npm run stt:cmek

    A covered deployment refuses to boot until it is done — see
    assertSttEncryption() in lib/voice/sttGoogle.js.
  EOT
  value = {
    for sk, sv in local.speech_stacks : sk => {
      project      = local.project_id_for_stack[sk]
      location     = local.projects[var.stack_projects[sk]].region
      kms_key_name = google_kms_crypto_key.speech[sk].id
    }
  }
}
