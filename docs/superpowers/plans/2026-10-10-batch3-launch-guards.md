# Batch 3 — launch guards before the first paying client — implementation plan (2026-10-10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** before the first paying client, no caller ever hears silence, a dead transfer or Twilio's
"application error", no call runs into Google's 10-minute cut, and nobody can make us dial or text an
expensive number.

**Architecture:** every "the AI can't or shouldn't handle this" path ends in ONE place — a short spoken line
in Twilio's own voice plus a recorded message that lands in the dashboard, email and a caller text
(`/twilio/voicemail`, fixed first because it has never worked). The Live front-end gets a per-call clock and a
"polite failure" that redirects the call over Twilio REST (no cross-instance state). Transfers become
`<Dial timeout action>` with one shared builder for both front-ends. Every number we dial or text is checked
against a committed snapshot of Twilio's price list. A Twilio-hosted Function answers when our server cannot.

**Tech stack:** Node 20 ESM, Express, Twilio Node SDK, Postgres 16 (Cloud SQL, RLS FORCE, `vetra_app`
NOBYPASSRLS), vitest + supertest, Twilio Functions (serverless, "Protected").

**Spec:** `docs/readiness.md` → "Launch checklist" §1 (first six items) as amended by the owner on 2026-10-10
(below). `docs/superpowers/plans/2026-10-08-abuse-guards.md` tasks 1–2 are SUPERSEDED where they disagree.

## Status

| Session | Content | Hours | Status |
|---|---|---|---|
| S1 | Voicemail fix + transfer stopgap + per-business choice + 60-min transfer limit | 4–5 | not started |
| S2 | 10-minute end + polite failure (never a silent line) | 4.5–5.5 | not started |
| S3 | Number block (price check at every dial and text) | 3.5–4 | not started |
| S4 | Loop guard + block list + repeat-caller alerts | 3.5–4.5 | not started |
| S5 | Twilio fallback Function + fallback-URL script + runbook + checkpoint (full sabotage, final review) | 3–4 | not started |
| S6 | ONE deploy (gcloud, main checkout) + live test calls (~$4–5, approved separately) | 3–4 | not started |
| | **Total** | **21.5–27** | |

**Execution (owner 2026-10-10):** subagent-driven, faster variant (sonnet implementers + reviewers; opus
reviews S2's Tasks 2.1–2.2 and the S5 final review; census per task; one full sabotage at S5). Owner answers
2026-10-10: numbers are bought by hand, not through the app (finding 6); the cascade's 10-minute cap by env
at deploy — yes. Line numbers in this plan are at `a238b80`; if another fix lands first, re-locate by the
quoted code, not the number.

Each session ends with: tests passing in the gate worktree, a commit, this table updated, and the next
session's starting message (bottom of this file) refreshed with anything that changed.

---

## Owner decisions (planning session 2026-10-10) — final

1. **Number block, simple version now.** Every dial/text is checked against Twilio's price for that number:
   ≤10¢/min automatic; 10–60¢/min only if WE switch it on for that client (`businesses.allow_pricier_numbers`);
   never above 60¢/min and never premium / personal / pager / satellite / shared-cost / special-rate (>10¢).
   Texts: any country ≤25¢ per text, absorbed; above that, no text (booking/message unaffected).
   Inbound calls are never blocked by price. Outbound stays UK/US/EU (law: `legalFloor.js` already refuses
   other countries). The "allow everything and charge the client" system (daily pricier-minute caps,
   pass-through billing, $10/month free) is DEFERRED to billing/self-serve. Isle of Man mobiles (+447624)
   are 32¢/min to call → switch-on band; texting them (5.6¢) works automatically.
2. **Deferred:** the Gemini overflow counter (keep the refusal alert; S2's polite failure already handles a
   refused session), the catch-up job for outage voicemails (manual check of Twilio after an outage),
   extensions reached by DTMF digits. Each has a build trigger in "Deferred" below.
3. **One number** — the existing `transfer_phone_number` — is used for transfers, (later) overflow, and the
   server-down fallback. No separate backup field. Loops are stopped by the server-side loop guard (S4) and,
   in the Twilio fallback, by the caller-ID trick (the fallback rings with OUR number as caller ID; a call
   that comes back "from ourselves" or from the dialled number is rejected). Onboarding asks for a number that
   reaches a person directly.
4. **Twilio console set-up by owner clicks** (~20 min, S6), with click-by-click steps in the runbook.
5. Per-business "if nobody picks up a transfer": `take_message` (default, ring 20 s) or `own_voicemail`
   (ring 45 s; if nothing answers, fall back to the message). Set by us; no dashboard screen.
6. Gemini limit default 5 (only matters when the overflow counter is built). `calls.transferred_at` recorded
   now (feeds the 30-AI-minute alert and later billing).

**Decisions the plan makes on its own (say if you object):** outbound Live calls get the same 9½-minute end,
and on an AI drop they apologise and hang up (no voicemail — we rang them); the cascade's cap is set to 10 min
by env at deploy; the transfer number is checked at dial time, not only at save; alerts carry only the
caller's last 4 digits + call SID; the block list is a DB table set by an admin script.

---

## What the code shows (verified 2026-10-10 at `a238b80`) — findings that changed the plan

1. **The voicemail path has never filed a message.** `/twilio/voicemail` (`server.js:834-887`) is used as a
   `<Record recordingStatusCallback>` (`lib/twiml.js:82`, `:142`) and looks the business up by `req.body.To`
   (`server.js:837`). Twilio's recording-status callback carries only AccountSid, CallSid, Recording*
   (Twilio docs, checked 2026-10-10) — no `To`/`From`. So `business` is always null and the route logs
   `degraded_voicemail_no_business` and files nothing. 60 days of production logs: zero hits on any
   `degraded_voicemail*` event, i.e. never exercised. Batch 3 routes four new paths into it → fixed first (S1).
2. **`/twilio/voicemail` accepts only account A** (`twilioValidation`, `server.js:359`, `:834`), while
   `/twilio/live-voice` accepts both (`twilioValidationAnyAccount`, `:445`, `:533`) and points recordings at it
   (`:593`, `:636`). An account-B number's voicemail would 403. Fixed in S1.
3. **Inbound transfer is a bare `<Dial>`** — Live `lib/voice/live/index.js:7331-7332`, cascade
   `lib/voice/session.js:2612` — no `timeout`, `action` or `timeLimit`. Both show the caller's number
   (`callerId`), so a bounced transfer arrives `From` = caller. Two byte-for-byte tests pin today's strings
   (`tests/outboundTransfer.test.js:307-328`, `tests/session.test.js:1489`) and must be changed deliberately.
4. **Live has no call clock.** `t0` (`index.js:776`) is `performance.now()` at socket open; no wall-clock
   timer, no `goAway`/`sessionResumption` (grep: docs only). `onclose` (`:7918-7934`) never calls `finish()`;
   `live_connect_failed` (`:7965-7968`) and `start_failed` (`:8588`) call `finish()`, which closes the Twilio
   socket (`:8571-8575`) and, with nothing after `<Connect>` (`server.js:495-498`), hangs up after silence.
   No test drives `onclose` or a connect failure; `tests/helpers/liveBoot.js` `fakeLive` (`:45`) captures only
   `onmessage`. → S2 includes harness work.
5. **A REST client exists in the Live closure** (`twilioClient` seam `:710`, `twilioClientFor` `:719`) but is
   used only by `redialForTransfer`. S2 extracts one `redirectCall(twiml)` helper for transfer, hard end and
   polite failure — REST redirect means no state has to cross Cloud Run instances.
6. **Numbers bought through the app would answer on the OLD front-end and get no fallback.** `purchaseNumber`
   (`services/twilioNumbers.js:59-65`) sets `voiceUrl: VOICE_URL` = `${BASE_URL}/twilio/voice`
   (`server.js:145`), the cascade, and no `voiceFallbackUrl`. **Owner 2026-10-10: numbers are not bought
   through the app now** (no screen for it); we buy them by hand in the Twilio console, so the runbook sets the
   voice URL (`/twilio/live-voice`) and the fallback URL by hand. No code change in batch 3. PARKED (not
   fixed, `memory: record-and-park-not-fix`): the endpoint `POST /api/businesses/:id/phone-numbers/buy`
   (`server.js:1338`, behind `requireBusinessAccess`) still exists, so a logged-in client could buy a number
   on our account through the API; fix or remove it before self-serve.
7. **Only one SMS choke point.** Every text goes through `sendSms` (`services/notifications.js:150-159`, the
   only `messages.create` in the repo), account-A client, `from: TWILIO_SMS_FROM`. One check there covers
   caller texts and owner notification texts.
8. **The dashboard backend is a separate build** (`cloudbuild.dashboard.yaml`, `AI-phone-dashboard/backend`)
   and cannot import root `lib/`; its live version is still `e1419d9`
   (`docs/superpowers/plans/2026-09-24-outbound-part1-golive-commands.md:477`). Its save-time check needs a
   vendored copy of the price module and only takes effect when the separate "deploy the current dashboard"
   checklist item runs. The dial-time check in the voice service is the real guard.
9. **`scripts/set-business-config.js` cannot set any phone field** (`FIELDS`, `:74-91`) and does no value
   validation (`:117-140`). We set first clients through it, so S1/S3 add the new fields with validation.
10. **Twilio's price list** (pulled 2026-10-10, account B, USD, 233 countries, 14,189 prefixes): UK landline
    1.6¢, UK main mobile ranges 3.05¢ but ~36 "Mobile – Other" ranges 32¢ (incl. **+447624 Isle of Man**),
    UK 070 personal 55.8¢, UK 09 $1.05, UK 084/087 26¢, UK 03 3.7¢; US/Canada 1.4¢ (Alaska 9.45¢, Yukon
    15.3¢); EU mobiles 16–59¢. Twilio does not price US 900/976 separately (they fall under `+1` 1.4¢) → an
    explicit NANP never-list is needed.

---

## Global constraints

- Plan-only rules for build sessions: no paid API calls, no real calls, no production writes until S6; S6's
  live calls need the owner's separate approval of the stated cost (`memory: ask-before-spending-api-money`).
- Production is built from `feat/outbound-stage4`. Build images ONLY from the main checkout
  `C:\Users\nithi\VetraTD\ai-phone-assistant` with `git status --porcelain --untracked-files=no` empty
  (`memory: prod-migration-checksums-crlf`). Never `--renormalize` `database/002-012`.
- Run tests in the isolated gate worktree `C:/Users/nithi/VetraTD/ai-phone-gate` with a `node_modules`
  junction; delete the junction BEFORE `git worktree remove` (`memory: sdd-gates-and-memory-limits`).
  Serialize heavy vitest runs. Check `ls node_modules | wc -l` (~269) at session start.
- **Commit before any sabotage**; assert the sabotage edit landed (`grep -c`) before reading a red/green
  result (`memory: never-git-checkout-uncommitted-work`). Sabotage rows are applied with
  `String.prototype.replace` — no `$\``, `$&`, `$'` in a row's `replace`. Never `import()` sabotage.mjs.
- After any edit to `lib/voice/live/index.js`, `lib/voice/live/tools.js` or `lib/voice/strings.js`, run
  `node scripts/corpus/sabotage.mjs --census` (< 1 s). Insert new code so no existing anchor moves inside a
  replaced span.
- Every migration is folded into `database/schema.sql` in the same commit (`tests/schema.test.js`,
  `tests/db/schemaParity.test.js`); `SET LOCAL lock_timeout = '5s'` in the migration, never in schema.sql
  (`tests/outboundMigrationsStatic.test.js`). Next free number: **052**.
- Every tenant write is scoped (`withTenant` / `withTenantSafe`); under FORCE RLS an unscoped write matches
  0 rows and "succeeds" (`memory: unscoped-writes-now-fail-closed`).
- Caller numbers never appear whole in logs or URLs (Cloud Run request logs keep full URLs). Logs use
  `callerLast4` + `callSid`.
- Spoken lines Twilio says itself use the business's locale voice (`lib/voice/localeProfiles.js:34` Joanna,
  `:49` Amy). English only in batch 3; the builders take the line as a parameter so a translation is a
  strings change later.
- Never print secrets. The price-table refresh script reads `.env` and prints counts only.
- Guards that protect money fail CLOSED (refuse to dial/text). Guards that could stop a caller reaching the
  business fail OPEN (answer the call) — except the explicit block list. Each task says which.

## Review focus (most likely to bite a real caller; each has a test in its owning task)

1. **The 9½-minute hard end fires after a transfer** and hangs up a caller talking to staff → the clock must
   stop in `finish()` and check `closed`. Test: transfer at 9:20 → no REST update at 9:30 (Task 2.1).
2. **A Gemini close that we caused** (finish → `closeLiveSession`, clip-drain end) **or that happens after a
   transfer is read as a drop** and the call is yanked into voicemail → polite failure only when `!closed`.
   Tests: clean finish then onclose → no redirect; transfer then onclose → no redirect (Task 2.2).
3. **The Dial action after a REAL conversation plays "leave a message"** → `DialCallStatus=completed` must
   hang up. Test (Task 1.4).
4. **The polite-failure REST update fails** (Twilio 5xx, wrong account) → the call must still end (socket
   close), never sit silent; alert event logged. Test (Task 2.2).
5. **A stale pending-dial row blocks a real caller forever** (crash before the action fires) → rows expire at
   `timeout + 15 s`; expired rows never match. Test (Task 4.2).

Also for reviewers on every task: fail-open vs fail-closed per the rule above; both front-ends (Live AND
cascade) and both Twilio accounts; a `?.` hiding a missing wire (`memory: a-fix-can-be-the-next-defect`);
tests that build a bare `express()` instead of importing `server.js` (`memory: plan-verbatim-code-fails-open`).

---

## File map

| File | Change | Session |
|---|---|---|
| `server.js` | `/twilio/voicemail` fix + any-account; new `/twilio/transfer-result`; webhook guards on `/twilio/live-voice` + `/twilio/voice`; repeat-minutes alert in `/twilio/status` | S1, S4 |
| `lib/twiml.js` | `buildTransferTwiml`, `buildMessageTwiml`, `buildHangupLineTwiml`, `voicemailCallbackUrl`, `CALL_LINES` | S1 |
| `lib/outbound/twilioAccounts.js` | `twilioClientForAccountSid(accountSid)` export | S1 |
| `lib/voice/live/index.js` | transfer via builder; `redirectCall`; call clock wiring; polite failure; price check; pending dial | S1–S4 |
| `lib/voice/live/callClock.js` (new) | pure 3-stage per-call scheduler | S2 |
| `lib/voice/session.js` | cascade transfer via builder; price check; pending dial | S1, S3, S4 |
| `lib/dialCost.js` + `lib/dialCostTable.json` (new) | price check + committed snapshot | S3 |
| `AI-phone-dashboard/backend/src/dialCost.js` + `dialCostTable.json` (new, vendored, byte-identical) | save-time check | S3 |
| `scripts/refresh-dial-costs.mjs` (new) | regenerates both snapshots from Twilio's Pricing API | S3 |
| `services/notifications.js` | `sendSms` text check | S3 |
| `lib/outbound/dispatch.js`, `gate.js`, `triggerRoute.js`, `campaignSchema.js` | destination fact + refusals | S3 |
| `AI-phone-dashboard/backend/src/settingsValidation.js`, `routes/settings.js` | transfer/notification number checks | S3 |
| `services/db.js` | `loadConfig` new fields; `markCallTransferred` sets `transferred_at`; pending-dial + guard helpers | S1, S4 |
| `database/052_*.sql`, `053_*.sql`, `054_*.sql` + `schema.sql` | new columns/tables/functions | S1, S3, S4 |
| `scripts/set-business-config.js` | new fields + validation | S1, S3 |
| `scripts/block-caller.js` (new), `scripts/fallback-urls.js` (new) + `Dockerfile` + `.dockerignore` | admin scripts via migrate job | S4, S5 |
| `twilio/fallback/fallback.js` (new) | Twilio Function source | S5 |
| `tests/helpers/liveBoot.js` | capture `onclose`, rejectable connect, inject `twilioClient` | S2 |
| `scripts/corpus/sabotage.mjs` | one row per guard | all |
| `docs/runbooks/twilio-fallback.md` (new), `docs/readiness.md` | owner steps; status | S5, S6 |

---

## Session 1 — voicemail fix + transfer stopgap (4–5 h)

### Task 1.1 — `/twilio/voicemail` finds its business and caller (1–1.5 h)

**Files:** modify `server.js:834-887`, `lib/twiml.js`, `lib/outbound/twilioAccounts.js:145-160`;
test `tests/degradedMode.test.js:223+`, `tests/db/degradedVoicemail.test.js`.

**Interfaces — produces:**
```js
// lib/twiml.js
export function voicemailCallbackUrl(baseUrl, twilioNumber) // `${base}/twilio/voicemail?to=${encodeURIComponent(twilioNumber)}`
// lib/outbound/twilioAccounts.js (router object)
twilioClientForAccountSid(accountSid) // -> client for A or B by SID; null if neither matches
```
Route resolution order: `twilioNumber = req.body.To || req.query.to`; `caller = req.body.From ||
(await client.calls(CallSid).fetch()).from || null`, client from `twilioClientForAccountSid(req.body.AccountSid)`.
A failed fetch files the message with a null callback number (still filed — fail soft for the message).
Middleware → `twilioValidationAnyAccount`. Every existing caller of the voicemail builders passes
`voicemailCallbackUrl(BASE_URL, To)` (`server.js:593`, `:636`, `:727`, `:803`).

- [ ] Step 1: failing tests in `tests/degradedMode.test.js`: (a) recording-status-shaped body `{CallSid,
  AccountSid, RecordingUrl}` + `?to=+441372656055` → `fileDegradedVoicemail` called with that business and the
  caller from a fake `calls().fetch()`; (b) fetch throws → still filed, `callerNumber: null`; (c) old shape
  (body has To/From) unchanged; (d) unknown `to` → `degraded_voicemail_no_business` logged, 200.
- [ ] Step 2: run, see (a)(b) fail. Step 3: implement. Step 4: green, plus the DB test as `vetra_app`.
- [ ] Step 5: signature test — a request signed with account B's token over the FULL URL including `?to=`
  passes; tampering with `to` fails (proves the query is covered by the signature).
- [ ] Step 6: sabotage row `vm-callback-to-param`: replace `req.body.To || req.query.to` with `req.body.To`
  → red `tests/degradedMode.test.js`. Commit first, census, run `--only`.

**Reviewer risks:** the validator must sign the URL Twilio called (BASE_URL + originalUrl with query);
`twilioClientForAccountSid` must not fall back to A for an unknown SID (wrong account = wrong caller);
no caller number in any log line.

### Task 1.2 — shared TwiML builders (0.5–1 h)

**Files:** `lib/twiml.js`; test `tests/twiml.test.js` (new).

```js
export const CALL_LINES = Object.freeze({
  noAnswer: "Sorry, nobody could get to the phone. Please leave your name, number and a short message after the tone.",
  cantTransfer: "Sorry, I can't put you through right now. Please leave your name, number and a short message after the tone.",
  technical: "I'm sorry, we're having a technical problem. Please leave your name, number and a short message after the tone, and the team will get back to you.",
  technicalOutbound: "I'm sorry, we're having a technical problem. We'll be in touch. Goodbye.",
  timeUp: "I'm sorry, we've reached the time limit for this call. Thank you for calling. Goodbye.",
});
export function buildTransferTwiml({ number, callerId, ringTone, timeoutSec = 20, actionUrl, timeLimitSec = 3600 })
//  <Response><Dial ringTone timeout timeLimit action method="POST" [callerId]>NUMBER</Dial></Response>
export function buildMessageTwiml({ line, sayVoice, callbackUrl, maxLengthSec = 120 })
//  <Response><Say voice>line</Say><Record maxLength playBeep="true" recordingStatusCallback/><Hangup/></Response>
export function buildHangupLineTwiml({ line, sayVoice }) // <Say/><Hangup/>
```
`buildDegradedVoicemailTwiml` / `buildUnroutedVoicemailTwiml` keep their exact wording and become thin
wrappers over `buildMessageTwiml`; `buildUnroutedTransferTwiml` gains `timeLimit="3600"`.

- [ ] Tests: every interpolation escaped (a number containing `"` or `<`); attribute order fixed (snapshot
  strings); `timeLimit` present on every Dial builder; existing degraded/unrouted strings unchanged except the
  callback URL now carries `?to=`.

### Task 1.3 — transfers use the builder, on both front-ends (1 h)

**Files:** `lib/voice/live/index.js:7327-7333` (inbound branch only), `:7324-7326` (outbound: add
`timeLimit="3600"` only); `lib/voice/session.js:2600-2622`; tests `tests/outboundTransfer.test.js:307-328`,
`tests/session.test.js:1489`, `tests/liveHangup.test.js:174-227`.

Inbound TwiML becomes `buildTransferTwiml({ number, callerId: state.callerNumber, ringTone:
resolveRingTone(state.config), timeoutSec: state.config?.transferNoAnswer === "own_voicemail" ? 45 : 20,
actionUrl: `${base}/twilio/transfer-result` })`, base from the same resolver the outbound branch uses
(`outboundBaseUrl(env)`, `:7312`). Cascade: same builder with `state.ringTone`, `config.transferPhoneNumber`.

- [ ] Update the two byte-for-byte expectations to the NEW captured strings (deliberate change; say so in the
  commit). Add: `own_voicemail` → `timeout="45"`; missing config → 20.
- [ ] Sabotage row `transfer-has-action`: remove `actionUrl:` from the Live inbound call → red
  `tests/outboundTransfer.test.js`. Row `cascade-transfer-has-action` likewise → red `tests/session.test.js`.

**Reviewer risks:** the outbound branch must stay byte-for-byte except `timeLimit`; `callerId` absent when
`state.callerNumber` is null (anonymous callers) must not produce `callerId=""`.

### Task 1.4 — `/twilio/transfer-result` (1 h)

**Files:** `server.js` (new route next to `/twilio/voicemail`); test `tests/transferResult.test.js` (new,
supertest against the real `app`, pattern of `tests/twilioStatus.test.js:1-60`).

```js
app.post("/twilio/transfer-result", twilioValidationAnyAccount, async (req, res) => {
  // DialCallStatus "completed" -> <Hangup/>; anything else -> buildMessageTwiml(CALL_LINES.noAnswer,
  // profile voice of the business found by req.body.To, voicemailCallbackUrl(BASE_URL, req.body.To)).
  // Business lookup failure -> same message TwiML with the en-GB/en-US guess used at server.js:587-589.
  // Never a 500, never an empty body. (S4 adds: end the pending dial for this CallSid.)
});
```
- [ ] Tests: completed → exactly `<Response><Hangup/></Response>`; `no-answer`, `busy`, `failed`, `canceled`
  → message TwiML with the business's voice and `?to=` callback; lookup throws → message TwiML (200).
- [ ] Sabotage row `transfer-result-completed-hangs-up`: change the completed check to always false → red.

**Designed for the warm transfer (first month):** it keeps `buildTransferTwiml` and this route, adds a
`<Number url=whisper>` (the outbound branch already has one, `index.js:7317-7318`) and one more branch here —
"nobody pressed 1" → back to a new receptionist session instead of the message TwiML. Keep the route's
decision a small pure function `transferOutcome(body, business) -> "hangup" | "message"` so that branch is an
added case, not a rewrite.

### Task 1.5 — migration 052: transfer choice + transfer time (0.5–1 h)

**Files:** `database/052_transfer_no_answer_and_transferred_at.sql`, `database/schema.sql`,
`services/db.js:485-547` (`loadConfig`), `:904-906` (`markCallTransferred`), `scripts/set-business-config.js`.

```sql
SET LOCAL lock_timeout = '5s';
ALTER TABLE businesses ADD COLUMN transfer_no_answer text NOT NULL DEFAULT 'take_message'
  CHECK (transfer_no_answer IN ('take_message', 'own_voicemail'));
ALTER TABLE calls ADD COLUMN transferred_at timestamptz;
```
`markCallTransferred`: `SET status = 'transferred', transferred_at = COALESCE(transferred_at, now())`.
`loadConfig` adds `transferNoAnswer: business.transfer_no_answer || "take_message"` (and to the null-business
defaults at `:499`). `set-business-config.js`: add `transfer_no_answer` (value must be one of the two) and
`transfer_phone_number` (strict E.164 now; S3 adds the cost check) to `FIELDS`, validated before any write.

- [ ] Tests: schema static + parity (`npm run test:db` with local Postgres on 55432); `markCallTransferred`
  keeps the FIRST time on a second call; set-business-config refuses `transfer_no_answer=maybe`.

### Session 1 close
- [ ] Full gate (root vitest + `test:db`) in the gate worktree; census; commit; Status table; refresh the S2
  starting message.

---

## Session 2 — 10-minute end + never a silent line (4.5–5.5 h)

### Task 2.0 — harness (0.5–1 h)

**Files:** `tests/helpers/liveBoot.js:26-160`. `fakeLive` also captures `callbacks.onclose` and exposes
`live.close({code, reason})`; `connect` can be made to reject (`connectGate: "reject"`); `bootLive` accepts
`twilioClient` (records `calls(sid).update({twiml})`) and a fake timer source. No behaviour change to existing
tests (run the Live suites before and after; same counts).

### Task 2.1 — per-call clock: wrap-up 8:30, goodbye 9:00, hard end 9:30 (2–2.5 h)

**Files:** create `lib/voice/live/callClock.js`; modify `lib/voice/live/index.js` (start after the session
opens at `~:7937`, stop in `finish()` next to `clearTimeout(exitTimer)` at `:8129`); test
`tests/liveCallClock.test.js` (new).

```js
// lib/voice/live/callClock.js
export const DEFAULT_WRAP_UP_SEC = 510, DEFAULT_GOODBYE_SEC = 540, DEFAULT_HARD_END_SEC = 570;
export const GOOGLE_LIMIT_SEC = 589; // observed close 9m49s (CAdfeb9d); never schedule at/after this
export function resolveClockConfig(env) // LIVE_CALL_WRAP_UP_SEC / _GOODBYE_SEC / _HARD_END_SEC; enforces
                                         // wrap < goodbye < hardEnd < GOOGLE_LIMIT_SEC, else defaults + log
export function createCallClock({ setTimer, clearTimer, config, onWrapUp, onGoodbye, onHardEnd })
  // -> { start(), stop() }; each callback fires at most once; stop() is idempotent
```
Wiring in `index.js`:
- **Wrap-up (8:30):** sets `timeNoteDue = "wrap"`; delivered at the next model `turnComplete` (the
  `closeLiveGeneration` boundary, `:5957`) as `sendClientContent({ turns: [{ role: "user", parts: [{ text:
  "(System: this call has about one minute left. Tell the caller briefly and, if they still need anything,
  offer to take a message now.)" }] }], turnComplete: true })`; if no turn completes within 20 s, sent anyway.
  Own path, NOT `sendTurnNote` (its per-call cap of 8 and once-per-turn latch must not swallow it).
- **Goodbye (9:00):** note "(System: the time limit is reached. Say one short, warm goodbye sentence now.)" and
  `exitAfterTurn = true` (the existing turn-boundary exit, `:2618` pattern) so the normal closing path hangs up.
- **Hard end (9:30):** `if (!closed)` → `redirectCall(buildHangupLineTwiml({ line: CALL_LINES.timeUp,
  sayVoice }))`, log `live_max_duration_hard_end`, then `finish("max_duration")`.
- New helper `redirectCall(twiml)`: the client resolution now inside `redialForTransfer` (`:7299-7303`)
  extracted unchanged; `redialForTransfer` calls it. Outbound uses `twilioClientFor(dial.config?.caller_id)`.
- Applies to inbound AND outbound Live sessions.

- [ ] Tests (fake clock): wrap note sent once, at a turn boundary; goodbye note + exit armed; hard end updates
  the call with the timeUp TwiML exactly once and finishes; **transfer at 9:20 → no update at 9:30** (Review
  focus 1); caller hangs up at 5:00 → no timers fire; env `LIVE_CALL_HARD_END_SEC=600` → refused, defaults used.
- [ ] Sabotage rows: `clock-stopped-in-finish` (remove the `stop()` in finish → red transfer-at-9:20 test);
  `hard-end-checks-closed` (drop `!closed` → red); `clock-config-under-google-limit` (drop the bound → red).
- [ ] Census (index.js edited).

**Reviewer risks (opus review for this task):** the wrap note sent while Live is generating cuts the reply
(`memory: live-instruction-timing`); timers created per call must be cleared on every finish path (11 callers,
`:2414`…`:8614`); `exitAfterTurn` must not collide with LVX132's ask-gate refusal (`services/tools.js`) — a
refused end_call after the goodbye leaves the hard end as the backstop, which is acceptable but must be tested.

### Task 2.2 — polite failure: AI won't start or drops (1.5–2 h)

**Files:** `lib/voice/live/index.js` `onclose` (`:7918-7934`), connect catch (`:7965-7968`), start failure
(`:8588`); test `tests/livePoliteFailure.test.js` (new).

```js
async function politeFailure(reason) {           // at most once per call (latch)
  if (closed || politeFailureSent) return;
  politeFailureSent = true;
  const twiml = state.outboundCall
    ? buildHangupLineTwiml({ line: CALL_LINES.technicalOutbound, sayVoice })
    : buildMessageTwiml({ line: CALL_LINES.technical, sayVoice,
        callbackUrl: voicemailCallbackUrl(base, state.twilioNumber) });
  try { await redirectCall(twiml); log.error("live_polite_failure", { callSid, reason, severity: "warn" }); }
  catch (err) { log.error("live_polite_failure_failed", { callSid, reason, message: err?.message }); }
}
```
- `onclose`: if `!closed` (we did not close it: our closes happen only after `closed = true`, `:8055`,
  `:8140`, `:1746`) → `politeFailure("live_dropped").finally(() => finish("live_dropped"))`, for ANY close code
  (a clean 1000 from Google mid-call is just as silent). Keep the existing counters/logs.
- connect catch and start failure: `await politeFailure(...)` before `finish(...)`, only when `callSid` is known.
- [ ] Tests: connect rejects → one update with the technical message TwiML (inbound) / hang-up line (outbound),
  then finish; Gemini closes 1011 mid-call → same; Gemini closes 1000 mid-call → same; **normal end_call then
  onclose → no update**; **transfer then onclose → no update** (Review focus 2); update throws → finish still
  runs and the socket closes (Review focus 4); two closes → one update.
- [ ] Sabotage rows: `polite-failure-on-drop` (remove the onclose call → red), `polite-failure-not-after-close`
  (remove the `closed` check → red transfer test).

### Task 2.3 — alerts + cascade cap (0.25 h, docs only)

Add to the S6 alert list: `live_connect_failed`, `live_close_abnormal`, `live_polite_failure`,
`live_polite_failure_failed`, `live_max_duration_hard_end`. Cascade: `CALL_MAX_DURATION_MINUTES=10` set at
deploy (no code; its graceful goodbye exists, `session.js:2739-2746`, `:4193-4197`).

### Session 2 close — gate, census, commit, Status, S3 starting message. Opus review of 2.1 + 2.2.

---

## Session 3 — number block (3.5–4 h)

### Task 3.1 — price snapshot + `lib/dialCost.js` (1.5 h)

**Files:** create `scripts/refresh-dial-costs.mjs`, `lib/dialCostTable.json`, `lib/dialCost.js`,
`AI-phone-dashboard/backend/src/dialCost.js` + `dialCostTable.json` (byte-identical copies); tests
`tests/dialCost.test.js`, `tests/dialCostVendorParity.test.js`.

Snapshot shape (`fetched`, `source`, `voice: { "<prefix>": [pricePerMinUsd, iso, category] }`,
`sms: { "<ISO>": maxMobilePriceUsd }`), ~460 KB. Category assigned by the refresh script from Twilio's
friendly name: `premium | personal | satellite | pager | shared | special | mobile | fixed`. Refresh script =
the scratch script used on 2026-10-10 (Pricing API v1 Voice/Messaging Countries, account B creds from `.env`,
prints counts only, writes both copies).

```js
export const AUTO_MAX_PER_MIN = 0.10, HARD_MAX_PER_MIN = 0.60, TEXT_MAX_EACH = 0.25;
export function callCostOf(e164)       // longest-prefix match -> { perMin, iso, category } | null
export function checkDial(e164, { allowPricier = false } = {})
  // -> { ok: true, perMin, iso } | { ok: false, reason, perMin?, iso? }
  // reason: "invalid" | "unknown" | "never" | "over_ceiling" | "needs_switch_on"
export function checkText(e164)       // -> { ok: true, price, iso } | { ok: false, reason, price?, iso? }
export const REFUSAL_MESSAGES = { ... } // what to do instead, per reason, for UI/ops
```
Rules: invalid E.164 / no prefix match → refuse; category premium/personal/satellite/pager/shared → never;
special priced > AUTO_MAX → never; NANP `+1(900|976|500|52[1-9]|533|544|566|577|588|700)` → never; perMin >
HARD_MAX → over_ceiling; perMin > AUTO_MAX → needs_switch_on unless `allowPricier`. Texts: never-categories
refused; SMS price for the number's country ≤ TEXT_MAX else refuse. The JSON is loaded at import; a missing or
malformed table THROWS (boot fails loudly — never allow-all). A table older than 120 days logs
`dial_cost_table_stale` once at boot.

- [ ] Table-driven tests with real-format numbers, both sides of every boundary: `+447400123456` ok 3.05¢;
  `+447911123456` needs_switch_on (32¢ "Mobile – Other"); `+447624123456` needs_switch_on, and ok with
  `allowPricier`; `+447000123456` never (personal); `+449090123456` never; `+448443123456` never (special 26¢);
  `+443301234567` ok (03, 3.7¢); `+12125551234` ok; `+19005551234` never; `+19075551234` ok (Alaska 9.45¢);
  `+18675551234` needs_switch_on (Yukon); `+33612345678` needs_switch_on; Tunisia mobile over_ceiling;
  `+44` short/garbage → invalid. Texts: UK/US/FR ok, Pakistan (47¢) refused. Parity test: the two `.js` files
  and the two `.json` files are byte-identical.
- [ ] Sabotage rows: `dialcost-unknown-refuses` (unknown → ok:true → red), `dialcost-never-category`,
  `dialcost-auto-max` (raise AUTO_MAX to 1 → red).

### Task 3.2 — check at every dial and text (1.5–2 h)

| Site | File:line | On refusal |
|---|---|---|
| Live inbound transfer | `lib/voice/live/index.js` `redialForTransfer` before the TwiML (`:7327`) | `redirectCall(buildMessageTwiml(CALL_LINES.cantTransfer…))`, log `dial_destination_refused` {site, reason, iso, perMin}, `finish("transfer_refused")`; NOT marked transferred |
| Live outbound transfer | same function, outbound branch (`:7306`) | hang-up line; `outbound` result as today's no-answer |
| Cascade transfer | `lib/voice/session.js:2600` | same message TwiML |
| Outbound gate | facts `dispatch.js:152-162` → `gate.js` | new fact `destination` (object, required by `assertGateFacts` — THROWS if missing, `gate.js:29-73`) → `never("blocked_destination")` |
| Lead intake | `triggerRoute.js:442-445` | 422 `{ field: "phone", error: "We can't call this number for you — please ring this lead yourself." }` |
| Campaign transfer | `campaignSchema.js:571` | save error for never/over_ceiling/invalid |
| Every text | `services/notifications.js:150-159` `sendSms` | return false, log `sms_destination_refused` {reason, iso} |
| Dashboard save | `settingsValidation.js:289`, `:303` + `routes/settings.js:61` | 400 with `REFUSAL_MESSAGES[reason]`; needs_switch_on refused unless the row's `allow_pricier_numbers` |
| Onboarding script | `scripts/set-business-config.js` | refuse before writing |

`allowPricier` comes from `config.allowPricierNumbers` (migration 053 below).

- [ ] Migration `053_allow_pricier_numbers.sql`: `ALTER TABLE businesses ADD COLUMN allow_pricier_numbers
  boolean NOT NULL DEFAULT false;` + fold + `loadConfig` + set-business-config field (`true`/`false` only).
- [ ] Tests per site (Live via `bootLive` + injected `twilioClient`; cascade via `tests/session.test.js`
  harness; gate via `tests/outbound*` gate tests; routes via supertest on the real `app`; dashboard via its own
  vitest). Refused Live transfer: one update with the message TwiML, call NOT marked transferred.
- [ ] Sabotage row per site (9 rows), each → red in its own suite. Census.

**Reviewer risks:** a refusal path that hangs up (`finish` without a redirect) instead of taking a message;
the gate fact defaulting to `{ ok: true }` via `?.` (fail-open — `memory: plan-verbatim-code-fails-open`);
`sendSms` check placed after the rate-limiter/consent hold so a refused text still burns a slot; dashboard copy
drifting from root (parity test).

### Session 3 close — gate (root + db + dashboard vitest), census, commit, Status, S4 starting message.

---

## Session 4 — loop guard + block list + repeat-caller alerts (3.5–4.5 h)

### Task 4.1 — migration 054 (1 h)

```sql
CREATE TABLE pending_dials (
  id bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_sid text NOT NULL,          -- the caller's (parent) call
  caller_number text,              -- whose call we are putting through (outbound: the campaign caller_id)
  dialled_number text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, -- started_at + dial timeout + 15 s
  ended_at timestamptz
);  -- FORCE RLS tenant policy, same shape as the other tenant tables
CREATE TABLE blocked_callers (    -- platform table: no tenant RLS, no direct grant to vetra_app
  phone text PRIMARY KEY, business_id uuid NULL REFERENCES businesses(id) ON DELETE CASCADE,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NULL);
-- SECURITY DEFINER, search_path pinned, EXECUTE granted to vetra_app only:
app_dial_bounced(p_twilio_number text, p_from text) RETURNS boolean
app_caller_blocked(p_from text, p_twilio_number text) RETURNS boolean
app_calls_from_today(p_from text) RETURNS integer        -- all tenants, UTC day, inbound only
app_ai_seconds_today(p_business uuid, p_caller text) RETURNS integer
  -- SUM(EXTRACT(EPOCH FROM COALESCE(transferred_at, ended_at) - started_at)), UTC day
```
- [ ] Fold into schema.sql; parity; DB tests as `vetra_app`: definer functions work without tenant scope;
  direct `SELECT` on `blocked_callers` is refused; an expired or ended pending dial never matches.

### Task 4.2 — record and end pending dials; refuse bounces (1–1.5 h)

**Files:** `services/db.js` (`recordPendingDial`, `endPendingDial(callSid)`), `lib/voice/live/index.js`
`redialForTransfer` (both branches, before `redirectCall`), `lib/voice/session.js:2600`, `server.js`
`/twilio/transfer-result` (end), outbound transfer result route (`lib/outbound/doorRoutes.js:~641`, end),
webhooks `/twilio/live-voice` (`:571-595`) and `/twilio/voice` (`:765-805`).

Webhook order (both routes): allowlist → business lookup → **blocked?** (`<Reject reason="rejected"/>`) →
**bounced?** (`<Reject reason="busy"/>`, log `transfer_loop_refused` {callSid, businessId}) → repeat-calls
count (Task 4.3) → stream. A bounce matches when `From` equals the pending dial's `caller_number` OR its
`dialled_number` (carriers differ in what they present on a forwarded call). A rejected bounce makes the
original `<Dial>` end busy/failed → its action → the message TwiML (S1). Guard query errors fail OPEN (answer
the call, log `inbound_guard_failed`). A `recordPendingDial` failure logs `pending_dial_write_failed` (alert)
and the transfer still proceeds.

- [ ] Tests: bounce within the window → Reject busy, on BOTH routes; same caller after `ended_at` or after
  `expires_at` → answered (Review focus 5); From = dialled number → Reject; DB throws → answered; outbound
  transfer records `caller_number = caller_id`.
- [ ] Sabotage rows: `loop-guard-live-route`, `loop-guard-cascade-route`, `pending-dial-expiry`.

### Task 4.3 — block list + repeat-caller alerts (1–1.5 h)

**Files:** `server.js` (both webhooks; `/twilio/status` completed branch after `completeCall`, `:944`),
`scripts/block-caller.js` (new; `--add <e164> --reason "<text>" [--business <twilio e164>] [--days N] |
--remove <e164> | --list`; dry run unless `--confirm`; prints last 4 digits only) + `Dockerfile` COPY +
`.dockerignore` negation (named allowlist, `memory: reading-production-data`).

- Calls/day: `n = app_calls_from_today(From)` (prior calls); when `n === 30` log `repeat_caller_calls`
  {callSid, businessId, callerLast4, count: 31} — once per number per day by construction.
- AI minutes: on `completed`, `s = app_ai_seconds_today(business, caller)`; when this call moved it from
  < 1800 to ≥ 1800 log `repeat_caller_minutes` {callSid, businessId, callerLast4, aiMinutes}.
- Never alert for the business's own numbers (`phone_number`, `main_phone`, `transfer_phone_number`,
  `notification_phone`). Block-list lookup errors fail OPEN.
- [ ] Tests: 31st call alerts once, 32nd silent; crossing 30 AI min alerts once; transferred staff time not
  counted (uses `transferred_at`); own number never alerts; blocked caller → `<Reject reason="rejected"/>` on
  both routes with no call row created; expired block → answered; script dry-run writes nothing.
- [ ] Sabotage rows: `block-list-live-route`, `block-list-cascade-route`, `repeat-calls-threshold`.

### Session 4 close — gate, census, commit, Status, S5 starting message.

---

## Session 5 — Twilio fallback + fallback URLs + checkpoint (3–4 h)

### Task 5.1 — the Twilio Function (1.5 h)

**Files:** create `twilio/fallback/fallback.js` (CommonJS, Twilio Functions runtime; exports `handler` and
a pure `buildFallbackTwiml(event, context, VoiceResponse)`); test `tests/twilioFallback.test.js` (loads via
`createRequire`, uses the `twilio` package's `twiml.VoiceResponse`).

Query params set per number by us: `n` (number to ring, E.164), `t` (`20` | `45`), `v` (Polly voice).
Function environment variable: `VOICEMAIL_URL` = `https://<prod base>/twilio/voicemail`.
1. `n` missing/invalid (`^\+[1-9]\d{7,14}$`) → message (Say + Record + Hangup).
2. **Bounce:** `From === To` or `From === n` → `<Reject reason="busy"/>`.
3. First request → `<Dial timeout=t timeLimit=3600 callerId=event.To action="fallback?step=after&n=…&t=…&v=…">n`.
4. `step=after`: `DialCallStatus === "completed"` → `<Hangup/>`; else Say(no-answer line) +
   `<Record maxLength=120 recordingStatusCallback=VOICEMAIL_URL?to=<event.To>/>` + Hangup.
   The callback files the message automatically once our server is reachable; during an outage the recording
   stays in Twilio (manual check — catch-up job deferred).
- [ ] Tests for each branch; `callerId` is OUR number (caller-ID trick); `t` other than 20/45 → 20; XML
  escaping of `n`; the action URL carries `n/t/v` through.
- [ ] Sabotage row `fallback-bounce-rejects`.

### Task 5.2 — fallback URLs script (0.5 h)

**Files:** create `scripts/fallback-urls.js` (+ Dockerfile COPY / .dockerignore negation); test
`tests/fallbackUrls.test.js`. No change to `services/twilioNumbers.js` (finding 6: numbers are bought by hand).
- `scripts/fallback-urls.js --base <Function URL>`: prints, per routable business, its Twilio number and the
  full fallback URL to paste (`?n=<transfer number>&t=<20|45>&v=<Polly voice>`; transfer number is business
  config, not caller data). Re-run whenever a business's transfer number or transfer choice changes (runbook).
- [ ] Tests: URL built per business; no transfer number → URL without `n` (voicemail only); `own_voicemail`
  → `t=45`; output never contains a caller number.

### Task 5.3 — runbook (0.5 h)

`docs/runbooks/twilio-fallback.md`: buying a number by hand (account A for UK; regulatory bundle; voice URL
`https://<prod base>/twilio/live-voice` POST; status callback `/twilio/status`; then `businesses.phone_number`
set exactly — `memory: twilio-account-topology`), and click-by-click for each account (Functions & Assets → Services → create
`vetra-fallback` → add `/fallback`, paste `twilio/fallback/fallback.js` → visibility **Protected** → env
`VOICEMAIL_URL` → Deploy All → copy URL); per number: Phone Numbers → Active → number → Voice → "Primary
handler fails" → Webhook, paste the printed URL, POST → Save; the after-outage check (Monitor → Calls/Recordings
for the outage window); "transfer number changed → re-run fallback-urls and re-paste".

### Task 5.4 — checkpoint (1–1.5 h wall, mostly overlapping)

- [ ] ONE full `node scripts/corpus/sabotage.mjs` in the gate worktree (~1.5 h; keep the session active with
  foreground wait loops; resume with `--from`). Every new row must go red.
- [ ] Opus final review of S1–S5 with named risks (Review focus + the per-task risks), source-only diff.
- [ ] One fix wave for all Minors; re-review; gate; commit.

---

## Session 6 — ONE deploy + live test calls (3–4 h)

Pre-flight (read-only): `gcloud run services describe voice-uk-prod` → note the live image and revision
(expected `00100-nzn` @ `c755f56` — verify, don't assume) = rollback target; confirm env NAMES (not values)
`TWILIO_ACCOUNT_SID_ALT` / `TWILIO_AUTH_TOKEN_ALT` exist on the revision (else account-B webhooks to
`/twilio/voicemail` and `/twilio/transfer-result` 403); main checkout clean; `CLOUDSDK_CONFIG=~/.gcloud-vetra2`.

1. `gcloud builds submit --config=cloudbuild.yaml --substitutions=_TAG=<sha> …` from the MAIN checkout
   (`memory: terraform-broken-deploy-route`).
2. Update the migrate JOB image first → `migrate.js --status` (expect 052–054 pending, no "edited" error) →
   apply → `db-inspect --business +441372656055` reads back the new columns.
3. `gcloud run services update voice-uk-prod --image=…:<sha>` + `--update-env-vars
   CALL_MAX_DURATION_MINUTES=10`; read back env + image.
4. Alert policy `15114942414748467079` (bare id): add `live_connect_failed`, `live_close_abnormal`,
   `live_polite_failure`, `live_polite_failure_failed`, `live_max_duration_hard_end`, `dial_destination_refused`,
   `sms_destination_refused`, `transfer_loop_refused`, `pending_dial_write_failed`, `inbound_guard_failed`,
   `repeat_caller_calls`, `repeat_caller_minutes`, `degraded_voicemail_no_business`, `dial_cost_table_stale`
   (describe → edit OR-list → update → describe).
5. Owner: create the Function in each Twilio account (runbook) and send the URLs; we run
   `scripts/fallback-urls.js` in the job; owner pastes each number's fallback URL.
6. Test tenant config via `set-business-config.js` (transfer number = owner's mobile; then `own_voicemail` for
   L4; then the loop number for L5) — restore afterwards from the script's base64 backup.
7. Live calls (below, after approval). 8. Update `docs/readiness.md` §1, this Status table, memory.

### Live test calls (approve separately — ~$4–5 of our spend, plus the owner's own phone charges)

| # | Call | Pass when | Est. |
|---|---|---|---|
| L1 | Stay on the line ~9½ min, chatting | wrap-up mention ~8:30, goodbye ~9:00, call ends ≤ 9:31; never silent | ~$2.00 |
| L2 | Ask for a person; don't answer the mobile | after ~20 s the no-answer line; leave a message → dashboard message + email + caller text | ~$0.45 |
| L3 | Ask for a person; answer; talk 30 s; staff hangs up | nothing played after; call ends | ~$0.35 |
| L4 | Business set to `own_voicemail`; don't answer | the mobile's own voicemail answers (~25–30 s) | ~$0.35 |
| L5 | Transfer number = a spare Twilio number whose TwiML Bin dials back to the business line | bounce refused, `transfer_loop_refused` logged, no-answer line on the original call | ~$0.45 |
| L6 | Block a second handset; call; unblock; call | first rejected ($0), second answered | ~$0.05 |
| L7 | A spare/test number whose primary URL points at a dead URL; call twice (answer / don't) | Twilio fallback rings the mobile showing OUR number; no answer → message → filed by callback | ~$0.20 |
| | **Total** | | **~$3.85 (+ ~20% margin ≈ $4–5)** |

Not tested live (offline proof only): a Gemini refusal/drop (cannot be forced in production safely) and the
number block (pure table + per-site tests).

---

## Owner actions and when

| Action | When | Time |
|---|---|---|
| Google Cloud billing → full paid account (trial ends **2026-11-18**; every call stops otherwise) | Now — most urgent | 15 min |
| Twilio country permissions, voice + SMS, BOTH accounts: UK, US/Canada, EU/EEA, Switzerland, Australia, NZ on; others off | Before the first client | 10 min |
| Twilio daily spend alert (usage trigger), BOTH accounts | Before the first client | 10 min |
| Gemini daily spend alert in AI Studio "VetraTD" | Before the first client | 10 min |
| Approve S6 live-call spend (~$4–5) | Before S6 | — |
| Create the fallback Function in each Twilio account + paste each number's fallback URL (runbook) | During S6 | ~20 min |
| Give us a spare number for L5/L7 (or OK buying one, ~$1–2/month) and a second handset for L6 | Before S6 | — |
| Onboarding script: ask each client for "a number that reaches a person and never forwards to us" and their transfer choice | First client | — |

---

## Deferred (with the trigger that brings each back)

- **Gemini overflow counter** (~2 h): shared count across both instances, divert to the transfer number →
  message. Build at ~5 clients or before outbound is switched on (outbound sessions count toward the limit;
  make outbound dispatch respect it in abuse-guards task 3). Limit default 5 (setting).
- **Catch-up job for outage voicemails** (~1–1.5 h): list Twilio recordings in the outage window and file them.
  Build if an outage leaves more than a handful to forward by hand.
- **Extensions by digits** (~0.5 h): `<Number sendDigits>`. Build when a client needs it.
- **Allow-and-charge pricier numbers** (daily pricier-minute caps per client and platform-wide, pass-through
  at cost, under-$10/month free, per-client "included up to" price for EU clients): with billing/self-serve.
- **Fallback URL drift check** (`fallback-urls.js --verify` against Twilio): with self-serve, when clients
  change their own transfer number.

---

## Session starting messages

### S1 (paste to start)

> Execute session S1 of `docs/superpowers/plans/2026-10-10-batch3-launch-guards.md` (voicemail fix, transfer
> stopgap, per-business choice, 60-min transfer limit) on branch `feat/outbound-stage4`. Read the plan's
> "Owner decisions", "What the code shows", "Global constraints" and "Review focus" first, then memory notes
> sdd-gates-and-memory-limits, never-git-checkout-uncommitted-work, plan-verbatim-code-fails-open,
> owner-wants-speed-and-low-usage. Method: subagent-driven, faster variant (sonnet implementers + reviewers,
> census per task, Minors batched at the session end). Set up the gate worktree + junction first and check the
> main `node_modules` (~269). No paid calls, no production access. End: full gate green, commit, Status table
> updated, S2 starting message refreshed. Estimate 4–5 h; tell me if it runs over.

Each session's last step rewrites the next message below with anything that changed (deviations, new names,
open Minors, commit sha).

### S2
> Execute session S2 of `docs/superpowers/plans/2026-10-10-batch3-launch-guards.md` (10-minute end + polite
> failure) on `feat/outbound-stage4`, continuing from S1's commit <sha>. Read the plan's top sections, S1's
> Status notes, and memory live-instruction-timing, live-session-dies-at-ten-minutes,
> sdd-gates-and-memory-limits. Method: subagent-driven faster variant, but OPUS reviews Tasks 2.1 and 2.2
> (timing/close code). Census after every index.js edit. No paid calls, no production. End: gate green,
> commit, Status, S3 message refreshed. Estimate 4.5–5.5 h.

### S3
> Execute session S3 (number block) of `docs/superpowers/plans/2026-10-10-batch3-launch-guards.md` from
> commit <sha>. The price snapshot comes from `scripts/refresh-dial-costs.mjs` (Twilio Pricing API, free,
> account B creds from `.env`; never print them). Gate includes the dashboard backend's own vitest. Method:
> faster variant. End: gate green, commit, Status, S4 message. Estimate 3.5–4 h.

### S4
> Execute session S4 (loop guard, block list, repeat-caller alerts) of
> `docs/superpowers/plans/2026-10-10-batch3-launch-guards.md` from commit <sha>. Migration 054 adds SECURITY
> DEFINER functions — DB tests run as `vetra_app` (local Postgres on 55432). Inbound guards fail OPEN except
> the block list. Method: faster variant. End: gate green, commit, Status, S5 message. Estimate 3.5–4.5 h.

### S5
> Execute session S5 (Twilio fallback Function, fallback-URL script, runbook, checkpoint) of
> `docs/superpowers/plans/2026-10-10-batch3-launch-guards.md` from commit <sha>. Ends with ONE full
> `sabotage.mjs` run in the gate worktree (~1.5 h; foreground wait loops), an opus final review of S1–S5, one
> Minor fix wave. End: everything green, commit, Status, S6 message with the exact build sha. Estimate
> 3–4 h.

### S6
> Execute session S6 (deploy + live calls) of `docs/superpowers/plans/2026-10-10-batch3-launch-guards.md` at
> sha <sha>. Follow the plan's S6 steps and memory terraform-broken-deploy-route,
> prod-migration-checksums-crlf, reading-production-data, outbound-calling-plan (alert policy bare id). Build
> ONLY from the main checkout with a clean tracked tree. I approve the live calls L1–L7 at ~$4–5: <yes/no>.
> I will create the Twilio Functions during the session. Rollback target = the revision live before deploy.
> Estimate 3–4 h.
