# GCP suspension appeal — 2026-08-25

**Suspended projects:** `vetra-uk-prod-c3a3bd`, `vetra-shared-c3a3bd`,
`vetra-us-prod-c3a3bd`, `ultra-glyph-506120-v5`
**Not suspended:** `vetra-us-staging-c3a3bd`
**Billing account:** `01C71E-7C0893-377AE9` — **Active, $0 spend in 30 days**, so
this is not a billing action.
**Console banner:** *"A potential violation of our Acceptable Use Policy has been
detected for multiple projects you own."*
**Email:** *"associated with repeated Terms of Service violations."*

> **File one appeal PER SUSPENDED PROJECT**, signed in as project owner. The
> wording below is written to be pasted into the four boxes Google asks for.
> **Change the project name in the first line of each.**
>
> **In the "Additional email for notifications" field put an address that is
> actually read** — `nithin.dodla@vetratd.com`. The 2026-08-22 suspension of
> `vetra-us-staging` was appealed successfully and **Google's reply went to a
> mailbox nobody could open**, which is why nobody ever learned what was
> detected, and is very plausibly why it has happened again.

---

## 1. Possible trigger of this activity

We operate an **AI phone receptionist** for small healthcare and service
businesses. It **answers inbound telephone calls** placed to numbers our
customers own. Architecture:

- **Twilio** receives the inbound call and POSTs a webhook to a Cloud Run
  service, then opens a **Media Streams WebSocket** carrying the caller's audio.
- **Deepgram** transcribes, **Google Vertex AI (`gemini-3.6-flash`)** generates
  the reply, **ElevenLabs** synthesises speech, all within the live call.
- Structured data (appointments, messages) is written to **Cloud SQL**.

**Our best hypothesis, offered honestly:** this workload's traffic shape —
a newly created project running a **publicly reachable Cloud Run endpoint**
that handles **telephony** and opens **outbound WebSocket connections to voice
AI vendors** — resembles the pattern automated abuse systems look for when
detecting robocall or voice-spam operations. On 2026-08-25 we created
`vetra-uk-prod` and, within a few hours, deployed a public voice service,
created a Cloud SQL instance, and sent a small number of **cryptographically
signed test webhook requests** to it from a developer workstation to verify the
deployment. We believe that burst of activity on a new project is the most
likely trigger.

**The critical distinction we would ask you to check:** *this system does not
place outbound calls.* It has no call-origination path. The only Twilio
call API it uses is `calls(callSid).update()`, which redirects an **already
in-progress inbound call** into a warm transfer to the business's own staff
number. There is no dialler, no campaign logic, no contact list, and no
mechanism to call a number that has not first called us.

**Volume to date:** single-digit test calls. **$0 of billed spend across the
entire billing account in the last 30 days.**

---

## 2. Planned steps to fix the problem

1. **Tell us what was detected and we will remove it.** We are not asking you to
   take our description on trust — we are asking which signal fired, because we
   cannot correct a behaviour we cannot see. **A prior project of ours
   (`vetra-us-staging`) was suspended on 2026-08-22 and reinstated, and we were
   never told the cause. We could not correct it, and it has now recurred.**
2. **Reduce public exposure.** Our design already anticipates this: we have an
   HTTPS Load Balancer + serverless NEG configuration written and gated behind a
   feature flag, which lets the Cloud Run service become IAM-restricted while
   the load balancer terminates public traffic. We will prioritise it.
3. **Restrict who can reach the endpoint.** Our staging service already enforces
   a caller allowlist. We will extend the same control to the new project so
   only known numbers can reach it during pre-launch testing.
4. **Rate limits and alerting** on the public webhook path.
5. If a specific API, region or dependency is implicated, we will stop using it
   pending your guidance.

---

## 3. If the behaviour is intentional, the business reason

**The public endpoint is intentional and unavoidable in the current design, and
it is not unauthenticated.**

Twilio delivers webhooks from its own infrastructure and **cannot present a
Google credential**, so Cloud Run IAM cannot be the gate. What replaces it:

- **Twilio request-signature validation** — every request is verified by HMAC
  over the exact URL and body using the account auth token, and rejected with
  **403 before any handler runs**. We have verified this in both directions:
  a correctly signed request is accepted, and tampered or unsigned requests are
  refused.
- **Caller allowlisting** on pre-production services.
- **No data at the edge** — the service holds nothing itself; the database is
  **private-IP only and unreachable from the internet at any price**.

The business exists to answer the phone for clinics that would otherwise miss
patient calls. An endpoint the telephone network can reach is inherent to that.

---

## 4. If you believe the project may have been compromised

**We have no evidence of compromise, and the account is structured to make it
unlikely:**

- **Zero service account keys have ever been created**, enforced by the
  organization policy `iam.disableServiceAccountKeyCreation`, with
  `iam.disableServiceAccountKeyUpload` also enforced. There is no exportable
  long-lived credential anywhere in the estate.
- **Database access is IAM-based** with short-lived tokens; no database password
  exists for the runtime.
- **Every principal that has ever acted on these projects is ours or Google's
  own** — verified from audit logs during the 2026-08-22 appeal: the owner
  account, the projects' runtime service accounts, Cloud Run's serverless robot,
  and Google's service-agent manager. No unknown principal.
- All infrastructure is defined in Terraform and reviewed; no manual grants.

**We would welcome being told otherwise.** If your systems observed traffic we
cannot see, that is exactly the information we need.

---

## What we cannot supply this time, and why

During the 2026-08-22 appeal we attached audit-log evidence, because our
organization-level log sinks export into buckets held in `vetra-shared` and that
project was healthy. **`vetra-shared` is suspended in this action**, so the
evidence store is behind the same wall as the projects it documents. We can
provide it immediately on reinstatement, or to any address you nominate.

---

## Notes for us, not for Google

- **Do NOT rebuild under new project IDs.** It reads as evasion and escalates.
  Last time the projects returned intact, configuration included.
- **Do not repoint `+441372656055`** to the UK stack. It currently serves from
  Railway and is unaffected; moving it now points a working demo at a suspended
  project.
- **Production is unaffected.** Railway, Supabase and Vercel are untouched;
  Excel Cardiac Care's receptionist is still answering.
- **The suspension is not data loss.** Suspended is not deleted.
- **"Repeated" is load-bearing, again.** Google states prior notices were sent.
  Essential Contacts now resolves to `nithin.dodla@vetratd.com` and is proven to
  deliver — **search that mailbox for any earlier warning**, because a warning
  we received and did not act on is a very different situation from one that
  went to an unreadable address, and it changes what the appeal should say.
