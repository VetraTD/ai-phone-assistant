# ---------------------------------------------------------------------------
# Adoption: resources that exist in GCP but not in Terraform state.
#
# ---------------------------------------------------------------------------
# What happened
# ---------------------------------------------------------------------------
#
# B0a applied partially on 2026-08-21. It created three org-node policies and
# six projects, then died on the billing account's 5-linked-project cap. It ran
# on LOCAL state, and that state file no longer exists — searched for across the
# whole workstation, not found. The resources survived. Terraform's knowledge of
# them did not.
#
# From empty state, `plan` proposes CREATING projects that already exist, and
# that apply fails on "Requested entity already exists" — a plan that reads as
# 182 resources of progress and is in fact a dead end.
#
# ---------------------------------------------------------------------------
# Why import BLOCKS and not `terraform import`
# ---------------------------------------------------------------------------
#
# `terraform import` writes state immediately, from whatever session runs it,
# leaving nothing in the repository to review. An import block is declarative:
# `plan` renders exactly what would be adopted and writes NOTHING, so the state
# change happens on an apply the owner runs. It is also in git, so the adoption
# is reviewable before it happens and legible afterwards.
#
# ---------------------------------------------------------------------------
# Lifecycle — read this before the next session
# ---------------------------------------------------------------------------
#
# These blocks are driven by variables that default to EMPTY, so they are inert
# unless terraform.tfvars fills them in. That is deliberate: Terraform ERRORS if
# an import block targets an address already in state, so once the adoption
# apply has succeeded, empty the two variables. The blocks themselves stay —
# they cost nothing when the maps are empty, and the next state loss is cheaper
# for their being here.
#
# `random_id.project_suffix` is deliberately NOT imported. Its old value is
# unrecoverable, and it does not need to be: `var.project_id_suffix` pins the
# real suffix and locals.tf prefers it, so the random value is now unused.
# ---------------------------------------------------------------------------

# Projects. The import ID for google_project is the bare project ID.
import {
  for_each = var.adopt_existing_projects

  to = google_project.this[each.key]
  id = each.value
}

# Org-node policies. The import ID is the full policy resource name.
#
# Note there are three of these in org-policies.tf and they are separate
# resources rather than a for_each, so the mapping is written out. A
# `for_each` over an import block cannot target three differently-named
# addresses, and inventing a `local.org_policies` map purely to make it
# possible would restructure working config for one adoption apply.
import {
  for_each = toset([
    for c in var.adopt_existing_org_policies : c
    if c == "iam.disableServiceAccountKeyCreation"
  ])

  to = google_org_policy_policy.disable_sa_key_creation
  id = "organizations/${var.org_id}/policies/${each.value}"
}

import {
  for_each = toset([
    for c in var.adopt_existing_org_policies : c
    if c == "compute.skipDefaultNetworkCreation"
  ])

  to = google_org_policy_policy.skip_default_network
  id = "organizations/${var.org_id}/policies/${each.value}"
}

import {
  for_each = toset([
    for c in var.adopt_existing_org_policies : c
    if c == "compute.requireShieldedVm"
  ])

  to = google_org_policy_policy.require_shielded_vm
  id = "organizations/${var.org_id}/policies/${each.value}"
}
