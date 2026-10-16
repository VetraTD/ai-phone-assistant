# What it takes to sell this

> **Start with the Launch checklist below (2026-10-09).** It is the current list
> for the first paying clients. For the older phase order, see `docs/roadmap.md`.


**Written 2026-09-03**, at the close of a sitting that put ten real calls
through the speech-to-speech front-end. It exists because "is it ready?" kept
getting answered about the wrong product.

**This is not legal advice.** The compliance section names questions, not
answers, and `docs/speech-to-speech-handoff.md` §10 is explicit that a
professional is required. Nothing here substitutes for that.

---

## Launch checklist — first paying clients (2026-10-09, current)

> **Start here.** The sections below this one were written 2026-09-03 for the
> demo stage; where they disagree with this list, this list wins. Hours marked
> *rough* are new estimates; the rest come from the finance guide (OneDrive
> `VetraTD - Documents\Finance\VetraTD_Financial_Master_Guide`, Parts 7 and 13)
> and `docs/superpowers/plans/2026-10-08-abuse-guards.md`.

Checked in the code on 2026-10-09 (`feat/outbound-stage4`): no billing code,
`users.role` never read, no deletion job, no Gemini Live reconnect (no
`goAway` / `sessionResumption` handling), no Twilio fallback URL. Live calls do
write transcripts now. Last real test round (2026-10-03, 5 calls): 5/5 pass.

**2026-10-12 (batch 3 S6):** batch 3 is LIVE — `voice-uk-prod-00101-fk2` @ `c185ff5`
(rollback `00100-nzn` @ `c755f56`). Fallback URLs are set on +441372656055 and
+18176011171. Live calls L1–L7 (10 calls; Twilio ≈$0.25, ≈$2 all-in with Gemini
— under the ~$4–5 approved): every guard did its job;
two failures found — **owner emails are never sent** (new item below) and the
10-minute end is abrupt (backlog LVX167). Details: the batch-3 plan, "S6 as built".

### 1. Code before the first paying client (~19–28 h)

**Order from here (owner, 2026-10-12, after S6):** (1) owner-email fix — launch blocker below, ~1.5–2 h;
(2) receptionist round: clean 10-min ending + warmth + ask-once + no invented names + no needless refusals +
surname (backlog LVX167–172) with the fixed lines in the receptionist's voice (LVX174) and the transfer pre-check
(LVX175), ~8–11 h over 2 sessions; (3) after a failed transfer the receptionist comes back as one continuous
conversation (LVX173, pulled forward from warm transfer part 2), ~4–6 h; (4) deploy the current dashboard;
(5) merge to `main` + shut down Railway/Supabase. Then section 3.

**Batch 3** = the first six items below (~16–23 h), built together, in that
order. Plan first (~1 h, owner reviews it), in a fresh session; the plan splits
the build into sessions of ~3–5 h (likely 5: number block; 10-min end; overflow
guard + transfer stopgap; Twilio fallback + repeat callers; one deploy + live
test calls last), each ending with tests passing, a commit and a starting
message for the next. **Owner decisions 2026-10-09:**
end calls before Google's 10-minute limit instead of reconnecting; repeat
callers are WATCHED (alerts + block list), not automatically limited; ONE rule
for every call the AI can't or shouldn't take: business's backup number, then
voicemail.

- [x] **DONE, live 2026-10-12 (S3, deployed S6).** Every dial and text is
  price-checked; production numbers checked at deploy (none needed switching on).
  The refusal itself is proven offline only; live calls dialled an allowed US mobile.
  **Block premium-rate and foreign numbers** for transfers, outbound and
  texts (abuse guards task 1, ~3 h). Today any valid number is accepted as a
  transfer number (`settingsValidation.js`) and outbound accepts any `+44`,
  including 09 and 070. That costs $0.30 to several dollars a minute, and abuse
  can get the one shared Twilio account suspended, which takes every client's
  phones down. Allow `+447624` (Isle of Man mobiles). The transfer destination
  is only ever the business's own setting (checked: never a number a caller
  says).
- [x] **DONE, live-tested 2026-10-12 (S6 L1).** Wrap note 8:43, hard end 9:30.6,
  line closed 19 s before Google's cut, never silent. The ending was abrupt (the
  soft goodbye found no gap) — clean-ending design agreed, backlog LVX167 (~3–4 h).
  Polite failure (AI won't start / drops) is proven offline only.
  **End calls before Google's 10-minute limit; never leave a line silent**
  (~5–8 h incl. tests, ~$2 of test calls, ask first). Wrap-up at ~8½ min, end at
  ~9½ (Google closed a real call at 9m49s). If the AI drops or will not start:
  apologise, take a message, hang up. Transferred calls end after 60 min.
  Replaces the 15-minute cap + reconnect (4–8 h, parked until long calls prove
  common). Evidence: call CAdfeb9d sat silent for 50 minutes after Gemini closed,
  and those minutes count toward the client's usage. Customers are told "calls
  end at 10 minutes".
- [ ] **DEFERRED by the batch-3 plan** (its "Deferred" list: ~2 h, build at ~5
  clients or before outbound is switched on). Not built.
  **Gemini overflow guard + alert** (2–3 h, rough; added 2026-10-09, owner
  approved for batch 3). Count the Live calls in progress across all clients;
  near the Gemini limit (~6 on Tier 2, see section 2), a new caller is forwarded
  to the business's own number, or voicemail if nobody answers, instead of
  risking every call in progress. Alert the owner when Gemini refuses a session.
  Why: over the per-minute token limit Google refuses work for that minute.
  Checked in code: a refused connect hangs up after a second or two with no
  message (`live_connect_failed` → `finish()` closes the Twilio socket, and
  nothing follows `<Connect>`); a call cut mid-way sits silent (`onclose` only
  logs). Which shape Google uses is unknown — never hit.
- [x] **DONE, live-tested 2026-10-12 (S6 L7a/b).** Twilio Functions on both
  accounts; fallback URLs on +441372656055 and +18176011171 (message-only: neither
  has a transfer number). Server "down" → rang the transfer number (answered), then
  no answer → message filed on the right business. Per-client rule (owner): strip
  the ring-first part for clients whose own phone rings before forwarding to us —
  runbook `docs/runbooks/twilio-fallback.md`.
  **Twilio fallback on every number** (2–3 h, rough): if our server is down,
  ring the business's own phone, then take a voicemail if nobody answers — never
  Twilio's "application error" message, which is what a caller hears today. It
  must be hosted by Twilio (a fallback URL to a TwiML Bin or Twilio Function), not
  by our server, or it dies with it. **Loop trap:** it must NOT ring the line the
  business forwards to us (forward-all bounces straight back; forward-on-no-answer
  bounces back after the rings). Onboarding asks for a "number to ring if we're
  down" that does not forward to us (owner's mobile, a direct line); the transfer
  number has the same rule. Nothing in the code sets a fallback URL; check the
  Twilio console too.
- [x] **DONE, live 2026-10-12 (S4, deployed S6).** Block list live-tested (S6 L6:
  blocked → refused before answer, $0; Verizon told the caller "this number can't
  be dialed"; unblocked → answered). Repeat-caller alerts are in the alert policy,
  proven offline only (no live trigger).
  **Watch repeat callers, don't block them** (~1 h). Alert us when one caller
  uses more than 30 AI minutes at one business in a day, or one number calls more
  than 30 times a day across all clients. A block list we control: a blocked
  number is refused before Twilio picks up (`<Reject>`, $0). Automatic limits
  (designed 2026-10-09: 30 AI min per caller per business per day, adjustable,
  trusted numbers; ~30 calls/day platform-wide; over a limit → business, then
  voicemail; never count the business's own number) only if the alerts show
  real abuse. Worst case without them: a prankster ~$40/day; a bot ~$80/hour
  while it lasts (bounded by the 10-minute end and the overflow guard).
- [x] **DONE, live-tested 2026-10-12 (S6 L2–L5).** Unanswered → message (L2);
  answered → clean end (L3); "own voicemail" choice → their voicemail at ~28 s (L4);
  transfer number forwarding back to us → refused in ~2 s, caller got the message
  line (L5). The message is filed, but the owner email never goes (item below), and
  no caller text goes because SMS is off in production (`TWILIO_SMS_FROM` unset).
  **Transfer loop guard + unanswered-transfer stopgap** (~3–4 h; owner
  approved both 2026-10-10). Loop: if the transfer number forwards back to us,
  the AI answers its own transfer, transfers again, and so on until the caller
  hangs up (exists today). A call that reaches the business from the same caller
  *while our transfer of that caller is still ringing* is our own transfer
  bouncing back: refuse it. Stopgap: today the inbound transfer is a bare `<Dial>`
  (`lib/voice/live/index.js` `redialForTransfer`, ~7332): no `timeout`, no
  `action`, nothing after it, so an unanswered transfer rings ~30 s and the call
  just ends (or lands in the staff phone's own voicemail). Stopgap: `timeout="20"`
  + an `action` that, unless the dial completed, plays "Sorry, nobody could get to
  the phone, please leave a message after the tone" and reuses the existing
  `/twilio/voicemail` recording path; a bounced transfer is refused, so it lands
  here too. The full warm transfer (section 3) reuses this `action`. That path
  (`lib/degradedVoicemail.js`) files a dashboard message with the recording link,
  emails the business and texts the caller; the line is spoken in Twilio's voice
  (Polly Amy UK / Joanna US), not the receptionist's (owner accepted 2026-10-10;
  a pre-recorded clip in the receptionist's voice, ~1 h, was skipped because the
  warm transfer replaces it). **Per-business choice (owner approved 2026-10-10,
  +~1 h):** "if nobody picks up a transferred call": *take a message for us*
  (default, the above) or *send it to our own voicemail* (ring ~45 s so their
  voicemail answers; if nothing answers, fall back to the message). Set by us at
  onboarding with the setup questions; no dashboard screen yet. Option 2 means no
  dashboard record, no caller text, and (in the warm transfer) "press 1" off.
- [x] **Owner emails are never sent — LAUNCH BLOCKER — FIXED 2026-10-13.** `28b8111`, live as
  `voice-uk-prod-00102-q9q`. Test `tests/db/ownerNotifications.test.js` (red before, green after, sabotaged).
  Live on +18175803291: a left message emailed the owner within 7 s; a blocked call sent no "Missed call" email.
  Batch-3 plan "E1 fixed". The fix exposed **LVX176**: a message-only call can email the owner a false
  "Unconfirmed booking — please contact the caller" and file a duplicate request. That is a false alarm, not a
  lost message. It is BUILT at `0fcd6f5` (with neutral "A caller may need a call back" wording for real misses)
  and not yet deployed: it ships with receptionist round A. Original entry (found 2026-10-12, S6 L2;
  ~0.5–0.75 h + one deploy + one test call). `loadBusinessNotificationConfig`
  (`services/notifications.js`) reads the business with `db.fetchBusinessById`
  outside any tenant scope; `businesses` has FORCE row-level security, so the read
  returns nothing and the email is skipped without an error. SMTP is configured;
  nothing reached the inbox or Sent folder for L1's booking or the L2/L7 messages.
  Hits all four owner emails (new appointment, unconfirmed booking, customer
  request, missed call). Fix: read inside `withTenantSafe` (as `server.js` ~1507
  does), test that reproduces it first. On the test call also prove a blocked or
  bounced call sends NO "Missed call" email.
- [ ] **Deploy the current dashboard** (2–3 h, rough). The live dashboard backend
  is from 2026-09-08. Hide the outbound-only setting cards first. (2026-10-16:
  only the D1 Calls-list date fix went live, as a backend hotfix on that base:
  `dashboard-api-uk-prod-00003-hc7` @ `f130aee`, branch `hotfix/d1-dashboard-bounds`.
  Its frontend half ships with this deploy.)
- [ ] **LVX179 (P0): the receptionist booked a time the caller never chose**
  (2026-10-16 call b), then turned the correction into a second booking.
  Fix before first paying clients. See `docs/receptionist-backlog.md`.
- [ ] **Merge `feat/outbound-stage4` into `main`, then shut down Railway and
  Supabase** once nothing points at them (1–2 h, rough). Production is built
  from this branch, 283 commits ahead of `main`. `main` still has backlog O1
  (unauthenticated endpoints that spend money); if Railway still runs `main`,
  they are open on the internet.
- [ ] Before outbound is switched on: **outbound daily cap, pacing and spike
  alert** (abuse guards task 3, ~3 h).

### 2. Owner actions before the first paying client (some take weeks; start now)

- [ ] **The Google Cloud free trial ends 2026-11-18.** Check in the Console that
  billing is a full paid account; a trial ending suspends the projects and every
  call. ~15 min. The most urgent date on this list.
- [ ] Twilio country limits (voice and SMS) on both accounts. ~10 min.
- [ ] **Daily spend alert on the Gemini project** (AI Studio "VetraTD"; ~10 min).
  The safety net for a bot attack, since repeat callers are watched, not blocked.
- [x] **Gemini Live limit — read 2026-10-09: about 6 calls at once.** Production
  uses AI Studio (`LIVE_SURFACE=aistudio`, `gemini-3.8-live`, secret `gemini-api-key`);
  the key's project is AI Studio project **"VetraTD", Tier 2**, outside every GCP
  project `vetratd@gmail.com` can see. Gemini 3.8 Live limits there: requests/min and
  /day Unlimited, **tokens/min 400K**; peak in 28 days 68.29K. One call uses ~68K
  tokens a minute, because the ~12.4K-token instructions are re-sent ~5.5 times a
  minute (measured on 97 real calls; see the finance guide). **400K ÷ 68K ≈ 6 calls at
  once across ALL clients**, inbound and outbound together; the 7th gets refused,
  and today a refusal is silence (see the long-call fix above). Our own Cloud Run
  cap (maxScale 2 × concurrency 10 ≈ 20 calls) is not the binding one. Rough fit:
  the first ~10–15 clients with margin (25 clients ≈ 5–7 at the busy hour).
- [ ] **Raise the Gemini ceiling before ~10 clients.** Tier 3 (read 2026-10-09 via
  "Compare tiers") lifts Gemini 3.8 Live to **10M tokens/min ≈ 147 calls at once**,
  so Tier 3 is the real fix. It is spend-based (check the Docs link on the Rate
  Limit page for the current rule; the AI Studio Spend page shows the total so far).
  At ~$79 of Gemini per client a month (250 calls × $0.32), it arrives roughly as
  clients do. Until then: (a) watch for more than ~8–10 clients before Tier 3;
  (b) if that happens first, trim the instructions (savings #1, 8–12 h; ~12.4K →
  ~6K tokens doubles the Tier 2 ceiling to ~12 calls) or ask Google for a higher
  limit. After Tier 3 the binding cap becomes our Cloud Run setting (~20 calls),
  a settings change plus database connections. (c) Optional: move the key into
  `vetra-uk-edc8ca` (~30 min) so production does not depend on a personal account.
  Last 30 days: 0 Live connection failures or quota refusals (calls ran one at a
  time); 2 Vertex 429s on 2026-09-12 cost one call its post-call summary.
- [ ] Form VetraTD LLC → EIN → business bank account → Stripe (invoice by hand at
  first) with Stripe Tax. Accountant: UK reverse-charge VAT, and a Texas sales
  tax permit before the first Texas client.
- [ ] Insurance quotes: professional indemnity and cyber. ~$500 cash buffer.
- [ ] Legal pack: terms (drafted in guide Part 7); DPA template (Claude drafts,
  2–3 h); accept Google Cloud, Twilio and Deepgram data processing terms; a DPIA
  template for clinic clients (health data); ask a lawyer whether a UK Art. 27
  representative is needed.
- [ ] support@vetratd.com as a real inbox someone reads, and a written "when it
  breaks" plan: who answers, how fast, and how a client forwards their line
  back to themselves.
- [ ] UK numbers need Twilio regulatory approval (business details and proof of
  address), which can take days.
- [ ] Digile: sign the pilot agreement; ask which booking systems their clinics
  use.
- [ ] **Texting registration (owner, 2026-10-13: starts once VetraTD LLC is formed,
  in the next couple of weeks).** US: A2P 10DLC brand + campaign registration in
  Twilio (needs the EIN; approval roughly 1–3 weeks; small one-time and monthly
  fees); until then US carriers block business texts. UK: decide per client between
  a UK mobile number (two-way, needs the regulatory bundle) and an alphanumeric
  sender name (one-way, no replies). +441372656055 cannot send texts (Twilio:
  `sms: false`). Then set `TWILIO_SMS_FROM` (or per-number senders). Gates the
  customer-texting track below.

### 3. First month — before about 5–10 clients (~37–54 h)

- [ ] **Owner/Staff roles** (8–12 h) before any business gets a second login.
  Today every login can change the transfer number.
- [ ] **Deletion job** (3–4 h) before the privacy page promises retention
  periods.
- [ ] **"Going nowhere" and sales-call handling** — first item after batch 3
  (~4–6 h + ~$1–3 of test calls; owner approved 2026-10-09). The receptionist may
  politely end sales pitches, abuse/pranks and recordings/bots; per-business
  sales-call setting (decline politely, or take a message); tests must show real
  callers (confused, elderly, bad line, long genuine problem) are never cut off.
  Add the free US caller-ID verification signal at the same time.
- [ ] **Warm transfer** (~10–14 h, rough, + ~$3 of test calls, ask first; owner
  approved 2026-10-10), right after "going nowhere"; builds on the batch 3 stopgap. **Part (2) is pulled
  forward as backlog LVX173 (owner 2026-10-12); what remains here is part (1), the whisper + press 1, ~6–8 h.** (1) The receptionist
  writes a one-line summary as part of the transfer; staff hear it before the
  caller is connected ("Call from Jane about moving Thursday's appointment. Press
  1 to take it.") and it is saved on the call. Pressing 1 proves a person
  answered, not a voicemail; a business may turn it off. (2) Nobody presses 1
  within ~20 s (no answer, busy, voicemail, bounced) → the caller returns to a
  new receptionist session that knows what was said and why it transferred:
  asked for a person → "nobody's free, I may be able to help, or take a
  message"; task it couldn't do → takes a message for a callback; urgent → the
  business's urgent rules. (3) Messages go through the existing take-a-message
  path (`capabilities/messages.js`: dashboard + email to the business + text to
  the caller), not voicemail. Outbound already has a basic whisper and
  `<Dial action>` (`lib/outbound/doorRoutes.js`) to reuse.
- [ ] **Billing basics** (5–7 h, rough): a plan per business, minutes used vs
  included in the dashboard, and a stored `billable_seconds` that leaves out
  spam (`/api/usage` sums every call today). Until then, invoice by hand from
  the dashboard's usage figure. **Minutes rule (owner 2026-10-10, replaces the
  10-09 free allowance and the 10-08 "transfers count"):** calls that never
  reached the receptionist (our outage, Gemini busy, blocked) don't count;
  transferred talk time counts at a third (3 min with staff = 1 plan minute).
  Needs the transfer start time recorded (~1 h). Why a third: a transferred
  minute costs ~3–5¢; beyond the plan it earns overage ÷ 3 (25¢/18¢/13¢/10¢), so
  never below cost; inside the plan a switchboard client (~1 min receptionist +
  ~5 min staff) costs ≤ the 13¢/min the prices assume. Only a whole plan of long
  (10+ min) transfers to mobiles costs more: at most ~$7 Core, $24 Pro, $60 Scale
  a month. A half was rejected: it costs a client at their limit up to ~$19/month
  to guard against that rare case.
- [ ] **30-day cancelled mode + setup question** (1–2 h; owner approved
  2026-10-09). At setup record how the business connects (A: AI as backup on no
  answer; B: AI answers everything; C: our number published) and a backup number
  that does not forward to us. On cancel, AI off for 30 days: A → voicemail
  emailed to them; B → forward to their backup number; C → forward to their new
  number or help them move it; plus "turn off forwarding" instructions and a test
  call. Release the number after 30 days or once forwarding is proven off; never
  release a number calls still forward to.
- [ ] **Website** (4–6 h, rough), after the pilot passes: `feat/site-overhaul`
  live with prices (its copy tests refuse prices today), the contact form fixed
  (it posts to a dead Railway host), a registered address added.
- [ ] **Load test** (2–3 h, ~$2–5, ask first): how many calls it takes at once
  has never been measured (backlog O7).
- [ ] **Customer texting, phase 1 — texts that work** (~8–12 h; owner approved the
  track 2026-10-13; needs the texting registration in section 2). Built and switched
  off today: five caller texts (booking confirmed / cancelled / request pending,
  message received, missed call), a per-business switch, `sms_consents`, a price
  check on every text; production sends none (`TWILIO_SMS_FROM` unset). Phase 1:
  switch them on; add text reminders (e.g. 24 h before, "reply C to confirm, R to
  reschedule"; reminders exist today only as outbound AI calls); STOP/HELP, quiet
  hours, per-business on/off + wording, consent asked on the call, the right sender
  per country; re-run S6 L6 (blocked/bounced caller gets no text). Rules: text only
  when something happened (no "thanks for calling" after every call); clinics get
  minimal content (time and place, no treatment); surveys, review requests and
  promotions are marketing and need explicit consent (TCPA / PECR); ask every
  customer for reviews, never only happy ones (Google's rules). Pricing: decide an
  included text allowance or pass-through (US ~1–2¢, UK ~4–5p a text).

### 4. Not blockers — after the first clients

- **Customer texting, phase 2 — text the AI** (~20–30 h + ~$3–5 of tests, month 2,
  after billing basics and Owner/Staff logins). Nothing receives inbound texts today
  (1171's SMS URL is a Twilio demo page, 3291's is Railway). Replies reach the same
  receptionist in text mode (cheaper text model): book, reschedule, cancel, answer,
  take a message, knowing the customer's calls and appointments; hand-off to the
  business; a conversation view in the dashboard where staff can take over; rate
  limits; the claim guard (the text channel had the "API" leak before). Needs a
  two-way sender (US registered number; UK mobile number, not a sender name).
- **Customer texting, phase 3 — extras** (~3–10 h each, when clients ask): surveys
  and review requests (marketing consent), WhatsApp (Meta approval + pre-approved
  templates; big in the UK/EU), broadcasts.

- **Gemini cost savings** (~25–40 h including a test round, ~$15): trim the
  prompt, cut wasted turns, shorter replies, screen junk calls, Deepgram shadow.
  Margin 81% → ~85%. Do it once real calls show the real mix. It comes after
  the long-call fix: the savings are ~$0.05–0.11 a call, while the bug can bill
  50 silent minutes on one call. (The finance guide's Part 13 still lists the
  savings as stage 1.)
- **Booking-system connections** (Google Calendar, Cliniko, Pabau, Dentally…):
  the most common sales objection, not a launch blocker. Build the one Digile
  and the first clients ask for; Google Calendar needs Google's review (weeks),
  so start that clock once it is picked.
- **Self-serve setup:** after ~10 setups by hand; their questions become the
  questionnaire. Includes (added 2026-10-09, owner approved):
  - **Guided forwarding page** (part of ~6–10 h, rough): a Twilio number lookup
    (~1 cent) names their phone company, and the page shows that company's exact
    steps (e.g. BT desk phone: dial `*61*<our number>#` for "when unanswered").
    We cannot set forwarding for them: it is a code dialled from their own phone
    or a setting behind their phone company's login.
  - **"Test my forwarding" button** (same estimate): we ring their public number
    from one of ours and check it reaches their receptionist (a few cents). Used
    at setup (forwarding works), at cancellation (forwarding is off), and as a
    monitor: a business that forwards every call but gets none for ~2 days →
    alert us.
  - Until then (first ~10 clients): set forwarding up together on a ~10-minute
    call, send written steps, make a test call.
- **Moving a client's number to us (porting), later:** their public number moves
  to our Twilio account, so we route everything (ring staff first, then the AI;
  pause; out-of-hours) with no forwarding codes and no loop trap. Costs: paperwork,
  1–4 weeks, a small risk of a gap while it moves, and moving it back out on
  cancellation. Kept off the website until built.
- **US clients:** A2P 10DLC registration before texting US callers (weeks).

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

**Rewritten again 2026-09-04 after a nine-call round** on the local rig, every
call transcribed and reconciled against the database. The round closed rows A, B,
C and D — every one of them a thing the assistant SAID wrongly — and put above
them the first entry on this list that is the assistant not answering at all.

**Read the two new top rows before anything else.** Rows A to D are struck
through because they are verified closed on real calls, not because they were
argued away.

| # | what they hear | entry |
|---|---|---|
| **★** | ~~says "okay" mid-call and is **said goodbye to**, then hears its whole last answer **read out again**~~ | **LVX76 — goodbye and re-read VERIFIED GONE on call 2**, 2026-09-04. A duplicate question survived and is on its second revision |
| **★★** | says "okay" or "no" and gets **ten seconds of silence**, then "I'm still here whenever you're ready" | **LVX70 · P0 — MECHANISM SETTLED 2026-09-04.** OUR gate withheld and dropped 280 ms of real speech; `LIVE_TURN_END` is irrelevant |
| **†** | it **speaks its own instructions** — "Acknowledge." / "Please pause there for a moment" | **LVX75 · P0 — SHIPPED, NOT WORKING.** Reworded, heard again on the next call. Second reword shipped; a third recurrence means the eval band |
| **A** | ~~asks "do you take my insurance?" and is told **yes, invented**~~ | **LVX66 — VERIFIED 2026-09-04 on the knowledge-row path** (call 1). The empty-table sourcing rule is still UNVERIFIED |
| **B** | ~~is told the practice is **closed on a day it is open**~~ | **LVX55 — VERIFIED** on call 1, 2026-09-04: all four hours facts correct |
| **C** | ~~is told an appointment is **"today"** when it is tomorrow, and offered times that **already passed**~~ | **LVX61 — VERIFIED** on call 2, 2026-09-04. LVX65 fixed, unverified |
| **D** | ~~asks for something the practice does not do and is **walked into a booking anyway**~~ | **LVX63 — VERIFIED** on call 5: Uber and the weather, both declined |
| 0 | ~~books the appointment **without ever asking their name**~~ | **LVX40 — VERIFIED on a call 2026-09-03**: it asked, and the row carries the name |
| 1 | ~~asks to book, gets "someone will call you back"~~ | **LVX34 — VERIFIED on a call 2026-09-03**: the gate refused, it asked for the spelling and waited, then booked |
| 2 | ~~cancels two things, is told it still has them, then cannot book~~ | **LVX33 — VERIFIED on a call 2026-09-03**: three cancelled in one turn, none left behind, and the next booking was allowed |
| 3 | four questions in one breath | **LVX25 — REPRODUCED repeatedly**, latest 2026-09-04. Seven prompt instructions already say not to. Still open |
| 3b | **"is there anything else?" closing nearly every turn**, including after a plain factual answer | the tic — five of five turns on two separate calls. No counter, and the clearest "this is not a person" signal on a demo call |
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

**Rows 0, 1 and 2 were demo-killers and they are now fixed.** They were the same
demo-killer three times: the assistant failing to do the one thing it is being
demonstrated to do. All three are verified on real calls, with the transcript
and the database row both read.

**Row A was worse than all three, and the 2026-09-04 round closed it.** The
fixed rows were failures to ACT; row A was a failure to be TRUTHFUL, which on a
demo call is the more dangerous kind because a prospect probes. On the
verification round the assistant sourced its answer from a `business_knowledge`
row and did not invent an insurer. **The empty-table case — what it says when
there is no row to source from — is still UNVERIFIED**, and that is the half a
prospect asking about an unusual insurer would actually hit.

**★ replaces every one of them, and it is a different kind of bad.** Rows A to D
are all things the assistant SAID wrongly. LVX70 is the assistant **not
answering at all**: the caller says "okay", hears nothing, and ten seconds later
is told "I'm still here whenever you're ready." A prospect reads that as broken
software before they get far enough to probe an insurance answer, and it needs no
domain knowledge to notice. It also made one call 308 seconds long instead of
about ninety, and cost on this path is quadratic in length.

**The mechanism is not established, and that is deliberate.** "Yes." ended a turn
correctly and "Ah!" ended four, so length alone does not explain it. Two
candidates are live and they have different fixes — see LVX70 in the backlog.
Nothing about turn-taking changes until an instrumented call says which.

**The structural gap that produced row A has not closed — the model simply
behaved.** Every guard built for LVX27 — the claim ledger, the write ledger,
`live_claim_without_action`, `postcall_claim_without_row` — detects claims that
an ACTION COMPLETED. Row A was a claim about a FACT, and `postcall_verify`
returned `verdict: ok` on the call that invented an insurer, correctly by its own
rules. LVX68 scopes the one narrow piece of that which IS answerable for free:
not "is it true", but "did you check anything at all".

**Row † lives in the same blind spot, one level further out.** "Acknowledge." and
"Please pause there for a moment" are ordinary English in ordinary sentences, so
`internal_term_leaks`, `live_outbound_leaks` and `intent_marker_leaks` all read 0
and were all correct. The guard family catches leaked SYNTAX and misses leaked
FRAMING — LVX54 and LVX64 exactly.

**All three are verified on real calls, with the transcript and the database row
both read.** LVX40 asked for the name and wrote it; LVX34's gate refused, the
assistant asked for the spelling and waited rather than promising a callback,
then booked; LVX33 cancelled three appointments in a single turn with none left
in the snapshot, and the booking asked for immediately afterwards reached the
availability check instead of being refused — the half the caller actually felt.

**What remains on this list, in order:** ★ LVX70 (silence on a short answer),
† LVX75 (it speaks its own instructions), 3 LVX25 and 3b the "anything else"
tic, 4 LVX35's ordering, and 7 the 1.4–2.2 s reply pause.

**And one caveat that applies to half of the strikethroughs above.** Five guards
shipped in the 2026-09-04 round never fired, because the model behaved well —
LVX56, LVX53, LVX71 and LVX74. A verified ROW is not the same as a verified
GUARD, and the two are distinguishable only where a positive counter sits beside
the fault counter. Anything new on this page gets one.

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
  reason for the architecture — and it is the one with all the rows above.
  ~~**It has no fallback: a failure is silence, not voicemail.**~~ **The
  connect-time half is built as of 2026-09-04** — a failure before the TwiML is
  returned now hands the caller to the cascade, and if neither front-end can
  mint a stream token, to voicemail. A mid-call socket drop is still silence.

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

- **Connect-time failure — BUILT 2026-09-04.** `/twilio/live-voice` now wraps
  its body and returns the cascade's `<Connect><Stream>` at
  `/twilio/media-stream` on any throw. The caller never knows. An allowlist
  refusal and an unrouted number return from *inside* the try and deliberately
  do not fall back: both are decisions, and routing them to the cascade would
  serve exactly the caller the control exists to turn away.

  **And the failure that mattered most was not a throw at all.**
  `mintMediaStreamToken` returns `null` — it does not throw — when it holds no
  signing key, and the route then emitted a well-formed but *tokenless*
  `wss://` URL. Twilio connects, the upgrade is refused with a bare 403, and
  the caller hears nothing. A try/catch would never have seen it.

  That configuration is reachable here, not hypothetical: `twilioValidationLive`
  accepts a signature from `TWILIO_AUTH_TOKEN` **or** `TWILIO_AUTH_TOKEN_ALT`,
  while the signing key is `MEDIA_STREAM_SECRET || TWILIO_AUTH_TOKEN`. **A
  deployment holding only the ALT token validates every webhook perfectly and
  cannot mint a stream token at all** — so every call is authenticated,
  accepted, and silent. With two Twilio accounts on this project that is one
  environment variable away. It is now promoted to a throw, and because both
  front-ends share the one signing key it lands on voicemail rather than the
  cascade, which would only move the silent 403 to a different socket.

  Counters `live_connect_ok` / `live_connect_fallback`. The positive twin is not
  decoration: without it a demo call that connected cleanly and a demo call that
  never reached the route at all read identically, and "did the number even
  point at us?" is the first question a failed demo raises.
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
- ~~**There is NO fallback. A Live failure is silence.**~~ **Half closed
  2026-09-04.** A failure at connect time hands the caller to the cascade, or to
  voicemail when no stream token can be minted on either path. **A mid-call
  socket drop is still silence** — that needs an `action` URL on `<Connect>`,
  which nobody has tried here, and it is deliberately not built. Tiers 2a/2b
  still do not exist.
- **The deploy topology, and the trap in it** (learned 2026-09-04):

  | | branch | URL |
  |---|---|---|
  | Railway **staging** | `feat/s2s-frontend` | `ai-phone-assistant-staging.up.railway.app` |
  | Railway **prod** | `main` | `ai-phone-assistant-production-2300.up.railway.app` |
  | GCP `voice-uk-prod` | deployed by Terraform | serves `+441372656055` |

  Both Railway services auto-deploy, and the root page prints
  `Build: <sha> (<branch>)` — **the fastest way to answer "is my commit
  deployed?", with no token.** The debug endpoint 404s when its token is wrong,
  which is indistinguishable from a missing route.

  **The trap:** merging `main` forward as a FAST-FORWARD onto a SHA that the
  staging environment has already built produces **no prod deployment**. There
  is no new commit for the webhook to react to. It cost twenty minutes on
  2026-09-04, and **Redeploy does not rescue it** — Redeploy rebuilds the
  ACTIVE deployment's commit, which is the old one, so it succeeds and changes
  nothing. The fix is an empty commit on `main`: a SHA Railway has not seen.

- **Vercel cannot deploy this repo** — private GitHub org repository on the
  Hobby plan. It is a permanently-red check on every commit. It does not block
  Railway (prod deployed `13265a3` with it already failing), but it means the
  dashboard frontend is not deploying at all.

- **There is no CI.** No `.github/workflows/`, so nothing runs the 3,169 tests
  on push. They run only when someone runs them locally.

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

**Rewritten 2026-09-03, third pass, after six calls made by a person.**

The three original demo-killers are fixed and verified on real calls. The
deployment works, the local rig works, and across six calls — including
deliberately awkward ones — **not one bad row was written**. Every appointment
carried the right name, the right time and the right number; two cancellations
in one breath both landed; changing your mind twice produced no phantom.

**And it is not demo-ready, for a reason that did not exist that morning.**

The round exposed an asymmetry worth stating plainly, because it decides what
to build next: **every guard in this system protects the database, and nothing
protects the conversation.** That is history rather than accident — each guard
was built after a defect that damaged data, so the data path is now genuinely
well defended. The conversation has no equivalent: no ledger of what the
assistant asserted, no comparison against the tenant's own configuration, and
leak guards that catch implementation VOCABULARY while missing implementation
FRAMING.

So everything that went wrong on those six calls went wrong in what was SAID:
an invented insurer, an invented service, the wrong opening hours, tomorrow
called today, times offered that had already passed, and the system describing
itself to the caller as "user" and "the calendar".

In order:

1. **LVX66 — it invents facts about the business.** Needs a decision, not just
   code: refuse every factual question the configuration cannot answer (safe,
   much less useful), ground answers in the knowledge table and refuse outside
   it (correct, needs the table populated per tenant), or detect assertions the
   way completions are detected (a new ledger, and the same pattern limits that
   made LVX57 miss half its cases).
2. **LVX55 — put the weekly hours in the prompt.** Cheap, clean, and removes two
   symptoms seen on two separate calls.
3. **LVX57 — the claim detector misses half the claims made.** It is the
   instrument every other judgement is made with.

None of it is compliance work. Only the first is large.

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
