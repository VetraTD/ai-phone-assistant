# Data retention and disposal schedule

**Status: DRAFT for owner adoption. Not legal advice.** Feeds the **DPIA** and
GDPR **Art. 5(1)(e)** (storage limitation). Ledger: "Still to draft: … retention
schedule".

**Adopted:** *(date, signature)* · **Reviewed:** *(annually)*

---

## The trap this schedule exists to avoid

**HIPAA's six years is about DOCUMENTATION, not about PHI.**

§164.316(b)(2)(i) requires *Security Rule documentation* — policies, risk
analyses, training records, this file — to be kept six years. It says nothing
about how long a call transcript is kept. HIPAA sets **no** retention period for
PHI at all; that comes from state law and from the covered entity's own policy.

Reading six years into the wrong column produces a system that keeps every
caller's recorded conversation for six years **and calls that compliance**. It
is the opposite: under GDPR Art. 5(1)(e) and the HIPAA Minimum Necessary
standard, keeping PHI longer than needed is itself the violation.

Both Terraform variables that touch retention already carry this warning in
their own descriptions (`cloud_sql_backup_retention_days`,
`audit_log_retention_days`). This file is the same warning at the level of the
data.

> **COUNSEL MUST CONFIRM (O18):** (a) **Texas** medical-record retention as it
> applies to a *business associate* rather than to the practice — the clinic's
> own obligation is not automatically ours; (b) whether appointment records held
> by us are "medical records" at all, given athenahealth is the system of
> record; and (c) the UK/GDPR position once that lane exists.

---

## The schedule

**Proposed. Nothing below is enforced by code today — see "What is not built".**

| Data | Where | Proposed retention | Why |
|---|---|---|---|
| **Call transcripts** | `call_transcripts` | **90 days** | The operational purpose — "what did the caller ask for" — is spent within days. This is the highest-sensitivity, highest-volume class and the shortest clock in the table on purpose. |
| **Call records** (number, time, outcome, summary) | `calls` | **1 year** | Supports billing disputes and "did anyone call us back". Less sensitive than the transcript, so it can outlive it. |
| **Appointments** | `appointments` | **1 year after the appointment** | athenahealth is the clinic's system of record; ours is a booking artefact, not the medical record. |
| **Messages / callback requests** | `customer_requests` | **1 year** | Same reasoning as calls. |
| **SMS consent records** | `sms_consents` | **The later of: consent revoked + 4 years, or the last message sent + 4 years** | **The one deliberately LONG row.** TCPA's statute of limitations is four years, and this table is the entire defence against a $500–$1,500-per-message claim. Deleting it early destroys the evidence, not the liability. |
| **PHI access log** | `phi_access_log` | **6 years** | §164.312(b) audit records are Security Rule documentation. Six years genuinely applies here — and this is the only PHI-adjacent table where it does. |
| **Staff accounts** | `users`, Identity Platform | **Termination + 6 years** for the *record of access*; the credential is revoked **same day** | Two different clocks on one person: access dies immediately, the evidence that they had it does not. See `access-authorisation-and-termination.md`. |
| **Business config** | `businesses`, `business_*` | Life of the contract + 1 year | Not personal data, except the notification address. |
| **Cloud SQL automated backups** | Google-managed | **35 days** prod / 7 staging | Already set in `cost-controls.tf`. **A backup is a copy of PHI**, so this is a retention decision that was made as a cost decision. |
| **Application + audit logs** | Cloud Logging sinks | `var.audit_log_retention_days` | Its own description warns against reading six years into it. |

---

## Erasure on request, and what it actually does today

The Art. 17 / §164.522 path is **built and reachable** (`eraseCallerData`). What
it touches, read from the code rather than assumed:

```
DELETE FROM call_transcripts     the transcript is destroyed outright
DELETE FROM sms_consents         the consent record for that number
UPDATE  calls                    caller-identifying fields cleared, row kept
UPDATE  appointments             same
UPDATE  customer_requests        same
```

**Delete versus redact is a deliberate split, and it is the interesting part of
this document.** The transcript is destroyed because its value is entirely its
content. The `calls` row is *redacted* rather than deleted, because the
appointment it produced, the audit trail that references it, and the clinic's
own operational history all point at it — deleting the row would cascade damage
through records that are not the subject's to erase.

> **NOTE, AND IT CUTS AGAINST THE ROW ABOVE:** erasing `sms_consents` destroys
> the evidence that a caller consented, which is the same evidence the four-year
> TCPA row exists to preserve. A subject asking for erasure is entitled to it;
> the resulting inability to prove consent is a consequence to have *decided*
> rather than discovered. **Counsel question**, and it is a real conflict rather
> than a drafting nit.

**Backups are the honest gap.** Erasure reaches the live database. It does not
reach the automated backups, which continue to hold the erased data for up to 35
days. That is normal, it is what almost every processor does, and it should be
**stated to the data subject** rather than quietly true.

---

## What is not built

The blunt version, so nobody reads this schedule as a description of the system:

- **There is no retention job. Nothing expires today.** Every transcript ever
  recorded is still in the database. A schedule with no enforcement is a policy
  document, and this one currently is exactly that.
- **The 90-day transcript clock is the first thing to build**, because it is the
  largest volume of the most sensitive data and the easiest to justify.
- **A deletion job needs the same care as `scripts/c8-rls-proof.js`:** it runs
  against a private-IP database, so it must be a committed script through the
  migrate job; it must be scoped per tenant under FORCE RLS, where an unscoped
  `DELETE` matches zero rows **and reports success**; and it must log what it
  deleted, because a purge with no record is indistinguishable from a purge that
  never ran.
- **Legal hold is not implemented.** If a claim is anticipated, retention must
  stop — and today that means remembering not to run a job that does not exist
  yet. Build the hold flag *with* the job, not after it.

---

## Review

Annually, and whenever:

- a new table starts holding personal data — **the trigger is the migration, not
  the release**;
- counsel answers any question above;
- the first customer contract sets a retention term that differs from this one,
  at which point **the contract wins and this file changes**.
