# Ilija inbound receptionist -- implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Digile UK answers Ilija's missed calls the way he described, every saved message reaches his inbox with correct details, and every code change serves all businesses.

**Architecture:** Message rows gain a `details` field and an `owner_notice_pending` flag. The Twilio status callback, which is awaited and independent of the process that held the call, claims pending rows and sends one email per call, with details unless the business's `effectiveTier` is `hipaa`. Everything specific to Ilija is business config, written through a standard onboarding form.

**Tech Stack:** Node.js ESM, Express, Twilio, Gemini Live (`gemini-3.8-live`), Postgres (Cloud SQL, FORCE RLS), nodemailer, vitest.

**Spec:** `docs/superpowers/specs/2026-11-04-ilija-inbound-receptionist-design.md`

**Size:** ~13-17 h in three sessions, plus ~1-1.5 h of the owner's calls.

| Session | Tasks | Hours |
|---|---|---|
| S1 Email | 1-6 | ~5-6 |
| S2 Receptionist | 7-13 | ~5-6 |
| S3 Set up and go live | 14-18 | ~3-5 |

| Paid run (ask first, each time) | Cost |
|---|---|
| Language probe, Task 11 | up to ~$0.50 |
| 4 local rig calls, Task 15 | ~$1.60 |
| 15 calls on the UK line, Task 17 | ~$6 |
| 3 calls on the Test Line, Task 17 | ~$1.20 |

## Global Constraints

- **Generic code only.** No code branches on a business name, ID or number. Ilija's specifics live in business config, and his payload is never committed. If config can't express a need, add a generic setting whose default is today's behaviour.
- **Email rule:** `effectiveTier(business) === "hipaa"` means no caller details; anything else means details. No new switch.
- **Subject lines never carry a caller's name or number.** Logs never carry the recipient, the subject, or caller words (LVX24): lengths, IDs and closed-list values only.
- **Booking emails stay link-only** in this plan (`notifyAppointmentBooked` is untouched).
- **Greeting, exact:** `Hello, this is Ilija's AI assistant. Ilija can't get to the phone right now, how can I help you?`
- **Do not rebuild** the pronunciation box, recorded greeting or sound-spelling without asking the owner.
- **Never route traffic to `voice-uk-prod-00114-zub`** (reverted build, latest ready, 0% today). Rollback: `gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00112-boh=100 --project=vetra-uk-edc8ca --region=europe-west2`, with `CLOUDSDK_CONFIG=~/.gcloud-vetra2`.
- **Red first.** Every behaviour change starts with a failing test. Each fix gets a sabotage row in `scripts/corpus/sabotage.mjs`, run in the batch at Task 16. Run `node scripts/corpus/sabotage.mjs --census` after touching any anchored file. `replace` strings expand `$`-sequences. Never `import()` that script.
- **Every new counter on a gate has a positive twin** (memory `negative-counters-cannot-confirm`).
- **Golden prompts:** `tests/__snapshots__/prompts/` must change only where a task says so. A business with no new settings keeps its wording, apart from the prompt edits Tasks 4, 11, 12 and 13 name.
- **Projects:** voice and jobs are in `vetra-uk-edc8ca`, region `europe-west2`; images are built in `vetra-core-edc8ca`. Script headers still name dead project `vetra-uk-prod-c3a3bd`: never use it.
- **Git:** work on `feat/outbound-stage4`. `git add` by exact path, because the tree holds unrelated uncommitted work. Never `git checkout` over uncommitted work. No `--no-verify`. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Editing:** regex code with Write/Edit, never a heredoc. No Python text-mode writes (they flip CRLF).
- **Money:** state the dollars and get a yes before any paid run. Gate discipline per memory `sdd-gates-and-memory-limits`.
- **Keep in every report until done:** Google Cloud trial ends 2026-11-18; confirm the account is paid. Ilija's email address is still needed.

## Review Focus

1. **The caller hangs up as the final save lands.** The status callback can arrive while a correction is in flight, on another instance. Expected: the email carries the corrected number. Pinned in Task 6 (settle delay).
2. **A status callback never arrives, or SMTP refuses.** Expected: nothing is silently lost; the next call for that business picks up rows older than 15 minutes, and rows from a call still running are left alone. Pinned in Tasks 2 and 6.
3. **The model sends junk in the new arguments** (a string for `details`, blank labels, 100 entries, newlines, an unknown `caller_type`). Expected: junk is dropped, the message still saves, the subject stays clean. Pinned in Tasks 3 and 5.
4. **No usable caller number** (withheld, or the owner's own phone). Expected: the email says `Number: not given`, the assistant asks for a number, and no on-file name is used. Pinned in Tasks 5 and 8.
5. **A business with notifications off or no address.** Expected: rows stop being pending, with no alert and no retry loop on every later call. Pinned in Task 6.

---

## Session 1: Email

### Task 1: Guard test: no business names in running code (~0.25 h)

**Files:**
- Create: `tests/noTenantInRuntimeCode.test.js`

**Interfaces:**
- Produces: nothing other tasks use. Fails the build on a violation.

- [ ] **Step 1: Verify the baseline.** Commit the spec and this plan by exact path (`docs: Ilija inbound spec and plan`). Run `npm test` and `node scripts/corpus/sabotage.mjs --census`. Record pass counts in the ledger `.superpowers/sdd/2026-11-07-ilija/ledger.md`. A red baseline stops the work and gets reported (memory `verify-the-stated-baseline`).

- [ ] **Step 2: Write the test.** It exports nothing, defines `findTenantNames(sourceText) -> string[]`, and scans `server.js`, `lib`, `services`, `capabilities`, `adapters`, `config`, `middleware`, `integrations`, `AI-phone-dashboard/backend/src`, `AI-phone-dashboard/frontend/src`. It skips `lib/probe/`, `lib/harness/`, `__tests__`, and comment lines (trimmed start `//`, `*`, `/*`). Forbidden: `/digile/i`, `/ilija/i`, `/brightwork/i`, `55c7c8c4-2c33-463c-875a-7f16d6bcc17e`, `2083c6a4-46da-4d82-bb69-93592b464030`, `+441372656055`, `+18176011171`, `+18175803291`, `07426704500`.

```js
it("can fail", () => {
  expect(findTenantNames('const x = "Digile Media";')).toEqual(["digile"]);
  expect(findTenantNames("// Digile Media")).toEqual([]);
});
it("running code names no business", () => { expect(scanAll()).toEqual([]); });
```

- [ ] **Step 3: Run it.** `npx vitest run tests/noTenantInRuntimeCode.test.js`. Expected: PASS. A hit in running code is a finding: report it, don't add an exclusion.

- [ ] **Step 4: Commit.** `test(guard): running code must not name a business`

### Task 2: Schema and database functions (~1 h)

**Files:**
- Create: `database/059_customer_request_details.sql`, `tests/db/customerRequestDetails.test.js`
- Modify: `database/schema.sql` (customer_requests, line 186), `services/db.js` (lines 1513, 1562, 1595, `exportCallerData`, `eraseCallerData`), `lib/phiAudit.js`

**Interfaces:**
- Produces:
  - `createCustomerRequest({ ..., details = null, ownerNoticePending = false })`
  - `updateCustomerRequest({ ..., details })`, with `details = COALESCE($n::jsonb, details)`
  - `listCallCustomerRequests` also returns `details`
  - `claimOwnerNotices({ businessId, callSid }) -> Promise<Row[]>`, where Row is `{ id, call_id, request_type, caller_name, callback_number, message, preferred_time, details, created_at, caller_number, twilio_call_sid }`, oldest first
  - `releaseOwnerNotices({ businessId, ids }) -> Promise<number>`
  - `details` is stored as `{ callerType?: string, answers: Array<{ label: string, answer: string }> }`

- [ ] **Step 1: Write the failing DB tests** in `tests/db/customerRequestDetails.test.js`:
  - `claims a pending row for this call once` (second claim returns `[]`)
  - `leaves a younger pending row from another call alone`
  - `claims a pending row from another call once it is older than 15 minutes`
  - `does not claim a row whose owner_notice_pending is false`
  - `release makes a row claimable again`
  - `claim is tenant scoped` (another business's row is never returned)
  - `eraseCallerData nulls details`
  - `exportCallerData returns details`
  - `an update without details keeps the stored details`

- [ ] **Step 2: Run them.** `npm run db:up`, then `npx vitest run --config vitest.db.config.js tests/db/customerRequestDetails.test.js`. Expected: FAIL.

- [ ] **Step 3: Write the migration, and add the same to `schema.sql`.** Old rows stay at `false`, so no backfill is needed (an unscoped data update would match 0 rows under FORCE RLS anyway).

```sql
ALTER TABLE customer_requests
  ADD COLUMN IF NOT EXISTS details jsonb,
  ADD COLUMN IF NOT EXISTS owner_notice_pending boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_customer_requests_notice_pending
  ON customer_requests (business_id, created_at) WHERE owner_notice_pending;
```

- [ ] **Step 4: Implement the functions.** The claim is one atomic statement:

```sql
UPDATE customer_requests cr SET owner_notice_pending = false
  FROM calls c
 WHERE cr.call_id = c.id AND cr.business_id = $1 AND cr.owner_notice_pending
   AND (c.twilio_call_sid = $2 OR cr.created_at < now() - interval '15 minutes')
RETURNING cr.id, cr.call_id, cr.request_type, cr.caller_name, cr.callback_number, cr.message,
          cr.preferred_time, cr.details, cr.created_at, c.caller_number, c.twilio_call_sid
```

15 minutes because a Live call is hard-ended by 9:30. Sort in JS. Follow the existing refuse-when-unscoped pattern and call `noteAccess`. Add `details = NULL` to the `eraseCallerData` UPDATE and `details` to the `exportCallerData` SELECT. In `lib/phiAudit.js`: `claimOwnerNotices: { action: "read", resources: ["customer_requests"] }`, `releaseOwnerNotices: { action: "write", resources: ["customer_requests"] }`.

- [ ] **Step 5: Run.** `npm run db:migrate`, the DB test, `npx vitest run tests/phiAuditCoverage.test.js`. Expected: PASS. Sabotage must hit the `schema.sql` copy too (memory `db-reset-skips-migrations`).

- [ ] **Step 6: Commit.** `feat(db): customer request details and a pending owner notice`

### Task 3: Save logic: merge details, keep one row (~1 h)

**Files:**
- Modify: `lib/capabilities/customerRequests.js`, `tests/customerRequestCorrection.test.js`

**Interfaces:**
- Consumes: Task 2's db functions and details shape.
- Produces:
  - `CALLER_TYPES = ["new_enquiry", "existing_customer", "personal", "supplier", "sales_pitch", "other"]`
  - `detailsFromArgs({ caller_type, details }) -> Details | null`
  - `mergeDetails(stored, incoming) -> Details | null`
  - `saveCustomerRequest({ ..., row: { ..., details } }) -> { id, corrected, ownerNoticePending } | null`
  - Removed: `noteOwnerNotified`, `ownerNotifiedFor`

- [ ] **Step 1: Write the failing tests.**

```js
it("a later save with details updates the row even when the reason was reworded", ...)
// first  { callerName: "Jane Doe", message: "wants help with Meta ads" }
// second { callerName: "Jane Doe", message: "interested in advertising",
//          details: { callerType: "new_enquiry", answers: [{ label: "Company", answer: "Acme" }] } }
// createCustomerRequest once; updateCustomerRequest with message: null and the details
it("a partial save cannot wipe an earlier answer", ...)     // stored Company, Industry + incoming Email = all three
it("a later answer for the same label replaces it", ...)    // "company " vs "Company" is one label
it("a different person is still a new row", ...)            // Jane Doe, then Tom Hill
it("a first save is pending when there is a call", ...)     // ownerNoticePending: true on insert
it("a save with no call id is not pending", ...)            // ownerNoticePending: false
it("detailsFromArgs drops junk", () => {
  expect(detailsFromArgs({ details: "nope" })).toBeNull();
  expect(detailsFromArgs({ details: [{ label: "", answer: "x" }] })).toBeNull();
  expect(detailsFromArgs({ caller_type: "vip" })).toBeNull();
  // 25 entries -> 20; label clamps to 60 chars; answer to 500; newlines collapse to spaces
});
```

- [ ] **Step 2: Run.** `npx vitest run tests/customerRequestCorrection.test.js`. Expected: FAIL.

- [ ] **Step 3: Implement.** Match rule: `sameRequest(...)` first, otherwise, when `row.details` is present, the newest row with `samePerson`. On that second kind of match the update passes `message: null`, so a reworded reason can't overwrite the stored one. The stored details are merged before writing. Insert passes `ownerNoticePending: Boolean(callId)`.

- [ ] **Step 4: Run, then census.** Expected: PASS. Fix any sabotage anchors the removal moved.

- [ ] **Step 5: Add row `details-merge`** (`mergeDetails` returns `incoming`; suite `tests/customerRequestCorrection.test.js`). **Commit.** `feat(messages): a lead's answers merge onto one row`

### Task 4: Packs stop emailing at save; the tool takes answers (~1 h)

**Files:**
- Modify: `capabilities/messages.js`, `capabilities/quotes.js:256-295`, `lib/voice/session.js:2770-2795`, `lib/harness/fakeDeps.js`
- Test: `tests/capabilityEffects.test.js`, `tests/customerRequestCorrection.test.js`, `tests/liveCustomerRequestCorrection.test.js`, `tests/messageLastChance.test.js`, `tests/outboundPartyEffectsWire.test.js`, `tests/quotes.test.js`, `tests/session.test.js`, `tests/degradedMode.test.js`, `tests/db/ownerNotifications.test.js`, `tests/__snapshots__/prompts/`

**Interfaces:**
- Consumes: Task 3's `saveCustomerRequest`, `detailsFromArgs`, `CALLER_TYPES`.
- Produces: `record_customer_request` accepts `caller_type` (enum `CALLER_TYPES`) and `details` (array of `{ label, answer }`, both strings, both required). Its reply carries a model-only `next` when the business has `messages` notes.

- [ ] **Step 1: Write the failing tests** in `tests/capabilityEffects.test.js`:
  - `record_customer_request saves pending and sends no email at save`
  - `a save with no call id still notifies at once` (`notifyCustomerRequest` as today, the only email path left in `onEffect`)
  - `the declaration offers caller_type and details`
  - `a business with messages notes gets next in the reply; spoken message unchanged`
  - `a business without notes gets no next`

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Add the two declaration properties.
  - `onEffect`: pass `details: detailsFromArgs(args)` in `row`, and `fallbackNumber: party.phone || null` (Task 13 relies on it). Drop the `ownerNotifiedFor`/`noteOwnerNotified` block; call `notifyCustomerRequest` only when `saved.ownerNoticePending` is false. The caller SMS is unchanged.
  - `execute(fc, ctx = {})`: when `capabilityConfig(ctx.config, "messages").notes` is set, add to `functionResponse.response` (not to `toolResult`, which may be spoken): `next: "[not caller speech] If this business's notes list more questions for this caller, ask them now, one at a time, before closing. Then save again with the same message and the answers in details."`
  - `quotes.js`: same treatment.
  - `session.js` fallback flow: `ownerNoticePending: true` when there is a call row, and drop its immediate notify.
  - `lib/degradedVoicemail.js` and `lib/postCallVerify.js:487` stay as they are: their rows default to not pending and keep their own emails.
  - Add step 7 to `MESSAGE_PROTOCOL_SECTION`: `7. Extra questions: if this business's notes list more questions, save as soon as you have name, number and reason, keep going one question at a time, then call record_customer_request once more with the same message and the answers in details. Skip anything they would rather not answer and never ask it again. Set caller_type whenever you can tell.`

- [ ] **Step 4: Update the listed tests.** A test asserting an email at first save now asserts `ownerNoticePending: true` on the insert. Update the golden prompts for step 7 only and check the diff.

- [ ] **Step 5: Run.** `npm test`, census. Expected: PASS. Don't deploy between this task and Task 6: until then nothing emails.

- [ ] **Step 6: Commit.** `feat(messages): take a caller's answers; the email waits for call end`

### Task 5: The email (~1 h)

**Files:**
- Create: `tests/notifications.callRequests.test.js`
- Modify: `services/notifications.js`, `tests/notifications.phi.test.js`, `docs/compliance/sub-processor-register.md` (line 56, section at line 101), comments in `lib/capabilities/customerRequests.js`

**Interfaces:**
- Consumes: `effectiveTier` (`lib/compliance.js`), Task 2's Row and details shape.
- Produces:
  - `renderCallRequestsEmail({ businessName, timezone, rows }) -> { subject, text }`
  - `notifyCallRequests({ businessId, rows }) -> Promise<"sent" | "off" | "failed">`, never throws
  - `loadBusinessNotificationConfig` adds `detailsAllowed`

- [ ] **Step 1: Write the failing tests.**

```js
const row = { request_type: "message", caller_name: "Jane Doe", callback_number: "+447700900123",
  message: "wants help with Meta ads", preferred_time: "Tuesday afternoon", caller_number: "+447700900999",
  created_at: "2026-11-09T14:32:00Z",
  details: { callerType: "new_enquiry", answers: [{ label: "Company", answer: "Acme" }] } };
const { subject, text } = renderCallRequestsEmail({ businessName: "Acme Plumbing", timezone: "Europe/London", rows: [row] });
expect(subject).toBe("New enquiry — Acme Plumbing");
for (const line of ["Name: Jane Doe", "Number: +447700900123", "Reason: wants help with Meta ads",
  "Company: Acme", "Preferred time: Tuesday afternoon"]) expect(text).toContain(line);
expect(text).not.toContain("contains no caller");
```

Also:
- Subject per type: `Existing customer message`, `Personal message`, `Supplier message`, `Sales call`; no or unknown type gives `New message`; `request_type: "quote"` with no type gives `New quote request`.
- `callback_number` null falls back to `caller_number`; both empty gives `Number: not given`.
- Two rows in one call render both, with the subject from the first.
- A subject never contains the name or number (sentinels).
- In `tests/notifications.phi.test.js`: `compliance_tier: "hipaa"` sends no sentinel anywhere, subject `New customer request — {business}`; the same under `DEPLOYMENT_MODE=hipaa`; a `standard` business's body carries them.
- Results: SMTP refusal `"failed"`; a send still hanging at 10 s `"failed"`; rate limited `"failed"`; `notifications_enabled: false` `"off"`; no email and SMS not configured `"off"`.

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.** Plain text only. Ends with `Details were taken by phone, so spellings may be off.` and the dashboard link line. Times render in the business timezone. Owner SMS stays link-only via `ownerSmsBody`. `notifyCustomerRequest` stays for the voicemail path. Update the file's header comment and the correction comment in `customerRequests.js`, so neither still claims every email is link-only.

- [ ] **Step 4: Update the register.** Row 56: `owner notifications -- caller details (name, number, reason, answers), except healthcare-tier businesses, which stay link-only`. Section retitled `Email carries caller details, except for healthcare businesses`, stating: the mail relay is a sub-processor for caller data; `effectiveTier` decides; `tests/notifications.phi.test.js` enforces it; health details would need a signed agreement with the provider before a clinic could get them.

- [ ] **Step 5: Run.** `npx vitest run tests/notifications`. Expected: PASS.

- [ ] **Step 6: Add row `email-tier-rule`** (`detailsAllowed` always true; suite `tests/notifications.phi.test.js`). **Commit.** `feat(notifications): owner email carries the call's details, except healthcare`

### Task 6: Send at call end from the status callback (~1 h)

**Files:**
- Create: `lib/ownerNotices.js`, `tests/ownerNotices.test.js`, `tests/statusCallbackNotices.test.js` (route setup modelled on `tests/inboundGuardRoutes.test.js`)
- Modify: `server.js` (status handler, after the `completeCall` await, about line 1085)

**Interfaces:**
- Consumes: Tasks 2 and 5.
- Produces: `flushOwnerNotices({ db, notifications, log, captureException, businessId, callSid, settleMs = 2000, sleep }) -> Promise<{ sent, failed, off }>`, never rejects.

Why here: `cpu_idle = true` throttles CPU once a response ends, and the Live `finish` path is fire-and-forget (a claim followed by a throttled send would lose the email). This handler is awaited, runs whichever instance took the call, and already logs for Live calls.

- [ ] **Step 1: Write the failing tests.**

`tests/ownerNotices.test.js`:
- `waits settleMs before claiming`
- `groups rows by call and sends one email per call`
- `a second flush sends nothing`
- `failed releases exactly those ids and logs owner_notice_unsent with counts only`
- `off releases nothing and logs no error`
- `a throwing db still resolves`
- `no pending rows bumps owner_notice_checked and sends nothing`

`tests/statusCallbackNotices.test.js`:
- `completed flushes for the business found from To`
- `busy does not flush`
- `an unknown To answers 200 without flushing`
- `a throwing flush still answers 200`

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.** Both DB calls go through `db.withTenantSafe(businessId, ...)`. In `server.js`: when `status === "completed"`, resolve the business from `shared.businessId`, otherwise `db.lookupBusinessByPhone(req.body.To)` (Live calls leave the shared store empty), and `await flushOwnerNotices(...)` before responding. Twilio's callback timeout is 15 s and the send is capped at 10 s.

- [ ] **Step 4: Run.** `npm test`, census. Expected: PASS.

- [ ] **Step 5: Add row `notice-unwired`** (remove the `flushOwnerNotices` call; suite `tests/statusCallbackNotices.test.js`) and `notice-no-settle` (`settleMs` ignored; suite `tests/ownerNotices.test.js`). **Commit.** `feat(notifications): send the owner's email when Twilio reports the call ended`

**Failures that remain, to state at handover:** a number with no status callback gets no email at all (Task 16 reads all three numbers, Task 14 puts it on the form); a failed send retries on that business's next completed call, not on a timer; a Live write in flight past the 2 s settle reaches the row but not the email.

---

## Session 2: Receptionist

### Task 7: Generic setting: who calls back and how soon (~0.5 h)

**Files:**
- Modify: `capabilities/messages.js`, `lib/capabilities/configSchema.js`, `AI-phone-dashboard/backend/src/capabilityConfigValidation.js`
- Create: `AI-phone-dashboard/backend/src/__tests__/capabilityConfigValidation.test.js`
- Test: `tests/capabilityConfig.test.js`, `tests/__snapshots__/prompts/`

**Interfaces:**
- Produces: `messages` config `callbackLine` (string, max 160); `messageProtocol(cfg) -> string`, replacing the constant.

- [ ] **Step 1: Write the failing tests.**
  - `no callbackLine renders byte-identical to today`
  - `callbackLine replaces the promise and removes the urgency step`: with `"Sam will call you back as soon as he can."` the prompt has `Promise the callback: "Sam will call you back as soon as he can."`, has no `Is this urgent`, and has no `Someone will get back to you`
  - `a non-string is dropped; a long one clamps to 160`
  - `the dashboard validator keeps callbackLine` (otherwise a dashboard save would wipe it)

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.** Steps renumber when urgency goes. `messageGuidance` follows the same rule. Strip quotes and newlines from the line before it enters the prompt. Declare it in the pack's `configSchema` as `{ type: "text", label: "What should the assistant promise about getting back to the caller?", placeholder: "e.g. Sam will call you back as soon as he can." }`. No dashboard screen in this plan.

- [ ] **Step 4: Run.** `npm test`. Expected: PASS, no snapshot changes.

- [ ] **Step 5: Commit.** `feat(messages): a business can say who calls back and how soon`

### Task 8: The business's own number is not the caller (~0.5 h)

**Files:**
- Modify: `lib/inboundGuards.js`, `server.js` (lines 631, 645, 845)
- Test: `tests/inboundGuards.test.js`, `tests/inboundGuardRoutes.test.js`, `tests/inboundGuardRoutesCascade.test.js`

**Interfaces:**
- Consumes: `isOwnNumber(business, from)`.
- Produces: `callerIdentityNumber(business, from, forwardedFrom) -> string`: `""` when `from` is the business's own number or equals `forwardedFrom`, otherwise `from`.

- [ ] **Step 1: Write the failing tests.**

```js
const b = { phone_number: "+441372656055", notification_phone: "+447700900111" };
expect(callerIdentityNumber(b, "+447700900111", "")).toBe("");
expect(callerIdentityNumber(b, "+447700900222", "+447700900222")).toBe("");
expect(callerIdentityNumber(b, "+447700900222", "+447700900111")).toBe("+447700900222");
expect(callerIdentityNumber(null, "+447700900222", "")).toBe("+447700900222");
```

Route tests: the TwiML `callerPhone` parameter is empty when `From` is the business's `notification_phone`, on both `/twilio/live-voice` and `/twilio/voice`.

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.** Only the argument to `buildStreamTwiml` changes. The allowlist, inbound guard, block list and status handler keep the raw `From`. An empty `callerPhone` already means no number block in the prompt and no caller history (`lib/voice/live/index.js:8801`).

- [ ] **Step 4: Run.** `npm test`. Expected: PASS.

- [ ] **Step 5: Add row `own-number-identity`** (the helper returns `from`; suite `tests/inboundGuardRoutes.test.js`). **Commit.** `fix(voice): the business's own number is never treated as the caller`

### Task 9: Emergency number from the business's country (~0.25 h)

**Files:**
- Modify: `lib/phone.js`, `services/db.js` (`loadConfig`, about line 540, and its default config, about line 504), `services/gemini.js:1371`
- Test: `tests/phone.test.js` (`emergencyNumberFor`), `tests/promptSplit.test.js` (the rendered line)

**Interfaces:**
- Produces: `emergencyNumberFor(e164) -> "999" | "911"`; `config.businessPhone`.

- [ ] **Step 1: Write the failing tests.** `nonNegotiableRulesSection` with `businessPhone: "+441372656055"` contains `call 999` and no `911`. With `+18176011171` or none it is byte-identical to today.

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.** `countryFromE164(e164) === "GB" ? "999" : "911"`. The line is pushed unconditionally at `services/gemini.js:1363`, so it renders on every inbound call.

- [ ] **Step 4: Run.** `npm test`. Expected: PASS, no snapshot change for fixtures with no UK number.

- [ ] **Step 5: Commit.** `fix(prompt): UK callers are told 999, not 911`

### Task 10: LVX185: a question back is not "no, nothing else" (~1.5 h)

**Files:**
- Modify: `lib/transcriptUtils.js`, `services/tools.js` (before the `allowedByExistingGates && !askedAnythingElse` line, which must stay byte-identical), `lib/voice/live/index.js` (ctx about line 4859, `askStillOutstanding` about line 4266, tool output about line 7193), `lib/voice/live/summary.js:163`
- Test: `tests/transcriptUtils.test.js`, `tests/liveEndCallAsk.test.js`, `tests/liveExitClose.test.js`

**Interfaces:**
- Produces: `callerLeftQuestionOpen(text) -> boolean`; `MAX_CALLER_QUESTION_HOLDS = 2`; ctx wire `callerQuestionHolds: number`; refusal kind `"caller_question"`.

- [ ] **Step 1: Prototype the detector** in a throwaway script in the scratchpad, on caller lines from `call-corpus/` (memory `prototype-detectors-before-editing`). Transcripts are lossy, so check whether a `?` is reliable enough or question openers are needed too. Settle the regex there.

- [ ] **Step 2: Write the failing tests.**

```js
for (const t of ["Wait, what? Wait, hold on. Wait, so this isn't the car insurance company number?",
  "Did you just say goodbye?", "Hold on a second."]) expect(callerLeftQuestionOpen(t)).toBe(true);
for (const t of ["No thanks.", "No, that's all, thanks.", "Okay, bye.", ""]) expect(callerLeftQuestionOpen(t)).toBe(false);
```

In `tests/liveEndCallAsk.test.js`:
- `end_call after a caller question is refused with caller_question, even when the no_ask refusal is spent` (the CA86103cd shape)
- `the refusal asks for "Is there anything else I can help you with?" and no goodbye`
- `after two holds end_call goes through`
- `a clear no goes through`
- `no callerQuestionHolds wire means no gate` (the cascade)
- `skipped on outbound`

In `tests/liveExitClose.test.js`: `a sign-off after a caller question does not arm the exit`.

- [ ] **Step 3: Run.** Expected: FAIL.

- [ ] **Step 4: Implement.** The gate runs only when `typeof ctx?.callerQuestionHolds === "number"` (memory `shared-gate-needs-the-latch-wire`), excludes `closeAnswersReadBack`, and checks `skipOnOutbound("askBeforeHangup", ...)`. Refusal text: `[not caller speech] NOT A FAILURE, the call is still open. The caller just asked you something. Answer it in one short sentence if you have not, then ask: "Is there anything else I can help you with?" Then stop and wait. Do not say goodbye.` Count holds in Live from both doors. Counters `end_call_question_check_ran` and `end_call_refused_caller_question`. `summary.js` accepts the new kind.

- [ ] **Step 5: Run.** `npx vitest run tests/liveEndCallAsk.test.js tests/liveExitClose.test.js tests/transcriptUtils.test.js`, then census. Expected: PASS.

- [ ] **Step 6: Add row `question-hold`** (`callerLeftQuestionOpen` returns false; suites as above). **Commit.** `fix(voice): LVX185 a caller's question back keeps the call open`

### Task 11: LVX187: no "this line operates in English" (~1 h, probe up to ~$0.50)

**Files:**
- Create: `scripts/probes/lvx187-language.mjs` (modelled on `scripts/probes/voice-check-38.mjs`)
- Modify: `services/gemini.js:1283`
- Test: `tests/promptSplit.test.js`, `tests/__snapshots__/prompts/`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test.** The English-only identity has no `operates in English` and no `Never apologise for the language`, and contains `Sorry, I didn't catch that, could you say it again?`. The multi-language branches are byte-identical.

- [ ] **Step 2: Pre-register in the ledger, then ask the owner.** 10 sessions per arm on `gemini-3.8-live`, the real prompt, caller text `¿Tienes que ayudarme a ponerlo a mí?`. Scored by counting replies that match `/language|english|idioma|inglés/i`. Pass: the new wording matches in at most 1 of 10, and fewer than the old wording. State the dollars. Run the old arm before changing the code.

- [ ] **Step 3: Implement.** Exact text: `\nReply in English only. If a caller's words reach you in another language, you misheard an English speaker. Do not mention language. Say: "Sorry, I didn't catch that, could you say it again?"`

- [ ] **Step 4: Run the new arm and the tests.** Update the golden prompts (this line only). Record the numbers. If it fails the rule, report before going further; no rewording loop.

- [ ] **Step 5: Commit** `services/gemini.js`, the snapshots, the probe. `fix(prompt): LVX187 the language rule no longer hands the model a line to say`

### Task 12: LVX188: an on-file name is a question (~0.5 h)

**Files:**
- Modify: `capabilities/appointments.js` (`onFileNameNote`, single-name branch), `capabilities/messages.js` (protocol step 1), `services/gemini.js` (`buildCallerContextSection`)
- Test: `tests/a1OnFileNote.test.js`, `tests/__snapshots__/prompts/`

**Interfaces:** none new. `nameIsOnFile` and the spelling gate are untouched.

- [ ] **Step 1: Write the failing tests.** `onFileNameNote` with one name returns text containing `Am I speaking with Jonathan Daniel?`, and no `that is their name`. It still says not to spell it. Protocol step 1 no longer says `you have it right already`. The multi-name branch is unchanged.

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Single-name note: `[not caller speech] On this caller's record: ${name}. That may not be who is calling. Before using it, ask once: "Am I speaking with ${name}?" If yes, use it exactly as written: do not ask for it again, do not ask them to spell it, and do not spell it back. If no, ask for their name.` plus the existing `another` text.
  - Protocol step 1, replacing the on-record sentences: `If a name is on their record from an earlier call, it may not be who is calling: ask once "Am I speaking with <name>?" If yes, use it and do not ask them to spell it. If no, ask for their name.`
  - Caller context section gains: `Names below may belong to someone else on this phone. Do not call the caller by any of them until they confirm.`

- [ ] **Step 4: Run.** `npm test`, census. Update the golden prompts for these lines only. Expected: PASS.

- [ ] **Step 5: Commit.** `fix(prompt): LVX188 an on-file name is asked, never assumed`

### Task 13: LVX189 / LVX169: one ask per need, counted in code (~2 h)

**Files:**
- Create: `lib/voice/askLedger.js`, `tests/askLedger.test.js`
- Modify: `lib/voice/live/index.js` (turn close near the LVX78 block, about line 4321; per-fragment beside `inspectRepeat`, line 5328), `capabilities/messages.js` (protocol step 2)
- Test: `tests/liveRepeatCut.test.js`, `tests/__snapshots__/prompts/`

**Interfaces:**
- Consumes: `callerLeftQuestionOpen` (Task 10); `fallbackNumber` on the save (Task 4).
- Produces:
  - `asksIn(text) -> string[]`: `"number"`, `"name"`, `"spelling"`, `"email"`, or `q:<normalised question>` for any other question sentence of 3+ content words
  - `createAskLedger({ maxAsks = 2 }) -> { recordReply(text, { callerSpoke }), repeatIn(soFar, { callerAsked, callerDeclined, callerWantsRepeat }) -> string | null }`

- [ ] **Step 1: Prototype** `asksIn` in the scratchpad on assistant lines from `call-corpus/`, including the seven asks on `CAe52b758` if present. Settle the regexes and the `q:` similarity (Jaccard of content words) before editing.

- [ ] **Step 2: Write the failing tests.**

```js
const l = createAskLedger({ maxAsks: 2 });
l.recordReply("What's the best contact number to reach you on?", { callerSpoke: true });
expect(l.repeatIn("And what's the best number to reach you?", { callerAsked: true })).toBe("number");
expect(l.repeatIn("And what's the best number to reach you?", { callerDeclined: true })).toBe("number");
expect(l.repeatIn("And what's the best number to reach you?", {})).toBeNull();   // second ask allowed
l.recordReply("What's the best number?", { callerSpoke: true });
expect(l.repeatIn("Could I take a contact number?", {})).toBe("number");          // cap reached
expect(l.repeatIn("What's the best number?", { callerWantsRepeat: true })).toBeNull();
// a lead question from config, with nothing naming it in code:
l.recordReply("What industry are you in?", { callerSpoke: true });
expect(l.repeatIn("So what industry are you in?", { callerDeclined: true })).toMatch(/^q:/);
// silence does not count as an ask answered:
const s = createAskLedger({ maxAsks: 2 });
s.recordReply("What's the best number?", { callerSpoke: false });
expect(s.repeatIn("What's the best number?", {})).toBeNull();
```

In `tests/liveRepeatCut.test.js`:
- `a repeated ask after a caller question is cut`, counting `live_ask_repeat_cut` once
- `the greeting is never cut`
- `the log carries a closed kind, never the question`

- [ ] **Step 3: Run.** Expected: FAIL.

- [ ] **Step 4: Implement.** Per fragment: `clearAudio(atMs)` on a hit, the same tapered cut as `inspectRepeat`; at most 3 per call; no note, because an appended note is ignored on Live and a forced reply adds a turn (memory `live-instruction-timing`). Counters `live_ask_checked` and `live_ask_repeat_cut`. `callerAsked` comes from `callerLeftQuestionOpen`; `callerDeclined` and `callerWantsRepeat` are small regexes in `askLedger.js`, settled in Step 1.

  Protocol step 2 becomes: `2. Number: if you know the number they are calling from, ask once: "Is the number you're calling from the best one?" Anything other than a different number means use it. If you do not have it, ask for the best number once. You will read it back digit by digit in your one summary, not now.` Task 4's `fallbackNumber` covers a save with no number.

- [ ] **Step 5: Run.** `npm test`, census. Update the golden prompts for step 2 only. Expected: PASS.

- [ ] **Step 6: Add rows `ask-cap`** (`repeatIn` returns null; suite `tests/askLedger.test.js`) **and `ask-wire`** (remove the per-fragment call; suite `tests/liveRepeatCut.test.js`). **Commit.** `fix(voice): LVX189 one ask per need, counted in code`

---

## Session 3: Set up and go live

### Task 14: Standard onboarding: form, required answer, prompt check (~1 h)

**Files:**
- Create: `docs/runbooks/client-onboarding.md`, `scripts/render-tenant-prompt.js`, `tests/renderTenantPrompt.test.js`
- Modify: `scripts/import-tenant.js` (`BUSINESS_FIELDS`, `importTenant`), `tests/importTenantFields.test.js`

**Interfaces:**
- Produces: `renderTenantPrompt(payload) -> { prompt, chars, warnings: string[] }`. The payload is import-tenant's JSON shape. CLI: `node scripts/render-tenant-prompt.js <payload.json>`.

- [ ] **Step 1: Write the failing tests.**
  - `a new business with no compliance_tier is refused`, message containing `is this a healthcare business`, nothing written
  - `an update to an existing business does not need it`
  - `compliance_tier is an imported field`
  - `renderTenantPrompt warns on custom_instructions over 2000`, and on capability notes over 2000
  - `messages notes appear in the prompt with appointments disabled`
  - `a disabled appointments capability leaves no booking language in the prompt`

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.** Add `"compliance_tier"` to `BUSINESS_FIELDS`. Refuse on the no-existing-row branch unless the value is `standard` or `hipaa`. `renderTenantPrompt` uses `loadConfig` and `buildSystemInstruction("greeting", null, config, { greetingSpoken: false })`, the same step Live renders.

- [ ] **Step 4: Write the form.** Each question names its setting:

| Question | Setting |
|---|---|
| Is this a healthcare business? | `compliance_tier` |
| What should the assistant say when it answers? (Must say it is an AI) | `greeting` |
| What do you sell? | `general_info` |
| Who rings you, and how should each kind of caller be handled? | `custom_instructions` |
| What should it never say or promise? | `custom_instructions` |
| What should it ask a new enquiry? | `messages` notes |
| Who gets back to callers, and how soon? | `messages.callbackLine` |
| Where should call notes go? | `notification_email` |
| Your own mobile number | `notification_phone` |
| Does your phone ring first, or do calls come straight to us? | fallback URL with or without `n=` (`docs/runbooks/twilio-fallback.md`) |
| Should it book? Length, days, times? | `appointments` capability, `availability`, `business_hours` |
| Should it ever transfer? To which number that does not forward to us? | `transfer_policy`, `transfer_phone_number` |
| What about after hours? | `after_hours_policy` |

Then the steps: fill the form; build the payload outside the repo; run the prompt check with no warnings; back up with `set-business-config --show` and `db-inspect --counts`; import; read back; confirm the number's `statusCallback` points at the voice service; test call; `onboard-tenant` for a login.

- [ ] **Step 5: Run.** `npm test`. Expected: PASS. **Commit.** `feat(onboarding): one form for every client; a new business must answer the healthcare question`

### Task 15: Ilija's config and a local rehearsal (~1 h, ~$1.60)

**Files:**
- Create (not committed): `.superpowers/tenants/digile-uk.json`
- Modify: `lib/probe/script.js` (four generic scripted callers), `scripts/live-call-harness.js` (`--post-status`: signs and POSTs `/twilio/status` with `CallStatus=completed` when the call ends)

**Interfaces:**
- Consumes: Tasks 7, 14.

- [ ] **Step 1: Read what's live.** `scripts/set-business-config.js --to +441372656055 --show` and `db-inspect --business +441372656055 --counts`, both via the migrate job (memory `digile-lead-gen-tenant`). Save the base64 backup to `.superpowers/backups/`.

- [ ] **Step 2: Fill the form from Ilija's answers and write the payload.**
  - `phone_number`: `+441372656055`; `compliance_tier`: `standard`; `greeting`: exact, from Global Constraints
  - `general_info`: services per the spec, advertising first; nothing clinic-specific
  - `custom_instructions`: the spec's caller-paths table and red lines
  - `messages` notes: open with "Only for a new business enquiry; never ask these of an existing client, a personal caller, a supplier or a sales pitch." Then the lead questions in the spec's order, soft, "skip anything they would rather not answer"
  - `messages.callbackLine`: `Ilija will get back to you as soon as he can.`
  - `appointments`: disabled, and booking tasks out of `allowed_tasks`
  - `transfer_policy`: never; `transfer_phone_number`: null; `after_hours_policy`: `take_message`
  - `main_phone`: null, until Ilija answers about 07426704500
  - `notification_email`: the owner's address (ask which); `notifications_enabled`: true; `notification_phone`: left out until Ilija gives it

- [ ] **Step 3: Check the prompt.** `node scripts/render-tenant-prompt.js .superpowers/tenants/digile-uk.json`. Expected: no warnings; the prompt contains the greeting and every lead question; no `clinic`, `07426704500` or booking language. Budget is tight: `custom_instructions` max 2000, `notes` max 2000.

- [ ] **Step 4: Ask the owner (~$1.60), then run 4 rig calls** on localhost per memory `local-rig-beats-staging`, with `--post-status`: full new lead; corrects the number; hangs up mid-questions; wrong number. Read rows and logs directly. Expected: one row and one `notifyCallRequests` per lead call with the final number; a partial row on the hang-up; nothing on the wrong number; `details` merged. Scripted callers desync, so read each transcript before calling a miss a defect (memory `scripted-callers-desync`). A real miss goes back to the owning task.

- [ ] **Step 5: Commit** only `lib/probe/script.js` and the harness. `chore(harness): scripted inbound callers and a status callback at call end`

### Task 16: Gate, deploy, write the config (~1 h active, gate runs unattended)

**Files:** none new. Sabotage rows from earlier tasks in `.superpowers/sdd/2026-11-07-ilija/rows.txt`.

**Interfaces:** none.

- [ ] **Step 1: Gate** in the isolated worktree (memory `sdd-gates-and-memory-limits`): `npm test`, `npm run test:db`, `--census`, and the owner's faster check (2026-10-21): `node scripts/corpus/sabotage.mjs --rows .superpowers/sdd/2026-11-07-ilija/rows.txt` for the new rows plus rows whose suites these tasks touched. Every row must go red. A red baseline or a green row stops the deploy.

- [ ] **Step 2: Review.** Fresh Opus reviewer over the whole branch diff, with named risks: the Review Focus list; a caller detail reaching a `hipaa` tenant; a second email from one call; a false "booked" with appointments off; own-number leakage into a save; other tenants' prompts changing beyond the listed lines. Fix what it finds, each with a test.

- [ ] **Step 3: Read before deploying.** With `CLOUDSDK_CONFIG=~/.gcloud-vetra2`: traffic is still `00112-boh` at 100%; `SMTP_USER`, `DASHBOARD_URL` and `NOTIFICATIONS_ENABLED` are set as expected on `voice-uk-prod`; `statusCallback` points at `voice-uk-prod` on all three numbers: `node scripts/uk-number.js show` for `+441372656055`, `UK_NUMBER_TARGET=us node scripts/uk-number.js show` for `+18176011171`, and a read-only Twilio REST fetch with account B's credentials for `+18175803291`. A missing callback gets reported before anything moves.

- [ ] **Step 4: Build from the main checkout** (never an LF worktree; memory `prod-migration-checksums-crlf`):

```bash
gcloud builds submit --config=cloudbuild.yaml --substitutions=_TAG=<sha> \
  --service-account=projects/vetra-core-edc8ca/serviceAccounts/vetra-deployer@vetra-core-edc8ca.iam.gserviceaccount.com \
  --project=vetra-core-edc8ca
```

- [ ] **Step 5: Migrate.** Update job `vetra-migrate-uk-prod` to the image, run `migrate.js --status` (expected: only 059 pending), apply, re-run status.

- [ ] **Step 6: Deploy with no traffic, then move it.** Owner pre-approved this if the gate passed. `gcloud run services update voice-uk-prod --image=us-central1-docker.pkg.dev/vetra-core-edc8ca/vetra/voice:<sha> --no-traffic --project=vetra-uk-edc8ca --region=europe-west2`, read the new revision's env back, then `update-traffic --to-revisions=<new>=100`.

- [ ] **Step 7: Write Ilija's config** with `import-tenant.js` (`IMPORT_TENANT_B64`), then read back with `--show` and `db-inspect --counts` and compare machine to machine. Report the revision, the sha and the rollback command.

### Task 17: Live calls (owner ~1-1.5 h, ~$7.20)

**Files:**
- Create: `docs/ilija-test-calls.md` (a one-page sheet: what to say for each call, what passes)

**Interfaces:** none.

- [ ] **Step 1: Write the sheet** from the spec's 15 calls, using the fresh names from `docs/receptionist-test-calls-2026-10.md`, with a separate phone or a withheld number for at least one call.

- [ ] **Step 2: Ask the owner (~$6), who makes the 15 calls on the UK line.** After each batch, read rows, emails and logs. Rules: a wrong outcome is reported straight away; anything else is re-run twice before it counts as a defect. Listen for "Ilija" in the greeting and report it without fixing it.

- [ ] **Step 3: Fix what fails** in the owning task's style (red first, row, commit). A prose fix is config only: re-run Task 14's prompt check and import again. A code fix re-runs Task 16's Steps 1-6. Each fix gets a re-test call.

- [ ] **Step 4: Ask the owner (~$1.20), then 3 calls on the Test Line:** leave a message (email has details); book (still works, booking email link-only); ask about the business (no trace of Ilija's wording).

- [ ] **Step 5: Commit the sheet.** `docs: Ilija test call sheet`

### Task 18: Hand over (~1 h)

**Files:**
- Create (not committed): `.superpowers/tenants/digile-uk-guide.md`
- Modify: `docs/receptionist-backlog.md`, `docs/readiness.md`, memory `ilija-inbound-2026-11`

**Interfaces:** none.

- [ ] **Step 1: Write Ilija's one-page guide.** What to try; ring the line directly first; how to turn forwarding on and off, with the code for his network checked by a test; what to expect (email addresses may be misheard, a short pause before replies, how it says names; no booking yet); how to send feedback. Ask the owner what format to send it in.

- [ ] **Step 2: With his answers,** set `notification_email` and `notification_phone`, and apply his answers on sales pitches, budget and 07426704500, through the form and an import. Read back. Tell him test rows exist.

- [ ] **Step 3: Forward test with Ilija.** He sets forwarding; the owner rings his mobile; he doesn't answer. Read the logs: is `From` the real caller; did `callerPhone` behave; is it one row and one email to him. Log the result. If `From` shows his number, that confirms Task 8 was needed and the assistant asks for a number on every forwarded call: tell the owner, because that changes what Ilija should expect.

- [ ] **Step 4: Update the records.**
  - Backlog: mark LVX185, 187, 188, 189 with revision and call IDs.
  - Add new backlog items: dashboard shows saved `details` (a healthcare business's link-only email leads to a dashboard that doesn't show them yet); self-serve signup must ask the healthcare question when it ships; dashboard screen for `callbackLine`.
  - `docs/readiness.md`: point to the onboarding form.
  - Memory: update status.

- [ ] **Step 5: Commit** the docs by exact path, leaving the owner's other uncommitted work alone. Report to the owner: what's live, the failures that remain from Task 6, Google Cloud trial date, and Stage 2 next (LVX182, then the calendar for whichever system Ilija named).

---

## Starting message for each session (paste into a fresh session)

```text
Ilija inbound receptionist, session S<n> (tasks <range>). Read
docs/superpowers/plans/2026-11-07-ilija-inbound-receptionist.md (Global Constraints, Review Focus, your tasks) and
docs/superpowers/specs/2026-11-04-ilija-inbound-receptionist-design.md. Ledger:
.superpowers/sdd/2026-11-07-ilija/ledger.md. Branch feat/outbound-stage4.
FIRST: reiterate in one short plain paragraph (steps, hours, $) and ask anything needed.
All code generic, Ilija only in config. Red first. Ask before any paid run. Cheaper models for mechanical tasks,
Opus reviews on Tasks 6, 10, 13 and the whole branch at Task 16. Remind the owner: Google Cloud trial ends 2026-11-18.
```
