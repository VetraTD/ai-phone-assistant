# What it takes to sell this

**Written 2026-09-03**, at the close of a sitting that put ten real calls
through the speech-to-speech front-end. It exists because "is it ready?" kept
getting answered about the wrong product.

**This is not legal advice.** The compliance section names questions, not
answers, and `docs/speech-to-speech-handoff.md` §10 is explicit that a
professional is required. Nothing here substitutes for that.

---

## The framing that matters most

**There are two products, and only one of them is the experiment.**

- **The cascade** — Deepgram → Gemini → ElevenLabs, on `/twilio/voice`. It is
  the mature one: fallbacks, transcripts, months of fixes behind it. It is tier
  3 in the fallback design and the last thing standing when everything else is
  down.
- **The Live front-end** — Gemini Live on `/twilio/live-voice`. Fourteen laptop
  calls and a handful of deployed ones, every one of them made by the owner. It
  is an upgrade path.

**Corrected 2026-09-03: there is no customer.** Earlier drafts of this document
and of the backlog said the cascade "serves a paying clinic today". It does not.
Nobody pays, and no member of the public reaches either front-end — Digile Media
is a friend's business used as a test tenant. The claim appeared in nine places
and two of them were load-bearing arguments rather than colour, so it is worth
being exact about what changes:

- **Shared-file changes are cheap.** "It is shared with the cascade, which
  serves a paying clinic" was the standing reason to be careful with
  `services/tools.js`, `capabilities/appointments.js` and the prompt. With no
  callers on either path, the cost of a regression is a test suite and a
  redeploy. Care is still warranted for the eval band's sake; fear is not.
- **The P1 tier means what it says.** "Before the first paying customer" is a
  real deadline in the future, not a description of today.
- **Nothing about compliance gets easier.** Every item in section 3 has external
  lead time and none of it starts when the money does.

Almost everything written about the Live front-end in the backlog is about
whether an *upgrade* is ready. It is not — and the cascade is not selling to
anyone either, so "does not block selling" is no longer the point. The point is
which of the two a prospect should be asked to judge.

The rest of this document is the honest list for each.

---

## 0. Demo-ready — what a prospect on a test call actually hears

**Added 2026-09-03.** The owner's nearest goal is a business that rings the
number and judges call quality. **That is a different list from everything below
it**, and the difference is worth stating plainly, because most of this
document's P0s do not appear on it.

**O1, O2, the DPIA, the DPAs, fallback tiers, the eval port, LVX29's
confirmation SMS — a prospect on a ten-minute test call cannot perceive any of
them.** They matter enormously the day a real patient is on the line and not one
minute before. Do not spend the demo run-up on them.

What a prospect DOES perceive, in the order it will cost you the meeting:

| # | what they hear | entry |
|---|---|---|
| 0 | ~~books the appointment **without ever asking their name**~~ | **LVX40 — VERIFIED on a call 2026-09-03**: it asked, and the row carries the name |
| 1 | ~~asks to book, gets "someone will call you back"~~ | **LVX34 — VERIFIED on a call 2026-09-03**: the gate refused, it asked for the spelling and waited, then booked |
| 2 | ~~cancels two things, is told it still has them, then cannot book~~ | **LVX33 — VERIFIED on a call 2026-09-03**: three cancelled in one turn, none left behind, and the next booking was allowed |
| 3 | four questions in one breath | **LVX25 — REPRODUCED 2026-09-03**, twice on one call. Still open |
| 4 | hangs up the moment something succeeds, without asking if there is anything else | LVX35 — never observed on Brightwork; verify before fixing |
| 5 | ~~offers midnight and 11 PM appointments~~ | **GONE** — Brightwork has real hours |
| 6 | a UK callback number read out in US digit grouping | LVX26 — US tenant, not on the demo path |
| 7 | a 1.4–2.2 s pause before every reply | measured, unfixed |
| 8 | ~~two seconds of silence before the greeting~~ | **GONE** — LVX17 was Norton; 16 ms on the deployment |

**Rows 5 and 8 closed on 2026-09-03 by deploying**, not by writing code. The
midnight offers were Digile Media's `00:00-23:59` hours and Brightwork has real
ones; the greeting delay was TLS interception on the development laptop and does
not exist where the product runs.

**And one row nearly wasn't on this list at all.** Every deployed call was
silent until `VOICE_INTENT_MARKER` was found — an environment variable set in
production and unset locally, which made the model speak `<<intent:...>>` aloud
and the leak guard shred the call. See LVX37. A demo rehearsal that had only
ever happened on the laptop would have met that for the first time in front of a
prospect.

**Rows 0, 1 and 2 are demo-killers and they are the same demo-killer three
times**: the assistant fails to do the one thing it is being demonstrated to do.
Everything else on this list is a wince; those three are a no.

**Two of the three are now verified on a real call, with the transcript and the
database row both read.** LVX40 asked for the name and wrote it; LVX34's gate
refused, the assistant asked for the spelling and waited rather than promising a
callback, and then booked. `postcall_verify` matched the claim to the row.

**LVX33 is now verified too.** Three appointments cancelled in a single turn,
all three `cancelled` in the database, none left in the snapshot — and the
booking the caller asked for immediately afterwards reached the availability
check instead of being refused, which is the half they actually felt.

**All three demo-killers are verified on real calls.** What remains on this list
is LVX25 (reproduced twice today, shared prompt text, belongs with the eval
band), LVX35's ordering, and the 1.4–2.2 s reply pause.

The verification was done on the LOCAL rig, not staging, and that is the lesson
rather than a shortcut: with no database access, "no row" and "never tried" are
the same observation, so four staging calls could not settle what one local call
did.

**5 was the free one and it is already spent.** Digile Media's `business_hours`
are 00:00–23:59, so availability correctly offered midnight — a prospect cannot
tell config from defect, and "would you like midnight?" reads as broken
software. Closed by making Brightwork the demo tenant rather than by editing
anyone's hours.

**8 was re-measured and it is gone.** The 2.2 s was Norton's TLS interception on
the development machine: `connect_ms` reads 16–22 ms on the Railway deployment
against 2,286 ms on the laptop. It does not exist where the product runs, and
the wider consequence stands — any latency measured on that laptop over an idle
connection carries the same penalty.

### Which front-end does the prospect call?

Answered by A1 below — Live answers, cascade as the fallback — but the trade is
still worth stating.

- **The cascade** has fallbacks, writes transcripts, and does not fabricate. It
  is also the one the owner has heard least recently.
- **The Live front-end** is the one that sounds better — that was the entire
  reason for the architecture — and it is the one with all eight rows above.
  **It has no fallback: a failure is silence, not voicemail.** Demoing it means
  accepting that risk in front of a prospect.

**It does now have a deployed home.** As of 2026-09-03 it runs on Railway
staging from `feat/s2s-frontend`, with its own Postgres and Brightwork Family
Dental as the tenant; `+18176011171` points at `/twilio/live-voice`. The
cloudflared quick tunnel this document was written against is no longer how it
is reached.

### Everything needed, in full

Six groups. **A is first because it changes what the rest of the list even
says.**

#### A. Two decisions — ANSWERED by the owner 2026-09-03

**A1. Gemini Live answers, with the cascade as the fallback.**

This is the right shape and it is **not a safety net you already have** — tiers
2a/2b/3 do not exist, and today a Live failure is silence. Choosing Live means
building the fallback is now demo work, not later work. Two halves, and they are
not equally hard:

- **Connect-time failure** — the cheap and valuable half. `/twilio/live-voice`
  already loads the tenant and mints a stream token before returning TwiML, so a
  failure there can return the cascade's `<Connect><Stream>` at
  `/twilio/media-stream` instead. The caller never knows.
- **Mid-call failure** — the socket drops after `<Connect>` has begun. Twilio's
  `<Connect>` accepts an `action` URL that is requested when the connection
  ends, which is the hook: on an abnormal close, hand back the cascade's TwiML
  and the caller continues on tier 3. **Unverified — nobody has tried it here.**

A connect-time fallback alone removes the worst demo outcome and is much smaller
than the full tier design in section 2.

**A2. Digile Media on its real UK line eventually; `+18176011171` for testing.**

`LIVE_BUSINESS_PHONE=+441372656055` stays the mechanism: a US test number
answers with the real tenant's config, nothing else changed.

**Superseded in practice on 2026-09-03, and for a better reason than
convenience.** The staging deployment carries **Brightwork Family Dental**, and
`+18176011171` resolves to it natively — no `LIVE_BUSINESS_PHONE` at all.
Brightwork has real business hours, which is what closed row 5 of the table
above; Digile Media's are `00:00–23:59` and it offers midnight appointments
correctly. A prospect cannot tell config from defect, so the demo tenant is
Brightwork and the override stays unset.

**Standing cost of that choice:** `+18176011171` is `ASSISTANT_NUMBER`, which
`npm run probe` dials, so every test round repoints it and must restore it
afterwards (`docs/live-frontend-RESTORE.md` §3, and verify by reading the number
back from Twilio, never by trusting the update). **A second, dedicated test
number would end that ritual permanently** and is worth the few dollars a month.

The original framing of both decisions follows.

#### A (original). Two decisions, before any work starts

1. **Which front-end answers the phone.** The cascade has fallbacks, writes
   transcripts and does not fabricate. The Live
   front-end sounds better — which is the entire reason it exists — and carries
   every row in the table above, has no fallback, and has no deployed home.
   Choosing the cascade deletes most of groups B, C and E.
2. **Where it is hosted, and which number is dialled.** Today the Live path runs
   locally behind a `cloudflared` quick tunnel whose URL changes on every
   restart. `+18176011171` is a US line and is `ASSISTANT_NUMBER`, which
   `npm run probe` depends on; `+441372656055` is Digile Media's real UK number
   that people actually call. **A prospect demo needs neither of those.**

#### B. What they hear — the eight rows above

Ordered by cost to the meeting. **LVX40, LVX34 and LVX33 were the three that
mattered**; they are the same failure three times, the assistant not doing the
thing it is being demonstrated to do. All three are fixed as of 2026-09-03 and
all three are unverified on a call.

What remains here is LVX41 — an audible hard cut whose content nobody has
captured — then LVX25 and LVX35 **if they reproduce on Brightwork**, then LVX26,
which is not on the demo path at all.

#### C. Infrastructure that survives a demo

- ~~**The Live front-end has no deployed home.**~~ **CLOSED 2026-09-03.** It runs
  on Railway staging from `feat/s2s-frontend`, with its own Postgres and
  Brightwork Family Dental as the tenant. `/twilio/live-voice` is mounted
  unconditionally in `server.js` — there is no feature flag — so deploying the
  app deploys the route; what that environment needs is `GEMINI_API_KEY` and a
  Twilio number pointed at it. Two things learned getting there: Railway prefers
  a Dockerfile over Nixpacks when it finds one, and `scripts/migrate.js` needs
  `--init-if-empty` against an empty database or it fails at 002.
- **There is NO fallback. A Live failure is silence** — not voicemail, not the
  cascade. Tiers 2a/2b/3 do not exist. On a prospect call that is the worst
  available outcome, and it is the strongest single argument for demoing the
  cascade instead.
- **Concurrency is unmeasured** (O7) and the vendor cap is shared. Two prospects
  at once is untested.
- A **second handset** has never been used. Every acoustic number in this
  repository is one phone, one room, one carrier's echo canceller.

#### D. A tenant that sounds like a real business

The demo tenant is a product surface, and Digile Media is a test fixture.
**Resolved by changing tenant rather than by editing config**: the demo is
Brightwork Family Dental, which has real hours. The rest of this list is what
Digile Media would still need if it were ever the one dialled.

- ~~**`business_hours` 00:00–23:59** is why it offers midnight.~~ **GONE on the
  demo path** — Brightwork has real hours. Still true of Digile Media.
- **`main_phone` is a mobile**, not the line callers dial, so the goodbye reads
  out the wrong number.
- **Intake fields drive LVX25.** Four configured fields are what get conjoined
  into one breath; fewer fields is a cheaper mitigation than a prompt change.
- Greeting, timezone and locale should match the vertical being demonstrated —
  and `locale` is currently null on this tenant, which is what LVX26 keys on.

#### E. Being able to answer "what did it say?"

The first question a prospect asks after a test call, and **today it cannot be
answered for a Live call at all**:

- **LVX30** — the Live path never writes shared call state, so `/twilio/status`
  sees no `businessId` and no `dbCallId`: the call is never marked completed,
  never summarised, and `completeCall` runs unscoped.
- **No transcripts.** The Live path never calls `db.addTranscriptEntry`.
- **LVX36's gap** — even the debug flag records only the assistant's half, so
  "did the caller actually ask for that?" is unanswerable.
- **D3** call review is the dashboard surface all of this would feed.

#### F. Risks to accept knowingly, not discover live

- **LVX27** — roughly one call in ten invented a booking. LVX29 now catches it
  after the fact, but only in `count` mode; nothing prevents it, and a prospect
  who checks the diary will find nothing there.
- **LVX21** — the outbound leak guard has never fired on a real call, so whether
  a leak can be cut in time is still unknown.
- **LVX16 is CLOSED** as of 2026-09-03: the assistant read the caller's own
  number back correctly on a real call, country code stripped.

#### G. Explicitly NOT needed for a call-quality demo

Say no to these now so they do not creep in: the DPIA, the Article 28 DPAs and
the transfer assessments; O1 and O2; the eval port and the fabrication-rate
round; the multi-vertical matrix; Google Calendar and the other scheduling
adapters; the confirmation SMS actually sending; self-serve signup.

They are all real and several are urgent **before money changes hands**. None of
them is perceivable on a test call, and every hour spent on them is an hour the
prospect's call still sounds wrong.

### The honest shortest path

**Updated 2026-09-03, second pass.** A1 and A2 are decided. LVX40, LVX34 and
LVX33 are fixed, the caller's half of the transcript is now captured, and the
demo tenant has real business hours because it is Brightwork rather than Digile
Media.

What is left, in order:

1. **Deploy and make the three calls.** Everything above is offline, and the
   only thing that settles any of it is a real call. Diff the deployed
   environment against the local `.env` FIRST — that is the trap that cost five
   hypotheses last sitting.
2. **LVX41** — one outbound leak still fires with marker mode off and it is
   audibly hard-cut. Its content is unknown, and `matched` will not name it:
   that field is a tool-name label and is null for anything structural. The
   `text` on `live_debug_leak_text` is the evidence.
3. **LVX25 and LVX35** only if they reproduce on Brightwork. Both were seen on
   Digile Media and neither has ever been observed on the demo tenant.
4. **An eval band for the reworded spelling gate**, ~$20 across two arms, which
   proves the cascade did not regress and proves nothing about the Live path.

None of it is compliance work, and none of it is large.

---

## 1. Technical — to sell the cascade to more customers

### Blocking

**Security, and these are already recorded as P0.**

- **O1** — unauthenticated endpoints that spend vendor money. Anyone who knows
  the URL can burn credit and consume the concurrency cap.
- **O2** — real caller phone numbers committed to git history.
- The five security risks knowingly left live on `main` (see the website
  decisions note). "Knowingly" was a reasonable call for a pre-revenue demo and
  stops being one the moment a second customer's callers are on the line.

**Coverage.** Every behavioural claim in this repository rests on one or two
tenants. `M1` defines the matrix, `M3`/`M4` extend prompt snapshots and eval
scenarios per archetype. **You cannot sell to a plumber on evidence gathered
from a dental clinic** — the capability packs make the two genuinely different
configurations, and only one of them has ever been exercised properly.

**Operations.**

- **O6** vendor-failure alerting. Today a Deepgram or ElevenLabs outage is
  discovered by a customer.
- **O7** concurrency and load. Unknown, and the cap is shared.
- **O4** an appointment sweeper.
- **C4** a `$/call` metric. Without it you are pricing on an estimate. The
  measured numbers are ~$0.13–0.16 per three-minute cascade call and ~$0.14–0.50
  on Live, where cost is quadratic in call length rather than linear.

### Important, not blocking

- **D1** — prove every dashboard knob actually reaches a call. There is a
  standing history of settings that look set and change nothing.
- **D3** — call review / QA. Without it you cannot answer "what did it say to my
  patient?", which is the first question any clinic asks after an incident.
- **D6 / O3** — self-serve or concierge. The code says one, the stated plan says
  the other, and one of them has to move before a second customer onboards.

---

## 2. Technical — additionally, to ship the Live front-end

In rough order, and all of it is in the backlog's "Session state at 2026-09-03
close" list:

1. **LVX29** — confirm from the database, so a fabricated booking cannot survive
   the call.
2. **Post-call reconciliation** — tell the business when a claim and the
   database disagree.
3. **The eval port** (handoff §8) — booking correctness across 43 scenarios has
   never been measured against a Live session, and it is the instrument that
   turns "it sometimes fabricates" into a rate.
4. **Fallback tiers 2a / 2b / 3.** Today a Live failure is silence — not
   voicemail, not the cascade. This is a hard blocker on its own, independent of
   everything else.
5. **LVX17** — ~2.2 s of dead air before every greeting.
6. **LVX15** — no deadline on the tenant load, so a hung query is an indefinitely
   silent call.
7. A **second handset**. Every acoustic number in this repository is one phone,
   one room, one carrier's echo canceller.

**The honest status:** after LVX29 and reconciliation, the Live path becomes
*safe to trial*. "Production-ready" is that plus the fallback tiers plus the
eval port plus a second tenant, and that is several sittings.

---

## 3. Non-technical — and this is the longer pole

### Compliance

Dental appointments are **special-category health data** under UK GDPR. That
is not a formality and it is the item with a lead time you do not control.

- An **Article 9 condition** plus a **DPA 2018 Schedule 1 condition**, wherever
  the processing happens.
- A **DPIA**. Very likely mandatory for this processing.
- **Article 28 DPAs** with every processor — Google, Deepgram, ElevenLabs — and
  the clinic contracts have to actually permit those sub-processors.
- Transfer assessments. UK GDPR does not require UK residency; adequacy or an
  IDTA plus a transfer risk assessment covers it. **Geography is the easy part;
  terms are the hard part.**
- Worth stating plainly: **this exposure already exists.** Caller audio goes to
  Deepgram and ElevenLabs in production today. The speech-to-speech decision
  does not create it — though moving the model leg to AI Studio would be a
  regression in posture versus Vertex.

### Legal and commercial

- Customer terms, and an SLA you can actually meet given O6 and O7 are open.
- **Liability for a missed or fabricated booking.** This is not hypothetical:
  on 2026-09-03 the assistant confirmed an appointment that was never written.
  Decide what you owe a clinic when that happens before a clinic asks.
- Professional indemnity insurance.
- A privacy notice and a retention policy. The recording disclosure is already
  spoken in the greeting, which is a good start and not the whole of it.

### Operational

- What happens when it breaks at 2pm on a Tuesday and a clinic is losing calls.
  Who answers, how fast, and what the customer is told to do meanwhile.
- An incident path that does not depend on the owner being awake.

### Commercial

- **M1** — which five or six verticals for the first ten customers. The matrix
  is much cheaper if it is not exhaustive.
- Pricing against the measured unit cost above, with a margin that survives a
  five-minute call.
- The website (a friend is doing it — do not rebuild it).

---

## 4. The shortest honest path

**To sell to the FIRST customer, on the cascade:** close O1 and O2, add
vendor alerting (O6), get call review (D3) so an incident is answerable, and
*start* the DPIA and the DPAs. Weeks, not months.

**To sell generally:** the multi-vertical matrix (M1/M3/M4) and the compliance
work are the real gates. The compliance work has external lead time, so start it
first even though it finishes last.

**The Live front-end is not on either path.** It is how the product gets better
after it is already selling.
