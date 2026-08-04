# Ideal Architecture — best voice, lowest latency, best value

**Date:** 2026-08-02
**Status:** Design document. Nothing here is implemented.
**Companion:** `2026-08-02-gcp-migration-architecture.md` (the HIPAA-constrained architecture)
**Vendor facts verified:** 2026-08-02. Benchmark standings move weekly — re-check before acting.

---

## Context

The GCP document answers "what does HIPAA force us to build." This one answers the opposite
question: **with a free hand and no compliance constraint, what is the right stack?**

Judged on voice quality first, latency second, cost third — best *value* meaning quality-and-latency
per dollar, with premium spend reserved for what callers actually notice. Every layer is compared
against its GCP equivalent so the two documents reconcile rather than compete. In practice this is
also the stack every non-healthcare tenant would run.

**Decisions taken as given:**

1. Keep the hand-built cascaded pipeline. Not Twilio ConversationRelay, not speech-to-speech.
   Cascaded remains the 2026 default for agents with 5+ tools and strict schemas, which describes
   the capability packs exactly. Owning each stage is also what makes everything below possible:
   you can replace the slow stage without touching the expensive one. Managed loops
   (ConversationRelay at $0.07/min, ElevenLabs Agents) bundle the stages and remove that lever.
2. Model and vendor choices are settled by the eval harness, not by argument.
3. Quality is a first-class axis, not a tiebreaker.

---

## 0. The finding that reframes everything

**No voice-to-voice latency measurement exists anywhere in this repository.**

The instrumentation is there and it is good. `lib/voice/metrics.js` records six marks per turn —
`speech_end`, `stt_final`, `llm_request`, `llm_first_chunk`, `tts_first_byte`, `first_audio_sent`
— and derives `stt_tail_ms`, `llm_ttfb_ms`, `tts_ttfb_ms`, and `voice_to_voice_ms`
(`metrics.js:85-90`). `GET /api/debug/latency` (`server.js:497-503`) exposes p50/p95/max over a
500-entry ring buffer. Every finished turn emits a structured `turn_latency` log line
(`metrics.js:161`), and `scripts/watch-call.js:295-305` already streams it live and flags anything
over 1000ms.

None of it has ever been captured. Every latency number committed to the repo comes from the
**text harness** (`lib/harness/textSession.js:102-140`), which measures the LLM in isolation with
no audio path at all. `docs/LOCAL_TESTING.md:66` sets a target of `voice_to_voice_ms` p50 ≤ 800ms,
ideal 500. Nobody knows whether it is met.

The text-harness numbers that do exist suggest it is not:

| Model | First-event p50 | Turn p50 | Source |
|---|---|---|---|
| gemini-2.5-flash | 636ms | 1207ms | `.superpowers/sdd/progress.md:15` |
| **gemini-3.6-flash (current default)** | **854ms** | 1583ms | matrix run, 2026-07-24 |
| gemini-3-flash-preview | 899ms | 1801ms | `eval/results/matrix-…838Z.json` |

**The current model is 218ms slower to first token than the one it replaced.** That was a quality
decision made without a latency budget in view.

### The reconstructed turn

Assembled from the actual constants in the code, for a typical turn with no tool call:

| Stage | Cost | Source |
|---|---|---|
| Deepgram endpointing (silence before finalize) | 300ms floor | `STT_ENDPOINTING_MS`, `sttStream.js:52-55` |
| `classifyHold` deliberate stall | 0-1500ms; 1500 when the transcript has no terminal punctuation | `transcriptUtils.js:194-224` |
| LLM time-to-first-token | ~850ms | matrix above |
| **Waiting for a complete sentence before any TTS** | +200-400ms of tokens | `splitReadySentences`, `session.js:281` |
| TTS time-to-first-byte | ~75-150ms | handshake overlapped, `session.js:1885` vs `:1892` |
| Paced-playout lookahead | up to 100ms | `LOOKAHEAD_MS`, `audioOut.js:54` |
| **Estimated total** | **≈1,500-1,900ms** | against an 800ms target |

With a tool call it roughly doubles. Tool calls in a round execute **sequentially** in a
`for (const fc of functionCalls) { await … }` loop (`gemini.js:1146-1164`), and then a **second
full `sendMessageStream` round trip** sends results back and pays time-to-first-token again
(`:1209`). Up to `MAX_FC_ROUNDS = 3` (`gemini.js:17`).

Everything that follows is ranked against that budget. **Every number in this document is a
hypothesis until §1 runs.**

---

## 1. Measure before changing anything

Two pieces of work, both prerequisites rather than improvements.

**Capture real voice latency.** Run 10+ live calls with `DEBUG_ENDPOINTS=true` and record p50/p95
for all four derived deltas. The tooling already exists; nothing needs building. This single
exercise determines whether the LLM, the hold logic, or the TTS path is the actual bottleneck —
and the reconstruction above could be wrong in either direction.

**Add latency to the eval harness.** `eval/run.js` scores 24 scenarios on hard asserts (tool-call
correctness, slot extraction) plus an advisory LLM judge on phrasing. It records no timing.
`lib/harness/textSession.js:102-140` already tracks `firstEventMs` and `totalMs`; promote them to
first-class scored dimensions and surface them in `eval/matrixAggregate.js`.

Without this, a model bakeoff selects the *smartest* model rather than the best *voice* model.
Those are different questions and the current harness can only answer one of them.

---

## 2. Voice quality, measured properly

### "Is ElevenLabs the best voice?" conflates two different products

ElevenLabs' quality flagship is **Eleven v3** — roughly $100-120 per million characters, not a
low-latency model. What this codebase runs is **Flash v2.5** (`services/elevenlabs.js:25`), the
speed-optimized model, which is explicitly a quality tradeoff against v3, at roughly $50-60 per
million characters.

So the premium being paid buys the *fast version of a good voice*, not the best voice.

### The best independent evidence

The **Artificial Analysis Speech Arena** ranks TTS models by blind pairwise human preference on an
Elo rating — listeners hear two anonymous samples and pick the more natural one. As of 2026 it
covers 76 production models. May 2026 standings:

| Rank | Model | Elo | ~$/1M chars | Latency |
|---|---|---|---|---|
| 1 | Inworld Realtime TTS 1.5 Max | 1,208 | ~$35 (→$10 at scale) | sub-250ms P90 |
| 2 | **Google Gemini 3.1 Flash TTS** | 1,206 | ~$36.6 | — |
| 4 | ElevenLabs Eleven v3 | 1,178 | ~$100-120 | not realtime |
| top tier | Cartesia Sonic 3.5 / Sonic 4 | — | ~$5-37 by plan | ~40ms TTFA |
| — | **ElevenLabs Flash v2.5 — what you run** | below v3 | ~$50-60 | ~75ms |
| — | Google Chirp 3 HD | close in casual listening | ~$30 | ~200ms |
| — | Rime | — | ~$39 effective | — |
| — | OpenAI standard TTS | — | ~$15 | — |

Blind MOS panels and the arena rotate their top three among **Inworld Realtime TTS 1.5 Max,
ElevenLabs Eleven v3, and Cartesia Sonic 3.5**. ElevenLabs is separately reported at MOS 4.14, and
Eleven v3's handling of pause, breath and intonation is still described as the reference for
long-form narration — but long-form is not this product. A receptionist speaks in short utility
turns, which is precisely where Cartesia Sonic 3.5 is described as hard to distinguish from human.

### Two conclusions

**One: you are not running the best voice, and the alternatives are cheaper and faster.** Inworld
and Cartesia are top-tier on blind preference, faster on time-to-first-audio, and cheaper per
character than Flash v2.5. That is unusual — normally you pick two of three.

**Two: Chirp 3 HD's problem is latency, not quality.** Reported ~200ms against ElevenLabs Flash's
~75ms, nearly 3x, and on a live call that is the difference between a slight pause and fluid
speech. On quality the gap has largely closed for clean conversational content. This matters
directly to the companion HIPAA document, which currently recommends Chirp for healthcare tenants
— see §9.

### How to actually decide

Not by leaderboard. Coval publishes specifically on why vendor TTS benchmarks mislead, the arena's
Elo moves weekly, and none of these measure the thing this product is judged on, which is *voice
character* in your 8 configured business voices (`config/voices.js`).

Run a blind A/B on real call audio: the same script, the same 8 voice archetypes, rendered through
Flash v2.5, Cartesia Sonic 3.5, Inworld, and Gemini 3.1 Flash TTS, scored by ear over a phone
handset at 8kHz mulaw — not through studio monitors on a 48kHz file. Telephony bandwidth destroys
much of what separates these models, which is itself an argument against paying for the top of the
range.

---

## 3. The LLM is the biggest latency lever, and also a cost win

Published median time-to-first-token spans roughly 5x across providers: Groq ~120ms, Cerebras
~160ms P50, Gemini ~600ms median with developers reporting worse in real-time voice builds. The
repo's own matrix already shows a 218ms swing between two Gemini versions.

| Option | Input /1M | Output /1M | Est. $/3-min call |
|---|---|---|---|
| gemini-3.6-flash (current) | $1.50 | $7.50 | ~$0.056 |
| Groq Llama 3.3 70B | $0.59 | $0.79 | ~$0.019 |
| Groq Llama 3.1 8B Instant | $0.05 | $0.08 | ~$0.002 |
| Cerebras Llama 3.3 70B | ~$0.85 | ~$1.20 | ~$0.027 |

Roughly 3x cheaper and potentially ~700ms faster to first token. That is the single largest
available win on both axes simultaneously.

**Run the bakeoff across gemini-3.6-flash, gemini-2.5-flash (the cheap rollback), Groq Llama 3.3
70B, and Cerebras**, scored on all 24 eval scenarios plus TTFT, once §1 lands. The honest caveat:
Groq and Cerebras serve open weights only — no Gemini, no Claude, no GPT — and reasoning quality on
multi-slot booking turns is the open question. Booking is where this agent earns its money, so a
model that is 700ms faster and 20% worse at slot extraction is a bad trade. The eval exists to
answer exactly this.

### A free win regardless of which model wins

`buildSystemInstruction(step, intent, cfg, extras)` (`gemini.js:796`) rebuilds the system
instruction on every turn, varying by conversation step and detected intent. Implicit caching only
pays when the prefix is byte-stable, so a prompt that changes shape each turn is likely paying full
prefill every time — which is TTFT, directly.

`cachedContentTokenCount` is already logged at `gemini.js:1212-1216`. **Read it before assuming.**
If the cache is not hitting, restructure so business identity, capability definitions and the
knowledge base form a byte-identical prefix, with only a short variable tail carrying step and
intent. Costs nothing, risks nothing, and may be worth more than a model swap.

---

## 4. Stop waiting for a whole sentence

`splitReadySentences` (`session.js:281`) releases text to TTS only at sentence boundaries, or when
the buffer hits a 200-character soft cap (`SENTENCE_BUFFER_SOFT_CAP`, `session.js:208`). So first
audio waits for the first *complete sentence*, not the first token — despite the LLM streaming
deltas and the TTS socket already being open.

ElevenLabs is opened with `auto_mode=true` (`elevenlabs.js:109`), which means the vendor is already
doing its own chunking and buffering; feeding it partial text earlier is safe by design. Flushing
at clause boundaries — comma, conjunction, or a short character floor with a minimum-word guard —
pulls first audio forward by roughly the length of the first clause.

Estimated 200-400ms, against some prosody risk where a clause break lands badly. The eval harness
plus a listen test bounds that risk. This is the second-cheapest win in the document.

---

## 5. End-of-turn detection

The current design is five hand-tuned layers:

1. Deepgram `endpointing=300` (`sttStream.js:52-55`)
2. `utterance_end_ms=1000` as a fallback finalizer (`sttStream.js:83`)
3. A local energy VAD, `activeMs` 200 / `hangoverMs` 300 (`inboundVad.js:52-58`)
4. `classifyHold`'s deliberate stalls — 2000ms on a trailing conjunction, 1500ms on partial digits,
   1500ms with no terminal punctuation, capped by `MAX_TOTAL_HOLD_MS` 3000
   (`transcriptUtils.js:194-224`, `session.js:88`)
5. A 700ms post-barge settle (`POST_BARGE_SETTLE_MS`, `session.js:126-129`)

It works. It was debugged against 14 live calls and it is the reason the agent stopped interrupting
itself. It is also the reason a caller who trails off waits 1.8 seconds for a reply.

**Deepgram Flux** collapses layers 1-4 into the model: the first conversational STT with integrated
end-of-turn detection, no external VAD required, claimed median end-of-turn under 300ms and
200-600ms saved against STT+VAD pipelines — at ~$0.0048/min against Nova-3's $0.0077/min. Cheaper,
faster, and deletes code.

The counter-evidence, stated in full: on the Pipecat open STT benchmark, AssemblyAI's
Universal-3.5 Pro Realtime posts a pooled word error rate of **6.99% against Flux's 15.58%**, and
an entity error rate of **15.31% against 50.50%**. Entity accuracy is names, dates and phone
numbers — the entire job of a receptionist. A 50% entity error rate would be disqualifying.

**That benchmark is published by AssemblyAI**, a direct competitor, so it needs independent
confirmation; Coval and Hamming both publish independent runs, and Hamming's data across 4M+
production calls shows AssemblyAI ahead on median word-emission latency (307ms vs 516ms) and
roughly 2x faster at P99. Note also that the repo already sends business keyterms to Deepgram for
name accuracy (`sttStream.js:94-96`) — any replacement must support an equivalent.

Three-way A/B on real recorded call audio, scored on entity extraction specifically. Not a document
decision.

---

## 6. Tool-call round trips

Two inefficiencies, both narrow and cheap.

**Sequential tool execution.** `gemini.js:1146-1164` awaits each function call in turn. Independent
calls in the same round should run concurrently. Real cost depends on how often multi-call rounds
occur — measurable from existing logs.

**Late filler.** `runLlmTurn` yields `slow` only after `firstChunkTimeoutMs` of 2000ms
(`llmTurn.js:131,191-193`), which triggers `playHoldLine("filler")` (`session.js:1934`). But when a
tool call is already in flight, the wait is *known* — an athenahealth call is bounded at 6000ms
(`integrations/athenahealth.js:17`), a customer webhook at 6000ms (`integrations/webhook.js:39`).
Speaking immediately on tool dispatch removes up to 2 seconds of dead air, and the utterance cache
already has the filler pre-rendered in the business's own voice
(`lib/voice/utteranceCache.js`, warmed at `session.js:2443-2456`).

---

## 7. Colocation

Published breakdowns put a typical voice agent at: network ingress plus SIP signaling 50-200ms, STT
80-300ms, LLM inference 150-1000ms, TTS 60-250ms, plus egress. Co-located stacks are reported under
200ms total where stitched stacks run 600-1,700ms.

Today the path is Twilio's edge → Railway → Deepgram → Google → ElevenLabs → back, with no
deliberate region placement anywhere in the configuration. Each hop that crosses the continent
costs real milliseconds, twice per turn.

The work is configuration, not code: pick one region, pin the voice host to it, select the Twilio
media edge explicitly (Media Streams supports regions beyond the default US1), and choose vendor
regions to match. Estimated 50-150ms for a day of work and no architectural risk.

---

## 8. Layer by layer, with the GCP equivalent

> **Read this first.** The Verdict column below answers "what is the single best option for this
> layer, in isolation." It deliberately ignores the constraint that a BAA deployment also has to
> exist. **On 2026-08-03 the architecture was settled as one codebase, two Cloud Run deployments
> with infrastructure consolidated on GCP** — which overrides four of these verdicts:
>
> | Layer | Verdict below | Actual choice | Why |
> |---|---|---|---|
> | Voice host | Fly.io | **Cloud Run** | Highest-PHI component; Fly's BAA status unknown; a second cloud recreates the two-stack problem. Paid for in the `callState` audit. |
> | Postgres | Neon | **Cloud SQL** | Needs CMEK, private IP, BAA. Neon's BAA status unknown. |
> | Static SPA | Cloudflare Pages | either | No PHI touches it. Consolidation preference only. |
> | CI | GitHub Actions | either | Does not touch PHI at runtime. |
> | Auth | Better Auth | **still open** | Better Auth self-hosts in your own Postgres, so there is no third party and nothing to sign a BAA with. That makes it BAA-*neutral*, not BAA-blocked — genuinely competitive with Identity Platform on both deployments. |
>
> Every other verdict below stands, including Sentry, which now applies to the standard deployment
> while the BAA deployment uses Error Reporting. Serving both is precisely what the two-deployment
> split buys.

| Layer | Today | GCP equivalent | Best-in-class | Verdict |
|---|---|---|---|---|
| Voice host | Railway | Cloud Run | **Fly.io Machines** | Fly: 35 regions vs Railway's 4, persistent machines, WebSocket-native, no request timeout, region pinning. Cloud Run works but fights a stateful WS app (60-min cap, instance churn, in-process `callState`). |
| Dashboard API | Railway | **Cloud Run** | Cloud Run / Fly | Genuine tie. Stateless request/response, so scale-to-zero is a feature. |
| Postgres | Supabase | Cloud SQL / AlloyDB | **Neon** | Neon on value: usage-based, no monthly minimum, branching per migration. Cloud SQL is fully competitive on capability and wins if you are already on GCP. |
| Auth | Supabase Auth | Identity Platform | **Better Auth** (self-hosted) | Better Auth: $0, organization plugin gives multi-tenant orgs/members/invites/RBAC, tables live in your own Postgres. Identity Platform is a strong managed alternative. Clerk is ~$1,000/mo at 100k MAU. |
| Static SPA + marketing | Vercel | Cloud Storage + CDN + LB | Cloudflare Pages | Rounding error. Cloudflare's free tier wins on price; nothing else differentiates. |
| Secrets | `.env` + Railway vars | **Secret Manager** | Secret Manager / Infisical | **GCP wins outright.** Versioned, IAM-scoped, access-audited, effectively free. Nothing in the current setup comes close. |
| Error tracking | Sentry | Cloud Error Reporting | **Sentry** | Sentry wins on UX by a wide margin when no BAA is required. |
| Logs + metrics | Railway log UI | Cloud Logging / Monitoring | Axiom / Better Stack | GCP adequate, specialists nicer, low stakes. |
| Shared call state | in-process `Map` (`lib/callState.js`) | Memorystore | Upstash / Fly Redis | Only needed if you leave single-instance hosting. Fly Machines make it unnecessary. |
| Cron | `setInterval` inside the web process | **Cloud Scheduler** | Cloud Scheduler / Fly cron | Anything beats a timer in a web process — it dies with scale-to-zero and duplicates with scale-out. |
| Queue | none | Cloud Tasks / Pub/Sub | Cloud Tasks | Would fix the fire-and-forget races in `POST /twilio/status` (`server.js:305-389`). |
| CI + registry | none (`.github/` does not exist) | Cloud Build + Artifact Registry | GitHub Actions + GHCR | GitHub Actions on ergonomics. Both fine. Having none is the actual problem. |
| **STT** | Deepgram Nova-3 | Google STT v2 / Chirp | Deepgram Flux, AssemblyAI | **GCP loses clearly.** 500ms-1s streaming against 200-300ms, and weaker on 8kHz telephony audio. |
| **TTS** | ElevenLabs Flash v2.5 | Chirp 3 HD, **Gemini 3.1 Flash TTS** | Inworld, Cartesia | **GCP is far stronger than assumed.** Gemini 3.1 Flash TTS sits #2 on the blind arena at ~$36.6/M — above ElevenLabs v3. |
| **LLM** | Gemini via AI Studio key | **Vertex AI** | Groq / Cerebras on TTFT | Competitive on quality, loses on time-to-first-token. |
| **Telephony** | Twilio | **none — GCP has no PSTN** | Twilio, Telnyx | Not a GCP question. Twilio recommended; Telnyx cheaper but had multi-hour voice outages in Dec 2025 and Feb 2026. |
| **Email** | Brevo + Gmail SMTP | **none native** | Resend, Postmark | Not a GCP question. |

### The verdict this table produces

**GCP is at or near best-in-class for every infrastructure layer, and wins outright on secrets
management.** It loses on STT latency, has no telephony and no email, and is competitive but not
leading on LLM time-to-first-token.

That is a meaningfully different conclusion than a vendor-by-vendor reading suggests. The
compliance-driven architecture costs far less capability than expected. The real sacrifices come
down to two things: Deepgram's STT latency advantage, and ElevenLabs' voice character.

**And the second one is now doubtful.** Gemini 3.1 Flash TTS out-ranks ElevenLabs v3 on blind human
preference and is presumably BAA-covered when served through Vertex. If that holds, the HIPAA
architecture's voice is not a compromise at all — it may be an upgrade. See §9.

---

## 9. TTS architecture note

The ElevenLabs socket is opened **per turn** (`createTtsTurn`, `ttsStream.js:136` →
`createTtsConnection`, `elevenlabs.js:99`), closed on `isFinal`. So a WebSocket handshake is paid
mid-turn, every turn. It is currently masked by starting the connection *before* the LLM request
(`session.js:1885` precedes `metrics.mark("llm_request")` at `:1892`), with pre-open writes queued
(`elevenlabs.js:138-145`) — good engineering, but it hides a cost rather than removing it, and it
consumes the overlap window that a faster LLM would otherwise free up.

It also means each turn is a fresh socket with no cross-turn state, so prosody continuity has to be
re-sent as `previous_text` (up to 300 characters) on every handshake (`elevenlabs.js:30,68-83`).

A persistent per-call connection removes both problems. Whichever vendor wins the A/B, prefer one
supporting multiple contexts on a single socket.

---

## 10. Supabase specifically

Verified against the current tree: no Storage, no Realtime, no Edge Functions, zero `CREATE POLICY`
statements, no `auth.uid()` anywhere, no `CREATE EXTENSION`. `services/supabase.js` is 1,039 lines
wrapping 30 `.from()` calls and exactly one `.rpc()`. The dashboard backend already talks to the
same database through a plain `pg` Pool — `AI-phone-dashboard/backend/src/db/index.js` is 8 lines.

**Supabase is Postgres plus a token verifier, at platform prices.** Its one genuinely differentiated
feature for a multi-tenant app — `auth.uid()` inside RLS policies — is unused, because no RLS
exists.

**The database is on the hot path only at call pickup.** `lookupBusinessByPhone` and `loadConfig`
are awaited at `session.js:2321-2327`; everything else (call record creation, knowledge base,
integrations, caller context) loads in a background `Promise.all` at `:2339-2358` and is awaited
lazily on the first turn via `ensureContext` (`:942`, called from `:1841`).

So an in-process business-config cache with a short TTL removes the database from the latency
conversation entirely. That reduces the choice to pure cost and operations, where Neon's usage-based
billing with no monthly minimum and per-migration branching is the value answer, and Cloud SQL is
the answer if the rest of the stack is on GCP anyway.

---

## 11. Value summary, quality-weighted

Per 3-minute call:

| | Today | Recommended | Δ |
|---|---|---|---|
| STT | Deepgram Nova-3 $0.023 | Deepgram Flux ~$0.014 (pending A/B) | cheaper, faster EOT, accuracy unproven |
| LLM | gemini-3.6-flash $0.056 | Groq Llama 3.3 70B ~$0.019 (pending eval) | ~3x cheaper, potentially ~700ms faster TTFT |
| TTS | ElevenLabs Flash v2.5 ~$0.10 | Inworld or Cartesia ~$0.02-0.04 | cheaper, faster, **and higher blind-preference Elo** |
| Telephony | Twilio ~$0.04 | Twilio, unchanged | — |
| **Per call** | **~$0.22** | **~$0.10** | **~55% cheaper** |
| **Per minute** | ~$0.073 | ~$0.033 | |
| Fixed monthly | Supabase + Railway + Vercel ~$65-90 | Neon + Fly + Cloudflare ~$25-50 | — |

Every swap in that table is cheaper *and* faster *and* — on the TTS row — higher-rated on blind
human preference. That is the finding:

**The current stack is not a premium stack. It is an early stack.** The expensive vendors are the
ones that were easiest to reach first. In TTS specifically, the premium price is buying the *fast*
version of a good voice rather than the best voice, at more than double what two better-rated
options cost.

Restating the caveat because it matters: **every number here is a hypothesis until §1 runs.**

---

## 11b. Vendor verdicts — settled 2026-08-03

Ahead of any testing, two of the three AI vendor questions are already decided. Only one needs a
test. This overrides the "run all three A/Bs" framing elsewhere in this document.

### LLM — keep `gemini-3.6-flash`. No test.

The test was already run. `.superpowers/sdd/progress.md`, full matrix 2026-07-24, 20 scenarios per
config:

| Config | Hard | First-token p50 |
|---|---|---|
| gemini-2.5-flash | 17-18/20 | ~630ms |
| **gemini-3.6-flash** | **19/20** | 785ms |
| gemini-3-flash-preview | 18/20 | 899ms |
| 2.5 + thinking128 | 14/20 | worse |
| 2.5 + thinking512 | 16/20 hard, 13/20 judge | 989ms |

3.6-flash won on quality; the single miss was a flaky long-call optional-notes assert. The 2.5
family retires **2026-10-16**, so reverting is not a durable option regardless.

The only open question is its 785ms TTFT, and **that is premature to act on** — nobody has
confirmed the LLM is the bottleneck in the voice path. `classifyHold` alone can insert 1,500ms of
deliberate stall before the LLM is called. Measure first (§1), fix the cache prefix (§3), then
reconsider Groq or Cerebras as one extra `--matrix` config.

### STT — keep Deepgram Nova-3. No change.

Highest-risk change available, least certain payoff. Flux's claimed 200-600ms win comes from
replacing the endpointing stack — Deepgram endpointing, `utterance_end_ms`, `inboundVad`, and
`classifyHold` — which took 14 live calls to tune and is why the agent stopped interrupting itself.
The one published accuracy figure puts Flux's entity error rate at 50.50% (names, dates, phone
numbers), from a competitor and unverified. Separately, our own keyterm boosting
(`sttStream.js:94-96`) has never been verified live, so any replacement must match a feature whose
value is unmeasured.

Revisit only if §1's measurement shows endpointing is a material cost.

### TTS — test. This is the one.

Genuinely undecided, cheapest to run, clearest payoff.

Candidates: **ElevenLabs Flash v2.5** (incumbent) · **Cartesia Sonic 3.5** · **Inworld TTS 1.5** ·
**Gemini 3.1 Flash TTS**.

Decide by ear at **8kHz mulaw over a phone handset**, not on a 48kHz file through monitors —
telephony bandwidth destroys most of what separates these models, which is itself an argument
against paying top of range. Score the 8 voices in `config/voices.js`.

Two findings from `.superpowers/sdd/progress.md` that lower the cost of leaving ElevenLabs:

- `previous_text` is **undocumented on the ElevenLabs WebSocket API and may be silently ignored** —
  the prosody continuity being given up may not exist.
- The lever that actually improved output was stability damping (0.5 → 0.65, catalog floor 0.6),
  not the vendor.

---

## 12. Sequenced menu

Ordered by value per unit of risk. No timeline — this is a menu, not a migration.

| # | Work | Est. gain | Risk |
|---|---|---|---|
| 1 | **Measure** (§1) — live-call latency capture + eval timing | none directly; unblocks everything | none |
| 2 | Prefix-stable system instruction (§3) | unknown, possibly large | very low |
| 3 | Clause-level TTS streaming (§4) | 200-400ms | low, prosody |
| 4 | Parallel tool calls + immediate filler (§6) | up to 2s of dead air on tool turns | low |
| 5 | Colocation + Twilio edge selection (§7) | 50-150ms | none, config only |
| 6 | TTS blind A/B incl. Gemini 3.1 Flash TTS (§2) | quality + ~$0.06-0.08/call | medium, voice character |
| 7 | LLM bakeoff (§3) | up to ~700ms + ~$0.037/call | medium, booking accuracy |
| 8 | STT three-way A/B incl. Flux (§5) | 200-600ms + ~$0.009/call | high, entity accuracy |
| 9 | Infrastructure: Neon, Fly, Better Auth (§8, §10) | ~$40/mo, better ops | low, no latency effect |

Items 1-5 are engineering work with known mechanics. Items 6-8 are vendor decisions that must be
settled by measurement. Item 9 has no effect on the product callers experience and should be done
last, when it is convenient — not first, because it feels like progress.

---

## 12b. Next session: start here

Everything below already exists in the repo. None of it needs building first.

**Step 1 — Measure the voice path.** Gates every other decision.

```
DEBUG_ENDPOINTS=true npm start          # then place 10+ live calls
GET /api/debug/latency                  # p50/p95/max for all four deltas
node scripts/watch-call.js              # live turn_latency stream, flags >1000ms
```

Record `stt_tail_ms`, `llm_ttfb_ms`, `tts_ttfb_ms`, `voice_to_voice_ms`. Target is p50 ≤ 800ms
(`docs/LOCAL_TESTING.md:66`). Reconstruction in §0 predicts 1,500-1,900ms — confirm or refute it.
Note that `first_audio_sent` marks *enqueue*, not wire-send; `audioOut` pacing can add up to
`LOOKAHEAD_MS` (100) on top.

**Step 2 — Read the cache counter.** Five minutes, possibly the largest free win.

`cachedContentTokenCount` is logged at `services/gemini.js:1212-1216`. If it is ~0, implicit
caching never hits and every turn pays full prefill. Fix is making `buildSystemInstruction`
(`gemini.js:796`) emit a byte-stable prefix with only a short variable tail.

**Step 3 — TTS blind A/B.**

`scripts/voice-ab.js` already renders WAVs across voices and has **never been listened to**
(ledger: *"listening pack awaits user ears"*). It is ElevenLabs-only today; adding a candidate is
one synth function per vendor writing into the same `voice-previews/` output. Also available:
`scripts/verify-voices.js` for REST previews.

**Harnesses that already exist and cost nothing to re-run:**

| Command | What it does |
|---|---|
| `npm test` | 1,088 root tests. The behavioral contract. |
| `npm run eval` | 24 scenarios, hard asserts + advisory judge. Costs money per run. Last: 23/24 hard, 21/24 judge. |
| `node eval/run.js --matrix` | Multi-config comparison. How the model decision was originally made. |
| `npm run chat` | Interactive REPL against the same brain, no Twilio/Deepgram/ElevenLabs/Supabase. |

**Known gap:** `eval/run.js` scores quality but records no timing.
`lib/harness/textSession.js:102-140` already tracks `firstEventMs`/`totalMs` — promote them to
scored dimensions before any vendor bakeoff, or the bakeoff picks the smartest model rather than
the best voice model.

**Repo state as of 2026-08-03:** on `main`. The marketing-site rebuild was deliberately **not**
merged — it lives on `redesign/site-truth-and-polish` (`fbb23ac`), with a second alternative on
`redesign/marketing-site-light` (`60dff60`). Main therefore has no Terms / Privacy / Recording
Disclosure / Acceptable Use pages; those ~985 lines are cherry-pickable from `fbb23ac` without its
design. Untracked `.playwright-mcp/` logs and loose PNGs in the repo root are session artifacts —
the `.gitignore` rules covering them also live only in `fbb23ac`.

---

## 13. What survives a BAA

For reconciling with `2026-08-02-gcp-migration-architecture.md`:

| Choice | BAA status |
|---|---|
| Vertex AI, Cloud Run, Cloud SQL, Identity Platform, Secret Manager, Cloud Storage | Covered, free, self-serve |
| Google STT / TTS (incl. Chirp) | Covered |
| **Gemini 3.1 Flash TTS via Vertex** | **Presumed covered — verify. High-value open item.** |
| Deepgram (Nova-3 or Flux) | BAA on request, tier unpublished |
| Twilio | Security or Enterprise Edition required, unpriced |
| Cartesia | Enterprise tier only |
| Inworld, Groq, Cerebras, Fly.io, Neon, Better Auth | Unknown — all need checking |
| ElevenLabs (any model) | Agents product only; incompatible with this architecture |
| Brevo, Gmail SMTP | None at any price |

**Action item for the HIPAA document:** if Gemini 3.1 Flash TTS is BAA-covered through Vertex, it
replaces Chirp 3 HD as the healthcare voice recommendation — it ranks above ElevenLabs v3 on blind
preference, where Chirp merely "closes the gap." That would change the healthcare voice from a
compromise into a genuine choice.

**Settled 2026-08-03:** the ideal stack and the compliant stack coexist as **one codebase, two
Cloud Run deployments** — same repository, same test suite, same pipeline, differing only in
environment configuration and vendor accounts. Everything in §1-§7 of this document applies to the
standard deployment without compromise; the BAA deployment substitutes covered vendors in the three
slots that require them. See §1 of the companion document.
