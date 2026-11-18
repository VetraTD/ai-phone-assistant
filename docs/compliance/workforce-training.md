# Security awareness and workforce training

**Status: DRAFT for owner adoption. Not legal advice.** Ledger item **O22**,
covering §164.308(a)(5) *Security awareness and training* and **Texas HB 300**
(Health & Safety Code §181.101).

**Adopted:** *(date, signature)* · **Next due:** *(see the schedule)*

---

## Two requirements, two different schedules

| | HIPAA §164.308(a)(5) | Texas HB 300 §181.101 |
|---|---|---|
| Who | every workforce member | every employee **who handles PHI** |
| When first | "as necessary and appropriate" — no fixed deadline | **within 90 days of hire** |
| Then | periodic security reminders (addressable) | **at least every two years** |
| Content | awareness: malicious software, log-in monitoring, password management | **specific to the employee's job duties** and to state and federal law |
| Evidence | documentation retained six years (§164.316(b)(2)) | **a signed attestation** of completion, retained |

**Texas is the binding one.** It sets a hard 90-day deadline, a hard two-year
cycle, and requires the content to be **job-specific** — which is the
requirement that makes one shared slide deck insufficient for two people doing
different work.

> **COUNSEL MUST CONFIRM (O18):** (a) whether §181.101 reaches a **founder** of a
> business associate rather than only an "employee"; (b) the exact attestation
> the statute expects; and (c) whether the two-year cycle runs from hire or from
> the last completed training.

---

## Who, and what each of them actually does

**Two people, and their exposure to PHI is not the same shape.** Writing one
curriculum for both would over-train one and under-train the other, and
under-training is the half that fails an audit.

### Owner — builds and operates the systems that hold PHI

Reaches: Google Cloud (all projects), Cloud SQL directly, Secret Manager,
Twilio, the dashboard, the repo, the audit trail. **Can read every clinic's
data**, and is the only person who can.

### Cofounder — works on the website; no Google Cloud access today

Reaches: the repo, the public website. **Standing decision (ledger O20): the
cofounder does not access Google Cloud.** So the exposure today is indirect —
what they might commit, what they might be told, what they might be phished for
— not direct read access to PHI.

**That distinction is the whole design of this curriculum**, and it has a
trigger attached: *the moment the cofounder is granted any GCP access, they
move to the owner's curriculum and must complete it before the access is
granted, not after.*

---

## Common module — both people

Roughly 45 minutes. Re-run every two years.

1. **What PHI is here, and where.** Not an abstraction: a caller's name, phone
   number, appointment time, and the transcript of what they said about their
   own care. It lives in Cloud SQL, in Twilio (call metadata, voicemail
   recordings, SMS bodies) and, transiently, in the model provider under BAA. It
   is deliberately **not** in the application logs.
2. **Business associate, not covered entity.** VetraTD holds the clinic's
   patients' data on the clinic's behalf. Duties run to the clinic; the clinic's
   duties run to the patients. This is why the breach runbook notifies the
   clinic and not individuals.
3. **The three breach clocks, and what to do in the first hour.** Read
   `incident-response-and-breach-notification.md`. The single most important
   behaviour: **report immediately and let someone else decide whether it is a
   breach.** The clock starts when it *should* have been discovered.
4. **Credential handling.** Passwords in a manager, unique per service, MFA
   everywhere it is offered. A credential in a commit, a screenshot, a chat
   message or a support ticket is an incident — including one in a repository
   that is currently **public**.
5. **Phishing and social engineering, aimed at this business specifically.** The
   realistic attack is not generic: it is somebody claiming to be the clinic,
   or Twilio support, or Google, asking for a number to be repointed or an
   account to be reset. **Nobody legitimate asks for a credential.** Verify out
   of band, on a number you already had.
6. **Malicious software and device hygiene** (§164.308(a)(5)(ii)(B)): updates
   on, disk encryption on, screen lock on, no work credentials on a shared
   machine.
7. **Log-in monitoring** (§164.308(a)(5)(ii)(C)): what an unexpected sign-in
   notification means and that it is reported, not dismissed.
8. **Never put PHI where it does not belong** — a log line, a ticket, a chat, a
   commit message, a test fixture, an AI prompt outside the covered lane.

---

## Owner module — production access

Additional, roughly 60 minutes, on top of the common module.

1. **Tenant isolation is enforced, and how.** Row-level security scopes every
   query to one business. Two consequences that matter operationally: an
   **unscoped read returns zero rows rather than an error**, so "no data" can
   mean "wrong question"; and a **hand-edit in a SQL console under a scope you
   set yourself** is a real access that the trail will record against you.
2. **The audit trail records you.** `phi_access_log` names the actor on every
   unit of work. This is the intended behaviour, it applies to the owner exactly
   as to anyone else, and it is the reason a shared account is forbidden.
3. **Minimum necessary, applied to yourself.** Being able to read a clinic's
   transcripts does not make reading them appropriate. Read what the task needs.
4. **The two-lane split, and what must never cross it.** The US lane is
   BAA-covered and refuses to construct a non-covered vendor client; the UK lane
   is not covered and holds no US PHI. A credential in the wrong project is a
   compliance failure that the boot check will refuse, and routing around that
   refusal is the mistake.
5. **Secret handling.** Secrets live in Secret Manager. They do not go into
   Terraform state, `.env` files that get committed, or a terminal history that
   is later shared.
6. **Change management on anything touching PHI.** Migrations, RLS policies,
   the audit trail, the consent gate. The repository's own history is the case
   study: several defects were invisible locally and only appeared under real
   row-level security.
7. **Data subject rights.** What export and erasure do, what erasure
   deliberately keeps, and that erasure reaches Twilio for recordings.
8. **The SMS consent gate.** No caller-facing text goes out without a recorded
   yes. Do not switch it off, and do not hand-insert consent rows.

---

## Cofounder module — website and repository

Additional, roughly 20 minutes, on top of the common module.

1. **You do not have production access, and that is a control, not an
   oversight.** If a task seems to need it, that is a conversation, not a
   workaround. Sharing the owner's login is the specific thing that must not
   happen.
2. **The repository is public today.** Anything committed is published:
   credentials, customer names, a description of an unfixed vulnerability.
3. **The website must not collect PHI.** A contact form asking "what is this
   regarding?" invites a symptom, and that lands the website in scope. Keep
   forms to name, contact details and a non-clinical reason.
4. **Analytics and third-party scripts** on any page a patient might reach are a
   disclosure question, not just a performance one.
5. **If a clinic or a patient contacts you directly**, hand it to the owner
   rather than answering. Confirming that a named person is a patient is itself
   a disclosure.
6. **Report anything odd.** Someone asking about the infrastructure, an unusual
   email, an unexpected repository invitation.

---

## Schedule

| Person | First training due | Then |
|---|---|---|
| Owner | **on adoption of this document** | every 2 years, and on any material change to how PHI is handled |
| Cofounder | **on adoption**, and in any case within 90 days of being treated as workforce | every 2 years |
| Anyone new | **within 90 days of joining**, and *before* any production access is granted | every 2 years |

**Additional triggers, not on the calendar:** after any incident; when a new
system holding PHI is added; when the cofounder is granted GCP access (they take
the owner module first); and when counsel returns on O18 or O11 with anything
that changes the content.

**Security reminders** (§164.308(a)(5)(ii)(A), addressable): a short written
reminder at least annually, at minimum covering phishing and credential
handling. Recorded in the log below like any other training.

---

## Training record

The evidence, and the thing an auditor actually asks for. Six-year retention
(§164.316(b)(2)).

```
TRAINING RECORD

PERSON             <name>
ROLE               <owner / cofounder / other>
MODULES            common + <owner | cofounder>
DELIVERED          <date>   by <who>   how <self-study / walkthrough / vendor>
MATERIALS          <this document, revision <n>, plus any deck or link>
DURATION           <minutes>

ATTESTATION
  I confirm I have completed the training named above, that I understand my
  obligations in handling protected health information at VetraTD, and that I
  know how and to whom to report a suspected incident.

  Signed <name>                    Date <date>

NEXT DUE           <date + 2 years>
```

---

## Open items before this can be adopted

1. **Counsel (O18)** on the three §181.101 questions above.
2. **Nobody has been trained.** This document is the curriculum, not the record;
   the record starts empty and stays empty until the sessions happen.
3. **The revision number matters.** When this document changes materially,
   bump it and note whether the change requires re-training or waits for the
   two-year cycle.
