# Speech-to-speech — build handoff

**Written 2026-09-02** at the close of a three-round probe session. Feeds
`docs/speech-to-speech-vendor-analysis.md`, which predates most of this and
whose §9 conclusions are superseded here.

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
- **The speech-to-speech migration has NOT started.** No integration exists;
  every probe was a direct WebSocket with no Twilio leg.
- **Tier-1 model choice is OPEN**, and it is a business judgement, not a
  technical one. See §6.

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

**3.1 is behaviourally the clear winner. 2.5 has the stronger compliance
posture.** Neither offers UK residency — `europe-west2` (London) serves NO Live
model at all (HTTP 400 at the WebSocket upgrade, measured across every candidate
model).

**Decide it by checking the AI Studio tier's data-use terms first** (§6). If
Google may use prompts to improve products on your tier, that is health data and
3.1 is off the table; take 2.5 with the idempotency guard and accept the
repetition.

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

**Multilingual** — untested by us. Vendor docs: Gemini Live native audio
supports ~24 languages and **does not accept an explicit language code** — it
auto-detects. gpt-realtime was trained on 98 languages but only lists those
clearing a WER bar; unlisted languages **degrade silently rather than erroring**.
Consequence: **`mapLanguage()` becomes dead code**, and a single-language
business can only be *asked* in the prompt, not pinned at the transport layer.

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

**Use manual activity detection.** `automaticActivityDetection: { disabled: true }`,
with `echoGuard` deciding when to send `activityEnd`. This is the single most
important design choice:

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

1. **Spike — throwaway Twilio ↔ Live bridge, one call on the UK handset.**
   ~1 day. Answers what $8.62 of probes could not: does echo break it, does it
   sound better through 300–3400 Hz, does 1,370 ms/turn feel like anything.
   **If echo wrecks it, stop here** — a day spent instead of 73–134 h.
2. Real front-end: manual activity detection, swappable client, all ten tools.
3. Guards: availability invariant + idempotent tool execution.
4. Port the 43-scenario eval to a Live session — see §8; the only instrument
   that measures booking correctness.
5. Fallback tiers, after tier 1 has survived real calls.

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

- **How any of this sounds on a handset.** No PSTN leg existed in the harness.
  Band-limiting to 300–3400 Hz may erase every difference measured.
- **Echo.** Every barge trial was a clean synthetic interrupt with no echo path
  in existence. This is the defect that actually bit on live calls.
- **Multilingual**, on either vendor, at telephony bandwidth.
- **Booking correctness** — needs the eval port.
- gpt-realtime-2.1's long-reply barge-in, its 12-turn slope, and hold times for
  either finalist. Runs were killed by the environment; the cause was never
  identified.

---

## 10. Compliance — open, and needs a professional

Not legal advice. These are the questions, not the answers.

1. **Check the AI Studio tier's data-use terms first.** If Google may use prompts
   to improve products on your tier, that is health data and 3.1 is off the
   table. Highest-value hour available.
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
