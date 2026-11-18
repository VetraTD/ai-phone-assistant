# Incident response and breach notification

**Status: DRAFT for owner adoption. Not legal advice.** Ledger item **O26**.
Every statutory deadline below must be confirmed by counsel (**O18** for US /
Texas, **O11** for UK) before this is adopted. Where a number is contested or
recently amended, it is marked.

**Adopted:** *(date, signature)* · **Reviewed:** *(annually, and after any
incident)*

---

## Why this document exists, and what it corrects

The compliance paperwork list carried a *"72-hour ICO breach runbook"*. That is
the **UK/GDPR** clock, and it is the only one that was written down. There are
**three clocks running on one incident**, they start at different moments, they
are owed to different people, and the shortest of them is not the 72 hours:

| # | Regime | Who VetraTD must tell | Deadline | Clock starts at |
|---|---|---|---|---|
| 1 | **HIPAA** §164.410 (business associate) | **the covered entity** (Excel Cardiac Care PLLC) | **without unreasonable delay, and no later than 60 calendar days** | **discovery** — the first day any workforce member knew or, exercising reasonable diligence, would have known |
| 2 | **Texas** Bus. & Com. Code §521.053 | **the data owner** (the clinic) — see the note below | **as soon as practicable** after discovery; if VetraTD ever owns the data, ≤60 days to individuals and ≤**30 days** to the Texas AG at 250+ Texas residents | **determination that a breach occurred** |
| 3 | **UK GDPR** Art. 33(2) (processor) | **the controller** (whoever the UK lane's customer is) | **without undue delay** — and the controller then has **72 hours** to the ICO, so in practice this is *hours, not days* | **becoming aware** |

**The 60-day HIPAA figure is a ceiling, not a target, and treating it as a
target is the mistake this table exists to prevent.** Clock 3 is effectively the
tightest: our own deadline is "without undue delay", and every hour we take is
an hour taken out of the controller's 72. **Assume the operative deadline for
any incident is 24 hours, and use the statutory numbers only to know what has
already gone wrong.**

### The Texas nuance that changes who we notify

Texas §521.053(c) distinguishes the **owner** of the data from a person who
merely **maintains** it. VetraTD maintains PHI on the clinic's behalf; it does
not own it. On that reading VetraTD's Texas duty is to **notify the clinic**,
and the clinic carries the duty to individuals and to the Attorney General. That
matches the HIPAA business-associate posture and means clocks 1 and 2 point at
the same recipient.

> **COUNSEL MUST CONFIRM (O18):** (a) that VetraTD is a "maintains, does not
> own" party under §521.053(c) for this data; (b) the current AG-notification
> trigger and deadline — this was amended in 2023 and the figure used above is
> **30 days at 250+ Texas residents**; (c) whether **HB 300** (Health & Safety
> Code ch. 181) adds anything beyond §521.053 for a business associate; and
> (d) whether the BAA with the clinic sets a **shorter** contractual deadline
> than 60 days, which it commonly does and which would then govern.

---

## Step 0 — what counts as an incident

Report **anything on this list**, immediately, without deciding first whether it
is a breach. Deciding is step 2 and it is not the reporter's job.

- Any access to PHI by a person or process that should not have had it.
- A lost or stolen device holding credentials to any VetraTD system.
- A credential appearing anywhere it should not — a commit, a log, a screenshot,
  a support ticket, a chat message.
- A caller reporting they received someone else's information, or a clinic
  reporting a patient did.
- A text message sent to the wrong number, or containing more than the template
  should carry.
- A suspected cross-tenant leak: any evidence that one clinic saw another's
  data.
- A Google Cloud **project suspension**, security notice, or Essential Contacts
  message.
- Anything a reasonable person would want to have been told about.

**Under-reporting is the failure mode.** A report that turns out to be nothing
costs an hour. An unreported incident that turns out to be something starts its
60-day clock on the day it *should* have been discovered, not the day it
eventually was — so silence does not stop the clock, it only removes the time.

---

## Step 1 — the first hour

Do these in order, and write the time next to each one as you go.

1. **Write down the time you became aware, and how.** This timestamp is the
   start of every clock in the table above and it will be asked for. Record it
   before doing anything else, because reconstructing it later is guesswork.
2. **Stop the bleeding, but do not destroy evidence.** Revoking access, taking
   a service down, or rotating a credential is correct. Deleting logs, deleting
   rows, or force-pushing over history is not — see "What must not be done".
3. **Open an incident record** from the template at the end of this document.
4. **Tell the other founder.** Both founders, always, regardless of who is on
   call. A single-person incident response has a single point of failure and
   the person handling it is the person who cannot also be checking their own
   reasoning.

---

## Step 2 — scope it, from the audit trail rather than from memory

The system was built so that this step has an answer. Use it.

**The PHI-access trail (§164.312(b)).** `phi_access_log` records one row per
unit of work that touched PHI: who (`actor_type` / `actor_id`, where a voice
actor is the Twilio call SID), what (`action`, `operations`, `resources`),
which records (`resource_ids`), and when. It carries **identifiers, never PHI**,
so it can be read and shared far more freely than the data it describes.

```sql
-- Everything one tenant's data saw, most recent first.
SELECT * FROM phi_access_log WHERE business_id = '<uuid>' ORDER BY occurred_at DESC;

-- Who touched THIS record. This is the question a breach makes you ask.
SELECT * FROM phi_access_log WHERE resource_ids @> ARRAY['<row uuid>']::uuid[];
```

Reading it requires a tenant scope like any other table — see
`docs/superpowers/plans/gcp-migration-ledger.md`, "Reading the database by
hand". **An empty result from an unscoped query is not evidence of anything.**

**The durable copy.** Every unit of work also emits a `phi_access` line to
stdout, which the org-node sinks export to buckets in `vetra-shared`
(`vetra-audit-us`, `vetra-audit-eu`) under **different IAM from the project that
produced it**. That is the copy to trust if the integrity of a project is in
question: a compromised runtime can stop writing to the trail and cannot erase
what it already wrote. It survives even a project suspension — that property was
not theoretical, it produced the evidence for the August 2026 appeal.

```
gcloud logging read 'resource.labels.project_id="<project>" AND jsonPayload.event="phi_access"' \
  --project=vetra-shared-c3a3bd --bucket=vetra-audit-us --location=us-central1 --view=_AllLogs
```

**The admin trail.** Cloud Audit Logs for the same projects, in the same
buckets, answer "which principal did what to the infrastructure". The specific
question worth asking early is whether any **service account key** was ever
created — the org enforces `iam.disableServiceAccountKeyCreation` **and**
`iam.disableServiceAccountKeyUpload`, so the expected answer is zero, and a
non-zero answer is itself the incident.

**What to establish, in this order:**

1. **Which tenants.** Isolation is enforced by row-level security, so
   cross-tenant exposure is a specific, checkable claim rather than an
   assumption.
2. **Which individuals**, by row id, from `resource_ids`.
3. **Which data elements** — a name and an appointment time is a different
   notification from a transcript.
4. **Whether it left the system**, and to whom.
5. **Whether it was encrypted**, and if so whether the key was also exposed.

---

## Step 3 — the risk assessment that decides whether it is a breach

Under §164.402 an impermissible use or disclosure of unsecured PHI is
**presumed to be a breach** unless a documented risk assessment shows a **low
probability that the PHI has been compromised**, on at least these four factors:

1. the nature and extent of the PHI, including identifiers and likelihood of
   re-identification;
2. the unauthorised person who used it or to whom it was disclosed;
3. whether the PHI was actually acquired or viewed;
4. the extent to which the risk has been mitigated.

**Write the assessment down whether or not it concludes "breach".** The
documented negative is what makes a decision not to notify defensible, and an
undocumented one is indistinguishable from not having thought about it.

The two safe harbours worth knowing: PHI that was **encrypted to HHS-recognised
standards** (with the key not also exposed) is not "unsecured PHI", and PHI
**destroyed** to those standards is out of scope.

---

## Step 4 — notify

**To the clinic (clocks 1 and 2).** In writing, addressed to the contact named
in the BAA, containing: what happened, when it happened and when it was
discovered, which individuals and which data elements, what has been done, and
what VetraTD will do next. Send the first notice as soon as there is something
true to say — a second notice with more detail is normal and expected, and it is
better than a first notice sent late because it was being polished.

**To the UK controller (clock 3).** Immediately on becoming aware, even with an
incomplete picture, because their 72 hours to the ICO is running and it is not
ours to spend.

**To Google.** If the incident involves the platform, through the support
channel on the billing account, and note that Essential Contacts must be
reachable — see the ledger's standing item on `admin@vetratd.com`.

**To Twilio.** If the incident involves call audio, SMS delivery, or recordings.

**Deliberately NOT ours to do:** notify individuals, HHS, the Texas Attorney
General, or the media. Those are the covered entity's duties. Offering to help
draft them is good practice; doing them unilaterally is not.

---

## What must not be done

- **Do not delete or edit the audit trail.** `phi_access_log` has no UPDATE and
  no DELETE policy and the application role holds neither privilege — that is
  deliberate, it is a control, and anyone routing around it during an incident
  has converted a breach into a much worse problem.
- **Do not erase the affected rows to "contain" it.** Destroying records during
  an investigation is spoliation. The Art. 17 erasure endpoint exists for data
  subject requests, not for incident cleanup.
- **Do not rebuild a suspended or compromised project under a new project id.**
  It reads as evasion and escalates.
- **Do not put PHI in the incident record, the ticket, or any chat.** Row ids
  and counts, never names, numbers or transcript text. The audit trail was
  designed to hold identifiers precisely so the investigation can be conducted
  without making a second copy of the data.
- **Do not push to a public repository anything describing an unfixed
  vulnerability.**

---

## Incident record template

Keep one file per incident. Six-year retention (§164.316(b)(2)).

```
INCIDENT <yyyy-mm-dd>-<n>

DISCOVERED       <ISO timestamp>   <-- clock start for all three regimes
DISCOVERED BY    <person> via <how>
REPORTED TO      <the other founder>, <ISO timestamp>

WHAT HAPPENED
SYSTEMS INVOLVED
TENANTS INVOLVED         <business_id list>
INDIVIDUALS INVOLVED     <count, and row ids — NEVER names>
DATA ELEMENTS
LEFT THE SYSTEM?         yes / no / unknown, and to whom
ENCRYPTED?               yes / no; was the key also exposed?

CONTAINMENT              <what, when>
EVIDENCE PRESERVED       <queries run, exports taken, where stored>

RISK ASSESSMENT (164.402)
  1 nature and extent of PHI
  2 who received it
  3 was it actually acquired or viewed
  4 mitigation
  CONCLUSION   breach / not a breach, and why

NOTIFICATIONS
  clinic (HIPAA 164.410, Texas 521.053)   sent <ts> by <who>, to <whom>
  UK controller (UK GDPR 33(2))           sent <ts> / n/a
  Google / Twilio                          sent <ts> / n/a

ROOT CAUSE
CORRECTIVE ACTIONS       <what changed, with commit or ticket>
CLOSED                   <ts>, by <who>
```

---

## Open items before this can be adopted

1. **Counsel (O18)** confirms the Texas questions listed above, and whether the
   clinic BAA imposes a shorter contractual notification deadline than 60 days.
2. **Counsel (O11)** confirms the UK processor position, and who the controller
   is for the UK lane.
3. **A reachable notification address.** Google's notices go to Essential
   Contacts and to the billing account's principal. The ledger records that this
   already failed once and that it cost the warnings which preceded a project
   suspension.
4. **A second Essential Contact.** One contact is a single point of failure for
   the one class of message that carries a deadline.
5. **This document has never been exercised.** Adopt it, then run a tabletop
   against one scenario — "an SMS confirmation went to the wrong number" is the
   cheapest realistic one and touches all three clocks.
