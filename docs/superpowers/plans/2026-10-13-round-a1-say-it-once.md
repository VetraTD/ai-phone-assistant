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
| S2 | T4 prompts, T5 closing, T6 measure, T8 rows, T9 full gate + ONE sabotage + opus review | next — starting message at the bottom |
| Part 2 | one deploy + 3 live calls | after S2 |

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
`save-confirmations-counted`. Anchors end before any `$\``; census clean.

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
| Session 2 | T4 + T5 + T6 + T8 → commit, full gate + ONE full sabotage + opus review + as-built | ~2.4 h | ~2 h |
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
- A previous-turn read-back of this slot with NO caller turn since saves a booking (owner Q1: nothing heard = save).
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

> Run receptionist round A1 "say it once" — session S2 of part 1 (T4 prompts, T5 closing, T6 measure, T8 sabotage
> rows, T9 full gate + ONE full sabotage + opus review). Plan: `docs/superpowers/plans/2026-10-13-round-a1-say-it-once.md`
> — read "S1 as built" first; ledger `.superpowers/sdd/2026-10-13-round-a1-say-it-once/progress.md` (resume after
> Task 3). Branch `feat/outbound-stage4`, code head `a7d2d99`. Execution: native (superpowers:executing-plans), one
> opus whole-branch review during the full sabotage. Owner decisions in the plan are final. Also during the sabotage
> wait: the free 10-03→10-13 log read (refusals per save on post-batch-2 code) with `CLOUDSDK_CONFIG=~/.gcloud-vetra2`.
> Rules: no paid runs; never git checkout over uncommitted work in the main tree; one full sabotage at the final sha in
> `ai-phone-gate` (copy gate-v3 → gate-v4 with a `fullsab` mode), waited on in the foreground; stop and ask at 3 h.
> End with the plan's "S2 as built" and the part-2 starting message.
