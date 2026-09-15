# GPT-Live-1: what it is, and whether we should move to it

**Written 2026-09-14.** Prompted by the owner hearing about OpenAI's new voice
model and asking whether it is a better answer than the Gemini Live front-end we
run today.

Companion reading: `docs/speech-to-speech-vendor-analysis.md` (2026-09-01, the
three-way costing), `scripts/probes/` (the $7.02 probe round that chose Gemini),
`docs/receptionist-backlog.md` §9.

**Everything below is four days old.** GPT-Live-1 reached the API on
**2026-09-10**. There is one independent benchmark and no independent latency
measurement. Treat every OpenAI-published number as a vendor claim.

---

## 1. What it is, in plain words

Three generations of phone-AI architecture, in order:

**Generation 1 — the cascade (what we ran until the Live front-end).**
Caller speaks → speech-to-text → a text model thinks → text-to-speech speaks.
Four hops. Every hop adds delay. The machine cannot hear you while it is
talking, so it must *decide* when your turn ended — and that decision is where
our cut-off bugs lived.

**Generation 2 — speech-to-speech (Gemini Live, OpenAI Realtime; what we run
now).** One model takes audio in and puts audio out. Faster and more natural,
but it is still **turn-based**: it listens, then it talks, then it listens. It
still has to guess when you stopped speaking, and in this architecture *the
vendor* owns that guess, not us. That is the source of `LIVE_TURN_END`, the
hangover timer, and the trail-off cut-offs we measured 5/5 at default.

**Generation 3 — full duplex (GPT-Live-1).** The model listens and speaks **at
the same time**, the way a person does. There is no "whose turn is it" decision
to get wrong, because there are no turns. It can say "mm-hm" while you are still
talking, and it can hear you interrupt it mid-sentence without a timer deciding
anything.

The second big idea is the one that matters more for us:

> **GPT-Live-1 is not a brain. It is a mouth and a pair of ears.**

It is deliberately a thin, fast voice layer with a small context window. When
the conversation needs actual thinking — check availability, book the slot,
look up the price — it **delegates** to a separate, ordinary text model that you
choose and configure. OpenAI calls this *delegation*. Its knowledge cutoff is
July 2025 and it is not meant to know anything; it is meant to sound human while
something smarter works behind it.

That is the opposite of Gemini Live, which is one model doing both jobs.

---

## 2. The architecture

```
  Caller (Twilio, mu-law 8k)
        |
        v
  +-----------------------+        audio in and out, both directions,
  |     gpt-live-1        |  <---- simultaneously. $0.05/minute, billed
  |  (ears + mouth only)  |        per second. It owns turn-taking,
  +-----------------------+        barge-in, backchannels, tone.
        |          ^
        | delegate | result
        v          |
  +-----------------------+
  |   the brain           |   <--- YOU choose this
  +-----------------------+
     two modes:
     (a) "responses" delegation: OpenAI calls a Responses model for you
         (gpt-5.6-terra $2/$12 per 1M, or gpt-5.6-luna $0.20/$1.20 per 1M).
         Tools declared in delegation.responses.tools, executed in your process.
     (b) "client" delegation: OpenAI calls nothing. It raises a
         session.delegation.created event with an id, and YOUR code decides
         everything and hands back a result.
```

Transports: WebRTC, WebSocket, server-side sideband, and **SIP/telephony**.
Twilio ships a native `GPTLiveProvider` in Agent Connect that wires Voice Media
Streams straight to it, plus Media Streams tutorials. Telnyx, LiveKit and
Pipecat have plugins.

**Mode (b) — client delegation — is the one that should interest us**, and it is
the single most important finding in this document. Our brain is
`lib/voice/llmTurn.js` and its ten tools, plus the guard stack we spent three
weeks building: the consent latch, the claim guard, `isUnusableTranscript`, the
write-order gate, the availability check. Client delegation means the voice
layer asks *us* a question and speaks *our* answer. It hands back the text
chokepoint that going Live took away.

Three channels exist for pushing text into a live session, each capped at 500
tokens:

| channel | what it does |
|---|---|
| `session.instructions.append` | change behaviour for the rest of the call |
| `session.thinking.append` | context the model may use, never spoken |
| `session.commentary.append` | content the model speaks — **in its own words** |

---

## 3. What it costs

**$0.05 per minute of voice, billed per second**, plus backend model tokens,
plus tools. No free tier. Concurrency-based rate limits (25 sessions on tier 1,
500 on tier 5).

A 3-minute, 10-turn call — the unit we have costed everything else in:

| line | cost |
|---|---|
| voice layer, 3 min | **$0.150** |
| backend, gpt-5.6-luna (~3.9k-token prefix x ~8 delegations + output) | ~$0.008 |
| backend, gpt-5.6-terra instead | ~$0.075 |
| **total, Luna backend** | **~$0.158** |
| **total, Terra backend** | **~$0.23** |

Against the numbers already in the repo: cascade **$0.130**, Gemini Live +
reseed **$0.096–0.122**, Gemini Live baseline **$0.136**.

So GPT-Live is **1.2x to 1.7x our current cost**, and the shape of the bill
changes in a way worth naming: **it is linear in wall-clock seconds, not in
tokens.** Silence costs money. A caller who puts us on hold costs money. Against
that, it kills the quadratic context re-billing that is Gemini Live's defect —
the thing text reseeding exists to work around.

At our pricing ladder ($0.31/call basis) this is affordable. **Cost is again not
the deciding factor, in either direction.**

---

## 4. What people actually say about it

**Named production users, all via OpenAI's own launch post** — so, selected
quotes, not a survey:

- **Speak** (language learning): "almost 80% fewer interruptions" than their
  previous turn-based system.
- **Yelp's CTO**: callers now speak in "fuller, more natural sentences" — i.e.
  people stop clipping themselves because the machine stopped cutting in.
- One customer "cut its voice codebase by 80%", deleting **23,000 lines** used
  for real-time patient conversations.
- Also live: Intercom's Fin, Cognition's Devin.

**Developers, unfiltered:**

- "full duplex models are amazing" — a dev who moved off self-hosted Fish Audio.
- "Why would openai keep realtime 2.1 when gptlive 1 is so much superior?"
- **The loudest complaint is transcripts**: "Unlike Realtime, we can't retrieve
  the conversation transcript because GPT-Live d[oesn't] transcribe the user's
  voice." The migration guide contradicts this — it documents
  `session.input_transcript.delta` — but it also says fragments "can arrive late
  or overlap with assistant speech" and are not turn boundaries. Something here
  is either a bug, a rollout gap, or a misunderstanding. **We must settle it
  before anything else** (see §7).
- A reviewer who put it on support queues: without delegation it "isn't
  particularly intelligent"; it over-uses "hmm"; it **paraphrases after every
  user input**.
- Per-minute billing "charges you for talk time, not problems solved."

**Independent measurement** — the one source not derived from OpenAI's post,
Artificial Analysis' Speech-to-Speech Index (equal-weighted speech reasoning,
agentic performance, arena preference, task success):

| model | index | latency |
|---|---|---|
| GPT-Live-1 (Astra backend, medium effort) | **81.5** | 1.34 s |
| Grok Voice Think Fast 2.0 High | 81.3 | **0.70 s** |
| GPT-Live-1 (Sol backend, low effort) | 80.1 | 1.24 s |
| GPT-Realtime-2.1 High | 73.9 | 1.21 s |
| **Gemini 3.1 Flash Live High** (what we run) | **71.5** | **2.99 s** |
| Gemini 3.1 Flash Live Minimal | 63.9 | 0.96 s |

An earlier reading of the same index scored GPT-Live-1 at **69.8, seventh of
eleven — below GPT-Realtime-2.1.** Both readings are real, and the reason is the
architecture: **the score is the pairing, not the model.** OpenAI's own
headline numbers come from different backends at different reasoning efforts —
Full Duplex Bench v3 on Terra at low effort, the 30-point Tau3 claim on GPT-6
Astra at medium. Whenever anyone quotes a GPT-Live score, the only useful
question is *which brain was behind it and at what effort*.

Two numbers from that table deserve to be read twice: our production model is
**last on quality and slowest by a factor of two** among models anyone
independently measured.

---

## 5. What it would fix for us

Mapped against defects that are open in the backlog or in memory today, not
against hypotheticals.

| our open defect | does GPT-Live fix it? |
|---|---|
| **Trail-off cut-offs.** Gemini 3.1 cuts into a trailing-off caller 5/5 at default, 3/5 even at `END_SENSITIVITY_LOW` + 1200 ms. *No setting fixes it, and in S2S the VAD is the vendor's.* | **Structurally, yes.** Full duplex has no endpointing decision to get wrong. This is the single strongest argument for the move, and it is the defect we have failed to fix three times. |
| **Latency.** Connect alone is ~2,200 ms on every call, in front of the greeting; AA measures the model at 2.99 s. | **Probably.** 1.24–1.34 s measured independently, 0.798 s claimed. Unknown whether session setup is as heavy as `live.connect()`. |
| **Caller turns transcribed in the wrong language**, with no fix in the Gemini API — `AudioTranscriptionConfig` is an empty interface. | **Possibly.** GPT-Live ships **keyword biasing and alphanumeric understanding**, which is exactly the control surface Gemini denies us. |
| **Spelling of names.** Four rounds of fixes; read-back cannot catch a spelling error. | Same answer — keyword biasing and alphanumeric recognition are aimed precisely here. Unmeasured. |
| **Guards became detectors.** Going Live removed the text chokepoint; the offer was spoken a second before the lookup ran. | **Only in client delegation**, and only partly — see §6. |
| **No residency.** `gemini-3.1-flash-live-preview` is AI Studio, global, preview. No Vertex publisher model in any region; `europe-west2` serves no Live model at all. | **Yes, and this is the quiet one.** GPT-Live supports data residency in Europe via a region-pinned project on `eu.api.openai.com`. Our UK-first estate currently runs its voice path through a global preview endpoint with no residency guarantee at all. |
| **mu-law integration tax.** | Already paid. We resample mu-law 8k ↔ PCM 16k/24k in `lib/voice/live/index.js`. If GPT-Live takes `g711_ulaw` natively we delete code rather than write it. |

---

## 6. What it does NOT fix, and what it breaks

This is the half that decides it.

**It speaks before the backend is done — by design.** The migration guide says
it outright: GPT-Live "can speak while backend work is still running", so
withholding a tool result does not stop it talking. And: **"a corrective
instruction cannot retract audio already heard."** That is *our exact bug* —
the offer spoken one second before the lookup returned — restated as a documented
property of the platform. Full duplex makes it structurally worse, not better,
because the model is designed to keep the floor.

**Silent gaps in a quarter of delegated cases.** Full-Duplex-Bench-v3 finds dead
air in ~25% of delegations. We have fought dead air before (the reschedule
stall). It is manageable — you hold the floor deliberately — but it is work we
would be doing again.

**It cannot say a fixed sentence.** `session.commentary.append` content is spoken
"in its own words"; LiveKit's plugin raises an error on `session.say()` because
the model cannot speak a word-for-word script. Our **recording disclosure** is a
legal string. Our read-back of an appointment time is the thing a booking hangs
on. A layer that paraphrases by design is a real hazard for both, and there is
no flag to turn it off.

**There is no "the response finished" event.** Neither `output_audio.done` nor
`response.done` confirms audio finished playing. `closeKind.js`, the `end_call`
mark, the doubled-goodbye fix and the hang-up path are all built on knowing when
a reply ended. That logic is not ported; it is redesigned.

**Transcripts stop being turn-shaped.** They arrive as deltas that overlap
assistant speech, and timestamps are explicitly "not definitive turn
boundaries". Our entire guard stack reads turns: the consent latch, the
affirmative check, `isUnusableTranscript`, `looksNonEnglish`. On a lossy
transcript we already lost 1,500 ms of speech logged as zero characters. This
gets harder, not easier.

**Self-correction is weak.** Under 59% on scenarios where the caller changes
their mind mid-sentence — and when the model keeps talking while listening it
can "lock in a caller's outdated intent". OpenAI's own eval cookbook names
"booking wrong dates after corrections" and "creating reservations when only
availability was asked" as headline failure modes. Those are LVX tickets we have
already written, about a different vendor.

**Everything we know about turn-taking becomes worthless.** `LIVE_TURN_END`'s
three arms, `halfDuplex.js`, the hangover timer, `classifyHold` — all of it is
answering a question full duplex does not ask. LiveKit's guidance is explicit:
do not invest in custom VAD, the model owns those decisions. That is ~7,000
lines of `lib/voice/live/` where the turn-taking half does not carry over.

**And it is four days old.** No independent latency number exists. Our current
model was chosen after three probe rounds and $7.02 of measurement, and one of
those rounds overturned the one before it.

---

## 6a. Which of our bugs follow us, and which do not

The owner's question, 2026-09-14: *if we keep our own brain, don't all the
Gemini Live problems just come with it?*

**About half. And the half that follows us is the half that is ours.** That
sounds like a tautology; it is the whole decision. A defect caused by the vendor's
voice layer is one we have failed to fix three times, because we do not own the
code. A defect caused by our brain is one we have fixed, repeatedly, on a
Tuesday.

Six real scenarios, all drawn from calls that actually happened:

### A. The caller trails off

> *"I'd like to book something for… um… maybe Thursday?"*

**Today:** it cuts in on "um". Measured 5/5 at default, 3/5 at
`END_SENSITIVITY_LOW` + 1200 ms. **No setting fixes it, because the VAD is
Gemini's.** Three attempts, three failures.

**GPT-Live, either brain:** no cut-off is possible, because no "has the turn
ended" decision exists to get wrong. It can say "mm-hm" over the pause and keep
listening. **Fixed by the move. Nothing to do with which brain.**

### B. "Do you have Thursday at two?"

This is the one that matters.

**Today:** the model speaks the offer, and a second later the availability lookup
returns. Going Live turned our guards from *gates* into *detectors* — they notice
afterwards, they cannot stop the sentence.

**GPT-Live is not a fix for this.** The migration guide says so outright: it
"can speak while backend work is still running", and "a corrective instruction
cannot retract audio already heard." Full duplex makes holding the floor easier,
not harder to abuse.

**But the two brains fail differently, and the difference is not small:**

- **Their brain (responses):** their model can see the diary — the tools are
  declared to it. So the sentence it speaks early can be a *specific factual
  claim*: "Thursday at two is free." That is the bug we already have, with a new
  vendor's name on it, and OpenAI's own eval cookbook lists "creating
  reservations when only availability was asked" as a headline failure mode of
  exactly this setup.
- **Our brain (client):** the voice layer has **no tools and no diary**. It has a
  small context window and literally cannot see whether Thursday is free. The
  worst it can invent is filler — "let me check that for you." It cannot read out
  a slot list it never received.

It is not immunity. It could still say "sure, Thursday at two, let me get that
booked" and have the caller hear a confirmation. **But the surface shrinks from
"can state any fact about the diary" to "can sound encouraging."** For a
receptionist whose whole liability is false confirmations, that is the argument.

### C. "It's Siobhán — S-I-O-B-H-Á-N"

**Today:** four rounds of fixes. Read-back cannot catch a spelling error, because
the model reads back what it *heard*. And Gemini's input transcription cannot be
constrained at all — `AudioTranscriptionConfig` is an empty interface, so there
is no hint, no bias, no language pin.

**GPT-Live, either brain:** ships **keyword biasing and alphanumeric
understanding** — a control surface Gemini denies us — plus a separate
`gpt-live-transcribe` model we did not know existed. **Vendor-layer, so the move
addresses it and the brain choice is irrelevant.** Unmeasured; this is G2's real
prize.

### D. "Thursday at two — no, wait, Friday"

**Today:** our bug, and a known one.

**GPT-Live: worse, and this is the strongest thing against the move.**
Self-correction succeeds in **under 59%** of scenarios, and when the model keeps
talking while listening it can "lock in a caller's outdated intent" — a failure
mode that turn-based systems structurally cannot have, because they hear the
whole sentence before acting. **Follows us on either brain, and full duplex
introduces it.** Our brain at least gets the correction in the transcript before
the write; their brain may have already called the tool.

### E. "Yeah, go on then" — and then silence

**Today:** the consent latch fires on a *completed caller turn*. That is how it
knows the caller agreed and not that they were mid-sentence.

**GPT-Live: this gets harder, on either brain.** From OpenAI's own SDK
docstring: input transcript fragments "do not define complete turns or include a
transcript-done event." Fragments arrive with millisecond timestamps and nothing
else. **We would rebuild turn segmentation ourselves, inside the layer that
authorises database writes** — the exact decision full duplex was supposed to
delete, reappearing one level down.

This is the cost nobody mentions in any launch coverage, and it is real work.
With their brain we would not do this work — we would simply not have the
guarantee.

### F. The goodbye

**Today:** `closeKind.js`, the `end_call` mark, the doubled-goodbye fix — all
built on knowing a reply ended.

**GPT-Live: harder, either brain.** Neither `output_audio.done` nor
`response.done` confirms audio finished playing. And the recording disclosure is
a legal string we must say verbatim, while `commentary.append` content is spoken
"in its own words" and LiveKit's plugin errors on `session.say()`. **A layer that
paraphrases by design is a hazard for both the disclosure and the read-back, and
there is no flag to turn it off.**

### The tally

| our defect | cause | does the move help? | does the brain choice matter? |
|---|---|---|---|
| trail-off cut-offs | vendor VAD | **yes, structurally** | no |
| latency 2.99 s | vendor | **yes** | no |
| spelling / wrong-language ASR | vendor | **probably** | no |
| speaks before the lookup lands | the seam | no — documented behaviour | **yes, and it is the main reason to keep ours** |
| mid-sentence corrections | ours, worsened | **no, worse** | slightly |
| turn boundaries for guards | ours, worsened | **no, worse** | **yes — with their brain we lose the guarantee instead of rebuilding it** |
| goodbye / hangup | ours + vendor gap | no, worse | no |
| booked-slot-vs-verified-slot, consent asymmetry, prompt caps | **ours** | no — they follow us anywhere | **yes: ours means we can still fix them** |

**Read the last row twice.** Every bug that follows us is a bug we have the
source for. That is the actual case for client delegation — not that it prevents
mistakes, but that it keeps them ours to fix.

---

## 7. What it would take, and the five questions that decide it

**The round is pre-registered at `scripts/probes/PLAN-gptlive.md`** (written
2026-09-14, NOT authorised to run). It carries the gates below with their
predictions, the two delegation arms, the new spend meter, and the call protocol
for the owner's two-arm test. Read that file before running anything; read this
section for why.

**Do not migrate. Probe.** The pattern that worked in this repo is a
pre-registered probe with falsifiable verdicts and a spend ceiling enforced in
code (`scripts/probes/PLAN.md`), and it has twice overturned a confident
prediction.

Five questions, each with a fail condition, in the order that kills the idea
fastest and cheapest:

| # | question | fail condition | cost |
|---|---|---|---|
| **G1** | Does our key have access, and does `gpt-live-1` accept `g711_ulaw` at 8 kHz? | either is no → the integration tax returns and the schedule doubles | **$0** |
| **G2** | Do we get caller transcripts we can gate on — text, attributable to the caller, before we must decide? | no usable input transcript → **the whole guard stack is unbuildable, stop here** | ~$0.20 |
| **G3** | Replay the trail-off fixtures from `test-audio/caller/`. Does it cut into a trailing-off caller? | cuts 2/5 or worse → the main reason to move evaporates | ~$0.50 |
| **G4** | Client delegation with our ten tools: does it ever speak an offer before the availability result lands? | speaks unverified availability in >1/10 → we are buying our worst bug back at 1.5x the price | ~$1.50 |
| **G5** | Does `commentary.append` preserve an exact appointment time and an exact disclosure sentence? | paraphrases either → read-back and the legal disclosure both need a new design | ~$0.50 |

Roughly **$3–5**, under the $10 ceiling the owner already set, and G1 is free.

If all five pass, the build is a **third front-end beside `session.js` and the
Live path**, behind a per-business flag — the same shape that made the Gemini
Live spike survivable, and for the same reason: the incumbent stays as the
control arm. The brain (`llmTurn.js`, tools, guards) is transport-agnostic and
ports. The transport, the event model and the turn-taking do not. Estimate on
the same basis as the 2026-09-01 analysis: **60–110 hours**, cheaper than the
first Live front-end because the seam already exists, and most of it is
re-deriving what "the turn ended" means when nothing has turns.

---

## 7a. G1 RESULT — run 2026-09-14, $0 spent

Run against our existing `OPENAI_API_KEY` (a service-account key). Read-only
`GET`s plus deliberately-invalid `POST`s that return errors and create nothing,
and the OpenAI SDK's own generated types via `gh`. No session was ever opened.

**G1 passes, and two of §9's unknowns are now closed.**

| check | result |
|---|---|
| `GET /v1/models/gpt-live-1` | **200.** No alpha gate. LiveKit's "requires alpha access" note is stale. |
| µ-law telephony audio | **`audio/pcmu`, mono G.711 µ-law, 8000 Hz, documented as "for a Live WebSocket connection".** Twilio's exact format. |
| transport | `POST /v1/live/sessions` mints **WebRTC only** ("Only the webrtc transport is supported"); WebSocket connects directly and is the transport that accepts `audio.format`. WebRTC and SIP negotiate media themselves. |
| SIP | recognised but org-gated: `outbound_sip_not_enabled`. Inbound untested. |
| caller transcripts | **the event exists** — `session.input_transcript.delta`, with `start_ms`/`end_ms` on the session timeline. |
| voices | 22 built-in (`marin` default, immutable after startup) plus custom voice IDs. |

**The µ-law result is better than the §5 guess.** We do not merely avoid a new
integration tax — we would **delete** the one we already paid.
`mulaw8kToPcm16k`, the downsampler and the framer in `lib/voice/live/index.js`
exist because Gemini Live demands PCM 16k in and 24k out. GPT-Live takes the
Twilio frame as it arrives, and hands one back in the same encoding.

**Also discovered: `gpt-live-transcribe` is a separate model on our key.**
Not mentioned in any launch coverage. It is the likely explanation for the
developer complaint about missing transcripts — transcription may be a thing you
attach rather than a thing you get.

**And the caveat that reshapes G2, in OpenAI's own words**, from the generated
SDK docstring for the input-transcript event:

> "Accumulate fragments in delivery order; **these events do not define complete
> turns or include a transcript-done event.**"

So caller text *is* available, with millisecond timestamps — but **nothing tells
us a caller utterance ended.** Every guard we own (the consent latch, the
affirmative check, `isUnusableTranscript`, the write-order gate) fires on a
completed caller turn. On GPT-Live we would have to define "the turn ended"
ourselves, from timestamps and silence — which is the exact decision full duplex
was supposed to delete, reappearing one layer down, in the layer that authorises
database writes.

That is not a blocker. It is the real shape of the work, and it is worth more
than the $0 it cost to find.

G2 therefore narrows to: **are those fragments accurate and timely enough to gate
a write on?** Still needs audio, still needs the ~$0.20.

---

## 7b. THE ROUND RAN — 2026-09-15, $0.8185 of $5

Full results: **`scripts/probes/report-gptlive.md`**. 57 sessions, every
prediction pre-registered before the first socket. Headlines:

- **G3 PASSED and it is the big one.** **0 cut-ins of 10** on the exact two
  fixtures where Gemini 3.1 cuts in 5/5. The defect we failed to fix three times
  is structurally gone.
- **Much faster.** Session start **p50 470 ms** against Gemini's ~2,200 ms on
  every call; turn latency **p50 0 ms, p90 800 ms** against 2.99 s.
- **Caller transcription is excellent.** Median WER **0.000**, and the spelled
  name — four rounds of fixes on our side — came back at 0.000/0.091/0.091.
- **Turn boundaries are reconstructible**, at 9/10 with an 800 ms gap rule and a
  plateau out to 3,000 ms. §6a called this "real work"; it is real, and it is
  smaller than feared.
- **My G4 argument was WRONG.** I predicted their brain would state an
  unverified slot in ≥3 of 10. **Both arms scored 0 of 10.** Client delegation
  bought nothing on the axis I claimed. What it does buy showed up elsewhere:
  arm R's backend **never consulted the diary in 3 of 10 takes**, matching round
  3's 9-of-20 skip rate on `gpt-realtime-2.1`.
- **G5 FAILED, and it is now the blocker.** `commentary.append` was acknowledged
  every time and **spoken only about 40% of the time**. 0 of 10 verbatim. When it
  did speak, the facts survived intact — but a recording disclosure that reaches
  the caller 1 time in 5 is not a disclosure. §6's worry was paraphrase; the real
  problem is delivery.

**Three of the harness's own instruments were wrong first**, one of which scored
10 of 10 cut-ins and would have published the exact opposite of the truth. The
output stream is continuous and carries silence, so counting audio events counts
silence. Detection is now energy-based. See the report.

---

## 8. Verdict

**Not now — and the reason is not the vendor.**

Phase 1 closes with a business ringing a number and judging how it sounds. We
have never had that call. Every prior round of predicted fixes was outscored by
one real call, and four of one round's own fixes introduced defects. Switching
the voice layer before a single business has tested the current one means we
would be tuning a new stack against a guessed list of complaints instead of a
real one.

**But the incumbent is on borrowed time, and that is new information.**
`gemini-3.1-flash-live-preview` is a preview model, on a global endpoint, with
no Vertex publisher entry in any region, no residency, and it now sits last on
the only independent quality index — at 2.99 s where GPT-Live measures 1.24 s.
For a UK-first product with a residency story, that is a standing liability
regardless of what OpenAI shipped last week. We were always going to have to
move off it. The real question is whether the destination is a
residency-capable Gemini Live model on Vertex, or GPT-Live-1.

**Owner decision, 2026-09-14: UK/EU residency on the voice path is HARD —
required before any business signs.** That converts a someday item into a dated
one. Today the voice path runs on `gemini-3.1-flash-live-preview`, an AI-Studio
global preview endpoint with no residency guarantee, and there is no Vertex Live
model in `europe-west2` at all. So **moving off the incumbent is now a
prerequisite for the first signature, not a phase-4 nicety** — and it is the
reason this document is no longer optional reading. The two candidate
destinations are a residency-capable Gemini Live model on Vertex
(`gemini-live-2.5-flash-native-audio` in `europe-west1`, which carries an
unresolved EU turn-2-silence report) and GPT-Live-1 on an EU-pinned
`eu.api.openai.com` project. Both need the DPA/ZDR question in §9 item 4 settled
in writing.

**So: run G1 today (free), G2–G5 in one pre-registered round after the UK
handset call.** G2 is the one that matters — if the caller transcript is not
gateable, none of the rest is worth reading, because every write guarantee we
have depends on reading what the caller actually said.

---

## 9. Unknowns, flagged rather than guessed

1. **Transcripts.** Docs and developers disagree. G2.
2. **Access.** The model card lists per-tier concurrency limits, but LiveKit's
   plugin says "requires an API key with GPT-Live **alpha** access." One of the
   two is stale. G1.
3. **Audio format.** `pcm16` / `g711_ulaw` / `g711_alaw` are the Realtime
   options; PCM16 is specified at 24 kHz. Not separately confirmed for
   `gpt-live-1`. G1.
4. **Zero data retention.** One source says GPT-Live does not support ZDR;
   OpenAI's residency documentation says EU-region projects get regional
   processing *with* zero retention. Contradiction, unresolved, and it matters
   for the DPA clock already running.
5. **`gpt-live-1-mini`** was announced for the API and does not appear on the
   model page. If it exists, the $0.05/min floor may not be the floor.
6. **Session length.** Plugins expose `max_session_duration` with reconnection.
   Unknown what a 20-minute call does.

---

## Sources

OpenAI: [GPT-Live-1 in the API](https://openai.com/index/introducing-gpt-live-1-in-the-api/),
[Introducing GPT-Live](https://openai.com/index/introducing-gpt-live/),
[Getting started](https://developers.openai.com/api/docs/guides/live),
[Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation),
[Migrate to GPT-Live](https://developers.openai.com/api/docs/guides/live-migration),
[Prompting](https://developers.openai.com/api/docs/guides/live-prompting),
[Partner integrations](https://developers.openai.com/api/docs/guides/live-partner-integrations),
[Model card](https://developers.openai.com/api/docs/models/gpt-live-1),
[Evaluation cookbook](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation),
[EU data residency](https://openai.com/index/introducing-data-residency-in-europe/).
Community: [launch thread](https://community.openai.com/t/introducing-gpt-live-1-in-the-api/1396471).
Partners: [LiveKit plugin](https://docs.livekit.io/agents/models/realtime/plugins/gpt-live/),
[Twilio resources](https://www.twilio.com/en-us/blog/developers/twilio-openai-gpt-live-1-api-resources).
Independent: [Artificial Analysis S2S Index](https://artificialanalysis.ai/speech-to-speech),
[unite.ai](https://www.unite.ai/openais-gpt-live-1-arrives-in-the-api-at-0-05-per-minute/),
[eesel review](https://www.eesel.ai/blog/gpt-live-1-review),
[Orca Router](https://www.orcarouter.ai/blog/gpt-live-1-api-launch-openai-agents-brief),
[Coursiv](https://coursiv.io/blog/gpt-live-1-api),
[Evalgent](https://www.evalgent.com/blog/build-voice-agents-gpt-live),
[TestingCatalog](https://www.testingcatalog.com/openai-launches-gpt-live-1-for-full-duplex-voice-agents/).
Backend pricing: [GPT-5.6 tiers](https://www.layer3labs.io/guides/gpt-5-6-pricing).
