# ---------------------------------------------------------------------------
# B3 — Identity Platform. Staff logins for the dashboard.
#
# ONE instance, in `vetra-shared`, serving BOTH regional stacks. US only. No
# tenants. That is a decision (2026-08-21, owner), and the reasoning is worth
# keeping next to the code because two parts of it read as mistakes otherwise.
#
# NO TENANTS. Identity Platform's multi-tenancy is a second, parallel tenancy
# model to the one migration 029 already enforces in the database, and the two
# would have to be kept in agreement forever — a user in the wrong Identity
# Platform tenant but the right `users` row, or the reverse, is a bug with no
# single source of truth to check against. The database is where tenancy is
# already enforced by policy rather than by discipline, so it stays the only
# place tenancy exists. `allow_tenants` is written out as `false` rather than
# left to the default, so switching it on is a visible edit.
#
# NO DATA-RESIDENCY CONTROL EXISTS FOR THIS SERVICE, at all. Checked against the
# API rather than inferred from marketing: the `Config` resource has eighteen
# top-level fields and not one sets a location, region or residency, and
# `gcp.resourceLocations` — the org policy that enforces the whole two-region
# design — does not apply, because Identity Platform is not a regional resource.
# `smsRegionConfig` governs where an SMS code may be SENT, not where accounts
# live.
#
# So this is the ONE place the two-region design cannot be enforced. What keeps
# it manageable: it holds clinic STAFF logins — email, a password hash, a
# display name — and no PHI and no patient data. What it changes: the UK story
# becomes a DISCLOSED TRANSFER under Google's DPA, not enforced residency, and
# saying otherwise in a DPIA would be worse than the transfer itself. That is a
# solicitor's question (open question O11), not a Terraform one, which is why
# UK staff accounts wait on the clinic's DPA and nothing here creates them.
# ---------------------------------------------------------------------------

resource "google_identity_platform_config" "auth" {
  project = local.project_id_for_stack["shared"]

  # Domains permitted to receive a password-reset or verification continue URL.
  # Setting this REPLACES Google's defaults rather than adding to them, so the
  # defaults are written out. Dropping `localhost` breaks the dev flow; dropping
  # the two Google-owned ones breaks the hosted action handler that sends the
  # reset email's link somewhere at all.
  authorized_domains = concat(
    [
      "localhost",
      "${local.project_id_for_stack["shared"]}.firebaseapp.com",
      "${local.project_id_for_stack["shared"]}.web.app",
    ],
    var.dashboard_domains,
  )

  sign_in {
    # Email and password. That is the entire product need, and every other
    # provider is an attack surface for a feature nobody asked for.
    email {
      enabled           = true
      password_required = true
    }

    # Written out as disabled rather than omitted. An anonymous session that can
    # call the dashboard API is a pre-authenticated stranger, and a phone
    # provider bills real money per SMS to whoever can reach the endpoint.
    anonymous {
      enabled = false
    }
    phone_number {
      enabled = false
    }

    # `users.email` is UNIQUE and app_lookup_user_by_email keys on it (migration
    # 034). Two auth accounts sharing an address would resolve to one staff row
    # and one tenant, which is an authorisation decision made by accident.
    allow_duplicate_emails = false
  }

  multi_tenant {
    allow_tenants = false
  }

  client {
    permissions {
      # A person deleting their own auth account leaves the `users` row and the
      # business behind, with no way back in and no way to re-attach — the
      # tenant is stranded rather than closed. Deprovisioning is an
      # administrative act (§164.308(a)(3)(ii)(C)), not a self-service button.
      disabled_user_deletion = true

      # Self-serve signup stays ON, deliberately and unchanged: it is how the
      # product works today on Railway, and `POST /api/onboarding/create-business`
      # is the flow behind it. Whether a HIPAA product should let a stranger
      # create a tenant unattended is a real question and a PRODUCT one — the
      # migration must not answer it by quietly changing behaviour.
      disabled_user_signup = false
    }
  }

  monitoring {
    request_logging {
      # §164.308(a)(5)(ii)(C), log-in monitoring. Without this there is no record
      # anywhere of a failed or successful sign-in — the dashboard logs what
      # happens AFTER a token is verified, and nothing logs the attempt.
      #
      # It writes staff email addresses into Cloud Logging, which is why this is
      # a deliberate choice and not a default: workforce identifiers, in the
      # project that holds no PHI, routed by logging.tf's org sink into the
      # 400-day audit bucket. That is the same trade `log_min_duration_statement`
      # was REFUSED on at B2 — and it comes out the other way here, because
      # there the payload was patient names and here it is who logged in.
      enabled = true
    }
  }

  depends_on = [google_project_service.this]
}

# ---------------------------------------------------------------------------
# The browser API key.
#
# Identity Platform auto-creates one when it is initialised, and the config
# exposes it as `client[0].api_key`. That key is UNRESTRICTED — it works against
# every API enabled on the project. This one does not.
#
# A Firebase/Identity Platform web key is meant to be public: it identifies the
# project and authorises nothing, and it ships inside the JavaScript bundle no
# matter what. The restriction below is not about keeping it secret. It bounds
# what someone who lifts it out of the bundle can spend the project's quota on —
# `identitytoolkit` and nothing else, so it cannot be turned on Vertex, Speech
# or Cloud Storage.
#
# NOT restricted by HTTP referrer, and that is a gap rather than an oversight:
# the dashboard has no domain yet. B5's load balancer is built and switched off
# pending DNS, so any referrer list written today would be a guess that either
# blocks the real domain later or is quietly widened until it means nothing.
# `var.dashboard_domains` is the seam — populate it at B5/D-lane and add
# browser_key_restrictions in the same edit.
# ---------------------------------------------------------------------------
resource "google_apikeys_key" "identity_platform_web" {
  project      = local.project_id_for_stack["shared"]
  name         = "vetra-dashboard-auth"
  display_name = "Vetra dashboard — Identity Platform only"

  restrictions {
    api_targets {
      service = "identitytoolkit.googleapis.com"
    }
  }

  depends_on = [google_project_service.this]
}
