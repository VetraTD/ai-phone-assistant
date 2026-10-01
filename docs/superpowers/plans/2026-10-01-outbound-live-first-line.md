# Outbound: the AI answers live (no recorded opener) -- Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the default outbound mode the AI's own live reply is the first thing the person hears; silence gets a
live "Hello?" at 3 s; hold/transfer is handled; key answers are read back; clip mode stays as the rollback.

**Architecture:** A NEW small pure controller `lib/outbound/liveFirstLine.js` runs the first seconds in `live` mode
(timers, hold state, first-reply metric). The existing 1,600-line `lib/outbound/firstSeconds.js` is NOT modified --
it keeps running `clip` mode exactly as today. `lib/voice/live/index.js` builds one or the other. Prompt changes
live in `lib/outbound/prompt.js`; must-nevers (disclosure, hold mute, read-back, early opt-out) are code.

**Tech Stack:** Node 22 ESM, vitest, Gemini Live (`gemini-3.8-live`), Twilio media streams, Deepgram (EU) one-shot.

**Spec:** `docs/superpowers/specs/2026-10-01-outbound-live-first-line-design.md` (read it first; it wins on conflict).

**Plan style (owner ruling 2026-10-01, speed + low usage):** short plan. Each task pins files, anchors, the exact
behaviour and the test cases; the code is written against the real code in the session (earlier plan-verbatim code
shipped fail-open gates -- memory `plan-verbatim-code-fails-open`). Ledger:
`.superpowers/sdd/2026-10-01-outbound-live-first-line/progress.md`.

## Global Constraints

- Inbound byte-identical: all 110 inbound prompt snapshots unchanged; `tools.json` inbound snapshots unchanged.
- No DB migration. No new env var (`OUTBOUND_FIRST_SPEAKER` exists). No new dependency.
- `OUTBOUND_FIRST_SPEAKER`: unset or `live` -> live mode (NEW default); `clip` -> today's behaviour; anything else ->
  `clip` + `log.error("outbound_first_speaker_invalid", {severity:"warn"})` (a typo must never pick the new path).
- Live mode numbers: silence "Hello?" HEARD at 3,000 ms after stream start (+/-500); Live-unresponsive 6,000 ms after
  the person's first utterance ends; hold cap 120,000 ms; early-audio buffer cap 15 s; read-back refusals cap 2/key.
- First reply always: persona name + "AI assistant" + business; name check unless self-identified; never the reason
  before identity is confirmed.
- `OUTBOUND_ENABLED` stays false. No push. No checkout/switch/restore/stash in the MAIN checkout. Never touch
  `.impeccable/` or `docs/VetraTD-Pricing-Model.xlsx`. Regex-bearing code via Write/Edit, never a heredoc
  (memory `heredoc-eats-backslashes`). Sabotage: commit first, restore by Edit, `git diff --quiet` after.
- Root suite needs `NODE_EXTRA_CA_CERTS=.superpowers/sdd/2026-09-29-outbound-stage4/norton-roots.pem` on this machine.

## Review Focus

1. Caller talks over the AI's FIRST reply -> the AI stops (Live `interrupted` must clear forwarded audio in live mode;
   in clip mode the vendor interrupt was deliberately skipped while the clip played). Test in Task 3.
2. Hold music with vocals (Live transcribes lyrics as words) -> the AI must not chat to the music. Release needs a
   worded transcript AND >= 400 ms of voiced caller audio in the same utterance; test with "la la love you" + 300 ms. Task 2.
3. A machine answers before AMD reports (~3.5 s) -> when the voicemail clip starts, Live audio stops (no AI voice over
   the voicemail message). Test in Task 3.
4. The person says "Hi" at 2.9 s, just as the "Hello?" cue is due -> exactly one AI turn (cue cancelled, no
   "Hello?" + reply). Task 2 (pure) + Task 3 (wired).
5. Read-back of values with punctuation/digits ("St. Mary's Clinic 2") -> normalisation (lowercase, strip
   punctuation, collapse spaces) still recognises the read-back. Task 8.

---

### Task 1: Census + mode selection

**Files:** Modify `lib/voice/live/index.js:7116-7125` (mode parse). Create `lib/outbound/firstSpeakerMode.js`.
Test: `tests/outboundFirstSpeakerMode.test.js`. Ledger: census table.

**Produces:** `resolveFirstSpeaker(rawEnvValue, log) -> "live" | "clip"`.

- [ ] Census (read-only, ~20 min): every `dialFirstSeconds` use in `index.js` (48) and every `dialCtx.opener*` use.
  For each: what it does in clip mode, and what live mode needs (nothing / liveFirstLine method / must not run). Write
  the table to the ledger. Any site whose `?.` null-skip would silently drop a needed behaviour in live mode (memory
  `a-fix-can-be-the-next-defect`) becomes an explicit `if (firstSpeaker === "live")` branch in Task 3.
- [ ] Failing tests: `undefined`/`""`/`"live"`/`" LIVE "` -> `"live"`; `"clip"` -> `"clip"`; `"lvie"` -> `"clip"` and one
  warn log `outbound_first_speaker_invalid`.
- [ ] Implement, wire into index.js (replace the inline parse), run, commit `feat(outbound): first-speaker mode -- live default, clip rollback`.

### Task 2: `liveFirstLine` pure controller

**Files:** Create `lib/outbound/liveFirstLine.js`. Test: `tests/outboundLiveFirstLine.test.js` (fake clock, no I/O).

**Produces:**
```js
export const LIVE_FIRST_LINE_DEFAULTS = Object.freeze({ silenceHelloMs: 3000, cueLeadMs: 800, unresponsiveMs: 6000, holdMaxMs: 120000, holdReleaseVoicedMs: 400 });
export function createLiveFirstLine({ now, streamStartAtMs, speakHello, endCall, log, logFields, ...overrides })
// returns:
//   onCallerFrame(atMs, voiced:boolean)          caller audio frame (20 ms) with VAD flag
//   onCallerTranscript(text, atMs)               Live inputTranscription chunk
//   onModelAudio(atMs)                           first chunk of each model generation
//   onTurnComplete(atMs)
//   enterHold(atMs)                              from the wait_on_hold tool (Task 7)
//   tick(atMs)                                   called from the existing 20 ms ticker
//   forwardModelAudio() -> boolean               false only while on hold and not released
//   onHold() -> boolean                          true while on hold (the silence ladder reads it)
//   firstReply() -> { path, from_speech_end_ms, from_answer_ms } | null
```
Behaviour (each a test, sabotage each in one batch at the end):
- [ ] Silence: no voiced frame -> `speakHello()` called once at `streamStartAtMs + silenceHelloMs - cueLeadMs`;
  never again. `firstReply().path === "silence_hello"`.
- [ ] Speech before the cue: the cue is sent at stream time 2,200 ms (3,000 - 800 lead); a voiced frame at 2,180 ms
  -> `speakHello` never called (Review Focus 4). A voiced frame at 2,220 ms (cue already sent) -> no second cue, and
  the model's next turn is the reply.
- [ ] Live never answers the cue: `speakHello()` returns false (no session), or no model audio within `unresponsiveMs`
  of the cue -> `endCall("live_unresponsive")` + the same ERROR log.
- [ ] First reply metric: utterance ends at T, first model audio at T+1,600 -> `from_speech_end_ms: 1600`, one
  `outbound_first_reply` info log; at T+2,100 also `outbound_first_reply_slow` (warn).
- [ ] Unresponsive: utterance ends at T, no model audio by T+6,000 -> `endCall("live_unresponsive")` + `log.error("outbound_live_unresponsive")`; model audio at T+5,900 -> no end.
- [ ] Hold: `enterHold` -> `onHold()` true, `forwardModelAudio()` false; transcript "hello?" with 500 ms voiced ->
  released (`onHold()` false, forward true); transcript "la la love you" with 300 ms voiced -> still on hold
  (Review Focus 2); no release by +120,000 ms -> `endCall("hold_timeout")`.
- [ ] Commit `feat(outbound): liveFirstLine controller -- silence hello, first-reply metric, unresponsive, hold`.

### Task 3: Wire live mode into the Live engine

**Files:** Modify `lib/voice/live/index.js` (build site ~7116-7175; silence ladder ~2355-2400; model-audio forward
path; `sc.interrupted` handler; `sc.inputTranscription` ~6045; AMD/voicemail clip start). Test: the existing liveBoot
outbound test file(s) with the fake Live (find with `grep -l "outbound" tests/liveBoot*`).

**Consumes:** Task 1 `resolveFirstSpeaker`, Task 2 controller API.

- [ ] Failing tests (fake Live, live mode): (a) no clip audio is ever enqueued and `dialCtx.openerAudio` is never read;
  (b) the first Live audio chunk after "Hello?" reaches `audioOut` (no discard); (c) silence -> the speakLine "Hello?"
  turn is sent at 2,200 ms stream time; (d) caller speech during the first model reply -> vendor `interrupted` clears
  forwarded audio (Review Focus 1); (e) on hold the ladder does not fire at 20 s; (f) AMD machine -> voicemail clip
  starts and no further Live audio is forwarded (Review Focus 3); (g) clip mode: the existing clip tests still pass
  unchanged.
- [ ] Implement per the Task 1 census: live mode builds `createLiveFirstLine` (not `createFirstSecondsController`);
  `speakHello` = `speakLine("hello", <strings outbound hello, default "Hello?">)`; `endCall` = the existing armExit/end path
  with the given reason; the ladder returns early while `liveFirstLine.onHold()`; the forward path drops model audio
  while `!liveFirstLine.forwardModelAudio()`. `outbound_live_shadow` / `outbound_first_audio` stay clip-only.
- [ ] Run the outbound + liveBoot tests, commit `feat(outbound): live mode -- the AI answers first`.

### Task 4: Disclosure guard

**Files:** Modify `lib/outbound/detectors.js` (add `firstReplyDiscloses(text)` using `AI_DISCLOSURE_RE` from
`lib/outbound/campaignSchema.js:20`), `lib/voice/live/index.js` (after the FIRST assistant `turnComplete` in live
mode). Test: `tests/outboundDetectors.test.js` + one fake-Live test.

- [ ] Tests: "Hi, this is Ava, an AI assistant calling from Digile Media" -> true; "Hi, this is Ava from Digile Media"
  -> false; "" / "???" -> false (fail closed). Wired: a first reply without disclosure -> `log.error("outbound_disclosure_missing")`
  once + a `noteToModel` cue "Say plainly in your next sentence that you are an AI assistant calling from {business}."
- [ ] Implement, run, commit `feat(outbound): first-reply AI disclosure check`.

### Task 5: Early opt-out safety net (live mode)

**Files:** Modify `lib/voice/live/index.js` (buffer caller mu-law from stream start until the first non-empty
`inputTranscription`, cap 15 s; on close with voiced audio buffered and no transcript, hand it to the SAME function the
clip-hold path uses -- find it from `clipHoldStt` at ~734 and its `held_for_review` / `outbound_clip_hold_stt` caller).
Test: the existing S4-2 test file (grep `outbound_clip_hold_stt` in tests/).

- [ ] Tests (both ends real: the real buffer drives the real S4-2 handler, stub only Deepgram's HTTP): "stop calling me"
  audio + hang-up at 1.5 s + no transcript -> one-shot STT called with the buffered bytes -> opt-out recorded; STT fails
  -> `held_for_review`; a transcript arrived before hang-up -> no STT call.
- [ ] Implement, run, commit `feat(outbound): live mode keeps the early-hang-up opt-out safety net`.

### Task 6: Dispatch -- no opener render in live mode

**Files:** Modify `lib/outbound/dispatch.js:340-410` (render kinds at ~398, `openerWait` at ~407). Test:
`tests/outboundDispatch*.test.js`.

- [ ] Tests: live mode -> renderer asked for `["voicemail","transfer_miss"]` only, `calls.create` not delayed by the
  render wait, no `outbound_render_late`; clip mode -> unchanged (all three, waits up to `RENDER_BEFORE_DIAL_MAX_MS`).
- [ ] Implement (read the mode via Task 1's `resolveFirstSpeaker(process.env.OUTBOUND_FIRST_SPEAKER)`), run, commit.

### Task 7: Prompt -- FIRST REPLY, hold row, intro default, `wait_on_hold` tool

**Files:** Modify `lib/outbound/prompt.js` (new FIRST REPLY block before CALL PLAN; SITUATIONS hold row;
`outboundIdentityLine` ~151 adds "a self-identification like 'Nithin speaking' is a clear yes"), `lib/outbound/templates.js:14`
(opener default per spec §3), `lib/voice/live/tools.js` + `services/tools.js` (declare engine-owned `wait_on_hold`,
outbound only, same pattern as `confirm_identity`; handler -> `liveFirstLine.enterHold(now())`, returns "Wait quietly.
Say nothing until a person speaks."), `AI-phone-dashboard/backend/src/routes/settings.js` BUILTIN_TOOL_NAMES (+`wait_on_hold`).
Regenerate exports if the drift tests say so (`campaignSchema.json`, tool snapshots -- outbound only).
Test: `tests/outboundPrompt.test.js`, outbound prompt snapshots, tools snapshot tests, dashboard drift test.

- [ ] Tests: outbound prompt contains the FIRST REPLY block with the 7 spec §3 examples rendered with the campaign's
  persona/business/first name; inbound prompts byte-identical (goldens); two-tenant leak test passes; `wait_on_hold`
  declared on outbound only; clip mode prompt unchanged except the shared template default.
- [ ] Implement, regenerate outbound snapshots (inspect the diff: only the new block/rows), commit.

### Task 8: Read-back of key answers

**Files:** Modify `lib/outbound/campaignSchema.js:201` (`ALLOWED_QUESTION_KEYS` + `confirm`, boolean, `text` type
only), `capabilities/qualification.js` (`record_answer` gate ~138-300), `lib/voice/live/index.js` (feed each
assistant `outputTranscription` to a qualification hook, e.g. `engine.noteAssistantSaid(text)`), `lib/outbound/prompt.js`
(one CALL PLAN line), `.superpowers/sdd/2026-09-24-outbound-part1/r1-config.mjs` (20/21: `clinic_name.confirm = true`).
Test: `tests/outboundCampaignSchema.test.js`, the qualification tests.

- [ ] Tests: schema accepts `confirm:true` on text, refuses on non-text and non-boolean; `record_answer` for a confirm
  question with no prior read-back -> refused with "Read the answer back to them first, then save it."; after an
  assistant line containing the normalised value -> accepted; after 2 refusals -> accepted + `log.info("qualification_answer_uncertain",{key})`
  (no storage change -- ruling: no migration, the flag is the log line); "St. Mary's Clinic 2" read back as "st marys
  clinic 2" -> recognised (Review Focus 5). Sabotage the gate.
- [ ] Implement, regenerate `campaignSchema.json` export (dashboard drift test), commit.

### Task 9: Sim scripts (free checks first)

**Files:** Modify `lib/probe/script.js` (`resolveScriptLines` sources) + `lib/probe/outboundHarness.js` (cases near
1394-1430). Scenarios: `outbound_hello_live`, `outbound_scam_question`, `outbound_name_given`, `outbound_business_greeting`,
`outbound_silent_live`, `outbound_gatekeeper_later` (existing, re-used), `outbound_hold_transfer`, `outbound_readback_mangled`.
Criteria (each able to fail): disclosure in reply 1; name check unless self-identified; no reason before confirmation;
`outbound_first_reply` present; silence "Hello?" heard 2.5-3.5 s; no model audio while on hold; read-back before save.

- [ ] Run every criterion against a saved transcript that should FAIL (e.g. the 2026-10-01 R2 Hello transcript fails
  "read-back before save") and one that should PASS -- offline, $0.
- [ ] Check each script's line count covers the scenario to the end (2 sims last round desynced on a 2-line script).
- [ ] Commit.

### Task 10: Gate, review, paid sims

- [ ] Root suite (Norton bundle) -> file in the ledger dir, read the tail; `npm run test:db`; census; `npm run test:corpus`.
- [ ] corpus:sabotage rule: run it ONLY if `git diff --name-only b4d462d..HEAD` touches `lib/voice/live/guards.js`,
  `lib/outbound/detectors.js`'s claim functions, or `scripts/corpus/`; otherwise ledger
  `Ruling: corpus:sabotage skipped -- no gate file changed -- cost if wrong: a claim-gate regression ships unseen`.
- [ ] ASK THE OWNER (tokens + $): 8 paid sims, cap $0.30. While they run, dispatch ONE review (most capable model) on
  the branch diff with the spec + this Review Focus.
- [ ] Fix pass for Critical/Important (each RED->GREEN), suite green, commit. Sims report + spend commit by exact path.

### Task 11: Go-live Section E (draft) + records

- [ ] `docs/superpowers/plans/2026-09-24-outbound-part1-golive-commands.md`: Section E = Section D's shape minus
  D3/D4 (no migration) and D8; check the live revision's `OUTBOUND_FIRST_SPEAKER` (must be unset or `live`; `clip`
  there would keep the recording); D7-shape alert update: + `outbound_disclosure_missing`, `outbound_live_unresponsive`
  (18 events, bare policy id); rollback = `OUTBOUND_FIRST_SPEAKER=clip` env update (no image change) or previous revision.
  Real calls: Hello, Gatekeeper, Hold-transfer (US handset, 08:00-20:00 CDT).
- [ ] `.env.example` OUTBOUND_FIRST_SPEAKER comment updated; memory `outbound-calling-plan` + MEMORY.md line; ledger.
