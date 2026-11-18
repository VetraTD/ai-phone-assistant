# Access authorisation, establishment, modification and termination

**Status: DRAFT for owner adoption. Not legal advice.** Ledger item **O21**,
covering §164.308(a)(3)(ii)(B) *Workforce clearance*, §164.308(a)(3)(ii)(C)
*Termination procedures*, §164.308(a)(4)(ii)(B) *Access authorization* and
§164.308(a)(4)(ii)(C) *Access establishment and modification*.

**Adopted:** *(date, signature)* · **Reviewed:** *(annually, and on any change
of workforce)*

---

## Scope, and why this only recently became meaningful

VetraTD has **two founders**. Until that was written down, "access control" was
one person's habits, and a procedure for granting and revoking access to
yourself is not a procedure. Two people is the smallest number at which
§164.308(a)(3) has any content, and it is also the number at which the *absence*
of a procedure starts to matter: there is now somebody who could be granted
access, and somebody whose access would have to be removed.

**"Workforce" here means anyone who can reach a system holding PHI, or the
credentials to one, whether or not they are paid.** Today that is the two
founders. It would also cover a contractor, a bookkeeper with console access, or
anyone given a dashboard login.

---

## What there is to have access to

Listed explicitly, because a termination procedure is only as complete as the
list it works from. **Anything not on this list has not been thought about.**

| System | Holds PHI? | How access is granted | How it is revoked |
|---|---|---|---|
| **Google Cloud org `vetratd.com`** (`564252011558`) | Yes — via the projects below | A `@vetratd.com` Cloud Identity account + IAM role binding | Suspend the Cloud Identity account, **then** remove IAM bindings |
| `vetra-us-prod`, `vetra-us-staging` | **Yes** — Cloud SQL holds calls, transcripts, appointments, requests, SMS consents | IAM on the project | IAM removal |
| `vetra-uk-prod` | Personal data under UK GDPR | IAM on the project | IAM removal |
| `vetra-shared` | **The audit trail** and Identity Platform | IAM on the project | IAM removal |
| **Twilio** (US account, UK account) | **Yes** — call metadata, voicemail recordings, SMS bodies | Console user invite | Remove the user; rotate the auth token if they held it |
| **The dashboard** (`AI-phone-dashboard`) | **Yes** — a staff login sees its own tenant's data | An Identity Platform account plus a `users` row attached to a business | Delete the Identity Platform account **and** the `users` row |
| **The GitHub repo** `VetraTD/ai-phone-assistant` | No PHI, but it is the deployment path | Repo collaborator | Remove collaborator |
| **The workstation ADC** (`~/.gcloud-vetratd`) | It is a live credential to all of the above | `gcloud auth application-default login` | `gcloud auth application-default revoke`, and the org's reauth window closes it anyway |
| **Secret Manager** (per project) | Database passwords, Twilio tokens | IAM on the secret | IAM removal **and** rotate what they could read |

> **The dashboard is the row most likely to be forgotten**, because it is the
> only one that is not Google IAM and the only one where "the account still
> exists" and "the account still reaches a tenant" are different facts.
> Migration 036 keys the tenant lookup on `auth_uid`, so **deleting the
> Identity Platform account is what actually severs it** — deleting only the
> `users` row leaves an account that can sign in and onboard fresh, and
> deleting only the account leaves a `users` row that a new account with the
> same email can no longer claim (which is the point of 036, and is why the
> order matters less than doing both).

---

## Authorisation — who may be granted what

**The principle is least privilege by job, not by seniority.** The six-project
split exists partly so that this is expressible: a person working on the website
never needs reach into `vetra-us-prod`, and the org's structure makes that a
configuration rather than a promise.

**Standing decision (2026-08-20, recorded in the ledger as O20):** *the
cofounder does not access Google Cloud.* That decision is doing real work —
while it holds, there is exactly one principal with production access and the
audit trail is unambiguously attributable.

**It becomes void the moment the cofounder needs any GCP access**, and at that
moment two things are required together:

1. **Their own `@vetratd.com` Cloud Identity account.** Free, two minutes.
2. **Never sharing `admin@vetratd.com`.** A shared account makes every audit
   log entry unattributable, which fails §164.312(a)(2)(i) *unique user
   identification* and §164.312(b) *audit controls* at the same time — one
   shortcut, two requirements.

### Grant procedure

1. **Write down the job**, in one sentence, before choosing a role. "Deploys the
   voice service" is a job; "needs admin" is not.
2. **Choose the narrowest predefined role that does the job**, or a custom role
   if none fits. Precedent worth following: the runtime's Speech access is a
   **custom role holding one permission**, because the obvious predefined role
   (`roles/speech.admin`) would have let the process disable the very control
   its boot check enforces — *a control the controlled party can switch off is
   not a control.*
3. **Grant at the narrowest scope** — the project, not the org; the secret, not
   the project.
4. **Record it** in the access register below: who, what, why, when, granted by.
5. **Prefer Terraform.** An IAM binding in `infra/terraform` is reviewable,
   diffable and removable by the same mechanism. A console click is invisible
   the day after it is made.

### Modification

Treat a change of job as **revoke then grant**, not as an addition. Access
accretes otherwise, and the accreted state is the one nobody can justify at
audit because nobody chose it.

---

## Termination — the procedure

**Target: all production access removed within one business day of the
decision, before the person is told where that is possible.** For a
for-cause departure, before.

Run every row of the table above, in this order. Tick each one; a
half-completed termination is the failure mode this exists to prevent.

1. **Suspend the Cloud Identity account first.** It is one action that cuts
   console, gcloud and ADC together, and it is reversible if the departure
   turns out not to be happening.
2. **Remove IAM bindings** on the org and each project. Suspension stops sign-in
   but leaves the bindings; leaving them is how a reactivated account silently
   regains everything.
3. **Delete their Identity Platform account and their `users` row.**
4. **Remove them from Twilio**, both accounts.
5. **Remove them from GitHub.**
6. **Rotate every secret they could read** — database passwords, Twilio auth
   tokens, any API key. Read access to a secret does not expire when the
   account does, because they may already have the value. **This step is the
   one most often skipped and the only one that closes what they already
   know.**
7. **Revoke ADC on any workstation they used**, and treat any device they keep
   as still holding whatever was cached.
8. **Read the audit trail for the last 90 days** for that principal:

   ```sql
   SELECT * FROM phi_access_log WHERE actor_id = '<users.id>' ORDER BY occurred_at DESC;
   ```

   plus Cloud Audit Logs in the `vetra-shared` buckets for infrastructure
   actions. Not because departures are presumed hostile, but because "we
   checked" is a sentence you can only say if you checked, and after the fact
   is too late to start.
9. **Record the termination** in the register, with the date each step
   completed.

### What cannot currently be revoked, stated honestly

**A session already issued outlives the revocation, for up to the token
ceiling.** `SESSION_MAX_AGE_MINUTES` (default 30) bounds a single access token,
and the client logs out after 15 minutes idle — but the refresh chain mints
fresh tokens and cannot be aged from a request. Suspending the Identity Platform
account stops the *next* refresh, so the practical exposure is bounded by the
current token's life rather than being unbounded; it is not zero. This is the
same limitation recorded as **O31**, and closing it needs a session store or
Firebase session cookies. **Do not describe termination as instantaneous to an
auditor.**

---

## Access register

Kept as the evidence for §164.308(a)(3) and (a)(4). Six-year retention.

```
PERSON            <name>, <@vetratd.com account>, <users.id if any>
ROLE / JOB        <one sentence>
GRANTED
  system          <from the table above>
  what            <exact IAM role / collaborator level / tenant>
  why             <the job sentence it serves>
  when            <date>   by <who>   where <terraform file / console>
MODIFIED
  <date>          <from> -> <to>, why, by whom
TERMINATED
  decided         <date>
  step 1 identity suspended        <date/time>
  step 2 IAM bindings removed      <date/time>   <list>
  step 3 dashboard account + row   <date/time>
  step 4 Twilio (US, UK)           <date/time>
  step 5 GitHub                    <date/time>
  step 6 secrets rotated           <date/time>   <list>
  step 7 ADC revoked               <date/time>
  step 8 audit trail reviewed      <date/time>   findings:
  completed by                     <who>
```

---

## Review

- **Annually**, and on any change of workforce: re-read the register against
  live IAM and confirm every standing grant still matches a current job.
- **On every new system**: add a row to the systems table *before* anyone is
  granted access to it. The table is the termination checklist, so a system
  missing from it is a system nobody will remember to revoke.

## Open items before this can be adopted

1. **Counsel (O18)** confirms nothing in Texas HB 300 adds to §164.308(a)(3).
2. **No termination has ever been run.** The procedure is untested; the cheapest
   test is to walk it on paper against the cofounder's current access and see
   which rows have no answer.
3. **O31** — the session-revocation gap above is real and currently unfixable
   without a design decision the owner has not made.
