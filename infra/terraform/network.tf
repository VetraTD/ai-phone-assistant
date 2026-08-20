# ---------------------------------------------------------------------------
# One VPC per regional stack. No default network, no public database.
#
# Cloud SQL in B2 is private-IP only, which requires two things that are easy to
# get wrong and slow to debug: a reserved address range for private services
# access, and a peering connection to Google's service network. Both are here so
# B2 is a database instance rather than a networking project.
#
# The Serverless VPC Access connector is what lets Cloud Run — which has no
# network of its own — reach that private IP. Without it, a Cloud Run service
# and a private Cloud SQL instance in the same project cannot talk, and the
# error message does not say so.
# ---------------------------------------------------------------------------

locals {
  # Distinct, non-overlapping /16 per stack. They must not overlap even though
  # the VPCs are not peered to each other, because a future peering (or a VPN
  # back to a clinic) becomes impossible if they do, and renumbering a live
  # database is not a small job.
  network_cidr = {
    us-prod    = "10.10"
    us-staging = "10.20"
    uk-prod    = "10.30"
    uk-staging = "10.40"
  }
}

resource "google_compute_network" "this" {
  for_each = local.regional_projects

  project                 = google_project.this[each.key].project_id
  name                    = "vetra-${each.key}"
  auto_create_subnetworks = false
  description             = "Private network for the ${each.value.lane} ${each.value.env} voice stack."

  depends_on = [google_project_service.this]
}

resource "google_compute_subnetwork" "this" {
  for_each = local.regional_projects

  project                  = google_project.this[each.key].project_id
  name                     = "vetra-${each.key}-${each.value.region}"
  region                   = each.value.region
  network                  = google_compute_network.this[each.key].id
  ip_cidr_range            = "${local.network_cidr[each.key]}.0.0/20"
  private_ip_google_access = true

  # Flow logs are an access-audit signal, and §164.312(b) asks for one. Sampled
  # rather than complete: full capture on a voice workload is expensive and the
  # question these answer ("did something talk to something it should not") does
  # not need every packet.
  log_config {
    aggregation_interval = "INTERVAL_10_MIN"
    flow_sampling        = 0.5
    metadata             = "INCLUDE_ALL_METADATA"
  }
}

# The address range Cloud SQL's private IP is allocated from. Reserved here,
# consumed in B2.
resource "google_compute_global_address" "private_services" {
  for_each = local.regional_projects

  project       = google_project.this[each.key].project_id
  name          = "vetra-${each.key}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  address       = "${local.network_cidr[each.key]}.32.0"
  prefix_length = 19
  network       = google_compute_network.this[each.key].id
}

resource "google_service_networking_connection" "private_services" {
  for_each = local.regional_projects

  network                 = google_compute_network.this[each.key].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services[each.key].name]
}

# Cloud Run's route into the VPC. The /28 is a hard requirement of the connector
# and must not overlap the subnet above.
resource "google_vpc_access_connector" "this" {
  for_each = local.regional_projects

  project       = google_project.this[each.key].project_id
  name          = "vetra-${each.key}-conn"
  region        = each.value.region
  network       = google_compute_network.this[each.key].name
  ip_cidr_range = "${local.network_cidr[each.key]}.16.0/28"

  min_instances = 2
  max_instances = 3

  depends_on = [google_project_service.this]
}
