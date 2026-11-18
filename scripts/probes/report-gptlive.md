# GPT-Live probe round — results

**Run 2026-09-15, overnight, unattended.** 57 sessions, **$0.8185 of the $5.00
cap**. Every prediction below was written to `verdicts-gptlive.json` before the
first socket opened; this report prints prediction beside result.

Raw event streams: `raw/gptlive-*.json`. Scored: `results-g*.json`. Audio of
every session the model spoke in: `audio/*.wav`.

---

## Scoreboard

| gate | question | predicted | measured | verdict |
|---|---|---|---|---|
| **G0** | is the harness real? | 7 checks pass, 7 sabotages trip | 7/7 and 7/7 | **PASS** ($0) |
| **G1b** | is the protocol what the SDK says? | session.start + `audio/pcmu` accepted | accepted, first try | **PASS** |
| **G2a** | can we read the caller? | transcript ≥9/10, median WER ≤0.25 | **9/10, median WER 0.000** | **PASS**, prediction held |
| **G2b** | can we rebuild caller turns? | 8/10 at a 500 ms gap rule | **6/10 at 500 ms; 9/10 at 800 ms+** | **PASS**, prediction missed |
| **G3** | does it cut into a trail-off? | 0 of 5 cut-ins per fixture | **0 of 5 and 0 of 5** | **PASS**, prediction held |
| **G4c** | does OUR brain leak a slot? | 0 of 10 | **0 of 10** | **PASS**, prediction held |
| **G4r** | does THEIR brain leak a slot? | ≥3 of 10 | **0 of 10** | **prediction WRONG** |
| **G5** | will it say an exact sentence? | time intact ≥4 of 5 | **3 of 5; 0 of 10 verbatim** | **FAIL** |
| **G6** | can any mechanism deliver one? | — (follow-up) | **best 5 of 8; verbatim solved, delivery not** | **use our own audio** |

**Three of my own instruments were wrong before any of these numbers meant
anything.** They are documented in full below, because the round found more
defects in the harness than in the vendor — again.

---

## The headline

**GPT-Live does the thing we most need and cannot do the thing we most rely on.**

- It **never cut into a trailing-off caller**: 0 of 10, on the exact two fixtures
  where Gemini 3.1 cuts in 5/5 at default and 3/5 at its least aggressive
  setting. This is the defect we have failed to fix three times, and it is gone
  — structurally, because full duplex has no endpointing decision to make.
- It is **much faster**. `session.started` at **p50 470 ms** (p90 643 ms) against
  Gemini's ~2,200 ms connect *on every call*. Turn latency **p50 0 ms, p90
  800 ms** measured on the session timeline, against 2.99 s for Gemini 3.1 Flash
  Live on the Artificial Analysis index.
- Caller transcription is **excellent**: median WER **0.000** across ten
  fixtures, and the spelled-name fixture — our worst ASR pain, four rounds of
  fixes — came back at WER 0.000 / 0.091 / 0.091 over three takes.
- **But it will not say a sentence we wrote.** 0 of 10 verbatim, and worse,
  content pushed via `commentary.append` was **acknowledged every time and
  spoken only about 40% of the time**.

That last point is the one that decides the build, and it is developed below.

---

## G2 — caller transcripts · $0.118 · PASS

**G2a passed on the prediction.** Nine of ten fixtures returned a transcript,
median WER **0.000**. Two rows are worth reading:

| fixture | truth | heard | WER |
|---|---|---|---|
| `clean_open` | "Hi, I'd like to book an appointment." | " Hi! I'd like to book an appointment." | 0.000 |
| `trailing_lead_in` | "It's for, uh" | " Is four a" | **1.000** |
| `name_spelling` | "My name is Nithin. That's N, I, T, H, I, N." | *(nothing)* | — |

`trailing_lead_in` is a genuine miss on genuinely hard audio — two seconds of a
caller starting a sentence they do not finish. `name_spelling` returned nothing
at all, and that is a separate story.

### The blank transcript, and what it turned out to be

The `name_spelling` session returned **zero transcript fragments, input and
output**, while the model spoke eleven seconds of audio — on a session that took
**9,083 ms** to reach `session.started` against ~470 ms everywhere else.

Two readings fit one take and they have opposite consequences: spelled names
defeat transcription (fatal), or a session can degrade and lose transcription
entirely (different, still serious). Only repetition separates them.

**Three more takes, alternating with a control** (`g2r-repeat.mjs`):

| take | `name_spelling` | `clean_open` control |
|---|---|---|
| 1 | 10 fragments, WER 0.000 | 5 fragments, WER 0.000 |
| 2 | 11 fragments, WER 0.091 | 5 fragments, WER 0.000 |
| 3 | 11 fragments, WER 0.091 | 5 fragments, WER 0.000 |

**Transient.** The spelled name transcribes nearly perfectly. But the blank is a
real defect class and it is now measured at **1 session in 57**: transcription
can vanish for an entire turn *while the model keeps speaking*. For our guard
stack that state is indistinguishable from "the caller said nothing" — and a
fault-only counter reads zero for a clean call and for a call that never got
there.

### G2b — turn boundaries, the thing OpenAI says does not exist

Prediction missed: the pre-registered 500 ms gap rule scored **6 of 10**, not 8.
Every mismatch was *over*-segmentation — a mid-number pause split into two turns,
which is the same defect as an endpointer cutting in.

Re-scoring the already-collected timestamps at other thresholds costs nothing,
so it was done, and the result is better than the prediction:

| gap rule | correct |
|---|---|
| 300 ms | 2/10 |
| **500 ms (pre-registered)** | **6/10** |
| **800 ms** | **9/10** |
| 1000–3000 ms | 9/10 |

**Every within-utterance gap measured ≤600 ms**, and the rule is stable from
800 ms all the way to 3,000 ms — a wide plateau, not a knife-edge. The only
remaining miss is the blank session.

So caller turns **are** reconstructible from timestamps, with margin. This is
post-hoc and labelled as such: the pre-registered number is 6/10.

---

## G3 — the trail-off · $0.302 · PASS, prediction held

**0 cut-ins of 5, on each fixture.** Against Gemini 3.1's 5/5.

Confirmed by two independent instruments. Energy analysis of the returned audio
found no model speech overlapping the caller. And the session-timeline stamps
say the same thing directly:

```
caller  " works"   start_ms 17800  end_ms 18000
model   " Okay,"   start_ms 18200                  ← 200 ms gap, no overlap
```

### The three instrument defects

This number was wrong twice before it was right, and both wrong versions looked
publishable.

**1. The greeting collided with the caller.** The first run played caller audio
from t=0, so the model's opening line overlapped a caller who never waited for
it. All ten takes reported an identical **0.61 s** offset into two fixtures of
*different lengths* — the tell that a timer was firing, not a response.
`runSession` now waits for the model to finish before the caller speaks.

**2. Text lags audio by 2.6–3.0 seconds.** Classification originally read the
output transcript, which arrives long after the audio it describes. The
classifier was blind for the entire window it was meant to judge and scored ten
overlaps as "silent".

**3. The output stream is continuous — and this one nearly published a false
headline.** Detection became "did output audio deltas arrive while the caller
was speaking", which scored **10 of 10 as cut-ins** and would have said
*GPT-Live interrupts worse than Gemini*. It is wrong because full duplex means
the output channel is always on: the model streams silence when it has nothing
to say, exactly as Twilio does inbound. Measured: **218 deltas, no gap over
400 ms, 21.8 seconds of stream carrying 1.0 second of speech.** Counting deltas
counts silence. Detection is now by RMS energy, validated against audio already
on disk — silence sits at p90 = 7, speech peaks at 2,000–4,400, so the 500 floor
has a wide margin either side.

### A finding nobody was looking for

**GPT-Live never greets unprompted.** Fed fifteen seconds of silence at session
start, it stays silent — one speech run in a 23-second session, and it begins
only after the caller speaks. Our receptionist greets first, by design and
partly by law. That greeting needs a trigger, and G5 is about whether we can
supply one.

---

## G4 — the availability race · $0.299 · arm C PASS, my prediction wrong

The caller asks *"Do you have anything Tuesday morning?"*; the harness holds the
availability result back by 1,200 ms — our real measured lookup latency. N=10
per arm, alternating, scored on the session timeline.

| | arm C (our brain) | arm R (their brain) |
|---|---|---|
| delegated | 10/10 | 10/10 |
| **spoke during the wait** | **10/10** | **10/10** |
| implied availability | 1 | 0 |
| **stated a clock time** | **0/10** | **0/10** |
| checked the diary | n/a — declares no tools | **7/10** |

**Nobody leaked a slot.** The pre-registered regex flagged 3 hits across both
arms; all were the word *Tuesday* inside "let me check **Tuesday**" — echoing the
caller's own question, not a claim about the diary. Under a strict re-score
requiring a clock time, **both arms score 0 of 10**. The verbatim text of every
utterance is in `results-g4.json` so this can be re-argued without re-running.

**So my argument was wrong, and the pre-registration required me to say so.**
I predicted arm R would state an unverified slot in ≥3 of 10 because their model
can see the diary. It did not, once. On this measurement, client delegation
bought nothing on the axis I claimed it would.

**Dead air did not happen either.** Both arms filled the wait every single time —
"Let me check the schedule", "One sec, I'll check our" — against the ~25% silent
gaps reported for delegated turns in Full-Duplex-Bench-v3. That is a better
result than the literature predicted, for both arms.

### What the arms actually discriminate on

Not early speech. **Whether the diary gets consulted at all.**

Arm R's backend called `check_appointment_availability` in **7 of 10** takes. In
three, it called only `set_call_intent` and never looked — for a caller who
asked about Tuesday morning in as many words. Round 3 measured the same failure
on `gpt-realtime-2.1`: **skipped 9 of 20**, against Gemini's 0 of 20. Different
model, same shape, still there.

In arm C that question does not arise: our brain decides, and checking is what
the guard stack is for.

**One harness defect found and corrected mid-gate.** The first arm-R run answered
`toolCalls[0]`, which is always `set_call_intent` — the prompt tells the model to
call it "as soon as you understand why the caller is calling". So the
availability payload went to the wrong call and the right one was never answered.
The arm was measuring a stalled tool loop. Corrected to answer every call, with
the 1,200 ms hold applied only to the availability lookup; the numbers above are
from the corrected run.

---

## G5 — will it say what we wrote · $0.092 · **FAIL**

**0 of 10 verbatim.** It never reads a script. That was expected.

What was not expected is the delivery rate.

| case | spoke the content | facts intact when spoken |
|---|---|---|
| recording disclosure | **1 of 5** | 1 of 1 |
| appointment read-back | **3 of 5** | 3 of 3 |

Every push was **acknowledged** — `session.commentary.appended`, no errors, every
time. It simply did not always say it. In the takes where it stayed on its own
conversational track, the caller heard *"Sure! I can help with that."* instead of
a legal disclosure.

**When it did relay, the facts survived every time.** The paraphrases are good:

> pushed: "Your appointment is Thursday the 18th of September at 2:15 pm."
> spoken: "Okay, I've got you down for Thursday, the 18th of September, at 2:15 in the afternoon."
> spoken: "I've got you at 2:15 on Thursday, September 18th. Can I get your name"

So the pre-registered fail condition — *the time is altered even once* — did not
technically occur. It scores FAIL because the read-back never reached the caller
in 2 of 5 takes, which is worse than a wrong time, not better.

**A hypothesis I formed and the data killed.** Looking at three takes it appeared
commentary was spoken when it answered an outstanding delegation and dropped when
pushed as general context with a null `delegation_id`. Across all ten takes there
is no such relationship: **with a delegation outstanding it spoke 1 of 5; without
one, 3 of 5.** The mechanism is not established by this data. What is established
is that acknowledgement is not delivery.

---

## G6 — can we make it say an exact sentence? · $0.093 · **NO VENDOR MECHANISM CLEARS THE BAR**

G5 left one blocker, so this settles it. Three mechanisms, N=8 each, alternating.
The G5 confound is removed: every push happens **after the model has gone
quiet**, so a miss is the mechanism failing rather than a collision. This is the
best case for all three.

| arm | mechanism | acked | **delivered** | verbatim | verbatim *when delivered* | misses that said nothing |
|---|---|---|---|---|---|---|
| A | `commentary.append`, stock prompt | 8/8 | **4/8** | 0 | 0 of 4 | 1 of 4 |
| B | `commentary.append` + prompt "relay word for word" | 8/8 | **3/8** | 2 | 2 of 3 | 0 of 5 |
| C | `instructions.append` carrying the sentence | 8/8 | **5/8** | **5** | **5 of 5** | **3 of 3** |

**Best delivery rate is 63%. 12 of 24 pushes were acknowledged and never
spoken.** A disclosure that reaches the caller two times in three is not a
disclosure.

### But it splits the problem cleanly in two, and one half is solved

**Fidelity: solved.** `instructions.append` is verbatim **5 of 5** times it
speaks — character for character, including the "2:15 pm" that every other
mechanism converted to "2:15 in the afternoon":

> "Your appointment is Thursday the 18th of September at 2:15 pm."

**Delivery: not solved, by any of them.** And note the failure *shapes* differ:

- Arm A never says it verbatim — 0 of 4 deliveries. It always rewrites, and in
  one take emitted a literal `[sigh]` token.
- **Arm B, the prompt-level fix, made delivery WORSE** — 3 of 8, below the
  do-nothing control. Telling the model to relay word for word did not help it
  relay word for word. Another instance of a prompt instruction failing to hold.
- **Arm C fails silent: 3 of 3 misses produced no speech at all.** Never garbled,
  never a wrong time — either the exact sentence or nothing.

That last property is the useful one. A failure that is total and silent is
**detectable**: our code can watch for the sentence in the output transcript and
fall back when it does not appear. A failure that paraphrases into a wrong hour
would not be.

### The answer, and it was the option this probe deliberately did not test

**An exact sentence must come from our own audio, not from the model.** We
already own the socket to Twilio; a pre-rendered clip played into the caller leg
makes delivery a property of our code rather than a model's decision. The only
vendor-side question it raises — whether the model talks over us — we settle by
not forwarding its audio while ours plays.

The fallback ladder that follows from the numbers above:

1. **Recording disclosure** — our own audio, always. It is a legal string, it is
   the same every call, and it must never be a 63% proposition.
2. **Appointment read-back** — `instructions.append`, which is verbatim when it
   lands, with detection on the output transcript and our own audio as the
   fallback. Worth doing because the model's own phrasing sounds better than a
   clip when it works.
3. **Everything else** — `commentary.append` is fine. Facts survived every
   paraphrase across G5 and G6; it is only the *exact* strings it cannot be
   trusted with.

**What this does not establish.** N=8 cannot demonstrate 95% reliability even at
8 of 8 — but 5 of 8 is far enough below the bar that no plausible N rescues it.
And all three arms were measured with the model idle; delivery under load, or
mid-sentence, can only be worse.

---

## Measured numbers worth keeping

| | GPT-Live-1 (measured here) | Gemini 3.1 Live (ours today) |
|---|---|---|
| session start | **p50 470 ms**, p90 643 ms, max 9,083 ms | ~2,200 ms on every call |
| turn latency | **p50 0 ms**, p90 800 ms, max 1,400 ms (n=49) | 2.99 s (Artificial Analysis) |
| cut-ins on trail-off | **0/10** | 5/5 at default, 3/5 at lowest |
| caller WER | **median 0.000** | not measured on these fixtures |
| blank transcript | 1 of 57 sessions | — |
| telephony audio | `audio/pcmu` 8 kHz, **no resampling** | PCM16 16k in / 24k out |
| cost, 3-min call | **$0.150 voice** + backend | $0.096–0.136 all-in |

57 sessions averaged 10.1 seconds each. The voice layer is billed on wall clock,
so **silence is billable** — the $0.150 for a three-minute call is a floor that
does not care how much anyone says.

---

## What this round cannot tell you

Stated before the results, and still true after them.

- **How it sounds on a handset.** No Twilio leg, no echo, no line. The WAVs in
  `audio/` are the raw stream, not a phone call.
- **Long calls.** Sessions were capped at 120 s. Nothing here says what a
  twenty-minute call does.
- **Inbound SIP.** Only outbound is confirmed org-gated
  (`outbound_sip_not_enabled`).
- **Whether the 40% commentary delivery rate is our push timing.** N=10, and the
  harness pushes while the model is often mid-sentence. That is realistic, but it
  is not the same as establishing the mechanism.

---

## What I would do next

1. **G5 is the blocker, and it is a design question, not a vendor question.**
   Before either arm is built, we need a mechanism that reliably delivers an
   exact sentence — the recording disclosure and the appointment read-back. If
   `commentary.append` cannot be made to deliver, the candidates are the startup
   `input` history, `instructions.append`, or playing our own audio into the
   caller leg and not asking the model at all. **This is worth an hour and about
   fifty cents to settle.**
2. **The tool-skip rate deserves N>10.** 3 of 10 on arm R against round 3's 9 of
   20 on `gpt-realtime-2.1` is consistent, and it is the only axis where the arms
   actually differ. If it holds, it is the argument for client delegation — not
   the one I predicted.
3. **Do not touch production.** Nothing here changes the recommendation in
   `docs/gpt-live-analysis.md` §8: phase 1 closes with a business ringing the
   current number, and no business has ever rung it.


---

# H1/H2/H3 — Gemini 2.5 on Vertex europe-west1 · $0.285 · **PASSED EVERYTHING**

Run 2026-09-15 on `gemini-live-2.5-flash-native-audio`, project `vetra-uk-edc8ca`,
location `europe-west1`, with the corrected **11-tool** set and the real prompt.
Pre-registered in `verdicts-gemini25.json`. 15 sessions.

This is the test `report-r3.md` called "the highest-value outstanding test" two
weeks ago and nobody had run.

| gate | question | predicted | measured | verdict |
|---|---|---|---|---|
| **H1** | does 2.5 cut into a trail-off? | holds 5/5 both fixtures | **10 of 10 held, 0 cut-ins** | **PASS**, prediction held |
| **H2** | does it break on turn 2 in the EU? | the report does not reproduce | **5 of 5 sessions answered all 4 turns** | **PASS**, prediction held |
| **H3** | does it check the diary, 11 tools? | ≥4 of 5 | **5 of 5** | **PASS**, prediction held |

**The instrument was validated before the numbers were trusted.** GPT-Live's
output stream is continuous and carries silence, which is why G3 needed RMS
energy. Gemini's is turn-based, so arrival of audio *is* speech — but that was
**proved, not assumed**: 8 real gaps over 400 ms across 241 inter-chunk
intervals. Had the stream been continuous these numbers would have been void.

The multi-turn transcripts are a working receptionist, not a loop:

```
turn 1  "Hi, I'd like to book an appointment."  -> "Are you a new or existing patient?"   [set_call_intent]
turn 2  "Do you have anything Tuesday morning?" -> "We have openings at 10:00 AM or 2:30 PM"
                                                                     [check_appointment_availability]
turn 3  "Tuesday at ten works for me."          -> "What is your full name for the appointment?"
turn 4  "Thanks, bye."                          -> "Thank you for calling Brightwork Family Dental."  [end_call]
```

**"Breaks on turn 2 in the EU" did not reproduce.** 20 of 20 turns answered.

---

# CORRECTION — GPT-Live's latency advantage was an instrument artifact

**I reported GPT-Live turn latency as "p50 0 ms, p90 800 ms". That number came
from transcript TIMELINE stamps, and it is not a delivery time.** Those stamps
annotate where the model places its speech on the session timeline, not when
audio actually arrives. Gemini was measured by wall clock. Comparing them was
apples to oranges, and it flattered GPT-Live by well over a second.

Recomputed from the saved WAVs — energy-detected speech start, wall clock, with
`session.started` as the timeline origin — **the same measure used for Gemini**:

| | turn latency p50 | p90 |
|---|---|---|
| **GPT-Live-1** | **1,171 ms** | 1,931 ms |
| **Gemini 2.5** | 1,441 ms | 2,580 ms |
| *Gemini 3.1 (Artificial Analysis)* | *2,990 ms* | — |

GPT-Live is still faster — by about **270 ms at p50 and 650 ms at p90**. That is
real and probably audible. It is not the order-of-magnitude gap I reported.

*Residual caveat, stated rather than buried:* the two figures use slightly
different marks for "the caller finished" — transcript end for GPT-Live, last
sent frame for Gemini. Transcript end precedes the last frame, so GPT-Live's
figure is if anything overstated by roughly 80 ms. Both are also inflated by this
machine's TLS interception, equally.

---

# THE FOUR-WAY, ON MEASURED EVIDENCE

| | gpt-realtime-2.1 | GPT-Live-1 | Gemini 3.1 *(running today)* | **Gemini 2.5** |
|---|---|---|---|---|
| trail-off | 5/5 held | **0 cut-ins /10** | **2/5 — fails, unfixable** | **0 cut-ins /10** |
| checks the diary | 11/20 | 7/10 | 20/20 | **5/5** |
| turn latency p50 | 1.21 s *(AA)* | **1,171 ms** | 2,990 ms *(AA)* | 1,441 ms |
| connect p50 | — | **470 ms** | ~2,200 ms | 987 ms |
| caller transcript | — | WER 0.000, 1 blank/57 | lossy, no language control | 10/10 returned |
| exact sentences | — | 63%, needs our audio | partly | untested |
| residency | EU project | EU project | **none — preview, global** | **native Vertex EU** |
| cost, ~10 turns | $0.131 mini | $0.158 | $0.096–0.136 | **~$0.05–0.10** |
| our code | rewrite | new front-end, 60–110 h | — | **keeps what we built** |
| maturity | superseded | **5 days old** | preview | stable |

## The verdict this round actually produces

**Gemini 2.5 wins, and the reason is that the case for switching vendors was
never really about OpenAI.**

The single strongest argument for GPT-Live was that it fixes the trail-off
cut-off. It does — and so does Gemini 2.5, **0 cut-ins out of 10 for both**. The
defect is a *3.1* defect. We have been living with a problem that the model we
already had did not have.

What GPT-Live retains: ~270 ms at p50, ~500 ms faster to connect, and a better
caller transcript. What it costs: roughly 2–3× the per-call bill, 60–110 hours of
new front-end, an exact-sentence mechanism we have to build ourselves, a backend
that skips the diary 3 of 10, and a five-day-old dependency.

What Gemini 2.5 gives: the trail-off fixed, the diary checked 5 of 5, native EU
residency on Vertex, a non-preview model, and **the code we already wrote**.

**Recommendation: move the Live front-end from `gemini-3.1-flash-live-preview` to
`gemini-live-2.5-flash-native-audio` on Vertex `europe-west1`.** It is a
configuration change against a front-end that already exists, it satisfies the
residency requirement the owner made hard, and it fixes the defect this entire
investigation started from.

**Keep GPT-Live on the shelf, not in the bin.** It is genuinely the better voice
layer and it is five days old. Revisit when a business has actually used the
product and the complaint is latency.
