# ---------------------------------------------------------------------------
# Networking. No default network, no public database.
#
# ---------------------------------------------------------------------------
# One VPC per PROJECT, one subnet per STACK — and why that split matters
# ---------------------------------------------------------------------------
#
# An earlier revision created one VPC per stack. Under the 6 -> 4 merge that
# quietly broke C-4. A Cloud SQL instance attaches to exactly ONE VPC (private
# services access is a peering on a single network), so a merged staging project
# holding two unpeered VPCs cannot have one shared instance — the second lane's
# Cloud Run would have no route to it. The choice would have been two instances,
# which is C-4 undone, or peering the two staging VPCs, which is a network path
# between the lanes that would not exist if they had their own projects.
#
# A GCP VPC is GLOBAL and its subnets are REGIONAL, so the right shape was
# available the whole time: one VPC in the merged staging project, a
# us-central1 subnet and a europe-west2 subnet inside it, one Cloud SQL instance
# peered to the VPC, and each lane's Cloud Run doing Direct VPC egress into its
# own regional subnet.
#
# This also survives the 4 -> 6 restore untouched. Put `uk-staging` back in its
# own project and "one VPC per project" is once again one VPC per stack, with no
# edit here.
#
# Cloud SQL in B2 is private-IP only, which needs two things that are easy to
# get wrong and slow to debug: a reserved address range for private services
# access, and a peering connection to Google's service network. Both are below,
# so B2 is a database instance rather than a networking project.
# ---------------------------------------------------------------------------

locals {
  # Distinct, non-overlapping /16 per STACK. They must not overlap even where
  # the VPCs are not peered to each other, because a future peering (or a VPN
  # back to a clinic) becomes impossible if they do, and renumbering a live
  # database is not a small job.
  #
  # Under the merge this stops being merely prudent: `us-staging` and
  # `uk-staging` are now two subnets of ONE network, and two subnets of one
  # network that overlapped would simply be rejected.
  network_cidr = {
    us-prod    = "10.10"
    us-staging = "10.20"
    uk-prod    = "10.30"
    uk-staging = "10.40"
  }

  # Regional stacks grouped by the project whose VPC they share. Written out
  # rather than derived inline because three resources below need it.
  stacks_by_regional_project = {
    for pk in local.active_regional_project_keys : pk => sort([
      for sk in keys(local.active_regional_stacks) : sk if var.stack_projects[sk] == pk
    ])
  }
}

resource "google_compute_network" "this" {
  for_each = toset(local.active_regional_project_keys)

  project                 = google_project.this[each.value].project_id
  name                    = "vetra-${each.value}"
  auto_create_subnetworks = false
  description             = "Private network for ${join(", ", local.stacks_by_regional_project[each.value])}. Subnets are per stack; the network is per project because a Cloud SQL instance peers to one network."

  depends_on = [google_project_service.this]
}

# Per STACK. Two stacks sharing a project get two subnets in two regions inside
# the one network above — which is what lets a US and a UK staging service each
# run in its own region while sharing a database.
resource "google_compute_subnetwork" "this" {
  for_each = local.active_regional_stacks

  project = local.project_id_for_stack[each.key]
  name    = "vetra-${each.key}-${each.value.region}"
  region  = each.value.region
  network = google_compute_network.this[var.stack_projects[each.key]].id

  # A /20 rather than something tighter because of C-6. Direct VPC egress
  # allocates an address from this subnet PER Cloud Run INSTANCE, not per
  # connector, so the subnet — not a connector's instance count — is what caps
  # concurrency. 4,096 addresses is far more than this workload will ever want
  # and costs nothing to reserve.
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

# The address range Cloud SQL's private IP is allocated from. Per network, so
# per project. Reserved here, consumed in B2.
#
# It is carved out of the /16 belonging to the stack the project is NAMED after,
# above that stack's /20 subnet. In a merged project the other lane's subnet
# lives in its own /16 entirely, so nothing can collide.
resource "google_compute_global_address" "private_services" {
  for_each = toset(local.active_regional_project_keys)

  project       = google_project.this[each.value].project_id
  name          = "vetra-${each.value}-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  address       = "${local.network_cidr[each.value]}.32.0"
  prefix_length = 19
  network       = google_compute_network.this[each.value].id
}

resource "google_service_networking_connection" "private_services" {
  for_each = toset(local.active_regional_project_keys)

  network                 = google_compute_network.this[each.value].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services[each.value].name]
}

# ---------------------------------------------------------------------------
# NOT HERE, AND NOT LATER EITHER: the Serverless VPC Access connector. (C-6)
#
# Cloud Run needs a route into this VPC to reach a private-IP Cloud SQL, and
# there are two ways to give it one:
#
#   Serverless VPC Access connector — a managed group of REAL VM INSTANCES.
#   Billed per instance-hour from the moment it exists, whether or not anything
#   sends a packet through it. Roughly $30-40 each, so four is $120-160/month,
#   for infrastructure that does nothing until B2 brings up a database.
#
#   Direct VPC egress — configured on the Cloud Run service itself. Reaches the
#   same private IPs, allocates addresses from the subnets above, and has NO
#   FIXED CHARGE. This is the one.
#
# So C-6 is not a deferral, it is a deletion: an earlier revision of this module
# created four connectors and would have started a ~$70-80/month meter on the
# very first apply. B2 uses `vpc_access { network_interfaces { ... } }` on the
# Cloud Run service and creates no connector at all.
#
# tests/infra/costControls.test.js fails the build if `google_vpc_access_connector`
# reappears in this directory. A comment explaining a cost decision is not the
# same as a check that catches someone undoing it.
#
# What IS here is the part that is free and that B2 depends on: the reserved
# peering range and the service-networking connection above. Those are fiddly
# and slow to get right, and having them already in place is what makes B2 a
# database task rather than a networking project.
# ---------------------------------------------------------------------------
