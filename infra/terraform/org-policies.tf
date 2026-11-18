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

# ---------------------------------------------------------------------------
# `iam.disableServiceAccountKeyCreation` IS NOT MANAGED HERE, AND THAT IS THE
# DECISION. The control is ON; Terraform is not the thing holding it on.
#
# Attempt 1 declared it, because attempt 1's org was created by hand and had
# nothing set. Attempt 2's org was AUTO-PROVISIONED by Google at signup and
# arrived with six secure-by-default managed policies already enforced, this
# among them (probed 2026-08-28):
#
#   iam.disableServiceAccountKeyCreation
#   iam.disableServiceAccountKeyUpload
#   iam.automaticIamGrantsForDefaultServiceAccounts
#   storage.uniformBucketLevelAccess
#   compute.restrictProtocolForwardingCreationForTypes
#   compute.setNewProjectDefaultToZonalDNSOnly
#
# Declaring a resource for a policy Google already set makes Terraform fight a
# policy it did not create: an apply that reports a change where nothing
# changed, and a `terraform destroy` that would REMOVE A SECURITY CONTROL
# nobody in this repo turned on. Managing it would be strictly worse than
# leaving it, and the reason for the control is unchanged — a JSON key is a
# long-lived credential that survives password changes, session revocation and
# offboarding, and it is the most common way cloud credentials reach a git
# repository. Workloads here use the metadata server instead.
#
# THE OTHER FIVE ARE THE SAME CASE and are equally not declared. The two below
# ARE declared because Google did NOT set them.
#
# ⚠ `storage.uniformBucketLevelAccess` IS ENFORCED, which is why every
# google_storage_bucket in this module sets `uniform_bucket_level_access = true`
# (loadbalancer.tf, shared.tf) and why no google_storage_bucket_acl or
# google_storage_default_object_acl resource exists anywhere in it. An
# ACL-based bucket is refused AT APPLY TIME, and `terraform plan` does not
# evaluate org policy, so a clean plan says nothing about it.
# ---------------------------------------------------------------------------

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
# ATTEMPT 2 GETS THIS FOR FREE, WHERE ATTEMPT 1 PAID FOR IT. Every project now
# holds exactly one stack, so no project takes the UNION of two lanes'
# locations, and the pin on `uk` is real rather than compensated for by a rule.
# Attempt 1's merged staging project permitted both continents and its residency
# was backed by a written rule (probe numbers only, no production Twilio
# credentials) instead of an enforcement. That gap is closed by the shape.
#
# It reopens the moment two stacks are pointed at one project in
# var.stack_projects — `local.projects` unions their locations, which is the
# only safe direction to combine them and is also strictly weaker. `us-prod`
# and `uk-prod` are forbidden from ever sharing by a validation on that
# variable, not by a note.
#
# ⚠ AND THE VALUE GROUPS DO NOT MEAN WHAT THEY LOOK LIKE. `in:eu-locations` is
# Google's group for the EUROPEAN UNION and does NOT contain `europe-west2`,
# because the UK left. `local.uk_locations` must stay
# ["in:eu-locations", "in:europe-west2-locations"]. `terraform plan` DOES NOT
# EVALUATE ORG POLICY, so the only way to catch this is to read it.
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


# ---------------------------------------------------------------------------
# Domain Restricted Sharing, relaxed for the projects that serve Twilio.
#
# `constraints/iam.allowedPolicyMemberDomains` is enforced by default on an org
# created through Cloud Identity, and it is a good default: it stops anyone
# granting a role to an account outside the organization. It also makes
# `allUsers` an invalid member, which blocks a public Cloud Run service:
#
#   Error 400: One or more users named in the policy do not belong to a
#   permitted customer, perhaps due to an organization policy.
#
# Twilio calls the voice webhook from its own infrastructure with no Google
# credential, so IAM cannot be the gate and the service has to be publicly
# invokable. The gate is Twilio's request signature instead — see the reasoning
# on google_cloud_run_v2_service_iam_member.public_invoker.
#
# SCOPED PER PROJECT, not at the org. The org node keeps the restriction, so a
# role granted to an outside account in `vetra-shared` — where the build
# pipeline and the audit trail live — is still refused. Only the projects that
# actually answer a phone are exempt.
#
# THE BETTER ANSWER, and it is deliberately not taken yet: put an HTTPS load
# balancer in front with a serverless NEG. The LB is public, the Cloud Run
# service stays IAM-restricted, and this constraint never has to be relaxed. It
# needs a managed certificate and therefore a DNS change on vetratd.com, which
# is B5's work. Revisit this the moment that exists — production especially.
# ---------------------------------------------------------------------------
locals {
  # The regional projects always; `shared` only when the load balancer is on,
  # because that is the only thing that needs a public bucket there.
  #
  # Keeping `shared` out by default is the point of scoping this per project at
  # all: it holds the build pipeline's deploy credentials and the audit trail's
  # destination buckets, and an outside grant there should stay refused.
  drs_exempt_projects = toset(concat(
    local.active_regional_project_keys,
    var.enable_load_balancer ? [var.stack_projects["shared"]] : [],
  ))
}

resource "google_org_policy_policy" "allow_public_invoker" {
  for_each = local.drs_exempt_projects

  name   = "projects/${google_project.this[each.value].project_id}/policies/iam.allowedPolicyMemberDomains"
  parent = "projects/${google_project.this[each.value].project_id}"

  spec {
    rules {
      allow_all = "TRUE"
    }
  }

  depends_on = [google_project_service.this]
}
