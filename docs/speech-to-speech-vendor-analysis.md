# Speech-to-speech: cascade vs Gemini Live vs OpenAI Realtime

**Written 2026-09-01.** Commissioned by the owner: "how long would a full
migration take, which is better, and what does each cost."

Supersedes the vendor half of `docs/receptionist-backlog.md` §9. Two of §9's
conclusions are **reversed** here, both because a criterion changed rather than
because the old arithmetic was wrong — see "What changed since 2026-08-30".

Every number is tagged:

- **[M]** measured in this project, with a source
- **[L]** looked up from a vendor doc on 2026-09-01
- **[D]** derived from [M] and [L] by arithmetic shown in-line
- **[U]** unmeasured — an assumption, flagged as such

---

## 0. The short version

1. **Cost is not a reason to migrate.** At a 3-minute call, the cascade
   ($0.130), Gemini Live with text reseeding ($0.096–0.122) and OpenAI
   `gpt-realtime-2.1-mini` ($0.131) are all within about 7% of each other.
   At 1,000 calls/month the best case saves roughly **$8/month**. Nobody should
   rewrite ~9,800 lines for $8/month.
2. **The residency constraint, which you said binds hard, currently favours
   OpenAI — the opposite of §9's verdict.** The Gemini Live model that was
   actually measured (`gemini-3.1-flash-live-preview`) is **AI Studio only,
   global routing, not on Vertex in any region** [L], and it **does not support
   asynchronous function calling** [L]. OpenAI offers UK and EU regional
   processing for `/v1/realtime` on eligible enterprise projects [L].
3. **"1 day build + 1–2 days debug" buys a demo, not a migration.** A flagged
   parallel front-end that answers one call is genuinely ~8–20 h. A production
   parallel front-end is **73–134 h**. A full cutover is **181–350 h**.
4. **Neither vendor is "perfect" at barge-in.** Both have open, unresolved
   defect reports in exactly the area you would be buying them for. OpenAI's
   `semantic_vad` is a real capability the cascade cannot replicate; Gemini has
   an open report that it never emits `interrupted` when the caller is already
   speaking as the model's turn begins — which is your cough-cutoff failure
   mode.
5. **Recommendation: do not migrate for cost. If you migrate, migrate for
   turn-taking quality, build Shape A, and price OpenAI Realtime mini seriously
   rather than treating it as ruled out.**

---

## 1. What changed since 2026-08-30

§9 was written two days ago and its measurements still hold. Two things moved:

| Then | Now |
|---|---|
| OpenAI ruled out on cost (~$0.41/call, ~5× Gemini) | Still true for the **full** model. But `gpt-realtime-2.1-mini` lands at **~$0.131** [D] — level with the cascade — and its **$0.40/M cached audio input** [L] flattens exactly the quadratic term that makes Gemini Live expensive on long calls |
| "Gemini Live rides the Vertex migration already underway" | **False for the measured model.** `gemini-3.1-flash-live-preview` is AI Studio / global only, no Vertex version in any region [L]. The Vertex-reachable Live model is the older `gemini-live-2.5-flash-native-audio` |
| Residency treated as a footnote | Owner confirmed 2026-09-01 that it **binds hard**. That promotes it from tiebreak to gate |

Neither change is a correction to a measurement. Both are a criterion moving.

---

## 2. Part 1 — How long it actually takes

### 2.1 What has to be built, and what does not

Your stack already splits cleanly. `lib/voice/session.js:25` and
`lib/harness/textSession.js:23` both import `runLlmTurn` from
`lib/voice/llmTurn.js` — two front-ends, one brain, today [M].

- **Brain half survives either migration untouched**: ~5,792 lines of
  capabilities, tools, adapters and reply state [M, §9].
- **Front-end half is what gets replaced**: `session.js` (4,308 lines) plus
  `sttDeepgram`, `ttsStream`, `turnManager`, `echoGuard`, `inboundVad`,
  `endpointArbiter`, `audioOut`, `mulaw` [M, `wc -l`].

### 2.2 The audio-format tax — a real difference between the two vendors

Your entire audio path is **μ-law 8 kHz end to end, with no resampling
anywhere**. ElevenLabs is requested at `output_format=ulaw_8000`
(`services/elevenlabs.js:122`) and `ttsStream.js:145` hardcodes
`MULAW_BYTES_PER_SEC = 8000` [M].

- **Gemini Live** requires raw 16-bit PCM **16 kHz mono little-endian in**, and
  emits **24 kHz out** [L]. You must write and test resampling in **both**
  directions, on the hot path, at telephony quality.
- **OpenAI Realtime** accepts and emits **`g711_ulaw`** natively — the format
  Twilio Media Streams already sends you [L]. Zero resampling.

That is roughly **6–10 h of new hot-path DSP code plus tests** that Gemini costs
you and OpenAI does not. It is also a quality risk: every resample is an
artefact opportunity on a band already limited to 300–3400 Hz.

### 2.3 Hours — Shape A (parallel front-end, flagged)

`lib/voice/liveSession.js` beside `session.js`, per-business flag, cascade stays
live as the control arm.

| # | Work | Gemini Live | OpenAI Realtime |
|---|---|---|---|
| 1 | Audio bridge (resampling both directions) | 6–10 h | **0 h** (native μ-law) |
| 2 | `liveSession.js`: WS lifecycle, setup, session resumption, reconnect | 8–12 h | 8–12 h |
| 3 | Tool bridge: `buildCallTools` → declarations, call/response plumbing | 10–16 h | 8–14 h |
| 4 | Turn/interruption semantics wired to existing enforcement | 8–12 h | 6–10 h |
| 5 | Text reseed of history (the cost fix, LV2) | 8–14 h | 4–8 h (cached audio makes it optional) |
| 6 | Per-business flag + routing | 2–4 h | 2–4 h |
| 7 | Live-backed eval harness so the 43 scenarios still run (LV4) | 10–16 h | 10–16 h |
| 8 | Metrics / cost telemetry parity with `lib/voice/metrics.js` | 4–8 h | 4–8 h |
| 9 | New vendor: project, secrets, region, billing, ZDR paperwork | 1–2 h | 4–8 h |
| | **Build subtotal** | **57–94 h** | **46–80 h** |
| 10 | Live-call debug loop | 16–40 h | 16–40 h |
| | **Shape A total** | **73–134 h** | **62–120 h** |

≈ **9–17 working days** (Gemini) or **8–15 working days** (OpenAI).

Line 10 is the honest one. The cascade needed **three separate rounds of
live-call fixes** — echo containment, punctuation-as-endpointing, filler
duplication [M]. A new front-end does not inherit those fixes; it inherits the
*class* of problem and needs its own rounds. This is wall-clock with your ears
on a phone, not compute.

### 2.4 Hours — Shape B (full cutover)

Everything in Shape A, plus:

| # | Work | Hours |
|---|---|---|
| 11 | Delete cascade front-end, remove Deepgram + ElevenLabs paths | 8–16 h |
| 12 | Rewrite or retire ~10,636 lines of tests + `sim/cutoffSim.sim.js` | 60–120 h |
| 13 | Re-prove every enforcement gate with **no control arm** | 40–80 h |
| | **Shape B total** | **181–350 h** |

≈ **23–44 working days.**

Line 12 is not "delete some tests". `sim/cutoffSim.sim.js:117` mocks
`llmTurn.js` directly; the STT/TTS suites mock `sttDeepgram` and `ttsStream`.
Those tests are the encoded output of the three debugging rounds. Retiring them
retires the record of why the current behaviour is the way it is.

### 2.5 So — is "1 day + 1–2 days" realistic?

**For a demo, yes.** ~8–20 h gets you `liveSession.js` on one flagged tenant
that answers, converses, and probably books — no reseed, no eval harness, no
tool-enforcement proof, no metrics, no residency story. That is a real and
worthwhile thing to build, and it is what §9's LV5 "2–3 day spike" meant.

**For a migration, no** — by roughly an order of magnitude on Shape A and two on
Shape B.

**Can Claude Code do it from one plan file in one session?** No, and not because
of model capability. Two hard reasons:

1. The debug loop is **you on a phone**, not a test suite. Every round of
   turn-taking fixes on the cascade needed live calls with human ears. That is
   wall-clock time no agent compresses.
2. Shape A is 57–94 h of build. That is many sessions. The right shape is a
   plan file executed across sessions with checkpoints — which is what
   `superpowers:writing-plans` and `superpowers:executing-plans` are for.
   One plan file: yes. One session: no.

---

## 3. Part 2 — Head to head

### 3.1 Latency

| | Value | Tag |
|---|---|---|
| Cascade, voice-to-voice p50 | **2,607 ms** | [M] probe C |
| Cascade realistic floor, levers spent | **~2.2–2.4 s** | [M] derived |
| Gemini Live, your measurement | **none taken** | [U] |
| OpenAI Realtime, your measurement | **none taken** | [U] |
| Vendor claims for both | sub-second | [L] |

Both vendors remove three serial hops: Deepgram inference, endpointing decision,
and TTS synthesis. The cascade's `llm_ttfb_ms` alone is 940 ms p50 [M], so
sub-second voice-to-voice is *plausible* — but **you have never measured it, and
this project has a documented history of confident latency claims falling over
on contact with a probe** (`docs/latency-and-tts-tests.md`: the assumed
1,500–1,900 ms turned out to be 3,062 ms).

The caveat §9 raised still stands and is physical: **PSTN is band-limited to
roughly 300–3400 Hz.** Much of what makes ChatGPT voice sound present is
high-frequency detail that does not survive the phone network regardless of
which model generated it.

### 3.2 VAD, barge-in, interruption — the honest version

**Neither is perfect. Both have open unresolved defect reports in this exact
area.**

**Gemini Live** [L]:

- Server-side VAD on by default; configurable via
  `RealtimeInputConfig.AutomaticActivityDetection` with
  `start_of_speech_sensitivity`, `end_of_speech_sensitivity`,
  `prefix_padding_ms`, `silence_duration_ms`.
- Can be disabled entirely — you then send `ActivityStart` / `ActivityEnd`
  yourself, which would let you keep your tuned `endpointArbiter`.
- Emits `serverContent.interrupted` on barge-in.
- `activity_handling` can *suppress* interruption so a long answer completes.
- **Open defect (unresolved, developer forum):** the server never emits
  `interrupted` when the caller is **already speaking as the model's turn
  begins**. That is precisely your cough-cutoff / talk-over failure mode.

**OpenAI Realtime** [L]:

- `server_vad`: `threshold`, `prefix_padding_ms`, `silence_duration_ms`,
  `create_response`, `interrupt_response`.
- **`semantic_vad`: a semantic classifier that decides the caller has finished
  based on the *words*, with `eagerness` = `low` / `medium` / `high` / `auto`.**
- On WebRTC and SIP the server buffers output audio and **auto-truncates
  unplayed audio** on interruption. On raw WebSocket you truncate yourself.

**Why `semantic_vad` matters to you specifically.** Your round-2 finding was
that *punctuation was being used as proof a turn had ended* [M]. Your standing
eval failures include `rambling-elderly` and `impatient-booker` [M, §0]. Those
are semantic end-of-turn problems, and `semantic_vad` is the only feature either
vendor sells that attacks them directly. Gemini's sensitivity knobs are still
acoustic.

**Physics neither vendor escapes:** you measured **~340 ms of added latency per
barge-in removed** [M, live calls 2026-08-27]. That trade is a property of
turn-taking, not of the cascade. Any vendor tuned to interrupt less will be
slower to respond.

### 3.3 Tool calling — the part that decides feasibility

This is the hardest part of either migration, and the two vendors are not equal.

| | Gemini 3.1 Flash Live | Gemini 2.5 Flash Native Audio | OpenAI Realtime |
|---|---|---|---|
| Function calling | yes | yes | yes |
| **Async / non-blocking tools** | **not supported** [L] | supported — `NON_BLOCKING` + `scheduling: INTERRUPT / WHEN_IDLE / SILENT` [L] | server-controlled via `response.create` |
| Your `buildCallTools` shape | already compatible [M, §9] | already compatible | needs a translation layer |

Today `getReplyStreaming` blocks the turn on a tool and plays a filler line [M].
In a live session audio flows both ways while the query runs, so a result can
land after the conversation has moved on. §9 scoped **3–5 weeks** for async
semantics plus re-proving every enforcement gate — that estimate is the single
largest line in any of these budgets and it still looks right.

**The trap:** the Live model you measured is the one that *cannot* do async
tools. Choosing 3.1 Live means keeping blocking tool semantics — which throws
away one of the main architectural reasons to migrate.

### 3.4 Data residency — the gate you said binds

| Option | Residency position | Tag |
|---|---|---|
| `gemini-3.1-flash-live-preview` (the model you measured) | **AI Studio only, `generativelanguage.googleapis.com`, global routing. No Vertex version in any region.** No EU/UK residency | [L] |
| `gemini-live-2.5-flash-native-audio` | On Vertex, **reachable in `europe-west1`**, GA. Supports async tools | [L] |
| Same, in EU | Open developer report (May 2026, unresolved): works turn 1, then **model goes silent from turn 2** with audio still arriving. `gemini-live-2.5-flash-cascade` returns "Publisher Model not found" (1008) in EU | [L] |
| Gemini 3.6 / 3.7 Flash generally | **global region only, no data residency**; 3.5 Flash is the newest with EU residency | [L] |
| Your current `gemini-3.6-flash` on Vertex | **serves at `global` only — 404s at `us-central1` and `europe-west2`** | [M] 2026-08-30 |
| OpenAI Realtime | `eu.api.openai.com` and **UK** among supported regions; regional *processing*, not just storage; TLS terminated in-region via Cloudflare Regional Services; ZDR available | [L] |
| OpenAI Realtime caveats | **Tracing is not EU-residency compliant for `/v1/realtime`.** Residency requires a **new project** — existing projects cannot be converted. Requires enterprise eligibility / advanced data controls approval | [L] |

**Read this carefully, because it cuts both ways.**

Your residency posture is **already compromised at the LLM layer** — 3.6 Flash
serves global-only and you measured that. So Gemini Live on the global endpoint
does not *newly* break anything. But it does not fix it either, and it forecloses
fixing it, because the residency-capable Live model is a generation behind and
has an unresolved EU-specific bug.

OpenAI, on the criterion you said binds hardest, is the only option that offers
**UK regional processing for the realtime endpoint today** — with real paperwork
and a real caveat attached.

### 3.5 Session limits and operational shape

| | Gemini Live | OpenAI Realtime |
|---|---|---|
| Max session, audio-only | **15 min** without compression; unlimited with context window compression [L] | **60 min** hard server-side stop, not configurable [L] |
| Context window | 128k [L] | 32,768 tokens [L] |
| Reconnect | session resumption tokens, valid 2 h after last termination [L] | reconnect and replay state yourself |
| Compression | server-side sliding window; **[M] at `triggerTokens: 3100` the model retained ~1 turn — the saving and the forgetting are the same dial** | n/a — caching does the job instead |

The 15-minute Gemini limit is not a practical constraint for a receptionist call,
but the WebSocket **does get reset periodically by the server** [L], so session
resumption is mandatory work, not optional. §9 already flagged the untested risk
here: whether the model **re-greets or repeats across a reconnect** [U].

### 3.6 Integration with the rest of your stack

| | Cascade | Gemini Live | OpenAI Realtime |
|---|---|---|---|
| Twilio Media Streams audio format | μ-law 8k native | needs resample both ways | **μ-law 8k native** |
| Rides the GCP/Vertex migration | n/a | **no** for 3.1 Live (AI Studio); yes for 2.5 native-audio | no — new vendor, new billing, new secrets |
| Secrets / IAM | in place | in place | new Secret Manager entries, new project |
| Reuses `buildCallTools` | yes | yes | needs translation |
| Reuses `llmTurn.js` brain | yes | yes | yes |
| Vendor count | 4 (Twilio, Deepgram, Gemini, ElevenLabs) | 2 (Twilio, Google) | 3 (Twilio, Google for the rest, OpenAI) |
| Failure blast radius | isolated per vendor; `fallbackFlow.js` exists | **single vendor = single point of failure for the whole call** | same |

That last row deserves weight. The cascade degrades: ElevenLabs quota ran out
mid-testing once and calls still completed on the Google TTS fallback [M]. A
speech-to-speech session has no such seam — if the socket dies, the call dies.
`lib/voice/fallbackFlow.js` (360 lines) has no equivalent on either Live path,
and building one means keeping the cascade anyway.

---

## 4. Part 3 — Cost, all three, with the arithmetic shown

### 4.1 Basis

3-minute call, 10 assistant turns, 2,890-token static prefix, ~180 s of audio
(~60 s caller, ~90 s assistant). Twilio inbound carriage **$0.0085/min =
$0.0255/call** is common to all three and is **included in every "all-in"
figure below**.

Rates [L, re-checked 2026-09-01]:

| Vendor | Rate |
|---|---|
| Gemini 3.6 Flash | in $0.75/M, out $3.75/M, **cached in $0.075/M** (rises to $1.50 / $7.50 / $0.15 on 2027-01-01) |
| Gemini 3.1 Flash Live | audio in $3/M, audio out $12/M, text in $0.75/M, text out $4.50/M |
| Gemini 2.5 Flash Native Audio | audio in $3/M, audio out $12/M, text in $0.50/M, text out $2/M |
| `gpt-realtime-2.1` | audio in $32/M, audio out $64/M, **cached audio in $0.40/M** |
| `gpt-realtime-2.1-mini` | audio in $10/M, audio out $20/M, **cached audio in $0.40/M** |
| Deepgram nova-3 streaming | $0.0077/min |
| ElevenLabs Flash v2.5 | $0.05/1k chars at volume |
| Twilio inbound US local | $0.0085/min |

### 4.2 The current cascade, reconstructed line by line

| Line | Cost | Share |
|---|---|---|
| ElevenLabs Flash v2.5 | $0.0754 | **58%** |
| Twilio carriage | $0.0255 | 20% |
| Deepgram nova-3 | $0.0231 | 18% |
| Gemini 3.6 Flash (cached) | $0.0060 | 5% |
| **Total, cache on** | **$0.130** | |
| Total, cache off | $0.161 | |

[M] — and the four lines sum to $0.130 exactly, which is the check that this
model is right. **The LLM is 5% of your bill. Your TTS is 58%.**

### 4.3 All three, 3-minute call, all-in

| Option | $/call | vs cascade |
|---|---|---|
| Cascade, cache **off** | $0.161 | +24% |
| **Cascade, cache on (today's target)** | **$0.130** | — |
| Gemini Live, baseline (no reseed) | $0.136 – $0.162 \* | +5% to +25% |
| Gemini Live, + text reseed | $0.096 – $0.122 \* | **−26% to −6%** |
| Gemini Live, reseed + prefix halved | $0.085 – $0.111 \* | −35% to −15% |
| OpenAI `gpt-realtime-2.1` (full) | ~$0.34 – $0.41 | +160% to +215% |
| **OpenAI `gpt-realtime-2.1-mini`** | **~$0.131** | **+1%** |

**\* The range is an unresolved arithmetic ambiguity, not model noise.** §9's
Live figures ($0.136 / $0.096 / $0.085) were computed in a scratchpad script
that was never committed [M], so it cannot be confirmed whether Twilio's $0.0255
is inside them. If it is not, every Live figure needs $0.0255 added, and §9's
headline comparison — "$0.096 vs $0.130" — was comparing a model-only cost
against an all-in one. **Resolve this before quoting a saving to anyone.** It is
the difference between a 26% saving and a 6% one.

`gpt-realtime-2.1-mini` derivation [D], to show it is not a guess: new audio in
4,500 tok @ $10/M = $0.045; repeated audio in 20,250 tok @ $0.40/M = $0.008;
prefix ~$0.008 with caching; output audio 2,250 tok @ $20/M = $0.045; Twilio
$0.0255. **Total $0.131.** This independently reproduces §9's "~$0.13" figure by
a different route.

### 4.4 Monthly, at 3-minute calls

| Calls/month | Cascade (cache on) | Gemini Live + reseed (conservative $0.122) | OpenAI mini | OpenAI full |
|---|---|---|---|---|
| 100 | $13.00 | $12.20 | $13.10 | $37 |
| 1,000 | $130 | $122 | $131 | $370 |
| 10,000 | $1,300 | $1,220 | $1,310 | $3,700 |
| 100,000 | $13,000 | $12,200 | $13,100 | $37,000 |

**Read the middle three columns.** At 1,000 calls/month the spread between the
cascade, Gemini Live and OpenAI mini is **$11**. Even on the optimistic reading
of the ambiguity in §4.3, the best case at 1,000 calls is **$34/month saved**
against a 73–134 h build.

**Migrating for cost is not defensible at any volume you can currently
foresee.** If cost is the goal, the lever is line 1 of table 4.2: ElevenLabs is
58% of the bill, and `scripts/voice-ab.js` exists, is keyed, and **has never
been listened to** [M].

### 4.5 How cost scales with call length — where it gets interesting

Your cascade is **linear** in call length. Both speech-to-speech APIs are
**quadratic**, because every turn re-bills the whole accumulated audio context —
this is measured, not assumed: audio prompt tokens went **47 → 827 over 6
turns**, monotonic, each turn's delta matching *new caller audio + previous model
output* to within 1–3 tokens [M].

The two vendors pay that quadratic term at wildly different rates:

- **Gemini charges the repeated audio at the full $3/M.**
  `cachedContentTokenCount` was **zero on every turn** of the probe [M] — no
  audio-input cache discount exists.
- **OpenAI charges repeated audio at $0.40/M** [L] — a 98.75% discount off its
  own $32/M, and **7.5× cheaper per repeated token than Gemini's $3/M.**

Modelled at an 8-minute call, ~27 turns [D]:

| Option | ~$/call at 8 min |
|---|---|
| Cascade, cache on | ~$0.35 |
| Gemini Live, **no reseed** | ~$0.71 |
| **Gemini Live, with text reseed** | **~$0.22** |
| OpenAI mini | ~$0.39 |

**Two conclusions from that table, and they are the sharpest results in this
document:**

1. **Text reseeding is not a nice-to-have optimisation — it is the entire
   economic case for Gemini Live.** Without it, Live costs *double* the cascade
   on a long call. With it, Live is the cheapest thing on the page. §9 rated LV2
   `[cheap]` / P2; it is actually load-bearing, and it carries two unmeasured
   quality risks (name mangling on reseed, doubled greeting across a recycle).
2. **OpenAI's cache discount does for it, automatically, most of what reseeding
   does for Gemini manually.** That is why the two converge as calls lengthen,
   and it is a strong argument against §9's flat dismissal of OpenAI.

**[U] Caveat:** call-length distribution is unknown. Production is **pre-launch
with no live traffic** [M], so there is no measured average call length. If real
calls turn out to be 90 seconds, every quadratic effect above shrinks toward
irrelevance and the cost comparison collapses to "all the same". **The single
cheapest thing that would improve this analysis is one week of real call
duration data.**

---

## 5. Part 4 — What is still unmeasured

Ranked by how much the answer would move.

| # | Unknown | Why it matters | Cost to close |
|---|---|---|---|
| 1 | **Real call length distribution** | Decides whether the quadratic term matters at all; §4.5 collapses without it | free — one week of post-launch telemetry |
| 2 | **Voice-to-voice latency on either API, over 8 kHz μ-law** | The main claimed benefit. This project has been wrong about latency before by 60% | ~$2 of probes + a phone |
| 3 | **Whether either sounds better on a phone handset** | §9's gate question 2. Band-limiting may erase the difference | your ears, one call each |
| 4 | Twilio inclusion in §9's Live figures (§4.3) | 26% saving vs 6% saving | free — re-derive |
| 5 | Barge-in behaviour on real callers, incl. the reported Gemini `interrupted` bug | Turn-taking is the actual reason to migrate | ~$2 of probes |
| 6 | Whether reseed mangles hard-to-spell names | Would kill LV2, which §4.5 shows is load-bearing | ~$1 of probes |
| 7 | Whether the EU turn-2 silence bug on `gemini-live-2.5-flash-native-audio` is real and current | Decides if Gemini has *any* residency-compliant Live option | ~$1 of probes |
| 8 | ElevenLabs alternatives (`scripts/voice-ab.js`, built, never run) | 58% of the bill — larger lever than the entire migration | free, offline |

---

## 6. Recommendation

**Do not migrate for cost.** §4.4 closes that argument at every volume in view.

**Do not cut over (Shape B) under any circumstance discussed here.** 181–350 h,
no control arm, and it retires the test suite that encodes three rounds of
live-call debugging — against a stack whose own P0-2 and P0-3 validation is
still open, so any regression would be unattributable.

**If you migrate, the order of operations is:**

1. **Close item 8 first** (ElevenLabs A/B). It is free, offline, and aims at 58%
   of the bill. Doing a 73–134 h migration before running a test that is already
   built and keyed is the wrong order.
2. **Close item 1** (call length) with real traffic. It is free and it decides
   whether §4.5 matters.
3. **Then spike Shape A** — but spike **both vendors**, not just Gemini. The §9
   dismissal of OpenAI predates the residency constraint binding, and did not
   price the mini model or the cached-audio discount.
4. **Gate on §9's two questions, unchanged and still right:** does it book
   correctly with requirements enforced, and does it sound better *on an 8 kHz
   μ-law phone line* — not on a laptop.

**If forced to pick one vendor today, on the criteria as weighted:** OpenAI
`gpt-realtime-2.1-mini`. Not because it is better — it is unmeasured, exactly
like Gemini — but because it is the only one that is **native μ-law** (no
resampling tax), has **`semantic_vad`** (the only feature aimed at your actual
measured turn-taking failures), and offers **UK regional processing** on the
criterion you said binds hardest. The cost gap that ruled it out does not exist
on the mini model.

The counter-argument, stated fairly: it is a fourth vendor in a stack you are
mid-way through consolidating onto GCP, it has no fallback path, and its
residency route requires enterprise eligibility you may not have. Those are real
and might well outweigh the above — but they are procurement questions, not
technical ones, and they deserve to be answered on their own terms rather than
by reflex.

---

## Sources

Vendor documentation consulted 2026-09-01:

- [Gemini Live API overview](https://ai.google.dev/gemini-api/docs/live-api)
- [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [Live API session management](https://ai.google.dev/gemini-api/docs/live-session)
- [Vertex AI Gemini Live API](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api)
- [Asynchronous function calling with Gemini Live](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/asynchronous-function-calling)
- [Vertex AI data residency](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency)
- [Forum: gemini-3.1-flash-live-preview on Vertex AI — EU region availability?](https://discuss.ai.google.dev/t/gemini-3-1-flash-live-preview-on-vertex-ai-eu-region-availability/144429)
- [Forum: Vertex AI Live API — only native-audio reachable in EU, breaks on turn 2](https://discuss.ai.google.dev/t/vertex-ai-live-api-only-native-audio-reachable-in-eu-and-it-breaks-on-turn-2-cascade-models-return/144760)
- [Forum: Live API server never emits interrupted (barge-in)](https://discuss.ai.google.dev/t/gemini-3-1-flash-live-preview-live-api-server-never-emits-interrupted-barge-in-when-the-user-is-already-speaking-as-the-models-turn-begins/174346)
- [OpenAI Realtime: voice activity detection](https://developers.openai.com/api/docs/guides/realtime-vad)
- [OpenAI Realtime conversations](https://platform.openai.com/docs/guides/realtime-conversations)
- [OpenAI Realtime with WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket)
- [OpenAI Realtime with SIP](https://developers.openai.com/api/docs/guides/realtime-sip)
- [OpenAI: data controls in the platform](https://developers.openai.com/api/docs/guides/your-data)
- [OpenAI: expanding data residency worldwide](https://openai.com/index/expanding-data-residency-access-to-business-customers-worldwide/)
- [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)
- [Twilio: minimalist integration with OpenAI Realtime](https://www.twilio.com/en-us/blog/minimalist-integration-twilio-openai-realtime)

Project sources: `docs/receptionist-backlog.md` §0 and §9,
`docs/latency-and-tts-tests.md`, and direct measurement of this repository.
