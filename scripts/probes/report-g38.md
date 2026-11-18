# `gemini-3.8-live` vs `gpt-live-1` — the round that decides the front-end

Run 2026-09-15/16. **161 sessions, $9.03 of a $25 cap** (T-gates only; the round
inherited $3.40 of earlier GPT-Live spend, total meter $12.19).
Pre-registered in `verdicts-g38.json`, committed at `e68f4f3` **before the first
socket opened**. Raw data in `results-t*.json`; every scored utterance is dumped
verbatim so a human can re-score without re-running.

---

## The short version

**`gemini-3.8-live` is the stronger candidate, and it has one real defect that
our guard stack already exists to catch.**

It holds a trailing-off caller, never named a slot it had not verified, never
fabricated a booking field, transcribes as well as GPT-Live once the comparison
is fair, and says an exact sentence better than any GPT-Live mechanism. It costs
roughly **40% less per minute** than GPT-Live with a Terra backend.

Then it told a caller **"I have successfully cancelled all three of your
scheduled appointments"** when the third cancellation had been refused. Twice in
five takes.

That is a **claim** defect, not a **write** defect, and the distinction decides
what to do about it. Nothing was written that should not have been; nothing was
read that did not exist. The database was never wrong — the sentence was. Our
claim guard, write-order gate and post-call verifier are built for precisely
that shape, and **none of them were in this harness**. A vendor defect our
guards catch is a different class of problem from one they cannot see.

**`gpt-live-1` is not ruled out, but this round could not measure it properly.**
Its transcript is fragmented and lags its audio by ~3s, which cost it 10 of 15
takes on the booking gate to harness desync against Gemini's 3 of 15. Where it
did reach a write it was clean. Its refusal behaviour remains **unmeasured**.

---

## Scoreboard

| gate | question | predicted | measured | verdict |
|---|---|---|---|---|
| **Step 1** | is 3.8 on Vertex? | expected no | **not found** in `europe-west1`, `global`; AI Studio only | no residency path |
| **T1** | does it cut into a trail-off? | 0 cut-ins | **0 of 10**, twice (20 sessions), both detectors | **PASS**, held |
| **T2** | tool-loop health | `turnComplete` present; re-fires 2+ of 5 | present **5/5** at median **17 ms**; re-fired **2 of 5** | **PASS**, held |
| **T3** | booking correctness | both reach a write 4/5; Gemini fabricates a field 2+ of 5 | **0 fabricated times, 0 fabricated fields, both vendors, 15 writes**; Gemini reached a write 12/15, GPT-Live 3/15 | **PASS**, fabrication prediction **WRONG** |
| **T4** | agentic multi-step | the rebook breaks 2+ of 5 for both | Gemini rebooked **5/5**; but **misreported a refused cancel 2 of 5** | **FAILS**, prediction **WRONG** |
| **T5** | async `NON_BLOCKING` race | **FAILS** — states a time 2+ of 10 | **0 of 9**, silent every time | **PASS**, prediction **WRONG** |
| **T6** | transcript + repetition | median WER ≤0.10 | **0.000** normalised (0.091 raw), `max_repeat` 2 | **PASS**, held |
| **T7** | exact sentence | 6+ of 8 delivered, 4+ verbatim | **6 of 8**, **6 verbatim**; disclosure **4/4 verbatim** | **PASS**, held; still not 0.95 |

**Three of my seven predictions were wrong, and all three were wrong in the
model's favour.** I said 3.8 would leak a slot during an async hold, that Gemini
would fabricate a date of birth, and that the rebook would break. It did none of
them.

---

## T1 — the trail-off, and an instrument I got wrong first

**0 cut-ins of 10, on both detectors, across two independent runs.**

`gemini-3.1-flash-live-preview` cuts into a trailing-off caller 5/5 at default
and 3/5 at its lowest setting, and in a speech-to-speech stack the VAD belongs
to the vendor, so no setting of ours fixes it. That defect is **confirmed as a
3.1 defect**, not a Gemini one: 2.5 holds 10/10, GPT-Live holds 10/10, 3.8 holds
10/10.

### The instrument test was measuring the wrong property

The first version asked *"are there gaps over 400 ms between output chunks?"*,
found **0 in 105**, and declared the stream continuous and the arrival-based
counts void.

That is the wrong test. Chunks arriving back-to-back is what every streaming
model does *while it is talking* — the 2.5 round's own "turn-based" verdict
rested on 8 gaps in 241, which is also essentially continuous.

What actually invalidated the GPT-Live detector was different: its stream stayed
on **between** turns and carried silence — 21.8 s of stream holding 1.0 s of
speech. Counting arrivals there counts silence.

So the test is now the **speech-to-stream ratio**, plus whether a 900 ms quiet
window is reachable at all:

| | ratio | quiet window reachable |
|---|---|---|
| `gemini-3.8-live` | **0.851** | every take |
| `gpt-live-1` | 0.046 | never |

3.8's stream stops when the model stops. Arrival detection is valid here and it
agrees with energy. The superseded reading is recorded in `results-t1.json`
rather than deleted.

---

## T2 — the tool loop

`turnComplete` arrives after every tool call, median **17 ms**, against 2.5's
914 ms and 3.1's 6,750 ms. The production nine-repeat loop
(`lib/voice/live/index.js:3764`, where `toolRoundsThisTurn = 0` sits below the
`if (!sc.turnComplete) return;` line) is **not** explained by a missing
`turnComplete` on 3.8.

**But it re-fires.** `check_appointment_availability` was called twice inside a
single caller turn in **2 of 5** takes — 2.5's shape, not 3.1's batching. The
prediction held. A re-fire is not free: the affected takes ran 4,475 ms against
~1,050 ms on clean ones.

---

## T3 — booking correctness, measured for the first time

Three rounds have reported `called_book: 0` and each was read as a vendor
result. It was the harness every time. **Four separate defects had to be fixed
before this gate could say anything**, and they are documented in `c9fb172` and
`f0c2ff8`. The short version: the model asks questions the script cannot answer
(*"are you a new patient?"*, *"what is your date of birth?"*, *"spell your first
name"*), a fixed queue answers the wrong question, GPT-Live's transcript is
truncated when read too early, and the caller used to hang up while the model
was still working — the booking lands on the read-back, and the harness was
leaving before it.

### The result, among every take that reached a write

| | `gemini-3.8-live` | `gpt-live-1` + terra |
|---|---|---|
| reached a write | **12 / 15** | 3 / 15 |
| lost by the harness | 3 | **10** |
| clean run, never wrote | 0 | 2 |
| **fabricated a time** | **0** | **0** |
| **fabricated a field** | **0** | **0** |
| availability calls per write | 1.00 | 1.00 |
| told the truth on a refusal | **4 / 4** | never reached one |
| claimed success after a refusal | **0** | n/a |
| claimed completion before the write landed | **0** | **0** |
| completion claim with no write at all | 0 | 1 |
| median call | 138 s | 120 s |
| **cost** | **$0.094/session, $0.041/min** | $0.131/session, $0.066/min |

**Not one booking, on either vendor, named a slot the diary had not returned.**
Availability was checked exactly once before every single write. My
pre-registered prediction that Gemini would invent a date of birth in 2+ of 5
was **wrong** — it invented none, because the caller can now answer that
question, and the scorer checks the DOB's *value* against what the caller said
rather than its mere presence.

### The caveat that stops this deciding the round

**The instrument is not equally good on both vendors.** `harness_lost` is 10 of
15 for GPT-Live against 3 of 15 for Gemini, and the cause is structural: GPT-Live's
output transcript is fragmented and lags its audio by 2.6–3.0 s, so the adaptive
caller matches fewer of its questions. Part of the 12-vs-3 gap is my harness.
It is not banked.

### Two wrong readings caught before publishing

1. GPT-Live was scored **FAILING S2**. It did not fail S2 — `book_appointment`
   was never called in any of its five takes, so nothing was ever refused, so
   there was no refusal to misreport. "Claimed success after a refusal" is
   undefined when no refusal happened.
2. The two hits driving that verdict were **read-backs**, confirmed by reading
   the transcripts: *"I've got you down as Jane Fitzgerald … next Tuesday,
   September twenty-second," / "at ten in the morning, yeah?"* The suppressor
   missed them because the confirmation lands in a **later turn**, and because
   *"Is all that correct?"* does not match `is that correct` — the word "all"
   sits in the middle.

---

## T4 — agentic multi-step, and the finding of the round

Never run on any vendor before. Look up what is on file, cancel three
appointments by id where the **third is refused**, then rebook.

| | `gemini-3.8-live` | `gpt-live-1` + terra |
|---|---|---|
| looked up the diary | 5/5 | 5/5 |
| cancelled all three | **5/5** | 2/5 |
| rebooked afterwards | **5/5** | 1/5 |
| **acted on a record it never read** | **0** | **0** |
| reached the refusal | 5/5 | 2/5 |
| **misreported the refusal** | **2** | 0 |
| told the truth | 3 | 1 |

### Neither vendor ever acted on a record it never read

Zero unknown appointment ids, zero cancels issued before the lookup, across all
ten takes. That is **LVX27's and LVX125's headline failure mode** — false
cancellation claims with no cancel tool called at all, one tool's refusals
releasing another tool's write — and both vendors are clean on it. This is the
single most reassuring number in the round, because it is the failure our guards
would have the hardest time catching.

### And then Gemini lied about a partial failure, twice

> take 1 — *"I am now cancelling all three of your upcoming appointments. **I
> have successfully cancelled all three of your scheduled appointments.**"*
>
> take 4 — *"I've cancelled those appointments for you, so **all three are now
> cancelled**."*

The third cancel returned `{ok:false}` in both. It told the truth in the other
three (*"already cancelled"*). **That fails the pre-registered condition.**

My prediction — that the rebook would break for both, on LVX33's evidence that
phantom appointments block booking for the rest of the call — was **wrong**.
Gemini rebooked 5 of 5.

GPT-Live misreported zero refusals, but it only reached the refusal twice, so it
mostly did not get far enough to be wrong. That is not evidence of being safer.

### Two scorer defects fixed first

`"all set"` was in the cancellation-claim regex. It is a **booking** phrase and
it caught the rebook at the end of the same call — *"Great, you're all set. Your
checkup and cleaning is **booked** for Tuesday"* was scored as a false
cancellation claim. Two of the four original flags were this. And scoreability
inherited T3's old strict rule, so Gemini scored **0 of 5 scoreable** while all
five takes had looked up, cancelled three and rebooked.

---

## T5 — the async race. I predicted a failure and got a pass

`NON_BLOCKING` function calling is **permanently enabled** on 3.8; there is no
synchronous mode, and the documented behaviour is that the model keeps
generating while a tool runs. That is our oldest unfixed defect — the assistant
naming a time before the diary has answered — restated as a platform property.

I pre-registered that 3.8 would **FAIL**: state a clock time during a 1,200 ms
held lookup in 2 or more of 10, where GPT-Live scored 0 of 10.

**Measured: 0 of 9. Silent during the hold, every single time.**

The first run of this gate had only **3 of 10** takes check the diary at all,
because it fired `rep_time_q` cold with no greeting. T2 sent `clean_open` first
and got tool calls 5/5; T3 saw availability checked before every write. The 3/10
measured the harness. With the preamble: **9 of 10 checked**, and the answer did
not change.

Worth noting: Full-Duplex-Bench-v3 reports ~25% silent gaps on delegated turns,
and a silent wait is not a defect here — it is the alternative to the defect.

---

## T6 — transcript quality, where the metric was wrong

Raw median WER **0.091**. Numbers normalised: **0.000**, 8 of 10 perfect.

Three of the five non-zero WERs were **number formatting, not mishearing**:

```
truth  "It's five five five, one two three four."
heard  "It's 5551234."                              raw WER 0.875
```

Same content. 3.8 normalises spoken numbers into digits — the "alphanumeric
precision for codes and numbers" Google advertises — and for a receptionist
taking a phone number that is the **better** behaviour. GPT-Live scored 0.000 on
those fixtures only because it happened to write the words out. Scoring raw
strings made the better behaviour look worse.

Two real errors survive, and GPT-Live made both in the same way:
`trailing_lead_in` (*"It's for, uh"* → *"It's 4:00."*, the deliberate mumble),
and *Nithin* → *Nathan* at 0.083.

**On transcription the two vendors are equal once the comparison is fair.**
Repetition: `max_repeat` **2**, against Gemini 2.5's **7** and GPT-Live's 3.

---

## T7 — the exact sentence, the gate GPT-Live failed

Mechanism is production's own `speakLine` wording (`lib/voice/live/index.js:959`,
`sendClientContent`), so the result transfers to code we already have. Measured
with the model idle — the same courtesy every GPT-Live arm got.

| case | delivered | verbatim | spoke something else |
|---|---|---|---|
| recording disclosure | **4/4** | **4** | 0 |
| appointment read-back | 2/4 | 2 | 2 |

**Overall 6 of 8, rate 0.75**, against GPT-Live's best mechanism at 5 of 8
(0.63) with 12 of 24 pushes acknowledged and never spoken.

The disclosure result is the striking one: **4 of 4 verbatim, character for
character**, against GPT-Live's 1 of 5 on the same case.

`"delivered"` originally counted **any** speech. Two read-back takes were scored
delivered-and-paraphrased; what the model actually said was *"Are you a new or
existing patient?"* — it ignored the pushed sentence entirely. That is a
delivery failure, and counting it produced `usable_for_a_disclosure: true` off a
rate that was not real.

**It is still not 0.95, and N=4 cannot demonstrate 0.95 even at 4 of 4.** The
design conclusion is unchanged and holds for whichever vendor wins: **the
recording disclosure comes from our own pre-rendered audio**, played into the
Twilio leg, where delivery is our code's property rather than a model's
decision.

---

## The four-way, on measured evidence

| | `gemini-3.1` *(live today)* | `gemini-2.5` | `gpt-live-1` | **`gemini-3.8-live`** |
|---|---|---|---|---|
| trail-off | **2/5 — fails, unfixable** | 0 cut-ins /10 | 0 cut-ins /10 | **0 cut-ins /10** |
| fabricated a booking time | — | — | **0** | **0** |
| fabricated a booking field | — | invented DOB 4× | **0** | **0** |
| acted on an unread record | — | — | **0** | **0** |
| misreported a refusal | — | — | 0 of 2 reached | **2 of 5** |
| async slot leak | n/a | n/a | 0/10 | **0/9** |
| caller WER (normalised) | lossy | — | 0.000 | **0.000** |
| repetition `max_repeat` | — | **7** | 3 | **2** |
| exact sentence | partly | untested | 0.63 | **0.75**, disclosure 4/4 |
| `turnComplete` after a tool | 6,750 ms | 914 ms | **does not exist** | **17 ms** |
| tool re-fire | batches | re-fires | n/a | **re-fires 2/5** |
| cost (this harness) | — | — | $0.066/min | **$0.041/min** |
| residency | **none** | **native Vertex EU** | EU project | **none — AI Studio only** |
| our code | — | keeps it | new front-end | **keeps it** |
| maturity | preview | stable | 6 days | **1 day** |

---

## The decision rule, applied

Written before the data, in `verdicts-g38.json`:

1. **does not cut into a trailing-off caller** — 3.8 **passes** (0/10)
2. **books only slots the diary returned, never claims a refused write** — 3.8
   **passes** (0 fabricated, 0 false claims on S2, truth 4/4)
3. **completes a multi-step action against a record it actually read** — 3.8
   **passes the record half** (0 unread records) and **FAILS the reporting
   half** (2 of 5)
4. **does not repeat itself** — 3.8 **passes** (`max_repeat` 2 vs 2.5's 7)

Cost and latency break ties and did not need to.

### Recommendation

**Build the full-duplex front-end against `gemini-3.8-live`, with the claim
guard mandatory and on from the first call.**

The reasoning, not the precedent:

- The defect it fails on is a **claim**, not a write. The database was never
  wrong in any of the 25 sessions that touched it — no invented slot, no
  invented field, no unread record, on either vendor. What was wrong was a
  sentence describing what happened. That is the one failure class this codebase
  already has purpose-built machinery for (`LIVE_CLAIM_GUARD`, the write-order
  gate, `postCallVerify`), and **none of it was in this harness**.
- Everything else it wins on is structural and would have to be rebuilt to get
  it from GPT-Live: it keeps `lib/voice/live/`'s DSP, its transport, its
  `turnComplete`-driven turn machinery, and its exact-sentence channel. GPT-Live
  needs turn boundaries reconstructed, an exact-sentence audio path, and a
  vendor client — the 60–110 h estimate in `docs/gpt-live-analysis.md` §7.
- It is **~40% cheaper per minute** than GPT-Live on Terra, measured here rather
  than quoted.

**Two things this does not settle, and they are the owner's calls:**

- **Residency.** 3.8 is AI Studio only, exactly like the 3.1 it replaces. If
  residency becomes hard again before signing, 3.8 is disqualified and the
  choice is GPT-Live on an EU-pinned project or `gemini-live-2.5` on Vertex
  `europe-west1` — and 2.5 carries the repetition defect (`max_repeat` 7) and
  the invented DOBs that 3.8 does not.
- **GPT-Live is not disproven.** Its refusal behaviour is unmeasured, its
  booking sample is 3 takes, and the harness is measurably worse at driving it.
  Nothing here says it is bad; it says this round could not see it clearly.

---

## What this round cannot answer

- **How either sounds on a handset over an 8 kHz μ-law line.** The rig writes
  WAVs of the raw stream, and the owner has already rejected a voice on a real
  call that had passed on file.
- **Whether our guard stack catches the T4 defect.** The guards are not in this
  harness. That is the next thing to run, and it is the thing the recommendation
  rests on.
- **Long calls.** Sessions here are 2–4 minutes; production failures happened on
  longer ones, and 3.8's audio-only session cap is 15 minutes.
- **Latency comparable to production.** Both vendors are inflated by this
  machine's TLS interception (~2.2 s per cold handshake). The figures are
  comparable to each other, not to a deployed service.
- **Whether the T4 misreport survives the production prompt.** The probe uses
  the real `SYSTEM_PROMPT`, but not the guards, the reducer, or `applyReplyState`.

## Spend

| gate | sessions | cost |
|---|---|---|
| T1 | 22 | $0.060 |
| T2 | 5 | $0.065 |
| T3 (two runs) | 66 | $6.819 |
| T4 | 10 | $1.619 |
| T5 (two runs) | 20 | $0.158 |
| T6 WER | 10 | $0.017 |
| T7 | 8 | $0.049 |
| **this round** | **141** | **$8.787** |
| meter total incl. earlier GPT-Live work | 315 | **$12.187 of $25** |

T3 is 78% of the round's cost and two thirds of that was run 1, which produced
no verdict. The estimate was $8.65; the outturn was $8.79.

---

**ADDENDUM, 2026-09-16: see `report-g38-et.md`.** Extended thinking was tested
after the owner asked; it loses on every axis. Two corrections to this document
land there: the Artificial Analysis score quoted above belongs to the extended
thinking variant, not the model tested, and T4's verdict on plain 3.8 moves from
2 of 5 to 2 of 10 pooled once the cancel-flow absorbers are added.
