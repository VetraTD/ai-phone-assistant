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
# ONLY `@vetratd.com` ADDRESSES ARE ACCEPTABLE, and that is not our rule:
# `constraints/essentialcontacts.managed.allowedContactDomains` is one of
# Google's secure-by-default managed constraints, applied to this org at
# creation with `allowedDomains = ['@vetratd.com']`. A personal address is
# refused with "Operation denied by org policy", which reads as a Console bug
# and is a policy working. Deliberately NOT relaxed: org security and legal
# notices for an organization handling PHI should not standingly land in a
# personal mailbox, and a company address is the one that survives somebody
# leaving. Forward it from M365 if you want it on a phone.
# ---------------------------------------------------------------------------

variable "essential_contacts" {
  description = <<-EOT
    Addresses Google notifies about suspensions, security, legal and billing.

    MUST be on a domain permitted by
    `constraints/essentialcontacts.managed.allowedContactDomains` — `@vetratd.com`
    today. Anything else is refused by org policy at apply time.

    Add the cofounder here. One contact is a single point of failure for exactly
    the class of message that has a deadline attached.
  EOT
  type = map(object({
    categories = optional(list(string), ["ALL"])
    language   = optional(string, "en-US")
  }))
  default = {}

  validation {
    # `[.]` rather than `\.` — a backslash escape inside an HCL quoted string is
    # parsed by HCL first ("The symbol . is not a valid escape sequence selector")
    # and never reaches the regex engine. Same family as the `$$` escape that
    # already cost an apply; a character class sidesteps the question.
    condition     = alltrue([for e in keys(var.essential_contacts) : can(regex("@vetratd[.]com$", e))])
    error_message = "Essential contacts must be @vetratd.com addresses — the org policy refuses anything else."
  }
}

resource "google_essential_contacts_contact" "org" {
  for_each = var.essential_contacts

  parent                              = "organizations/${var.org_id}"
  email                               = each.key
  language_tag                        = each.value.language
  notification_category_subscriptions = each.value.categories
}
