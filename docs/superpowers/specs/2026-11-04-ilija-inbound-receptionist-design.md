# Ilija's inbound receptionist (Digile UK) -- design

Date: 2026-11-04, updated 2026-11-07. Target: Ilija testing as soon as it is ready, Monday 2026-11-09 at the earliest.
The original Friday 2026-11-06 passed with nothing built. Late means slip, nothing gets cut (owner).
Line: Digile UK, `+441372656055` (01372 656055), tenant `55c7c8c4-2c33-463c-875a-7f16d6bcc17e`.
Live at time of writing: `voice-uk-prod-00112-boh` @ `4ae6f1d` at 100% (read 2026-11-04). `00114-zub` is the latest
ready revision but takes 0% traffic: it is the reverted pronunciation build, so never route "latest" to it. Branch
`feat/outbound-stage4`, HEAD `db6e5af`.

## Intent

Ilija owns Digile Media, a UK marketing agency. He answered our questionnaire about inbound calls. He wants an
assistant that picks up the calls he can't: it finds out why the person rang, takes notes, and tells him. The UK line
has run a general-agency config copied from the US line since 2026-10-10, and has never been shaped around his
answers. His phone rings first and forwards to this line on no answer.

This build is for him to test and give feedback. It is a supervised pilot, not unattended service.

**Treat him like every future client (owner rule, 2026-11-07).** All code changes are generic and apply to every
business. Anything specific to Ilija lives only in business config. No code branches on a business name or ID, and no
per-business decision is created for the owner to track. If config can't express something he needs, add a generic
setting whose default is today's behaviour.

**Success:** Ilija rings the line, hears his greeting, and each kind of caller gets handled the way he described. Each
message reaches his inbox with correct details. Nobody is told something false, above all nobody is told they are
booked.

## What Ilija said

- **Job:** answer calls he can't pick up, find the reason, take notes and messages. Business callers: if possible,
  check his calendar and book a "free consultation".
- **Greeting (his wording):** "Hello this is Ilija's assistant, Ilija can't get to the phone right now, how can I help
  you?"
- **Services:** the highest and main package is advertising for the business (Meta, Google, All-In-One). Also systems
  for businesses: speed to lead, lead nurturing, appointment reminders.
- **New lead details:** name, number, company, industry, what they sell, main challenge, plus email.
- **Screening:** main constraint on scaling their business; roughly what they spend or want to spend on marketing
  monthly. He gave no disqualifier.
- **Booking:** find a slot in his calendar if possible; if not, don't book and say he will be in touch soon. Later,
  GHL integration for data and bookings.
- **Existing clients:** ask the reason and how we can help; he will call them ASAP.
- **Personal calls:** make a note and send him the info.
- **Red lines:** never discuss other clients or their results; never confirm a booking unless the slot is actually
  confirmed in the calendar. Existing rules stay: no quoted prices, no guaranteed results.

## Decisions (owner, 2026-11-04)

1. **No booking in Stage 1.** The assistant takes the preferred day and time and says Ilija will be in touch. Ilija
   accepted this as his fallback. The calendar connector is Stage 2, next week.
2. **Greeting, exact:** "Hello, this is Ilija's AI assistant. Ilija can't get to the phone right now, how can I help
   you?" No transcription clause. Owner chose this knowing callers are not told about the transcript.
3. **Inbox gets messages and important items only, with details, for every business except healthcare.** See
   "Emails". Never one email per call. Owner's reason: one behaviour, consistent across clients, nothing to manage.
4. **Fix LVX185, LVX187, LVX189 (with LVX169's counter), and LVX188 before handover.** LVX188 ruling: an on-file name
   becomes a question, "Am I speaking with X?", never a statement. Also check whether the hard-coded 911 at
   `services/gemini.js:1371` renders on the UK line; if it does, the number comes from the business's phone country,
   the way language does (`countryFromE164`), never from a business-specific setting.
5. **Deploy the voice service if the test gate passes,** without a second check from the owner. Paid runs still need
   asking.
6. **Late means slip, not cut.**
7. **No email switch.** Whether an email carries details is derived from the existing `compliance_tier` via
   `effectiveTier` (`lib/compliance.js:157`): `hipaa` = no details, otherwise details. Setting up a new business must
   answer "is this a healthcare business?", and the setup script refuses to create one without that answer.
8. **Standard onboarding form.** Ilija's questionnaire becomes the form every client goes through; each question names
   the setting it fills. Ilija is set up only through it.

## Goals for Stage 1

### Caller paths

The assistant listens for the reason first, then follows the matching path. It asks "have you worked with Ilija
before?" only if it can't tell. It has no client list and must not get one, because of the red line about clients.

| Caller | What the assistant does |
|---|---|
| New business enquiry | Answers what it can, then asks the lead questions one at a time, saving as it goes. Takes preferred day and time for a free consultation. "Ilija will be in touch soon." |
| Existing client | Asks the reason and how we can help. "Ilija will call you as soon as he can." No lead questions. |
| Personal call | Takes name and the note. No business questions. |
| Supplier | Short message: name, company, reason, number. |
| Sales pitch | Default: short message. Changes to a polite decline if Ilija says so. |
| Wrong number, robocall, silence | Says who this is and closes kindly. Saves nothing. |
| Asks to speak to Ilija | Says he can't get to the phone and offers to take a message. Transfers stay off. |
| Asks for a booking | Never says booked. Takes the preferred time. Ilija confirms. |

### Lead questions (Ilija's list, in this order)

Name, number, company, industry, what they sell, main challenge, email, monthly marketing spend (actual or wanted).

- **Soft, never enforced.** A declined question is skipped and never asked again in that call. Enforced custom fields
  caused the 2026-10-10 failure (a non-clinic caller was asked for a clinic name and blocked).
- **Nobody is turned away on budget** unless Ilija gives a cut-off.
- **Number:** offer the caller-ID number once ("is the number you're calling from best?").
- **Email:** ask once, have it spelled, save what was heard. The model is its own speech recogniser and read-back
  cannot catch spelling, so some addresses will be wrong. Tell Ilija this; the phone number stays the safe contact.
- **Answer before asking.** If the caller asks a question, answer it first. A question from the caller is never treated
  as an answer to the assistant's question.

### Services and red lines

Put the services above in the tenant's prose. Remove anything clinic-specific. Add the two new red lines; keep prices
and guarantees. Replace "Office 07426704500" with whatever Ilija answers; until then, do not give out any other
number. Transfer policy = never, and `transfer_phone_number` must never be his forwarding number (loop).

### Emails

One rule for every business, derived from the existing tier: `effectiveTier(business) === "hipaa"` means the email goes
at the same time with no caller details; anything else means details. There is no new setting. Today only Digile UK and
the Test Line would receive these; Digile US had no notification address when last read.

| Event | Email |
|---|---|
| A message or callback request saved (lead, client, personal, supplier, sales pitch if messages are kept) | One, with details, after the call ends |
| "A caller may need a call back" (`notifyUnconfirmedClaim`) | As today |
| Call never reached the assistant (`notifyCallMissed`: failed, busy, no-answer) | As today |
| Nothing saved | None |

- **Contents:** caller type, name, number, reason, extra answers, preferred time, call time. The subject carries no
  caller name or number (lock screens, mail logs): "New enquiry -- {business}", worded by caller type. Never log the
  recipient or subject.
- **One email per call, built from the final saved row.** Today `capabilities/messages.js:255` emails at the first
  save, and a later correction updates the row silently. With details in the body, that would send the wrong number.
  So the email waits for call end, for every business: one path. Exceptions: the AI-down voicemail
  (`lib/degradedVoicemail.js`) has no call to wait for and sends as it does today, and owner SMS stays link-only.
- **Booking emails stay link-only until Stage 2** (Claude's call). Digile UK has no bookings before then, and a booking
  can move during a call, so it needs the same final-row treatment.
- **It must not get lost.** A lost email is a lost lead. If the call-end hook fails or the instance dies, this has to
  surface (alert or retry); the builder picks how, and says which failures remain.
- **False alarms must not reach Ilija** (owner rule, memory `client-alerts-neutral-wording`). Client-facing wording
  leads with the action and talks about the caller, never "the assistant failed".
- `notifyCallCompleted` has no callers and stays that way.

### Saving a lead as it goes

A long lead intake must survive a hang-up. Save once name, number and reason are known, then update as answers arrive.

**Trap:** `sameRequest` in `lib/capabilities/customerRequests.js` decides "correction or new request" by word overlap
on `message` (Jaccard >= 0.5). If the lead answers go into `message`, the text grows and a later save files as a NEW
row with a NEW email. So keep `message` as the short stable reason, and put lead answers somewhere else. Claude's call,
not yet reviewed by the owner: an optional details field on `record_customer_request` and a column on
`customer_requests` (next migration is 059). The updates must merge, so one partial save can't wipe an earlier answer.
Caller type is a generic list (new enquiry, existing customer, personal, supplier, sales pitch, other), lives in that
same field, is set by the model, and has no second column. A missing type still sends the email, with a plain subject.
Which extra questions a business asks is config (prose in `messages` notes), never code.

### Forwarding

Ilija sets conditional forwarding from his mobile to 01372 656055. His phone rings first, so the Twilio fallback stays
message-only (no `n=`), which it already is.

**Unknown until tested:** whether Twilio's `From` shows the real caller or Ilija's own mobile. The code reads `From`
only (`server.js:548,771`) and ignores `ForwardedFrom`. If `From` is his number, the assistant would offer his own
number as the caller's and may use a wrong on-file name. So:

- The code must not treat the business's own number as the caller's identity, for any business: no on-file name, ask for a number. Build
  this regardless of the test result, because Ilija will also ring the line directly from that phone to test. Claude's
  call: reuse `isOwnNumber` (`lib/inboundGuards.js:75`), and store his mobile in `notification_phone` once he gives it.
  Not `main_phone` (the silence goodbye speaks it) and not `transfer_phone_number` (loop). Until it is set, nothing
  changes; the forward test waits for it anyway.
- Run one real forwarded call with Ilija and read the logs. The owner is in the US and can ring Ilija's mobile; it
  doesn't need a UK handset on our side.

### Hand over

- ~15 scripted calls on the UK line before Ilija touches it (list below). ~$6; ask before spending. Claude's call: run
  them on the real Digile UK tenant, before forwarding is on, with emails going to the owner's address. No rehearsal
  tenant, because a copy wouldn't prove this line's config. Switch to Ilija's address at handover, and tell him test
  rows exist. Rollback: traffic back to `voice-uk-prod-00112-boh`, and the prose restored from the `--show` backup.
- A one-page guide for Ilija: what to try, how to forward (with his network's code), how to turn forwarding off, what
  to expect (email mistakes, a pause before replies, how it says names), how to send feedback.
- He rings the line directly first. Forwarding goes on only when he chooses.

### Stage 1 test calls

Each checks what was said, the saved row and the email:

1. Full new lead. 2. Lead declines budget. 3. Lead corrects the number after saving (one row, one email, final number).
4. Lead hangs up mid-questions (partial saved, one email). 5. "Just book me in" (no booked claim). 6. Asks the price.
7. Asks about other clients and results. 8. Existing client. 9. Personal call. 10. Supplier. 11. Sales pitch.
12. Wrong number (no email, no hang-up mid-confusion, LVX185). 13. Silence (no email). 14. Asks whether it's a person.
15. Asks to speak to Ilija.

Also listen for how it says "Ilija" in the greeting (see Constraints).

### Proof that it is generic

- A guard test fails the build if a business name or ID appears in running code.
- After Ilija's line passes, 3 calls on the Test Line (~$1.20, ask first), with its different config: a message email has
  details, booking still works, none of Ilija's wording appears.

## Non-goals

Calendar or GHL connectors (Stage 2+), SMS (production sends none; the UK number is voice-only), dashboard redesign and
deploy (that session waits; Ilija needs no dashboard login for this), transfers, the US line's config (`+18176011171` keeps its
prose as baseline, though generic code reaches it), LVX182 (Stage 2 prerequisite, moot with no booking tool on his line),
dashboard screens for the new settings.

## Anti-goals

Fail even if everything technically works:

- Any caller told they are booked.
- The same question asked twice after a no, or the caller's question ignored in favour of the next ask.
- Lead questions put to a personal caller, an existing client or a wrong number.
- A caller turned away because of budget.
- Ilija's inbox filling with noise, or a false alarm reaching him.
- Other clients' names or results mentioned.
- Any caller detail in an email from a healthcare-tier business.
- Code that names a business, or a setting only one business could ever use.

## Constraints and traps

- **Prompt budget.** `custom_instructions` is cut silently at 2000 characters (`services/gemini.js:1244`), and capability
  `notes` has a separate 2000 (`lib/capabilities/configSchema.js:50`). Check the rendered prompt, not the stored field.
- **Live builds the prompt once**, at the greeting step. Step-scoped rules never reach it (memory
  `live-prompt-built-once`), so caller paths must sit in text that always renders. Appointment notes are at risk once
  that capability is off, so use `messages` notes or `custom_instructions`, and confirm by rendering.
- **The message protocol is fixed text** (`capabilities/messages.js`: urgency question, "Someone will get back to you...
  by the next business day"). It conflicts with "Ilija will call you ASAP", and the model follows the local instruction
  over tenant prose. So add a generic `messages` setting for who calls back and how soon, whose default is today's
  wording.
- **Turning booking off** is two layers: tool and prompt (memory `capability-disable-model`). Test that a booking claim
  doesn't come back. On Live the claim guard only detects, it doesn't stop.
- **Prompt caps don't hold** (memory `prompt-caps-need-counters`). "One ask per need" is a counter in code.
- **Pronunciation.** "Ilija" is now in the first sentence of every call, and this voice has no pronunciation control.
  Owner reverted the pronunciation round on 2026-10-22 and chose to stay as is. Do NOT rebuild the box, the recorded
  greeting, or sound-spelling without asking. If it says "Ilija" badly, report it; the owner decides.
- **Config writes.** `scripts/set-business-config.js` (backup with `--show` first; one field per run) and
  `import-tenant.js` (the only path to capability rows and `allowed_tasks`; must include `phone_number` or it makes a
  second tenant). Read capability rows first with `db-inspect --business <e164> --counts`.
- **Reading prod:** db-inspect via the migrate job only. Notifications were off when last read (2026-10-10); re-read.
- **Deploy** via gcloud, not Terraform. Build images from the main checkout, never an LF worktree (migration checksums
  are CRLF). Run the suite before trusting the stated baseline. Migrations: `db:reset` applies only `schema.sql`, so add
  to both. Red-first tests with sabotage rows; review with named risks.
- **Email promises must change in the same commit.** `docs/compliance/sub-processor-register.md` (line 56, and the
  section from line 101) says email carries no caller information and calls that load-bearing: once it does, Microsoft
  365 (US) is a sub-processor for caller data. The register must say so. `tests/notifications.phi.test.js` keeps its
  no-sentinels property for healthcare-tier businesses and for every subject line, and gains a test for details on. Update the
  comments in `services/notifications.js` and `lib/capabilities/customerRequests.js`, and about ten test files reference
  `notifyCustomerRequest` timing.
- **Default `standard` fails open for a clinic,** so the healthcare answer is required at setup rather than remembered.
  Do not guess it from description words: Digile sells to clinics and would match. Health details in email would need a
  signed agreement with the mail provider (US) and special handling as health data (UK).
- **Money:** state the dollars and ask before any paid run (probes, test calls).
- **Owner to-do that can stop every call:** Google Cloud trial ends 2026-11-18. Billing is enabled; whether it is
  converted to paid is unconfirmed. Keep it in every report until done.

## Waiting on Ilija

Draft questions given to the owner on 2026-11-04 to send. Defaults below are Claude's calls.

| Question | Blocks handover? | Default |
|---|---|---|
| Email address for call notes | **Yes** | None. Owner's address until he answers, so testing can continue |
| Mobile number and network to forward from | **Forward test only** | He rings the line directly |
| Which calendar | Stage 2 only | -- |
| Consultation length, days, times, phone or video | No | "Which day and time suit you?"; no slots offered |
| Sales pitches and suppliers | No | Short message |
| Minimum budget | No | None, pass everything on |
| How he says "Ilija" and "Digile Media" | No | Judge by ear after the first call |
| May it give out 07426704500? | No | No |

## Stage 2 (after handover, separate design)

Fix LVX182 first. Then a calendar connector behind the existing adapter seam (`adapters/scheduling/`; backlog K4). The
model says "booked" only after the external calendar returned success; otherwise "Ilija will be in touch". Which
connector depends on his answer: Google (sharing his calendar with a service account should avoid the OAuth review;
unverified), Outlook (Microsoft Graph), or GHL, if he already books there, since that's where he wants to end up. Rough
size: ~8-12 h + ~$3 of test calls. `calendarRemoved.test.js` guards the old dashboard sync and must keep passing.

## Left to the builder

- How the email waits for call end.
- The details field's shape.
- How the question counter is built for LVX189/LVX169.
- Exact prose, subject to the budget and the paths above.
- Task order. If time runs short, say so early rather than cutting tests silently.
