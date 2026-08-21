output "project_ids" {
  description = "Generated project IDs, keyed by project key. Project IDs are immutable — record these."
  value       = { for k, v in google_project.this : k => v.project_id }
}

output "project_numbers" {
  description = "Project numbers, keyed by project key. Some IAM bindings and API quotas reference these rather than the ID."
  value       = { for k, v in google_project.this : k => v.number }
}

# ---------------------------------------------------------------------------
# The 6/4 shape, as a fact rather than a paragraph.
#
# This is the output to read first when picking the ledger back up. It says
# which stacks are sharing a project, which is the single piece of context that
# makes everything else in the plan legible.
# ---------------------------------------------------------------------------
output "stack_layout" {
  description = "Which project each stack lives in, and which stacks share one. Merged entries are the temporary 6 -> 4 shape."
  value = {
    for pk, pv in local.projects : google_project.this[pk].project_id => {
      stacks    = pv.stacks
      merged    = length(pv.stacks) > 1
      locations = pv.locations
      holds_phi = pv.phi
    }
  }
}

output "runtime_service_accounts" {
  description = "Cloud Run runtime identities per ACTIVE regional stack. B4 deploys services as these."
  value       = { for k, v in google_service_account.runtime : k => v.email }
}

output "deployer_service_account" {
  description = "Cloud Build identity that pushes images and deploys revisions."
  value       = google_service_account.deployer.email
}

output "vpc_networks" {
  description = "VPC self-links, keyed by PROJECT. One network per project — a Cloud SQL instance peers to one network, which is what lets merged staging share an instance."
  value       = { for k, v in google_compute_network.this : k => v.id }
}

output "subnetworks" {
  description = "Subnet self-links per active regional stack. Cloud Run's Direct VPC egress attaches to these."
  value       = { for k, v in google_compute_subnetwork.this : k => v.id }
}

output "private_services_ranges" {
  description = "Reserved peering ranges Cloud SQL private IP is allocated from, keyed by project. Created here, consumed by B2."
  value       = { for k, v in google_compute_global_address.private_services : k => v.name }
}

output "artifact_registry" {
  description = "Docker repository holding the single image both stacks run."
  value       = "${var.us_region}-docker.pkg.dev/${local.project_id_for_stack["shared"]}/${google_artifact_registry_repository.images.repository_id}"
}



output "log_buckets" {
  description = "Log destinations, {region}-{stream}. The `audit` ones are what Bucket Lock will eventually be applied to; the `app` ones must never be locked."
  value       = { for k, v in google_logging_project_bucket_config.sink_target : k => v.id }
}

output "organization_sinks" {
  description = "Aggregated sinks at the org node. A project admin cannot delete or edit these, which is the point."
  value = {
    for k, v in google_logging_organization_sink.aggregated : k => {
      name            = v.name
      filter          = v.filter
      writer_identity = v.writer_identity
    }
  }
}

# ---------------------------------------------------------------------------
# The residency claim, as a machine-readable fact rather than a paragraph in a
# document. C8 and the DPIA both need to state where data can live; this output
# is generated from the same values the org policy enforces, so the two cannot
# drift apart.
# ---------------------------------------------------------------------------
output "enforced_resource_locations" {
  description = "Per-project allowed locations, as enforced by gcp.resourceLocations. Evidence for the DPIA and C8. A project showing both continents is a merged one and is NOT region-pinned."
  value       = { for k, v in local.projects : google_project.this[k].project_id => v.locations }
}



output "tfstate_bucket" {
  description = "State bucket. After the first apply: uncomment the backend block in versions.tf with this name, then `terraform init -migrate-state`. B0a's state was lost for want of this."
  value       = google_storage_bucket.tfstate.name
}
