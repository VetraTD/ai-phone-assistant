# LVX192 save guard + transfer screening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.
> Owner-chosen execution: Sonnet implementers (independent tasks only), Opus risky-first review after Task 3 (save
> guard) and Task 8 (screening), Opus final review; Critical/Important fixed per task, all Minors in one wave.

**Goal:** every owner email carries what the caller said; a screened transfer never lands in a voicemail.
**Architecture:** a counter-based `end_call` gate + a post-call Q&A note written in `finish()` before the email window
+ a parsed-notes "open questions" fact in the save reply; screening = `<Number url>` whisper + `<Gather>` + an
`accepted_at` stamp on `pending_dials` read by transfer-result.
**Tech:** Node ESM, vitest, Postgres (local docker :55432), Twilio TwiML, Gemini Live.
**Spec:** `docs/superpowers/specs/2026-11-23-lvx192-save-guard-design.md` (read it: Design, corrections and rulings live there).

## Global Constraints

- Generic code: no branch on a business name/ID; per-business behaviour only from config columns.
- No caller words in any log line (outcome, counts, lengths only). No new env var. Avoid the word "recorded" in new
  comments (recordingClaimLint).
- Byte-identical default TwiML when screening is off; cascade behaviour unchanged by fixes 1 and 3 (presence-gated).
- `hangup-without-asking`, `completion-ask-note`, `transfer-has-action`, `transfer-result-completed-hangs-up`,
  `pending-dial-ended-on-result` sabotage anchors must still match once: `node scripts/corpus/sabotage.mjs --census`
  after every edit to `lib/voice/live/index.js`, `lib/voice/live/tools.js`, `services/tools.js`,
  `capabilities/messages.js`, `lib/twiml.js`, `server.js`, `lib/transferOutcome.js`, `lib/voice/session.js`.
- One heavy vitest run at a time (RAM); implementers check no vitest is running before starting one.
- Root tests: `npx vitest run <files>`. DB tests: `DATABASE_URL=<local url from .superpowers/sdd/2026-09-29-outbound-stage4/gate.sh> npm run test:db -- <files>`.

## Review Focus

1. "No that's all, thanks, bye" right after a save → guard does NOT refuse (Task 1 + Task 3 test).
2. A call longer than 40 turns / 4000 chars → unsaved count still correct (monotonic counter; Task 3 test with 45 turns).
3. `record_customer_request` and `end_call` in the SAME tool batch → the save stamps before the gate reads (Task 3 test
   via `callToolBatch`).
4. Caller hangs up mid-turn right after answering (words only in `turnUserText`) → note includes them (Task 4 test).
5. Dispatcher presses 2 / presses nothing / whisper request with an unknown `ParentCallSid` → leg hangs up, caller gets
   the message step (Task 8 tests).

---

### Task 0: Branch, spec and plan files

- [ ] `git checkout -b fix/lvx192-save-guard feat/hammersleys-demo`; check `ls node_modules | wc -l` ≈ 269.
- [ ] Write the Design section to `docs/superpowers/specs/2026-11-23-lvx192-save-guard-design.md` and the plan to
      `docs/superpowers/plans/2026-11-23-lvx192-save-guard.md`; run `node scripts/corpus/sabotage.mjs --census` and
      record the baseline (expect only the known stale `p4-d1-preset-sends-to` row).
- [ ] Commit `docs: LVX192 save guard + transfer screening design and plan`.

### Task 1: `lib/voice/unsavedAnswers.js` (pure)

**Produces:** `isInformativeCallerTurn(text: string, prevReply: string): boolean`;
`countUnsaved(turns: {index:number, caller:string, prevReply:string}[], savedThroughTurn: number): number`
(counts informative turns with `index > savedThroughTurn`).
- [ ] Test `tests/unsavedAnswers.test.js`: informative — "two passengers", "card", "BA2490", "yes a child seat";
      not informative — "", "um", "No, that's all, thanks", "thanks, bye", "cheers"; "yes"/"that's right" NOT
      informative when prevReply = "22 Godstone Road, RH7 6AA, is that right?" but informative when prevReply =
      "Do you need a child seat?"; `countUnsaved` with savedThroughTurn 3 over indexes 1..6 counts only 4..6.
- [ ] Run → FAIL (module missing). Implement (reuse `isHesitationOnly` from `lib/transcriptUtils.js` and any existing
      closer predicate there). Run → PASS. Commit.

### Task 2: Save-guard refusal in `services/tools.js` `case "end_call"`

**Consumes ctx:** `unsavedCallerTurns:number`, `messagesSaved:number`, `promisedWithoutSave:boolean`,
`saveGuardSpent:boolean`. **Produces:** refusal `stateEffects.endCallRefusal === "unsaved"`.
- [ ] Tests in `tests/endCallSaveGuard.test.js` calling `executeToolCall` (pattern: `tests/liveEndCallAsk.test.js:515-575`):
      refuses when messagesSaved 1 + unsaved 2; passes when unsaved 0; passes when `saveGuardSpent`; refuses when
      messagesSaved 0 + promisedWithoutSave + unsaved 1; no gate when `unsavedCallerTurns` is absent (cascade ctx) —
      result identical to today; no gate on an outbound ctx; refusal ordering: unsaved beats no_ask when both apply;
      counters `end_call_save_guard_ran` / `end_call_refused_unsaved` bumped.
- [ ] FAIL → implement (new `skipOnOutbound` name, kind added to JSDoc enum `:454` and to
      `lib/voice/live/summary.js` accepted kinds) → PASS → census → commit.

### Task 3: Live wiring (state, latch, ctx, live text harness)

**Consumes:** Task 1, Task 2. **Produces (in `lib/voice/live/index.js`):** `turnLog` (`{index, caller, prevReply,
voiced}`, last 40, written at turn close incl. voiced-but-empty turns), `savedThroughTurn:number`,
`customerRequestsSaved:number` (record_customer_request only), `lastSaveArgs:object|null`,
`saveGuardSpentAt:number|null`; `turnState()` fields from Task 2 plus `saveGuardPending:boolean` (an "unsaved"
refusal happened and no save since); runner same-batch override in `lib/voice/live/tools.js`.
- [ ] Tests with `tests/helpers/liveBoot.js` `bootLive` in `tests/liveSaveGuard.test.js`: (a) caller answer → save in
      same turn → end_call passes; (b) save → assistant question → caller answer → end_call refused "unsaved" → re-save
      → end_call passes; (c) after a refusal with no new save, the next end_call passes (latch); (d) Review Focus 1, 2, 3;
      (e) `live_call_summary` carries `end_call_refusals.unsaved`; (f) refusal turn does not arm the sign-off exit;
      (g) a voiced turn with empty transcription counts as unsaved; (h) a call whose only save is
      `record_quote_request` is never refused "unsaved"; (i) the guard-forced save with no open questions: reply has
      no `COMPLETION_ASK_NOTE`, the LVX132 latch is not re-armed, and the next end_call passes.
      Extend `tests/liveToolContext.test.js` for the four ctx fields. Add the fields to
      `lib/harness/liveTextSession.js:164-173` with a unit test that they are numbers/booleans.
- [ ] FAIL → implement → PASS → census → commit. **Opus risky-first review (Tasks 1-3)** → fix C/I → re-review.

### Task 4: After-save note (`lib/voice/afterSaveNote.js` + `finish()` chain)

**Produces:** `AFTER_SAVE_LABEL = "Said after the last save (unchecked transcript)"`;
`afterSaveNote({ turnLog, savedThroughTurn, inFlight }): { label, answer } | null` (answer ≤500, word boundary,
`"<question ≤80>" — <words>` joined " / ").
- [ ] Unit tests `tests/afterSaveNote.test.js` (format, cap, closers skipped, null when nothing informative).
- [ ] Session tests `tests/messageAfterSaveNote.test.js` (template `tests/messageAfterCall.test.js:81-225`): hang-up
      after a payment answer → `updateCustomerRequest` called with details containing the label and "card"; same
      caller_name + message as the last save (one row, merged); not written when no save happened (owed path's job),
      when the owed path wrote, on a healthcare tier, on outbound, when nothing informative followed the save;
      Review Focus 4 (in-flight words); the write is dispatched before any awaited verify step (order assertion like
      the owed-path tests); log line has no caller words.
- [ ] FAIL → implement → PASS → census → commit.

### Task 5: Open notes questions in the save reply

**Produces:** `parseNotesQuestions(notes): {n, label, words, compact}[]`, `openQuestions(questions, savedLabels): same[]`
in `lib/capabilities/notesQuestions.js`; `stateEffects.questionsOpen:boolean`; `capabilityState.messages.savedLabels`.
- [ ] Unit tests `tests/notesQuestions.test.js` on the real Hammersleys v6b notes (labels Pickup, Destination, When,
      Passengers, Luggage, Payment) and Digile notes (6 items: company, industry, sell, main…, email address,
      roughly…marketing); "Pick-up address" answers Pickup; "Company" answers "Their company"; unnumbered notes → `[]`.
- [ ] Pack tests (extend `tests/intakeProtocol.test.js` or new `tests/messagesOpenQuestions.test.js`): three labels
      saved in one save → reply lists "4. Passengers, 5. Luggage, 6. Payment" in order and keeps the "new enquiries
      by default" clause; labels persist across two saves; all answered → the all-answered sentence; a save whose
      labels match no numbered question (complaint "Trip date"/"What happened", URGENT name/where) → today's text;
      notes without "?"/"ask" → today's text; healthcare tier byte-identical; no numbered list → today's text;
      `ctx.saveGuardPending` + nothing open → the quiet-save sentence and `stateEffects.quietSave = true`.
      Live runner tests: `COMPLETION_ASK_NOTE` absent when `questionsOpen` or `quietSave`, present otherwise;
      `quietSave` does not re-arm the ask latch (`live/tools.js:654-667`).
- [ ] FAIL → implement → PASS → census → commit.

### Task 6 (worktree, parallel with 1-5): Migration 063 + config fields

Worktree: `git worktree add -b fix/lvx192-screening C:/Users/nithi/VetraTD/ai-phone-screening fix/lvx192-save-guard`
(+ node_modules junction; delete the junction before `git worktree remove`). Cherry-pick onto the main branch after.
**Produces:** config `transferScreening:boolean`, `transferWhisper:string|null`; db methods
`notePendingDial({..., screened})`, `pendingDialBusiness(callSid): Promise<string|null>`,
`acceptPendingDial(callSid): Promise<number>`, `pendingDialOutcome(callSid): Promise<'unscreened'|'accepted'|'not_accepted'>`.
- [ ] DB tests `tests/db/transferScreening.test.js`: defaults false/null; whisper >200 chars rejected; screened dial →
      outcome `not_accepted`; after accept → `accepted`; unscreened → `unscreened`; vetra_app cannot read
      `pending_dials` directly; fold test `tests/migration063Fold.test.js`; `tests/capabilityConfig.test.js` loadConfig
      strictness; `tests/importTenantFields.test.js`; `tests/setBusinessConfig.test.js` (combo with own_voicemail refused).
- [ ] FAIL → migration + schema fold + `services/db.js` + import/set-config/inspect → `npm run db:migrate` locally →
      PASS → commit.

### Task 7 (worktree): TwiML + dial sites

**Produces:** `buildTransferTwiml({..., whisperUrl?})`, `buildTransferWhisperTwiml({ text, sayVoice, actionUrl })`,
`buildTransferAcceptTwiml(accepted: boolean)`, `screeningEffective(config): boolean`,
`TRANSFER_WHISPER_PATH = "/twilio/transfer-whisper"`, `TRANSFER_ACCEPT_PATH = "/twilio/transfer-accept"`.
- [ ] Tests: `tests/twiml.test.js` new cases + existing pins unchanged; Live transfer with screening on → `<Number url=
      ".../twilio/transfer-whisper?b=<id>" method="POST">`, `callerId` = business number, pending dial screened with
      that callerId and extended timeout; screening on + `own_voicemail` → today's TwiML; cascade parity
      (`tests/session.test.js`).
- [ ] FAIL → implement → PASS → census → commit.

### Task 8 (worktree): Whisper/accept routes + transfer-result

- [ ] Tests `tests/transferScreenRoutes.test.js` (real app, pattern `tests/transferResult.test.js`): whisper says the
      business's own text, else the generic sentence with the business name, in its TwiML voice; `?b=` mismatch /
      unknown ParentCallSid / DB error → `<Hangup/>`; accept Digits "1" → stamp + `<Response/>`; Digits "2" / missing
      → Hangup; accept stamp fails twice → Hangup (fail closed) + error log; one transient failure then success →
      bridge. transfer-result: `completed` + `not_accepted` → message
      step; `completed` + `accepted` → Hangup; unscreened → today's behaviour (update `:87-93`).
      `tests/transferOutcome.test.js` new cases; `tests/liveRouteParity.test.js` both routes on the any-account validator.
- [ ] FAIL → implement → PASS → census → commit. **Opus risky-first review (Tasks 6-8)** incl. the named risks
      (loop guard with business callerId, pending-dial expiry, fail-closed paths) → fix C/I → cherry-pick onto
      `fix/lvx192-save-guard`.

### Task 9: Sabotage rows + backlog

- [ ] Add 4 rows to `scripts/corpus/sabotage.mjs` (save-guard condition, after-save note write, open-questions list,
      screened-not-accepted outcome); hand-verify each goes red with its suite (`--only <row>` in the gate worktree,
      never the main tree); census clean.
- [ ] `docs/receptionist-backlog.md`: LVX192 → FIXED (code), new entries for screening; commit.

### Task 10: Eval scenarios (gitignored) + free self-test

- [ ] `.superpowers/hammersleys/scenarios/09-three-in-one-line.js` (opens with time + pickup + destination in one
      line; asserts passengers, luggage, payment each ASKED and saved), `10-hangup-after-payment.js` (persona
      END_CALL right after the payment answer; asserts everything before payment was saved before payment was asked —
      the note itself is proven by Task 4, the eval never runs `finish()`), `11-detour-then-book.js` (a trip outside
      the UK declined, then a real Gatwick booking; asserts the saves carry the real booking).
- [ ] Each gets `selftest.good` + ≥2 `bad`; `node .superpowers/hammersleys/selftest-asserts.mjs` reports every bad
      call failing; commit nothing (gitignored).

### Checkpoint (after Tasks 0-10)

- [ ] Gate worktree at the branch head; full root suite in a separate mintty window with `NODE_EXTRA_CA_CERTS` and
      local `DATABASE_URL`, then `npm run test:db`, then `npm run test:corpus`; census. Expected: all green except
      known baselines.
- [ ] Opus final review over the whole branch (source-only diff); one Minor wave; re-run the touched suites.

### Task 11: Config v7 (owner yes before any import)

- [ ] Edit `build_tenant_final.py` → v7 (Design: Config v7), save `tenant-*-v7.json`, check notes ≤1950, render with
      `scripts/render-tenant-prompt.js`, db-vs-payload, local-DB dry-run import, show the owner the v6b→v7 diff.

### Task 12: Paid sims (owner pre-approved ≤ $5)

- [ ] Local server (check :3000 free); state the token estimate; run scenarios 09-11 at N=2 first with
      `npm run eval -- --scenarios .superpowers/hammersleys/scenarios --filter ... --no-judge`, then the 8 existing at
      N=1 if budget remains; report k/N per assert; stop at $5.

### Task 13: Deploy (owner yes at EACH step; record old values in `prod-change-log.md`)

- [ ] Record: serving revision (`00120-qpn`), migrate job image, tenant payloads v6b.
- [ ] Build from the MAIN checkout, clean tree (CRLF checksum trap): `gcloud builds submit --config=cloudbuild.yaml
      --substitutions=_TAG=<sha> --service-account=…vetra-deployer… --project=vetra-core-edc8ca`.
- [ ] Migrate job → new image → `migrate.js --status` → `migrate.js` (applies 063, additive; 00120 keeps working) → read back.
- [ ] `gcloud run services update voice-uk-prod --image=…:<sha>` (0 % traffic, pinned) → smoke the tagged URL
      (health; new routes 403 unsigned) → owner yes → `update-traffic --to-revisions=<new>=100` → read traffic back.
- [ ] Re-import both tenants with v7 via the migrate job; db-inspect read-back (screening true, whisper set, notes
      length); delete both import executions.
- [ ] Rollback: `update-traffic --to-revisions=voice-uk-prod-00120-qpn=100`; re-import `tenant-*-v6b.json`; 063 stays.

### Task 14: Measure and evaluate

- [ ] Validate `.superpowers/hammersleys/census/analyze-unsaved-answers.mjs` on known-bad CAecaa4bd1 (must flag it);
      record the before numbers (3/30 + 2 no-save); after = Digile calls since the deploy (re-pull when enough exist).
- [ ] Owner makes the 5 "done when" calls (second phone, US test line). For each: `live_call_summary`
      (`end_call_refusals`, `after_save_note_*`, first-reply ms, tokens/turn vs ~1.2 s / ~11k), Twilio child legs
      (`calls.list({parentCallSid})`: answered-after, duration), and the forwarded email. Report pass/fail per call.

### Task 15: Close

- [ ] superpowers:verification-before-completion; update memories (hammersleys-taxis-prospect, tenant-config-traps,
      four-items-plan-2026-11-23) and backlog LVX192; superpowers:finishing-a-development-branch.

## Verification summary

Unit + session tests per task (vitest), DB tests for 063, census after every hot-file edit, 4 new sabotage rows
proven red, corpus replay of real calls, full root suite at the checkpoint, free self-test before paid sims, paid sims
≤ $5 as k/N, and the owner's 5 real calls evaluated from logs, Twilio and the email.

## Time

~12 h of work, ~9-10 h wall with Tasks 6-8 in parallel (estimates given to the owner up front).
