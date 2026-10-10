# Abuse guards before the first paying client — plan (2026-10-08)

**Status: PLAN ONLY, awaiting owner approval. Nothing built.**
Source: the 2026-10-08 abuse review of the plans (guide Part 7, "Ways the plans could be abused").
Estimate: **~9 h of code** (3 tasks) + owner console actions. The Live long-call resumption fix (stage 2,
4–8 h, `memory: live-session-dies-at-ten-minutes`) is separate and still needed.

## Why these three

| Risk | Evidence in code today | Money at stake |
|---|---|---|
| Premium / high-cost dialling | Transfer number accepts any valid E.164 (`AI-phone-dashboard/backend/src/settingsValidation.js:71`, `validateE164Phone`). Outbound accepts ANY `+44` number incl. 09 / 070 / 087 (`lib/outbound/legalFloor.js:423`); EU numbers checked by country only. | Twilio bills $0.32–0.56/min (UK 070) up to several $/min (international premium); clients pay at most $0.75. Classic revenue-share fraud. |
| No call-length cap on Live inbound | `<Connect><Stream>` has no limit (`server.js:495`); `CALL_MAX_DURATION_MS` is enforced only in the cascade (`lib/voice/session.js:90`, `:2740`). Live dies ~10 min and the line stays open silent up to 60 min (call CAdfeb9d). | Calls past ~15 min cost more per minute than Scale/Enterprise earn; minutes are billed from `duration_seconds` (`services/db.js:846`), so silent tails would be billed to clients. |
| Outbound volume | Leads-in link: 30 requests/min per IP (`lib/outbound/triggerRoute.js:97`), one call per number per UTC day; **no per-campaign/per-business daily cap**, no spike alert. | A leaked trigger link or a client without consent can dial thousands → TCPA $500–1,500/call, spam labels on our numbers, Twilio suspension of the ONE account every client shares. |

## Task 1 — Block premium, shared-cost and personal numbers (~3 h)

- New pure helper `lib/phoneRisk.js`: `blockedDestination(e164) -> null | reason`.
  UK: `+449` (09 premium), `+4470` (070 personal), `+4476` (pagers), `+4484` / `+4487` (084/087), `+44118` (directory).
  **Exception: `+447624` is Isle of Man MOBILES — allow it** (it sits inside `+4476`). Legit owners of a blocked
  number (owner question 2026-10-09): the refusal must say what to do instead — transfer setting: "use an ordinary
  landline or mobile number for transfers"; outbound lead: skipped with reason `blocked_destination`, shown to the
  business so they can ring the lead themselves; caller text: not sent, booking unaffected. Inbound calls are
  never blocked. A per-business exception, set by us (not the client), only if a real client needs one (~30 min).
  US: confirm `US_MAINLAND_NANP` already excludes 900 and other non-geographic codes; add a test that pins it.
  EU: no per-country premium table yet → owner decision: either restrict EU to mobile + geographic ranges per
  country, or rely on Twilio geo permissions (owner action below) until an EU client exists.
- Apply it at every place we dial or text a number we did not receive a call from:
  1. `settingsValidation.js` `transfer_phone_number` — refuse a blocked number AND a number in a different country
     from the business's own number (message: "Transfer numbers must be ordinary UK/US numbers in your country").
  2. `lib/outbound/legalFloor.js` `floorFor` (or `gate.js` `evaluateGate` before `floorFor`) — refuse
     `blocked_destination`, fail closed.
  3. `lib/outbound/triggerRoute.js` — refuse at intake so the contact never gets an outreach row.
  4. `services/notifications.js` `sendCallerSms` — refuse blocked destinations (SMS-pumping guard).
- Tests: a table of real-format numbers per range (blocked + allowed neighbours), and a sabotage row per call
  site (remove the check, the test must fail) — `memory: sim-must-be-able-to-fail`.

## Task 2 — Cap call length; never bill silence (~3 h)

- Live inbound: a per-call timer in `lib/voice/live/index.js` from call start. At `CAP − 2 min` ask the
  receptionist to wrap up at the next turn boundary (NOT inside a tool reply — `memory: live-instruction-timing`);
  at `CAP` end the call via Twilio REST (`status: "completed"`). New env `LIVE_CALL_MAX_MINUTES` (proposed 15),
  separate from the cascade's `CALL_MAX_DURATION_MINUTES` (30).
- On `live_close_abnormal` (`lib/voice/live/index.js` ~7918) when the session is not resumed: play the
  degraded-mode line / voicemail fallback and end the call, so the line never sits silent (and is never billed silent).
- Transfers: add `timeLimit` (proposed 60 min) to the `<Dial>` in `lib/twiml.js` `buildUnroutedTransferTwiml`
  and to whichever builder the Live transfer path uses (grep `transferNumber()` callers first).
- Tests: fake clock drives the timer (wrap-up note sent once, hang-up once); onclose path ends the call;
  TwiML snapshot carries `timeLimit`. One paid sim (~$0.10, ask first) that a 15-min cap actually fires.

## Task 3 — Outbound daily cap, pacing, spike alert (~3 h)

- `lib/outbound/campaignSchema.js`: new `daily_cap` (default 50 in early access, bounded in `CAMPAIGN_LIMITS`)
  and a per-business ceiling across campaigns.
- `lib/outbound/gate.js`: refuse/queue to tomorrow when today's dials for the business reach the cap
  (count from the outreach attempts table, business-local day); log `outbound_daily_cap_reached`.
- Pacing: at most N simultaneous outbound calls per business (proposed 2) so a campaign cannot take capacity
  inbound callers need; inbound always wins.
- `lib/outbound/triggerRoute.js`: `outbound_trigger_spike` when one campaign receives > X submissions in an hour.
- Owner: add both events to the one log-match alert policy (bare policy id — `memory: outbound-calling-plan`).
- Tests: cap reached → no dial, row queued; spike → event once per hour; sabotage rows.

## Billing rules to carry into the billing build (no code now)

- Billable time = `duration_seconds` for every call in both directions, **including time after a transfer**
  (owner decision 2026-10-08), counted by the second; outbound dials nobody answers = 0.
- Exclude calls the spam filter caught → store a per-call `billable_seconds` instead of reusing
  `duration_seconds`, so exclusions and the silent-tail fix do not rewrite the call record.
  Today `/api/usage` (`AI-phone-dashboard/backend/src/routes/analytics.js:116`) sums ALL `duration_seconds`.
- "Best price" month: if extra minutes would exceed the next plan's price, charge that plan's price for the month.

## Related builds decided 2026-10-08 (separate from the 9 h above)

- **Data retention job (~3–4 h):** nightly delete — transcripts, summaries, call records, messages after 12 months;
  Twilio voicemail recordings after 30 days; on cancellation, 30-day export window then delete. KEEP: outbound consent
  proof (consent row + the disclosure part of the transcript) 4 years after the last call (TCPA limitation — ledger
  O18), suppression hashes while outbound is used, PHI access log 6 years, billing 6 years. Then update the privacy
  page (`content/legal/privacy.jsx` on feat/site-overhaul, which says "no automatic expiry today").
- **Owner/Staff logins (~8–12 h):** email invites + role checks. `users.role` exists (default `staff`) but nothing
  reads it — every login can do everything today, including changing `transfer_phone_number` (Task 1's risk).
  Owner: settings, billing, exports, deletion, invites. Staff: calls, bookings, messages, edit bookings.
  Must ship before any business gets a second login. Unlimited logins on every plan.

## Owner actions (not code)

1. Twilio console, BOTH accounts (`memory: twilio-account-topology`): Voice geographic permissions — allow only the
   countries we call (UK, US; EU only when needed) and keep high-risk / premium number ranges blocked if offered.
   Same for SMS geographic permissions.
2. Approve the numbers: `LIVE_CALL_MAX_MINUTES` 15, transfer limit 60 min, `daily_cap` 50, pacing 2.
3. Add the two new alert events to the alert policy after deploy.
