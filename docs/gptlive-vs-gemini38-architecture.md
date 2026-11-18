# `gpt-live-1` vs `gemini-3.8-live` — architecture head to head

Written 2026-09-16. Synthesis of `docs/gpt-live-analysis.md` and
`docs/gemini-38-live-analysis.md`, plus the measured round in
`scripts/probes/report-g38.md` and its addendum.

**Legend:** **[M]** measured here · **[D]** documented by the vendor ·
**[U]** unmeasured

---

## 0. The one difference everything else follows from

**GPT-Live splits the voice from the brain. Gemini 3.8 does not.**

```
GPT-Live                                  Gemini 3.8 Live
────────────────────────────────          ──────────────────────────────
  caller audio                              caller audio
      │                                         │
  ┌───▼────────────┐                        ┌───▼──────────────────┐
  │ gpt-live-1     │  voice only            │ gemini-3.8-live      │
  │ $0.05/min      │  knows nothing         │ voice AND reasoning  │
  └───┬────────────┘                        │ interleaved thinking │
      │ delegation protocol                 └───┬──────────────────┘
  ┌───▼────────────┐                            │ toolCall
  │ terra / luna / │  the brain                 │
  │ sol / astra    │  billed separately     ┌───▼──────────────────┐
  └───┬────────────┘                        │ services/tools.js    │
      │ function_call                       └──────────────────────┘
  ┌───▼────────────┐
  │services/tools.js│
  └────────────────┘
```

Everything below — the transports, the turn boundaries, the cost curve, the
integration bill — is downstream of that choice.

**What the split buys you:** the brain is swappable, and it matters. Measured:
Luna skipped the diary **3 of 10**; Terra checked it before every write. You can
pay for a better brain without changing the voice.

**What it costs you:** a second protocol, a second bill, and a seam where
information gets lost. The voice layer holds no tools and no diary — which is
also a safety property, since it cannot read out a slot list it never received.

---

## 1. Model shape

| | `gpt-live-1` | `gemini-3.8-live` |
|---|---|---|
| kind | voice layer only | native speech-to-speech, voice + reasoning |
| base model | not disclosed | **Gemini 3 Pro** [D] |
| knowledge cutoff | **Jul 31 2025** [D] | **Jan 2025** [D] |
| GA | 2026-09-10 | **2026-09-15** |
| brain | delegated: `gpt-5.6-luna` / `-terra` / `-sol` / `gpt-6-astra` | itself, or the `-extended-thinking` variant |
| context | 128k, auto-summarises past 90% [D] | **131,072 in / 65,536 out** [D] |
| variants gotcha | `delegation.type` **immutable after start** [D] | ET **requires** `thinkingLevel`; plain **rejects** it [M] |

---

## 2. Transport

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| primary | WebSocket — **the only transport accepting `audio.format`** [M, G1] | WebSocket (WSS), stateful [D] |
| also | WebRTC via `POST /v1/live/sessions`; **sideband** socket for server-side control of a browser-owned session | client-to-server direct, with **ephemeral tokens** for production [D] |
| SIP / telephony | recognised but **org-gated** — `outbound_sip_not_enabled` on our key [M] | none; partners handle media (LiveKit, Pipecat, Agora, Daily) |
| partner SDKs | Twilio **Agent Connect** has a native `GPTLiveProvider`; Telnyx, LiveKit, Pipecat | LiveKit, Pipecat, Agora, Fishjam, Vercel, LangChain |

**Practical:** GPT-Live has the better telephony story on paper — Twilio ships a
provider and official inbound *and* outbound Node tutorials. We use neither; our
own bridge already exists.

---

## 3. Session lifecycle

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| open | `session.start` → `session.started` | `setup` → `setupComplete` |
| audio in | `session.input_audio.append` | `realtimeInput` |
| audio out | `session.output_audio.delta` | `serverContent.modelTurn.parts[].inlineData` |
| **reply finished** | **no event exists** [D] | `generationComplete` |
| **turn finished** | **no event exists** [D] | **`turnComplete`** [D] |
| close | `session.close` → `session.closed` with `usage.seconds` | `goAway` (carries `timeLeft`) then close |
| resume | fork a stored session, or replay saved history | `sessionResumption` handle, **valid 2 h** [D] |
| session cap | **unknown** [U] | **15 min audio**, 2 min audio+video [D] |
| connection cap | unknown [U] | **~10 min** [D] |
| long calls | context auto-summarises; replacement gets instructions + 8,192 tokens | `contextWindowCompression`, sliding window |

**The asymmetry that matters most in this table is the missing turn event.** See §5.

---

## 4. Audio — and the integration bill inverts

| | GPT-Live | Gemini 3.8 | Twilio |
|---|---|---|---|
| in | **μ-law 8 kHz** (`audio/pcmu`) [M] | PCM16 **16 kHz** LE [D] | μ-law 8 kHz |
| out | **μ-law 8 kHz** [M] | PCM16 **24 kHz** [D] | μ-law 8 kHz |
| resampling needed | **none** | both directions | — |

On paper GPT-Live wins outright — it speaks Twilio's exact frame.

**In practice the bill inverts, because we already paid Gemini's.**
`lib/voice/resample.js` has `mulaw8kToPcm16k` (:146), `createDownsampler` (:86,
63-tap Hamming sinc, exact 3:1) and `createFramer` (:171), running in production
today on the 3.1 path. The "6–10 h of new hot-path DSP" that
`speech-to-speech-vendor-analysis.md` §2.2 priced as Gemini's integration tax is
**sunk**.

So: choosing GPT-Live means **deleting working DSP and writing a new vendor
client**. Choosing 3.8 means **changing a model string**.

---

## 5. Turn boundaries — the structural difference

Both are full duplex, so neither has a "whose turn is it" decision at the
*vendor* level. The difference is whether they tell you when a turn ended.

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| turn-complete event | **none** | `turnComplete` |
| after a tool call | n/a | **median 17 ms** [M] |
| vs 2.5 / 3.1 | — | 2.5: 914 ms · 3.1: 6,750 ms [M] |
| reconstruction | **required** — 9/10 correct at an 800 ms gap rule [M] | not required |

OpenAI's own SDK docstring:

> *"Accumulate fragments in delivery order; these events do not define complete
> turns or include a transcript-done event."*

**Why this is the expensive difference for us.** Every write guard in this
system fires on a completed caller turn — the consent latch, the affirmative
check, `isUnusableTranscript`, the write-order gate. On GPT-Live we would
rebuild turn segmentation **inside the layer that authorises database writes**.
The decision full duplex deletes reappears one level down, in the worst possible
place.

On 3.8, `lib/voice/live/index.js`'s existing `turnComplete`-driven machinery
just works — including the `toolRoundsThisTurn = 0` reset at :3764 that sits
below `if (!sc.turnComplete) return;`.

---

## 6. Stream shape — and the detector it breaks

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| speech : stream ratio | **0.046** [M] | **0.851** [M] |
| gaps > 400 ms | none — 21.8 s of stream held 1.0 s of speech [M] | 0 of 110 within a response, but the stream **stops** between them [M] |
| 900 ms quiet window reachable | **never** | **every take** [M] |
| valid detector | **RMS energy only** | arrival-based *and* energy, and they agree |

GPT-Live's output stream is **always on and carries silence**. During the
GPT-Live round a detector that counted audio arrivals scored **10 of 10
cut-ins** and would have published the exact opposite of the truth.

3.8's stream stops when the model stops. Both detectors agree on it: **0 cut-ins
of 10, twice.**

---

## 7. Tools and function calling

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| where declared | `delegation.responses.tools` | `tools[].functionDeclarations` |
| call arrives as | `response.event` envelope → inner `response.output_item.done`, `item.type === "function_call"` | `toolCall.functionCalls[]` |
| answer with | `response.item.create` **then `response.create`** | `sendToolResponse({functionResponses})` |
| async | backend runs while the voice talks | **`NON_BLOCKING` is the default** [D] |
| scheduling | — | `INTERRUPT` / `WHEN_IDLE` / `SILENT` [D] |
| automatic handling | none | none |
| other tools | web_search, `parallel_tool_calls`, `tool_choice` | search grounding; **no** code execution, URL context, structured outputs, caching |

**Three documented GPT-Live traps**, all of which would have to be handled:

1. Appending a function result **does not continue the response** — you must
   send `response.create` too.
2. A terminal snapshot showing `output: []` **does not mean there are no pending
   calls**.
3. An arguments-done event alone gives **neither the name nor the `call_id`**.

**Gemini's trap is different and simpler:** it **re-fires** tools —
`check_appointment_availability` twice in one caller turn in **2 of 5** takes
[M]. The availability invariant must tolerate that without double-counting.

### The async race, measured on both

Both vendors document that the model may speak while backend work runs. OpenAI
states it as *"a corrective instruction cannot retract audio already heard."*
That is our oldest defect written down as a platform property.

**Neither leaked.** GPT-Live **0 of 10** on both delegation arms; 3.8 **0 of 9**,
and silent during the hold rather than filling it with chatter.

---

## 8. Injecting text — "say exactly this"

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| channels | `commentary.append` (spoken, **in its own words**), `instructions.append` (behaviour, can interrupt), `thinking.append` (never spoken) | `sendClientContent` with a system-framed turn |
| cap | **500 tokens each** [D] | prompt-sized |
| best delivery | **0.63** — `instructions.append`, 5 of 8 [M] | **0.75**, 6 of 8 [M] |
| recording disclosure | **1 of 5** verbatim [M] | **4 of 4 VERBATIM** [M] |
| failure mode | **fails silent** (3/3 misses said nothing) — detectable | says something else entirely (2/4 on read-back) |
| acked but never spoken | **12 of 24 pushes** [M] | — |

3.8 is materially better here, and **neither clears 0.95**. The design
conclusion is the same for both and is vendor-independent: **the recording
disclosure comes from our own pre-rendered audio**, played into the Twilio leg,
where delivery is our code's property rather than a model's decision.

---

## 9. Transcription

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| source | the model is the ASR | the model is the ASR |
| caller text | `session.input_transcript.delta` + `start_ms`/`end_ms` | `serverContent.inputTranscription` |
| **lag behind audio** | **2.6–3.0 s** [M] | arrives with the audio [M] |
| shape | **fragmented**, no turn boundaries | turn-shaped |
| WER (normalised) | **0.000** [M] | **0.000** [M] |
| number formatting | writes words | **writes digits** — better for a phone number |
| catastrophic loss | **1 blank turn in 57** [M] | 0 in 98 [M] |
| vocabulary biasing | `gpt-live-transcribe`, keyword + language hints | `gemini-3.5-transcribe-live`, **1,000 custom terms** |

**The lag is not cosmetic.** It cost GPT-Live **10 of 15** booking takes to
harness desync against Gemini's 3 of 15 — the adaptive caller was reading
truncated questions and answering half of them. Any guard reading the transcript
inherits that 3-second blindfold.

---

## 10. Config, voices, language

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| voices | 22, `marin` default, **immutable after start** [D] | 8 tested, **all resolve including `Kore`** [M] |
| language | — | native audio infers it; **cannot be pinned** [D] |
| immutable fields | `model`, `voice`, `audio.format`, `delegation.type`, `store` | model, voice |
| prompting | **do not paste a Realtime prompt in**; split frontend/backend (563 chars vs 15,932 in our rig) | one `systemInstruction` — the production prompt as-is |
| removed / defaults | — | `thinkingLevel` rejected; **affective dialog removed**; **proactive audio now ON by default** |

`Kore` resolving matters: the owner chose it by phone on 2026-09-05 after
rejecting Aoede on a real call. It carries over.

---

## 11. Cost

| | voice layer | brain | **measured total** |
|---|---|---|---|
| `gpt-live-1` + terra | $0.05/min | $2/$12 per 1M | **$0.066/min · $0.20/call** [M] |
| `gpt-live-1` + luna | $0.05/min | $0.20/$1.20 | ~$0.052/min [D] |
| `gpt-live-1` + sol | $0.05/min | $4/$20 promo | ~$0.082/min [D] |
| **`gemini-3.8-live`** | — | — | **$0.041/min · $0.12/call** [M] |
| `-extended-thinking` | — | — | $0.070/min · $0.21/call [M] |
| *today's cascade* | — | — | *$0.130/call* |

**Billing model differs fundamentally.** GPT-Live bills **wall-clock seconds** —
silence is billable, and a hung socket bills until someone notices. Gemini bills
**audio tokens** in and out. For a receptionist with pauses, token billing is
the friendlier curve.

**3.8 is the only option cheaper than what we run today.**

---

## 12. Limits

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| concurrent sessions | **25 Tier 1 → 500 Tier 5** [D] | **not published** [U] — open item |
| free tier | none | yes |
| startup history | 128 messages / 8,192 tokens [D] | — |
| session | unknown [U] | 15 min audio [D] |

---

## 13. Residency — GPT-Live's one clear win

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| EU path | **yes** — `eu.api.openai.com`, regional processing + ZDR | **none** [M] |
| conditions | **new project only** (cannot convert), eligibility via sales, **+10% uplift** | — |
| Vertex | n/a | **not found in europe-west1, europe-west2, us-central1 or global** [M] |
| DPF certified | **no** — SCCs + UK Addendum, DPA eff. 2026-01-01 | Google Cloud DPA |

Checked 2026-09-16 against `vetra-uk-edc8ca`: **neither 3.8 variant is on Vertex
anywhere we can reach**, despite the DeepMind card listing "Vertex AI" among
Extended Thinking's distribution channels.

So 3.8 carries **exactly the same disqualifier as the 3.1 it would replace**.
If residency hardens before signing, the choice collapses to GPT-Live on an
EU-pinned project, or `gemini-live-2.5-flash-native-audio` on Vertex
`europe-west1` — which carries the repetition (`max_repeat` 7) and invented DOBs
that 3.8 does not.

---

## 14. Known issues in the wild

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| dominant complaint | shallow without delegation; **paraphrases everything**; per-minute billing rewards long calls | **WebSocket 1011 mid-session** |
| specifics | acked-but-unspoken pushes; no exportable transcript | reported at **90–120 s**, mostly **audio+video**; during tool execution; **session resumption poisons restored context** |
| our observation | 1 blank transcript in 57 | **0 errors in 98 sessions** [M] |
| caveat on ours | — | audio-only, 2–4 min — precisely the shape that does *not* trigger the reports, and most reports are against 3.1-preview |

Google's own model card names hallucinations and "occasional slowness or timeout
issues" as known limitations.

---

## 15. Measured, head to head

| | `gpt-live-1` + terra | `gemini-3.8-live` |
|---|---|---|
| trail-off cut-ins | 0/10 | **0/10** (twice) |
| reached a write | 3/15 | **12/15** |
| lost to harness desync | **10/15** | 3/15 |
| fabricated a time | **0** | **0** |
| fabricated a field | **0** | **0** |
| acted on an unread record | **0** | **0** |
| told truth on a refusal | never reached one | **4/4** |
| misreported a refused cancel | 0 of 2 reached | **2 of 10** |
| claimed completion before the write | 0 | 0 |
| repetition `max_repeat` | 3 | **2** |
| exact sentence | 0.63 | **0.75** |
| turn latency p50 | — | 1,277 ms |

**The caveat that keeps this from being a clean sweep:** the instrument is not
equally good on both. GPT-Live's 3-second transcript lag cost it 10 of 15 takes,
so part of the 12-vs-3 gap is our harness, not the model. Its refusal behaviour
is still **unmeasured** — it never reached a refusal.

**The property that holds across both, and across 197 sessions on three model
variants:** nothing wrong was ever written, and no record was ever acted on that
had not been read. Every failure was a *sentence*, never the *database*.

---

## 16. What each would cost us to build

| | GPT-Live | Gemini 3.8 |
|---|---|---|
| vendor client | **new** | exists (`live/client.js`) |
| audio path | **delete** `resample.js` on that path, new μ-law passthrough | **unchanged** |
| turn boundaries | **rebuild**, inside the write-authorisation layer | unchanged — `turnComplete` in 17 ms |
| tool loop | new — envelopes, delegation ids, `response.create` | audit for async scheduling modes |
| exact sentence | **our own audio**, mandatory | **our own audio**, mandatory |
| prompt | **split** frontend/backend | as-is |
| guards | all port, but fire on reconstructed turns | all port unchanged |
| estimate | **60–110 h** (`gpt-live-analysis.md` §7) | **one line, plus 3 real changes** |

The three real changes on 3.8: async `NON_BLOCKING` scheduling per tool, the
availability invariant tolerating a re-fired tool, and the pre-rendered
disclosure audio — the last of which is needed on either vendor.

---

## 17. The verdict, and where it could flip

**Build against `gemini-3.8-live`.** It wins on the axes that decide it —
booking correctness, refusal honesty, repetition, exact-sentence delivery,
latency, cost — and it costs a model string instead of a rewrite because the
integration tax everyone quotes against Gemini is already sunk in our repo.

**GPT-Live is not disproven.** It is architecturally cleaner in one real way
(the voice layer cannot read out a diary it never received), it has the better
telephony story, a swappable brain that measurably matters, and **the only
residency path**. This round could not see it clearly because its transcript lag
defeated our instrument.

**Three things would flip this:**

1. **Residency hardens before signing.** 3.8 has no path; GPT-Live does.
2. **A fixed harness measures GPT-Live's refusal behaviour** and it beats 2-of-10.
3. **Concurrency.** OpenAI publishes 25→500; Google publishes nothing, and we
   have not asked.
