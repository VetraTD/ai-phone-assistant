# Speech-to-speech probe run — 2026-09-01

Executes `scripts/probes/PLAN.md`. Verdicts were pre-registered in
`verdicts.json` (2026-09-01T20:30:00Z) **before the first run** and are not
edited; every row below prints the prediction beside the result.

**Total spend $1.2977 against the $5.0000 cap.**
All raw output is in `scripts/probes/raw/`, the spend ledger in
`scripts/probes/spend.json`, and every number here is re-derivable by running
`node scripts/probes/report.mjs`.

Prompt under test: the real one — `buildSystemInstruction` +
`buildCallTools` from `services/gemini.js`, 13704 chars,
6 tools, fixture `appointments-availability`
(Brightwork Family Dental).

---

## (a) The five questions, in plain English

### 1. Is it actually faster than our current ~940 ms first-reply time?

**Not at that number — but yes at the number that matters.**

Gemini Live's model leg is **1043 ms p50** (n=25), so measured
literally against the 940 ms `llm_ttfb` baseline it is 103 ms
*slower*, and V1 fails.

That comparison is not like-for-like, and the honest reading is the opposite.
`model_leg_ms` here is *last caller speech frame → first model audio byte*, so
it already contains the vendor's endpointing wait and its speech generation. In
the cascade those are three separate charges: ~500 ms of STT endpointing, then
940 ms of LLM, then TTS time-to-first-byte (92 ms on the old path, **1,408 ms**
as measured after the GCP move). The cascade's own end-to-end baseline is
**2,607 ms voice-to-voice**.

So one vendor round trip replaces roughly 1,440–2,850 ms of cascade with
**1043 ms**. On a whole turn that is a real win of well over a second. It is
just not a win against the single 940 ms slice, and anyone quoting "faster than
940" would be wrong.

Two further things the numbers say plainly:

- **Every call still pays a tool round trip on turn 1.** The real prompt tells
  the model to call `set_call_intent` as soon as it understands the caller, and
  both vendors did exactly that on the opening turn, then blocked until answered.
  `VOICE_INTENT_MARKER` exists to remove that round trip in the cascade, and the
  problem survives the migration unchanged.
- **What that round trip *costs* is unresolved, and the two runs disagree.** In
  the first L1 run tool turns were clearly slower (p50 ~1,690–1,780 ms against
  ~1,030 ms plain). In the re-run after the usage fix they were not
  (1070 ms tool against 1013 ms plain). Same fixtures, same
  prompt, N=5 each. Two runs of five giving opposite answers is precisely the
  pattern the explicit-cache probe produced, so **do not quote a tool-turn
  penalty from this run in either direction** — it needs a dedicated arm.
- **OpenAI mini is the slowest of the three**, at 1983 ms p50 — +90%
  against Gemini. The full model is faster than the mini (1375 ms) and more
  reliable with it.

### 2. Does it stop talking when someone interrupts, and how fast?

**It signals fast enough to act on. Whether it "stops" is not answerable here,
and that distinction is the whole finding.**

Gemini raised `serverContent.interrupted` on **5/5**
barge-ins (10/10 across both independent runs) at **490 ms p50**.
V2 passes: the reported Gemini barge-in bug does not reproduce for us. V3 fails:
490 ms is slower than the cascade's measured 340 ms trade.

OpenAI detects the caller at a comparable **445 ms**
but cancelled the in-flight response in only 2/5 trials.
Before calling that a defect, the cross-check: in just
1/5 trials was OpenAI's audio *still arriving*
when it noticed the caller — and that trial was cancelled. In the rest the reply
had already finished streaming, so there was nothing to cancel and the "miss" is
correct behaviour, not a defect. **The 2/5 headline is not a failure rate.**

Now the caveat that matters more than either number, because it cuts against the
verdict I just recorded as a pass:

**Gemini's audio stream had already stopped before the `interrupted` signal
arrived, in 5/5 trials** —
generation ended around 404 ms
and the signal landed ~490 ms. Positive proof the barge
actually *halted* generation, rather than the reply merely finishing first,
exists in **2/5** trials, where the reply is
cut off mid-sentence ("Are you a new or existing" with no "patient?"). The other
replies completed normally.

So the scripted replies — two to three seconds — were often over before the
interrupt mattered. **The case that actually hurts on a real call is a caller
cutting into a long answer, and this run never tested it.** V2 and V3 should be
read as measurements of *signal timing*, which they do establish, and not as
proof that either vendor reliably kills a long in-flight reply.

And in this harness there is no playout queue, so nothing here can tell you what
a caller would have *heard*. Clearing the queue is our job, not the vendor's.

### 3. Does OpenAI's semantic_vad wait for callers who trail off mid-sentence?

**On two of our three failure cases, perfectly. On the third it is worse than
useless, and no eagerness setting fixes it.**

| fixture | low | medium | high |
|---|---|---|---|
| `no_terminal_punct` ("Next Tuesday afternoon works") | 5/5 waited | 5/5 | 5/5 |
| `trailing_lead_in` ("It's for, uh") | 2/5 waited | 0/5 | 0/5 |
| `partial_digits` ("My number is five five five, two") | 5/5 waited | 5/5 | 5/5 |

"Waited" means the vendor did **not** end the turn inside the window our own
`classifyHold` already charges for that rule (1,500 ms, or 2,000 ms for
`trailing_lead_in`).

`partial_digits` is the encouraging one: a caller stopping halfway through a
phone number is held every single time, at every eagerness. That is the case the
cascade loses a phone number on.

`trailing_lead_in` is the problem. At `medium` and `high` it cuts in
**10/10**, and even at `low` it cuts in half the time (5/10 pooled across both
runs). A caller saying "It's for, uh —" gets interrupted. V4 fails on that cell,
and since `low` is already the most patient setting, there is no knob left.

### 4. Does Gemini's text-reseed cost fix preserve a hard-to-spell name exactly?

**Yes — 5/5, and 10/10 across both runs.**

After discarding the audio session and reseeding history as text, the model
spelled the name back as `N I T H I N` every single time. V6 passes, and the
economic case for LV2 survives its most dangerous test.

The more interesting result is underneath it. **Gemini's own input transcription
rendered the name as "Nitin" in 5/5 trials** —
the same class of error that made Google STT return niton / nithan / Nathan on a
real handset and never once "Nithin". What saved the read-back is that the
caller *spelled it out loud*, and the letters survived where the name token did
not. So speech-to-speech does not fix our name-accuracy defect; it inherits it.
Anything that depends on hearing a name correctly the first time is no safer
after this migration than before it.

One honest note on the instrument: the first scoring pass reported 0/5 because
the letter extractor swept up every single-letter word in the sentence and
scored a correct "n i t h i n" as "NITHINI". The model was right and the
measurement was wrong. It was re-scored from the saved transcripts
(`rescore-l4.mjs`) without new API calls, and the extractor now takes the
longest contiguous run of single letters.

### 5. Does Gemini Live work at all in europe-west1?

**Yes. 5/5 sessions, all four turns, no silence.**

`gemini-live-2.5-flash-native-audio` on Vertex in project `vetra-uk-edc8ca`,
location `europe-west1`, model leg p50 **1053 ms** — the fastest
of anything measured tonight. The reported turn-2 silence did not reproduce
once. V7 passes, and the residency gate does **not** eliminate Gemini.

Project discipline, since this is the trap that has caught this work before: the
machine's ADC quota project was `physicianmessagingapp` at the start of the
session. `project` and `location` are passed explicitly in
`l5-vertex-eu.mjs` and printed before any spend, so nothing here inherited it.

---

## (b) Pre-registered verdicts

| ID | Prediction (locked 2026-09-01) | Result | Verdict | Cost |
|---|---|---|---|---|
| **V1** | Gemini model leg p50 < 940 ms | 1043 ms (n=25) | **FAIL** | $0.3590 |
| **V2** | serverContent.interrupted fires on >=4 of 5 barge-ins | 5/5 (10/10 across both independent runs) | **PASS** | — |
| **V3** | barge-in stop latency < 340 ms | 490 ms p50 | **FAIL** | — |
| **V4** | at eagerness low, no cut-in on no_terminal_punct / trailing_lead_in in >=4 of 5 | no_terminal_punct 5/5 waited (PASS); trailing_lead_in 2/5 waited (FAIL) | **FAIL** | $0.2843 |
| **V5** | OpenAI mini model leg p50 < Gemini's (V1) | 1983 ms vs Gemini 1043 ms — +90% | **FAIL** | — |
| **V6** | name read-back exact-matches ground truth 5/5 | spelling exact 5/5 (10/10 across both runs) | **PASS** | $0.3288 |
| **V7** | turn-2 silence does NOT reproduce | 5/5 runs fully working, all 4 turns; reproduced: false | **PASS** | $0.1987 |
| **V8** | measured cost/call within +/-25% of the analysis doc's modelled figures | Gemini 19 turns, OpenAI mini 22 turns, OpenAI full 19 turns — vs a 12-turn call, all 35-45% low | **FAIL** | $1.2977 |

**3 of 8 predictions held.** Notes:

- **V1** — model_leg_ms includes the vendor's own endpointing wait, which the 940 ms llm_ttfb baseline excludes — see question 1. Plain turns p50 1013 ms vs tool turns 1070 ms in this run, but the first L1 run put tool turns ~650 ms slower; the two runs disagree and neither figure should be quoted.
- **V2** — The reported Gemini barge-in bug does NOT reproduce for us.
- **V3** — Signal latency, not stop latency: there is no playout queue in this harness. See section (c).
- **V4** — The prediction names both fixtures, so one failing cell fails the verdict. Pooled across both L2 runs: no_terminal_punct 10/10 waited, trailing_lead_in 5/10.
- **V5** — OpenAI mini also produced 2 turns with no audio at all and 1 turn credited to the wrong window; Gemini produced 0 and 0.
- **V6** — Vendor STT transcribed the name itself as "Nitin" in 5/5 — the spelled-out letters carried what the transcript lost.
- **V7** — project vetra-uk-edc8ca, location europe-west1. Model leg p50 1053 ms.
- **V8** — The doc's absolute figures are only reproducible if a 3-minute call is ~19-22 turns; at a 12-turn call all three vendors land 35-45% below. More important: the measured RANKING is reversed — see section (b) note.

### V8 in detail — the cost model

Measured per-turn cost, real prompt, from `spend.json`:

| Vendor | measured $/turn | 12-turn call | 19-turn call | doc's model-only figure | turns implied by doc |
|---|---|---|---|---|---|
| Gemini Live 3.1 flash | $0.0067 | $0.0800 | $0.1266 | $0.1235 | 19 |
| OpenAI gpt-realtime-2.1-mini | $0.0048 | $0.0578 | $0.0915 | $0.1055 | 22 |
| OpenAI gpt-realtime-2.1 (full) | $0.0184 | $0.2205 | $0.3491 | $0.3495 | 19 |

The doc's per-call figures are quoted all-in including Twilio carriage at
$0.0255; these probes have no Twilio leg, so the comparison is
against the model-only remainder.

Two findings, and the second matters more than the verdict:

1. **The doc's absolute numbers embed an unstated turn count.** They reproduce
   only if a 3-minute call is ~19–22 turns. At a 12-turn call all three vendors
   land 35–45% below the modelled figure. That is outside ±25% either way, so
   V8 fails — but the doc is internally consistent, not wrong, and the fix is to
   state the turn assumption rather than re-derive section 4.

2. **The measured ranking is reversed.** OpenAI mini costs
   $0.0048/turn against Gemini Live's $0.0067 — the mini is
   **28% cheaper per turn**, before any reseed work. The
   mechanism is visible in the usage records: OpenAI billed ~22,800 cached text
   tokens against ~1,400 uncached, while **Gemini's `cachedContentTokenCount`
   measured exactly zero on every Live session**. OpenAI caches the prefix by
   default at a 10x discount; Gemini Live does not cache it at all.

   This is the same "prefix is 85% of the bill" problem the text reseed (LV2)
   was designed to solve — except OpenAI already solves it, automatically, with
   no reseed machinery, no `historyTrim` rework and no risk to a caller's name.
   **The entire economic argument for Gemini Live + reseed rests on a
   disadvantage that OpenAI does not have.**

---

## (c) Module fate

Per vendor, against the inventory at the end of `PLAN.md`. Nothing here moves
the 73–134 h Shape A estimate much: that number is the cost of *writing* the new
front-end, tool bridge, reseed and eval harness. Deletion is the cheap part.

### `lib/voice/turnManager.js` — 667 lines — **SURVIVES, reduced**

V2 and V3 decide this file and they split.

**V2 passed.** Gemini signals `interrupted` 10/10 at ~490 ms, and
OpenAI cancels correctly whenever there is anything to cancel. So the part of
`turnManager` that *detects* a barge-in from our own VAD and decides a turn has
ended is genuinely replaceable. That is real deletion.

**But V2 is weaker evidence than its 10/10 suggests.** Only
2/5 trials show a reply actually truncated
mid-sentence; in the rest the short scripted answer had finished streaming before
the signal arrived. Interrupting a *long* reply — the case that hurts on a real
call — was never exercised. Before deleting detection logic on the strength of
V2, run a barge arm against a deliberately long answer.

**V3 failed, and it fails in a way that keeps the file.** 490 ms is
slower than the cascade's 340 ms trade, and more importantly the vendor's signal
arrives *after* it has already stopped generating. Something on our side still
has to own the playout queue: stop feeding Twilio, issue `clear`, discard the
frames already buffered, and hold the post-barge settle window before accepting
the next turn. No vendor event does that, because no vendor knows the queue
exists.

Verdict: **turnManager shrinks, it does not vanish.** The VAD/endpoint decision
logic goes; the queue and settle-window state machine stays. Do not book 667
lines of deletion against the Shape A estimate — book a rewrite of roughly the
back half.

### Both vendors — genuinely replaced

| Module | Lines | Evidence from tonight |
|---|---|---|
| `sttDeepgram` + `sttGoogle` + `sttStream` | 1,407 | Both vendors returned caller transcripts inline. Confirmed. |
| `ttsStream` + `elevenlabs` + `googleTts` + `ttsHealth` | 1,124 | Both returned speech directly. Confirmed. |
| `speakableText` | 693 | No text→TTS step exists in either path. Confirmed. |
| `endpointArbiter` | 176 | Superseded by vendor VAD on both. Confirmed — and it never ran on a real call anyway. |
| `utteranceCache` | 103 | Nothing to cache without synthesis. Confirmed. |

### `geminiCache` — 412 lines — **delete on Gemini, and note why**

Measured `cached_in` was **0 on every Gemini Live session tonight**, confirming
the earlier finding. The module is dead on a Gemini S2S path. On an **OpenAI**
path it is dead too, but for the opposite reason: OpenAI caches the prefix
automatically and better than we could. Either way: delete.

### Both vendors — survives, and the reason is unchanged

| Module | Lines | Why the probes do not touch it |
|---|---|---|
| `echoGuard` | 365 | **Not decided by this run, deliberately.** Vendor VAD sits at the far end of a WebSocket and cannot know that the speech it hears is our own output echoing back off a speakerphone through the PSTN. Every barge-in trial here was a clean synthetic interrupt with no echo path in existence. Three rounds of live-call debugging established cutoffs were echo, not endpointing; nothing tonight speaks to that. |
| `inboundVad` | 193 | Shrinks, does not vanish — it feeds echoGuard's energy signal, and that consumer is untouched. |
| `audioOut` | 424 | Reinforced by V3: pacing, marks and `clear` on barge-in are exactly what the vendor signal does not do. |
| `mulaw` | 100 | Twilio speaks μ-law. OpenAI takes it natively; **Gemini does not** — see the integration-tax note below. |
| `fallbackFlow` | 360 | Matters more. OpenAI produced 2 turns with no audio at all out of 25 tonight. |
| `promiseGate` | 132 | Behaviour, not transport. Untouched. |
| `historyTrim` | 99 | Central on a Gemini path (it is what reseeding needs); much less load-bearing on OpenAI, which caches the prefix itself. |
| brain (`tools`, `replyState`, `appointments`, `notifications`, `llmTurn`) | ~1,900 | Untouched, and tonight is evidence *for* it: both vendors called our real tool declarations correctly and blocked until answered. |
| `metrics` | 595 | Rewired, not deleted. |

### The integration tax, measured rather than estimated

OpenAI accepts `audio/pcmu` in **and** out — the fixture bytes go to the vendor
untouched, exactly as they arrive from Twilio. Gemini Live requires PCM16 at
16 kHz, so every Gemini path needs the decode-and-upsample in
`scripts/probes/lib/audio.js` on every frame in both directions. That is a real,
permanent difference in favour of OpenAI, and it is the 6–10 h resampling tax the
analysis doc claimed, now observed rather than assumed.

---

## (d) What this run cannot tell you

Unchanged from PLAN.md, and worth repeating before anyone acts on the numbers:

- **Nothing about how either vendor sounds on a handset.** No PSTN leg.
  Band-limiting to 300–3400 Hz may erase the difference entirely. Needs a real
  call, a UK number, and your ears.
- **Nothing about true voice-to-voice.** Model leg only. The metric is named
  `model_leg_ms` everywhere for that reason.
- **Nothing about booking correctness or conversation quality.** Tool results
  were canned successes returned instantly; the model never saw a refusal or a
  vanished slot. That is the 43-scenario eval's job.
- **Nothing about real callers.** Ten fixtures is not a distribution.
- **Nothing about echo.** See `echoGuard` above.

### Deviations from the plan, recorded

1. **Business hours overridden to 24/7.** The fixture ships Mon–Fri 09:00–17:00
   America/Chicago and the run happened at ~01:30 local, so every conversation
   took the after-hours message path instead of the booking path the caller
   fixtures were written for. Only the hours were changed; the prompt is still
   built by the real `buildSystemInstruction`.
2. **L4 turn 6 is a text turn.** No caller fixture asks for a spelling
   read-back. What is under test is whether the reseed carried the name, not how
   the question arrived.
3. **"Cut-in" needed a definition.** PLAN.md does not pin one down, so it is
   `response.created` arriving inside the window `classifyHold` already
   charges for that rule. That makes the arm answer "would the vendor wait as
   long as our own rule does?".
4. **ElevenLabs A/B skipped.** The API key lacks the `user_read` permission, so
   the quota check returned `HTTP 401 missing_permissions` and could not be
   performed. Your instruction made the run conditional on checking quota first,
   and a run that exhausted quota mid-way would have fallen back to Google TTS
   and poisoned the samples. Fix is one line: grant `user_read` to the key and
   re-run `node scripts/voice-ab.js`.
5. **Two harness bugs were found and fixed mid-run, both of which had produced
   wrong answers.** Recorded because they are the same class of error the plan's
   method rules exist to catch:
   - *Turn boundaries.* Advancing on `turnComplete` / `response.done` let the
     previous reply's audio tail land in the next turn's window, producing
     model legs of −1,800 ms and, on L5, a turn 2 whose "reply" was a fragment
     of turn 1. Read naively that would have scored **V7 a pass on turn-1
     audio**. Boundaries are now a quiet period.
   - *Usage accounting.* Gemini emits `usageMetadata` per turn, not cumulatively.
     Keeping the last message under-reported a 5-turn conversation ~3x, which
     also meant the $5 cap was being enforced against the wrong number. All
     Gemini probes were re-run after the fix; every figure above is post-fix.

---

## Spend

| Probe | Cost |
|---|---|
| L0 (harness validation) | $0.0089 |
| L1 | $0.3590 |
| L2 | $0.2843 |
| L3 | $0.1180 |
| L4 | $0.3288 |
| L5 | $0.1987 |
| **Total** | **$1.2977** |
| Cap | $5.0000 |
| Headroom | $3.7023 |

178 billed sessions. Rate card in `lib/spend.js` from the
analysis doc section 4.1; OpenAI **text**-modality rates are not in that table and
are marked `assumed` there — they affect the OpenAI figures slightly and the
audio-dominated conclusions not at all.
