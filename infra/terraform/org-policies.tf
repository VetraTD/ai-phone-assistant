# ---------------------------------------------------------------------------
# Org policies.
#
# These are the difference between a design and an enforcement. Everything else
# in this module could be undone by someone clicking around the console; these
# make the console refuse.
#
# Propagation is eventually consistent — a policy can take minutes to bind. That
# is why skip_default_network is a `depends_on` of every project rather than an
# assumption about apply ordering.
# ---------------------------------------------------------------------------

# No downloadable service-account keys, anywhere in the organization.
#
# A JSON key is a long-lived credential that survives password changes, session
# revocation and offboarding, and it is the single most common way cloud
# credentials end up in a git repository. Workloads here use the metadata server
# and Workload Identity instead, which is both safer and less work.
resource "google_org_policy_policy" "disable_sa_key_creation" {
  name   = "organizations/${var.org_id}/policies/iam.disableServiceAccountKeyCreation"
  parent = "organizations/${var.org_id}"

  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

# No default VPC on new projects.
#
# Google's auto-created default network ships with firewall rules that permit
# SSH and RDP from 0.0.0.0/0. Every project here builds its own network in
# network.tf with nothing open to the internet.
resource "google_org_policy_policy" "skip_default_network" {
  name   = "organizations/${var.org_id}/policies/compute.skipDefaultNetworkCreation"
  parent = "organizations/${var.org_id}"

  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

# Shielded VM required. Nothing in this stack runs a VM today — Cloud Run and
# Cloud SQL are both managed — but the constraint costs nothing now and closes
# the door before someone spins up a bastion host "just to debug something".
resource "google_org_policy_policy" "require_shielded_vm" {
  name   = "organizations/${var.org_id}/policies/compute.requireShieldedVm"
  parent = "organizations/${var.org_id}"

  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

# ---------------------------------------------------------------------------
# Resource locations — the constraint the whole two-region split exists for.
#
# Applied PER PROJECT, because that is the only place it can be applied per
# project. This is precisely why separate projects instead of one: a single
# project gets a single location policy, so it would have to allow both
# continents, and then nothing stands between UK patient data and a us-central1
# bucket except somebody remembering. Here, creating a UK resource outside the
# EU is an API rejection.
#
# THE MERGE COSTS EXACTLY THIS, IN ONE PLACE. `local.projects` derives a merged
# project's allowed locations as the UNION of its stacks', so the staging
# project — hosting both lanes — permits both continents and is therefore NOT
# region-pinned. That is unavoidable: one project, one policy. It is why the
# compensating-control table backs staging residency with a rule (probe/test
# numbers only, no production Twilio credentials) rather than an enforcement,
# and why `us-prod` and `uk-prod` are forbidden from ever sharing — a validation
# on var.stack_projects, not a note.
#
# Restoring `uk-staging` to its own project restores the pin with no code change:
# the union collapses back to one continent on its own.
# ---------------------------------------------------------------------------
resource "google_org_policy_policy" "resource_locations" {
  for_each = local.projects

  name   = "projects/${google_project.this[each.key].project_id}/policies/gcp.resourceLocations"
  parent = "projects/${google_project.this[each.key].project_id}"

  spec {
    rules {
      values {
        allowed_values = each.value.locations
      }
    }
  }

  depends_on = [google_project_service.this]
}
