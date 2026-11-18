# `gemini-3.8-live` — full architecture and analysis

Written 2026-09-16. The companion to `docs/gpt-live-analysis.md`.

**Unlike that document, this one is not mostly vendor claims.** We have run
**98 sessions** on this model across seven gates. Where a number here is
measured it says so; where it is Google's, it says that too.

---

## 1. What it is

A **native speech-to-speech** model. Audio goes in, audio comes out, with no
transcribe→think→speak chain in the middle. That is the same architectural
family as GPT-Live and the opposite of our current cascade (Deepgram → Gemini →
ElevenLabs).

Three properties define it, all **permanently on** — there is no flag to
disable any of them:

- **Full duplex.** It can listen while speaking.
- **Interleaved reasoning.** It thinks between and during turns.
- **Asynchronous function calling.** `NON_BLOCKING` is now the *default*; the
  model keeps generating while a tool runs.

It is **based on Gemini 3 Pro** (DeepMind model card), with a **January 2025
knowledge cutoff** — so, like GPT-Live, it knows nothing current and everything
factual must come from tools.

GA **2026-09-15**. One day old when we measured it.

---

## 2. The model family

| model | role | notes |
|---|---|---|
| **`gemini-3.8-live`** | the one we tested | 131,072 in / 65,536 out. **Rejects `thinkingLevel`.** |
| **`gemini-3.8-live-extended-thinking`** | higher reasoning budget | **Requires `thinkingConfig.thinkingLevel`** (`low`/`medium`/`high`; `minimal` unsupported). Measured worse for us — see §11. |
| `gemini-3.5-transcribe-live` | streaming ASR, separate | **custom vocabulary up to 1,000 terms**, 85+ languages, 4.0% streaming WER |
| `gemini-3.1-flash-live-preview` | **what we run in production today** | preview, sync-only tools, the trail-off defect |
| `gemini-live-2.5-flash-native-audio` | the residency-capable fallback | on Vertex `europe-west1`, GA, async tools |

**The two 3.8 variants are not interchangeable by model id.** Measured directly:

```
gemini-3.8-live-extended-thinking  {}                          FAIL  "Thinking level must be specified for this model."
gemini-3.8-live-extended-thinking  {thinkingLevel:"high"}      OK
gemini-3.8-live                    {}                          OK
gemini-3.8-live                    {thinkingLevel:"high"}      FAIL  "Thinking level is not supported for this model."
```

A probe that only swaps the model string silently fails on one of the two.

---

## 3. Transport and architecture

**Stateful WebSocket (WSS).** Not REST, not WebRTC — one long-lived bidirectional
socket per call. Two deployment shapes:

- **Server-to-server** — our backend holds the socket. This is what we do: Twilio
  media stream lands on our server, we forward frames. Keeps the API key server-side.
- **Client-to-server** — a browser connects directly. Lower latency, but needs
  **ephemeral tokens** in production so the real key never reaches the client.
  Irrelevant to a phone line.

Partner integrations exist for Agora, Fishjam, LangChain, **LiveKit**, **Pipecat**,
Vercel and Vision Agents. We use none of them — `@google/genai`'s `live.connect()`
directly.

---

## 4. Session lifecycle

```
connect  ──▶ setup            (model, config, tools, systemInstruction)
         ◀── setupComplete
         ──▶ realtimeInput    (audio chunks, continuous)
         ◀── serverContent    (modelTurn.parts[].inlineData = audio)
         ◀── serverContent    (inputTranscription / outputTranscription)
         ◀── toolCall         (functionCalls[])
         ──▶ toolResponse     (functionResponses[])
         ◀── generationComplete
         ◀── turnComplete
         ◀── goAway           (connection about to end, carries timeLeft)
         ◀── sessionResumptionUpdate (handle for reconnect)
```

**Hard limits, from Google's docs:**

| | |
|---|---|
| audio-only session | **15 minutes** without compression |
| audio + video session | 2 minutes without compression |
| single connection lifetime | **~10 minutes** |
| session resumption token validity | 2 hours after termination |

**This matters for a phone line.** A 15-minute cap is fine for a receptionist —
our calls are 2–4 minutes — but the **~10-minute connection lifetime** means a
long call will get a `goAway` and need resumption mid-call. Our current Live
front-end does not handle that.

**Context window compression** (`contextWindowCompression`, sliding window with
a configurable trigger) extends sessions indefinitely. Note the standing warning
from our own earlier work: compression's *saving* and *forgetting* are the same
dial — at `triggerTokens: 3100` the model retained about one turn.

---

## 5. Audio — and this is where it beats GPT-Live for us

| | in | out |
|---|---|---|
| **Gemini Live** | **PCM16, 16 kHz, LE** | **PCM16, 24 kHz** |
| GPT-Live | μ-law 8 kHz (`audio/pcmu`) | μ-law 8 kHz |
| Twilio | μ-law 8 kHz | μ-law 8 kHz |

On paper GPT-Live wins — it speaks Twilio's format natively and Gemini needs
resampling in both directions.

**In practice we already built that resampling.** `lib/voice/resample.js` has
`mulaw8kToPcm16k` (:146), `createDownsampler` (:86, 63-tap Hamming sinc, exact
3:1 decimation) and `createFramer` (:171), all running in production today on
the 3.1 path. The "6–10 hours of new hot-path DSP" that
`docs/speech-to-speech-vendor-analysis.md` §2.2 priced as Gemini's integration
tax **is already paid**.

So the tax inverts: choosing GPT-Live means *deleting* working DSP and writing a
new vendor client; choosing 3.8 means changing a model string.

---

## 6. Turn-taking and VAD

Three modes, configured under `realtimeInputConfig.automaticActivityDetection`:

- **Automatic (default)** — server-side VAD decides when you stopped.
- **Hybrid** — server detects speech start, the client signals the end with
  `audioStreamEnd`.
- **Manual** — `disabled: true`, and the client sends `activityStart` /
  `activityEnd` itself.

Tunable parameters:

| field | default | what it does |
|---|---|---|
| `startOfSpeechSensitivity` | — | how eagerly it decides you started |
| `endOfSpeechSensitivity` | — | how eagerly it decides you stopped |
| `prefixPaddingMs` | ~20 ms | audio buffered before speech is detected |
| `silenceDurationMs` | **~800 ms** | silence that ends your turn |

**Interruption** arrives as `serverContent.interrupted: true`, and **pending
function calls are cancelled** when it fires. The client must stop playback and
clear its queue.

**Measured, and this is the headline:** 3.8 **never cut into a trailing-off
caller — 0 of 10, twice, 20 sessions, on two independent detectors.** Our
production 3.1 does it 5/5 at default and 3/5 at its lowest setting, and it is
the single defect that makes 3.1 unusable. It is a **3.1 defect, not a Gemini
defect** — 2.5 holds 10/10 and 3.8 holds 10/10.

---

## 7. Tools and asynchronous function calling

**There is no automatic tool handling.** `toolCall` arrives, you execute, you
send `toolResponse`. Same shape our `services/tools.js` already serves.

**`NON_BLOCKING` is the default on 3.8.** On 3.1 it did not exist at all — this
is the single biggest behavioural change in the upgrade. The model does not wait
for your tool to return.

**Response scheduling**, set on the `FunctionResponse`:

| mode | behaviour |
|---|---|
| `INTERRUPT` | stop what you are saying, deliver this now |
| `WHEN_IDLE` | queue it until the current turn finishes |
| `SILENT` | absorb it as knowledge, say nothing |

Supported on 3.8: function calling (async by default, sync still available for
back-compat), **search grounding**, thinking. **Not** supported: code execution,
URL context, structured outputs, caching, Maps grounding, batch.

### The async race, measured

Async-by-default is exactly our oldest unfixed defect restated as a platform
property — the assistant naming a time before the diary has answered. I
pre-registered that 3.8 would **fail** this.

**It did not. 0 of 9 stated a clock time during a 1,200 ms held lookup, silent
every time.** Not chatty dead-air filler either — actually silent.

### The defect it does have

**It re-fires tools.** `check_appointment_availability` called twice inside a
single caller turn in **2 of 5** takes — Gemini 2.5's shape, not 3.1's batching.
On T3 it averaged 1.00 availability calls per write, so it is not universal, but
it is real and it costs time: affected takes ran 4,475 ms against ~1,050 ms.

`turnComplete` arrives after a tool call at a **median of 17 ms** — against 2.5's
914 ms and 3.1's 6,750 ms. That matters because `lib/voice/live/index.js:3764`
resets `toolRoundsThisTurn` below a `if (!sc.turnComplete) return;` line, so a
model that withholds `turnComplete` on tool turns never resets the counter. 3.8
does not withhold it.

---

## 8. Configuration surface

```js
{
  responseModalities: [Modality.AUDIO],        // native audio: AUDIO only
  systemInstruction: { parts: [{ text }] },
  tools: [{ functionDeclarations: [...] }],
  inputAudioTranscription: {},                 // caller text
  outputAudioTranscription: {},                // assistant text
  speechConfig: {
    voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
    languageCode: "en-GB",                     // see caveat
  },
  realtimeInputConfig: { automaticActivityDetection: { ... } },
  contextWindowCompression: { slidingWindow: {}, triggerTokens: N },
  sessionResumption: { handle },
  // thinkingConfig: ONLY on -extended-thinking, and REQUIRED there
}
```

**Voices — measured on our key, all 8 tested resolve on 3.8:**
`Kore`, `Aoede`, `Puck`, `Charon`, `Leda`, `Fenrir`, `Zephyr`, `Orus`.
**Kore works**, which is the one that matters: the owner chose it by phone on
2026-09-05 after rejecting Aoede on a real call.

**Language caveat.** Native-audio models infer output language themselves and
the docs say you cannot pin it. Our own prior finding stands and is worth
repeating: `language_pinned` refers to the **output voice**, never the caller's
input language, and that has already misled two readers.

**Removed in 3.8, relevant if we ever set them:** `thinking_level` (rejected),
**affective dialog removed entirely**, and **proactive audio is now on by
default** — the model may decline to respond to speech it judges isn't addressed
to it. That last one is worth watching on a phone line with background noise.

---

## 9. Pricing

| | rate |
|---|---|
| audio input | **$0.005 / min** |
| audio output | **$0.018 / min** |
| derived from | $3 / 1M input, $12 / 1M output — the same per-token audio rates as 2.5 |

**Measured on our own conversational gate**, which is the number to trust:

| config | $/session | $/min | 3-min call |
|---|---|---|---|
| **`gemini-3.8-live`** | **$0.094** | **$0.041** | **$0.12** |
| `gpt-live-1` + `gpt-5.6-terra` | $0.131 | $0.066 | $0.20 |
| `gemini-3.8-live-extended-thinking` | $0.202 | $0.070 | $0.21 |

Against today's cascade at ~$0.130/call, **3.8 is cheaper than what we run now**
— the first time in this whole vendor exercise that has been true.

---

## 10. Limits

- **Context:** 131,072 input / 65,536 output tokens.
- **Rate limits** are per-project across RPM / TPM / RPD and scale with the paid
  tier. Google does not publish a concurrent-Live-session number the way OpenAI
  does (25 on Tier 1, 500 on Tier 5) — **this is an open item before launch**,
  and `docs/capacity.md` already records that our binding cap today is
  ElevenLabs at 10 concurrent.
- **Residency: none.** See §12.

---

## 11. What we measured — 98 sessions

| gate | result |
|---|---|
| **trail-off** | **0 cut-ins of 10**, twice, both detectors |
| **tool loop** | `turnComplete` 5/5 after tool calls, median **17 ms**; **re-fires a tool 2 of 5** |
| **booking correctness** | reached a write **12/15**; **0 fabricated times, 0 fabricated fields**; availability checked **1.00× before every write** |
| **refusal honesty** | told the caller the truth **4 of 4**; claimed success after a refusal **0**; retried the other slot twice unprompted |
| **claimed completion before the write landed** | **0** |
| **agentic multi-step** | cancelled three and rebooked **10/10**; **acted on an unread record 0/10**; **misreported a refused cancel 2 of 10** |
| **async race** | stated a slot during a held lookup **0 of 9** |
| **transcription** | median WER **0.000** normalised (0.091 raw), 8/10 perfect |
| **repetition** | `max_repeat` **2** (Gemini 2.5 hits 7, GPT-Live 3) |
| **exact sentence** | **0.75** overall; recording disclosure **4/4 VERBATIM** |
| **stream shape** | speech:stream ratio **0.851** — turn-based, stops when it stops |
| **turn latency** | p50 **1,277 ms** (inflated by this machine's TLS interception) |
| **errors / disconnects** | **0 in 98 sessions** |

**Two things it does badly**, both real:

1. **It misreported a refused cancellation, 2 of 10 pooled.** *"I have
   successfully cancelled all three of your scheduled appointments"* — the third
   had returned `{ok:false}`. This is a **claim** defect, not a **write** defect.
2. **It re-fires tools**, 2 of 5.

**One property worth stating plainly:** across every session in the round, on
three model variants, **nothing wrong was ever written and no record was ever
acted on that had not been read**. Zero fabricated times, zero fabricated
fields, zero unknown ids. Every failure was a *sentence*, never the *database*.

### The transcription number needed fixing before it was fair

Raw WER said 0.091. Three of five non-zero scores were **number formatting, not
mishearing**:

```
truth  "It's five five five, one two three four."
heard  "It's 5551234."          raw WER 0.875, normalised 0.000
```

3.8 turns spoken numbers into digits. For a receptionist taking a phone number
that is the **better** behaviour, and GPT-Live only scored 0.000 because it
happened to write the words out. Normalised, the two are equal.

---

## 12. Residency — the disqualifier, verified

**Neither 3.8 variant is on Vertex, in any region we can reach.** Measured
2026-09-16 against `vetra-uk-edc8ca`:

| model | europe-west1 | europe-west2 | us-central1 | global | AI Studio |
|---|---|---|---|---|---|
| `gemini-3.8-live` | not found | timeout | not found | not found | **OK** |
| `gemini-3.8-live-extended-thinking` | not found | timeout | not found | not found | **OK** |

The DeepMind model card lists "Vertex AI" among Extended Thinking's distribution
channels. **That is not true for our project** — rollout lag or an allowlist,
either way it is not available to us today and it should be re-checked before
any launch decision, because it is the one fact that would change the answer.

So **3.8 carries exactly the same residency disqualifier as the 3.1 it would
replace**: AI Studio only, global endpoint, no ADC, no VPC-SC, no CMEK, no
regional processing.

This is not fatal on its own — UK GDPR permits transfers under SCCs + the UK
Addendum plus a Transfer Risk Assessment, and the owner's position is that
residency is a go-live checklist item rather than a build constraint. But it
means **the residency story does not improve by moving to 3.8**, and if
residency hardens before signing, the choice collapses to GPT-Live on an
EU-pinned project or `gemini-live-2.5-flash-native-audio` on Vertex
`europe-west1`.

---

## 13. Known issues in the wild

The dominant complaint across GitHub and Google's own forums is **WebSocket
close 1011, "Internal error encountered"**, mid-session:

- Reported killing sessions **90–120 seconds in**, most consistently on
  **audio + video** streams.
- Reported during **tool execution**, losing the whole conversation.
- **Session resumption is reported to poison the restored context** — resumed
  sessions then die within ~0.5 s of the next user utterance.
- ADK users report they cannot do cross-connection resumption at all; every
  reconnect starts a fresh session with no memory.

**We saw none of it. 0 errors in 98 sessions.** That is a real datapoint but it
is not a refutation: our sessions were **audio-only and 2–4 minutes**, which is
precisely the shape that does *not* trigger the reported failures, and most
reports are against `gemini-3.1-flash-live-preview` rather than 3.8.

**What this means for us:** a receptionist call is audio-only and short, which
is the lucky shape. But **`goAway` and `sessionResumption` handling does not
exist in our Live front-end**, and a 10-minute connection lifetime says it will
eventually be needed.

Other reported behaviour: hallucinations and "occasional slowness or timeout
issues" are named in Google's own model card as known limitations.

---

## 14. What this means for our build

**The integration is a model swap, not a rewrite** — and that is the whole
argument against GPT-Live, which needs a new vendor client, reconstructed turn
boundaries and an exact-sentence audio path.

What carries over unchanged from `lib/voice/live/`:

- the WebSocket client (`live/client.js`) and `connectLive`
- the whole audio path — `resample.js`, `audioOut.js`, `inboundVad.js`
- `turnComplete`-driven turn machinery, because 3.8 emits it in 17 ms
- `buildAllDeclarations` and the entire tool executor
- every write guard, `applyReplyState`, the silence ladder, post-call verify

What actually changes:

| # | change | size |
|---|---|---|
| 1 | `LIVE_MODEL_DEFAULT` in `lib/voice/live/surface.js:2` | one line |
| 2 | **Do not send `thinkingConfig`** — 3.8 rejects it | a guard |
| 3 | **Async tools are now default.** Audit the tool loop for `NON_BLOCKING` semantics and pick a scheduling mode per tool — `SILENT` for `set_call_intent`, `INTERRUPT` for a refused write | real work |
| 4 | **Tool re-fire** — the availability invariant in `live/guards.js` must tolerate the same tool twice in a turn without double-counting | small |
| 5 | **Proactive audio is on by default** — verify it does not swallow a quiet caller | a call |
| 6 | **The claim guard is mandatory**, for the 2-of-10 refusal misreport | already built |
| 7 | **Recording disclosure from our own pre-rendered audio** — 4/4 verbatim is not 0.95, and a legal string cannot be a 75% proposition | new, shared with any vendor |
| 8 | `goAway` / `sessionResumption` for calls approaching 10 minutes | deferred |

**Not carried over:** nothing. That is the point.

---

## 15. Open questions

- **Concurrent Live sessions per project.** Google does not publish it the way
  OpenAI does. Must be answered before launch.
- **Whether our guard stack catches the 2-of-10 misreport.** The guards were not
  in this harness. **This is the next thing to run and the recommendation rests
  on it.**
- **How it sounds on a handset** over an 8 kHz μ-law line. The rig writes WAVs
  of the raw 24 kHz stream, and the owner has already rejected a voice on a real
  call that passed on file.
- **Long calls.** Everything here is 2–4 minutes. The 1011 reports cluster
  around the 90–120 s mark on other session shapes, and we have not gone near
  the 10-minute connection limit.
- **Whether `gemini-3.5-transcribe-live` in parallel fixes name spelling.** It
  takes **1,000 custom vocabulary terms** — the control surface the Live API's
  empty `inputAudioTranscription` denies, and the strongest untried lever on
  LVX42/77/123.
- **Vertex availability**, re-checked periodically. It is the one fact that
  would change the residency answer.
