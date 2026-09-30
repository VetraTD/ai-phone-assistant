# Outbound STAGE 4 (lean) — unattended overnight run

## Context
Stage 3 is deployed (prod `voice-uk-prod-00095-nhs` @e451d91, `OUTBOUND_ENABLED=false`). Before
outbound can be switched on for Ilija's pilot, five must-holds remain (spec §12.3 + owner decisions
2026-09-29): callback recognition, the mid-clip opt-out rule, three small must-fixes, an EU
calling-hours floor, and a minimal outbound-aware call log. Requirements source:
`.superpowers/sdd/2026-09-27-outbound-stage3/next-session-prompt-stage3-stage4.md` (tasks, Read-first,
How to run, Rules) + the owner's overrides/pre-answers in this session's prompt (those win).
Method: superpowers:subagent-driven-development. Sonnet implementers + reviewers; opus for the S4-2
review loop and the one final review. No deploy, push, prod write or real call. Paid: only the S4-2 sim.

Owner answers (2026-09-29 planning): callback answers → call log only (no webhook delivery for
callbacks this stage); S4-3 switches the inbound tool webhook fully to fetchVetted (redirecting tenant
URLs = pre-deploy check in the report); held lead = outreach CLOSED `held_for_review` + alert email,
operator re-adds by hand (no release command); if still running at 08:05 CDT, keep going in the main
checkout (commit often so the phone-check session sees a clean tracked tree; never hold the harness
server on :3000 then).

Wall-time estimate: ~6.5–7.5 h (tasks ~5 h incl. EU research, final review + fix wave ~1 h, full
corpus:sabotage ~1 h overlapping). Start ~22:00 CDT → done ~04:30–05:30 CDT.

## Efficiency (usage + time, no quality cut)
- ~20 agent dispatches total: 1 research, 5 implementers, 5 task reviews, expected 3–5 fix/re-review
  rounds, 1 final review, 1 fix wave (final-review findings + all FIX minors together), 1 re-review, 1
  docs. Sonnet everywhere except the S4-2 review loop + the final review (opus, where sonnet has missed
  real timing bugs before).
- Wall time saved without token cost: EU/NANPA research runs in parallel with S4-1/S4-2; each gate
  (a script, no tokens) overlaps the next implementer; reviews overlap gates; full corpus:sabotage
  (script) overlaps the final review.
- Gate only what a task touches: S4-4 (dashboard-only) runs dash + its DB test, not the 12-min root
  suite; DB gate only for S4-1/S4-2/S4-3. The final gate still runs everything once.
- Cheap handoffs: briefs/reports/review packages as files, source-only diffs, implementer replies ≤15
  lines, controller never re-reads big files. One S4-3 dispatch for three items. Minors fixed once,
  batched with the final fix wave (not per task).
- Paid: one sim run (max 2, ≤$0.10). No live Playwright UI session for S4-4 (component tests + build
  instead; login + Norton make it slow).
- Kept on purpose (quality): per-task review with named risks, sabotage per task, per-task gate, re-review
  after every fix, full corpus:sabotage, opus final review.

## Setup (controller, ~10 min)
1. `git switch -c feat/outbound-stage4` in the main checkout (from feat/outbound-stage3 @77ce358).
   No other checkout/switch/restore/stash in the main checkout. Never touch database/002–012 bytes.
2. Commit this plan as `docs/superpowers/plans/2026-09-29-outbound-stage4.md` (explicit path) →
   SDD workspace `.superpowers/sdd/2026-09-29-outbound-stage4/` (ledger `progress.md`, briefs,
   reports, review packages, gate logs, `MORNING-REPORT.md`).
3. Copy `C:/Users/nithi/.claude/jobs/8770908f/tmp/norton-roots.pem` (exists, checked) → workspace.
   `gate.sh` = stage-3 copy retargeted: gate worktree `C:/Users/nithi/VetraTD/ai-phone-gate` (clean,
   detached e451d91; moved with `checkout --detach <sha>` there only), NODE_EXTRA_CA_CERTS → workspace
   pem, logs → workspace, serialized-vitest wait, census, optional `db`, plus new `dash` mode (dashboard
   backend + frontend `npm test` + frontend `npm run build`; junctions for their node_modules in the
   gate worktree, created once, never followed by a worktree remove).
4. Stage-4 `common.md` + `session-rules.md` = stage-3 copies updated: branch, trailer
   `Claude-Session: https://claude.ai/code/session_01FzJXgVvUM9vvxphmL7QE4q`, migrations 051+ (LF,
   idempotent, folded into schema.sql), CRLF 002–012 rule, "tomorrow's phone-check session shares this
   checkout".
5. Pre-flight conflict table (skill requirement) into the ledger; baseline = stage-3 final gate (root
   6114 passed/5 skipped, test:db 579, census 63, snapshots 0).

## Pipeline
- Parallel from the start: ONE research agent (sonnet, WebSearch/WebFetch, writes only
  `eu-floor-research.md` + `nanpa-check.md` in the workspace): EU hours/weekend/holiday/B2C-consent/DNC
  table for IE DE FR ES IT NL BE PT (+ scan of the other 19 for anything stricter than the draft
  default), each row sourced; and US_MAINLAND_NANP vs nationalnanpa.com. Feeds S4-3 + S4-5 briefs.
- Implementers strictly one at a time in the main tree. Gate for task N (gate worktree) runs while
  task N+1's implementer works; reviews run in parallel with gates. Vitest serialized (gate.sh waits).
- Per task: brief → implementer (TDD RED→GREEN, sabotage protocol, commits by explicit path) →
  task review with NAMED RISKS (memory plan-verbatim-code-fails-open) → Critical/Important fix rounds
  + scoped re-review → minors to ledger → gate (root+census; +db/+dash when touched; S4-4: dash + its
  DB test only).

## Tasks

### Task 1 — S4-1 Callback recognition (MUST-HOLD)
Build (spec §12.3, §6.3 C2):
- `services/db.js` `openOutreachForPhone(phoneE164)` (tenant-scoped ordinary query via
  `requireTenantScope`; PHI_ACCESS + `noteAccess`): most recent outreach with `state='waiting'`,
  `last_attempt_at` within 14 days, number NOT suppressed (reuse the suppression check incl. hash for
  erased rows) and not erased; returns outreach id, campaign topic + pinned `config.questions`,
  `last_attempt_at`, and answered keys = union of `calls.answers` keys (non-`_`) over calls with that
  `outreach_id`. `closeOutreachCalledBack(id)` wraps `closeOutreach(id,'called_back',…)`.
- Live `onStart` (`lib/voice/live/index.js:~6646` Promise.allSettled) + cascade start
  (`lib/voice/session.js:~3907`) via one shared helper: inbound only; lookup failure/timeout → no
  recognition, warn log, prompt unchanged. On a hit: `extras.callbackOutreach` → tail line inside the
  dynamic tail (`services/gemini.js buildDynamicTail`, next to the existing CALLER CONTEXT section):
  "We called this person on {date in business tz} about {topic}. Questions still unanswered: {…}."
  (sentence omitted when none remain); `record_answer` declared with only the remaining keys
  (`capabilities/qualification.js` + the execution gate `services/tools.js:~893` accept the callback
  context); `createCall` link `outreachId` (+contactId) so `calls.outreach_id` is set; close
  `called_back`; log `outbound_callback_recognized`.
- Planned ruling: close `called_back` at recognition (call start), not at call end — spec's "unless a
  schedule_callback was made" cannot occur on inbound (schedule_callback isn't declared there) and an
  early close stops a +10 min retry dialling the lead mid-callback. Booking gate stays inbound-normal.
- No-outreach caller: prompt + declarations byte-identical (all existing `tests/__snapshots__/prompts`
  unchanged); new callback snapshots go in a new `prompts/callback/` dir.
Tests: both ends real (tests/db: real outreach row → real lookup → real start path/prompt builder);
tenant-scoped (other tenant's outreach invisible); suppressed + erased not recognised; 14-day bound
(13d yes / 15d no) with sabotage; mid-dial states not recognised; record_answer on inbound writes
`calls.answers`. Census after index.js/tools.js edits.
Named risks for review: inbound byte-identity; extra DB round-trip on every inbound start must not
delay the greeting (parallel, bounded); cross-tenant leak; PHI in logs; `?.` hiding a missing wire;
retry dialling the lead during their callback.

### Task 2 — S4-2 Mid-clip opt-out + hang-up (opus review loop)
- `lib/voice/live/index.js`: at `beginClipHoldDrain` keep a copy of the held mu-law 8 kHz frames
  (outbound only, only when voiced frames > 0). In `endClipHoldDrain`, if `!clipDrainTranscribed`:
  (a) transcribe the copy with Deepgram via a new injectable one-shot helper in `lib/voice/sttDeepgram.js`
  (prerecorded `listen.v1.media.transcribeFile`, nova-3, mulaw/8000, `mip_opt_out`, EU base URL via
  `deepgramEnvironment()`, `assertVendorAllowed("deepgram")`, bounded timeout); non-empty text →
  persisted as the caller transcript row so post-call's D9 detector runs on it unchanged; log
  `outbound_clip_hold_stt` {ok, chars, ms} (no transcript text in logs).
  (b) Deepgram error/timeout/unavailable/hipaa-refused/empty text → mark the attempt
  (`calls.answers._optout_unverified`) → post-call: outcome `held_for_review`, outreach CLOSED with new
  close_reason `held_for_review` (migration `051`, 047/048 drop/add CHECK pattern, folded into
  schema.sql), `log.error("outbound_optout_unverified_hold")` (alertable), no reschedule. Fail closed by
  throwing where a fact is missing.
- Harness verdict `hold_drained` (`lib/probe/outboundHarness.js:~1433`) accepts the STT-fallback
  transcription; `tests/outboundHarnessVerdict.test.js` updated.
Tests: RED-first with REAL held frames (a real mu-law "stop calling me" fixture from the repo's
harness audio) through the real drain → stubbed Deepgram returning text → post-call writes
suppression + `opted_out`; Deepgram failure → `held_for_review` + ERROR event + no next_attempt_at;
sabotage both branches; migration loop + fold proof.
Paid sim (pre-approved): after gate green, ONE run of `outbound_stop_midclip_hangup` against the local
harness server (real Gemini + real Deepgram keys from .env), probe `P1-SIM-S4`, reserveP1 0.05 →
commit via spendLive; at most 2 runs, ≤ $0.10 total (Deepgram ≈$0.0005/run, noted outside the ledger).
Instrument failure → replay verdict from saved logs (free), not a paid re-run. Harness server stopped
after; port 3000 checked.
Named risks (opus): teardown ordering / post-call waiting on the STT promise; double-drain; frames
from the provisional/delay lines; retry still armed; alert event name matches `jsonPayload.event`.

### Task 3 — S4-3 Small must-fixes (one sonnet dispatch)
- `integrations/webhook.js` → `lib/net/ssrfGuard.js fetchVetted` (redirects refused, pinned IP,
  timeout covers the body); add a `maxBodyBytes` option + `truncated` flag to fetchVetted (outbox
  default unchanged) so an oversize tool response is an explicit error, not a truncated parse; BAA gate
  stays before DNS; injectable fetch impl so `tests/integrations.test.js` + `tests/webhookBaaGate.test.js`
  still intercept; model-facing messages/timeout mapping unchanged; golden snapshots unchanged.
- `exportCallerData` (`services/db.js:~1888`) adds calls link columns + `answers`, contacts, consents,
  outreach, call_attempts (no audio), suppressions, outbox — mirroring `eraseCallerData`'s coverage;
  schema-walking drift test like `tests/db/outboundErasure.test.js:519`.
- NANPA: apply the research agent's result to `US_MAINLAND_NANP` only where verified; unreachable →
  unchanged + owner list.

### Task 4 — S4-5 EU calling-hours floor
- `lib/outbound/legalFloor.js`: row shape → per-day list of ranges (lunch gap) + national-holiday set +
  zones. One STRICT default for all 27 member states, sized to the strictest researched rule (draft:
  Mon–Fri 10:00–13:00 & 14:00–20:00 local — France's B2C décret; no weekends; no national public
  holidays; tightened further if research finds stricter). Longest-prefix country-code table (27 EU
  codes; +350/+354/+376/+377/+378/+379/+423 etc. refused; FR/ES/PT/NL overseas codes refused; Italian-
  numbered Vatican/San Marino ranges refused); multi-zone ES (Canary) / PT (Azores, Madeira): window must
  hold in every zone unless a contact tz inside the country is given. GB/US rows unchanged.
- `nextLegalOpening` / `collectStartBoundaries` handle several starts per day + holidays (search bound
  raised if Easter/Christmas runs need it); `<20 ms` perf test holds; callback validation inherits.
- Holidays: generated JSON `lib/outbound/euHolidays.json` (national "public" holidays, 2026–2030) from
  `date-holidays@3.37.0` (maintained, updated 2026-09-20, ISC + CC-BY-3.0 data) via a committed
  generator script run from a scratch install (no package.json/lockfile change, no prod dependency).
  Year not covered → refuse + `log.error("outbound_holiday_table_stale")`.
- Research table + "differs from strict default — NOT applied, needs owner/counsel sign-off" list in
  `docs/outbound-eu-calling-floor.md`.
Tests: each of 27 countries refused outside / allowed inside; lunch gap refused; weekend + a national
holiday refused; multi-zone; prefix collisions; unknown non-EU still `no_legal_floor`; stale year
refused; sabotage.

### Task 5 — S4-4 Minimal call log
- Backend `AI-phone-dashboard/backend/src/routes/calls.js`: `direction` filter (allow-list
  inbound|outbound; tenant-scoped via existing `withTenantHandler`; read-only).
- Frontend `frontend/src/App.jsx` (existing filter pattern + `LanguageSwitcher.jsx` en/es/fr labels):
  direction select; direction + outcome pill on call cards; details panel shows `outcome_code` and
  answers (question keys only; `_outcome_note` as a note) via a small extracted component; CSV gains
  direction + outcome columns.
Tests: backend route test (harness) for the filter + bad value; `tests/db/dashboardTenantScoping`
direction case on real PG; frontend component test; `npm run build` + lint.

## End of session
1. Final gate on the final head: root suite (gate worktree), `test:db`, census 63/63, inbound snapshots
   0 changed, dashboard tests + build, full `corpus:sabotage` (index.js/tools.js will change) → expect
   exactly the 3 baseline x rows.
2. Opus final review of the whole stage-4 diff (source-only package) with the ledger's minor/parked
   list → ONE sonnet fix wave (Critical/Important + minors marked FIX) → one scoped re-review →
   re-gate the fix head.
3. Docs: go-live Section D draft (stage-4 deploy, YES-gated: build from MAIN checkout, migration 051,
   add `outbound_optout_unverified_hold` + `outbound_holiday_table_stale` to the alert policy filter,
   dashboard backend/frontend deploy); spec §19 stage-4 decisions. Commit by explicit path.
4. Memory `outbound-calling-plan`: re-read first, then add a stage-4 block only (keep the phone-check
   session's additions).
5. `MORNING-REPORT.md` in the workspace (per task done/parked + what a caller/Ilija notices; gate
   numbers; rulings; deferred minors; owner sign-off list: EU values, NANPA, B2B exemption, regional
   holidays; spend; next step = YES-gated stage-4 deploy from the MAIN checkout after the phone check)
   + a 10-line version in the final message.
6. Leave: main checkout on feat/outbound-stage4, tracked tree clean, no vitest/harness server running,
   port 3000 free, gate worktree clean. No push. Workspace kept (holds the report).

## Hard-stop handling
Only: irreversible/destructive op, security-sensitive action, prod write/deploy/push/real call/paid
spend beyond the S4-2 sim, or a spec where every path is a guess → park that task with the reason in
the ledger, continue the others. Everything else: `Ruling: <what> — <why> — <cost if wrong>`.

## Verification
Per-task: implementer RED/GREEN + sabotage evidence; reviewer verdicts; gate logs. Final: numbers above
vs baseline (root ≥ 6114 passed, only 5 known skips; test:db ≥ 579 all pass; census 63/63;
`git status --porcelain tests/__snapshots__/prompts` empty; corpus 60 v + 3 baseline x; dashboard
tests/build green); S4-2 sim verdict + spend from `spendLive totalFor`.
