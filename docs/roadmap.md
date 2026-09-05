# What we are doing, and in what order

**Written 2026-09-04**, at the close of the session that made the Live
front-end demonstrable. It exists because `readiness.md` answers *"what does it
take to sell this"* and `receptionist-backlog.md` answers *"what is broken and
what proves it"* — and neither answers **"what are we doing next week."**

Keep this page short. Detail lives in the other two; this is the order.

---

## The plan, in four phases

Each phase unblocks the next. That is the point of the order, and it is a
change from an earlier plan that ran everything in parallel.

1. **Demo ready** — a business rings a number and judges how it sounds.
2. **Infrastructure** — one canonical deployment, one database.
3. **Dashboard** — numbers and tenant data changeable without a script.
4. **Integrations** — Google Calendar, Outlook, Calendly, *while businesses test.*

**Two clocks run alongside all of it and do not compress**: Google OAuth
verification for the Calendar scope, and DPAs from Twilio, Google and
ElevenLabs. Start both before writing the code that waits on them.

---

## Phase 1 — demo ready

**The market is UK first.** UK businesses test in the coming weeks; US in a few
weeks after. That decision cascades into most of this list.

| | |
|---|---|
| **A British voice you are happy with** | The owner reports `en-GB` sounds "slightly muffled" and `en-US` "way better and more clear". For a UK tenant British is the CORRECT accent, so this stops being a preference and becomes a demo-quality problem. Try two or three prebuilt voices against `en-GB` and pick by ear. **Needs the owner's ears, not a test.** |
| **Make `LIVE_VOICE` tenant-aware** | `lib/voice/live/index.js:87` — the language is tenant-aware as of today, the VOICE NAME is not. It is one global constant for every tenant. Same fix as `liveLanguageCode()`: env override → tenant's configured voice → default per locale. |
| **A UK test number** | `+18176011171` is American; a UK business would dial internationally. A new number must be on **Twilio account A** (`AC1828…43b6`) because Twilio signs webhooks with the owning account's token — see `twilio-account-topology`. |
| **A UK demo tenant** | Brightwork is `America/Chicago`, `en-US`. Digile Media is UK but is a marketing company with `00:00–23:59` hours, which is what produced the midnight-appointments bug. A UK tenant with real opening hours. Config, not code. |
| **The "anything else?" tic** | 3–4 of every 10 turns. The loudest remaining "this is not a person" signal. **Fix the counter first** — it undercounts, missing "What else can I help you with", "Is there anything else you'd like to know". Then the reducer, NOT the prompt: seven instructions already say this and are ignored. |
| **Stacked questions** | Same file, same session as the tic. `live_stacked_questions` already counts 1–2 a call. |
| **A notes tool, or a refusal that admits it cannot** | It told a caller *"I've added that note for you"* with no tool able to do it, and the row kept its old notes. LVX48's shape in a new place, and the same class as the booking bug that took six calls to kill. |

### Definition of done — phase 1 ends with a CALL, not with an empty list

**A UK business rings a UK number and:**

- hears a British voice **the owner has approved** — not merely correct, one
  they would put in front of a prospect
- books an appointment that lands in the database with the right name and time
- is not asked "is there anything else?" three times
- is not told anything untrue — no phantom booking, no note that was not saved
- hears no goodbye until the call is actually over

And from the counters: `postcall_verify: ok`, a real row, `nudges_fired: 0`, a
clean transcript.

### Why that call is not optional

**Everything verified on 2026-09-04 was verified on the US configuration** —
Brightwork, `+1 817`, `America/Chicago`, `en-US`, Twilio account B. A UK setup
is a DIFFERENT ENVIRONMENT: new number, new tenant, new locale, new voice, and
account A. **None of those verifications automatically carry.**

That is the same shape as the two traps this project has already paid for. The
locale fix worked on two laptop calls and did nothing on the deployment because
the tenant row differed. `VOICE_INTENT_MARKER` was set in production and unset
locally, and fourteen clean laptop calls hid a silent deployment. Assuming a UK
config behaves like the US one would be the third instance.

### The stopping rule

Phase 1 is done **when that call passes** — not when the list above is empty.

Equally: a defect that fires once in nine calls does not block it. LVX75 has had
two clean calls since its second reword; LVX70's fix has never been exercised at
all. Neither is worth another day, and both are written down.

If items appear after the passing call, the question to ask is whether a
business ringing the number can PERCEIVE them. If not, they belong to phase 3.

### Already done, and verified on real calls

- The abandoned write — gate refuses, we retry in code, the model corrects the
  name. Four consecutive calls had lost a booking here.
- Connect-time fallback: a failure at pickup is the cascade or voicemail, never
  silence.
- The mid-call goodbye and the 40-word re-read.
- Voice locale derived from the dialled number.

---

## Phase 2 — infrastructure

**Destination: `vetra-uk` (europe-west2), after demo readiness.** Not before —
moving hosts before a business has used it trades a known-good state for an
unverified one.

**Why GCP rather than staying on Railway**, now that the market is UK:

- `cloudbuild.yaml` builds **the same Dockerfile from the same repo**, so GCP
  Cloud Run already runs this exact application. Moving the receptionist is a
  `GEMINI_API_KEY` and a number pointed at it — not a port.
- The cascade already runs there in production, serving `+441372656055`.
- UK callers, UK numbers, London server: no transatlantic audio per frame.
- Cloud SQL is the answer to the three-databases problem below.

**Why NOT to rush it:** every deploy becomes a cloudbuild rather than a push,
and Google suspended four projects on 2026-08-25 for an undisclosed AUP
violation scoped to this owner. That is a recorded risk, not a hypothetical.

**`vetra-us` stays dark** until US businesses test — "one tfvars line to light".

### The thing that actually hurts today

**The same tenant exists in three databases with different values.** That is
what made the accent fix look done and not be: Brightwork's `locale` says
`en-US` locally and is empty on staging. One shared Postgres — Cloud SQL, or a
single Railway instance — is the fix, and it is worth doing **whichever
destination wins.**

---

## Phase 3 — dashboard

The goal is operability: change a number, change tenant data, see what happened
on a call, without a script and without a local Postgres.

**The blocker is that a Live call is invisible.** `lib/voice/live/index.js`
calls neither `addTranscriptEntry` nor `completeCall` — count is **0**. So a
Live call writes no transcript, is never marked complete, never summarised, and
the dashboard cannot show it at all. See `readiness.md` §E and LVX30.

That must land before businesses are testing in volume, because the first thing
any of them says is *"it got my name wrong"* and there is currently nothing to
look at.

---

## Phase 4 — integrations

Google Calendar, Outlook, Calendly — built **while businesses are testing**, not
before.

- `adapters/scheduling/` exists; Google Calendar was removed and is K4.
- **The Calendar scope is SENSITIVE.** External-user apps go through Google's
  verification: privacy policy, scope justification, sometimes a demo video, and
  a review queue you do not control. **You can finish the integration in three
  days and still not ship it for weeks.** Microsoft has an equivalent.
- Bookings already land in the database and can notify by email/SMS. A first
  customer may not need any of this — ask the business that is testing before
  assuming.

---

## Decisions locked, with the reasoning

Recorded so they are not re-litigated. **Re-derive on request; do not cite.**

| | |
|---|---|
| **UK first** | UK businesses test now, US in a few weeks. Drives voice, number, tenant and region. |
| **Locale from the NUMBER, not the stack** | Region is where data lives; locale is who is calling. They come apart the moment a UK stack serves an Irish business. `+44` → `en-GB`, `+1` → `en-US`, tenant row overrides, env overrides both. |
| **Gemini Live for the receptionist** | Knowingly forecloses the compliance path: Gemini 3.1 Live is **AI Studio only** — no BAA, no residency, a `-preview` model, and `europe-west2` serves no Live model on Vertex. A clinic that asks for a BAA gets the CASCADE, which is what the GCP estate was built for. |
| **The fallback is not an infrastructure problem** | `/twilio/voice` and `/twilio/live-voice` are the same process — `server.js:568` is the connect-time fallback handing off in-process. Hosting changes nothing about it. |
| **Mid-call fallback deliberately unbuilt** | Needs `<Connect action=...>`, never tried here. Connect-time covers the common case. |
| **Do not rebuild the website** | A friend is doing it. Three rebuilds already discarded. |

---

## Operational gotchas, learned the expensive way

- **Railway prod will not deploy a fast-forward** onto a SHA the staging
  environment has already built — no new commit for the webhook to react to.
  **Redeploy does not rescue it**: it rebuilds the ACTIVE deployment's commit,
  succeeds, and changes nothing. Fix: an empty commit on `main`. Cost the first
  time: twenty minutes.
- **The root page prints `Build: <sha> (<branch>)`.** Fastest deployment check
  available, no token. The debug endpoint 404s on a wrong token, which is
  indistinguishable from a missing route.
- **Vercel cannot deploy this repo** — private org repo on the Hobby plan. A
  permanently-red check that does NOT block Railway, but the dashboard frontend
  is not deploying at all.
- **There is no CI.** No `.github/workflows/`, so nothing runs the 3,169 tests
  on push. **Twenty minutes of work, and the highest-leverage item on this
  page** for a week of long days — this project already has two entries proving
  how unverified change ends.
- **A tenant row is configuration too.** "Diff the env before theorising" is too
  narrow; ask which database you verified against.

---

## Explicitly NOT in scope for demo readiness

Say no now so they do not creep in: the dashboard, transcripts, billing,
self-serve signup, the multi-vertical matrix, mid-call fallback, concurrency
testing, the DPIA and transfer assessments. Every one is real. **None is
perceivable by a business ringing a number to hear how it sounds**, which is the
only thing phase 1 is for.
