# Sub-processor register

**Status: DRAFT for owner adoption. Not legal advice.** Feeds the **DPIA**, the
**Art. 30 Records of Processing**, and the transparency the clinic BAA will ask
for. Ledger: "Still to draft: … sub-processor register".

**Adopted:** *(date, signature)* · **Reviewed:** *(quarterly — see "Keeping this
true")*

---

## What this is, and the one distinction that decides every row

A **sub-processor** is a third party that processes personal data *on our
behalf*, as part of delivering the service. It is not "every vendor we pay".
The test is whether the data reaches them.

Two categories, and conflating them is how a register becomes wrong:

| | Reaches PHI / personal data | Contract needed |
|---|---|---|
| **Sub-processor** | yes | **BAA** (HIPAA) and/or **Art. 28 DPA** (GDPR) |
| Ordinary supplier | no | ordinary commercial terms |

A monitoring tool that only ever sees a stack trace is still a sub-processor if
that stack trace can carry a caller's number. Which is exactly why this register
is derived from what the code does rather than from an invoice list.

> **COUNSEL MUST CONFIRM (O18):** (a) whether the UK lane's controller/processor
> analysis makes the clinic the controller and us the processor in the shape
> assumed here; (b) whether the Identity Platform residency position below is
> adequately disclosed as an Art. 44+ transfer rather than presented as
> residency; and (c) the notice period this register owes a customer before a
> sub-processor is added or changed.

---

## The covered (US HIPAA) lane

Everything here is inside the **Google Cloud BAA**, which is what the whole
`DEPLOYMENT_MODE=hipaa` boundary exists to keep true.

| Sub-processor | Service | What it processes | Where | Contract |
|---|---|---|---|---|
| **Google Cloud** | Cloud Run | the voice server and dashboard API — every request | `us-central1` | Google Cloud BAA |
| **Google Cloud** | Cloud SQL (PostgreSQL) | **the PHI of record** — calls, transcripts, appointments, messages | `us-central1`, private IP, CMEK | Google Cloud BAA |
| **Google Cloud** | Speech-to-Text v2 | **caller audio**, transcribed | `locations/us` | Google Cloud BAA · CMEK asserted at boot |
| **Google Cloud** | Text-to-Speech | the assistant's replies (not caller data) | `us` | Google Cloud BAA |
| **Google Cloud** | Vertex AI (Gemini) | **the conversation**, turn by turn | `locations/us` multi-region | Google Cloud BAA |
| **Google Cloud** | Identity Platform | **staff** accounts — email, password hash, display name | **no residency control** — see below | Google Cloud BAA |
| **Google Cloud** | Cloud Logging + storage sinks | application and audit logs; PHI is redacted at source | `vetra-shared` buckets | Google Cloud BAA |
| **Google Cloud** | Secret Manager | credentials only — no personal data | `us` | Google Cloud BAA |
| **Google Cloud** | Artifact Registry | container images — no personal data | `us-central1` | Google Cloud BAA |
| **Google Cloud** | Firebase Hosting | the SPA's static files — no personal data | Google CDN | Google Cloud BAA |
| **Twilio** | programmable voice + SMS | **the call itself**: caller number, audio in transit, SMS bodies | US | **BAA NOT YET IN PLACE — ledger O5, `wip`** |
| **Microsoft 365** | outbound email | owner notifications — **link-only, no PHI by design** | US | see "Email is deliberately out of scope" |

### Two rows that need reading rather than scanning

**Identity Platform has no data-residency control at all.** Verified against the
live API and the v2 discovery document, not marketing: the `Config` resource
exposes eighteen fields and none of them sets a location. It holds **staff**
logins — email, bcrypt hash, display name — so no patient data and no PHI, which
is what keeps this manageable. But for the UK lane it must be described as **a
disclosed transfer under Google's DPA, not as residency.** Saying "EU-resident"
about this component would be false.

**Twilio is the one non-Google sub-processor that touches PHI**, and its BAA is
**not signed yet**. The caller's number and the audio both pass through it, and
nothing in the Google relationship covers that. Ledger **O5** is open: a support
ticket was filed 2026-08-21, Twilio redirected to a sales form, and it is
recorded there as the **longest lead time in the plan**.

**This is the single largest open compliance gap in the register**, and it is a
hard gate rather than paperwork: the covered lane cannot lawfully carry a real
patient call until it is signed. It sits alongside the LLC and cyber liability
on the "no real patient call" line.

---

## The UK / GDPR lane

Not built (`enable_uk_resources = false`) and listed so the register is complete
rather than aspirational.

| Sub-processor | Service | Contract |
|---|---|---|
| **Google Cloud** | Cloud Run, Cloud SQL, Vertex (`locations/eu`) | Art. 28 DPA + SCCs where applicable |
| **Deepgram** | speech-to-text, EU endpoint | Art. 28 DPA — **not BAA-covered, and correctly so: GDPR has no covered-products concept** |
| **ElevenLabs** | text-to-speech | Art. 28 DPA |
| **Twilio** | voice + SMS | Art. 28 DPA |

**Deepgram and ElevenLabs appear ONLY here.** `lib/compliance.js` refuses to
construct either client when `DEPLOYMENT_MODE=hipaa`, and a covered process will
not boot with their credentials present. That refusal is the enforcement behind
this table — the register describes a boundary the code holds, rather than a
promise somebody has to remember.

---

## Email is deliberately out of scope, and that is a design decision

`services/notifications.js` carries **no caller or patient information** — not in
the body, not in the subject. A notification says which business and what *kind*
of thing happened, and links to the dashboard. The details stay behind
authentication.

That is why the mail relay is not listed as a PHI sub-processor. The alternative
was negotiating BAAs down a delivery path whose entire job is to say "something
happened, go look", and removing the payload is cheaper and stronger.

**This is load-bearing.** The moment anything patient-identifying is added to a
notification, the relay becomes a sub-processor and needs a BAA. `tests/
notifications.phi.test.js` is what keeps it true.

> **OPEN, and it is an operational problem rather than a compliance one:** the
> SMTP credentials are currently a **personal Gmail account**, so notifications
> are sent *from* an individual rather than from the business. Ledger item
> D1-mail. It is not a PHI exposure — the messages carry none — but it is a
> workforce-offboarding problem now that there are two founders.

---

## Not sub-processors

Listed because their absence from the table above should be deliberate and
visible, not an oversight:

| | Why not |
|---|---|
| **AI Studio / Gemini Developer API** | Not a Google Cloud service and **not BAA-covered**. Never reachable from a covered deployment — `getClient()` refuses. |
| **athenahealth** | Not integrated. When it is, it becomes a sub-processor *or* a separate controller and that is a counsel question, not a table row. |
| **Sentry** | Receives **errors**, with context filtered against an allow-list of seven non-identifying keys (`callSid`, `requestId`, `businessId`, `context`, `table`, `op`, `kind`) — `lib/sentry.js` added that filter *because* recipient addresses, a subject line naming a patient, and caller numbers were previously being sent. **The residual is the exception MESSAGE itself**, which no allow-list filters and which a vendor error string could carry something in. To be cancelled at D7; until then treat it as a low-volume processor rather than as out of scope. |
| **GitHub** | Source only. The repository must never contain PHI. |

---

## Keeping this true

A register that is written once is wrong within a quarter. Three triggers, and
the first is the one that will actually happen:

1. **Any new client library that sends data outward.** Adding a vendor SDK is
   the moment this file changes — not the deploy, and not the invoice.
2. **A region or a residency claim changes.**
3. **Quarterly review**, alongside the access review in
   `access-authorisation-and-termination.md`, so both happen or neither does.

**Customers must be told before a sub-processor is added.** The notice period
goes in the clinic BAA and the DPA; counsel to set it (see the question above).

---

## What has never been exercised

Stated plainly, because the other drafts in this directory end the same way and
an untested control is a claim.

- **No customer has ever been notified of a sub-processor change.** The process
  above is written and unused.
- **The Twilio BAA has not been confirmed signed in this file.** It is the one
  non-Google PHI path and it should not stay unconfirmed.
- **No sub-processor's own compliance has been reviewed** — we rely on their
  published attestations, which is normal for a business of this size and is
  still worth writing down as the position taken.
