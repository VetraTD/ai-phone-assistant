# ---------------------------------------------------------------------------
# The project matrix.
#
# Six projects, generated from one description rather than six copies. That is
# not tidiness — it is what makes B0a's gate meaningful. The gate is
# "`terraform plan` applies clean to BOTH staging stacks", and it exists to
# prove the module is genuinely parameterised by region. Six hand-written copies
# would pass that gate while hiding a us-central1 hard-coded in the UK stack.
#
# Projects are SIBLINGS under the organization. GCP has no such thing as a
# sub-project; nesting is done with folders, which hold no resources.
# ---------------------------------------------------------------------------

locals {
  # `in:us-locations` and `in:eu-locations` are Google's value groups for the
  # gcp.resourceLocations constraint. They are the enforcement behind the entire
  # two-region design: with them, creating a resource in the wrong continent is
  # an API rejection rather than a code review someone has to catch.
  us_locations = ["in:us-locations"]
  eu_locations = ["in:eu-locations"]

  common_apis = [
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ]

  # Everything a voice stack needs to serve a call. Vertex, STT and TTS are here
  # rather than in shared because the US lane's model and speech traffic must
  # stay inside the US project's location constraint.
  regional_apis = concat(local.common_apis, [
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "redis.googleapis.com",
    "vpcaccess.googleapis.com",
    "compute.googleapis.com",
    "servicenetworking.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudkms.googleapis.com",
    "aiplatform.googleapis.com",
    "speech.googleapis.com",
    "texttospeech.googleapis.com",
    "cloudscheduler.googleapis.com",
  ])

  shared_apis = concat(local.common_apis, [
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "identitytoolkit.googleapis.com",
    "secretmanager.googleapis.com",
  ])

  logging_apis = concat(local.common_apis, [
    "storage.googleapis.com",
  ])

  projects = {
    us-prod = {
      display   = "Vetra US Prod"
      lane      = "us"
      env       = "prod"
      region    = var.us_region
      locations = local.us_locations
      apis      = local.regional_apis
      phi       = true
    }
    us-staging = {
      display   = "Vetra US Staging"
      lane      = "us"
      env       = "staging"
      region    = var.us_region
      locations = local.us_locations
      apis      = local.regional_apis
      phi       = false
    }
    uk-prod = {
      display   = "Vetra UK Prod"
      lane      = "uk"
      env       = "prod"
      region    = var.uk_region
      locations = local.eu_locations
      apis      = local.regional_apis
      phi       = true
    }
    uk-staging = {
      display   = "Vetra UK Staging"
      lane      = "uk"
      env       = "staging"
      region    = var.uk_region
      locations = local.eu_locations
      apis      = local.regional_apis
      phi       = false
    }
    shared = {
      display = "Vetra Shared"
      lane    = "shared"
      env     = "shared"
      region  = var.us_region
      # Both continents allowed. This project holds Artifact Registry, Cloud
      # Build and Identity Platform, and it serves BOTH stacks — a UK Cloud Run
      # service pulling an image from a US registry is fine, because container
      # images are not patient data. Constraining it to one continent would
      # force a second registry for no safety gain.
      locations = concat(local.us_locations, local.eu_locations)
      apis      = local.shared_apis
      phi       = false
    }
    logging = {
      display = "Vetra Logging"
      lane    = "logging"
      env     = "logging"
      region  = var.us_region
      # Both continents, deliberately, because this project holds TWO regional
      # log buckets rather than one. UK logs landing in a US bucket would be a
      # transfer, so the sink is split by origin — see logging.tf.
      locations = concat(local.us_locations, local.eu_locations)
      apis      = local.logging_apis
      phi       = false
    }
  }

  # The regional stacks only — the four that actually serve calls and hold a
  # VPC. `shared` and `logging` have no network of their own.
  regional_projects = {
    for k, v in local.projects : k => v if contains(["us", "uk"], v.lane)
  }
}
