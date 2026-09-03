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

- **The cascade** — Deepgram → Gemini → ElevenLabs, on `/twilio/voice`. It
  serves a paying clinic today. It is tier 3 in the fallback design and the
  last thing standing when everything else is down.
- **The Live front-end** — Gemini Live on `/twilio/live-voice`. Fourteen real
  calls, every one of them made by the owner. It is an upgrade path.

Almost everything written about the Live front-end in the backlog is about
whether an *upgrade* is ready. It is not, and that does not block selling,
because the thing you would sell is already answering a real clinic's phone.

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
| 1 | asks to book, gets "someone will call you back" | **LVX34** |
| 2 | cancels two things, is told it still has them, then cannot book | **LVX33** |
| 3 | four questions in one breath | LVX25 |
| 4 | hangs up the moment something succeeds, without asking if there is anything else | LVX35 |
| 5 | offers midnight and 11 PM appointments | **config, free** |
| 6 | a UK callback number read out in US digit grouping | LVX26 |
| 7 | a 1.4–2.2 s pause before every reply | measured, unfixed |
| 8 | two seconds of silence before the greeting | LVX17 — **may not exist off the dev laptop** |

**1 and 2 are demo-killers and they are the same demo-killer twice**: the
assistant fails to do the one thing it is being demonstrated to do. Everything
else on this list is a wince; those two are a no.

**5 is free and has the best ratio on the page.** Digile Media's
`business_hours` are 00:00–23:59, so availability correctly offers midnight. A
prospect cannot tell config from defect, and "would you like midnight?" reads as
broken software. **Give the demo tenant real hours.**

**8 has to be re-measured before it is believed.** The 2.2 s was traced to
Norton's TLS interception on the development machine and has never been measured
anywhere else. If the demo is served from Cloud Run it may simply not be there.

### Which front-end does the prospect call?

An unresolved question and it should be answered deliberately rather than by
whichever one happens to be pointed at the number.

- **The cascade** is what serves a paying clinic, has fallbacks, and does not
  fabricate. It is also the one the owner has heard least recently.
- **The Live front-end** is the one that sounds better — that was the entire
  reason for the architecture — and it is the one with all eight rows above.
  **It has no fallback: a failure is silence, not voicemail.** Demoing it means
  accepting that risk in front of a prospect, on a path with no deployed home
  today (it runs locally behind a cloudflared tunnel).

### The honest shortest path to a call-quality demo

Fix **LVX34** and **LVX33**, give the demo tenant **real business hours**, and
decide which front-end answers. LVX25 and LVX35 next if there is time. That is a
short list and none of it is compliance work.

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

**To sell to one more friendly customer, on the cascade:** close O1 and O2, add
vendor alerting (O6), get call review (D3) so an incident is answerable, and
*start* the DPIA and the DPAs. Weeks, not months.

**To sell generally:** the multi-vertical matrix (M1/M3/M4) and the compliance
work are the real gates. The compliance work has external lead time, so start it
first even though it finishes last.

**The Live front-end is not on either path.** It is how the product gets better
after it is already selling.
