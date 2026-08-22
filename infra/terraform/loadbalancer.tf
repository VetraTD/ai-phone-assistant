# ---------------------------------------------------------------------------
# B5 — the dashboard SPA, and the front door for everything public.
#
# ---------------------------------------------------------------------------
# Split by COST, not by tidiness
# ---------------------------------------------------------------------------
#
# Almost all of this is free. Exactly one part is not:
#
#   free      the bucket, the backend bucket and its CDN config, the serverless
#             NEG, the URL map, the target proxy, the managed certificate
#   ~$18/mo   the GLOBAL FORWARDING RULE, billed per hour whether or not a
#             single request arrives, plus data processing
#
# So the free half is created unconditionally and the forwarding rule sits
# behind `var.enable_load_balancer`, default false. That is the same rule this
# module has followed since the VPC connectors were moved out of B0w: GCP bills
# managed services for capacity that EXISTS, not capacity that is USED.
#
# ---------------------------------------------------------------------------
# What turning it on actually needs, and why it is off today
# ---------------------------------------------------------------------------
#
# Two things that are not code:
#
#   1. A DNS record. The managed certificate cannot provision until
#      dashboard.vetratd.com (or whatever `var.load_balancer_domain` says)
#      resolves to the load balancer's IP. Until then the cert sits in
#      PROVISIONING and the LB serves nothing usable.
#   2. The dashboard BACKEND image. cloudbuild.yaml builds the voice service
#      only; AI-phone-dashboard/backend has its own Dockerfile and nothing
#      pushes it. A dashboard that loads and cannot reach its API is not a
#      dashboard.
#
# Turning it on before those exist buys an $18/month IP address.
#
# ---------------------------------------------------------------------------
# It also retires a security compromise, which is the real argument for it
# ---------------------------------------------------------------------------
#
# The voice service is currently `allUsers`-invokable, which needed a
# project-scoped exception to Domain Restricted Sharing (org-policies.tf).
# Routing Twilio through this load balancer instead lets the Cloud Run service
# go back to IAM-restricted — the LB is public, the service is not, and the DRS
# exception can be deleted.
#
# That is worth $18/month once there is production traffic. It is not worth it
# for a staging service nobody has dialled.
#
# ---------------------------------------------------------------------------
# The cheaper alternative, recorded because it may be the better answer
# ---------------------------------------------------------------------------
#
# For the SPA ALONE, Firebase Hosting is $0 at this scale: free tier, custom
# domain, automatic certificate, CDN included, no forwarding rule. It cannot
# front Cloud Run for Twilio, so it does not retire the DRS exception — but if
# the dashboard is the only thing that needs hosting, it is strictly cheaper.
# Revisit at D-lane rather than assuming this file is the answer.
# ---------------------------------------------------------------------------

variable "enable_load_balancer" {
  description = <<-EOT
    Whether to create the global forwarding rule and its IP — the only part of
    the load balancer that costs money (~$18/month, billed whether or not a
    request arrives).

    Off until BOTH exist: a DNS record pointing at the IP, and a deployed
    dashboard backend. Turning it on earlier buys an IP address.
  EOT
  type        = bool
  default     = false
}

variable "load_balancer_domain" {
  description = <<-EOT
    Domain for the managed certificate, e.g. "dashboard.vetratd.com".

    Empty disables the certificate and the HTTPS proxy. A Google-managed
    certificate provisions only once DNS resolves to the load balancer's IP, so
    this and the DNS record have to arrive together.
  EOT
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# The SPA bucket. Free at this size, so created regardless.
# ---------------------------------------------------------------------------
resource "google_storage_bucket" "spa" {
  project  = local.project_id_for_stack["shared"]
  name     = "${var.project_prefix}-dashboard-${local.project_suffix}"
  location = var.us_region

  uniform_bucket_level_access = true

  # THE PORT OF vercel.json. Its entire content is
  #   { "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
  # which is the standard single-page-app fallback: the client router owns every
  # path, so a request for /settings must return index.html rather than a 404.
  #
  # On Cloud Storage that is `not_found_page`, and it is genuinely equivalent —
  # the bucket returns index.html with the requested path intact, so the router
  # sees the URL the user asked for.
  website {
    main_page_suffix = "index.html"
    not_found_page   = "index.html"
  }

  # A built SPA bundle is public by design — it is the code the browser runs.
  # What must never be here is a config file with a key in it, which is why the
  # dashboard reads its API base from the page origin rather than a baked-in
  # secret.
  #
  # public_access_prevention is deliberately NOT enforced, unlike the state
  # bucket. This one is meant to be readable.
  force_destroy = false

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 5
    }
    action {
      type = "Delete"
    }
  }

  depends_on = [google_project_service.this]
}

# ---------------------------------------------------------------------------
# Public read on the SPA bucket. GATED, and this one is a security decision
# rather than a cost one.
#
# A Cloud CDN backend bucket requires its objects to be readable by `allUsers` —
# that is how the CDN fetches them, and there is no service-account path. Which
# means this bucket needs the Domain Restricted Sharing exception.
#
# BUT THE BUCKET IS IN `vetra-shared`, and the DRS exception in org-policies.tf
# deliberately covers only the projects that answer a phone. Its own comment
# says why: "a role granted to an outside account in vetra-shared — where the
# build pipeline and the audit trail live — is still refused."
#
# Extending the exception to `shared` to publish a JavaScript bundle would
# weaken that for the whole project, permanently, for something not needed until
# D-lane. So both the binding and the exception wait for the toggle, and until
# then the bucket exists and is private.
#
# WHAT WOULD AVOID THIS ENTIRELY: Firebase Hosting. It serves a SPA on a custom
# domain with a certificate and a CDN at $0, needs no public bucket, and
# therefore needs no DRS exception in the control-plane project. It cannot front
# Cloud Run for Twilio, so it does not replace the load balancer — but if the
# dashboard is the only thing that needs hosting, it is both cheaper AND leaves
# a tighter policy behind. Decide at D-lane.
# ---------------------------------------------------------------------------
resource "google_storage_bucket_iam_member" "spa_public_read" {
  count = var.enable_load_balancer ? 1 : 0

  bucket = google_storage_bucket.spa.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"

  depends_on = [google_org_policy_policy.allow_public_invoker]
}

# ---------------------------------------------------------------------------
# Backend bucket with Cloud CDN. Free to define; billed only on cache egress.
# ---------------------------------------------------------------------------
resource "google_compute_backend_bucket" "spa" {
  project     = local.project_id_for_stack["shared"]
  name        = "vetra-dashboard-spa"
  bucket_name = google_storage_bucket.spa.name
  description = "Dashboard SPA. Cached at the edge; index.html deliberately is not."

  enable_cdn = true

  cdn_policy {
    cache_mode = "CACHE_ALL_STATIC"

    # Vite emits content-hashed filenames, so a bundle is immutable and can be
    # cached for a year. index.html is NOT hashed — it is the file that points
    # at the current bundle — so caching it hard would pin every browser to a
    # stale deploy. The negative TTL keeps it short.
    default_ttl = 3600
    max_ttl     = 31536000
    client_ttl  = 3600

    negative_caching = true
    negative_caching_policy {
      code = 404
      ttl  = 60
    }

    # Serve stale content while revalidating rather than showing an error if the
    # origin hiccups. A dashboard that renders slightly old JavaScript beats a
    # dashboard that does not render.
    serve_while_stale = 86400
  }
}

# ---------------------------------------------------------------------------
# Serverless NEG for the voice service.
#
# This is what would let the Cloud Run service go back to IAM-restricted: the
# load balancer becomes the only public entry point, and the DRS exception in
# org-policies.tf can be deleted.
#
# Free to create. Created unconditionally so the routing is already correct when
# the forwarding rule is switched on.
# ---------------------------------------------------------------------------
resource "google_compute_region_network_endpoint_group" "voice" {
  for_each = local.deployable_services

  project               = each.value.project
  name                  = "vetra-neg-${each.value.stack}"
  region                = each.value.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = google_cloud_run_v2_service.this[each.key].name
  }
}

output "load_balancer_status" {
  description = "What exists, what does not, and what turning it on requires."
  value = {
    spa_bucket         = google_storage_bucket.spa.name
    backend_bucket     = google_compute_backend_bucket.spa.name
    serverless_negs    = [for k, v in google_compute_region_network_endpoint_group.voice : v.name]
    forwarding_rule    = var.enable_load_balancer ? "enabled" : "NOT created (~$18/mo when it is)"
    certificate_domain = var.load_balancer_domain == "" ? "not set" : var.load_balancer_domain
    blocked_on = compact([
      var.load_balancer_domain == "" ? "load_balancer_domain is unset, so no certificate" : "",
      "the dashboard backend image is not built by cloudbuild.yaml",
      "DNS must point at the LB IP before a managed certificate will provision",
    ])
  }
}
