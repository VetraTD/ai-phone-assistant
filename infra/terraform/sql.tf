# ---------------------------------------------------------------------------
# B2 — Cloud SQL for PostgreSQL 16. Private IP, CMEK, PITR.
#
# Built from `local.cloud_sql_plan` (cost-controls.tf) rather than from four
# hand-written instance blocks. That plan is where C-3, C-4 and C-5 already
# decided the shape:
#
#   C-4  one instance per PROJECT, one database per stack. Merged staging shares
#        an instance and takes a database each, and the 4 -> 6 restore gives it
#        its own instance with no edit here, because a project is what an
#        instance belongs to.
#   C-5  ZONAL. HA is not a HIPAA requirement — §164.308(a)(7) asks for backup,
#        disaster recovery and emergency mode, which PITR + backups + C7's
#        restore test satisfy. Regional roughly doubles the bill.
#   C-3  no Memorystore. The shared call-state slice is three scalars written at
#        call boundaries, and it lives in a table on this instance.
#
# This is the FIRST FILE IN THE MODULE THAT COSTS MONEY. Everything up to B0a
# was projects, policies, IAM, networks and empty buckets. Read budget.tf before
# applying this — the ledger's precondition is a budget alert existing first,
# and it did not.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# C-12 — do not run the PRODUCTION database during the migration.
#
# Priced off the real SKU catalog rather than guessed (Cloud Billing Catalog
# API, service 9662-B51E-5089, us-central1, Postgres zonal Enterprise N4):
#
#   vCPU  $0.0413 / hour        RAM  $0.007 / GiB hour
#
#   us-prod    db-custom-2-7680   (2 vCPU, 7.5 GiB)
#              (2 x 0.0413 + 7.5 x 0.007) x 730  =  $98.62 / month
#   us-staging db-g1-small        (shared core)   ~  $27 / month
#
# `vetra-us-prod`'s database serves NOTHING until D4 repoints the Twilio
# webhooks. Creating it at B2 buys 3-6 weeks of an idle $98.62/month instance —
# roughly a third of the entire $300 trial credit — to hold zero rows.
#
# That is the same argument as C-1 and the same argument that moved the VPC
# connectors out of B0w: GCP bills managed services for capacity that EXISTS,
# not capacity that is USED, so paid infrastructure gets provisioned as late as
# possible. Staging is what B2's schema work actually needs.
#
# WHAT THIS DEFERS, stated rather than hidden: B2's gate is "schema diffed
# against Supabase, identical, both regions". With this off, that gate is met
# for staging at B2 and for production at D3, where `pg_restore` creates the
# data the diff would compare. Flipping this to true is one line and one apply.
# ---------------------------------------------------------------------------
variable "enable_prod_databases" {
  description = <<-EOT
    Whether to create Cloud SQL instances for PRODUCTION stacks. Default false.

    Off is not a deferral of the decision — the decision is that a production
    database with no production traffic is $98.62/month of nothing. Turn it on
    at D3, when there is a dump to restore into it.

    Staging is unaffected and always created: it is what the schema work, the
    RLS negative tests and the restore rehearsal all run against.
  EOT
  type        = bool
  default     = false
}

locals {
  # The plan, minus anything C-12 has switched off.
  active_sql_instances = {
    for k, v in local.cloud_sql_plan : k => v
    if !local.projects[k].has_prod || var.enable_prod_databases
  }

  # Flattened databases, so `google_sql_database` can for_each over them.
  active_sql_databases = merge([
    for ik, iv in local.active_sql_instances : {
      for db in iv.databases : "${ik}/${db.name}" => {
        instance_key = ik
        name         = db.name
      }
    }
  ]...)
}

# ---------------------------------------------------------------------------
# CMEK.
#
# Google encrypts Cloud SQL at rest either way; CMEK changes WHO HOLDS THE KEY.
# That matters here for one specific reason: a customer-managed key can be
# disabled, which renders the data unreadable without touching the data. It is
# the only mechanism in the stack that can make a PHI database inert quickly,
# and §164.312(a)(2)(iv) is satisfied by either — this is the stronger form.
#
# The key ring is REGIONAL and must match the instance's region. A key ring
# cannot be moved, renamed or deleted, ever — that is a GCP property, not a
# Terraform one, which is why `prevent_destroy` below is honesty rather than
# caution.
# ---------------------------------------------------------------------------
resource "google_kms_key_ring" "sql" {
  for_each = local.active_sql_instances

  project  = each.value.project_id
  name     = "vetra-sql-${each.key}"
  location = each.value.region

  # Key rings cannot be deleted. Terraform will happily remove one from state
  # and report success, leaving something that can never be recreated under the
  # same name.
  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.this]
}

resource "google_kms_crypto_key" "sql" {
  for_each = local.active_sql_instances

  name     = "vetra-sql-${each.key}"
  key_ring = google_kms_key_ring.sql[each.key].id
  purpose  = "ENCRYPT_DECRYPT"

  # 90 days. Rotation creates a new key VERSION; existing data stays readable
  # under the version that encrypted it, so this is not a re-encryption event
  # and does not need a maintenance window.
  rotation_period = "7776000s"

  # DESTROYING THIS KEY DESTROYS THE DATA. Not figuratively — the ciphertext
  # remains and becomes permanently unreadable, including every backup taken
  # under it. There is no recovery, no support ticket, no restore.
  lifecycle {
    prevent_destroy = true
  }
}

# Cloud SQL encrypts using a per-project Google-managed service agent, not the
# runtime service account. It does not exist until something asks for it, which
# is what this resource does — and the grant below fails with a confusing
# "member not found" if it is skipped.
resource "google_project_service_identity" "sql" {
  provider = google-beta
  for_each = local.active_sql_instances

  project = each.value.project_id
  service = "sqladmin.googleapis.com"

  depends_on = [google_project_service.this]
}

# EXPECT THIS TO FAIL ON A FIRST APPLY, and expect a re-apply to fix it:
#
#   Error 400: Service account service-<n>@gcp-sa-cloud-sql.iam.gserviceaccount.com
#   does not exist., badRequest
#
# `google_project_service_identity` above returns as soon as the API accepts the
# request, but the agent takes a moment to become visible to IAM. Terraform's
# graph orders these correctly and the ordering is not the problem — the
# propagation is. The message says "does not exist", which reads as a wrong
# email address rather than a race, and sends you looking for a typo.
#
# Left as a re-apply rather than papered over with a `time_sleep`: a fixed delay
# is a guess that is either too short on a bad day or wasted on every good one,
# and the failure is loud, safe and idempotent.
resource "google_kms_crypto_key_iam_member" "sql" {
  for_each = local.active_sql_instances

  crypto_key_id = google_kms_crypto_key.sql[each.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${google_project_service_identity.sql[each.key].email}"
}

# ---------------------------------------------------------------------------
# The instances.
# ---------------------------------------------------------------------------
resource "google_sql_database_instance" "this" {
  for_each = local.active_sql_instances

  project             = each.value.project_id
  name                = each.value.instance
  region              = each.value.region
  database_version    = "POSTGRES_16"
  encryption_key_name = google_kms_crypto_key.sql[each.key].id

  # Terraform's own guard, separate from the API-level one in settings below.
  # Both are needed: this one refuses to plan a destroy, that one refuses to
  # execute it. A production database should take two deliberate edits to lose.
  deletion_protection = local.projects[each.key].has_prod

  settings {
    tier              = each.value.tier
    availability_type = each.value.availability_type # C-5: ZONAL
    disk_type         = "PD_SSD"
    disk_size         = 10
    disk_autoresize   = true

    # A cap, because autoresize has no natural ceiling and disk cannot be shrunk
    # afterwards — a runaway table would otherwise buy permanent storage.
    disk_autoresize_limit = local.projects[each.key].has_prod ? 100 : 20

    edition = "ENTERPRISE"

    deletion_protection_enabled = local.projects[each.key].has_prod

    # -----------------------------------------------------------------------
    # PRIVATE IP ONLY. No public IP, no authorized networks.
    #
    # `ipv4_enabled = false` is what makes the database unreachable from the
    # internet regardless of who holds the password. The VPC and the reserved
    # peering range already exist from B0w, which is the whole reason B2 is a
    # database task and not a networking project.
    # -----------------------------------------------------------------------
    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = each.value.private_network
      enable_private_path_for_google_cloud_services = true

      # Reject any connection that is not TLS. Private IP already means "inside
      # the VPC", and B2-rls found `rejectUnauthorized: false` shipped against
      # the PHI database — defence in depth is cheap here.
      ssl_mode = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled    = true
      start_time = "09:00" # UTC, comfortably outside US and UK clinic hours

      # §164.308(a)(7)'s data backup plan, and what C7's restore test operates
      # on. PITR is production-only: staging holds nothing worth recovering to a
      # point in time, and the write-ahead logs are not free.
      point_in_time_recovery_enabled = each.value.point_in_time_recovery
      transaction_log_retention_days = each.value.point_in_time_recovery ? 7 : null
      location                       = startswith(each.value.region, "europe") ? "eu" : "us"

      backup_retention_settings {
        retained_backups = each.value.backup_retention_days
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7 # Sunday
      hour         = 9 # UTC
      update_track = "stable"
    }

    # `log_min_duration_statement` is NOT set, and that absence is deliberate.
    # Statement logging on this schema would put patient names and phone numbers
    # into Cloud Logging as query parameters — the exact leak A1.7's lint exists
    # to prevent, arriving through a channel that lint cannot see.
    database_flags {
      name  = "log_min_error_statement"
      value = "panic"
    }

    # Who connected, from where, and when. An access signal that costs nothing
    # and answers a §164.312(b) question that flow logs answer only vaguely.
    database_flags {
      name  = "log_connections"
      value = "on"
    }

    database_flags {
      name  = "log_disconnections"
      value = "on"
    }

    # -----------------------------------------------------------------------
    # IAM DATABASE AUTHENTICATION. This is what removes the password entirely.
    #
    # With this on, a principal authenticates to Postgres with a short-lived
    # OAuth access token instead of a password. Three consequences, and the
    # third is the one that changes this migration's shape:
    #
    #   1. There is no long-lived database credential to store, rotate, leak or
    #      find in a state file. Access is granted by an IAM binding and revoked
    #      by removing it, which is also how offboarding already works.
    #   2. Postgres sees the IAM identity, so `log_connections` above names WHO
    #      connected rather than "vetra_app" — a real §164.312(b) answer.
    #   3. B4 does not need a database password in Secret Manager, which takes a
    #      whole class of secret off the critical path.
    #
    # Static flag: turning it on RESTARTS the instance. Free to do now on an
    # empty staging database, disruptive later.
    #
    # The application half is separate and not done: `services/db.js` builds a
    # pg.Pool from a DATABASE_URL connection string, and IAM auth needs a token
    # in the password field, refreshed roughly hourly. That is what
    # `@google-cloud/cloud-sql-connector` exists for, and it is a Lane A change.
    # -----------------------------------------------------------------------
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    user_labels = merge(var.labels, {
      stack = each.key
      phi   = local.projects[each.key].has_prod ? "true" : "false"
    })
  }

  depends_on = [
    google_service_networking_connection.private_services,
    google_kms_crypto_key_iam_member.sql,
  ]
}

resource "google_sql_database" "this" {
  for_each = local.active_sql_databases

  project  = local.active_sql_instances[each.value.instance_key].project_id
  instance = google_sql_database_instance.this[each.value.instance_key].name
  name     = each.value.name

  # UTF8 and a deterministic collation. The default follows the instance locale,
  # and a collation difference between the Supabase source and this target is
  # the kind of thing that shows up as ORDER BY returning a different sequence
  # long after the migration is called done.
  charset   = "UTF8"
  collation = "en_US.UTF8"
}

# ---------------------------------------------------------------------------
# Database users — IAM ONLY. None of these has a password.
#
# `google_sql_user` normally takes a `password`, and a password in a Terraform
# resource is a password in Terraform STATE, which now lives in a versioned GCS
# bucket. Migration 029 makes `vetra_app` NOLOGIN precisely so its password does
# not live in git; putting one in state instead would be the same mistake
# wearing a different hat.
#
# CLOUD_IAM_SERVICE_ACCOUNT and CLOUD_IAM_USER users have NO password field at
# all. The credential is a short-lived OAuth token minted at connect time, so
# there is nothing to store and nothing to rotate.
#
# WHAT THIS DOES NOT DO: it does not grant anything INSIDE the database. A fresh
# IAM user can connect and read nothing — table grants and the RLS policies from
# migration 029 are the schema's job, at D3. Being able to open a connection and
# being allowed to read a row are two different questions, and only the first is
# answered here.
# ---------------------------------------------------------------------------

# The runtime service accounts. This is the binding that means B4 needs no
# database password.
#
# Postgres identifiers cap at 63 characters and Cloud SQL expects the service
# account email with the `.gserviceaccount.com` suffix removed — passing the
# full email creates a user that exists and can never authenticate.
resource "google_sql_user" "runtime_iam" {
  for_each = {
    for sk in keys(local.active_regional_stacks) : sk => sk
    if contains(keys(local.active_sql_instances), var.stack_projects[sk])
  }

  project  = local.active_sql_instances[var.stack_projects[each.key]].project_id
  instance = google_sql_database_instance.this[var.stack_projects[each.key]].name
  name     = trimsuffix(google_service_account.runtime[each.key].email, ".gserviceaccount.com")
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}

# The humans. Lets an owner reach the database through the Cloud SQL Auth Proxy
# without a shared password existing anywhere — and makes each connection
# attributable to a person, which a shared `postgres` login never can be.
resource "google_sql_user" "owner_iam" {
  for_each = {
    for pair in setproduct(keys(local.active_sql_instances), var.owner_principals) :
    "${pair[0]}/${pair[1]}" => { instance_key = pair[0], email = trimprefix(pair[1], "user:") }
    if startswith(pair[1], "user:")
  }

  project  = local.active_sql_instances[each.value.instance_key].project_id
  instance = google_sql_database_instance.this[each.value.instance_key].name
  name     = each.value.email
  type     = "CLOUD_IAM_USER"
}
