# Speech-to-speech — build handoff

**Written 2026-09-02** at the close of a three-round probe session. Feeds
`docs/speech-to-speech-vendor-analysis.md`, which predates most of this and
whose §9 conclusions are superseded here.

**UPDATED 2026-09-02, after the section 7 step 1 spike.** Nine real calls on a
UK handset through a Twilio leg. Sections 1, 3, 4, 6, 7, 9 and 11 all changed;
three claims below were disproved by those calls and are now in the retraction
table. Spike evidence: `scripts/spike/VERDICT.md` (predictions pre-registered
before the first dial), branch `spike/s2s-bridge`.

**Purpose:** carry the measured facts, the retractions, and the build order into
the implementation session, so that decisions costing $8.62 and three rounds are
not re-derived — and, more importantly, so the conclusions that turned out to be
WRONG are not re-adopted. Several of them looked obvious.

**Evidence:** `scripts/probes/` on `feat/gcp-2`, commits `38f4899` → `d9eb0c7`.
Scripts, raw per-session JSON, spend ledger and three reports are all committed.
Regenerate with `node scripts/probes/report.mjs` / `report-r2.mjs` /
`report-r3.mjs`. Predictions were pre-registered per round in `verdicts*.json`
and never edited: round 1 held 3/8, round 2 held 1/7, round 3 held 4/6 scored.

---

## 1. Where things stand

- **GCP migration is DONE.** Phase 5's last gate — a live call on a UK handset —
  passed on 2026-09-02. The cascade serves from GCP.
- **The section 7 step 1 spike is DONE and it PASSED.** 2026-09-02, nine calls
  on a UK handset through a real Twilio leg. **Echo does not break the
  approach.** The pre-registered rule was P1 and P5; both passed. Score 5 pass,
  1 partial, 1 void, 1 unscorable, ~$0.65. See `scripts/spike/VERDICT.md`.
  The bridge, its Cloud Run service, its secret and its service account were all
  torn down the same day; `lib/voice/resample.js` and its tests survive.
- **The real front-end has NOT been built.** Step 2 is next and is the bulk of
  the remaining 73-134 h.
- **Tier-1 model is DECIDED: Gemini 3.1 Live on AI Studio.** The blocking
  question — whether the AI Studio tier permits training on prompts — was
  checked by the owner on 2026-09-02: **the paid tier does not use data for
  model training.** That was the only thing standing between 3.1's measured
  behaviour and shipping it. See §2.

---

## 2. The open decision: 3.1 vs 2.5

| | Gemini 3.1 Live | Gemini 2.5 native audio |
|---|---|---|
| Surface | **AI Studio only** — API key, no ADC, no VPC-SC, no CMEK | **Vertex** — ADC, enterprise DPA, EEA |
| Region | n/a (external) | `europe-west1` (Belgium) |
| Status | `-preview` | GA |
| Model leg p50 | **1,043 ms**, flat (+22 ms over 12 turns) | 1,050 ms, flat |
| Dropped turns | **0 / 25** | 0 / 25 |
| Tool duplicates (excl. `end_call`) | **0 / 26 trials** | **15 / 29 trials** |
| Doubled utterances | **0 / 90 turns** | **5 / 33 turns (15%)** |
| $/turn | $0.0067 | $0.0049 |

**DECIDED: Gemini 3.1 Live.**

3.1 is behaviourally the clear winner and the one objection to it — that AI
Studio might train on prompts, which would be disqualifying for health data —
was resolved on 2026-09-02: **the paid tier does not use data for model
training.** The project is demonstrably on the paid tier (it has a real Gemini
billing history).

What choosing 3.1 still costs, and what must therefore be recorded rather than
forgotten:

- **US transfer**, not EEA. Lawful with the importer's DPF certification or an
  IDTA / UK Addendum plus a transfer risk assessment — but it needs documenting.
- **No Cloud Audit Logs, no VPC-SC, no CMEK** on the model leg. It is egress to
  a public API.
- **A `-preview` model.** It will move, change, or be withdrawn. This is why the
  client must be swappable (§6).
- **Moving the LLM leg from Vertex to AI Studio is a downgrade in posture.** The
  cascade runs the LLM on Vertex today. Accepting this is a deliberate trade of
  audit surface for measured behaviour, not an oversight.

Neither option offered UK residency anyway — `europe-west2` (London) serves NO
Live model at all (HTTP 400 at the WebSocket upgrade, every candidate model). So
2.5's Belgium endpoint bought an EEA transfer, not a UK one, in exchange for a
model that re-fires tool calls in half its booking trials.

**Revisit if 3.1 ships GA on Vertex** — at that point the trade disappears and
it becomes a config change.

---

## 3. RETRACTED — do not act on any of these

Every one of these was stated confidently during the session and later disproved
by measurement. They are listed because they are the conclusions a fresh reading
of the vendor docs or the early rounds would reach again.

| Retracted claim | What is actually true |
|---|---|
| "Cost decides this" | Cost is a **tie**. It moved three times across two rounds and landed at ~$22/month difference at 1,000 calls. Not a decision input. |
| "OpenAI's `semantic_vad` solves our endpointing failures" | At `eagerness: low` it **holds `no_terminal_punct` for 9,727 ms** — a dead-air hang scored as a pass by a binary check. Neither vendor solves endpointing; both land in the 1.3–2.6 s band `classifyHold` already occupies. |
| "Gemini's latency lead is the model" | It is **endpointing**. Gemini's pure generation is 898 ms, *slower* than OpenAI's single-turn ~790 ms. |
| "3.1 interrupts trailing-off callers, unfixably" | **A configuration choice.** With `automaticActivityDetection: { disabled: true }` it held the turn open through 3,000 ms of silence 3/3 and answered only on our `activityEnd`. |
| "2.5 matches 3.1 on tool reliability" | The assertions were **blind to duplicate calls**. 2.5 scored 15/15 and 20/20 while re-firing tools in half its trials, including one doubled `book_appointment`. Assert call COUNTS, not just presence. |
| "2.5's quality deficit was a six-tool harness artefact" | The *"ignores caller content"* reading was. **The repetition is real** and reproduces across three independent drivers, on audio and text input. |
| "gpt-2.1's latency is tunable via `silence_duration_ms`" | **Disproved.** Endpointing tracked the setting exactly (483 → 201 ms) and the total leg did not improve (1,558 → 1,750 ms). Its latency is generation-bound. |
| "3.1 speaks raw JSON tool blobs" | Artefact of the six-tool harness. **0 leaks in ~90 trials** once all ten tools were declared. |
| "Vendor VAD replaces `classifyHold` / `inboundVad` / `endpointArbiter`" | Under manual activity detection **they survive and stay in control.** Less deletion than the Shape A estimate assumed, but months of tuned behaviour is kept. |
| "Gemini Live native audio does not accept an explicit language code" (section 4, from vendor docs) | **It does.** `speechConfig.languageCode: "en-GB"` was accepted on 9/9 spike calls, no error, no fallback. Accepted is not proof it is honoured — but the claim as written is false, and `mapLanguage()` is not obviously dead code after all. |
| "PSTN echo is the defect that will bite; far-end VAD cannot see it" (section 6's primary justification) | **Echo is real but small.** 40 of 1514 frames during our own playback carried signal, peaking at RMS 211, against `inboundVad`'s 700 floor — about **10 dB of margin**. Neither VAD fired in 9 calls, including an undefended auto-VAD arm. The threat is a thin margin, not a certainty. One handset, one room, one carrier. |
| "No echo reaches us at all — absent at the sample level" (claimed DURING the spike, from a mean of 0) | **Wrong, and disproved within the hour by adding a counter.** The mean was 0 only because 1,474 of 1,514 frames were exactly zero. A mean is the wrong statistic for a signal absent 97% of the time and present in bursts. Log the max and the nonzero count, never a bare mean. |

---

## 4. Measured facts worth carrying

**Latency** — Gemini 3.1: 1,043 ms p50, flat across 12 turns (1,540 → 1,562 ms,
drift +22 ms). gpt-realtime-2.1: 1,558 ms, improves over a call. The
`gpt-realtime-2.1-mini` degrades badly (980 ms turn 1 → 2,748 ms turn 5, still
climbing) and drops ~12% of turns — **excluded from every tier.**

**Tool reliability** (scripted results, real 10-tool declarations):

- gpt-realtime-2.1 **skips `check_appointment_availability` in 9 of 20** T2/T7
  trials — it books without checking. **Forced `tool_choice` closes this: 3/3.**
  Side effects at n=3: the opening turn degrades to filler, and one trial
  produced a doubled utterance it had never shown unforced.
- gpt-realtime-2.1 **misses `end_call` in 2 of 5.**
- **Neither model ever claimed a booking the backend had refused.**
- Gemini 3.1's own defects: one confirmation livelock (three turns re-confirming
  a DOB) and a doubled `end_call` in 2 of 26 trials.

**Region availability** — Vertex serves exactly one Live model
(`gemini-live-2.5-flash-native-audio`) and only in `europe-west1` and
`us-central1`. `gemini-3.1-flash-live-preview` is "Publisher model not found" in
all three Vertex regions and exists only on AI Studio.

**Multilingual** — still untested across languages, but the transport question
is now measured. **`speechConfig.languageCode` IS accepted** by
`gemini-3.1-flash-live-preview`: `en-GB` was set on 9/9 spike calls with no
error and no fallback. The vendor-doc claim that native audio refuses a language
code and only auto-detects is **wrong as written**, so `mapLanguage()` is not
obviously dead and a single-language business may be pinnable at the transport
layer after all. What is NOT established is whether the code changes the output
— accepted is not honoured. gpt-realtime was trained on 98 languages but only
lists those clearing a WER bar; unlisted languages **degrade silently rather
than erroring**.

**Echo, measured 2026-09-02 — this was the spike's whole question.** On a silent
caller with the assistant speaking: 40 of 1514 inbound frames carried any signal
at all, peaking at **RMS 211**. The caller's own speech peaks at 14,334 and
`lib/voice/inboundVad.js` uses a `minRms` floor of **700**. So the carrier's echo
canceller leaks, and what leaks sits roughly **10 dB under the VAD floor**.
Nothing fired in nine calls — including an arm with no gating at all — because
of a margin, not an absence. **One handset, one room, one carrier.**

**Latency with a real PSTN leg** — model leg 880-1140 ms, against 1,043 ms
measured in round 3 with no phone line in existence. The transport cost almost
nothing. What the caller actually feels was 2,246 ms, and the difference is the
bridge's own turn-end timer, not the vendor.

**Transcript lag** — `inputAudioTranscription` arrives **113-360 ms** after
speech end. This is the single most valuable number the spike produced: it is
what makes `classifyHold` and `echoGuard` usable in the real front-end, since
both need text and neither can wait long for it.

---

## 5. Architecture

```
Twilio UK number
    ↓ μ-law 8 kHz, 20 ms frames
Cloud Run · vetra-uk / europe-west2                    ← GCP
    ├─ inboundVad + echoGuard        SURVIVES — gates activityEnd
    ├─ classifyHold                  SURVIVES — decides turn end
    ├─ Live adapter (swappable)      NEW
    │     ↓ PCM16 16 kHz (resampler — Gemini only; OpenAI takes μ-law native)
    │  gemini-3.1-flash-live-preview · AI Studio       ← outside GCP
    ├─ tool bridge → executeToolCall  existing, tenant-scoped, RLS
    ├─ guards (NEW, in the reducer)
    │     · availability invariant
    │     · idempotent tool execution
    └─ audioOut → Twilio             SURVIVES — pacing, marks, clear on barge
Cloud SQL + RLS · Secret Manager                       ← GCP
```

### Fallback tiers — build LAST, not now

| tier | what | trips on |
|---|---|---|
| 1 | Gemini 3.1 Live | — |
| 2a | reconnect / retry tier 1 | transient socket failure, silent response |
| 2b | OpenAI `gpt-realtime-2.1` + narrow forced `tool_choice` | Google outage, quota, preview withdrawal |
| 3 | the existing cascade | both S2S vendors down |

**Design rule: no two adjacent tiers fail for the same reason.** This is why
2.5 is NOT the fallback for 3.1 — same Google infrastructure, correlated
failure, plus its own defects.

---

## 6. Decisions that matter most

**Use manual activity detection — but it is TWO mechanisms, not one, and the
spike proved they have completely different costs.** This section originally
treated them as a single decision. They are:

1. **The half-duplex gate** — do not forward inbound audio while we are
   speaking. **Costs zero latency.** Guards a ~10 dB margin against carrier
   echo leak (section 4). **Keep it**; it is free insurance.
2. **Who decides the turn ended** — the thing that actually costs. The spike
   used a flat 1,200 ms hangover and it cost **~900 ms per turn**: 2,246 ms
   felt, against 1,325 ms in the vendor-VAD arm. **Replace the flat number with
   `classifyHold`**, which prices the wait from what the caller actually said —
   0 ms on a sentence that ends in terminal punctuation, 2,000 ms on a trailing
   conjunction. A caller who speaks in whole sentences then pays nothing, where
   a flat timer charges everyone. This is only possible because transcript lag
   measured 113-360 ms.

`automaticActivityDetection: { disabled: true }` remains correct. The rest of
this section's reasoning stands, with one correction: its primary justification
was echo, and echo turned out to be a thin margin rather than a certainty. Its
turn-taking justification is independent and is the stronger one.

### "But Gemini Live already detects when to step in — why turn that off?"

It does, it is on by default, and in the spike's auto arm it worked: no
misbehaviour the caller could hear, and **900 ms faster** (1,325 ms against
2,246 ms). The question deserves a real answer rather than a re-assertion of
section 6.

**Because it endpoints on SILENCE, and silence does not distinguish these:**

```
"I'd like to book an appointment."          finished    -> answer now
"I'd like to book an appointment for—"      unfinished  -> wait
```

Identical to any timer. Distinguishable from the text. That is the entire
argument, and it is measured: round 3 saw 3.1 cut into a trailing-off caller
**5/5** at default VAD, and still **3/5** at `END_SENSITIVITY_LOW` + 1,200 ms.
Tuning the vendor's detector does not fix it, because the information it needs
is not in the audio timing.

**The honest gap:** the spike tested trail-off only in the MANUAL arm (call 1,
where it held). Nobody has run a trailing-off caller through the auto arm on a
real phone line. The case against vendor VAD rests on round 3's harness, not on
a handset.

**Why manual + `classifyHold` should beat BOTH, and why that is a prediction and
not yet a result:**

`classifyHold` returns **0 ms** for a sentence ending in terminal punctuation —
the common case. Under manual detection the earliest we can classify is when the
transcript lands, measured at **113-360 ms**. Vendor VAD has its own silence
window before it will commit. So for a caller who speaks in whole sentences,
manual + `classifyHold` plausibly answers **sooner** than the vendor's detector,
while still spending 2,000 ms on the fragments that need it.

That is the design bet: **pay only the callers who are actually mid-thought.**
It has not been measured end to end and it is the first thing step 2 should
instrument — with a vendor-VAD arm kept alongside for comparison, because a bet
this clean is exactly the kind this document's section 3 is full of.

- It is what lets **`echoGuard` survive**. Far-end VAD sits at the other end of a
  WebSocket and cannot know that the speech it hears is our own output echoing
  back off a speakerphone. With automatic VAD the vendor reads echo as barge-in
  and cuts itself off — **the exact defect three rounds of live-call debugging
  already identified**, and speech-to-speech does not fix it.
- It removes the trail-off cut-in entirely (measured 3/3).
- It keeps `classifyHold`'s tuned 1,500 / 2,000 ms rules in force.

**Make the model client swappable.** One branch covers both surfaces:

```js
const ai = surface === "vertex"
  ? new GoogleGenAI({ vertexai: true, project, location })
  : new GoogleGenAI({ apiKey: secret("GEMINI_API_KEY") });
```

3.1 is preview; it will move or be withdrawn. Build so that switching is a config
change.

**Declare all TEN tools.** Production unions three builders
(`services/gemini.js:92` — `buildCallTools` + `buildIntegrationTools` +
`buildDbAppointmentTools`). Rounds 1–2 declared only six and every behavioural
observation from them is suspect as a result.

**Guards belong in the reducer, counted.** Not in the prompt — this codebase has
already established that "at most once" in a prompt does not hold.

**Key in Secret Manager**, not `.env`. `scripts/push-secrets.js` already does
this.

---

## 7. Build order

1. ~~**Spike — throwaway bridge, one call on the UK handset.**~~ **DONE
   2026-09-02, PASSED.** Nine calls. Echo does not break it; it sounds good
   ("it sounds amazing"); the felt gap was 2.2 s of which ~1.2 s was our own
   timer. Torn down the same day. Full result and the pre-registered
   predictions: `scripts/spike/VERDICT.md`.
2. Real front-end: manual activity detection, swappable client, all ten tools.
3. Guards: availability invariant + idempotent tool execution.
4. Port the 43-scenario eval to a Live session — see §8; the only instrument
   that measures booking correctness.
5. Fallback tiers, after tier 1 has survived real calls.

### 7a. What the spike is — and is NOT

**"Throwaway" describes the BRIDGE CODE, not the Twilio account.** Use the
existing Twilio account and an existing number. The disposable part is ~200
lines of glue.

One WebSocket endpoint that Twilio `<Stream>` connects to:

```
Twilio <Stream>  →  your endpoint  →  Gemini Live session
                 ←                  ←
```

- receive Twilio media frames (base64 μ-law 8 kHz, 20 ms)
- resample to PCM16 16 kHz
- pipe into a Live session
- pipe the reply audio back as Twilio media frames

**No tools. No database. No tenant logic. No reducer. No guards.** Audio in,
audio out. Throw it away and write the real front-end afterwards.

Why throwaway rather than "the first commit of the real thing": the spike
answers exactly one question — *does echo break this, and does it sound better
on a handset.* Building it properly first means committing to session lifecycle,
error handling and turn management before knowing whether the approach survives
contact with a phone line. If echo wrecks it you delete 200 lines instead of a
week's work.

**Two practical cautions:**

- **Use the right Twilio account.** There are two, and only one whose token GCP
  holds — a number from the wrong one 403s every call. See the Twilio topology
  notes; this is an easy hour to lose.
- **Do not point the clinic's live number at the spike.** `.env` carries
  `LISTENING_TEST_NUMBER` and `PROBE_NUMBER`. Use one of those, or repoint
  outside business hours. A real caller reaching a bare audio bridge with no
  tools and no fallback path is a bad afternoon.

---

## 8. Eval port — scoped, ~17–29 h

Single swap point: `eval/run.js:213`, `createTextSession(...)`. Everything
downstream (45 scenarios, 19 assert helpers, the judge, matrix mode) reads a
`ctx` built from the session's return values.

- Interface to satisfy: `{ sendTurn(text) → {text, toolCalls, toolResults, state,
  timings, usage, finishReason, notes}, getState(), transcript }`
- `applyReplyState` consumes only `reply.{text, intentArgs, endCallArgs,
  capabilityEffects, capabilityState}`
- **Extract** the reply assembly from `getReplyStreaming`
  (`services/gemini.js:1900–2290`) rather than duplicating it, or the two drivers
  drift and the eval silently stops measuring production
- The dynamic-tail problem is already solved: `composeCachedMessage()` exists for
  exactly this (the cached path hit the same constraint)
- Text-in / audio-out is the right tier. Audio-in folds vendor STT errors into
  every result
- **Assert call COUNTS**, not just presence — that omission is what hid 2.5's
  duplicate bookings

---

## 9. Still unmeasured

- ~~**How any of this sounds on a handset.**~~ **MEASURED** — nine calls,
  reported as "it sounds amazing" through 300-3400 Hz.
- ~~**Echo.**~~ **MEASURED** — present, peaking at RMS 211 against a 700 VAD
  floor, ~10 dB of margin. See section 4. **Still open: a SECOND handset.**
  Every acoustic number in this document is one phone, one room, one carrier's
  echo canceller.
- **Whether a pinned `languageCode` changes the output.** It is accepted; that
  is all that is known.
- **Read-back of a caller's own phone number.** The spike's assistant REFUSED
  to repeat a number back. Untestable there — a ten-line prompt, no tools — but
  read-back is not optional (`echoGuard` normalises digit runs specifically to
  recognise a read-back echo). **First thing to check once the real front-end
  can hold a conversation.** Backlog LVX4.
- **Multilingual**, on either vendor, at telephony bandwidth.
- **Booking correctness** — needs the eval port.
- gpt-realtime-2.1's long-reply barge-in, its 12-turn slope, and hold times for
  either finalist. Runs were killed by the environment; the cause was never
  identified.

---

## 10. Compliance — open, and needs a professional

Not legal advice. These are the questions, not the answers.

1. ~~Check the AI Studio tier's data-use terms.~~ **DONE 2026-09-02 — the paid
   tier does not use data for model training.** This unblocked the 3.1 decision.
   Confirm the key's project stays on the paid tier; a lapse to free tier would
   silently change the terms under you.
2. UK GDPR does **not** require UK residency — transfers are lawful with
   adequacy (EEA) or IDTA/UK Addendum + a transfer risk assessment (US).
   Geography is the easy part; **terms are the hard part.**
3. Dental appointments are **special category health data** — needs an Article 9
   condition plus a UK DPA 2018 Schedule 1 condition, wherever processed.
4. Article 28 DPAs with every processor; clinic contracts must permit these
   sub-processors.
5. A DPIA is very likely required.
6. **This exposure already exists.** Caller audio goes to Deepgram (US) and
   ElevenLabs (US) in production today. The S2S decision does not create it — but
   moving the LLM leg from Vertex to AI Studio would be a **regression** in
   posture.

---

## 11. Harness defects found (so they are not repeated)

Six instrument bugs, against roughly four vendor defects. The measurements worth
trusting are the ones that reproduced across independent runs.

1. **Six tools declared instead of ten** — no model could check availability.
2. **Three scenarios under-specified** — both models correctly refused to book
   without required identity and were scored as failing.
3. **An assertion scanned the whole transcript** instead of the final turn.
4. **Raw written only at the end of a run** — seven environment kills lost
   everything. Fixed with per-trial persistence.
5. **A one-trial diagnostic reused the default output tag** and clobbered a
   completed suite. Fixed with `--tag`.
6. **Leak detection looked for JSON and backticks only** — it could not catch
   2.5 speaking the bare word `end_call` aloud, which it did in 2 of 8 turns.

**Five more from the spike harness, 2026-09-02 — against roughly one vendor
observation. The ratio holds: most of what a new instrument measures at first is
itself.**

7. **`usage` overwritten instead of accumulated.** This is **defect #1 above**,
   reproduced by someone who had read this document and the write-up in
   `scripts/probes/lib/geminiUsage.js`. Under-reports a multi-turn call 3-4x.
   **Reuse the instrument; do not re-derive it.**
8. **A metric named `echo_return_loss_db` that measured caller speech**
   leaking into the tail of the playback window. Real numbers, wrong name, and
   it was quoted for five calls before anything caught it.
9. **A bare mean reported over a bursty signal, and a design conclusion drawn
   from it.** The playback-window bucket was zero in 97% of frames; the mean
   read 0 and "no echo exists" was concluded. Adding a nonzero count and a max
   disproved it within the hour. **Never report a mean alone for a signal that
   may be intermittent.**
10. **`noise_floor_db` measured the caller talking**, not the room, so the
    "is it echo or is it ambient" control never existed.
11. **A build-wait loop keyed on "the most recent build" rather than a build
    id**, so it read the PREVIOUS build's terminal status and returned
    immediately. Made twice in one session. Poll the id you created.
