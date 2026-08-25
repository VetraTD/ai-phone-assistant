# ---------------------------------------------------------------------------
# Billing budgets. THE PRECONDITION FOR EVERYTHING THAT COSTS MONEY.
#
# The ledger states it plainly and it had not been done: "Set a billing budget
# alert on 01C71E-7C0893-377AE9 before Lane B provisions anything. Free, two
# minutes, and it is the only thing that reports a min-instances=1 nobody meant
# to create while it quietly burns the credit. Sessions are being run
# unattended; this is the guardrail for that."
#
# Everything applied so far has been free, so nothing was at risk. B2 is the
# first thing with a meter, which makes this the last honest moment to add it.
#
# In Terraform rather than clicked into the console, for the same reason as the
# org-level IAM grant: a threshold somebody set once in a browser is a number
# nobody can review, and nobody remembers whether it was 50% or 90%.
#
# ---------------------------------------------------------------------------
# Two budgets, because there are two different ways this goes wrong
# ---------------------------------------------------------------------------
#
#   RUNAWAY   a resource nobody meant to create, billing quietly, forever.
#             Caught by a MONTHLY budget: the month it appears, spend jumps.
#
#   RUNWAY    nothing wrong at all, and the trial credit simply runs out. A
#             monthly budget never fires on this — $180/month against a $250
#             threshold is silent right up until the projects SUSPEND.
#             Caught by a budget over the credit's own custom period.
#
# A monthly budget alone would have missed the second one entirely, and the
# second one is the one with a date attached.
#
# ---------------------------------------------------------------------------
# Who gets the mail
# ---------------------------------------------------------------------------
#
# ORIGINALLY: no `all_updates_rule` and no notification channel, on the grounds
# that Cloud Billing already emails the billing account's Administrators and
# Users, that this needs nothing to exist first, and that it cannot silently
# break because somebody deleted a channel in another project.
#
# EVERY CLAUSE OF THAT WAS TRUE AND THE CONCLUSION WAS STILL WRONG, corrected
# 2026-08-25. The billing account has exactly one principal —
# `admin@vetratd.com` — and that is a mailbox the owner cannot read, because
# vetratd.com mail runs on Microsoft 365 and nobody opens that box. So the
# alarm has been firing into a void: not broken, just unheard, which is the
# worse failure because nothing reports it.
#
# It cannot be fixed by adding a person to the billing account either. Both
# routes are closed, and each closure is a control working:
#
#   nithin.dodla@vetratd.com  `INVALID_ARGUMENT: User ... does not exist` —
#                             a valid M365 mailbox is not a Google account, and
#                             IAM needs the latter.
#   nithinjd06@gmail.com      `constraints/iam.allowedPolicyMemberDomains` —
#                             Domain Restricted Sharing refusing to let a
#                             consumer account hold billing admin on this org.
#                             Relaxing that at the org node to receive an email
#                             would be a bad trade.
#
# A Monitoring notification channel needs no Google account and no org-policy
# exception: it emails an address. `nithin.dodla@vetratd.com` is the address to
# use because it is PROVEN — Google's suspension-lifted notice arrived there,
# which is delivery rather than configuration.
#
# `disable_default_iam_recipients` stays false, so the billing admins keep
# getting it too. This adds a recipient rather than replacing one.
#
# The original objection still stands and is answered rather than dismissed: a
# deleted channel would break this silently. The channel is Terraform-managed,
# so deleting it shows up as drift on the next plan — which is the same answer
# this config uses everywhere else.
# ---------------------------------------------------------------------------

variable "budget_alert_emails" {
  description = <<-EOT
    Addresses that receive budget alerts, IN ADDITION to the billing account's
    own administrators.

    These become Monitoring notification channels, which is the only route that
    works here: an IAM grant needs a Google account, and the addresses that
    matter are Microsoft 365 mailboxes with no Cloud Identity behind them.

    USE AN ADDRESS SOMEBODY HAS DEMONSTRABLY RECEIVED MAIL AT. The reason this
    variable exists is that the previous arrangement mailed a real, correctly
    configured address that nobody opens, and there is no difference between
    that and no alarm at all.
  EOT
  type        = list(string)
  default     = []
}

variable "budget_monthly_amount" {
  description = <<-EOT
    Monthly budget ceiling, USD. Alerts fire at the thresholds below; nothing is
    ever capped or shut off — a budget in GCP is an alarm, not a limit.

    250 against a rebuilt-from-scratch steady state of ~$145-245/month with the
    UK stack empty. Set high enough that ordinary months are quiet, low enough
    that one unintended always-on resource is visible inside a month.
  EOT
  type        = number
  default     = 250
}

variable "budget_trial_credit_amount" {
  description = "The free-trial credit, USD. The second budget measures cumulative spend against this."
  type        = number
  default     = 300
}

variable "budget_trial_period" {
  description = <<-EOT
    The free trial's own window. $300 over 90 days from 2026-08-20, so it
    expires around 2026-11-18.

    This is the hard date the ledger says nobody had written down: WHEN THE
    TRIAL ENDS, PROJECTS ARE SUSPENDED unless full billing is active. Not a
    quota nuisance — the thing standing between a date and a suspended
    production stack. A budget cannot prevent that, but it can stop the date
    arriving unannounced.
  EOT
  type = object({
    start = object({ year = number, month = number, day = number })
    end   = object({ year = number, month = number, day = number })
  })
  default = {
    start = { year = 2026, month = 8, day = 20 }
    end   = { year = 2026, month = 11, day = 18 }
  }
}

variable "budget_thresholds" {
  description = <<-EOT
    Fractions of the budget at which an alert fires.

    0.5 and 0.75 are early warnings. 0.9 is the one that matters — it is the
    last point at which there is time to do something before either the month's
    ceiling or the credit is gone. 1.0 fires after the fact and exists so the
    record shows it happened.
  EOT
  type        = list(number)
  default     = [0.5, 0.75, 0.9, 1.0]
}

# ---------------------------------------------------------------------------
# 1. The runaway alarm. Resets every month.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Notification channels. One per address, in the shared project because that is
# where the billing and org-level plumbing already lives.
# ---------------------------------------------------------------------------
resource "google_monitoring_notification_channel" "budget" {
  for_each = toset(var.budget_alert_emails)

  project      = local.project_id_for_stack["shared"]
  display_name = "Budget alerts — ${each.value}"
  type         = "email"

  labels = {
    email_address = each.value
  }

  # A channel that exists and is disabled is the same void this change exists
  # to close, so it is pinned on rather than left to a console toggle.
  enabled = true
}

resource "google_billing_budget" "monthly" {
  billing_account = var.billing_account
  display_name    = "Vetra — monthly spend"

  budget_filter {
    calendar_period = "MONTH"

    # Deliberately unfiltered by project. The failure this catches is a
    # resource in a project nobody was watching, so scoping it to the projects
    # somebody remembered to list would defeat it.
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_monthly_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.budget_thresholds
    content {
      threshold_percent = threshold_rules.value
      # CURRENT_SPEND, not FORECASTED_SPEND. A forecast on a workload with three
      # weeks of history and no traffic is noise, and an alarm that cries wolf
      # in month one is an alarm that is filtered to a folder by month two.
      spend_basis = "CURRENT_SPEND"
    }
  }

  depends_on = [google_project_service.this]

  # Adds the channels ALONGSIDE the billing account's own admins —
  # disable_default_iam_recipients stays false on purpose.
  dynamic "all_updates_rule" {
    for_each = length(var.budget_alert_emails) > 0 ? [1] : []
    content {
      monitoring_notification_channels = [for c in google_monitoring_notification_channel.budget : c.id]
      disable_default_iam_recipients   = false
    }
  }
}

# ---------------------------------------------------------------------------
# 2. The runway alarm. Does not reset — it measures the whole trial.
#
# INCLUDE_ALL_CREDITS on a budget that is ABOUT the credit looks wrong and is
# not: it makes this budget track NET spend, which is what actually consumes the
# grant. Gross spend would fire while the credit was still comfortably covering
# it, which is the same false alarm as a forecast.
# ---------------------------------------------------------------------------
resource "google_billing_budget" "trial_credit" {
  billing_account = var.billing_account
  # No dollar sign, and no interpolation of the amount. `$$` is HCL's escape for
  # a literal `$`, so "$${var.x}" renders the LITERAL text ${var.x} rather than
  # the number — which is how this first went out as a 76-character name against
  # a 60-character API limit. The amount is a field on the budget already.
  display_name = "Vetra — free trial credit, ends 2026-11-18"

  budget_filter {
    credit_types_treatment = "INCLUDE_ALL_CREDITS"

    custom_period {
      start_date {
        year  = var.budget_trial_period.start.year
        month = var.budget_trial_period.start.month
        day   = var.budget_trial_period.start.day
      }
      end_date {
        year  = var.budget_trial_period.end.year
        month = var.budget_trial_period.end.month
        day   = var.budget_trial_period.end.day
      }
    }
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_trial_credit_amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.budget_thresholds
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  depends_on = [google_project_service.this]

  # Adds the channels ALONGSIDE the billing account's own admins —
  # disable_default_iam_recipients stays false on purpose.
  dynamic "all_updates_rule" {
    for_each = length(var.budget_alert_emails) > 0 ? [1] : []
    content {
      monitoring_notification_channels = [for c in google_monitoring_notification_channel.budget : c.id]
      disable_default_iam_recipients   = false
    }
  }
}
