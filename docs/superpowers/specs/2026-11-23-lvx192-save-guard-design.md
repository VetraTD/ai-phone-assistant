# Hammersleys fix session — LVX192 save guard, recovery note, open questions, transfer screening, config v7

## Context

Owner's real calls on the Hammersleys US test line (+14692810667) and a log census of Digile show one defect on
every business: answers the caller gives after the receptionist's last `record_customer_request` save never reach
the owner email, while the AI says "passed to the dispatcher" / "passed on to Ilija" (3/3 real booking calls;
Digile 3/30 saved calls + 2 no-save promises). Prompt wording ("save after every answer") holds ~2 in 3 calls, so
it needs code. Separately, an inbound transfer to the dispatcher's mobile was answered by the mobile's voicemail
(Twilio reports `completed`), so the caller heard a personal voicemail instead of our message step. Jason
(Hammersleys) does not get the number until the five "done when" calls in
`.superpowers/hammersleys/fix-session-brief.md` pass.

Branch: new `fix/lvx192-save-guard` from `feat/hammersleys-demo` (7 unpushed commits on `feat/outbound-stage4`).
Prod: voice-uk-prod serves `00120-qpn` 100%, traffic PINNED (deploy needs update-traffic). Config v6b live on
tenants 2ada1dd4 (UK) and 7df62558 (US).

## Owner decisions (2026-11-23, AskUserQuestion)

| Question | Decision |
|---|---|
| Screening default for Hammersleys | ON (new per-business setting; default OFF = today for everyone else) |
| Caller ID on a screened transfer | Business number when screening is on (derived, no extra switch) |
| Recovery | Code-only Q&A note, labelled as unchecked transcript (no model call) |
| Paid sims | Yes, cap $5 (N=2 on new scenarios first; report k/N; stop at cap) |
| Fix 1 approach | A: count caller turns since the last save, one refusal per save |
| Fix 3 approach | A: code parses numbered notes items, matches saved labels, lists open ones as a fact |
| Whisper wording | Generic default + optional per-business text |

## What the code says today (verified by reading, file:line)

- Save reply = `capabilities/messages.js:502-548`; `next` carries `NEXT_QUESTIONS_NOTE_STANDARD` (`:61`) when the
  business has notes. Notes are never parsed (`lib/capabilities/requirements.js:349`).
- On Live every successful action reply ALSO gets `next_step = COMPLETION_ASK_NOTE` ("ask whether there is anything
  else", `lib/voice/live/tools.js:136-140, 727-731`). Two conflicting orders in one reply: the likely cause of the
  "three answers in one line → read back → end_call" call (CA13bffc75).
- `end_call` gates: `services/tools.js:580-1119` (hesitation, LVX185 caller question `:858`, LVX132 no_ask `:900`
  whose `if` line is the sabotage anchor `hangup-without-asking` and must stay byte-identical). Live-only gates are
  presence-gated on ctx fields so the cascade is untouched.
- No counter of caller turns since the last save. `messagesRecordedThisCall` (`index.js:2399, 6996`) is a count only;
  `callerTurnsThisCall` keeps the last 40 caller turns (`:2421, 3363`); `callerSaidThisCall` is capped at 4000 chars
  (a length comparison stalls on long calls — do not use it).
- Closing paths besides `end_call`: LVX146 sign-off detector (`index.js:4502-4630`), silence-ladder goodbye, caller
  hang-up. All end in `finish()` (`index.js:10001`).
- Owner email is NOT sent from `finish()`: `/twilio/status` → `flushOwnerNotices` sleeps 2 s then claims rows
  (`server.js:1284-1294`, `lib/ownerNotices.js:33-47`). A write must start before any await in `finish()`
  (`lastChanceSettled = saveOutstandingMessage().then(saveOwedMessage)`, `index.js:10064`).
- `saveOwedMessage` (`index.js:9907`) already writes one message from the caller's own words when NOTHING was saved
  (`lib/voice/messageOwed.js`). Fix 2 is its sibling for "saved, then more was said".
- A re-save with the same caller_name + message merges into the same row (`customerRequests.js:282-327`,
  `mergeDetails` by label). Details are `{label, answer}` only (label ≤60, answer ≤500, ≤20 answers).
- Inbound transfer TwiML: `lib/twiml.js:91-99` `buildTransferTwiml` (bare number, no `<Number url>`); callers
  `index.js:8790-8796` (callerId = caller's number) and cascade `lib/voice/session.js:2707-2715`. Pending dial noted
  at `index.js:8802-8807` (`app_record_pending_dial`, `database/054_loop_guard_block_list.sql`).
- Outbound whisper (`lib/outbound/doorRoutes.js:565-608`) is `<Say>` only — no Gather, no acceptance record. Reusable:
  `<Number url=…>` shape, lookup by `ParentCallSid`, `?param` cross-check, `twilioValidationAnyAccount`.
- `/twilio/transfer-result` = `server.js:975-1024` + `lib/transferOutcome.js:20-23` (`completed` → hang up, else
  message step `buildMessageTwiml`).
- `transfer_no_answer = own_voicemail` rings 45 s so the business's voicemail answers — contradicts screening.
- Eval harness never runs `finish()`; `lib/harness/liveTextSession.js` turnState supplies only a few fields, so a new
  Live gate is invisible to paid sims unless its fields are added there.

## Goals / non-goals / anti-goals

- **Goal:** the owner email always carries what the caller said; a voicemail can never take a transferred caller on
  a screened business. Generic code, client specifics in config only.
- **Non-goals:** LVX190 (meta text spoken), LVX191 (doubled speech), trip email subject, iCabbi, dashboard UI for the
  new settings (operator-only, like `allow_pricier_numbers`).
- **Anti-goals:** a guard that loops or holds a caller on the line; any added latency on the normal path; caller
  words in logs; a model inventing details into the owner email; a behaviour change for businesses that did not
  opt into screening.

## Design

### Fix 1 — save guard (end_call refused once while answers are unsaved)

- **New pure module `lib/voice/unsavedAnswers.js`:** `isInformativeCallerTurn(text, prevReply)` → false for empty,
  hesitation-only (`isHesitationOnly`), plain closers ("no", "no thanks", "that's all", "thanks", "bye", "cheers",
  reuse an existing closer predicate if `lib/transcriptUtils.js` has one), and a bare affirmation ("yes", "correct",
  "that's right") when `prevReply` was a read-back question. Everything else counts (a misheard turn with voiced
  speech but empty text counts — conservative: costs one re-save).
- **State in `lib/voice/live/index.js`** (see corrections below: turn-close hook, record_customer_request-only count,
  same-batch override): monotonic `callerTurnsNoted`, a capped `turnLog`
  (`{index, caller, prevReply}`, last 40) for fix 2, `savedThroughTurn` stamped in `recordToolOutput` on every
  successful `record_customer_request` = `callerTurnsNoted + (in-flight turnUserText non-empty ? 1 : 0)` (the save
  covers the utterance it answers), `lastSaveArgs` (in-memory only, never logged), and the latch
  `saveGuardSpentAt` (= `savedThroughTurn` when an "unsaved" refusal is seen). `turnState()` exposes
  `unsavedCallerTurns` (informative noted turns with index > savedThroughTurn, plus the in-flight turn),
  `messagesSaved`, `promisedWithoutSave` (`assistantPromisedThisCall && messagesSaved === 0`), `saveGuardSpent`.
  Plumbed through `lib/voice/live/tools.js` ctx builder (`:435-603`); `tests/liveToolContext.test.js` proves the wire.
- **Gate in `services/tools.js` `case "end_call"`**, after the LVX185 caller-question block and before the LVX132
  no_ask block (anchor line untouched). Runs only when `typeof ctx.unsavedCallerTurns === "number"` (Live + live text
  harness; cascade unchanged), inbound only (register a `skipOnOutbound` name), messages pack enabled,
  `allowedByExistingGates`, `!ctx.saveGuardSpent`, and
  `(messagesSaved > 0 || promisedWithoutSave) && unsavedCallerTurns > 0`.
  Refusal (shape as no_ask): `success:false`, model text "[not caller speech] NOT A FAILURE, the call is still open.
  The caller has told you more since your last save, and the business only gets what is saved. Call
  record_customer_request now with the caller's name, the same message and every detail so far, then carry on. Do not
  say goodbye on this turn."; `stateEffects.endCallRefusal: "unsaved"`, callerSafe toolResult "Just a moment.".
  Counters `end_call_save_guard_ran` (positive twin) and `end_call_refused_unsaved`. Add "unsaved" to the kinds in
  `lib/voice/live/summary.js:99,167` and the JSDoc enum `services/tools.js:454`.
- **Cannot loop:** one refusal per save stamp (a new save resets it); the no-save-promise variant once per call.
- **Spoken goodbye without end_call / caller hang-up:** not held; fix 2 catches the unsaved words.
- **Normal-path cost:** one integer per caller turn. Refusal adds one tool round-trip only on calls that had unsaved
  answers (the defect case).
- **Live text harness:** `lib/harness/liveTextSession.js:164-173` turnState gains the same four fields (its own turn
  counting) so the paid sims exercise the gate.

### Fix 2 — after-save note (post-call, code only)

- **New pure module `lib/voice/afterSaveNote.js`:** `afterSaveNote({ turnLog, savedThroughTurn, inFlight })` →
  `{ label, answer } | null`. One detail, label `Said after the last save (unchecked transcript)` (46 chars), answer =
  informative turns after the save as `"<last question sentence of prevReply, ≤80 chars>" — <caller words>` joined
  " / ", capped 500 at a word boundary. Null when nothing informative.
- **`saveAfterSaveNote()` in `index.js`**, chained in `finish()`:
  `saveOutstandingMessage().then(saveOwedMessage).then(saveAfterSaveNote)` (no await before it; census the anchor).
  Runs only when inbound, not healthcare tier, not hipaa, business + call row present, `messagesRecordedThisCall > 0`,
  the owed path did not write (`afterCallMessagesSaved === 0`), `lastSaveArgs` present, note non-null. Writes through
  `runner.handleToolCall` with `lastChanceWrite = true`, args = `lastSaveArgs` + `details:[note]` (same name +
  message → same row, merged), effects marked `afterCall = true`, `recordToolOutput` + `dispatchEffects` exactly as
  `saveOwedMessage`. Log outcome only `{callSid, ok, turns, ms}`; counters `after_save_note_saved/failed`.
- Email: no template change — the detail renders as `label: answer` (`services/notifications.js:403-423`). The label
  IS the "recovered, may have errors" marker.
- Known limits (documented, not fixed): a row already holding 20 answers drops the note (Hammersleys uses ≤11); a
  write slower than the 2 s settle reaches the row/dashboard but not the email (measured via `ms`).

### Fix 3 — open notes questions named in every save reply

- **New pure module `lib/capabilities/notesQuestions.js`:** `parseNotesQuestions(notes)` → numbered items
  `^\s*\d{1,2}[.)]\s+…` (≥2 items, else `[]`); label = text before a colon within 40 chars, else the item's first
  clause (≤40 chars); match words = lowercase content words minus a small stop list (a single-word label is always
  kept), plus a compacted form ("pick-up" = "pickup"). `openQuestions(questions, savedLabels)` → items with no word or
  compacted overlap with any saved label. Digile ("1. Their company.") and Hammersleys ("1. Pickup: …") both parse.
- **`capabilities/messages.js` execute (standard tier only; healthcare byte-identical):** savedLabels = union of
  `ctx.capabilityState.messages.savedLabels` and this save's labels (cap 20), persisted via
  `stateEffects.capabilityState.messages` (keep `firstSaveDone`; verify the merge semantics). When the scope rule in
  the corrections below holds, the questions note becomes: "[not caller speech] This business's questions with no saved answer yet: 4.
  Passengers, 5. Luggage, 6. Payment. If they apply to this caller, ask them now in that order, one at a time; if the
  caller already gave one, save it instead of asking again; skip any they would rather not answer. Then save again
  with the same message and all the answers in details." When none are open: "Every question in this business's
  notes has a saved answer." Deferred read-back path appends its existing sentence. No numbered list → today's text.
  `stateEffects.questionsOpen = open.length > 0`.
- **`lib/voice/live/tools.js:727`:** skip `COMPLETION_ASK_NOTE` when `result.stateEffects?.questionsOpen === true`
  (nested check, keep the `completion-ask-note` anchor), counter `live_completion_ask_note_skipped_open_questions`.
- Not a hard gate (owner chose A; "A + end_call refusal" held back until done-when call #2 says otherwise).

### Fix 4 — inbound transfer screening (per business, default off)

- **Migration `database/063_transfer_screening.sql`** (additive; fold into `database/schema.sql` + fold test like
  `tests/migration053Fold.test.js`): `businesses.transfer_screening boolean NOT NULL DEFAULT false`,
  `businesses.transfer_whisper text NULL CHECK (char_length(transfer_whisper) <= 200)`,
  `pending_dials.screened boolean NOT NULL DEFAULT false`, `pending_dials.accepted_at timestamptz`. New SECURITY
  DEFINER functions (REVOKE PUBLIC, GRANT vetra_app; existing 054 functions unchanged): mark a dial screened (or a
  screened twin of `app_record_pending_dial` — builder's call), `app_pending_dial_business(call_sid) → uuid`,
  `app_accept_pending_dial(call_sid) → integer`, `app_pending_dial_outcome(call_sid) → text`
  ('unscreened' | 'accepted' | 'not_accepted').
- **Config:** `services/db.js` `loadConfig` → `transferScreening` (strict `=== true`), `transferWhisper` (trimmed
  string | null), null-business defaults; db wrappers for the new functions. Effective screening =
  `transferScreening && transferNoAnswer !== "own_voicemail"`.
- **TwiML `lib/twiml.js`:** `buildTransferTwiml` gains optional `whisperUrl` → `<Number url="…" method="POST">num</Number>`;
  without it byte-identical (pins in `tests/twiml.test.js`, `tests/outboundTransfer.test.js:333`,
  `tests/session.test.js:1496`). New `buildTransferWhisperTwiml({ text, sayVoice, actionUrl })` →
  `<Gather numDigits="1" timeout="6" action=… method="POST"><Say>text</Say><Pause length="1"/><Say>text</Say></Gather><Hangup/>`,
  and accept → `<Response/>` (bridge) or `<Response><Hangup/></Response>`.
- **Dial sites** (Live `index.js:8786-8807`, cascade `session.js:2707-2715`): when screening is effective, whisperUrl
  `${base}/twilio/transfer-whisper?b=<businessId>`, callerId = the business's own number, pending dial noted with
  `caller_number` = the callerId actually sent, screened, and its timeout extended by the whisper allowance (~16 s).
- **Routes** (new `lib/transferScreenRoutes.js`, mounted in `server.js`, both behind `twilioValidationAnyAccount`,
  added to `tests/liveRouteParity.test.js`): `POST /twilio/transfer-whisper` resolves the business from
  `ParentCallSid` via `app_pending_dial_business`, cross-checks `?b=`, says `config.transferWhisper ||`
  "Call from the <business> AI receptionist. Press 1 to take it." in the business's TwiML voice; any failure →
  `<Hangup/>` (fail closed: the caller gets our message step). `POST /twilio/transfer-accept`: `Digits === "1"` →
  `app_accept_pending_dial` (one retry) → bridge; a stamp that still fails → hang up (fail closed, see corrections);
  any other digit or none → hang up.
- **transfer-result:** read the outcome before `endPendingDial` (keep the `pending-dial-ended-on-result` anchor
  block); `lib/transferOutcome.js` takes it: `not_accepted` → message step whatever `DialCallStatus` says; otherwise
  today's rule (anchor text `body?.DialCallStatus === "completed"` stays). Update `tests/transferResult.test.js:87-93`
  (a lookup now happens on `completed`).
- **Operator fields:** `scripts/set-business-config.js` FIELDS + VALIDATORS (`true`/`false`; whisper ≤200 chars, no
  newlines; refuse screening with `transfer_no_answer=own_voicemail`); `scripts/import-tenant.js` BUSINESS_FIELDS
  (+ the same combination check; `tests/importTenantFields.test.js` checks against migrations);
  `lib/db/businessConfigInspect.js` shows both (via `to_jsonb`, safe on an older DB).
- **Named review risks:** loop guard with the business number as callerId (`app_dial_bounced` matches caller or
  dialled number; `isOwnNumber` on a forward-back); pending-dial expiry vs the longer ring; what `DialCallStatus` the
  parent gets when the whisper leg hangs up (design does not depend on it; confirm on done-when call 5).

### Config v7 (Hammersleys only; `.superpowers/hammersleys/`, gitignored)

`build_tenant_final.py` → v7: notes item 3 "When: ask WHICH DAY and the time to pick up"; "If an answer makes no
sense or you did not catch it, ask again once"; more than 8 passengers OR 8 cases → "the dispatcher will confirm";
trip saves use message "Taxi booking request" by default; drop "Ask all six before saying it is passed on" (code now
names open questions); notes stay ≤1950 chars (v6b 1940). Business: `transfer_screening: true`,
`transfer_whisper: "Urgent taxi request from the AI receptionist. Press 1 to take it."`. Build → render →
db-vs-payload → local-DB dry-run import → show the owner the v6b→v7 diff.

## Files touched

New: `lib/voice/unsavedAnswers.js`, `lib/voice/afterSaveNote.js`, `lib/capabilities/notesQuestions.js`,
`lib/transferScreenRoutes.js`, `database/063_transfer_screening.sql`, tests for each.
Edited: `services/tools.js`, `lib/voice/live/index.js`, `lib/voice/live/tools.js`, `lib/voice/live/summary.js`,
`capabilities/messages.js`, `lib/harness/liveTextSession.js`, `lib/twiml.js`, `lib/voice/session.js`,
`lib/transferOutcome.js`, `server.js`, `services/db.js`, `database/schema.sql`, `scripts/set-business-config.js`,
`scripts/import-tenant.js`, `lib/db/businessConfigInspect.js`, `scripts/corpus/sabotage.mjs` (4 new rows),
`docs/receptionist-backlog.md` (LVX192 + new IDs). Existing tests updated: twiml, transferResult, transferOutcome,
liveToolContext, liveRouteParity, importTenantFields, setBusinessConfig, summary kinds.
Gitignored (`.superpowers/hammersleys/`): `build_tenant_final.py` (v7), `tenant-*-v7.json`, scenarios 09-11,
`selftest-asserts.mjs`, `prod-change-log.md`.

## Constraints

- Generic code only; Hammersleys specifics (screening on, whisper text, notes) live in its config.
- Security: no caller words in logs (outcomes/counts only); secrets read straight into env, never printed; Twilio
  account A, only the two Hammersleys numbers (no Twilio change is planned — number webhooks stay); record every old
  value before changing it; delete import execution records (they hold the owner's email/phone).
- Performance: no added latency on the normal path; measure first-reply time and tokens/turn on the owner's calls vs
  last session (~1.2 s, ~11k tokens/turn).
- Avoid the word "recorded" in new comments (recordingClaimLint); no new env var (envInventory); census after any
  edit to `index.js`, `services/tools.js`, `capabilities/messages.js`, `lib/twiml.js`, `server.js`.

## Builder-check corrections and my calls (2026-11-23)

- **Same-batch save + end_call (correction):** `recordToolOutput` runs after the whole batch (`index.js:7130`) while
  `turnState()` is read per call (`live/tools.js:404`). The runner in `lib/voice/live/tools.js` tracks a successful
  `record_customer_request` earlier in the SAME batch and passes `unsavedCallerTurns: 0` to later calls in that batch
  (LVX163's trap, `tools.js:558-567`). Review Focus 3 pins it.
- **Empty misheard turns (correction):** `noteCallerTurn` returns early on empty text (`index.js:3365`). The counter
  and `turnLog` entry are written at the turn-close site where voiced audio is known; a voiced turn with empty text
  counts as informative (conservative: one extra save).
- **Quote saves (correction):** `messagesSaved` counts successful `record_customer_request` only (new counter), not
  `messagesRecordedThisCall` (which includes `record_quote_request`).
- **Open-questions scope (my call):** list only when (a) the notes look like questions (`/\?|\bask\b/i`, the existing
  `messages.js:519` test), (b) ≥2 numbered items parse, and (c) at least one saved label already matches a numbered
  question (the caller is in that flow — so complaint / lost-property / URGENT saves with other labels get today's
  note). Keep today's "new enquiries by default, other callers only when the notes say so" clause in the new wording.
  Otherwise today's text, byte-identical.
- **After a guard refusal (my call, "ask once"):** the save the guard forced is a quiet one: when it leaves no open
  questions, its reply skips `COMPLETION_ASK_NOTE` and does not re-arm the LVX132 ask latch, and says "Saved. If the
  caller already said they need nothing else, say a short goodbye and call end_call; otherwise ask whether there is
  anything else." With open questions, the list wins (fix 3). The caller hears at most one extra sentence.
- **Accept stamp fails (my call):** fail closed. One retry; if the stamp still fails, hang up the dispatcher leg so the
  caller gets our message step. Never bridge an unrecorded accept (else transfer-result plays "nobody could get to the
  phone" after a real conversation, the defect `lib/transferOutcome.js:4-9` exists to prevent).
- **Fallback gap (owner, accepted for the demo):** server-down fallback (`n=+14699338887`) dials unscreened; no
  Twilio change now; add "fallback screening or strip n=" to the Hammersleys go-live gates (memory).
- **Done-when call 3 pass (owner):** pass = pickup, destination, when, passengers, luggage in the email; payment
  best-effort (words transcribed after Twilio's stop are lost, LVX83 stays parked).
- **Deploy order vs validation (owner's order, kept):** update-traffic happens before the five calls, so Digile gets
  fixes 1-3 before real calls check them. Mitigations: offline suites, corpus replay of real calls, paid sims, and a
  one-command rollback to `00120-qpn`.

## Left to the builder

Exact closer word list; the screened-dial SQL function shape; the cascade's screening wiring details; turnLog field
names; whether `turnSeq` or a new counter is cleaner, provided the tests below pin the ordering.
