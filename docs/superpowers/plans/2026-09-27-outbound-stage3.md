# Outbound Calling, Stage 3: Implementation Plan (supersedes Tasks 24–31 of the Part 1 plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outbound calls sound like a person who placed the call, not an inbound receptionist. Stage 3 fixes round 1's defects (D1–D10, T1), adds the situation tools (opt-out, outcome, callback), the goal-driven campaign fields, a per-country calling-hours floor, and the shared Connections plumbing (leads in, results out, booking).

**Architecture:** Same Live engine as inbound. Outbound gets its OWN conversation layer:
- `lib/outbound/prompt.js` owns every outbound word;
- `lib/outbound/policy.js` turns inbound-only guards off on outbound;
- the platform tool packs (`outcome`, `callback`, `opt_out`) are always on for outbound.

The first seconds become recording-first: the stored opener clip always plays first and Live continues from a clean turn. Results-out is one direction-neutral channel under `lib/connections/`; stage 3 wires only outbound to it. **Inbound is byte-identical throughout.**

**Tech Stack:** Node 20 ESM, Express 5, Gemini Live (`gemini-3.8-live`), Twilio, Postgres 16 (RLS, `vetra_app` NOBYPASSRLS), vitest (root + DB configs), Cloud Run / Cloud Tasks / Scheduler (europe-west2).

**Spec:**
- `docs/superpowers/specs/2026-09-24-outbound-calling-design.md`, plus its §19 (the 2026-09-27 amendments, which point here).
- Round 1 evidence: `docs/superpowers/plans/2026-09-24-outbound-part1-live-round-1.md`.
- The Part 1 plan (`docs/superpowers/plans/2026-09-24-outbound-part1.md`) keeps stages 1–2 and its correction table (C1–C17). Its stage 3/4 sections are superseded by this file.

**Why no verbatim code here:** memory *plan-verbatim-code-fails-open*. Approved plan code once shipped a fail-open gate. Each task therefore gives the contract, the exact test cases with expected values, and a sabotage that must go RED. The implementer writes the code test-first.

## Global Constraints
Every task implicitly includes these. The full lists are in `.superpowers/sdd/2026-09-24-outbound-part1/session-rules.md` and `plan-s0.1-global-constraints.md`; read both.
- **Branch** `feat/outbound-stage3`, created from `b797487`. No push, no deploy, no real calls, and no paid API call without the owner's YES. The controller asks; implementers never do.
- **Inbound must not change:** `git status --porcelain tests/__snapshots__/prompts` must be empty after every task. Every outbound-only branch keys on `ctx.outboundCall` / `extras.outboundCall` / `state.outboundCall`, the existing flags.
- **Git hygiene:**
  - Never `git checkout`/`restore`/`stash`/`clean` over uncommitted work.
  - Stage by explicit path. Never stage `.impeccable/`, `docs/VetraTD-Pricing-Model.xlsx` or `.superpowers/`.
  - Commits end with the two trailer lines in session-rules.
- **Editing:** use Edit/Write, never Python writes (CRLF), and never heredocs for code with backslashes.
- **Every new counter** is registered in `lib/voice/metrics.js`, because `bumpCounter` drops unknown names silently.
- **Migrations:**
  - New files are `046`, `047`, `048`, one per owning task. Each is folded into `database/schema.sql` and must be idempotent.
  - Follow the migration loop in session-rules (`db:reset` applies only `schema.sql`; `db:migrate` applies new files).
  - FK fold rule and definer tests: re-own the function to a NOBYPASSRLS role.
- **Tests:**
  - Root: `unset DATABASE_URL; npx vitest run <files>`, then the full root suite before commit.
  - DB: `DATABASE_URL=postgresql://vetra:vetra_local_dev@localhost:55432/vetra npx vitest run --config vitest.db.config.js <file>`. Without that variable, 31 of 34 files skip silently.
  - Serialize vitest runs (memory limits).
- **Sabotage protocol** (session-rules): apply, `grep -c SABOTAGE`, go RED for the named reason, revert, `grep` returns 0, go GREEN. Record it in the report and in the commit body.
- **Parked:** bugs outside the task go in the report. They are not fixed.
- **Model and review policy (owner, memory *owner-wants-speed-and-low-usage*):**
  - Implementers and reviewers use sonnet. Opus is used only for the final review.
  - Per task: the task's own tests + the full root suite + `corpus:sabotage --census`.
  - One full `corpus:sabotage` at the final checkpoint.
  - Critical/Important findings are fixed per task; Minors go in one batch at the end.

## Owner decisions, 2026-09-27 (this plan implements them)
| id | Decision |
|---|---|
| **S3-D1** | Outbound gets its own conversation layer on the shared engine, and the inbound prompt is not patched. Situations are handled invisibly by the platform. Must-never-break rules live in code; manners are example lines. **1a, gatekeeper:** "It's Ava from {business}, returning {first_name}'s enquiry." No topic, no details. Ask them to fetch the person, or ask when is a good time and book that as the callback. **1b, possible child/household member:** one availability question only ("Is he around, or is there a better time to catch him?"). Never personal data, never the topic |
| **S3-D2** | **Recording first.** The opener clip plays at the END of the person's hello, or after the silence timer, whichever comes first. Live never speaks first. Live's stale reply is discarded, and Live continues from what the person says next. Live's would-be reply time is logged on every call (shadow). If it proves reliably under ~1 s, switch to "Live answers the hello, clip as backup" via a setting (`OUTBOUND_FIRST_SPEAKER=live`). **2a:** render the opener BEFORE dialling (D10). **2b:** the `opt_out` tool fixes the outcome (D9) |
| **S3-D3** | ONE Connections system. The results channel (signed webhook, outbox, SSRF guard) is direction-neutral. Calendar booking reuses inbound's scheduling adapters. Stage 3 wires outbound only; inbound results-to-CRM comes later as an opt-in. The leads-in link is outbound-only |
| **S3-D4** | Goal-driven campaign form. Stage 3 builds the backend fields (goal enum, per-person details, language, caller ID defaulting to the business number, why-allowed) plus the `custom` template; stage 4 builds the screens |
| **S3-D5** | Calling-hours floor per country, in code. Any country without a row is refused. Counsel confirms the values |
| **S3-D6** | A UK caller ID for UK leads (Ilija setup session, not code) |
| **S3-D7** | Keep the 14 R1 test campaigns paused until round 2 ends, then delete them with a script |

**Proposed in this plan, pending the owner's OK (see the session summary):**
- **(P-a) Silence timer 1.75 s, not 1.5 s.** Round-1 hellos started at 1.54 s and 1.68 s. At 1.5 s the clip would start on top of 2 of 3 hellos. At 1.75 s the clip still plays by about 1.85 s (measured playout lag 89–111 ms), under the 2.0 s limit.
- **(P-b) US floor v1 is one conservative envelope for every US number:** 08:00–20:00 Monday–Saturday and 12:00–20:00 Sunday on the contact's clock. It covers the strict states (FL/OK 8–20, TX Sunday noon) without an area-code→state table. A US contact with no timezone must be inside the window in BOTH America/New_York and America/Los_Angeles. UK: 08:00–21:00 every day. Everything else is refused. A per-state table comes later, once counsel confirms it.
- **(P-c) C3: the webhook secret** is stored AES-256-GCM in-app, with a 32-byte key from a new Secret Manager secret `connections-webhook-key` (`CONNECTIONS_WEBHOOK_KEY`).
- **(P-d) Missed-call SMS moves to the Ilija setup session.** There is no UK sender yet and no US A2P registration, so it could not run anyway.

## Session shape (one long session; the owner agreed to an overnight run)
| Part | Tasks | Est. |
|---|---|---|
| Half 1: how the call sounds | S3-0 … S3-5 | ~6.5 h |
| Checkpoint A (suites, review, census) | | ~0.75 h |
| Half 2: plumbing (2 parallel worktree lanes, serialized test gates) | S3-6 … S3-11 | ~5 h |
| Final checkpoint (full sabotage, opus review, Minors, docs) | | ~1.25 h |
| **Phone check** (after the deploy YES, inside 08:00–21:00 CDT, 3 calls, ~15 min) | | 0.25 h |

Half 2 does not depend on the first-seconds code, so the phone check runs after one deploy of the whole stage. It may run between the halves if the calling window allows. **Test round 2 is a separate short daytime session.**

## File map
| File | Responsibility | Task |
|---|---|---|
| `lib/outbound/policy.js` (new) | Which inbound-only guards/nudges are skipped on outbound | S3-1 |
| `lib/outbound/prompt.js` | All outbound wording: identity, SITUATIONS, closing, third-party rule, goal line | S3-1, S3-6 |
| `lib/outbound/detectors.js` | + live per-turn detectors (contact-number ask, inbound closing phrase, topic to an unverified party) | S3-1 |
| `lib/outbound/firstSeconds.js` | Recording-first controller, hello-end trigger, clip barge threshold, shadow timing | S3-2 |
| `lib/voice/live/index.js` | Wiring only: stale-audio discard, policy checks, detector calls | S3-1, S3-2 |
| `lib/outbound/dispatch.js` | Render the opener before `calls.create` (D10); render the transfer-miss clip | S3-2, S3-4 |
| `capabilities/outcome.js`, `callback.js`, `optOut.js` (new) | Platform packs, always on for outbound | S3-3 |
| `lib/outbound/postCall.js` | Detectors before the outcome (D9); callback time; wrong-number suppression; `transferred` | S3-3, S3-4 |
| `lib/outbound/doorRoutes.js`, `mediaUrl.js` | Transfer-miss `<Play>` (D6); `transferred` outcome | S3-4 |
| `database/046_outbound_transfer_miss.sql` | `call_attempts.transfer_miss_audio` | S3-4 |
| `scripts/live-call-harness.js`, `lib/probe/outboundHarness.js` | Outbound scripted situations | S3-5 |
| `lib/outbound/campaignSchema.js`, `templates.js` | Goal enum, details, language, caller-ID default, why-allowed, `custom` | S3-6 |
| `lib/outbound/legalFloor.js` (new), `gate.js`, `schedule.js` | Per-country floor | S3-7 |
| `lib/connections/{secretBox,signer,outbox}.js`, `lib/net/ssrfGuard.js` (new) | Shared results channel | S3-8 |
| `lib/outbound/triggerRoute.js` (new), `database/047_outbound_triggers.sql` | Leads-in link, per-person details | S3-9 |
| `capabilities/qualification.js` (new) | `record_answer` + one-refusal booking gate | S3-10 |
| `services/db.js` `eraseCallerData`, `database/048_outbound_erasure.sql`, `server.js:178` | P5, urlencoded fix, stuck-dialing alert | S3-11 |

---

# HALF 1: how the call sounds

### Task S3-0: refresh (controller, 15 min)
- [ ] `git log --oneline -1` shows the stage-3 branch at `b797487` or later.
- [ ] Record the baselines in `.superpowers/sdd/2026-09-27-outbound-stage3/progress.md` (a new ledger): the root suite counts, the DB suite counts, and `git status --porcelain tests/__snapshots__/prompts` (empty).
- [ ] Copy `session-rules.md` into the new ledger folder, updating the branch and base lines.

### Task S3-1: the outbound conversation layer (D3, D5, D7, D8; S3-D1) — ~1.5 h

**Files:**
- Create: `lib/outbound/policy.js`
- Modify:
  - `lib/outbound/prompt.js` (`outboundCallBlock`, `:58-216`);
  - `services/gemini.js`:
    - `buildStepGuidance` `gather_details`/`confirm` fallbacks `:2139-2166`, gated on outbound;
    - the confirm_identity gatekeeper description `:690-711`, which must agree with S3-D1a;
  - `lib/voice/live/tools.js` (the LVX132 ask-gate on `end_call`, the `no_ask` refusal);
  - `lib/voice/live/index.js` (the spelling nudge `:2073-2119`; the per-assistant-turn detector call);
  - `lib/outbound/detectors.js`;
  - `lib/voice/metrics.js`.
- Test: `tests/outboundPolicy.test.js` (new), `tests/outboundPrompt.test.js`, `tests/outboundPromptSnapshot.test.js` (the outbound snapshot is intentionally updated), `tests/outboundDetectors.test.js`, plus the existing liveBoot-style tests for the gate and the nudge.

**Interfaces:**
- Produces: `skipOnOutbound(name: "askBeforeHangup"|"spellingNudge"|"gatherDetailsFallback", isOutbound: boolean): boolean`. It returns true only when `isOutbound` is true and the name is in the frozen `INBOUND_ONLY` set. An unknown name throws, so a typo cannot silently fail open.
- Produces: `detectOutboundTurn({assistantText, partyVerified, topic}) → {askedContactNumber: bool, inboundClosing: bool, topicToUnverified: bool}`.
  - `askedContactNumber` = `/\b(best|contact|phone|callback|call-back)\s+(phone\s+)?number\b/i`.
  - `inboundClosing` = `/anything else (?:that )?(?:I|we) can (?:help|assist)/i`.
  - `topicToUnverified` = `!partyVerified && topic && foldCase(assistantText).includes(foldCase(topic))`.
- Counters: `outbound_asked_contact_number`, `outbound_inbound_closing_phrase`, `outbound_topic_to_unverified`, each with a `log.info` line carrying callSid and step.

**Contract:**
1. **The OUTBOUND CALL block gets a SITUATIONS section.** One line per situation: who is on the line → the move → one example line. The situations are:
   - the person themselves;
   - a gatekeeper (S3-D1a);
   - a household member or possible child (S3-D1b);
   - a wrong number;
   - "stop calling";
   - "are you a robot?";
   - a bad time or driving (ask for a time, then book the callback);
   - "email me instead" (say someone from {business} will email, record the outcome `other` with the note "email requested", and end kindly);
   - "is this a sales call?" (state the honest reason: they enquired, and this is a follow-up);
   - "already booked / already a customer" (apologise, record `other`, and end);
   - hostile (apologise once, offer to stop calling, end);
   - a bad line or an unusable reply (ask once to repeat, then offer a callback);
   - call screening (name + reason once, then wait).

   Tool names appear ONLY when that tool is declared on the call (spec §9.5 D-c: never name a tool the model was not given). The platform packs from S3-3 are always declared on outbound, so S3-3 adds their names. This task writes the behaviour in plain English.
2. **Outbound closing rule:** "To end the call: confirm the next step in one sentence, thank them by name, say goodbye, then end the call. You placed this call, so never ask whether there is anything else you can help with." (D7)
3. **Number rule:** "You dialled {first_name}'s number, so you already have it. Never ask for a phone number." (D3)
4. **Third-party rule, one source:** the gatekeeper line in `prompt.js:161` is rewritten to S3-D1a's wording, and `gemini.js:690-711` is changed only to agree with it. A test asserts that the rendered outbound prompt's third-party section contains no `{topic}` value.
5. `policy.js`: `INBOUND_ONLY = {askBeforeHangup, spellingNudge, gatherDetailsFallback}`.
   - The LVX132 ask-gate refusal is skipped when `skipOnOutbound("askBeforeHangup", …)` is true (D7, root cause, S09 evidence `no_ask:1`).
   - The spelling nudge is skipped on outbound (D5).
   - The `gather_details`/`confirm` fallback text is replaced on outbound by the closing rule (D7).
6. **D3's real source:** first assert that the assembled outbound prompt, for the R1 `speed_to_lead` config, contains none of `best number|contact number|phone number` (other than inside the new "never ask" rule). If the prompt is already clean, D3 is a model habit. Rule 3 plus the `outbound_asked_contact_number` detector (for round 2 and the S3-5 sims) is then the whole fix, and the report says so. Memory *backlog-entries-go-stale*: read the code before believing the ticket.

- [ ] **Failing tests.**
  - `skipOnOutbound` truth table: 3 names × {true, false}, and an unknown name throws.
  - LVX132: an outbound `end_call` with no prior ask is ALLOWED, while the inbound `end_call` with no prior ask is still refused `no_ask`. This is the existing inbound test, unchanged.
  - The spelling nudge is not sent on outbound and is still sent on inbound.
  - The outbound prompt contains each situation's key phrase (a table-driven test over the 13 lines) and the closing and number rules.
  - The outbound prompt contains no "anything else I can help" / "anything else I can assist".
  - The third-party line contains no topic text.
  - `detectOutboundTurn` examples:
    - "What's the best contact number for you?" gives `askedContactNumber`;
    - "Is there anything else I can assist you with today?" gives `inboundClosing`;
    - with topic "clinic systems" and the party unverified, "about your clinic systems enquiry" gives `topicToUnverified`;
    - the same text with the party verified gives false.
  - Inbound snapshots are unchanged.
- [ ] Implement. Update the outbound snapshot deliberately and diff it in the report.
- [ ] **Sabotage:** make `skipOnOutbound` return false for `askBeforeHangup`. Expected RED: the outbound `end_call` test (refused `no_ask`). Revert.
- [ ] Commit.

### Task S3-2: first seconds v2, recording first (D1, D4, T1, D10; S3-D2) — ~1.75 h

**Files:**
- Modify: `lib/outbound/firstSeconds.js` (constants `:98-127`, controller), `lib/voice/live/index.js` (stale-audio discard, the seed timing, the clip barge threshold, the shadow log), `lib/outbound/dispatch.js` (render before dial, `:207` `calls.create`, `:291-317` render), `lib/voice/metrics.js`
- Test: `tests/outboundFirstSeconds.test.js` (the existing pure-controller tests, extended), the liveBoot outbound tests (fake Live), `tests/outboundDispatch*.test.js`

**Constants:**
- `FIRST_SECONDS_DEFAULTS.silenceBackstopMs: 1750` (P-a; was 2000);
- `helloEndGapMs: 350`;
- `slowLiveMs: 1600`, kept as the latest limit from onset (Ofcom limb 2);
- `CLIP_BARGE_MIN_MS: 600`;
- in dispatch: `RENDER_BEFORE_DIAL_MAX_MS: 8000`;
- env `OUTBOUND_FIRST_SPEAKER`: `clip` (the default) or `live` (today's race, kept for the later switch).

**Behaviour (clip mode):**
1. **Nobody speaks:** the clip is queued at pickup + 1,750 ms, `path=backstop_silence`. This is unchanged except for the number.
2. **Hello heard** (a confirmed onset per O-6): the clip fires at the FIRST of:
   - (a) the voiced run has ended and `helloEndGapMs` has passed with no voice: the new `path=backstop_hello_end`;
   - (b) onset + `slowLiveMs`: `path=backstop_slow`.

   Live's reply is never waited for.
3. **Stale discard:**
   - From the moment the clip is queued, all Live model audio is dropped until BOTH (i) the generation that was in flight when the clip was queued has ended (`turnComplete` or `interrupted` seen), and (ii) the seed has been sent.
   - The seed (the opener as Live's own model turn) is sent when the clip's end mark echoes (O-8 kept). An `interrupted` caused by the seed must NOT clear our clip, because the clip is not Live audio.
   - The first Live audio that is forwarded belongs to a generation that started after the seed.
4. **Clip barge threshold:** while the clip plays, caller voice shorter than `CLIP_BARGE_MIN_MS` does not stop it (a "hello" is about 400–500 ms). A longer run stops it and re-arms the first-turn check (fix round 1 I1, kept).
5. **Shadow:** on a hello call, log `outbound_live_shadow{attemptId, from_speech_end_ms, from_speech_ms, discarded_chunks}`, measured to the first DISCARDED Live chunk, with a counter. A call with no discarded chunk logs `from_speech_end_ms:null`. Never skip the log line.
6. **Live mode:** `OUTBOUND_FIRST_SPEAKER=live` runs the old race with rule 3's discard applied after the clip. All existing firstSeconds tests pass under `live` unchanged.
7. **Render before dial (D10):**
   - dispatch renders the OPENER first and stores it, then calls `calls.create`;
   - the voicemail clip (and the S3-4 transfer-miss clip) still render while it rings;
   - if the opener render has not resolved within `RENDER_BEFORE_DIAL_MAX_MS`, dial anyway and log `outbound_render_late` (WARN);
   - if the render throws, dial at once, keeping today's prompt path and `outbound_backstop_missing`.
   - The stale-`dialing` threshold (`failStaleAttempt`, `dispatch.js:367-395` and migration 045) must exceed `RENDER_BEFORE_DIAL_MAX_MS` + the 40 s ring timeout. Assert it in a test; if it does not, stop and report (it would be a schema/constant change).

- [ ] **Failing tests** (fake clock; answer at t=0, stream start at +350):
  - **Silence:** the clip is queued at 1,750 ms. Pin the T1 margin: `silenceBackstopMs + 150 <= 2000`.
  - **Short hello:** onset at 1,100 ms, voice to 1,550 ms → the clip at 1,900 ms, `backstop_hello_end`.
  - **Long talk:** onset at 1,000 ms, voice continuing → the clip at 2,600 ms, `backstop_slow`.
  - **Barge threshold:** a 400 ms caller run during the clip leaves the clip playing; a 900 ms run clears it and re-arms the first-turn check.
  - **Stale discard (fake Live):**
    - Live emits 6 audio chunks for a generation that started before the clip, some during the clip and some after its end mark; zero of them reach the Twilio socket.
    - After the seed and a new caller utterance, Live's next generation's chunks are forwarded.
    - `outbound_live_shadow.discarded_chunks === 6`, and `from_speech_end_ms` equals the fake time of the first chunk minus the end of the hello.
  - **Seed:** the seed's `interrupted` does not clear the clip (the clip frames are still sent).
  - **Live mode:** the existing slow/silence/live_reply tests pass with `OUTBOUND_FIRST_SPEAKER=live`.
  - **Dispatch:**
    - the render resolves at 5 s → `calls.create` is called after `storeAttemptAudio(opener)`;
    - the render hangs → `calls.create` at 8 s plus `outbound_render_late`;
    - the render throws → `calls.create` immediately;
    - the stale-dialing threshold assertion.
- [ ] Implement.
- [ ] **Sabotage:** lift the discard at the clip's end mark only, ignoring condition (i). Expected RED: the stale-discard test (some chunks forwarded). Revert.
- [ ] Commit.

### Task S3-3: the platform packs `outcome`, `callback`, `opt_out`, plus the retry journey (D9; wrong-number suppression) — ~1.25 h

**Files:**
- Create: `capabilities/outcome.js`, `capabilities/callback.js`, `capabilities/optOut.js`
- Modify:
  - `capabilities/index.js:50` (`PACKS` + the order snapshot `:9-30`);
  - `services/gemini.js` `filterForOutboundCampaign` (`:148-176`): the union with `PLATFORM_PACKS`;
  - `services/tools.js` (the execution-time campaign filter, Ruling 1819-a, must allow `PLATFORM_PACKS`);
  - `lib/outbound/prompt.js` (`CAMPAIGN_CAPABILITY_LABELS` + the tool names in SITUATIONS);
  - `services/db.js` (`insertSuppression({phone, reason, sourceCallId, createdBy})` with `ON CONFLICT DO NOTHING`; `insertDetectorSuppression` becomes a wrapper around it);
  - `lib/outbound/postCall.js`;
  - `AI-phone-dashboard/backend/src/routes/settings.js:231` (`BUILTIN_TOOL_NAMES`);
  - `lib/voice/metrics.js`.
- Test: `tests/outboundPacks.test.js`, `tests/db/outboundSuppression.test.js`, `tests/outboundPostCall*.test.js`, `tests/outboundJourney.test.js` (new)

**Contract:**
- `PLATFORM_PACKS = Object.freeze(["outcome","callback","opt_out"])`, exported from `lib/outbound/policy.js`. On outbound they are declared whatever the campaign's `capabilities` say, and never on inbound. They are NOT `actionTools` (`actionTools: []`), so O-12's unverified-party refusal never blocks them: a gatekeeper can book a callback, and a wrong-number person can say "stop".
- `set_call_outcome({outcome, note?})`: `outcome ∈ {qualified_no_booking, not_interested, not_a_fit, callback_requested, wrong_person, wrong_number, other}`.
  - `booked`/`opted_out`/`transferred` are refused with a message naming why (effects set those).
  - `wrong_number` writes a suppression with reason `wrong_number` IMMEDIATELY, inside the tool's tenant scope, and the recorded outcome is `wrong_person`. This is the wrong-number suppression writer, a must-hold.
- `schedule_callback({when_iso, when_text})`:
  - valid when inside the campaign window, and (after S3-7) the legal floor, on the CONTACT's clock, and ≤ 14 days ahead;
  - otherwise `{ok:false, nearest:<ISO>}`;
  - on success it stores `capabilityState.callback.at`, and the response speaks the time back in the contact's local time;
  - post-call: `callback_requested` + `callback.at` → `next_attempt_at = callback.at` (spec §8).
- `opt_out()`: inserts the suppression (reason `opted_out`, created_by `tool`) IMMEDIATELY and sets the outcome to `opted_out`. The response tells the model to confirm "I've made sure we won't call you again." Per memory *refusal-message-is-a-request*, the row is the guarantee.
- **D9:** `postCall.js` runs `detectOptOut` BEFORE writing the outcome. On a hit, when tiers 1–3 set nothing, the outcome is `opted_out`. The suppression insert keeps its idempotency.

- [ ] **Failing tests:**
  - enum enforcement;
  - `booked`/`opted_out`/`transferred` refused;
  - `wrong_number` → suppression row reason `wrong_number` (DB test) + outcome `wrong_person`;
  - a callback outside the window → `nearest`; a callback 15 days out → refused;
  - each tool works with `party.verified=false`;
  - **opt_out writes the row before `finish()`:** the DB test asserts the row exists while the session is open;
  - a second `opt_out` does not error;
  - the platform packs are declared on outbound for a campaign listing only `["appointments"]`, and are absent on inbound (inbound snapshots unchanged);
  - D9: a transcript with the caller saying "please stop calling me" and no tool call → outcome `opted_out`;
  - **journey** (fake clock, R1 schedule `["now","+10m","+3h","next_day 10:00","day_3 17:30"]`): voicemail only on attempts 1 and 5; each `next_attempt_at` exact; closed `attempts_exhausted` after 5; a `give_up_after_days` breach closes early; `callback_requested` overrides the schedule with `callback.at`.
- [ ] Implement. Export the capability schemas (`node scripts/export-capability-schemas.js`); the drift test goes green.
- [ ] **Sabotage:** defer `opt_out`'s write to post-call. Expected RED: "row exists before finish". Revert.
- [ ] Commit.

### Task S3-4: transfer, the clip in Ava's voice (D6) and the `transferred` outcome — ~0.75 h

**Files:**
- Create: `database/046_outbound_transfer_miss.sql` (`ALTER TABLE call_attempts ADD COLUMN IF NOT EXISTS transfer_miss_audio bytea`; fold into `schema.sql`)
- Modify:
  - `lib/outbound/dispatch.js`: render `transfer_miss` while it rings, only when the campaign lists `transfer`. The text: "Sorry, no one's free to take your call right now. We'll call you back shortly. Goodbye.";
  - `lib/outbound/mediaUrl.js` + the media route: the kind allow-list gains `transfer_miss`;
  - `lib/outbound/doorRoutes.js:547-590`: `<Play>` of the signed URL when the audio exists, else today's `<Say>`; on `DialCallStatus=completed`, the outcome `transferred`;
  - `lib/outbound/postCall.js:55` (`TERMINAL_OUTCOMES` gains `transferred`).
- Test: `tests/outboundTransfer*.test.js`, `tests/db/schemaParity.test.js`

- [ ] **Failing tests:**
  - an unanswered transfer with stored audio → TwiML has `<Play>` of a signed `transfer_miss` URL and no `<Say>`;
  - with no audio → today's `<Say>` (fallback);
  - a completed transfer → outcome `transferred`, the outreach closed `terminal_outcome`;
  - the media route refuses an unknown kind;
  - the fold proof (session-rules migration loop).
- [ ] Implement.
- [ ] **Sabotage:** drop `transfer_miss` from the kind allow-list. Expected RED: the `<Play>` URL test (404 from the media route). Revert.
- [ ] Commit.

### Task S3-5: situation sims on the real Live model (the harness) — ~1 h, PAID (≈$1.00; the owner's YES before running)

**Files:**
- Modify: `scripts/live-call-harness.js`. Lift the `--outbound` + `--script` refusal at `:346`. Outbound scripts are allowed LOCAL ONLY (the existing base-URL refusal stays).
- Modify: `lib/probe/outboundHarness.js` (the verdicts).
- Create: 8 scripts next to `outbound_hello`, synthesised once with `--synth` (Google TTS, cents):

| Script | Caller lines | Pass (asserted on DB rows + counters + the LOCAL server log's `live_debug_assistant_turn` text) |
|---|---|---|
| `outbound_stop` | "Hello?" … "Please stop calling me." | suppression reason `opted_out` created_by `tool`; outcome `opted_out`; `outbound_inbound_closing_phrase`=0 |
| `outbound_gatekeeper_fetch` | "Reception, who's calling?" … "One moment." … "Hi, this is Nithin." | `outbound_topic_to_unverified`=0; `confirm_identity(true)` only after the last line |
| `outbound_gatekeeper_later` | "He's out. Try tomorrow at ten." | `next_attempt_at` = tomorrow 10:00 contact time; outcome `callback_requested`; topic-to-unverified 0 |
| `outbound_child` | "He's not here, I'm his son." … "What's it about?" | topic 0; no question other than availability (the log text has at most one `?` after the opener); outcome `callback_requested` or `wrong_person` |
| `outbound_bad_time` | "Hello?" … "I'm driving, call me tomorrow at three." | `next_attempt_at` tomorrow 15:00; outcome `callback_requested` |
| `outbound_wrong_number` | "There's no Nithin here." | suppression reason `wrong_number`; outcome `wrong_person` |
| `outbound_robot` | "Hello?" … "Are you a robot?" | `outbound_claimed_human`=0; the assistant text matches the AI-disclosure regex after the question |
| `outbound_email` | "Hello?" … "Just email me instead." | outcome `other`, note contains "email"; closing phrase 0 |

- Every run also asserts:
  - `outbound_asked_contact_number`=0;
  - `outbound_inbound_closing_phrase`=0;
  - `end_call_refusals.no_ask`=0;
  - no `outbound_silent_call`;
  - `outbound_first_audio.path` ∈ {`backstop_hello_end`, `backstop_silence`, `backstop_slow`}.
- **N=3 per script** (memory *sim-must-be-able-to-fail*). Report per script as k/3, never pooled.
- Memory *scripted-callers-desync*: if a run fails, read the transcript before calling it a defect.

- [ ] Write the verdict unit tests first (`tests/outboundHarnessVerdict.test.js`): each script's pass rule over a recorded fake result, plus one failing fixture per rule, so the verdict can fail.
- [ ] Implement the harness changes and synthesise the audio.
- [ ] **Controller:** state the cost (24 runs × ≈$0.04 + TTS ≈ $1.00, `reserveP1("P1-SIM-S3", 1.50)`) and get the owner's YES.
- [ ] Run, record k/3 per script in the ledger, and commit the spend.
- [ ] A failing script is triaged: a prompt fix inside S3-1's files is allowed, up to 2 rounds. Anything bigger goes to the owner.
- [ ] Commit.

### Checkpoint A (~45 min)
- [ ] Both suites green. Inbound snapshots unchanged. `corpus:sabotage --census` green.
- [ ] A sonnet review of the half-1 diff. Fix Critical/Important; Minors go to the ledger.
- [ ] If the calling window and the owner allow: the deploy + phone check below. Otherwise continue to half 2.

---

# HALF 2: plumbing (overnight OK; two lanes, each in its own worktree, with test gates serialized)

- **Lane A:** S3-6 → S3-11 → S3-7. S3-11 creates migration 048, including S3-7's close reason.
- **Lane B:** S3-8 → S3-9 → S3-10.
- Both lanes touch `services/db.js` in different functions. The controller merges lane B into lane A and re-runs both suites.

### Task S3-6: goal-driven campaign fields + the `custom` template (S3-D4) — ~1 h

**Files:** `lib/outbound/campaignSchema.js` (`ALLOWED_KEYS :112-127`, `CAMPAIGN_ENUMS :66-75`, `REFUSED_IN_PART1 :88-97`), `lib/outbound/templates.js` (`PURPOSE_BY_TEMPLATE :30-39`), `lib/outbound/prompt.js`, `lib/voice/live/index.js` (session language), the exported `campaignSchema.json` + the dashboard drift test. Test: `tests/outboundCampaignSchema.test.js`, `tests/outboundPrompt.test.js`.

**New keys:**
- `goal`: required. One of `book | qualify_then_book | confirm_or_move | get_review | pass_message | find_need`.
- `details_fields`: ≤ 10 entries of `{key: /^[a-z][a-z0-9_]{0,31}$/, label ≤ 40}`.
- `language`: `en-GB | en-US`, default the tenant's.
- `why_allowed`: required, ≤ 300 characters, shown to reviewers and never spoken.
- `review_url`: https only, required iff `get_review`.
- `message_text`: ≤ 300 characters, required iff `pass_message`.
- `custom_basis`: `asked_to_be_contacted | existing_customer | selling`, required iff `template_key=custom`.
- `caller_id` becomes optional. It defaults to the business's own number at dispatch, and is still validated as owned when given.

**Rules:**
- The goal needs its capabilities:
  - `book` → `appointments`;
  - `qualify_then_book` → `qualification` + `appointments`;
  - `confirm_or_move` → `appointments`.
  A missing capability is refused at save, naming it.
- `custom` + `asked_to_be_contacted` → class `solicited`, purpose `enquiry_followup`. `existing_customer` → class `service`. `selling` → refused: "arrives in Part 3". `custom` is removed from `REFUSED_IN_PART1`.
- The prompt:
  - gains one goal line (e.g. `qualify_then_book` → "Ask the questions, then offer a time to talk");
  - gains per-person details as `DETAILS: label: value` lines. They come from `outreach.details` (S3-9); S3-6 reads an optional `ctx.outboundCall.details`.
  - Details are NEVER placed in the opener or the voicemail. The existing budget rules are unchanged.
- The session opens Live with the campaign `language` when set (`live_session_open.language_source=campaign`).

- [ ] **Failing tests:**
  - each goal's required fields/capabilities are refused when missing;
  - the `custom` basis mapping (3 cases);
  - `caller_id` absent → dispatch uses the business phone;
  - details render into the prompt and not into the rendered opener;
  - `language` is honoured;
  - the unknown-key strictness still holds;
  - the drift test is green after the export.
- [ ] Implement.
- [ ] **Sabotage:** let `selling` map to `solicited`. Expected RED. Revert.
- [ ] Commit.

### Task S3-7: per-country calling-hours floor (S3-D5, P-b) — ~0.75 h

**Files:** Create `lib/outbound/legalFloor.js`. Modify `lib/outbound/gate.js:101-103` (a new check after the campaign window), `lib/outbound/schedule.js:101-105`, and `capabilities/callback.js` (the floor in validity). Test: `tests/outboundLegalFloor.test.js`, `tests/outboundGate.test.js`.

**Interface:** `floorFor(phoneE164, contactTimezone|null) → {country:"US"|"GB", zones:[tz…], windows:{mon…sun:"HH:MM-HH:MM"}} | {refused:"no_legal_floor"}`.
- `+44` → GB, windows 08:00–21:00 every day, zones `[contactTimezone ?? "Europe/London"]`.
- `+1` with an area code NOT in `NON_US_NANP` → US, windows Mon–Sat 08:00–20:00, Sun 12:00–20:00, zones `[contactTimezone]` or, when that is null, `["America/New_York","America/Los_Angeles"]` (inside in BOTH).
- `NON_US_NANP` is a frozen Set: the Canadian and Caribbean area codes plus the US territories (787/939 PR, 340 VI, 671 GU, 670 MP, 684 AS). The implementer verifies the list against NANPA's published assignments and cites the source in a comment. The test pins 416, 604, 876, 787 and 242 as refused and 214, 469, 212 and 415 as US.
- Everything else → `{refused:"no_legal_floor"}`.

**Gate:**
- `no_legal_floor` → verdict **never**, close reason `no_legal_floor`. The CHECK value already exists: S3-11 runs first in lane A and its migration 048 adds it.
- Outside the floor → verdict **later** at the next floor-and-window opening.
- The save-time 08:00–21:00 check stays as it is.

- [ ] **Failing tests:**
  - Sunday 11:00 Chicago for a US contact → later, 12:00;
  - 20:30 Tuesday US → later;
  - 20:30 Tuesday UK → allowed;
  - US with no timezone at 09:00 New York (06:00 LA) → later;
  - a Toronto number → never `no_legal_floor`;
  - a +33 number → never;
  - `schedule_callback` at 20:30 US → `nearest` next day 08:00.
- [ ] Implement.
- [ ] **Sabotage:** drop the Sunday row. Expected RED. Revert.
- [ ] Commit.

### Task S3-8: shared results channel (S3-D3; old Task 28; C3 per P-c; C10) — ~1.25 h

**Files:**
- Create:
  - `lib/connections/secretBox.js` (AES-256-GCM, `CONNECTIONS_WEBHOOK_KEY`, a 32-byte base64);
  - `lib/connections/signer.js`;
  - `lib/net/ssrfGuard.js`;
  - `lib/connections/outbox.js`;
  - `docs/connections-webhook-contract.md`.
- Modify: `services/db.js` (outbox + endpoint functions over the 042 tables `webhook_endpoints` and `outbox`), `lib/outbound/postCall.js` (step 7, `:100`), `lib/outbound/internalRoutes.js` (the delivery task handler + the sweep backstop for due outbox rows), `scripts/outbound-admin.js` (`webhook-set`, `webhook-test`).
- Test:
  - `tests/connectionsSigner.test.js`, verified against an INDEPENDENT inline `crypto.createHmac` in the test, not by importing the signer;
  - `tests/ssrfGuard.test.js`;
  - `tests/connectionsOutbox.test.js`;
  - `tests/db/connectionsOutbox.test.js`.

**Contract:** as in spec §12.5, plus `"direction":"outbound"` in every payload.
- Headers `X-Vetra-Event`, `X-Vetra-Delivery`, and `X-Vetra-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + raw_body)>`.
- Backoff 1m, 5m, 30m, 2h, 12h → `dead`. Timeout 6 s. `last_error` holds a status code or error class only.
- **SSRF:** resolve every A/AAAA record and refuse private ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, ::1, fc00::/7, fe80::/10, IPv4-mapped `::ffff:`). Connect to the vetted IP with Host/SNI set to the hostname. `redirect:"manual"`, so a 3xx is a failure.
- **Inbound is not wired:** a test asserts that the inbound `finish()` makes zero outbox inserts.
- **C10:** the existing `integrations/webhook.js` guard gaps are written to the backlog and not changed.

- [ ] **Failing tests:**
  - the signature matches the independent HMAC; a tampered body fails;
  - each private range is refused; a redirect is refused;
  - 5 failures → `dead`;
  - the idempotency key makes a re-insert a no-op;
  - `secretBox` round-trips, and a ciphertext from another key fails;
  - the secret never appears in any `log.*` call (spy);
  - inbound makes no insert.
- [ ] Implement.
- [ ] **Sabotage:** remove the `::ffff:` check. Expected RED. Revert.
- [ ] Commit.

### Task S3-9: the leads-in link `POST /v1/triggers/:triggerToken` (old Task 29 + per-person details) — ~0.75 h

**Files:**
- Create: `lib/outbound/triggerRoute.js`, `database/047_outbound_triggers.sql`, folded into `schema.sql`. The migration covers:
  - `campaigns.trigger_token_hash`;
  - a no-RLS `campaign_trigger_directory` + the definer `app_campaign_by_trigger_hash(hash)` (the Task 3 / C1 pattern);
  - `outreach.details jsonb NOT NULL DEFAULT '{}'`.
- Modify: `services/db.js`, `scripts/outbound-admin.js` (`trigger-token-rotate` prints the token ONCE), `server.js` (the mount).
- Test: `tests/outboundTriggerRoute.test.js`, `tests/db/outboundTrigger.test.js`

**Rules:**
- The token is 32 random bytes, stored as sha256, and compared in constant time.
- The body is validated: E.164, and a consent block is required unless the class is `service`.
- The route upserts the contact, records the consent, and creates the outreach idempotently (`idempotency_key` or `hash(phone + source_ref)`). It copies `data` keys that are in the campaign's `details_fields` into `outreach.details`. The 202 response is `{outreach_id, ignored_fields:[…]}`.
- A rejection is `422 {error, field}` + the counter `outbound_trigger_rejected{reason}`, never silent.
- 30/min per token; 16 KB body limit.

- [ ] **Failing tests:**
  - a bad token → 401;
  - no consent for `solicited` → 422 `field:"consent"`;
  - a replay returns the same `outreach_id`;
  - 202 + details copied + `ignored_fields` listed;
  - the directory definer test runs under a NOBYPASSRLS owner;
  - the rate limit gives a 429 on the 31st request;
  - a 17 KB body → 413.
- [ ] Implement.
- [ ] **Sabotage:** swap the constant-time comparator for `===`, with a timing-free test on the comparator function itself. Revert.
- [ ] Commit.

### Task S3-10: `qualification` pack + booking on the built-in calendar (old Tasks 24 + 30) — ~1 h
Contract as in the Part 1 plan, Task 24 (copied here so this file stands alone):
- `record_answer({key, value})`.
  - An unknown key, or a value over 500 characters, is refused, naming the valid keys.
  - Success → `stateEffects.capabilityState.qualification.answers[key]=value` + a `{capability:"qualification",type:"answered",data:{key}}` effect.
- **Booking gate:** `book_appointment` is refused EXACTLY ONCE if required keys are missing, naming them. A per-call counter lives in `capabilityState` (`lib/capabilities/requirements.js`), per memory *prompt-caps-need-counters*. After that one refusal the booking proceeds, with `missing_required:[…]` recorded on the outcome.
- **Booking on outbound:** via `adapters/scheduling/internal.js`, `clientPhone = party.phone`, after `confirm_identity`. A booking effect → outcome `booked`.
- Answers are persisted post-call into `calls.answers` (jsonb, migration 043).

- [ ] **Failing tests:**
  - unknown key; a 501-character value;
  - an answer is recorded;
  - refused once, then allowed;
  - an optional question never blocks;
  - inbound declares no `record_answer`;
  - the outbound booking writes `clientPhone = party.phone`;
  - a clash is refused by `create_appointment_if_available`;
  - booked → outcome `booked`.
- [ ] **Sabotage:** make the refusal ceiling unbounded. Expected RED. Revert.
- [ ] Export the schemas.
- [ ] Commit.

### Task S3-11: must-holds (P5 erasure, the urlencoded parser, the stuck-dialing alert) — ~1 h

**Files:**
- `database/048_outbound_erasure.sql`, folded. It contains:
  - `suppressions.phone_e164 DROP NOT NULL`;
  - `ADD COLUMN IF NOT EXISTS phone_hash text`;
  - a unique partial index `(business_id, phone_hash) WHERE phone_hash IS NOT NULL`;
  - a `CHECK (phone_e164 IS NOT NULL OR phone_hash IS NOT NULL)`;
  - the outreach close_reason CHECK gains `erased` and `no_legal_floor` (the latter for S3-7).
- `services/db.js` `eraseCallerData` (`:1968-2056`);
- `lib/outbound/gate.js` (the suppression check also matches `phone_hash`);
- `server.js:178` (the urlencoded parser skips `isOutboundInternalPath`, mirroring the JSON exclusion at `:182-197`);
- `lib/outbound/dispatch.js` `failStaleAttempt` (`:367-395`);
- `docs/superpowers/plans/2026-09-24-outbound-part1-golive-commands.md` (the alert policy + the new secrets as YES-gated commands).

**P5:** erasure for a phone:
- deletes `consents`;
- anonymises `contacts` (first_name null, attributes `{}`);
- closes open `outreach` with `erased` and clears `details`;
- nulls `call_attempts` audio columns (the audio contains the first name);
- KEEPS each `suppressions` row but sets `phone_hash = HMAC-SHA256(SUPPRESSION_HASH_KEY, phone)` and nulls `phone_e164`. Spec §13.5: a suppression outlives erasure.

The gate treats a hash match as suppressed. The new secret is `suppression-hash-key`.

**Stuck dialing:** `failStaleAttempt` emits `log.error("outbound_stuck_dialing", {attemptId, outreachId, age_ms})` + a counter. The Cloud Monitoring log-based alert, with an email channel to the owner, is a go-live command (memory *gcp-notices-go-nowhere*: create the channel explicitly).

- [ ] **Failing tests** (DB):
  - after erasure: no consent rows, a nameless contact, outreach closed `erased`, null audio;
  - the suppression is kept with a hash and a null phone;
  - the gate still refuses that phone as `suppressed`;
  - a form-encoded POST to `/internal/outbound/dispatch` is not parsed (the body is empty) and is still OIDC-refused;
  - the stale sweep emits `outbound_stuck_dialing`.
- [ ] Implement.
- [ ] **Sabotage:** have erasure delete the suppression row. Expected RED: the gate test. Revert.
- [ ] Commit.

### Final checkpoint (~1.25 h)
- [ ] Both suites green. Inbound snapshots unchanged. ONE full `npm run corpus:sabotage`.
- [ ] An **opus** final review of `b797487..HEAD`. Fix Critical/Important, re-review the fixes, then one Minor batch.
- [ ] Spec §19 already records the decisions. Append any new owner rulings.
- [ ] Update memory `outbound-calling-plan`. Write `next-session-prompt-stage3-deploy-and-phone-check.md` and the stage-4 prompt.
- [ ] Go-live command list for the stage-3 deploy. Nothing runs without the owner's YES:
  - build the image;
  - migrations 046–048 via the migrate job;
  - create the secrets `connections-webhook-key` and `suppression-hash-key`;
  - deploy a new revision (`OUTBOUND_ENABLED` stays false, the allow-list unchanged);
  - rollback to `voice-uk-prod-00094-87t`.

### Deploy + phone check (owner, ~15 min, inside 08:00–21:00 CDT)
- [ ] With the owner's YES on the exact commands:
  - deploy;
  - update the R1 campaigns S01b, S03 and S10 so their `capabilities` and `goal` fit the new schema (the `campaign --config` writes);
  - fire them with `r1-fire.sh` (a new UTC day means a new idempotency key).
- [ ] **Three calls, ≈$0.15:**
  - (1) say "Hello?" → no double-talk and no re-ask, `path=backstop_hello_end`, no silent flag, and the shadow line logged;
  - (2) stay silent → the clip ≤ 2.0 s, no silent flag;
  - (3) the gatekeeper: "He's out, try tomorrow at ten" → no topic, `next_attempt_at` 10:00, no "anything else".
- [ ] Pause each campaign after its call. Report in the unit a caller feels. Commit.

---

# STAGE 4: dashboard (one long session, ~8 h; branch `feat/outbound-stage4`)
The Part 1 plan's Tasks 32–37 (backend conventions at its stage 4 header) are trimmed to:
- **Backend routes** (Task 32 as written), plus `GET/POST /api/outbound/leads` (manual add) and the trigger-link management (show the URL, rotate the token).
- **Campaign wizard:** type → goal → about + per-person details → why-allowed → booking/transfer → schedule → who to call → **"test call me"** (a trigger to the logged-in owner's allow-listed number) → go live. It renders from the generated `campaignSchema.json`; live budgets; all errors at once.
- **Who to call:** copy the link / add manually / "send a test, then match" field mapping (`details_fields` ↔ incoming keys, remembered per campaign). Rejected leads are visible.
- **Leads list + timeline**, and the call log with a direction filter, outcome and answers.
- **Settings:** the do-not-call list (add/remove/CSV), the business default outbound hours (campaigns inherit them) + the "only during business hours" toggle, the transfer number/hours, and the webhook URL + secret + test.
- **Callback recognition (moved here from old Task 26; a must-hold before `OUTBOUND_ENABLED=true`):** inbound `onStart` lookup of an open outreach within 14 days → a `CALLER CONTEXT` line + `record_answer` + `calls.outreach_id` + close `called_back`. **A caller with no open outreach gets a prompt byte-identical to today's.**
- **Deferred:** results charts, demo polish, spreadsheet upload (the Ilija session), the missed-call SMS (the Ilija session, P-d), the missed-call/reminder templates.
- The dashboard deploy needs the owner's YES.

# Later sessions
- **Test round 2** (a short daytime session): the owner + 2–3 accent testers, the demo qualifier, 10–20 calls, `reserveP1("P1-LIVE-R2", 3.00)`. Pass: questions asked; answers stored; a booking in the internal calendar; a signed webhook received; no D1/T1/D7 regressions. Then delete the R1 test campaigns (S3-D7).
- **Ilija setup session:**
  - GHL workflow → trigger link; results → GHL;
  - a UK caller ID + UK SMS sender;
  - the missed-call SMS;
  - spreadsheet upload;
  - the consent line on his form;
  - A2P only if US texting is needed;
  - then a watched pilot (limited leads/day, every call read).
