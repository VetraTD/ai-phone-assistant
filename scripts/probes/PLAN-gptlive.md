# GPT-Live probe round — pre-registration

**Written 2026-09-14. NOT AUTHORISED TO RUN.** No probe in this file may be
executed until the owner approves the spend explicitly. G1 below is already
done and cost $0.

Feeds `docs/gpt-live-analysis.md` §7. Same discipline as `PLAN.md`
(2026-09-01), which this file extends rather than edits — that round's
pre-registration must stay exactly as it was written.

**Why a round at all:** the owner's decision of 2026-09-14 makes UK/EU residency
a hard requirement before the first signature, and today's voice path runs on
`gemini-3.1-flash-live-preview` — a global AI Studio preview with no residency
and no Vertex publisher model in any EU region. We are moving off it regardless
of what OpenAI shipped. This round decides whether the destination is GPT-Live-1
or a residency-capable Gemini Live model on Vertex.

---

## G1 — DONE 2026-09-14, $0, PASSED

Read-only `GET`s, deliberately-invalid `POST`s that create nothing, and the
generated SDK types via `gh`. No session was opened.

| check | result |
|---|---|
| `GET /v1/models/gpt-live-1` | 200. No alpha gate. |
| telephony audio | **`audio/pcmu`, mono G.711 μ-law, 8000 Hz, Live WebSocket.** Twilio's frame, untouched. |
| transports | `POST /v1/live/sessions` mints **WebRTC only**. WebSocket connects directly and is the only transport that accepts `audio.format`; WebRTC and SIP negotiate media themselves. |
| SIP | recognised, org-gated: `outbound_sip_not_enabled`. Inbound untested. |
| input transcripts | `session.input_transcript.delta` exists, with `start_ms` / `end_ms`. |
| voices | 22 built-in; `marin` default; immutable after startup. |
| also found | **`gpt-live-transcribe`**, a separate model on our key, in no launch coverage. |

**The finding that shapes this round**, from the generated SDK docstring:

> "Accumulate fragments in delivery order; these events do not define complete
> turns or include a transcript-done event."

Caller text exists; caller *turns* do not. Everything downstream of that is G2.

---

## Hard rules

Rules 1–7 of `PLAN.md` carry over unchanged. Read them there. Four are amended
or added because GPT-Live bills differently and behaves differently:

1. **The meter is wall-clock, not tokens.** $0.05/minute billed per second for
   the voice layer, plus backend tokens. A socket left open costs money while
   nothing happens. **Every probe must close its session in a `finally`, and the
   run aborts if any session exceeds 120 s.**
2. **`spend.json` currently records $9.152 against a cap raised to $10.** There
   is ~$0.85 of headroom, which is not enough for this round. A new meter file
   `spend-gptlive.json` with its own cap, and that cap is the owner's number, not
   mine. Enforced in code, checked before every session, aborts mid-run on
   breach.
3. **N=5 per arm minimum, N=10 for G4.** Round 2 overturned round 1; the
   explicit-cache probe gave opposite verdicts on consecutive runs at N=1.
4. **G0 runs first and must be able to fail.** The round-3 lesson: rounds 1–2
   declared 6 tools where production declares 10, so no model was ever offered
   `check_appointment_availability` and every transcript looped on "new or
   existing patient". Before any scored run, the harness asserts: 10 tool
   declarations, the real prompt prefix, the real fixture bytes — **and then
   deliberately breaks one and confirms the assertion trips.** A harness that
   cannot fail has not been validated.

---

## What already exists and is reused

| asset | where | note |
|---|---|---|
| μ-law fixtures | `test-audio/caller/*.ulaw` | the same ten. They exist because the cascade got them wrong. |
| spend meter | `scripts/probes/lib/spend.js` | new file, same code |
| real 10-tool declarations | `scripts/probes/lib/tools.js` | Realtime shape; needs a Responses-shape variant for arm R |
| real prompt prefix | `scripts/probes/lib/prompt.js` | must be SPLIT for GPT-Live — voice instructions vs backend instructions |
| μ-law passthrough | `scripts/probes/lib/openai.js` | already sends `audio/pcmu` in and out, untouched bytes |
| stats / reporting | `lib/stats.js`, `report*.mjs` | unchanged |

## What must be written

`lib/gptlive.js`, a raw `ws` wrapper. **Not a fork of `openai.js`** — the event
names differ throughout: `session.input_audio.append`, `session.output_audio.delta`,
`session.input_transcript.delta`, `response.event` envelopes that must be
unwrapped, `response.item.create` for tool results. And three things `openai.js`
relies on do not exist: no `response.done`, no `output_audio.done`, no manual
audio commit.

---

## The two arms

| arm | `delegation` | who decides | what we are testing |
|---|---|---|---|
| **R** | `{"type":"responses", "responses":{"model":"gpt-5.6-luna", ...}}` | OpenAI's model picks the tool and the words; our process still executes the tool | whether handing over the decision costs us write integrity |
| **C** | omitted / `{"type":"client"}` | `llmTurn.js` picks the tool and the words; the voice layer has no tools and no diary | whether we can rebuild turn boundaries well enough to gate a write |

Arm R uses `gpt-5.6-luna` ($0.20/$1.20 per 1M), not `terra` ($2/$12) — if the
cheap backend is adequate the expensive one is a tuning decision, and if it is
not, that is itself the finding. Record which backend produced every number:
the Artificial Analysis index scores the same voice model at **81.5 with one
backend and 69.8 with another**, so a GPT-Live score without its backend named
is not a number.

---

## Gates

Pre-registered predictions. `verdicts-gptlive.json` is written **before** the
first run and never edited. The report prints prediction beside result.

### G2 — are caller transcripts gateable? · N=10 fixtures, both arms share it · ~$0.20

The gate that can end the round. Every write guarantee we own — the consent
latch, the affirmative check, `isUnusableTranscript`, the write-order gate —
fires on a **completed caller turn**, and OpenAI states there is no such event.

Replay all ten fixtures. Accumulate `session.input_transcript.delta`. Then
attempt turn segmentation from `start_ms`/`end_ms` gaps alone.

- **Prediction:** fragments reconstruct the utterance at a word error rate
  within 5 points of Gemini's `inputTranscription` on the same fixtures, and a
  silence-gap rule segments 8 of 10 correctly.
- **Fails if:** no input transcript arrives at all, **or** segmentation is
  correct in fewer than 6 of 10. Either way **stop the round** — without a
  gateable turn, arm C is unbuildable and arm R has no guarantee to lose.
- Also record: does `gpt-live-transcribe` change this? If it is a better
  transcript we want to know before designing around fragments.

### G3 — the trail-off · N=5 per config · ~$0.50

`no_terminal_punct` and `trailing_lead_in` — the fixtures where Gemini 3.1 cuts
in 5/5 at default and 3/5 at `END_SENSITIVITY_LOW` + 1200 ms.

- **Prediction: 0 of 5 cut-ins.** Full duplex has no endpointing decision to get
  wrong; this is the single strongest claim in the analysis doc and it should be
  the easiest to falsify.
- **Fails if:** 2 or more of 5 cut in. The main reason to move evaporates and
  the round becomes about residency alone.

### G4 — the availability race · N=10 per arm · ~$1.50

The scripted caller asks "do you have Thursday at two?". The harness delays the
`check_appointment_availability` result by a fixed 1,200 ms — the real lookup
latency we measured, not an invented one.

- **Prediction, arm C:** speaks no diary fact before the result lands in ≥9 of
  10. It cannot: the voice layer holds no tools and no availability data.
- **Prediction, arm R:** speaks an unverified slot in ≥3 of 10. OpenAI's own
  eval cookbook names "creating reservations when only availability was asked" a
  headline failure mode of this configuration.
- **Fails if:** arm C states a specific slot before the result in more than 1 of
  10 — then client delegation buys nothing here and the two arms collapse into
  one decision about code volume.
- Score three separate things, because they are not the same failure: (a) any
  speech at all during the wait, (b) speech that implies availability, (c) a
  specific time or date stated. Only (c) is a write-integrity defect. (a) is
  desirable — it is the hold behaviour that stops dead air.

### G5 — does it say what we tell it to say? · N=5 · ~$0.50

Two strings, pushed via `session.commentary.append`, which the docs say is
spoken "in its own words":

1. the recording disclosure, verbatim, as a legal obligation
2. a read-back: "Thursday the 18th of September at 2:15 pm"

- **Prediction:** the disclosure is paraphrased in ≥3 of 5; the appointment time
  survives intact in ≥4 of 5.
- **Fails if:** the time is altered even once — a paraphrased legal sentence is a
  design problem, an altered appointment time is a caller being told the wrong
  hour. If it fails, both the disclosure and the read-back need a mechanism that
  is not `commentary.append`, and that must be designed before either arm is
  built.

### Always measured, not a gate

- **Real cost of a 3-minute call**, both arms, from the session duration and the
  backend usage — because per-second billing means silence is billable and the
  $0.158 estimate in the analysis doc is arithmetic, not a measurement.
- **`model_leg_ms`**, labelled exactly that. There is no Twilio leg and no
  playout queue in this harness, so it is **not** voice-to-voice. Reporting an
  in-process window as v2v is the 2026-08-04 error (1,500 ms assumed vs 3,062 ms
  actual).
- **Dead air during delegation.** Full-Duplex-Bench-v3 reports silent gaps in
  ~25% of delegated cases. Count ours.

**Round total: ~$2.70 of probe spend, plus harness validation overhead. Call it
$4 with a ceiling the owner sets.**

---

## What this round cannot answer

Say it before the results arrive, so nobody reads more into them than they hold.

- **Handset audio, echo, and a real line.** No Twilio leg. `echoGuard`'s 4.7 dB
  margin was measured on a real call and cannot be re-derived here.
- **Long calls.** Sessions are capped at 120 s by rule 1. Nothing here says what
  a 20-minute call does, and plugins expose `max_session_duration` with
  reconnection for a reason.
- **Whether it sounds better.** That is the owner's ears on a handset, and it is
  the next section.
- **Inbound SIP.** Only outbound is confirmed org-gated.

---

## After the gates: the owner's two-arm call test

The owner's proposal, 2026-09-14: build both delegation modes and judge them by
phone. The shape is right — every unknown-unknown we have found came from a call,
not a document. Two conditions:

1. **Two calls smoke-test, they do not decide.** At N=1 per arm a single
   mis-heard word picks an architecture. Two calls are excellent at *rejecting*
   an arm that is obviously broken, and that is worth doing first and early.
2. **Then ~5 calls per arm, same script, alternating, with the fail conditions
   written down before dialling** — so that "neither is better" can be a result.

**It is one build, not two.** Both arms share the transport, the μ-law path and
the tool executors — in responses delegation OpenAI's model only *decides* which
tool to call; `services/tools.js` still executes it in our process. The arms
differ in who decides. Estimate: the second arm adds 10–15%, not 100%.

## Module delta against the Gemini list in `PLAN.md`

`PLAN.md`'s survives/dies table mostly holds. Three rows change:

| module | Gemini Live verdict | GPT-Live verdict |
|---|---|---|
| `lib/audio.js` μ-law → PCM16 16k, downsampler, framer | **required** — 6–10 h of hot-path DSP | **deleted.** `audio/pcmu` in and out. The tax we already paid comes back. |
| `turnManager` (667 lines), `turnEnd/*`, `halfDuplex.js` | decided by V2/V3 | **mostly dies, and its question moves.** Full duplex owns barge-in. But turn *segmentation* reappears inside the guard path (G2) — this is not a saving, it is a relocation. |
| `closeKind.js`, `end_call` mark | survives | **redesigned.** No `response.done`, no `output_audio.done`, no event that says the audio finished playing. |

---

# Overnight runbook — written 2026-09-15, before the build

Owner authorised a **$5.00 cap** and "fire it when built", then went to sleep.
This section is the contract for what happens unattended.

## Build order

Each step is checked before the next begins. Steps 1-4 spend nothing.

| # | step | spends | why this order |
|---|---|---|---|
| 1 | `verdicts-gptlive.json` — predictions and fail thresholds | $0 | written FIRST, before any code that could tempt me to move a threshold after seeing a number |
| 2 | `lib/spendLive.js` — own meter, own file, cap $5 | $0 | the ceiling must exist before the first socket, not after |
| 3 | `lib/gptlive.js` — raw `ws` wrapper for the Live protocol | $0 | not a fork of `openai.js`: different events throughout, and no `response.done`, no `output_audio.done`, no manual commit |
| 4 | `g0-harness.mjs` — assert 10 tools / real prompt / real fixtures, **then sabotage each and confirm the assertion trips** | $0 | rounds 1-2 declared 6 tools where production has 10, and the verdict had to be retracted. A test that cannot fail is just green. |
| 5 | **G1b — one-session smoke test**: open, send 2 s of μ-law, read events, close | **~$0.01** | validates `session.start`, the `audio/pcmu` format and the event names against a real socket before any gate depends on them. Cheapest possible way to find out the protocol is not what I read. |
| 6 | the four gate scripts | — | written against a transport already proven by step 5 |
| 7 | `run-gptlive.mjs` + `report-gptlive.mjs` | — | gate-ordered, stop-on-fail, resumable, writes raw JSON per session |

## Spend ladder, worst case

| stage | est | running worst case |
|---|---|---|
| G1b smoke | $0.01 | $0.01 |
| G0 validation sessions | $0.05 | $0.06 |
| G2 transcripts, 10 fixtures | $0.20 | $0.26 |
| G3 trail-off, 5+5 | $0.50 | $0.76 |
| G4 race, 10 per arm | $1.50 | $2.26 |
| G5 verbatim, 5 | $0.50 | $2.76 |
| re-runs / debugging headroom | $1.00 | **$3.76** |

**Hard stop at $5.00, checked before every session, aborts mid-run on breach.**
The gap between $3.76 and $5.00 is deliberate: it is the room a wrong estimate
needs, not budget to spend.

## Three kill switches

1. **Per-session:** any session open longer than **120 s** aborts. GPT-Live
   bills per second of wall clock, so a hung socket bills until someone notices.
   Every session closes in a `finally`.
2. **Per-run:** a global wall-clock ceiling on the whole run. It exits and
   reports rather than continuing into the morning.
3. **Per-gate:** **G2 failing stops the round.** Without a gateable caller turn,
   arm C is unbuildable and arm R has no guards, so G3/G4/G5 would be $2.50
   spent answering a question we have already stopped asking.

## What is on disk in the morning

- `scripts/probes/raw/gptlive-*.json` — every event of every session, timestamped on arrival
- `scripts/probes/results-gptlive.json` — scored
- `scripts/probes/report-gptlive.md` — **prediction beside result**, per gate
- `scripts/probes/spend-gptlive.json` — every cent, itemised
- `scripts/probes/audio/*.wav` — **the model's actual speech, saved to WAV.**
  Free byproduct: the audio arrives anyway. Includes the G5 read-back and
  disclosure takes, so the paraphrase question can be judged by ear and not only
  by string comparison. Voice is `marin`, the default — a British one can be
  re-rendered later for pennies once there is something worth listening to.

## What will NOT happen while the owner sleeps

- **No production code touched.** Probe only. The two-arm front-end is a build,
  and building it against unmeasured gates is the mistake this round exists to
  prevent.
- **No deploys, no pushes to a remote, no server restarts.**
- **No Twilio, no phone minutes, no ElevenLabs.** Direct vendor socket only.
- **No raising the cap.** If $5.00 is not enough the run stops and says so.
