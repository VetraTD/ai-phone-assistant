output "project_ids" {
  description = "Generated project IDs, keyed by stack. Project IDs are immutable — record these."
  value       = { for k, v in google_project.this : k => v.project_id }
}

output "project_numbers" {
  description = "Project numbers, keyed by stack. Some IAM bindings and API quotas reference these rather than the ID."
  value       = { for k, v in google_project.this : k => v.number }
}

output "runtime_service_accounts" {
  description = "Cloud Run runtime identities per regional stack. B4 deploys services as these."
  value       = { for k, v in google_service_account.runtime : k => v.email }
}

output "deployer_service_account" {
  description = "Cloud Build identity that pushes images and deploys revisions."
  value       = google_service_account.deployer.email
}

output "vpc_connectors" {
  description = "Serverless VPC Access connectors. Cloud Run needs these to reach private-IP Cloud SQL."
  value       = { for k, v in google_vpc_access_connector.this : k => v.id }
}

output "artifact_registry" {
  description = "Docker repository holding the single image both stacks run."
  value       = "${var.us_region}-docker.pkg.dev/${google_project.this["shared"].project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "audit_log_buckets" {
  description = "Regional audit log buckets. UK logs stay in the EU one."
  value       = { for k, v in google_logging_project_bucket_config.audit : k => v.id }
}

# ---------------------------------------------------------------------------
# The residency claim, as a machine-readable fact rather than a paragraph in a
# document. C8 and the DPIA both need to state where data can live; this output
# is generated from the same values the org policy enforces, so the two cannot
# drift apart.
# ---------------------------------------------------------------------------
output "enforced_resource_locations" {
  description = "Per-project allowed locations, as enforced by gcp.resourceLocations. Evidence for the DPIA and C8."
  value       = { for k, v in local.projects : google_project.this[k].project_id => v.locations }
}

output "tfstate_bucket" {
  description = "State bucket. After the first apply: uncomment the backend block in versions.tf with this name, then `terraform init -migrate-state`."
  value       = google_storage_bucket.tfstate.name
}
