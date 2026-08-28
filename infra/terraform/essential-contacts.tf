# ---------------------------------------------------------------------------
# Who Google tells when something is wrong.
#
# THIS EXISTED NOWHERE UNTIL 2026-08-22, and the cost was already paid. Google
# suspended `vetra-us-staging` for an Acceptable Use Policy violation and said
# it was for REPEATED violations — meaning earlier notices had been sent. None
# were ever seen: with no Essential Contacts configured, Cloud notices go to the
# account that owns the org, `admin@vetratd.com`, and `vetratd.com` mail runs on
# Microsoft 365 where nothing was listening on that address. Every suspension,
# security and billing notice had been going nowhere since the org was created.
#
# The free-trial expiry (~2026-11-18) SUSPENDS projects and warns by the same
# channel, so the next one would have been the whole estate rather than staging.
#
# AT THE ORGANIZATION, not per project. Contacts set here cascade to every
# project including ones that do not exist yet, which is the property that
# matters — a per-project contact is a step somebody has to remember at the
# moment they are busy creating a project.
#
# ---------------------------------------------------------------------------
# THE `@vetratd.com`-ONLY WALL IS GONE, AND KEEPING IT WOULD HAVE MEANT NO
# CONTACTS AT ALL. Re-derived 2026-08-28, not inherited.
#
# Attempt 1's org enforced `essentialcontacts.managed.allowedContactDomains`
# with `allowedDomains = ['@vetratd.com']`, and a personal address was refused
# with "Operation denied by org policy" — which reads as a Console bug and was a
# policy working. This module encoded that as a regex validation so it failed at
# plan time instead.
#
# ON THIS ORG THE SAME CONSTRAINT READS `enforce: false` (probed 2026-08-28), so
# a Gmail IS accepted. And it has to be: `vetratd.com` mail ran on Microsoft 365
# under `admin@vetratd.com`, THAT ACCOUNT IS SUSPENDED AND IS NOT COMING BACK,
# and the account that owns this org is `vetratd@gmail.com`. A validation
# demanding a domain nobody can receive on would have produced a plan-time
# refusal for every address that could actually be reached — the failure mode
# this whole file exists to prevent, arriving through the validation instead of
# through an empty list.
#
# THE ORIGINAL OBJECTION STILL STANDS AND IS NOW A RULE RATHER THAN AN
# ENFORCEMENT: org security and legal notices should not standingly land in one
# personal mailbox. The compensating control is plural contacts — ADD THE
# COFOUNDER — because one contact is a single point of failure for exactly the
# class of message that arrives with a deadline attached. Revisit the moment
# there is a company domain that somebody actually reads.
# ---------------------------------------------------------------------------

variable "essential_contacts" {
  description = <<-EOT
    Addresses Google notifies about suspensions, security, legal and billing.

    Must be a syntactically valid address on a domain permitted by
    `constraints/essentialcontacts.managed.allowedContactDomains`. On THIS org
    that constraint reads `enforce: false`, so any domain is accepted —
    including Gmail, which is what the owning account is. Attempt 1's org
    enforced `@vetratd.com` and that mailbox is suspended; see the header.

    ⚠ ADD THE COFOUNDER, AND TREAT THIS AS REQUIRED RATHER THAN OPTIONAL. One
    contact is a single point of failure for exactly the class of message that
    arrives with a deadline attached — and an empty list is how attempt 1 never
    saw the notices that preceded its suspension.
  EOT
  type = map(object({
    categories = optional(list(string), ["ALL"])
    language   = optional(string, "en-US")
  }))
  default = {}

  validation {
    # Shape only, not domain. `[.]` rather than `\.` — a backslash escape inside
    # an HCL quoted string is parsed by HCL FIRST ("The symbol . is not a valid
    # escape sequence selector") and never reaches the regex engine. Same family
    # as the `$$` escape that already cost an apply; a character class sidesteps
    # the question entirely.
    condition     = alltrue([for e in keys(var.essential_contacts) : can(regex("^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$", e))])
    error_message = "Every essential contact must be an email address. The domain is no longer constrained — see the header — but a malformed address is accepted by the API and then silently never notified."
  }

  validation {
    condition     = length(keys(var.essential_contacts)) != 1
    error_message = "Set either zero essential contacts (and know that Google's suspension, billing and security notices reach nobody) or at least TWO. Exactly one is the shape that already failed: attempt 1 had a single contact on a mailbox nobody read, and the notices preceding a suspension went unseen."
  }
}

resource "google_essential_contacts_contact" "org" {
  for_each = var.essential_contacts

  parent                              = "organizations/${var.org_id}"
  email                               = each.key
  language_tag                        = each.value.language
  notification_category_subscriptions = each.value.categories
}
