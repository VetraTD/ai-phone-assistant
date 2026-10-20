# Round A1 "say it once" — implementation plan (2026-10-13)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native) or
> superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
> On approval this file is copied to `docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md` (first commit).

**Goal:** a caller never confirms or spells the same thing twice, and the call ends "anything else?" → no → goodbye.

**Covers:** LVX177 (save gates), LVX172 (spelled surname, first half), LVX178 (closing ask). LVX176 (`0fcd6f5`)
ships in part 2's deploy unchanged. NOT in scope: LVX167, LVX174, LVX175, LVX168–171.

**Spec:** `docs/receptionist-backlog.md` → LVX177, LVX178, LVX172, "Round A plan (owner, 2026-10-13)" (A1 done-when).
Owner decisions there are final.

**Tech:** Node 20 ESM, vitest, Gemini Live front-end (`lib/voice/live/index.js`), shared gate `services/tools.js`.

## Status

| Block | Content | Status |
|---|---|---|
| Plan | exploration + plan + 4 owner answers | **done 2026-10-13** (~0.9 h) — `b19cc5c` |
| S1 | T1 detectors, T2 save policy, T3 spell once, T7 replay/test updates | **done 2026-10-13** (~1.9 h active) — code head `a7d2d99`, see "S1 as built" |
| S2 | T4 prompts, T5 closing, T5b silence (added after S1), T6 measure, T8 rows, T9 full gate + ONE sabotage + opus review | **built 2026-10-13** (~2.5 h active) — code head `c185a97`; full sabotage pending, see "S2 as built" |
| S3 | I3: a same-call message correction updates the first message; one owner email (owner, after S2) | **done 2026-10-15** — code head `eb60198`, full sabotage PASS, see "S3 as built" |
| Part 2 | one deploy + live calls a–d | **done 2026-10-15** (~1.9 h) — LIVE `00103-nvc` @ `eb60198`; (a) (c) (d2) PASS, (b) FAIL, (d1) silence untested — see "Part 2 as built" |
| Part 3 | fix F1/F3/F4 (+ F2 decision), gate, redeploy, re-run (b) + (d1) | next — starting message under "Part 3" |

## Owner answers (2026-10-13, planning)
- Q1 same breath: **save in same breath**; when the read-back is not visible at tool time, refuse once with the
  engine-composed sentence; the caller's reply saves unless no/question/change (garbled or silent = save).
- Q2 split: **two build sessions** (S1 ≤3 h, S2 ≤3 h active), then part 2.
- Q3 execution: **native**, one opus whole-branch review during the full sabotage.
- Q4 baseline: **yes**, free log read of 10-03→10-13 (post-batch-2) during the sabotage wait.
- Defaults taken (no question needed; say so if wrong): a message's phone number is read back digit by digit
  INSIDE its one summary, not as a separate wait; outbound uses the same shared gate (outbound is off in prod);
  `correct_appointment_name` stays on today's rule (residual, recorded); a bare "um" after a read-back still refuses.

## Context — why, and what the code does today

Owner: "it shouldn't make me say yes twice." LVX177 measured 124 gate refusals over 67 saving calls (09-16→10-13),
73% on saves that later went through; in 12 of 15 never-saved episodes the model claimed "done" anyway.

What the exploration found (all verified in code at `8411ff5`):
1. **All save gates run in `executeToolCall` (`services/tools.js` ~996–2435) for EVERY action tool, messages
   included**, in this order: (a) silent-turn consent LVX117 → (b) hesitation → (c) unusable transcript →
   (d) write-order LVX95 (read-back + agreement, ceilings 1/2, budget 3) → (e) spelling → (f) qualification →
   (g) tenant `confirmBeforeWrite`. There is no per-kind policy; `HELD_WRITE_STATE` is the only tool table.
2. **Batch 2 (live since 10-03 01:44 CDT) already trusts a loose answer after a read-back** (`agreesAfterReadBack`,
   `lib/transcriptUtils.js:412`) — but NOT an empty/garbled answer, and cancels stay strict. So the 73% baseline is
   mostly pre-batch-2 (17 of its 27 days).
3. **The owner's own sentence is not a read-back to the gate.** `confirmReadBackRe` (`lib/voice/strings.js:1055`)
   misses "Tuesday at 3 for Jon Doe, booking that now", "…I'll book that now", "passing that message on now"
   (tested). It matches only offer-to-act questions ("shall I book that?").
4. **The gate only looks at the PREVIOUS completed turn** (`lastReplyText`). On Live the tool call usually arrives
   before the same turn's speech; when the model speaks first, the text exists only in `turnReplyText` at tool time
   (comment at `index.js:4560-4583`). So "read back + book in one breath" is refused today → a second read-back.
5. **Spelling:** `spellingSettled` needs letters captured or `spellAskMisses >= spellMissCap()` (=2); the spelling
   gate may refuse twice (`gateRefusals < spellMissCap()`). Prompt `gemini.js:1460` also asks the caller to
   "confirm those letters" — a built-in second confirmation.
6. **Closing:** the `end_call` no_ask refusal (`services/tools.js:716-763`) tells the model "Do NOT say goodbye
   again"; the model has usually not spoken yet (tool-first) and then says its planned farewell AND the ask →
   backwards order. The post-action ask note already rides in the tool reply (`COMPLETION_ASK_NOTE`,
   `lib/voice/live/tools.js:135`) and is honoured 20/21. Nothing counts goodbye-before-ask.
7. **Write-gate refusals are not in `live_call_summary`** (process counters + log lines only).

## The policy, as code will apply it

| Rule | Tools | Gates a–d | Save when |
|---|---|---|---|
| `message` | `record_customer_request`, `record_quote_request` | skipped (e: spelling, at most once; g: tenant flag) | the model calls it |
| `booking` | `book_appointment`, `reschedule_appointment_db`, `book_appointment_in_ehr`, `reschedule_appointment` | new rule below | read-back standing for this slot AND no objection heard since |
| `cancel` | `cancel_appointment_db`, `cancel_appointment` | **unchanged, byte-identical path** | as today |
| `strict` | `correct_appointment_name`, `add_appointment_note`, anything else | unchanged | as today |

**Booking rule (model-initiated calls only):**
- *Read-back standing* = the previous turn (`lastReplyText`) OR the in-progress turn (`turnReplyText`, new ctx wire
  `inTurnReplyText`) matches `confirmReadBackRe` **or** new `readBackStatementRe`, AND names the slot being written
  (`readBackMentionsSlot`, `lib/voice/slotMention.js`).
- *Objection* (only when the read-back is in the PREVIOUS turn; an in-turn read-back has no answer yet) =
  new `callerObjects(text, { restatedSlot })`: `withdrawsAgreement` OR last sentence ends "?" OR names a different
  time (`NAMES_TIME_RE` and not LVX144's restated slot) OR bare hesitation. **Empty, garbled or unusable = not an
  objection → save** ("save unless it HEARS a no"). Gates a and c stop refusing booking calls when a read-back is
  standing; b (bare "um") still refuses.
- *No read-back standing* → refuse once with an **engine-composed read-back** the model is told to say verbatim,
  built from the args that will be written: "Tuesday the 14th at 3 PM for Jon, D-O-D-L-A, booking that now." The
  surname is spelled letter by letter only when the caller spelled it this call (LVX172). The next turn is then a
  recognised read-back by construction. Existing ceilings/budget unchanged.
- *Engine retries* (`fc.id` starts `retry_`, `retryPendingWrite`) keep today's rule: code never acts on a looser
  agreement than the model's own call (batch-2 principle). The agreement ledger and its hidden readers (post-call
  SMS/task, recovery, silent token) are NOT touched.

**Spelling:** one voiced answer to a spelling ask settles it (`spellMissCap` 2 → 1); the gate refuses at most once;
the spelled name is read back exactly once — inside the action's one read-back, never as a separate "confirm those
letters".

**Closing (LVX178):** ask comes from (1) the action tool's success reply (exists) and (2) the first `end_call` when
not yet asked (exists) — its refusal now says "Say only this, nothing before it, no goodbye: 'Before you go — is
there anything else I can help you with?'". Prompt + `end_call` description: goodbye only after the caller says no
or says goodbye. Never goodbye-then-ask.

## Measure (live_call_summary)

New per-call block `confirm` (beside `closing`) + one log event per save:
- `confirm.saves`, `confirm.readbacks` (assistant turns matching either read-back regex, spoken lines excluded),
  `confirm.gate_refusals` + `confirm.refusals_by_gate` {consent, hesitation, unusable, write_order, spelling},
  `confirm.max_readbacks_per_save`, `confirm.saves_over_one_readback` (**target 0**), `confirm.spell_asks`,
  `confirm.readback_spelled` / `confirm.readback_spelled_missing` (caller spelled; did the read-back spell?).
- Event `save_confirmations {callSid, tool, rule, readbacks, refusals}` on every successful action write.
- `closing.backwards_goodbye` (new): farewell before the ask in one turn, or a farewell turn followed by an ask turn
  with no caller words between. Existing `end_call_refusals.no_ask` is the other LVX178 counter.
- Baselines: LVX177 f6-09-16 = 124 refusals / 67 saving calls (1.85 per saving call), 73% later saved; LVX178 =
  no_ask 20/52 receptionist-ended calls, backwards ≈6/52. Plus a **revision-independent "before"**: the T1 script
  runs the same detectors over `call-corpus/` turns offline (free).
- A1 done-when (part 2): `saves_over_one_readback` = 0 and `gate_refusals` ≤ 1 per save on the live calls;
  `backwards_goodbye` = 0; `no_ask` refusal never followed by a second farewell.

## Tasks (hours = active; machine time separate)

### T1 · Detectors, prototyped on real turns first — 0.5 h
Files: `lib/voice/strings.js` (en+es `readBackStatementRe`, `spelledLettersRe`), `lib/transcriptUtils.js`
(`callerObjects`), `lib/voice/closingOrder.js` (new, `farewellBeforeAsk(text, strings)`),
`scripts/corpus/confirmations.mjs` (new, offline baseline).
- [ ] Throwaway node script over every assistant/caller turn in `call-corpus/` + `tests/fixtures/liveCalls/`:
  hits for statement read-back (must NOT hit claims like "you're booked" / "I've booked", and the claim detector
  must NOT fire on "booking that now"), letter-spelled pattern, `callerObjects` vs `agreesAfterReadBack` diffs,
  farewell-before-ask. Read every hit; settle regexes before editing (prototype-detectors memory).
- [ ] Commit regexes in files (never heredoc), unit tests with the real positives/negatives (red first).
- [ ] `confirmations.mjs` prints read-backs per successful write on the corpus = the "before" distribution.

### T2 · Save policy in the gate — 1.5 h
Files: `lib/voice/savePolicy.js` (new: `SAVE_RULE`, `saveRuleFor(name)`), `services/tools.js` (gates a–d branch on
rule; composed read-back; `stateEffects.writeGateRefusal`), `lib/voice/live/index.js` (`turnState()` adds
`inTurnReplyText: turnReplyText` — must not land between sabotage anchors), `tests/liveToolContext.test.js` (wire).
- [ ] Red tests first (new `tests/liveSavePolicy.test.js`, driven through `bootLive` like the replay):
  message saves with no read-back / on "umm" / on empty turn; booking after previous-turn read-back saves on
  "da, ja, das", "", garbled; refuses on "no", "what time was that?", "make it four", "um"; in-turn statement
  read-back saves; no read-back → one refusal whose text contains the composed sentence; read-back for a different
  slot does not count; engine retry stays on today's rule.
- [ ] **Cancel-strictness pin** (owner ask): cancel after read-back refuses on "I love it" (loose), on "" (silent),
  on garbled, and with only an in-turn read-back; still passes on "Ja." and "yes". Plus sabotage row
  `cancel-stays-strict` that moves cancel into the booking rule and must turn this file red.
- [ ] The booking no-read-back refusal's caller-safe line (today "Just to confirm before I do that — shall I go
  ahead?", `services/tools.js:2125`) becomes the composed sentence, so a fallback never asks a second question.
- [ ] Implement; cancel/strict branches keep the existing code byte-identical where sabotage anchors sit
  (run `node scripts/corpus/sabotage.mjs --census` after every edit to tools.js/index.js/strings.js).

### T3 · Spelling once + spelled read-back (LVX172) — 0.5 h
Files: `lib/voice/replyState.js` (`spellMissCap` default 1), `services/tools.js` (composed read-back spells surname
when letters were captured or the caller gave a voiced spelling), `lib/voice/live/index.js` (`SPELLING_NOTE` drops
"and read the letters back"), `services/gemini.js:1460`, SPELLING NOT YET CONFIRMED block (`gemini.js:2166-2199`).
- [ ] Red tests: one voiced answer settles; spelling gate refuses at most once; composed sentence spells
  "D-O-D-L-A" only when spelled; `VOICE_SPELL_MISS_CAP` env still overrides (check prod env in part 2).

### T4 · Prompt trims — 0.75 h
Files: `services/gemini.js` (rule 3 :1309 → "read back once, then do it" by kind; confirm step :2435; `end_call`
inbound description :688), `capabilities/appointments.js` (:61-62, :685-699 steps 7–8 with the owner's example
sentence; :1125 kept), `capabilities/messages.js` (:73-95: one-breath summary incl. number digit by digit, save
right away, a correction files again), `capabilities/quotes.js` (:78-79). Outbound-only guardrail (:1122) and tenant
`confirmBeforeWrite` untouched.
- [ ] Regenerate prompt snapshots (`tests/__snapshots__/prompts/*`, outbound snapshot); review the diff: ONLY the
  edited sentences may change (grep the diff for anything else).
- [ ] Update text-asserting tests the explorer listed (spellAskCap, promptSplit, promptConversationTruth,
  liveDeferralGuard, outboundPromptLeak, toolMessageLeak …) — each edit names the old rule it encoded.

### T5 · Closing (LVX178) — 0.5 h
Files: `services/tools.js:739-744` (refusal text only; anchor line :716 untouched), `services/gemini.js` (prompt
closing rule), `lib/voice/live/index.js` `auditTurn` (`closingAudit.backwards_goodbye`, via `farewellBeforeAsk` +
previous-turn farewell flag).
- [ ] Red tests in `tests/liveEndCallAsk.test.js` (refusal text has no goodbye, starts with the ask) and
  `tests/liveCompletionAsk.test.js` (backwards counter: one-breath and two-turn shapes; ask-then-goodbye = 0).

### T5b · Silence like a person + the A1 silence correction — 1–1.5 h (added by the owner after S1)
Owner, 2026-10-13 evening: "If there is silence, shouldn't it behave like a normal receptionist … a polite 'Hello?'
or 'Are you there?' … then the second one being the normal nudge and then it ending after that if nothing is there?"
Approved: the wording below, plus reversing S1's ruling that a read-back followed by NO sound at all saves a booking.

**Today (verified at `a7d2d99`).** `checkSilence` in `lib/voice/live/index.js` runs three rungs, each spoken by the
model in the receptionist's own voice via `speakLine`; any VOICED audio (VAD, not the transcript) resets it. Gaps from
`SILENCE_THRESHOLDS` (`lib/voice/session.js`): 6–10 s, then +6–8 s, then +8–10 s by step (ending: 4/8/12 s). Text from
`buildSilenceNudge` / `buildSilenceGoodbye` + `lib/voice/strings.js`:
rung 1 `nudge1` "I'm still here whenever you're ready." · rung 2 per step, at `confirm` `nudgeConfirm` **"Just say yes
to confirm, or let me know if anything needs to change."** (a second confirmation — breaks A1) · rung 3
`goodbyeWithPhone`/`goodbyeNoPhone` "It seems like you may have stepped away. Feel free to call us back at … anytime.
Have a great day. Goodbye!" then hang up.

**Change 1 — the words (en + es; timings unchanged, they were never measured).**
| Rung | New line |
|---|---|
| 1 | `nudge1`: "Hello? Are you still there?" (es "¿Hola? ¿Sigue ahí?") |
| 2 | identify / gather lines kept (they help a caller who is thinking); `nudgeConfirm` → "Sorry, are you still there? I've got that ready for you whenever you are." — never "say yes to confirm" (es equivalent); `nudgeDefault` → "Take your time, I'm here when you're ready." |
| 3 | "I think I've lost you. Feel free to call us back at {phone}. Bye for now." (no-phone variant without the number; es equivalent), then hang up as today |
Outbound lines (`nudgeOutbound1`, `goodbyeOutbound`) untouched. Any test pinning the old strings: update and name the
old wording in the commit body.

**Change 2 — the A1 save rule tells "said something the transcript lost" from "made no sound".**
- New wire `callerVoicedSinceReply`: `lib/voice/live/index.js` sets it true where `spelling_voiced_answer` is decided
  (utterance close, `voicedMs >= voicedAnswerMs()`), and resets it ONLY where `lastReplyText = replyText` runs (a real
  reply) — never on a ladder line (`spokenLinePending`), so the read-back standing across a nudge is still judged
  against the caller's sound since IT (LVX120's rule). Expose in `turnState()`, copy in `lib/voice/live/tools.js`.
- `decideSave` gains input `callerVoicedSinceReply`. A read-back on the PREVIOUS turn with no voiced sound since →
  `{ readBackSource: "previous", agreed: false, objection: false, awaitingAnswer: true }` → the write is held (gate a
  on an empty turn, which already re-stashes it for the retry on a clear yes; gate d's "you called this before they had
  answered — WAIT" message otherwise). Voiced-but-garbled still saves; the same-breath (in-turn) read-back still saves
  (owner Q1); messages unchanged.
- Engine retry and cancels unchanged.
- Expected test flips (each encodes S1's reversed ruling, say so): `liveWritePathEndToEnd` "A1: a booking read back
  into silence is saved" → held; `liveConsentLatch` "A1: the second read-back, unanswered, saves" → held;
  `liveSavePolicy` decideSave/executeToolCall cases with `""` → split into voiced (save) and silent (hold). Corpus
  replay: fixtures carry caller text but no VAD; if an attempt flips, derive `caller_voiced` in build-fixtures from
  `live_utterance` voiced frames between the standing turn and the attempt and have the replay `feed(ms, { voiced })`
  before the call — never just edit `expect`.
- Accepted edge: a caller who heard "booking that now" and then hung up silently is not booked; post-call may raise the
  neutral "A caller may need a call back" alert, which is the right outcome for a caller who left mid-booking.

**Tests (red first):** strings tests for the three rungs (and no "yes to confirm" anywhere in the inbound ladder);
`decideSave` voiced/silent split; `liveToolContext` copy test; a `bootLive` e2e with both ends real: read-back → no
frames → book is held → `feed(…, { voiced: true })` + "yes" → saved; read-back → voiced frames + "" transcript →
saved; read-back → ladder rung 1 fires "Hello? Are you still there?" (assert the line sent via `speakLine`).

### T6 · Measure — 0.75 h
Files: `lib/voice/live/index.js` (`confirmAudit` ledger, increments in `auditTurn` + `onTool`, summary
`confirm: { ...confirmAudit },` on its OWN line after the `closing:` anchor), `lib/voice/metrics.js` `COUNTER_NAMES`
for any new bumpCounter.
- [ ] Red tests: per-call `summary.confirm` on a two-read-back booking (`saves_over_one_readback` 1) and a one-read-back
  booking (0); refusals_by_gate counts each gate; `save_confirmations` event emitted once per save.

### T7 · Replay fixtures + old-behaviour tests — 0.5 h
- [ ] Run `npm run test:corpus`. For every flipped attempt: change `expect`, append to `why`
  "CHANGED refuse→write 2026-10-1x (A1, owner: save unless it HEARS a no) — encoded <old rule>". Predicted:
  `CA299f23` #0 ("da, ja, das" after a read-back; encoded clear-yes). Expected to stay: questions
  (`CA954592` #0–1), "let me think" (`CAb4427e` #1, `CA240834` #1, `CAd97855` #3), engine retries (`CAd97855` #4–5),
  never-read-back attempts. **Zero cancel attempts may flip** (asserted in the report). Canary 34/96 unchanged.
- [ ] Unit tests that pin the old message gating (`liveWriteConsent` "covers every action tool" → re-pointed at a
  booking + a new message-passes case; "still refuses that same message write…"), garbled-answer booking refusals in
  `liveWriteOrder`, spelling-twice cases in `tools.test.js`/`spellAskCap`. Listed in the commit body with the old rule.
- Eval scenarios 18/32/39/40/42/44/45 (paid, scripted) encode the old flow — NOT run, NOT edited; recorded as stale.

### T8 · Sabotage rows — 0.5 h (verified by the full run, not by hand)
New rows (census 156 → ~169): `message-skips-gates`, `booking-garbled-answer-saves`, `booking-objection-refuses`,
`booking-question-refuses`, `in-turn-readback-counts`, `in-turn-readback-wire`, `readback-tied-to-slot-a1`,
`engine-retry-stays-strict`, `cancel-stays-strict`, `spelling-once`, `composed-readback-spells-surname`,
`statement-readback-regex`, `no-ask-refusal-no-goodbye`, `backwards-goodbye-counter`, `confirm-ledger-wire`,
`save-confirmations-counted`, and for T5b `silence-hello-first-rung`, `confirm-nudge-never-asks-yes`,
`no-voice-since-readback-holds`, `voiced-since-reply-wire`, `voiced-flag-survives-nudge`. Anchors end before any `$\``;
census clean.

### T9 · Commit, gate, ONE full sabotage — ~0.4 h active + ~2 h machine
- [ ] Commits per task on `feat/outbound-stage4` (no push). Final sha → `gate-v4.sh` (copy of v3 + `fullsab` mode,
  never edit a running script): full root vitest + census + `test:db`, then ONE `sabotage.mjs` full run in
  `ai-phone-gate`. Foreground wait loops ≤9 min on `^ALL-DONE exit=`. Pass = every row red except the 3 known
  baseline x (`ask-branch-latch`, `ask-branch-in-turn`, `ask-latch-per-action`).
- [ ] During the run: opus whole-branch review (source-only diff) + this doc's "as built" + part-2 script.

## Review Focus (most likely to bite; each has a test in its task)
1. "booking that now" spoken BEFORE the write lands trips the claim guard / post-call claim matcher → a false
   correction note or a "may need a call back" email (T1 prototype + T2 test).
2. A read-back for one slot authorising a write for another (action-blind regex) — slot-mention required (T2).
3. Cancels loosened by a shared helper (T2 pin + `cancel-stays-strict` row).
4. New ctx field produced but not copied (`inTurnReplyText`) → feature silently dead (`liveToolContext` + row).
5. Widening a shared fact's hidden readers — `confirmReadBackRe` and the agreement ledger are NOT widened; the new
   statement regex is read only by the booking rule and the counter (T1/T2 grep of readers).

## Split point and hours
| Block | Content | Active | Machine |
|---|---|---|---|
| Plan (this) | exploration + plan + questions | ~0.8 h | — |
| Session 1 | T1 + T2 + T3 + T7 → commit, root gate + census | ~3.0 h | ~0.3 h |
| Session 2 | T4 + T5 + T5b + T6 + T8 → commit, full gate + ONE full sabotage + opus review + as-built | ~3.5–4 h | ~2 h |
| Part 2 | one deploy + 3 live calls (separate approval) | ~1.5 h | — |

**Session ends:** S1 ends with commits + root gate + census green, this doc's Status updated and an S2 starting
message at its bottom. S2 ends with the full gate + sabotage verdict, "as built", the 10-03→10-13 baseline numbers
and the part-2 starting message. Stop and ask at 3 h in either session.

## Part 2 (next session — not this one)
ONE deploy from the main checkout, clean tracked tree: migrate status (none expected), then service; env diff =
only `GIT_COMMIT_SHA` (check `VOICE_SPELL_MISS_CAP` unset); boot logs clean. LVX176 ships in it. Calls on
+18175803291 from +14699338887, each script in its own message, wait for "done":
(a) leave a message → only "New customer request" email; `confirm.refusals_by_gate` all 0.
(b) book with a spelled surname → one letter-by-letter read-back, saved on first non-objection;
`saves_over_one_readback` 0, `readback_spelled` 1.
(c) ending → "anything else?" → no → goodbye; `backwards_goodbye` 0.
(d) silence (T5b): after the booking read-back say nothing → hear "Hello? Are you still there?" → say "yes" → booked
once; then on a second short call stay silent throughout → "Hello? Are you still there?", the rung-2 line (never "say
yes to confirm"), "I think I've lost you…" and the hang-up; nothing booked. `live_silence_line` stages 1-3 in the log.

## S1 as built (2026-10-13) — what S2 must know

Commits on `feat/outbound-stage4` (not pushed): `b19cc5c` plan · `507a10c` T1 detectors · `df5bf27` T2 save policy
(+ T7 replay/test updates) · `a7d2d99` T3 spell once. Gate at `a7d2d99` (gate worktree, gate-v3): root 313 files / 7,738 tests passed (1 file, 5 tests skipped; +4 files / +110 tests vs `0fcd6f5`), census 156 rows clean. test:db not run (no DB change); S2 runs the full gate incl. test:db.

**What exists now**
- `lib/voice/strings.js` (en + es): `readBackStatementRe` ("…booking that now", "I'll book that…"; a SEPARATE key —
  `confirmReadBackRe` and its other readers were not widened), `spelledLettersRe` (D-O-D-L-A). Prototyped on 416
  assistant turns: 8/8 and 8/8 hits real, none a completion claim.
- `lib/transcriptUtils.js` `callerObjects(text, { restatedSlot })`: no / hedge / "?" / bare "um" / a different time /
  "make it…, can we do…" (3/3 corpus hits real). Empty or unreadable is NOT an objection.
- `lib/voice/savePolicy.js`: `SAVE_RULE`, `saveRuleFor(name)`, `decideSave({...})` →
  `{ rule, applies, readBackStanding, readBackSource: "not_needed"|"previous"|"in_turn"|null, agreed, objection }`,
  `composeReadBack({ toolName, args, config, callerSpelled })` → "Friday, September 18 at 2:00 PM for Jon, D-O-D-L-A,
  booking that now." (reschedule: "Moving your appointment to …, moving it now."). Naive `scheduled_at` = tenant wall
  clock (formatted in UTC); offset-bearing = instant in tenant tz.
- `services/tools.js`: `a1Save` computed beside the probe facts; feeds `callerAgreedAfterReadBack` (`|| a1Save.agreed`,
  appended after the anchor's closing paren), `readBackMade` (`|| a1Save.readBackStanding`), the silent-turn verdict
  (new value `"a1_save_unless_no"`), the hesitation/unusable block (messages skip both; booking with a read-back
  skips "unusable"), and gate d's refusal text + caller line (objection → "answer it, never re-confirm"; none standing
  → the composed sentence). Probe logs `a1_rule`, `a1_applies`, `a1_readback`, `a1_objection`. Engine retry = `fc.id`
  starting `retry_` → `applies: false`.
- Wires: `lib/voice/live/index.js` `turnState()` → `inTurnReplyText: turnReplyText || ""`,
  `callerSpelled: Boolean(state.spellingCaptured || state.spellingVoiced)`; copied in `lib/voice/live/tools.js`. Proven
  both ends real by `tests/liveSavePolicyWire.test.js` (producer hand-sabotaged red, restored).
- `lib/voice/replyState.js`: `applyCallerVoicedAnswer` sets `state.spellingVoiced`; `spellingSettled` treats it like
  letters. Miss cap unchanged (2).
- Replay: `scripts/corpus/build-fixtures.mjs` emits `via: "engine_retry"|"model"` (from `live_write_retried`); the replay
  issues engine retries with a `retry_<tool>` id (`tests/helpers/liveBoot.js` `callTool(name, args, { id })`). 8 attempts
  are retries. One flip: `CA0ef8d2` #0 refuse → write. Canary 34/96 unchanged; no cancel attempt flipped.

**Rulings (ledger `.superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md`)**
- ~~A previous-turn read-back of this slot with NO caller turn since saves a booking.~~ **REVERSED by the owner the
  same evening:** a person checks the caller is still there instead. Built in S2 as T5b (no voiced sound since the
  read-back → held; the ladder's first rung asks "Hello? Are you still there?").
- Spelling: built the spec's narrow rule (voiced answer settles), not the plan's cap 2→1, which also re-opened the
  "talked past the question → misheard name written" defect.
- `write_confirm_readback_prev_turn` (process counter) now also counts A1 read-backs; the A1 per-call ledger (T6) is
  the measure.
- Moved to S2: the farewell regex + `farewellBeforeAsk` (T5), `scripts/corpus/confirmations.mjs` (T6), the spelling
  prompt block + "confirm those letters" (T4, with every other snapshot-changing prompt edit).

**Residuals, recorded, not fixed:** `correct_appointment_name` keeps today's rule; a model that ignores an objection
and re-reads the SAME slot in the turn in progress saves it (owner-accepted stray-booking trade).

**For S2's T6 (`writeGateRefusal` tags):** the five refusal returns are gate a (`silentTurnVerdict ===
"refused_no_consent"`), gate b/c (`if (consentRefusal)`), gate d (`!writeOrderGateOff()` branch), gate e (spelling,
the `spellingGateRefusals` patch), plus the ceiling/budget releases (not refusals). Add the tag to each return's
`stateEffects`; count in `lib/voice/live/index.js` `onTool`.

**For S2's T8:** the anchors S1 added that need rows: `a1Save.applies && a1Save.rule === "message"` (message skips),
`return { rule, applies: true, readBackStanding: true, readBackSource: "in_turn"` (in-turn), `if (readsBackThisSlot(lastReplyText))`
(previous), `const objection = callerObjects(lastCallerText` (objection), `engineRetry: typeof fc.id === "string" &&
fc.id.startsWith("retry_")` (retry strict), `cancel_appointment_db: "cancel",` (cancel strict → change to "booking"),
`inTurnReplyText: turnReplyText || "",` (wire), `state.spellingCaptured || state.spellingDeclined || state.spellingVoiced`
(spell once), the `who = words.length > 1 ?` line in `composeReadBack` (spelled surname; end the anchor before its
template literal — sabotage rows are applied with `String.replace`, which expands `$` sequences).

## S2 starting message (paste into a fresh session)

> Run receptionist round A1 "say it once" — session S2 of part 1: T4 prompt trims, T5 closing (LVX178), **T5b silence
> like a person + the A1 silence correction (added by the owner after S1)**, T6 measure, T8 sabotage rows, T9 full gate
> + ONE full sabotage + opus review. Plan: `docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md` — read "S1 as
> built" and T5b first; ledger `.superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md` (resume after Task 3).
> Branch `feat/outbound-stage4`, code head `a7d2d99` (docs after it). Execution: native (superpowers:executing-plans),
> one opus whole-branch review during the full sabotage. Owner decisions in the plan are final, including T5b: rung 1
> "Hello? Are you still there?", rung 2 never asks for a yes, rung 3 "I think I've lost you…"; a read-back followed by NO
> voiced sound is held (S1's opposite ruling is reversed), voiced-but-garbled still saves, the same-breath read-back
> still saves. Order: T4 → T5 → T5b → T6 → T8 → T9 (T4 and T5b both touch strings/prompt snapshots — regenerate
> snapshots once, after both). During the sabotage wait: the free 10-03→10-13 log read with
> `CLOUDSDK_CONFIG=~/.gcloud-vetra2` — refusals per save on post-batch-2 code, and how long callers pause before
> answering (for the silence timings, which stay unchanged this round). Rules: no paid runs; never git checkout over
> uncommitted work in the main tree; one full sabotage at the final sha in `ai-phone-gate` (copy gate-v3 → gate-v4 with
> a `fullsab` mode), waited on in the foreground; S2 is estimated at ~3.5–4 h active, so stop and ask at 3 h with what is
> left. End with the plan's "S2 as built" and the part-2 starting message (calls a–d).

## S2 as built (2026-10-13) — what part 2 must know

Commits on `feat/outbound-stage4` (not pushed): `a61171b` T4 prompts · `86d6e9b` T5 closing · `236425d` T5b silence ·
`777af08` prompt snapshots (regenerated once) · `7b9693b` T6 measure · `7cad43b` T8 rows · `08c5c82` final-review fix
round · `c185a97` fix-round follow-up (code head).
Gate: at `7cad43b` root 7,825 passed (exit 1 = one vitest worker RPC timeout under load), census 183, test:db 690 —
the full sabotage was stopped at its first row once the review landed (the fixes touch most rows). At `08c5c82` root
went RED 7 (the fix round's early objection hold bypassed the write-order ceiling); fixed in `c185a97`.
At `c185a97` (gate-v4): **root 318 files / 7,841 tests passed (exit 0), census 194 clean, test:db 50 files / 690 passed.** ONE full sabotage (194 rows) started 22:54 CDT in `ai-phone-gate`, log `.superpowers/sdd/2026-10-10-batch3-launch-guards/gates/gate-a1-s2-final-sab.log`; pass = every row red except the 3 known baseline x (`ask-branch-latch`, `ask-branch-in-turn`, `ask-latch-per-action`). Verdict: **NOT MEASURED.** Claude Code killed the gate's background shell for low memory at ~23:39; the
orphaned run went on, but from row 5 (`hammer-brake`) on, all 190 rows printed "could not be READ (no test tally)"
inside 10 minutes (log last written 23:49). In other words vitest never started, which says nothing about the suite.
Rows 1–4 were measured and are red as expected (`word-clock`, `supersession-veto`, `spent-token`, `spent-latch`).
The gate tree was left clean with no journal. Ruling (2026-10-14): do not resume at `c185a97`. S3 changes the code
again, so ONE full sabotage runs at S3's final sha. Run it outside a Claude Code background shell (the owner's own Git
Bash) so the memory reaper cannot kill it.

**Final review (opus, whole branch S1+S2): 0 Critical, 5 Important.** Fixed, each red first: **I1** a held engine retry
of a booking now tells the model to call again (no second read-back, no yes; the retry keeps its strict rule) and a
booking held awaiting its read-back's answer is stashed; **I2** a read-back that ASKS in the same breath as the tool
call ("…shall I go ahead and book that?") waits for the answer — only the statement form saves at once (ruling on
owner Q1 — **owner confirmed 2026-10-15**); **I4** "Sorry, yes, make it four" objects again, and a yes that carries a change or question
("Yeah, make it four") is held before the write-order gate (only that case — every other objection keeps the gate's
ceiling). Also fixed for the part-2 numbers: `farewellRe` false positives ("take care of", "have a day in mind",
"Good morning, thanks for calling") and booking read-backs tied to the saved slot in the confirm ledger. **Not fixed
(owner decision / latent): I3** a corrected message files a second row and a second owner email, the first one wrong
(the plan's "a correction files again"); **I5** EHR reschedule has no slot for the booking rule (no EHR tenant live).
~15 Minors are in the ledger as deferred.

**What exists now (on top of S1)**
- **T4 prompts.** Rule 3 is per kind: message/quote = one summary (number digit by digit inside it), recorded straight
  away, a correction files again; booking/reschedule = day, time and name read back ONCE as it is booked ("Tuesday at 3
  for Jon Doe, booking that now"), booked unless the caller objects; cancellation = read back + clear "yes". Spelled
  letters are said back inside that one read-back (no "confirm those letters"). The post-action confirm step no longer
  re-reads the details. Inbound `end_call` description + closing rule: ask "anything else?" when a task is done or the
  caller wraps up; goodbye only after a no or their goodbye. `tests/a1PromptTrims.test.js` names every moved sentence.
  Outbound moves only by the shared rule 3, letters rule and `book_appointment` description.
- **T5 closing (LVX178).** The `end_call` no_ask refusal hands the model the one sentence: "Say only this, nothing before
  it, no goodbye: 'Before you go — is there anything else I can help you with?'". New `strings.farewellRe` (en+es,
  counter-only) + `lib/voice/closingOrder.js`; `closing.backwards_goodbye` counts goodbye-then-ask in one breath, or a
  goodbye turn followed by an ask turn with no caller words between (prototype: 434 corpus turns, 32 farewells all real,
  2 one-breath backwards, both real).
- **T5b silence.** Ladder (en+es; timings unchanged; outbound untouched; shared with the cascade): rung 1 "Hello? Are you
  still there?"; rung 2 confirm "Sorry, are you still there? I've got that ready for you whenever you are.", default
  "Take your time, I'm here when you're ready."; rung 3 "I think I've lost you. Feel free to call us back at {phone}. Bye
  for now." Wire `callerVoicedSinceReply` (owner at S2 start: "any heard voice" = a voiced frame forwarded to the model,
  held speech the gate released, or a caller transcript past the echo gate; NOT the 400 ms spelling threshold), reset
  only at a real reply. Previous-turn read-back + no voice since → `awaitingAnswer` → held, and BOTH the silent-turn gate
  and the write-order gate tell the model to WAIT (their old wording asked "whether to go ahead" — a second yes);
  caller-safe line = rung 1. Absent wire (null) reads as S1. `callerObjects`: "Yes, sorry" / "Sorry, I'm still here"
  (the natural answer to rung 1) is not an objection; "Sorry, it's John with an H", "Sorry." and "Sorry?" still are.
  Corpus replay: no attempt flipped (fixtures carry caller text), so build-fixtures needed no `caller_voiced`.
- **T6 measure.** `live_call_summary.confirm` {saves, readbacks, gate_refusals, refusals_by_gate {consent, hesitation,
  unusable, write_order, spelling}, max_readbacks_per_save, saves_over_one_readback, spell_asks, readback_spelled,
  readback_spelled_missing} + one `save_confirmations` {callSid, tool, rule, readbacks, refusals} per save. A read-back
  belongs to the next save; one spoken in the save's own turn belongs to it; ladder lines never count. Every write-gate
  return carries `stateEffects.writeGateRefusal`. `scripts/corpus/confirmations.mjs` is the offline "before".
- **T8.** 27 sabotage rows, + 11 for the fix round (census 156 → 194), each hand-verified red before the full run
  (except `a1-objection-branch-skips-time-cue`, red only on the corpus replay — left to the full run).

**Rulings (the ledger has each one's cost if wrong):** T5 two-turn backwards needs NO caller words between (goodbye →
"Thank you." → ask is not counted; no_ask covers it) · T5b wire is frame-level · a null wire reads as S1 · gate a uses the
wait wording · "sorry" + only a yes/presence is not an objection · T6 read-backs finalize at the end of the save's turn;
readback_spelled counts booking AND message saves · T8 has 27 rows (6 for guards S2 added).

**Baselines ("before")**
- *Offline corpus* (`node scripts/corpus/confirmations.mjs`; call-corpus/ is a set of investigations, not a sample — a
  distribution, never a rate): 38 saves on 28 saving calls; **17 saves heard more than one read-back** (bookings 12 of
  22, cancels 5 of 16); **14 of 28 saving calls** had such a save; 70 gate refusals.
- *Production after batch 2* (free log read, 10-03 01:44 CDT → 10-13, revisions 00100/00101/00102, 26 calls): 6 saving
  calls, 6 saves (1 message, 3 booking/reschedule, 2 cancel); **7 holds before those saves = 1.17 per save; 4 of 6 saves
  held at least once** (the message held 3 times — A1 ungates messages); **2 of 6 saves heard more than one read-back**.
  Per call: 4 of the 6 callers who got something saved were asked again at least once. Small N.
- *LVX178* (plan): no_ask 20/52 receptionist-ended calls, backwards ≈6/52; corpus one-breath backwards 2 of 434 turns.
- *Silence timings:* **not measurable from today's logs.** The inbound ladder fired 0 rungs in 26 calls (no caller paused
  past 6–10 s), and the per-turn pause cannot be rebuilt: `live_utterance.opened_ms` is a process clock and its log time
  is written late. Before any timing change, add a per-utterance "ms since our audio stopped" field (not built).

**Residuals, recorded, not fixed:** outbound keeps its guardrail "book only after a clear yes" while the shared gate and
the `book_appointment` description now say one read-back (outbound is off in prod) · `correct_appointment_name` on the
old rule · eval scenarios 18/32/39/40/42/44/45 encode the old flow (not run, not edited) · a caller who heard "booking
that now" and hung up silently is not booked (owner-accepted; the neutral "may need a call back" alert covers it) ·
"Yes, sorry" said as a hedge saves.

## S3 — owner, 2026-10-13 (after S2): fix I3 before part 2

Owner chose "fix before deploy": a caller who corrects a message on the same call ("no, it's 0 1 2 4") must not file a
second message — the correction UPDATES the first one, and the owner gets ONE "New customer request" email with the
final details. Est. ~1–1.5 h active. Today: `capabilities/messages.js:226` `db.createCustomerRequest` then `:240`
`notifyCustomerRequest` fire on every `record_customer_request` (same for `record_quote_request`), no de-dupe. Design
question for S3 to settle on the code (explore first): one email with the final details means the email must wait until
the message can no longer change (end of call, or a short quiet window) — check how post-call / `saveOutstandingMessage`
and the owner-email path already run before choosing; the row update is a same-call, same-request-type match. Tests red
first; sabotage rows for "a correction updates, not inserts" and "one email per message"; gate: root + census + test:db,
then ONE FULL sabotage at S3's final sha (the S2 run never measured rows 5–194; see the verdict above). Part
2's call (a) then checks: correct the number once → one row, one email, with the corrected number.

## S3 starting message (paste into a fresh session)

> Run receptionist round A1 — S3: fix review finding I3 before part 2. Plan:
> `docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md` — read "S2 as built" and "S3". Ledger
> `.superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md`. Branch `feat/outbound-stage4`, code head `c185a97`.
> The S2 full sabotage was NOT measured: rows 5–194 never ran ("S2 as built" has the details). Do not resume it.
> Do I3 (owner: a same-call correction updates the first message; ONE owner email with the final details), red-first,
> with new sabotage rows. Then gate: `gate-v4.sh <sha> <label> db` (root + census + test:db). If that is green, give me
> the ONE command for `gate-v4.sh <sha> <label> noroot fullsab` to run in my own Git Bash, not as a Claude Code background
> shell (the memory reaper killed the last one). Pass = every row red except `ask-branch-latch`, `ask-branch-in-turn`,
> `ask-latch-per-action`. Rules: no paid runs; never deploy; never git checkout over uncommitted work in the main tree;
> serialize vitest; census after every edit to tools.js/index.js/strings.js; stop and ask at 2 h. End with S3 as built
> and an updated part-2 starting message.

## S3 as built (2026-10-14/15) — what part 2 must know

Commits on `feat/outbound-stage4` (not pushed): `2ad29db` I3 correction updates · `a3cd9ba` Live + cascade wire
tests · `c3ba26c` last-chance write · `0118380` test:db as vetra_app · `eb63f83` 6 rows · `5953aa0` review round
(C1/I1/I2) · `eb60198` 7 rows (**code head**). No migration. Nothing deployed.

**Finding that set the design:** the owner email and owner SMS are link-only by design ("A caller left a message or a
callback request." + dashboard link; no caller fields). Owner (S3 start): the email stays at the FIRST save; a same-call
correction UPDATES the row and sends nothing. The details the owner reads are the row's.

**What exists now**
- `lib/capabilities/customerRequests.js`: `sameRequest` (same PERSON — name missing, same first name, or a spelling fix
  with at most a third of the letters different; the number never vouches — AND same REASON — Jaccard ≥ ½ over content
  words minus EN+ES stop words minus the callers' name words); `saveCustomerRequest` (per-callId in-process chain; tenant
  unit 1 = list this call's rows of this type, newest first, match, UPDATE; else tenant unit 2 = INSERT; a re-record with
  no reason words keeps the row's message; `fallbackNumber` fills a new row only); `noteOwnerNotified`/`ownerNotifiedFor`.
- `services/db.js` `listCallCustomerRequests` + `updateCustomerRequest` (COALESCE; business in the WHERE and in the RLS
  scope; classified in `lib/phiAudit.js`).
- Packs: `messages.js`/`quotes.js` notify + caller SMS on the first save only; a correction logs
  `customer_request_corrected {callSid, tool}` and re-sends the email ONLY if the first send did not reach the owner
  (`notifyCustomerRequest` now resolves true/false; a correction waits for a send still in flight). Quotes match on the
  description (not the Address/Urgency labels) and keep segments a re-record leaves out.
- **Last-chance fix (owner: fix in S3):** `saveOutstandingMessage` dispatched nothing — a message re-issued at close was
  counted `message_saved_last_chance` with no row and no email. Its output now goes through `recordToolOutput` +
  `dispatchEffects`; post-call verify waits for it and derives `abandoned` at verify time.

**Rulings (ledger has each cost):** R1 email at first save · R2 (revised after review) same person + same reason; a false
split (Jon → Jonathan, a reason correction, detail added) = 2 rows + 2 emails, nothing lost · R3 request_type literal
(message → callback flip files separately) · R4 no callId → insert as today · R5 failed list/update → filed as new ·
R6 caller SMS on first save only · R7 per-call chain · R8 log line, no counter.

**Review (opus, one pass): 1 Critical, 2 Important — all fixed red-first** (C1 unrelated requests merged and overwritten;
I1 quote correction overwrote the number with the caller ID; I2 an undelivered first email was no longer retried by
the correction). **Not fixed (pre-existing, told to the owner):** the first-save email has no durable retry — an SMTP
failure with no correction loses it exactly as before S3; the durable fix is an outbox (+2–3 h).

**Gates:** `eb63f83` root 320 files / 7,868 passed, census 200, test:db 51 / 695 (superseded). `eb60198`: see the
ledger line "S3 gate @eb60198". 13 new sabotage rows (census 207), each hand-verified red; 2 read green on the first
pass and their test cases were sharpened.
**Full sabotage at `eb60198` (separate Git Bash window, 09:41–11:48 on 10-15):** **PASS.** 207 rows: 204 red, and
exactly the 3 known baseline x green (`ask-branch-latch`, `ask-branch-in-turn`, `ask-latch-per-action`); 0 rows
"could not be READ" (0 not measured); all 13 S3 rows red; gate tree clean afterwards, no journal left. Log
`.superpowers/sdd/2026-10-10-batch3-launch-guards/gates/gate-a1-s3-final-sab.log`. The I2 ruling (a same-breath
read-back phrased as a question waits for the answer) was confirmed by the owner on 10-15.

## Part 2 starting message (paste into a fresh session — AFTER S3)

> Run receptionist round A1 "say it once" — part 2: ONE deploy + live calls. Plan:
> `docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md` — read "S2 as built", "S3 as built" and "Part 2". Ledger
> `.superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md`. Branch `feat/outbound-stage4`, code head
> `eb60198`; nothing deployed; production = voice-uk-prod-00102-q9q @ 28b8111 (rollback target). LVX176
> (`0fcd6f5`) ships in this deploy. (1) ONE deploy from the main checkout with a clean tracked tree (prod migration
> checksums are CRLF — never an LF worktree): `migrate status` (none expected), then the service; env diff vs 00102 = only
> `GIT_COMMIT_SHA` (check `VOICE_SPELL_MISS_CAP` unset); boot logs clean. The deploy is outward-facing: confirm with me
> first. (2) Live calls on +18175803291 from my phone +14699338887, each script in its own message; wait for my "done",
> then read that call's `live_call_summary.confirm` / `.closing` and its `save_confirmations` (free log read,
> `CLOUDSDK_CONFIG=~/.gcloud-vetra2`): (a) leave a message, then correct the number once ("no, it ends in …") → one summary, saved at once, ONE "New
> customer request" email, ONE dashboard row holding the CORRECTED number, `customer_request_corrected` once in the log,
> `confirm.refusals_by_gate` all 0; (b) book with a spelled surname → one letter-by-letter read-back, saved on the
> first non-objection, `saves_over_one_readback` 0, `readback_spelled` 1; (c) the ending → "anything else?" → no →
> goodbye, `backwards_goodbye` 0, no second farewell after a no_ask refusal; (d) silence: after the booking read-back say
> nothing → hear "Hello? Are you still there?" → say "yes" → booked once; then a second short call silent throughout →
> rung 1, the rung-2 line (never "say yes to confirm"), "I think I've lost you…" and the hang-up, nothing booked,
> `live_silence_line` stages 1–3 in the log. Paid calls need my approval (state the cost first). A1 done-when on these
> calls: saves_over_one_readback 0, gate refusals ≤ 1 per save, backwards_goodbye 0. Not in scope: LVX167, LVX174,
> LVX175, LVX168–171 (round A2).

## Part 2 as built (2026-10-15) — deploy + live calls

**Deploy (gcloud, main checkout, clean tracked tree, HEAD `4977aa0` = docs on top of code `eb60198`):** build
`0df473a1` (53 s), tag `:eb60198`, digest `sha256:f2ce0d4e…6b26`. Migrate job image → `:eb60198`; `migrate --status`
(`-p62sn`): 53 applied, none pending, no "edited". LIVE **`voice-uk-prod-00103-nvc` @ `eb60198`**, 100% traffic. Env
diff vs `00102-q9q` = only `GIT_COMMIT_SHA` 28b8111→eb60198 (44 = 44 vars, `VOICE_SPELL_MISS_CAP` unset, spec
otherwise identical). Boot clean (`sms_channel_off` as expected; page shows `Build: eb60198`). Rollback:
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00102-q9q=100 --project=vetra-uk-edc8ca --region=europe-west2`.
Owner kept `00103` after the (b) failure (fix forward).

**Ops done for the checks (owner YES):** second dashboard login `nithinjd06+testline@gmail.com` attached to the VetraTD
Test Line (`scripts/onboard-tenant.js --phone +18175803291`, uid `tenant-a633d96206a8c76559217179`); the owner's main
login resolves to Digile Media, so the Test Line rows were invisible to it. Test data left (owner): appointments Mon 19
Oct 11:00 + Tue 20 Oct 14:00, customer_requests 3 → 4.

**Calls** (owner handset → +18175803291; (c) folded into (b) by the owner; ≈5.1 call-min ≈ $0.70 incl. build, cap $2):

| Call | CallSid | Verdict | Numbers |
|---|---|---|---|
| (a) message + one number correction | `CA25ae7250e03f478e57fde4eb2294c592` | **PASS** | saved at once (2 saves, rule message, 0 refusals); `refusals_by_gate` all 0; `customer_request_corrected` 1; rows 3→4; dashboard: ONE row "Nithin Dodole — 4699338887" (corrected); ONE "New customer request" email 17:32:48Z; no false "Unconfirmed booking" (LVX176 live ✓); `no_ask` 1 (end_call right after the summary, refused) → "updated, anything else?" → no → goodbye; `backwards_goodbye` 0 |
| (b)+(c) booking, surname spelled | `CAff059ed83d190170d6cea4e9f306eac3` | **(b) FAIL, (c) PASS** | booked Mon 19 Oct 11:00 "Nithin Dodla"; readbacks 3, `max_readbacks_per_save` 2, `saves_over_one_readback` 1, gate refusals 2 (write_order 1, spelling 1), `readback_spelled` 0 / missing 1; caller heard "unable to finalize your booking right now" + "temporary issue" (F1); ending "anything else?" → no → goodbye, `backwards_goodbye` 0, `no_ask` 0 |
| (d1) booking, silence after read-back | `CAfbe56923754b90d43679e12ed6a83163` | **silence UNTESTED; A1 checks FAIL** | name on file → "add Tuesday in addition?" → yes; booked Tue 20 Oct 14:00 (`in_addition_to_existing`); spelling asked for the name on file, twice (F4); gate refusals 3 (consent 1, spelling 1, write_order 1); `saves_over_one_readback` 1; letters said back ("Nithin, D-O-D-L-A"), `readback_spelled` 1; no silent pause after a read-back, ladder never fired |
| (d2) silent throughout | `CAcb208fd214d78ea82c4aafe962f78d39` | **PASS** | `live_silence_line` nudge stage 0 "Hello? Are you still there?", nudge stage 1 = `nudgeIdentify` (the step's own rung-2 line; never a yes), goodbye stage 2 = `goodbyeNoPhone` (tenant has no main number); `live_silence_hangup` quiet 8,021 ms; 0 saves; `<no speech detected>` in the output transcript after "Bye for now" — owner: NOT spoken |

**A1 done-when on these calls:** `saves_over_one_readback` 0 — **FAIL** (b 1, d1 1) · gate refusals ≤ 1 per save —
**FAIL** (b 2, d1 3) · `backwards_goodbye` 0 — **PASS** (4 of 4). Messages and closing work; bookings do not yet.

**Findings (Part 3 fixes them):**
- **F1 (b) false "can't book" after the tool-round cap.** Live issued `book_appointment` before any read-back text
  (`a1_readback` null) → write_order refusal handing the composed sentence (the designed one-refusal path). The model
  spoke the sentence, but `toolRoundsThisTurn` reached 6 > `MAX_TOOL_ROUNDS` 5 at 17:57:31
  (`lib/voice/live/index.js:6474`) and the cap's reply ("Too many tool calls in one turn. Stop calling tools and speak
  to the caller now…") made it say it could not finalize, twice. **Cause not known:** only ONE tool ran in that turn
  (one `tool_duration`); `onToolCall` has no silent early return between the cap and the runner (outbound aside).
  Suspects to test first: toolCall messages with empty/duplicate `functionCalls`, or a previous turn whose turnComplete
  never came. Prior cap hits: 6 calls 09-16→09-20 (`00061`–`00091`), none 09-20→10-15. The cap reply also breaks the
  held-write rule "do not tell them anything went wrong".
- **F2 (b) spelled letters lost upstream.** Caller said "Nithin Dodla — D, O, D, L, A"; Live's input transcript was
  "diodo" → `callerSpelled` false → the spelling gate refused the next (in-turn) save and the model asked to spell
  AFTER "booking that now" ([[live-transcript-is-lossy]]). Owner decision needed on any mitigation.
- **F3 (a, b) letters not said back** (LVX172 agreed design: the ONE read-back spells the surname). Prompt makes it
  conditional (`services/gemini.js:1466`: only when the letters do not look like a name or differ by one letter);
  message step 5 (`capabilities/messages.js:81`) lists name/number/reason only. (a)'s row holds "Dodole" for D-O-D-L-A.
- **F4 (d1) spelling forced for a name on file, and asked twice.** The prompt says a name from an earlier visit is
  not spelled again; the spelling gate refused anyway, and after "Don't you already have the spelling?" the model asked
  again. Plus a write_order refusal and an engine-retry `write_refused_no_consent` in the same save (3 refusals).
- **Observations (not fixes):** the urgency question is the general take-message step 4 (owner asked; no tenant
  setting) · (a)'s summary turn and the caller's "urgent" are missing from the transcript (`turns_reply_empty` 1), so the
  confirm ledger read 0 read-backs for (a) · `live_silence_line` stages log 0–2 (plan said 1–3) · the owner's Digile
  dashboard password was pasted in chat — owner told to change it.

## Part 3 starting message (paste into a fresh session)

```text
Run receptionist round A1 "say it once" — part 3: fix what the part-2 live calls found, ONE redeploy, re-run calls.

FIRST, before any tool call that changes anything: reiterate this task back to me in plain words — the steps, what
each fix and each call checks, hour estimate, $ cost — and ask me any questions you have (AskUserQuestion; recommended
option first). Don't guess on anything that is mine to decide; wait for my answers, then start. Re-state where we are in
one line whenever we move to the next step.

Plan: docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md — read "Part 2 as built" (F1–F4, call table) and "S2 as
built" (the gate design). Ledger: .superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md (every Ruling + deferred
minor; Part 2 lines at the end). Branch feat/outbound-stage4. Code head eb60198 (only docs commits on top).
Production = voice-uk-prod-00103-nvc @ eb60198 (LIVE since 10-15, owner chose fix-forward); rollback target
voice-uk-prod-00102-q9q @ 28b8111. Test line +18175803291 (VetraTD Test Line tenant; dashboard login
nithinjd06+testline@gmail.com). My handset +14699338887 now has a name on file ("Nithin Dodla") and two test bookings
(Mon 19 Oct 11:00, Tue 20 Oct 14:00).

(1) F1 — false "unable to finalize your booking" (call CAff059ed83d190170d6cea4e9f306eac3, 17:57:21–17:57:41Z).
Live sent book_appointment before any read-back text → the designed write_order refusal handed the composed sentence →
the model spoke it, but toolRoundsThisTurn hit 6 > MAX_TOOL_ROUNDS 5 (lib/voice/live/index.js ~6474) and the cap's
reply ("Stop calling tools…") made it say it couldn't book. Only ONE tool ran that turn — the 6 rounds are unexplained.
Systematic debugging first: prototype on that call's own events (free log read, CLOUDSDK_CONFIG=~/.gcloud-vetra2)
before editing; explain the cause in plain words with a yes/no fix decision for me. Whatever the cause, a cap reply
for a held write must never make the model say it failed.
(2) F4 — spelling forced for a name already on file, and asked twice (call CAfbe56923754b90d43679e12ed6a83163). The
prompt says a name from an earlier visit is not spelled again; the spelling gate refused anyway. Never ask twice.
(3) F3 — the ONE read-back spells back a surname the caller spelled (LVX172 agreed design), for bookings AND messages.
Today it is conditional (services/gemini.js ~1466) and message step 5 (capabilities/messages.js ~81) omits it.
(4) F2 — Live heard spelled letters as "diodo", so callerSpelled was false. Bring me the options with cost; no fix
without my yes.

Each fix: red-first (TDD), census, sabotage rows (hand-verified red), opus review of the whole fix set. Then db gate
+ ONE full sabotage at the final sha, launched in its own mintty Git Bash window (not a Claude Code background shell).
Then ask me before the redeploy: ONE deploy from the main checkout with a clean tracked tree (prod migration checksums
are CRLF — never an LF worktree), migrate status first, env diff vs 00103 = only GIT_COMMIT_SHA, boot logs clean; tell
me the rollback command before running it.

Live calls after the redeploy (each script in its own message; wait for my "done"; read that call's
live_call_summary.confirm / .closing and save_confirmations): (b) a booking where I spell a surname that is NOT on file
→ one read-back that spells the letters, saved on the first non-objection, no "unable"/"temporary issue",
saves_over_one_readback 0, gate refusals ≤ 1; (d1) a booking with my name on file → no spelling ask; after the
read-back I stay silent → "Hello? Are you still there?" → "yes" → booked once; (a) a message with a spelled surname
only if F3 changed messages. Design the scripts around the name and bookings now on file for my handset. A1 done-when:
saves_over_one_readback 0, gate refusals ≤ 1 per save, backwards_goodbye 0. A call that fails its check is a finding:
explain it in plain words with a yes/no decision for me, fix red-first, and ask me before any redeploy.

Conserve usage and time WITHOUT compromising quality:
- Read only the plan sections named above and the parts of files you need (grep/offset), not whole big files; don't
  re-read what you already have; don't re-derive facts the plan or ledger already settles.
- Batch independent reads/commands into one turn; one filtered log query per call, not many.
- Use cheaper models (sonnet/haiku) for mechanical subagent work (log extraction, searches); keep opus for any code
  review of a fix. Spawn subagents only when they save real work.
- Never skip a check to save time: every call's numbers are read from the logs, every fix is red-first with a test and
  census, and a fix gets the full gate before redeploy. If saving usage would cost quality, say so and ask.
- Keep replies short and plain; put the detail in the ledger, not the chat.

Rules: paid calls/runs need my approval (state tokens + $ first). Never git checkout/restore over uncommitted work in
the main tree. Serialize heavy vitest runs; run any long gate in its own Git Bash window, not a Claude Code background
shell. Owner decisions are final — don't reopen them. Explain in plain words; give hour estimates. Stop and ask at 2 h
with what is left. Ask before anything not in these steps. Not in scope: LVX167, LVX174, LVX175 (round A2), LVX168–171.

End with: verdict per fix and per call, "Part 3 as built" in the plan, ledger + memory updated, and what round A2
starts with.
```

## Part 3 sitting 1 (2026-10-15, 13:51–15:50 CDT) — fixes built, gate running

Owner decisions: F4 option 2 (a name on file is never asked for; a NEW name keeps the second spelling ask only after a
near-silent answer) · F4 read-back = spell the on-file surname as a statement · F1 fix set YES · F2 = ask before
the read-back (a lost-letters save shows 2 refusals — accepted) · review I2 = prompt only, counted · calls approved,
cap $2.

**Causes (free log reads):** F1 — the model re-called `book_appointment` 5× in 3 s after the handed-sentence refusal;
the refusal echo answered 4 (`live_write_refusal_replayed` carried no callSid, so part 2's filtered read saw "one
tool"; the echo key lacked `inTurnReplyText`/`callerVoicedSinceReply`), round 6 hit the cap, whose "Too many tool
calls…" made the model say it could not book. The model's own arg was "Nithin **Dodda**" — it misheard the letters
too; the late spelling ask is what wrote "Dodla". F4 — LVX53 provenance (on-file name not said this call → spelling
ask), after "booking that now"; the model re-asked on its own after "Don't you already have the spelling?".

**Commits (code head `04d176a`):** `2abf3ae` + `071ad14` F1 · `2352d7f` F4 code · `f850697` F3+F4 prompts (snapshots
regenerated once, 36 files) · `154d34e` F2 · `006e117` 15 rows · `04d176a` review round (I1 cap pass + "already said",
I2 counter `confirm.onfile_saves` / `onfile_readback_unspelled`, M3). Opus review: 0 Critical, 2 Important (fixed /
owner-ruled), 5 Minor (M3 fixed; M4/M5 deferred; M6 measured on call b). 20 new rows + 2 re-anchored, each
hand-verified RED; census 227.

**What exists now**
- F1: echo key + the A1 inputs; past `MAX_TOOL_ROUNDS` a HELD write is answered gated with its caller-safe line (or
  "ask what you were told to ask"), never "Too many tool calls"; once the handed sentence has been said, ONE capped call
  per turn reaches the gate (`live_tool_rounds_cap_pass_said`), after that "already said, do not say it again";
  handed-sentence refusal "Once you have said it, call this again"; callSid on `live_write_refusal_replayed`.
- F4: `shouldConfirmSpelling` never asks for an on-file name (`write_name_on_file_unspoken` counts the LVX53 case);
  the handed sentence spells an on-file surname; booking guardrail + message step 1 tell the model to; spelling
  refusal "ask once… do not ask them to spell it again yourself".
- F3: letters rule unconditional; message step 5 + guidance spell a spelled or on-file surname.
- F2: `spellingGateWouldHold()` look-ahead; the A1 no-read-back branch steps aside so the spelling is asked first;
  fail-closed (`spellFirst` read by the spelling gate).

**Gate:** `gate-v4.sh 04d176a a1-p3 db fullsab`, launched 15:46 in its own mintty window; log
`.superpowers/sdd/2026-10-10-batch3-launch-guards/gates/gate-a1-p3.log`. Pass = ROOT exit 0, census 227, DB exit 0,
every sabotage row red except the 3 baseline x, 0 "could not be READ", gate tree clean. **Verdict: PASS (one
stale row fixed).** ROOT exit 0, 320 files / 7,902 tests; census 227; DB exit 0, 51 files / 695; SAB 16:00–18:12,
227 rows: 223 red + 4 green = the 3 baseline x + `hammer-brake-too-wide`, 0 "could not be READ", tree clean. That row
stripped only 3 of the echo key's now-5 state fields, so a read-back still changed the key (F1 added the A1 inputs):
code correct, row stale. Owner YES: the row now strips all five; hand-verified RED (liveWriteHammering 3 failed,
incl. its own "does NOT echo once the model has read the details back"). Code to deploy stays `04d176a`.

## Part 3 sitting 2 starting message (paste into a fresh session — after the gate finishes)

```text
Run receptionist round A1 "say it once" — part 3, sitting 2: read the gate verdict, ONE redeploy, live calls.

FIRST, before any tool call that changes anything: reiterate in plain words (steps, what each call checks, hours, $)
and ask me any questions (AskUserQuestion; recommended first). Re-state where we are in one line at each step.

Read: docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md "Part 3 sitting 1" (+ "Part 2 as built" call
table); ledger .superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md (P3 lines at the end). Branch
feat/outbound-stage4, code head 04d176a. Prod = voice-uk-prod-00103-nvc @ eb60198; rollback
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00103-nvc=100 --project=vetra-uk-edc8ca --region=europe-west2`.

(1) Gate verdict is already PASS at 04d176a (plan "Part 3 sitting 1"; one stale row fixed in docs/test commit
after it). Confirm main checkout HEAD = 04d176a + docs/row commits only (git diff 04d176a HEAD -- lib services
capabilities = empty).
(2) Ask me before the redeploy: ONE deploy from the main checkout, clean tracked tree (CRLF checksums — never an LF
worktree), migrate --status first, env diff vs 00103 = only GIT_COMMIT_SHA, boot logs clean; rollback said first.
(3) Calls (approved, cap $2; each script in its own message; wait for "done"; read live_call_summary.confirm /
.closing, save_confirmations, live_debug_assistant_turn; filter by callSid AND by time window — some lines carry no
callSid). Handset +14699338887 has "Nithin Dodla" on file + bookings Mon 19 Oct 11:00, Tue 20 Oct 14:00 (and any
new ones from these calls):
 (b) new surname: "Hi, I'd like to book an appointment for my colleague, Wednesday the 21st at 10 a.m. Her name is
     Priya Raman — R, A, M, A, N." (if asked "in addition?": "Yes, it's for my colleague.") Pass: ONE read-back that
     spells R-A-M-A-N, saved on first non-objection, no "unable"/"temporary issue"/"spell" AFTER "booking that now",
     saves_over_one_readback 0, refusals ≤ 1 (≤ 2 if the letters were lost — then the spelling ask must come BEFORE
     the read-back; 3 = finding M6). live_tool_rounds_capped 0 or answered held.
 (d1) on file: "Hi, I'd like to book another appointment, Thursday the 22nd at 2 p.m." Do NOT say your name. Answer
     "in addition?" with "Yes." After the read-back stay SILENT ~10 s; on "Hello? Are you still there?" say "Yes."
     Pass: no spelling ask; read-back spells D-O-D-L-A (confirm.onfile_readback_unspelled 0 — 1 = prompt did not
     hold, report it); booked once; saves_over_one_readback 0; refusals ≤ 1; if the save waited, rung 1 heard first.
 (a) message: "I'd like to leave a message. My name is Nithin Dodla — D, O, D, L, A. My number is 469 933 8887.
     It's about an invoice." Pass: ONE summary spelling D-O-D-L-A + number digit by digit, saved at once, row
     "Nithin Dodla", readback_spelled 1, one owner email.
 All: backwards_goodbye 0. A failed check = finding: plain words + yes/no, fix red-first, ask before any redeploy.

Conserve usage and time WITHOUT compromising quality:
- Read only the plan sections named above and the parts of files you need (grep/offset), not whole big files; don't
  re-read what you already have; don't re-derive facts the plan or ledger already settles.
- Batch independent reads/commands into one turn; one filtered log query per call, not many.
- Use cheaper models (sonnet/haiku) for mechanical subagent work (log extraction, searches); keep opus for any code
  review of a fix. Spawn subagents only when they save real work.
- Never skip a check to save time: every call's numbers are read from the logs, every fix is red-first with a test and
  census, and a fix gets the full gate before redeploy. If saving usage would cost quality, say so and ask.
- Keep replies short and plain; put the detail in the ledger, not the chat.

Rules as before: paid runs need my yes; never git checkout/restore over uncommitted work in the main tree; long gates
in their own Git Bash window; owner decisions final; stop and ask at 2 h. Not in scope: LVX167, LVX174, LVX175 (A2),
LVX168–171. End with: verdict per fix and per call, "Part 3 as built" in the plan, ledger + memory updated, and what
round A2 starts with.
```

## Part 3 as built (2026-10-15, sitting 2, 18:25–19:55 CDT) — deploy + live calls

**Deploy (gcloud, main checkout, tracked tree clean, HEAD `15dfa09` = `04d176a` + docs/row commits, code diff empty):**
build `06af2a35` (29 s), tag `:04d176a`, digest `sha256:39c19239…57a9`, all smoke steps loaded. Migrate job →
`:04d176a`; `migrate --status` (`-fvpqt`): 53 applied, none pending, no "edited". LIVE **`voice-uk-prod-00104-n6b` @
`04d176a`**, 100% traffic. Env diff vs `00103-nvc` = only `GIT_COMMIT_SHA` eb60198→04d176a (44 = 44,
`VOICE_SPELL_MISS_CAP` unset, spec otherwise identical). Boot clean (0 WARNING+; `sms_channel_off` expected). Rollback:
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00103-nvc=100 --project=vetra-uk-edc8ca --region=europe-west2`.
Kept: 00104 is strictly better than 00103 on what was tested (F1 and the F4 spelling ask both gone).

**Owner decisions this sitting:** call order d1 → b → a (b first would put Priya on file and muddy d1) · keep test
rows · F5 + F2-on-Live + F6 = ONE design next sitting · silence re-run as d1b · **a name already on file is said, NOT
spelled** ("it can just say the name"; spelling it on d1 "felt weird") — reverses F4's read-back half · D1 folded
into next sitting.

**Calls** (owner handset → +18175803291; 331 s ≈ 5.5 call-min ≈ $0.72 + build, cap $2; `scripts/call-report.js` is
blind to Live calls):

| Call | CallSid | Verdict | Numbers |
|---|---|---|---|
| (d1) on file, nameless | `CA6bf6e2894fd6df32fd9a5b618db79290` | **A1 checks PASS; silence UNTESTED; F5** | spell_asks 0, spelling refusals 0; read-back "…for Nithin, D-O-D-L-A, booking that now" (`onfile_readback_unspelled` 0); booked Thu 22 once; gate refusals 1 (write_order); `saves_over_one_readback` 0; no cap hit; `backwards_goodbye` 0. Owner's mumbled "yes" to "in addition?" heard as "No" → "Understood, anything else?" → caller had to ask "did you book it?"; then the tool's in-addition guard refused AFTER "booking that now" (F5) |
| (d1b) silence re-run | `CA046f67282bcad0aa9dac67eaea34b55b` | **silence PASS; name not said; F6** | in-addition asked FIRST (right order) → yes → booked Fri 23 once, gate refusals 1; within-turn `live_repeat_cut` (260 chars) right after the save wiped the turn's text (`turns_reply_empty` 1 → `onfile_readback_unspelled` 1 is blind); ~15 s quiet → "Hello? Are you still there?" → yes → "anything else?" → goodbye. Owner: no name heard in the read-back |
| (b) new surname | `CAdefce6ab506bbf25c8b579ee06c72e80` | **FAIL (F2 on Live, F6, F5, M6)** | booked Wed 21 once "Priya Raman", no "unable", no cap hit, `backwards_goodbye` 0; caller heard "Wednesday at 10 for Priya Raman, booking that now. Before I finalize that, could you please spell…" then, in ONE turn, "…Priya Raman, R-A-M-A-N, booking that now. Wednesday, October 21 at 10:00 AM for Priya Raman, booking that now. You already have appointments… add or reschedule?"; gate refusals 3 (spelling 2 + write_order 1) + 1 tool in-addition refusal; counter `saves_over_one_readback` 0 is WRONG (counts turns) |
| (a) message | `CAbada737cd5227daee3438414ab08accc` | **PASS** | saved at once (0 refusals); ONE summary "So that's Nithin, D-O-D-L-A, on four six nine, nine three three, eight eight eight seven about an invoice"; dashboard row "Nithin Dodla"; ONE "New customer request" email 00:38:37Z; `backwards_goodbye` 0; `readback_spelled` 0 = instrument blind (caller's letters never reached the transcript) |

Emails: one "New appointment" each for d1/d1b/b, one "New customer request" for a, no "Unconfirmed booking".

**Verdict per fix:** F1 **PASS** live (0 cap hits in 3 bookings, no failure words; `live_write_refusal_replayed` now
carries callSid). F2 **FAIL on Live** (the gate order is right, but the model says its OWN "…booking that now" in the
same breath as the call; Live delivers the call before the words, so the spelling refusal is spoken after). F3
**PASS** by ear/text (b R-A-M-A-N, a D-O-D-L-A; counter blind). F4 **PASS** (no spelling ask for a name on file, d1 +
d1b); its read-back half is superseded by the owner's "say, don't spell". M6 **confirmed** (b: 3 refusals).
**A1 done-when:** `backwards_goodbye` 0 PASS (4/4) · refusals ≤ 1 per save FAIL (b 3) · one read-back FAIL by ear on b
(counter can't see it).

**Findings (next sitting fixes them, as ONE design):**
- **Root:** on Live the model's words arrive AFTER its tool call; every gate judges "what has been said" before the
  words exist, and its question/sentence is spoken after "booking that now".
- **F2-on-Live** spelling ask after the model's own read-back (b). **F5** the tool's in-addition guard
  (`capabilities/appointments.js:2159`) runs after the gates, so its question follows "booking that now" (d1, b).
  **F6** write_order sees `readBackMade` false and hands sentence S although the model is already saying its own
  read-back → read-back twice in one turn (b; d1b's repeat cut).
- **Instrument:** `saves_over_one_readback` counts read-back TURNS (a doubled read-back in one turn reads 1);
  `readBackIsFor` slot match missed "Wednesday at 10"; `readback_spelled` counts only captured spellings.
- **On-file name rule** (owner): say the name, never spell it — drop the letters from `composeReadBack`, the booking
  guardrail, message step 1/guidance; replace `onfile_readback_unspelled` with a count of on-file read-backs that NAME
  the person (d1b said no name at all).
- **D1 dashboard:** the Calls list hides calls after 00:00 UTC of the local "today" (7 PM CDT) until the next day —
  `frontend/src/App.jsx:444` sends local `to`, `backend/src/routes/calls.js:107` casts it in UTC; "Last 24 hours" too.
- **G2 (owner: in part 4):** with several bookings on file the model names only one (the prompt lists all ≤5; a 6th
  never reaches the prompt). Same sentence F5 moves, so fixed together.

## Part 4 starting message (paste into a fresh session)

```text
Run receptionist round A1 "say it once" — part 4: the "words arrive after the call" design + on-file name rule + D1.

FIRST, before any tool call that changes anything: reiterate in plain words (steps, hours, $) and ask me any
questions (AskUserQuestion; recommended first). Re-state where we are in one line at each step.

Read: docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md "Part 3 as built" (findings + call table) and "Part 3
sitting 1" (what exists); ledger .superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md (P3 lines from
"sitting 2" on). Branch feat/outbound-stage4. Prod = voice-uk-prod-00104-n6b @ 04d176a; rollback
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00104-n6b=100 --project=vetra-uk-edc8ca --region=europe-west2`.

Design first (brainstorm with me, then a short plan section), ONE fix set:
 (1) prompt: settle the spelling (new name, not spelled yet) and "in addition?" (bookings on file) BEFORE any
     read-back; never say "booking that now" while either is open.
 (2) code: when the write call arrives before the read-back text, give the words a short window to arrive (measure
     the gap on CAdefce6ab / CA046f67 first); accept an arriving read-back instead of handing a second sentence (F6).
 (3) code: in-addition look-ahead beside spellingGateWouldHold so its question comes first (F5).
 (4) counters: read-back SENTENCES per save (not turns); on-file read-back names the person; fix readBackIsFor's
     "Wednesday at 10" miss.
 (5) owner rule: a name already on file is SAID, not spelled (composeReadBack, booking guardrail, message step 1).
 (6) D1: Calls list date filter in the business timezone (frontend App.jsx:444 + backend calls.js:107), with a test
     for a 7–11:59 PM call.
 (7) G2: when a caller already has bookings, name them properly -- my choice in the design talk: list all vs
     count + next (e.g. "You have 4 upcoming appointments; the next is Monday at 11"); handle more than 5 on file.
Every fix red-first with a test + census rows hand-verified RED; opus review; full gate (gate-v4 db fullsab) in its
own mintty window; ask before ONE redeploy. Calls after (cap $2, scripts in the plan): b (new surname, spelled only
when asked), d1 (on file, nameless, "Yes, in addition"), d1b silence; all: ONE read-back by ear, refusals ≤ 1.

Conserve usage and time WITHOUT compromising quality: read only named sections and needed parts of files; batch
independent reads; cheaper models for mechanical subagent work, opus for code review; never skip a check; short plain
replies, detail in the ledger. Rules as before: paid runs need my yes; never git checkout/restore over uncommitted
work; long gates in their own Git Bash window; owner decisions final; stop and ask at 2 h. Not in scope: LVX167,
LVX174, LVX175 (A2), LVX168–171. End with: verdict per fix and per call, "Part 4 as built" in the plan, ledger +
memory updated, and what round A2 starts with.
```

## Part 4 design (2026-10-15, 20:50 CDT — owner-approved)

**Measured (free log reads):** a refused book call → read-back text in `turnReplyText`: ≤1.1 s (b, 00:27:02.43 →
03.56), ≤1.5 s (d1b, 00:10:46.28 → 47.74). Upper bounds (no per-chunk log), and the text may be the handed S, not the
model's own. **New cause on b:** the model said "Wednesday **at 10**" — `readBackMentionsSlot` never matches a bare
hour (slotMention.js header), so the gate could not see that read-back at any timing. Our own flow steps teach the
form ("Tuesday at 3 for Jon Doe").

**Owner decisions:** G2 = name 1–2 bookings, 3+ → "You have N upcoming appointments; the next is Monday at 11 a.m."
(N from the DB, a 6th+ never dropped) · wait window ≤ 2 s, only when the model sent audio this turn, ends when a
read-back arrives, logged · D1 dashboard deploy in the same sitting as the voice deploy, asked separately ·
**in-addition: ask only when unclear, and right away** — no ask when the words say it (another / also / as well /
second: the model sets the flag), no ask when the booking is for a different person than those on file (CODE
rule), else ask once the moment the booking is asked for, before times and the read-back · **ask-now rule,
general:** "when the caller says something you need to check, check it in your very next reply"; code-backed +
counted where late asks hurt (spelling, in-addition) · a name on file is said, never spelled; a surname spelled this
call keeps its letters.

**Fix set (each red-first + a hand-verified RED sabotage row):**
- **F-A** ask-now prompt: general line in the tool contract; spelling block asks right after a new name;
  caller-context asks extra-or-move right away (G2 wording); flow-step examples get a meridiem; never "booking that
  now" while spelling or extra-or-move is open. Snapshots regenerated once.
- **F-B** on-file said: `composeReadBack` spells only `ctx.callerSpelled`; guardrail + message step 1/5/guidance.
- **F-C** detector: `"<weekday> at <h>"` / hour word, minute 0, 07:00–19:59 only (gate sight + counter miss).
- **F-D** wait for the words: `onToolCall` waits ≤ 2 s before the gate for a booking-rule write when model audio
  arrived this turn and no read-back of the slot is in `turnReplyText`/`lastReplyText`; early exit on a matching
  chunk / turnComplete / interrupt / close; a second write waits behind it; `live_readback_wait` {waited_ms, outcome}.
- **F-E** in-addition: one exported predicate (guard + gate, no drift); different first name from every booking on
  file → no ask; write_order steps aside (beside `spellFirst`) so the tool's question comes before any S; refusal
  text in G2 wording + "if extra, read it back once and call again in that same response with the flag";
  `upcomingTotal` from the DB; counter `in_addition_asked_after_readback`.
- **F-F** counters: read-back SENTENCES per save; pre-cut text when a repeat cut wipes a turn;
  `onfile_readback_nameless` replaces `onfile_readback_unspelled`; `spell_ask_after_readback`.
- **F-G** D1: calls.js bounds in the business timezone (analytics.js pattern, index-friendly); presets send no `to`;
  test for a 21:30 CDT call.

**Order:** S1 (tonight) F-B → F-A → F-C · S2 F-E → F-D · S3 F-F → F-G → rows → opus review · S4 fix round + commit +
`gate-v4.sh <sha> a1-p4 db fullsab` in mintty · S5 ask → voice redeploy → ask → dashboard deploy → calls. ≈ 9.5 h
active; $0 build; calls ≈ $0.40–0.60 (cap $2).

**Calls after** (handset on file: Nithin Dodla Mon 19 11:00, Tue 20 14:00, Thu 22 14:00, Fri 23 14:00; **Priya
Raman Wed 21 10:00 is on file now**, so b needs a new name):
- (b) "Book an appointment for my colleague, Wednesday the 28th at 10 a.m. Her name is Maya Okafor." Spell
  O-K-A-F-O-R only when asked. Pass: spelling asked right after the name, before any read-back; NO in-addition ask;
  ONE read-back with the letters; refusals ≤ 1; `saves_over_one_readback` 0 (sentences).
- (d1) nameless: "I'd like to book another appointment, Thursday the 29th at 2 p.m." Pass: no in-addition ask, no
  spelling ask, ONE read-back that SAYS Nithin (no letters), refusals ≤ 1.
- (d1b) "Can I book Friday the 30th at 2 p.m.?" Pass: extra-or-move asked FIRST in G2 count + next wording; "Yes,
  in addition"; ONE read-back saying the name; silent ~10 s → "Hello? Are you still there?" → "Yes".
- All: `backwards_goodbye` 0; `live_readback_wait` outcomes read; each call read by callSid AND time window.

## Part 4 sitting 1 as built (2026-10-15, 20:50–23:10 CDT, $0)

**Commits:** `0940920` design · `1067209` F-B · `07539cb` F-A · `aebaeda` F-C · `e41a6c0` F-E · `af5a5e5` F-D. 33 new p4 rows + 4 re-anchored, every one hand-verified RED (scratchpad
`verify-rows.mjs`, maxBuffer 512 MB); census 255. Not yet run: the full root suite, the gate.

**Findings that changed the design**
- **On Live the system instruction is built ONCE, at the greeting** (`lib/voice/live/index.js` ~8697
  `buildSystemInstruction(state.step, …)`), so the step-scoped SPELLING NOT YET CONFIRMED block never reached the
  model, and the static guardrail said "do not ask them to spell anything unless you are told to". That — not only
  ordering — is why call b's spelling ask came after the model's own read-back. F-A puts the ask-now rule in the
  tool contract (static prefix) + the book_appointment declaration (always carried).
- **Bare hour:** call b's own read-back ("Wednesday at 10") was unreadable to the gate at any timing (F-C).
- **F-D must not yield before the gate** when nothing is waited for: an `await` with nothing ahead lets a
  turnComplete delivered right behind the call roll the turn first (caught by `liveClaimGuardRefusedWrite`). And a
  wait can END on the words in the same message as turnComplete, so the gate's continuation runs after the roll:
  the turn state is frozen when the wait ends (`frozenTurnState`, read by the runner's `turnState`).
- **F-E regression caught before commit:** under `allow` the helper dropped the full list → booking threw.
- **Two rows read GREEN first** (cases too easy: a shared surname rescued a misheard first name; no guard-level
  flag-set write) — sharpened. The verifier's 1 MB spawnSync buffer cut the REPLAY suite ("no tally") — fixed.

**What exists now:** F-A (ask-now rule, meridiem examples, in-addition rule rewritten, G2 prompt sentence) · F-B (on
file said) · F-C (`weekdayBareHour`) · F-D (`VOICE_READBACK_WAIT_MS` default 2000/0 = off, `live_readback_wait`
{tool, waited_ms, outcome ∈ arrived|timeout|turn_end|interrupted}, booking writes chained, state frozen) · F-E
(`inAdditionWouldRefuse` shared by guard + gate `inAdditionFirst`, different person never asked, G2 in the guard,
`upcomingTotal`, counter `in_addition_asked_after_readback`).

**Left for part 4:** F-F counters · F-G D1 · **11 pm/1 pm slot-matcher fix (owner: IN part 4)** — digit forms match
by substring, so "1 pm" is found inside "11 pm" and a read-back of 11 p.m. vouches for a 1 p.m. write; make the
forms whole-word · opus review of `0940920..HEAD` · fix round · full gate · deploys · calls.

## Part 4 sitting 2 starting message (paste into a fresh session)

```text
Run receptionist round A1 "say it once" — part 4, sitting 2: F-F counters, F-G D1, the 11pm/1pm matcher fix, opus
review, fix round, then launch the full gate.

FIRST, before any tool call that changes anything: reiterate in plain words (steps, hours, $) and ask me any
questions (AskUserQuestion; recommended first). Re-state where we are in one line at each step.

Read: docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md "Part 4 design" + "Part 4 sitting 1 as built";
ledger .superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md (P4 lines). Branch feat/outbound-stage4. Prod
= voice-uk-prod-00104-n6b @ 04d176a (nothing of part 4 deployed); rollback
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00104-n6b=100 --project=vetra-uk-edc8ca --region=europe-west2`.

Build (each red-first + a hand-verified RED row; the scratchpad verifier needs maxBuffer >= 512 MB for REPLAY):
 (F-F) confirm audit counts read-back SENTENCES per save (prototype the splitter on call b's real text first:
     "...booking that now.Wednesday, October 21 at 10:00 AM..." = 2; "a.m." must not split); a within-turn repeat
     cut must not wipe the turn's text from the audit (d1b turns_reply_empty); onfile_readback_nameless replaces
     onfile_readback_unspelled; spell_ask_after_readback counter.
 (F-G) D1: AI-phone-dashboard/backend/src/routes/calls.js bounds in the business timezone (analytics.js pattern,
     index-friendly `($d::date::timestamp AT TIME ZONE $tz)`), presets send no `to` (frontend App.jsx); test a 21:30
     CDT call; confirm the gate runs the dashboard suites, else run them as an explicit step.
 (M) slotMention digit/word forms matched whole-word ("1 pm" must not match "11 pm").
Then: opus code review of 0940920..HEAD (named risks: F-C write side, F-D chain/freeze/interrupt, F-E predicate +
same-person rule, F-F splitter, D1 bounds) → fix round → commit → `gate-v4.sh <sha> a1-p4 db fullsab` in its own
mintty window (pass = ROOT exit 0, census N, DB exit 0, every row red except the 3 baseline x, 0 "could not be
READ", tree clean). Deploys + calls are the NEXT sitting (scripts in "Part 4 design").

Conserve usage and time WITHOUT compromising quality: read only named sections and needed parts of files; batch
independent reads; cheaper models for mechanical subagent work, opus for code review; never skip a check; short
plain replies, detail in the ledger. Rules as before: paid runs need my yes; never git checkout/restore over
uncommitted work; long gates in their own Git Bash window; owner decisions final; stop and ask at 2 h. Not in scope:
LVX167, LVX174, LVX175 (A2), LVX168–171.
```

## Part 4 sitting 2 as built (2026-10-16, 00:08–~02:10 CDT, $0)

**Commits (on `974df80`):** `f0d5031` M · `0824b9b` F-F · `8e28026` F-G/D1 (sonnet, worktree, cherry-picked) ·
`633af07` review I1+M8 · `5418ff4` review M6+M7 (sonnet, worktree) · `47efa2c` review I2/I3/I4/M5 · `6bda465`
re-review I1 · `5c15583` re-review M2–M7 · docs. Every new row hand-verified RED; census **292**. Root suite at
`5c15583` (clean tree): 325 files, 7993 passed. Dashboard suites (the gate does NOT run them): backend 17 files 165
passed, frontend 10 files 68 passed.

**What was built**
- **M:** time forms match whole words — "1 pm" no longer found inside "11 pm" (also 12→2, 11:00→1:00, 1130→130).
- **F-F:** `lib/voice/readBackCount.js`. A booking save's read-backs = read-back SENTENCES that name its slot (min 1
  per read-back turn): call b counts 2; the 10 corpus turns shaped "X at 2 PM. Shall I go ahead?" count 1. d1b's
  lost read-back was the vendor `interrupted` handler clearing the turn's text unaudited (not the repeat cut) — it is
  audited there now. `onfile_readback_named/_nameless` (first name OR surname, whole word) replace `_unspelled`;
  `spell_ask_after_readback`; counting-only "could you please spell" alternation.
- **D1:** calls list bounds in the business timezone (`AI-phone-dashboard/backend/src/callDateBounds.js`); presets
  send no `to` (`frontend/src/callsQueryParams.js`). Real-Postgres test: a 21:30 CDT call is listed under its day.
- **Opus review (0 C / 4 I / 6 M) + re-review (0 C / 1 I / 5 M), all I fixed:** bare hour only 08:00–18:59 (owner:
  a plain "at 7" never counts), only a date between weekday and hour, part-of-day phrases refuse; the read-back wait
  reads arriving text as OPEN (a bare hour needs a whole next word that cannot start a minute/meridiem/part of day;
  "at 10." after a digit stays open); the turn-end retry QUEUES behind an in-flight booking (dropping it lost
  LVX160's yes — caught by the re-review); frozen turn state passed per call; close ends the wait;
  `confirm.saved_then_asked` (owner: keep saving on arrival, count a question after it); live upcoming count;
  same person on any shared name word, titles stripped.

**Owner decisions (2026-10-16):** D1 by sonnet in parallel · on-file name said = first OR surname · bare-hour window
08:00–18:59 (after a plain re-explanation) · trailing question: keep saving, count it.

**Declined / parked:** review M9 (refusal text "call again with the flag") declined — the flag rides in the LVX160
stash; a re-call instruction adds a second write path · M10 counter attribution after a roll (counters only) · a
second arrival in one turn orphans the first `saved_then_asked` marker (rare, counter only) · **ask the owner:** the
shared `spellRequestRe` misses "could you please spell…" (call b + 3 corpus asks) — the reducer's spelling cap is
blind to those asks · analytics.js chart series still UTC days · "1:30pm" (no space) has no form · UK date order
("Wednesday 28th October at 10") never read as a bare hour.

**Gate:** `gate-v4.sh <docs sha> a1-p4 db fullsab` launched in its own mintty window via
`.superpowers/sdd/2026-10-13-round-a1-say-it-once/run-gate-a1-p4.sh <sha>`; log
`.superpowers/sdd/2026-10-10-batch3-launch-guards/gates/gate-a1-p4.log`. ~3 h machine (292 rows).

## Part 4 sitting 3 starting message (paste into a fresh session)

```text
Run receptionist round A1 "say it once" — part 4, sitting 3: read the gate, then (each asked separately) voice
redeploy, dashboard deploy (D1), and the three live calls.

FIRST, before any tool call that changes anything: reiterate in plain words (steps, hours, $) and ask me any
questions (AskUserQuestion; recommended first). Re-state where we are in one line at each step.

Read: docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md "Part 4 design" (calls b/d1/d1b + pass lines),
"Part 3 as built" (deploy procedure), "Part 4 sitting 2 as built"; ledger
.superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md (P4 lines). Branch feat/outbound-stage4. Prod =
voice-uk-prod-00104-n6b @ 04d176a; rollback
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00104-n6b=100 --project=vetra-uk-edc8ca --region=europe-west2`.

1. Gate: one-shot read of .superpowers/sdd/2026-10-10-batch3-launch-guards/gates/gate-a1-p4.log. Pass = ROOT exit 0,
   CENSUS 292 clean, DB exit 0, every row red except the 3 baseline x (ask-branch-latch, ask-branch-in-turn,
   ask-latch-per-action), 0 "could not be READ", tree clean. Any other GREEN row = a finding: stop and report.
2. Ask -> voice redeploy (build from the MAIN checkout, never an LF worktree; tracked tree clean; diff env vs
   00104-n6b first; VOICE_READBACK_WAIT_MS unset = 2000).
3. Ask -> dashboard deploy (D1).
4. Calls (cap $2; paid -> my yes): b (Maya Okafor, Wed 28th 10 a.m.), d1 (another, Thu 29th 2 p.m.), d1b (Fri 30th
   2 p.m. + 10 s silence). Read each by callSid AND time window. New numbers: confirm.saves_over_one_readback (now
   per sentence), saved_then_asked, spell_ask_after_readback, onfile_readback_named/_nameless; live_readback_wait
   outcomes; write_retry_deferred_booking_in_flight. Dashboard: the calls show under today after 7 p.m. CDT.

Conserve usage and time WITHOUT compromising quality; cheaper models for mechanical work; short plain replies,
detail in the ledger. Rules as before: paid runs need my yes; never git checkout/restore over uncommitted work;
owner decisions final; stop and ask at 2 h. Not in scope: LVX167, LVX174, LVX175 (A2), LVX168–171.
```

## Part 4 sitting 3 as built (2026-10-16, ~10:50–15:05 CDT incl. a long owner break, ~$0.65)

**Gate** `gate-a1-p4` @ `55d73c6`: PASS. ROOT exit 0 (7991 passed), CENSUS 292 clean, DB exit 0 (700), sabotage 289
red + exactly the 3 baseline x, 0 "could not be READ", no dirty tree.

**Voice deploy (owner YES):** build `f7135f25` (main checkout, tracked tree clean, `5c15583..55d73c6` docs-only) →
`voice:5c15583` digest `sha256:9e8dea9b…381d`, all smoke steps; migrate job → `:5c15583`, `--status` 53 applied, none
pending, no "edited". LIVE **`voice-uk-prod-00105-mw4` @ `5c15583`**, 100%. Env diff vs `00104-n6b` = only
`GIT_COMMIT_SHA` (44 = 44, spec identical, `VOICE_READBACK_WAIT_MS` unset = 2000). Boot 0 WARNING+. Rollback:
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00104-n6b=100 --project=vetra-uk-edc8ca --region=europe-west2`.
Owner KEPT 00105 after call b (the defect path pre-dates part 4).

**D1 (owner: backend-only hotfix).** The live dashboard API was `dashboard:e1419d9` (09-08); HEAD would ship 22
dashboard commits incl. 4 outbound-only Settings cards (readiness: hide first). Branch `hotfix/d1-dashboard-bounds`
= `e1419d9` + 8e28026's backend files only, commit `f130aee` (local, not pushed); backend 15 files 149 passed; the
D1 test red 5/6 with the fix reversed. LIVE **`dashboard-api-uk-prod-00003-hc7`** @ `dashboard:f130aee`, env/spec
unchanged, /health 200. Rollback: `gcloud run services update-traffic dashboard-api-uk-prod --to-revisions=dashboard-api-uk-prod-00002-mlr=100 --project=vetra-uk-edc8ca --region=europe-west2`.
Frontend half (presets send no `to`) NOT deployed — it ships with the full dashboard deploy.

**Calls** (owner handset → +18175803291, order d1 → d1b → b by owner; ≈ 309 s ≈ $0.65):

| Call | CallSid | Verdict | Numbers |
|---|---|---|---|
| (d1) "another", nameless | `CA7c0d50b0672a602767c9e9f8ac0cf38c` | **A1 PASS; in-addition asked anyway (LVX180)** | asked "You have 5 upcoming appointments; the next is Monday, October 19 at 11 AM…in addition…or move?" (G2 wording right, ask wrong after "another"); booked Thu 29 14:00 once, 0 refusals; heard "Thursday at 2 PM for Nithin Dodla, booking that now. I've booked that for Thursday, October 29 at 2 PM under Nithin Dodla"; `onfile_readback_named` 1, `saves_over_one_readback` 0, spell asks 0, `backwards_goodbye` 0; odd ending ("location information") from garbled caller text |
| (d1b) ambiguous + silence | `CAb3e55b61be728cc99f4e8994f5d160e3` | **booking + silence PASS; wording + name ask FAIL (LVX180)** | extra-or-move asked before the read-back but in generic wording, after "That time is available"; asked an on-file caller's full name; booked Fri 30 14:00 once, in addition, 0 refusals; one read-back naming Nithin; nudge "Hello? Are you still there?" at +8 s → yes → "What else…?" → goodbye |
| (b) colleague, new surname | `CA70682e3219cb227353f4681b25119586` | **FAIL — LVX179 (P0)** | spelling asked right after the name (PASS); first name misheard (Amara → Maja); after listing 9/1/4:30 the model booked 9 AM itself (same-breath save, `slot_listed_only`); the caller's "10 a.m." became a SECOND booking via an in-addition ask; DB has both; `live_readback_wait` {timeout, 2000 ms} on the 10 AM save; claims 0 |

**Per fix:** F-A partly (ask-now spelling PASS on b; in-addition "ask only when unclear" FAIL on d1) · F-B PASS (name
said, never spelled, d1 + d1b) · F-C/M not observable · F-D fired once (timeout) without harm · F-E PASS for a
different person (no ask on b's first booking), G2 wording 1 of 2 · F-F counters read sensibly on d1/d1b · D1 live
(owner VERIFIED: Custom 10-15 → 10-15 now lists the evening calls).
**A1 done-when:** one read-back per save PASS on d1/d1b · refusals ≤ 1 PASS (0, 0, 0) · `backwards_goodbye` 0 PASS ·
but b booked something nobody agreed to, so A1 is not done until LVX179 is fixed.

**Owner decisions after the calls (2026-10-16, after a plain explanation of where 9 AM came from):**
- **Confirm = always ask once, as a question.** "So that's Monday the 19th at 9 a.m. for Nithin Dodla, is that
  right?" Any answer that is not a no saves it (a mangled yes still saves). Then only "Done, you're all set" — never
  the details again. This REPLACES the S2 ruling "same-breath statement read-back saves" ("booking that now"); the
  wait for the answer becomes CODE (today the question-form wait is prompt-only, the I2 ruling).
- **Spelling = the full name, one ask, new people only.** "Could you spell the first and last name for me?" A name on
  file is never asked for and never spelled (unchanged). Reason: "Maja"/"Maya" sound the same, so a read-back cannot
  catch a first name; only spelling can.
- **A correction right after a save moves that booking**, never adds one. When unsure, ask naming it: "Move your 9
  a.m. to 10?"

## Next session starting message (paste into a fresh session)

```text
Fix LVX179 (P0): the receptionist booked a time the caller never chose, then made the correction a second booking.
AND LVX181 (P1, same incident, owner: same session): it answers a thinking "umm" (or a tiny noise) as if the caller
had finished -- the 9 AM booking came 1.2 s after a ~1.3 s "umm" that followed "Which of those works best?".
Owner decisions (2026-10-16, in the plan "Part 4 sitting 3 as built"): always confirm ONCE as a question, save on
anything but a no, then only "Done, you're all set"; spell the FULL name of a new person in one ask; a correction
right after a save MOVES that booking; an "umm" must not make it talk at all, not only not book.

FIRST, before any tool call that changes anything: reiterate in plain words (steps, hours, $) and ask me any
questions (AskUserQuestion; recommended first). Re-state where we are in one line at each step.

Read: docs/receptionist-backlog.md LVX179 + LVX180 + LVX181 (grep, the file is large); docs/superpowers/plans/
2026-10-13-round-a1-say-it-once.md "Part 4 sitting 3 as built"; ledger
.superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md (P4 S3 lines). Branch feat/outbound-stage4. Prod =
voice-uk-prod-00105-mw4 @ 5c15583; rollback
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00104-n6b=100 --project=vetra-uk-edc8ca --region=europe-west2`.

Design with me first (plain words, then a short plan section): (1) booking confirm = ONE question read-back; the
write is refused in code until that question was spoken in an earlier model turn AND the caller has answered with
anything but a no (Live sends the call WITH the words -- the same-breath statement save goes; replay CA70682e and
the d1/d1b calls first; list which existing rows/tests encode the old same-breath rule); after the save only
"Done, you're all set"; (2) prompt + spelling gate: a new person spells first AND last name in one ask; (3) a
correction right after a save moves that booking, never adds one; the in-addition question names what is on file.
(4) LVX181: FIRST measure ($0, ~30 min) how often a model turn followed a short wordless caller sound across recent
calls (live_utterance voiced_ms/transcript_chars vs the next turn; 3.8 probe in docs/gemini-38-live-analysis.md §6
covered mid-sentence trail-off only); then pick with me among endOfSpeechSensitivity LOW, silenceDurationMs
1000-1200 (1600 cost +512 ms/turn in Sept), a prompt line "after a question a lone um/uh is not an answer"; watch
reply_after_last_voice_ms_p50 so replies don't get slower. Optional, my call: LVX180 prompt items. Each red-first + a
hand-verified RED row; opus review; gate-v4 db fullsab in mintty; ask before ONE redeploy; then calls (cap $2): b
again (new colleague, pick from the list only when asked, with a real "ummm" pause before choosing), one "no, 10
instead" correction call, one on-file booking (one question, one yes, "you're all set") with "uhh" pauses.

Conserve usage and time WITHOUT compromising quality; cheaper models for mechanical work; short plain replies,
detail in the ledger. Rules as before: paid runs need my yes; never git checkout/restore over uncommitted work;
owner decisions final; stop and ask at 2 h. Round A2 (LVX167, LVX174, LVX175) comes after this.
```

## Part 5 sitting 1 as built (2026-10-16, 19:04–~21:05 CDT, $0) — LVX179 fixes 1–2 + LVX180 prompt + carry-over

Plan: `~/.claude/plans/pasted-content-id-ff3e-fix-lvx179-deep-mitten.md`. Owner answers at the start: the one question
SPELLS BOTH names for a new person; a paid LVX181 probe is OK (exact $ first); LVX180 prompt items folded in.
Owner mid-sitting (AskUserQuestion): an answer the caller already gave carries over — "it should not ask again for
anything it already got the answer to". Not deployed; prod still `voice-uk-prod-00105-mw4` @ `5c15583`.

**What changed (code):**
- `lib/voice/savePolicy.js` `decideSave` (booking rule): saves only on a QUESTION about this slot in the previous turn
  (`asksReadBack`: confirmReadBackRe or "please confirm", not ending on a statement) + a sound since + no objection;
  any read-back in the turn being spoken HOLDS (question → awaiting; statement → `in_turn_statement`); a previous
  statement → `previous_statement` held. A yes that names a DIFFERENT time is a change (`clockTimesIn`/`timesAgainst`,
  CA94817d). New source `answered_earlier` = the carry-over. `composeReadBack` = "So that's … for Maya, M-A-Y-A,
  Okafor, O-K-A-F-O-R, is that right?" (every name spelled when the caller spelled).
- `services/tools.js`: on the booking rule the A1 decision is authoritative — `readBackMade` = the slot question only
  (b's 10 AM rode an action-blind "Just to confirm … additional one, correct?"); refusal iff not agreed (slot-tied
  latch kept); write-order ceiling + attempt budget NEVER release a booking-rule write; silent-turn verdict decides
  before the action-blind token; stash only on a slot question; new `a1AskMessage` hands the question and says WAIT;
  an ENGINE retry of a booking must also pass the one-question rule for its own slot, else it is dropped
  (`a1_engine_retry_dropped`; CA94817d's replay booked the stale 4:30 on the caller's yes to 10 AM).
- `lib/voice/live/index.js`: `a1AnsweredReadBack` — the booking question (asks + names a time/day) judged ONCE per
  question at EVERY turn end; kept unless the answer is a no / question / change / a time it did not name, or the
  question is a cancellation; cleared by a newly asked time question and by any completed action. Runner copies it
  (`lib/voice/live/tools.js`, also in the refusal-echo key). Cap pass-said accepts the question form.
- Success replies (book + reschedule): `Say only: "Done, you're all set."`.
- Prompt (`capabilities/appointments.js`, `capabilities/messages.js`, `services/gemini.js`): ONE question, wait,
  never call in that breath, then only "Done, you're all set"; ask-now spelling = "Could you spell the first and last
  name for me?"; on-file caller never asked for a name, "not even their full name" (LVX180); "another / also / one
  more" = extra, no ask, opener no longer reads against it (LVX180); "Never ask the caller again for something they
  have already answered on this call".

**Proof so far:** `tests/lvx179Replay.test.js` (18 rows: b/d1/d1b replays, previous statement, just-to-confirm hole,
clear no, full-name spelling, prompt, 5 carry-over rows) RED 5/7 at HEAD before the fix. 58 old-rule tests updated
deliberately (listed in the ledger P5 S1 lines); CA954592 #2-4 expectations CHANGED write→refuse (no ceiling release).
Tests caught three defects of my own before commit: CA94817d (yes + different time booked 4:30), a cancellation's yes
carried to a booking, an older answer surviving a newer unanswered proposal — all fixed, each has a row.

**Not done (S2):** full root suite on a still tree; sabotage census has 11 drifted rows + new rows to add and
hand-verify RED; Fix 3 (correction moves); LVX181 (count → probe → pick); opus review; gate. Pre-existing, not mine:
`corpus:build` rewrites derived targets in CA240834/CA299f23/CA6dcec7/CAec2309 at HEAD (gate does not run
`corpus:check`) — left as committed, backlog note.

**Residual risks to put to the reviewer:** (1) a "no" whose transcript arrives after the turn ends is judged as
"answered" (same lag A1 already lives with; the model heard it and must still call); (2) when spelling is asked AFTER
the question was answered, the letters are never read back (owner rule: never ask again wins); (3) `PLEASE_CONFIRM_RE`
is English-only; (4) the time comparer over-reads (safe direction: one more ask).

## Part 5 sitting 2 starting message (paste into a fresh session)

```text
Continue LVX179 + LVX181, sitting 2 of 3. S1 code is committed on feat/outbound-stage4, NOT deployed (prod
voice-uk-prod-00105-mw4 @ 5c15583; rollback `gcloud run services update-traffic voice-uk-prod
--to-revisions=voice-uk-prod-00104-n6b=100 --project=vetra-uk-edc8ca --region=europe-west2`).
Read: docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md "Part 5 sitting 1 as built"; plan
~/.claude/plans/pasted-content-id-ff3e-fix-lvx179-deep-mitten.md (Fix 3, LVX181 A-C, Proof); ledger
.superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md (P5 S1 lines).
FIRST: reiterate in one short plain paragraph (steps, hours, $) and ask anything needed (AskUserQuestion).
Order: (0) full root suite on a still tree (~17 min, background) -- fix stragglers; (1) Fix 3: a correction right
after a save MOVES that booking (lastBooked + words since the save: correction cue -> move via the reschedule path;
"another/also/too" -> add; unclear -> "Move your 9 a.m. to 10, or keep both?"), red-first rows; (2) LVX181 A: $0 log
count of replies after a short wordless caller sound + baseline reply_after_last_voice_ms_p50 on 00105; B: the probe
(state exact $ and wait for my yes); C: pick with me; (3) sabotage: repoint the 11 drifted census rows, add rows for
every new guard (in-turn statement holds, question-required, voiced-required, Done-only prefix, full-name spelling,
carry-over set/supersede/cancel/spent, engine-retry own-slot, time comparer, correction move/add/ask), hand-verify
each RED; (4) opus review with the residual risks listed in "S1 as built"; (5) gate-v4 db fullsab in mintty. Stop
and ask at 2 h. S3 = gate verdict, ONE redeploy (ask), 3 calls (cap $2), docs.
Rules as before: paid runs need my yes; never git checkout/restore over uncommitted work; owner decisions final;
short plain replies, detail in the ledger; cheaper models for mechanical work.
```

## Part 5 OVERNIGHT starting message (owner, 2026-10-16 ~21:10 -- paste into a fresh session; supersedes the S2 message)

```text
OVERNIGHT, unattended: finish LVX179 + LVX181 (Part 5 S2 + gate + deploy) by morning. I am asleep -- do not wait
for me except where noted. S1 is committed (1e78dc1, feat/outbound-stage4), NOT deployed; prod
voice-uk-prod-00105-mw4 @ 5c15583; rollback `gcloud run services update-traffic voice-uk-prod
--to-revisions=voice-uk-prod-00104-n6b=100 --project=vetra-uk-edc8ca --region=europe-west2` (after deploy, roll back
to 00105-mw4 instead).
Read: docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md "Part 5 sitting 1 as built" + "Part 5 sitting 2
starting message" (the task list); plan ~/.claude/plans/pasted-content-id-ff3e-fix-lvx179-deep-mitten.md; ledger
.superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md (P5 lines).
My decisions for tonight (final): (1) the LVX181 probe may run, hard cap $0.80, report exact $; (2) you pick the
LVX181 setting by the pre-registered rule (fewest replies to an umm with normal-reply delay <= today +150 ms; no clear
winner -> change nothing, say why); (3) DEPLOY overnight if the gate passes (build from the main checkout, env diff,
smoke, keep the rollback ready); (4) the 2 h stop is lifted tonight only -- stop only for an owner decision not
covered here, and leave it in the morning report.
Already running: the full root suite at 1e78dc1 in a mintty window (gate label p5-root, log
.superpowers/sdd/2026-10-10-batch3-launch-guards/gates/gate-p5-root.log; launcher
.superpowers/sdd/2026-10-13-round-a1-say-it-once/run-gate-p5.sh <sha> <label> [modes]). Census will show 11 drifted
rows -- expected, repoint them in step 3.
Run every long job (root, gate, sabotage) in mintty via run-gate-p5.sh, never a Claude Code background shell (the
memory reaper killed one tonight); keep this session active with foreground wait loops (<= 9 min each, anchored
markers). Serialize vitest runs. Never git checkout/restore over uncommitted work. Cheaper models for mechanical work;
opus for the review. Write detail to the ledger; end with a short morning report: what passed, what deployed (revision,
sha, rollback), probe $ and the chosen setting, anything left for me, and the 3 call scripts for the morning (on-file
booking with "uhh" pauses; call b with a new colleague and a real "ummm" before choosing; "no, 10 instead" right after
a save) with the cap of $2.
```

## Part 5 OVERNIGHT full prompt (supersedes the overnight block above; owner wants to call on waking)

```text
OVERNIGHT, UNATTENDED -- finish LVX179 + LVX181 and deploy, so that when I wake up I can make the 3 test calls
straight away. I am asleep: do not wait for me except for something not covered below (then park it in the morning
report and carry on with everything else).

WHERE WE ARE
- Branch feat/outbound-stage4. S1 code is committed at 1e78dc1 (docs after it), NOT deployed.
- Prod = voice-uk-prod-00105-mw4 @ 5c15583. Rollback before your deploy:
  gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00104-n6b=100 --project=vetra-uk-edc8ca --region=europe-west2
  After your deploy, the rollback target is voice-uk-prod-00105-mw4.
- The full root suite at 1e78dc1 is already running in a mintty window (gate label p5-root, log
  .superpowers/sdd/2026-10-10-batch3-launch-guards/gates/gate-p5-root.log). Read its verdict first. Its census will
  show 11 drifted sabotage rows: expected, you repoint them in step 4.

READ FIRST (briefly)
- docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md: "Part 5 sitting 1 as built" and "Part 5 sitting 2
  starting message".
- The plan ~/.claude/plans/pasted-content-id-ff3e-fix-lvx179-deep-mitten.md (Fix 3, LVX181 A-C, Proof, Deploy).
- The ledger .superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md (P5 lines).
- docs/receptionist-backlog.md: grep LVX179, LVX180, LVX181.

MY DECISIONS FOR TONIGHT (final, do not re-ask)
1. The LVX181 probe may run. Hard cap $0.80; report the exact $.
2. You pick the LVX181 setting by the pre-registered rule: fewest replies to an "umm", with the normal-reply delay
   no more than 150 ms above today's. If no arm clearly wins (prompt line must beat default by >= 3/10), change
   nothing and say why.
3. DEPLOY tonight if, and only if, the gate passes.
4. The 2 h stop is lifted tonight only.
Standing owner decisions (unchanged): every booking is confirmed with ONE question and saved on anything but a no,
then only "Done, you're all set"; a new person spells first AND last name in one ask; the one question spells every
name they spelled; an answer already given carries over (never ask again for something already answered); a
correction right after a save MOVES that booking; an "umm" must not make it talk at all.

DO, IN ORDER
0. Read the p5-root verdict (root exit, failing files). Fix any straggler red-first and commit.
1. FIX 3: a correction right after a save moves that booking, never adds one. In capabilities/appointments.js'
   book path, before the in-addition guard: scratch(ctx).lastBooked exists this call, same person
   (samePersonBookings), different time. Classify the caller's words SINCE that save (store the callerSaidThisCall
   length on lastBooked at save time):
   - correction cue (no / instead / actually / change / move / make it / rather / meant) and no addition cue ->
     MOVE lastBooked to the new time through the existing reschedule path (rescheduleAppointment: identity check,
     validateBookingTime, adapter). Never insert. Success reply ends in Say only: "Done, you're all set." Update
     lastBooked.
   - addition cue (another / also / too / as well / second / both / extra / in addition / keep both) and no
     correction cue -> treat as in_addition_to_existing = true (no question).
   - neither, both, or words not transcribed yet -> refuse, naming it: ask "Move your <old time> to <new time>, or
     keep both?". Re-classify on the next attempt; the caller's answer ("move it" / "keep both") lands in the words
     since the save.
   - Check whether a move should notify the owner like a booking does. If it doesn't today, say so in the report;
     don't build an outbox.
   Red-first replay rows in tests/lvx179Replay.test.js: "no, 10 instead" right after a save -> one row, moved;
   "also one at 3" -> two rows; unclear -> the named question, then "move it" -> moved; a different person -> the
   normal path.
2. LVX181 A ($0, ~45 min): from Cloud Logging (CLOUDSDK_CONFIG=~/.gcloud-vetra2, project vetra-uk-edc8ca, service
   voice-uk-prod), revisions 00087 -> 00105. For each live_utterance with transcript_chars <= 6 and voiced_ms < 1500,
   did a model turn start within 2.5 s of its close? Count per CALL (calls with >= 1 / calls), with examples. Also
   record the baseline reply_after_last_voice_ms_p50 on 00105 from live_call_summary. Watch the Norton TLS trap
   (memory norton-tls-inflates-latency) and gcloud quoting on Windows (fetch from bash).
3. LVX181 B (paid, cap $0.80): new scripts/probes/lvx181-umm.mjs, reusing scripts/probes/lib/geminiSession.js,
   lib/audio.js and lib/spendLive.js (reserve/commit, so the cap is enforced in code). gemini-3.8-live, the same
   setup production uses. The context ends on the receptionist asking "Which works best -- 9, 1 or 4:30?"; caller
   audio is an "ummm" of ~1.3 s, then 4 s of silence. Plus a complete-answer fixture ("Ten works") as the cost arm.
   - Arms: default; silenceDurationMs 1000; silenceDurationMs 1200; default + a prompt line ("After you ask a
     question, a lone um or uh is the caller thinking -- say nothing and wait.").
   - N = 10 umm + 5 complete per arm.
   - Instrument check: default must reply to the umm in >= 3/10, or the probe is blind -> stop and report.
   - Look for an existing filler/umm fixture in test-audio/ or scripts/probes first. If you must synthesise one,
     say so and treat the result as weaker.
   Then 3C: apply the pick. Silence -> env LIVE_VAD_SILENCE_MS on the deploy (no code). Prompt line -> static
   prompt, plus a test and a snapshot update.
4. PROOF:
   - Repoint the 11 drifted census rows.
   - Add a sabotage row for every new guard: in-turn statement holds; question required; voiced required;
     Done-only prefix; full-name spelling; carry-over set / supersede / cancel / spent; engine retry needs its own
     slot; the time comparer; Fix 3 move / add / ask; the LVX181 prompt line if added.
   - Hand-verify each row RED with a scratchpad script (String.replace, restore, run the red suites). Remember that
     `$` in a replace string expands, and never import sabotage.mjs.
   - Census clean.
5. OPUS REVIEW (one opus subagent) of 5c15583..HEAD with named risks:
   - double read-back
   - a held write lost
   - cascade or text-channel drift
   - a move applied to the wrong person or appointment
   - transcript lag ("no" arriving late)
   - letters never read back when spelling comes after the yes
   - English-only "please confirm"
   - the engine-retry veto dropping a legitimate write
   Fix every real finding red-first; re-review the fixes.
6. GATE in mintty:
   bash .superpowers/sdd/2026-10-13-round-a1-say-it-once/run-gate-p5.sh <sha> p5-final db fullsab
   launched with PowerShell Start-Process mintty, as tonight's p5-root was.
   - PASS = ROOT exit 0, CENSUS clean, DB exit 0, every sabotage row red except the 3 known baseline x
     (ask-branch-latch, ask-branch-in-turn, ask-latch-per-action), 0 "could not be READ", no dirty tree.
   - Match the phrase "could not be READ" (the row name `unreadable-after-readback` also matches "unreadable").
   - If it fails with time left, fix and re-gate. If it can't pass by ~07:00 CDT, do NOT deploy; report.
7. DEPLOY (only on PASS). Follow the voice deploy recorded in "Part 4 sitting 3 as built" and memory
   terraform-broken-deploy-route:
   - Build from the MAIN checkout with a clean tracked tree (prod-migration-checksums-crlf: never an LF worktree).
   - Image voice:<sha> + digest; run all smoke steps.
   - Migrate job --status: none pending, nothing "edited".
   - New revision at 100%.
   - Env diff vs 00105 = only GIT_COMMIT_SHA, plus LIVE_VAD_SILENCE_MS if 3C picked it
     (config-only-in-one-environment).
   - Boot logs: 0 WARNING+. /health 200.
   - Do NOT touch the dashboard service.
   Record revision, sha, digest and rollback in the plan, ledger and memory.
8. MORNING HANDOFF, so I can call immediately:
   - Put the report at the TOP of your final message.
   - Write docs: plan "Part 5 S2 + overnight as built"; backlog LVX179/180/181 status; ledger; memory
     round-a1-say-it-once + MEMORY.md. Commit (never push).
   - Final message:
     1. Status in 3 lines: deployed or not (revision, sha, rollback command), gate result, probe $ and the chosen
        setting.
     2. The 3 call scripts, exact words for me to say, numbered, owner handset -> +18175803291. Order: on-file
        first, then the new name, then the correction. Each says what I should hear, and what counts as a
        pass or a fail:
        (a) On-file booking with "uhh" pauses: one question, one yes, "Done, you're all set", and no reply to the uhh.
        (b) Booking for a new colleague with a new name I spell on request. Pick a time only when asked, with a
            real "ummm" before choosing. Expect: no reply to the umm, one full-name spelling ask, one question
            that spells both names, saved once.
        (c) Book, then right after "you're all set" say "no, 10 instead": one booking, moved, no second row.
     3. After-call check: what you'll read (readcall.sh by time window, db-inspect --appointments --names via the
        migrate job, write_consent_probe a1_readback, reply_after_last_voice_ms_p50 vs the baseline). Total cap $2.
     4. Anything parked for me.

RULES
- Long jobs (root, gate, sabotage) run in mintty via run-gate-p5.sh, never a Claude Code background shell: the
  memory reaper killed one tonight.
- Keep this session active with foreground wait loops (<= 9 min each), waiting on anchored markers
  (grep -q '^ALL-DONE').
- One vitest at a time (the gate's waitvitest also waits on yours).
- Never git checkout/restore over uncommitted work.
- Use Write'd .cjs scripts or the Edit tool for edits containing regex or backslashes, never node -e through bash
  (it turned \b into a backspace character tonight).
- Run the census after editing index.js, tools.js or strings.js.
- Paid runs beyond the $0.80 probe need my yes.
- Owner decisions are final.
- Cheaper models for mechanical work; opus for the review.
- Detail goes in the ledger, not in chat.
```

## Part 5 S2 + overnight as built (2026-10-16 22:36 → 2026-10-17 ~05:00 CDT, unattended, $0.34)

Owner overnight decisions (final): probe may run (cap $0.80); LVX181 pick by the pre-registered rule (owner 22:55:
the >= 3/10 margin applies to EVERY arm, tie -> faster); deploy iff the gate passes; short on time -> gate what's
ready. Owner 22:55 on Fix 3: unclear words -> CODE asks once (the move/keep question is the confirmation).

**Step 0.** p5-root @1e78dc1: ROOT red, 24 tests in 8 files, all encoding the old same-breath save / the action-blind
token / old wording; updated deliberately (f04bdef).

**LVX181 — not fixed (rule says change nothing).** A ($0, sonnet): the literal filter is useless (transcript chars are
misattributed: 84 of 86 hits were real words); debug-text cross-check: filler-only caller turns drew a reply on 6 of
86 calls (7%, a floor), 8 of 550 turns. Baseline `reply_after_last_voice_ms_p50` 00105 = 1,378 ms (n=3), 00104 =
1,664 (n=4). B (`scripts/probes/lvx181-umm.mjs`, gemini-3.8-live AI Studio = prod, real prompt builder, synthetic
SAPI "ummm" 1.30 s + 4 s silence, N = 10 umm + 5 complete per arm, 0 invalid): umm replies default 10/10, silence
1000 10/10, silence 1200 10/10, prompt line 9/10; complete-answer median 2215 / 2497 / 2744 / 2432 ms. No arm
qualifies -> nothing changed. $0.3393 (incl. smoke). The silence knobs moved complete replies but not the umm reply
time, so the synthetic umm may be only partly heard as speech (weaker instrument) -- either way no knob or prompt
line stops a reply. Next options are code: hold a turn end on a short wordless utterance (manual VAD / the
s2s-frontend gate + hangover).

**Fix 3 — a correction right after a save moves that booking** (1d098c8 → 72f3483 → 04211cc → 4ebc606 → 12eecce →
6da2411; four opus review rounds). Final design, `capabilities/appointments.js`:
- Applies only on Live, to a second `book_appointment` on the call that just booked, same person (the same name, or
  the surname dropped), different time.
- The QUESTION the caller answered decides, recognised by EXACT wording only: ours ("So that's moving your <old> to
  <new> …, is that right?" / "Shall I move your <old> to <new>, or keep both?") or the declaration's "Shall I move
  your 9 a.m. to 10 a.m.?". It must name the NEW slot and the OLD slot of the booking being moved.
- Move question + a plain yes -> the row is MOVED (reschedule path, capacity pre-checked, never an insert, "Done,
  you're all set."). Keep-words about the booking in the answer ("keep both", "the 9 too", "still want") or the
  model's in_addition flag -> keep both.
- Either/or -> the caller's LATEST answer ("move it" / "just the ten" / "only one" -> move; "keep both" / "no" ->
  keep both; unclear -> keep both if already asked, else the move is asked).
- Anything else -> the caller's words since the save choose the ONE question the gate hands (correction words -> the
  move read-back; unclear -> move-or-keep; "also / another" -> the ordinary read-back, extra one), handed at most once
  per slot; after it a plain yes keeps both.
- Safe direction everywhere: a second row (visible to the business) beats a silent move (loses a booking the
  caller believes they have).
- Review findings fixed: silent move on cue words; same-surname daughter; cascade asked forever; "wait" verdict on
  lag; capacity skipped; either/or read as a move; "keep both" to a move question; ordinary "…or change anything?"
  read-backs and spelled names ("M-O-S-S") misread; Mark/Mary as one person; the wrong one of two bookings moved;
  everyday asides ("one more thing") read as keep; rescheduleAppointment's undefined `log`.
- Accepted / documented: a time-only answer ("Ten, please") to move-or-keep after it was handed keeps both; "one
  works" read as a time costs one extra question; "No, keep both" is a gate objection (one extra question); the
  engine-retry veto's note text never reaches the model. A move sends NO owner notification (booking email is
  link-only, so it stays accurate). LVX176's claim check is unaffected (verified by review).

**Proof.** Census 327 rows clean. 13 drifted rows repointed (none retired), 35 new p5- rows, every one
hand-verified RED (several read GREEN on first try and got sharper test cases). `tests/lvx179Replay.test.js` 42 cases.

**Gate (`p5-final5` @ `6da2411`).** ROOT exit 0 (8,038 passed), CENSUS clean, DB exit 0 (700). The full sabotage
matrix could not run as one job before 07:00 (`liveCorpusReplay` is ~700 s per run) and the single run crashed after
row 27 on a Windows file lock ("Error: UNKNOWN … open …\lib\voice\live\index.js", tree verified clean). Finished as
shards at the same sha: the gate run (rows 0–27), `sharda` (28–176) in `../ai-phone-gate`, `shardb` (177–249) in a new
worktree `../ai-phone-shardb`, then the same per-row check (`verify-tail.mjs`: patch, assert landed, one worker,
restore + assert) for 250–326. All 327 rows got a verdict, 0 "could not be READ", trees clean. Non-red beyond the 3
baseline rows, each read in code, test-only follow-up (`f2f4c60`, `1f60bc2`):
- fixed, RED again: `in-addition-stash` (new on-file case), `voiced-flag-survives-nudge` (retargeted at the carry-
  over judge's "a sound since the question" condition, which had no test; new silence + nudge case),
  `p3-real-hold-overwrites` (assertion was stale: the earlier hold's sentence is now "…is that right?").
- retired with reasons (LVX179 made the A1 decision authoritative; the ceiling never releases a booking):
  `a1-objection-before-write-order`, `a1-objection-branch-only-for-a-yes`, `a1-objection-branch-skips-time-cue`,
  `ceiling-ignores-history` (cancel path now untested → backlog). Census 323.

**Deploy (05:09 CDT).** Build `c3f9da3a` from the main checkout (HEAD `f2f4c60`, `6da2411..HEAD` docs/tests only), all
steps; `voice:6da2411` digest `sha256:58936de0d121db12cf0ad40e74769d3ab2323b86416cfc623eebcfe8d3ae400f`. Migrate job →
`:6da2411`, `--status`: 53 applied, none pending, no "edited". Revision **`voice-uk-prod-00108-rox`** staged with no
traffic (tag `lvx179p5`), checked, then 100%. Env diff vs `00105-mw4` = only `GIT_COMMIT_SHA` 5c15583→6da2411 (44 = 44,
spec identical; no `LIVE_VAD_SILENCE_MS`, LVX181 changed nothing). Boot 0 WARNING+ (`sms_channel_off` expected). The
voice service has no `/health` route (404 on 00105 too); `GET /` 200. Dashboard untouched. Rollback:
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00105-mw4=100 --project=vetra-uk-edc8ca --region=europe-west2`.

**Next:** the owner's 3 calls (scripts in the overnight report / ledger), then Round A2 + the backlog follow-ups.

**Morning calls (owner handset -> +18175803291; Test Line on file 05:15: Nithin Dodla Mon 19 11:00, Tue 20 14:00,
Thu 22 14:00, Fri 23 14:00, Thu 29 14:00, Fri 30 14:00; Priya Raman Wed 21 10:00; Maja Okafor Wed 28 09:00 + 10:00):**
(a) on-file, "uhh" pauses: "another appointment for myself" -> Tue 20th 11 a.m. -> ONE question naming Nithin Dodla
(said, not spelled) -> "Yes" -> only "Done, you're all set." (b) new colleague "Leila Hartmann" (L-E-I-L-A,
H-A-R-T-M-A-N-N), day only (Wed 21st), a real "ummm" before picking 11 a.m. from the list -> one full-name spelling
ask, ONE question spelling both names, saved once; a reply to the umm is EXPECTED (LVX181 unfixed) but no booking on
it. (c) "another appointment for myself, Monday the 26th at 9 a.m." -> yes -> "Done, you're all set." -> "No, 10
instead." -> ONE move question -> plain "Yes" -> one row Mon 26 10:00, none at 9:00. After: readcall.sh by time
window, db-inspect --appointments --names via the migrate job, write_consent_probe a1_readback,
booking_correction_* counters, reply_after_last_voice_ms_p50 vs 1,378 ms.

## Part 5 calls (2026-10-19, owner handset → Test Line, on `00108-rox`) — verdict

| Call | CallSid | Core (LVX179) | Other |
|---|---|---|---|
| (a) on-file, "uhh" | `CAc31b31c86e0f266042665253c423cb11` | **PASS**: one question naming Nithin Dodla, "Ya" → saved once → only "Done, you're all set" | FAIL (prompt-only, LVX180): asked an on-file caller to spell; asked extra-or-move after "another". "uhh" (heard "A") drew "Could you specify…" (LVX181). After "Done", an unusable caller turn got TWO replies (model's own + the unusable-transcript note) |
| (b) new name, "ummm" | `CAd918e0c910be304966f7c8eda5ba5fcf` | **PASS**: one full-name spelling ask; day only → list; the umm (1.06 s + 0.28 s, no words) drew NO reply; one question → "Yes" → saved once | The model asked its OWN question without letters ("…for Leila Hartmann, is that right?"); the gate only requires a slot question |
| (c) correction | `CA1cfcbc4e47655e76c8d9802bb09203f3` | **PASS on outcome**: one row moved 9 → 10 (`booking_correction_after_save` moved) | Caller heard TWO move questions: the model's "Shall I move your appointment on Monday, October 26th to 10:00 AM?" named the day, not 9 AM, so namesOldSlot refused it and the gate handed ours. On-file caller asked to spell again |

DB after: Tue 20 11:00 Nithin Dodla, Wed 21 11:00 Leila Hartmann, Mon 26 10:00 Nithin Dodla (no 9:00).
`reply_after_last_voice_ms_p50` 1,863 / 2,100 / 1,986 vs 1,378 (00105, n=3) — watch, not a finding.

**Owner decisions (2026-10-19):** letters missing from the model's own question → ACCEPT the save (no extra
question). A move question that names only the DAY counts when that person has ONE booking that day. Polish round
NOW. LVX181 → leave it for now (parked; it can no longer book on an umm).

## Part 6 starting message — polish round (paste into a fresh session)

```text
Round A1 polish (Part 6). LIVE voice-uk-prod-00108-rox @ 6da2411 (rollback
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00105-mw4=100 --project=vetra-uk-edc8ca --region=europe-west2`).
Branch feat/outbound-stage4. Read: docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md "Part 5 S2 + overnight
as built" and "Part 5 calls … verdict"; ledger .superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md (P5 lines).
FIRST: reiterate in one short plain paragraph (steps, hours, $) and ask anything needed (AskUserQuestion).

Owner decisions (2026-10-19, final): a yes to the model's own question without letters SAVES (no extra question);
a move question naming only the DAY counts when that person has one booking that day; LVX181 parked.
Fix, red-first, each with a hand-verified RED sabotage row:
1. Fix 3 day-if-unique: capabilities/appointments.js namesOldSlot -- accept a question naming the old booking's DAY
   when the caller has exactly one booking that day (this call's lastBooked + callerContext upcoming). Replay call c.
2. On-file caller asked to spell (3 of 3 calls) and extra-or-move asked after "another" (call a): prompt-only rules
   the model skips. Find a code lever at the right moment -- e.g. the set_call_intent tool reply (a tool reply is
   executed at once, memory live-instruction-timing) carrying "this caller is <name> on file: never ask for or spell
   their name; 'another' = extra, no question". Prototype on the call a/c turns first.
3. Double reply after an unusable caller turn (call a): lib/voice/live/index.js auditCallerTurn sends
   UNUSABLE_TRANSCRIPT_NOTE at turn end after the model already answered -> it speaks twice. Send it only when the
   model's reply to that turn was empty (or not at all on Live) -- decide from the code + counters.
4. Optional cheap backlog items from the overnight gate: reword the early "yes that objects" branch in
   services/tools.js to the one-question form (or delete it); add a cancel case for the write-order ceiling history
   and restore the retired row ceiling-ignores-history.
Then: opus review (named risks: double question, a held write lost, cascade drift, on-file name on the wrong caller,
transcript lag); gate in mintty -- run the sabotage matrix SHARDED from the start (two worktrees at the same sha,
`sabotage.mjs --from`, see memory round-a1-say-it-once overnight block; the single run is ~9 h); ask before the ONE
deploy; 2 calls (cap $1.50): on-file booking ("another") and a correction where the model names only the day.
Conserve usage; cheaper models for mechanical work; detail in the ledger; never git checkout over uncommitted work.
```

## Part 6 as built (2026-10-19, ~16:35 → , polish round)

Owner answers at start: paid probe for Fix 2 first (cap $0.50); item 4 both parts; one session through the calls.
Later (AskUserQuestion): deploy iff the gate passes; on a number with several names on file KEEP the separate
"Is that under <most-booked>?" yes/no (not folded into the read-back). Code `b8e60b6..bcec775`, docs/ledger P6 lines.

**Fix 1 — a day-only move question counts when that person has one booking that fits it.** `namesOldSlot` also
accepts `namesOldDayOnly`: the OLD half of the move question (between "move your" and "to") names a weekday and/or
an anchored date and no clock, no relative day, no other weekday/month/date, and exactly ONE of that person's
upcoming bookings fits what it named (`bookingsFitting`: the snapshot incl. this call's bookings, the new
`fetchCallerContext.upcomingBeyond` = rows past the five listed, and lastBooked; loose same-person predicate).
"Your Monday appointment" fits every Monday; "the 26th" every month's 26th (opus review H1). A number/ordinal is a
date only beside a month, or an ORDINAL beside a weekday, never followed by "one" ("your first appointment", "the
second one", "your Monday 9 appointment" ask). Unknown = ours is asked: no snapshot, a withheld number (now never
looked up — this also closed a pre-existing leak: all withheld callers shared one caller context and last-call
summary), a failed lookup, an overflow without the beyond list. Spanish and "on the 26th" alone still get ours.

**Fix 2 — the on-file name rides `set_call_intent`'s reply** (Live, inbound, intent `book_appointment` only). Logs:
set_call_intent is the first tool and runs BLOCKING before the words that asked to spell (calls a and c). One name
→ "that is their name, never ask or spell"; several → the listed names (max 3), never spelled, "Is that under
<most-booked>?" only when unclear; "another" → an extra booking with `in_addition_to_existing` (not on a block
policy). Probe `scripts/probes/p6-onfile.mjs` (gemini-3.8-live, real prompt + tools, text caller turns, Test-Line-
shaped snapshot, pre-registered rule): asked to spell plain 5/10 → note 0/10, any name ask 6 → 0, move question
1 → 0; re-run of the reviewed note 0/10. $0.29 total.

**Fix 3 — the unusable-transcript note only to a turn the model left unanswered** (no reply text and no model audio
this turn). Fleet 10-05..10-19: 2 notes, both after a reply, both doubled.

**Item 4.** The early "yes that objects" branch hands the one-question form; a cancel case for the write-order
ceiling history restores `ceiling-ignores-history`.

**Review.** Opus review + 2 re-reviews (H1 regression, then stray ordinals as dates, then withheld/failed lookups):
all fixed with red-first tests and hand-verified sabotage rows. Accepted: the note repeats on a second booking
intent; Spanish never gets the day-only form; a reply that guessed at garble no longer gets the "do not guess" note
(writes still refused); a stale audio marker on a turn with no turnComplete.

**Tooling.** `sabotage.mjs --to <row>`; `.superpowers/sdd/2026-10-13-round-a1-say-it-once/run-shard-p6.sh <sha>
<label> A|B <args>` (A: root+census+db inline, then `--to`; B: `--from` in `../ai-phone-shardb`). Census 347.
A verify run in a Claude shell was killed by the memory reaper mid-row and LEFT A FILE SABOTAGED — restored from
the row's find; run verifiers in the foreground or in mintty.

**Gate `p6-final` @ `bcec775`.** ROOT exit 0 (8,080 passed), CENSUS 347 clean, DB exit 0 (700); sabotage shards A
(0–107) and B (108–346) — verdict below. Build `d583596e` SUCCESS (all 5 steps), `voice:bcec775` digest
`sha256:af306b221579af7bcc27e6460055f7e21717aebe4da115562d81c2e224c006c6`.

**Gate verdict: PASS.** Shard A 108 rows (only the 3 baseline x: ask-branch-latch, ask-branch-in-turn,
ask-latch-per-action), shard B 239 rows all red; 347/347 verdicts, 0 "could not be READ", both trees clean.

**Deploy (20:42 CDT).** Migrate job → `:bcec775`, `scripts/migrate.js --status` (the job's command is `node`; a bare
`--status` arg exits 9): 53 applied, none pending. **LIVE `voice-uk-prod-00110-vah`** @ `bcec775` (staged with no
traffic, tag `p6polish`: env diff vs 00108 only GIT_COMMIT_SHA, spec identical, Ready, GET / 200, 0 WARNING+; then
100%). Rollback:
`gcloud run services update-traffic voice-uk-prod --to-revisions=voice-uk-prod-00108-rox=100 --project=vetra-uk-edc8ca --region=europe-west2`.

**Calls (owner handset → +18175803291), cap $1.50.** (a) on-file "another": "Hi, I'd like to book another
appointment for myself." → expect "Is that under Nithin Dodla?" → "Yes." → "Thursday the 22nd at 11 a.m." → ONE
question naming Nithin Dodla, not spelled, no extra-or-move question → "Yes." → only "Done, you're all set." (b)
correction, day only: "I'd like to book another appointment for myself, Wednesday the 28th at 11 a.m." → (Is that
under Nithin Dodla? → Yes) → one question → "Yes." → Done → "No, actually make it 2 p.m. instead." → ONE move
question → "Yes." → Done; one row Wed 28 14:00, none at 11:00.

## Part 6 calls (2026-10-19, owner handset → Test Line, on `00110-vah`) — verdict

| Call | CallSid | Part 6 | Other |
|---|---|---|---|
| (a) on-file "another" | `CAa3e6c3f99cbcad238ed09e2e7a14c8a0` | **PASS**: "Is that booking under Nithin Dodla?" → no spelling, no extra-or-move question → ONE question naming him → "Ja" → saved once (in_addition) → only "Done, you're all set" | goodbye on a garbled "n?o aceita", no double reply |
| (b) correction | `CAe6827ddc3f8dc82536d0da70fa9fce43` | **PASS on Fix 1**: the model's own day-only "Shall I move your appointment on Wednesday, October 28th to 2 p m?" → "Ja" → moved, ONE move question; owner's further 3/4/1 p.m. changes each one question, one row | **FAIL (LVX182, new)**: final "go back to 2 p.m." → "Ja" ignored, then "Done, you're all set" with no tool call; row stays at 1 p.m. Claim guard detected only; post-call verify said ok |

DB after: Thu 22 11:00 Nithin Dodla (call a), Wed 28 13:00 Nithin Dodla (call b; the caller was told 2 p.m.).

## LVX183 (2026-10-20) — hung up after the caller came back from the silence goodbye

Owner on Digile US +18176011171 (`CAd51783477c…`): the goodbye rung set `exitAfterTurn`; the caller spoke over it (arm
refused on the barge) but the latch stayed set and hung up at the end of the NEXT reply, which asked a question.
Fix `4708fc9` + review `4ae6f1d`: `silenceOwnsExit`; a caller transcript with words (not a short echo) clears a
silence-owned latch AND restarts the ladder; the call clock's goodbye still ends the call (a skipped clock goodbye takes
ownership). Rows lvx183-silence-latch-cleared, lvx183-ladder-restarts, lvx183-words-only (census 350). Gate `lvx183`
@ `4ae6f1d` PASS (ROOT 8,085, DB 700, A 108 + B 242, only the 3 baseline x). **LIVE `voice-uk-prod-00112-boh`**
(rollback `00110-vah`). Verification call: on 1171, stay quiet until the goodbye, talk over it, ask a question — the
line must stay open and the silence nudges must work again later.
