# Plan: cuts become counters, a message is never lost (batch after the intake live check)

## Context

The intake live check (11-15/16, docs/ilija-test-calls.md "Intake round results") left two defects that the owner
approved fixing on 2026-11-16.

- **Cuts chop sentences.** Three cuts judge the model's own output transcript, which lags the audio: the ask cut, the
  reason re-ask cut, and LVX78's across-turn cut.
  - They fire after the caller has heard the words, chop the end off and leave silence.
  - 9 prod cuts in 30 days; none of these kinds helped, and twice the caller said "What?".
  - Prod runs `LIVE_ASK_CUT=off` (00132-cis) in the meantime.
- **Messages get lost.**
  - On call c15f30 the receptionist told a seller "I'll make sure to pass your message on". Nothing was saved and no
    email went out.
  - In S4, 2 of 4 UK calls hung up before any save.
  - The existing net (`messageOwedNoRow`, lib/postCallVerify.js:536) fires only when the assistant read the caller's
    number back. It also sends a different "Follow-up needed" alert, not the normal message email.

Item 3 (existing-client read-back skipped, call d8df81) is a free offline check only.

**Owner answers on 2026-11-15, this session:**
1. Cuts become counters **everywhere**, outbound and healthcare included.
2. The after-call message's Reason line is **the caller's own words**. The summary lands after the email is sent.
3. **Code-only for fix 2.**
   - There is NO in-call end_call refusal. The model gets no extra turn, so the doubled goodbye, narrating the save, a
     refusal loop and a stall cannot happen.
   - The after-call message runs on every ending: a caller hang-up, and the receptionist's own end_call.

Requirements source: `.superpowers/sdd/2026-11-14-intake/handoff-next-batch.md`. Item 2(a) is replaced by answer 3.

## What the caller hears, and the business's work

| Fix | Caller, good case | Caller, bad case | Business vs today |
|---|---|---|---|
| 1 Cuts → counters | Every question is heard whole. "What?" gets the full question again. | A model re-ask is heard whole, not chopped. It is counted, so we see it. | Same as today. |
| 2 After-call message | Exactly today's call. One goodbye, no extra turn. | None: nothing new is said to the caller. | Gets the normal message email instead of nothing. It carries the number (or "withheld" stated), the caller's own words (may be misheard), and a "left before the message was finished" line. No name. |
| 3 Read-back | Check only. | — | — |

## Rulings settled in planning (each: what — why — cost if wrong)

- **R1** The ask cut, the reason re-ask cut and the across-turn cut become count-only on every tier and direction.
  - This amends the byte-identity rule for those cuts only. Prompts and declarations stay identical.
  - Why: owner, 11-15. The flaw is the same everywhere; outbound is off and no healthcare client is live.
  - Cost if wrong: an outbound or healthcare re-ask is heard whole.
- **R2** The count-only events are renamed `live_ask_repeat_seen`, `live_reason_reask_seen` and `live_repeat_seen`
  (kind across_turns).
  - `live_repeat_cut` stays for within_turn only. The metrics.js closed list is updated.
  - Why: a counter called "cut" that never cuts misreads in every census.
  - Cost if wrong: 30-day comparisons need two names.
- **R3** Across-turn detection counts once per turn, on its own latch.
  - It does NOT set `repeatCutThisTurn`, so it never skips the within-turn check.
  - It counts even after the cut budget is spent.
  - Why: the only cut with a measured benefit must not be blinded by a counter.
  - Cost if wrong: none.
- **R4** Delete `LIVE_ASK_CUT` from code and .env.example, and remove it from prod on deploy.
  - `LIVE_REPEAT_CUT` stays: it still switches the within-turn and greeting cuts.
  - Remove `askCutNeedThisTurn`, `askReplyPendingCut`, `MAX_ASK_CUTS`, `askCutsThisCall` and
    `intakeAudit.reason_reask_cut`. `reason_reasked` already counts those turns.
  - Index.js stops passing askLedger's `cut` option. The option stays in askLedger.
  - Why: an ask that is no longer cut WAS heard, so the ledger must count it as asked.
  - Cost if wrong: one unused API option.
- **R5** The after-call message.
  - **Where and when:** in `finish()`, started in the same tick as `saveOutstandingMessage`, before any await. Its row
    then lands inside the status flush's 2 s settle, the same timing the last-chance save relies on. It is chained
    into `lastChanceSettled`, so verify waits for it.
  - **Scope:** Live, inbound, standard tier.
  - **Runs only when:** there is no pending-write stash, the rule says owed, `messagesRecordedThisCall === 0`, and
    `businessId && dbCallId` are set.
  - **How:** it goes through `runner.handleToolCall(record_customer_request)` with lastChance semantics, then
    `recordToolOutput` and `dispatchEffects`. That gives the same row and the same normal email via
    `claimOwnerNotices`.
  - **Interaction with verifyCall:** verifyCall then reads `messagesRecorded` 1, so its "Follow-up needed" net stands
    down. That net stays the fallback if this write fails.
  - **Args:**
    - `request_type`: callback_request if that intent was reported, else take_message
    - `caller_type`
    - no name, ever invented
    - message: the caller's own words this call (`callerSaidThisCall` + the in-flight `turnUserText`), capped near 500
      chars, then one neutral sentence that they left before the message was finished, plus that their number was
      withheld when it did not come through. Wording is about the caller, never "the assistant"
      ([[client-alerts-neutral-wording]]).
  - **Telemetry:** counters `message_saved_after_call` and `message_after_call_failed`. Logs carry the outcome only
    (LVX24).
  - Why: owner, 11-15 (code-only, caller's words). The email is on time and the same, with no model turn and no model
    cost.
  - Cost if wrong: a misheard Reason line. The number is right, and the summary is on the dashboard.
- **R6** Live only; the cascade is unchanged.
  - Why: verify and recover are Live-only for the same closure reason.
  - Cost if wrong: a cascade-fallback call can still lose a message, as today.

## Task 0 — controller preflight (~1 h, $0)

1. **Workspace and plan.**
   - Create the workspace `.superpowers/sdd/2026-11-16-cuts-and-messages/` with ledger.md, rulings.md and rows.txt.
   - Copy this plan to `docs/superpowers/plans/2026-11-16-cuts-and-messages.md` and commit it by exact path.
2. **Reread the named code:**
   - inspectAsk / inspectRepeat (index.js 5726-6061)
   - saveOutstandingMessage / finish (index.js 9835-10300)
   - messages.js save path (172-215, 500-662)
   - lib/capabilities/customerRequests.js saveCustomerRequest
   - lib/ownerNotices.js
   - the verify inputs (index.js 10111-10179)

   Log a preflight table and any new rulings ("Ruling: <what> — <why> — <cost if wrong>").
3. **Prototype "message owed"** in throwaway scratchpad scripts, written with the Write tool (never a heredoc).
   - **Data:** 30 days of prod logs, read-only `gcloud logging read`, `CLOUDSDK_CONFIG=~/.gcloud-vetra2`:
     - `live_call_summary` (intake.caller_type, ended_before_save, close_reason)
     - `postcall_verify` (message_owed = message intent declared)
     - `live_debug_assistant_turn` texts
     - `tool_duration` names

     Plus tests/fixtures/liveCalls and call-corpus.
   - **Hand-label** each call owed / not owed. Fixed points:
     - c15f30 owed: a seller, and the business's own seller rule takes messages (S4 call 2)
     - the S4 abandoned UK calls owed
     - wrong numbers and silent calls not owed
   - **Candidate rule** (pure function, lib/voice/messageOwed.js). Owed when all of these hold:
     - no message saved, the caller spoke, type is not wrong_number, the caller did not decline
     - AND one of:
       - (a) take_message/callback_request was reported this call
       - (b) the type is new_enquiry, existing_customer, personal or null, with reason_given

     Seller types count only through (a), and only when `businessHandlesSellerCalls(config)`.
   - **Settle with evidence:**
     - whether c15f30 reported a message intent; if not, add a promise detector on the assistant's own text
     - whether `other` + reason counts
   - **Decline** means the caller's turn right after an assistant message OFFER matches a decline pattern. Probe it on:
     - corpus caller turns
     - the shapes the current prompt produces: the message offer; the closing "anything else?" ("No, that's all"
       there must NOT read as a decline); the read-back check; the seller-default wording
   - **The bad case to measure:** an email for a call that needed none (false alarm). Each false hit is listed.
   - Record the rule, hits, misses and false hits as **Ruling P-owed**.
4. **Item 3 check (~20 min).**
   - Replay d8df81's save offline through `spelledReadBackNote` with: existing_customer, "Kwame Mensah", no email, no
     spelling, an Ilija-shaped config (notes with questions, confirmStyle default).
   - Run it with callerContext empty, and again with an upcoming appointment.
   - Check the P28 deferral path, and read the logs for what the save reply carried.
   - Ruling: the note was null (which branch), or it was sent and ignored. Fix only if new leads could be hit. A fix,
     if any, becomes a small sonnet task.
5. **Gate prep.**
   - Copy `run-gate-hotfix.sh` to `run-gate-batch.sh` in the new workspace (paths, rows file).
   - Gate trees clean, node_modules junction (~269 entries), test-audio present.

## Tasks (subagent-driven: sonnet implementer → sonnet task review; sequential, since both touch index.js; review 1 runs beside implementer 2)

**Every brief carries:**
- the implementer rules, `.superpowers/sdd/2026-11-07-ilija/implementer-rules-s3.md`
- red-first tests
- a sabotage row per behaviour, appended to rows.txt and hand-verified red after commit; census OK
- one vitest at a time, with `NODE_EXTRA_CA_CERTS`
- `git add` by exact path
- the trailer:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01D4eoyNFudTosBNWdhG5GYa
  ```

**Guard suites to run when touched:** envInventory, recordingClaimLint, promptConversationTruth, liveToolContext,
tools.test.js, liveCallerType, liveCorpusReplay, noTenantInRuntimeCode.

**Snapshots: zero files may change.** This batch makes no prompt or declaration change. That zero is the
byte-identity check for healthcare and outbound prompts.

### Task 1 — cuts become counters (~0.75 h) — R1-R4

**Files:**
- lib/voice/live/index.js: inspectAsk, inspectRepeat, the switches at 891-894, the reset sites 4701/5598/8379,
  intakeAudit
- lib/voice/metrics.js
- .env.example

**Tests:**
- tests/liveRepeatCut.test.js
  - the across-turn cases at :201, :526 and :729 now assert "counted, 0 cleared"
  - the LVX189 cases at :625, :658, :715, :772, :789, :825 and :871 now assert "seen, 0 cleared"
  - delete the `LIVE_ASK_CUT` case at :885
- tests/liveReasonReask.test.js: the cases at :109, :127, :252, :314 and :493 now assert "seen, 0 cleared"
- tests/liveCallerType.test.js:210: update the summary shape
- new: an across-turn match followed by a within-turn runaway in the same turn is still CUT

**Rows:**
- re-anchor reason-reask-cut, reason-cut-honours-repeat and hipaa-reason-never-cut so they go red on the count
- new: ask-seen-never-clears, reason-seen-never-clears, across-seen-never-clears, within-cut-after-across-seen
- recheck the dependent rows that prove themselves through `cleared.length`: ask-wire, decline-lift-late,
  confirm-tag-each, reason-final-clause, reason-alt3-clause-start, outbound-reason-kind-off,
  hipaa-ledger-keeps-q-class, reason-forgotten-after-save

### Task 2 — the "message owed" rule and the after-call message (~1 h) — P-owed, R5, R6

**New:** lib/voice/messageOwed.js
- the rule
- the offer/decline (and promise, if needed) patterns, exactly as prototyped
- the message-text builder

Unit tests use the prototype's real sentences and the new-prompt shapes.

**index.js:**
- track the offer/decline facts at turn close (a counter in the reducer, not a prompt cap)
- add a sibling of `saveOutstandingMessage`, started in the same tick in `finish()` and chained into
  `lastChanceSettled`

**Tests** (a finish-level harness, as saveOutstandingMessage's tests do):
- a lead hangs up mid-intake → one record_customer_request effect, with caller_type, the caller's words, and the real
  number via fallbackNumber
- the receptionist ends the call (end_call) with a message owed and none saved → the same single effect, and the
  caller-side sequence is unchanged (no refusal, no extra reply)
- withheld number → the text says so
- a save already made → nothing
- a stash present → the last-chance path only, never two rows
- wrong number / declined / silent / seller under the default / healthcare / outbound → nothing
- verify receives `messagesRecorded` 1

**DB test, if cheap** (tests/db): the row has `owner_notice_pending` true and `claimOwnerNotices` returns it.

**Rows:** aftercall-writes, aftercall-on-end-call, aftercall-not-twice, aftercall-hipaa-off, aftercall-declined-off,
aftercall-seller-default-off, aftercall-before-verify.

### After the tasks (controller)

1. **One opus whole-branch review** over the diff from 352e22f to HEAD. Named risks:
   - two rows or two emails for one call (stash, last-chance, a lease race)
   - an email for a call that needed none (false alarm)
   - the after-call row landing after the flush (an await before the write)
   - a write outside tenant scope (RLS fail-closed)
   - caller words in a log (LVX24)
   - ask-ledger state now that asks are heard
   - the within-turn cut still firing after an across-turn count
   - healthcare and outbound prompt identity (zero snapshots changed)
   - generic code

   Budget one fix round (sonnet) and a scoped re-review.
2. **Gate in mintty.** No watcher; read the log once at the expected finish.
   - Order: census, root, DB, then rows.
   - Rows: the new ones plus the mechanically touched ones (rows-touched.mjs), split across ai-phone-gate and
     ai-phone-shardb.
   - Pass: root green, DB passed (not skipped), every row red, gate trees clean. MIGRATE exit=1 on the LF worktree is
     expected.
3. **Build from the MAIN checkout.** Cloud Build `_TAG=<sha>`. Never re-submit after a reaped client; check
   `gcloud builds list`.
4. **Deploy** by ledger.md's "Deploy 6" route.
   - Migrate job image, then `--status`.
   - `gcloud run deploy ... --no-traffic --tag batch --remove-env-vars=LIVE_ASK_CUT`.
   - Then check:
     - a GET on the tag serves `Build: <sha>`
     - env diff vs 00132-cis = GIT_COMMIT_SHA plus LIVE_ASK_CUT removed, nothing else
     - SA and resources equal
     - boot log 0 WARNING+
     - revision JSON backed up to .superpowers/backups/
5. **ASK THE OWNER** before moving traffic.
   - Rollback after a move: 00132-cis, then 00130-pal, 00128-laf, 00126-kem, 00112-f84, 00111-8nw, 00110-vtk.
   - NEVER 00114-zub.
6. **Re-test** (owner's yes first; 4 calls, ~$1.60, US +1 817 601 1171), with the handoff's scripts:
   - seller → the after-call or model save email arrives
   - "What?" → the full question
   - existing client → the read-back, per item 3
   - a lead who hangs up → the after-call email

   Run `call-report.sh` per call, then `gcloud logging read` for the `_seen` and `_cut` events, `message_saved_after_call`,
   and the summary's barges.

## Verification

- **Each task:** a red-first test; its named suites green; rows hand-verified red; census OK; 0 snapshot files changed.
- **Gate and deploy:** the checks listed above.
- **Live re-test, read per call:**
  - `message_saved_after_call` on calls 1 and 4 (or a model save on 1)
  - the owner email arrived, with the number
  - the `_seen` counters
  - 0 `live_ask_repeat_cut` / `live_reason_reask_cut` events
  - no `end_call` refusal kind beyond today's

## Estimate (hours)

| Step | Time |
|---|---|
| T0 preflight, prototype, item 3 | 1 |
| T1 | 0.75 |
| T2 | 1 |
| Opus review + fix round | 0.5 |
| Gate (unattended wall) | ~1 |
| Build + no-traffic deploy + checks | 0.5 |
| **Total** | **~4.75 h**, ~1 h of it unattended gate |

- Dropping the in-call refusal saved ~1 h over the first draft.
- The handoff's ~4 h did not include the message-owed prototype, which must come before code, or a sharded gate.
- $0 until the re-test (~$1.60, owner's yes). The after-call layer adds no model call.

## Reminders

- The Google Cloud trial ends 2026-11-18. Confirm the paid account, or the demo line stops.
- Ilija's own email is still needed for the handover. The UK line's notices go to Joshua.
