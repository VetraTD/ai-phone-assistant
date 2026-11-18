# ADDENDUM to `report-g38.md` — extended thinking, and a correction to T4

Run 2026-09-16, after the owner asked two questions the first report did not
answer: *was extended thinking tested?* and *did GPT-Live run on something
better than Luna?*

Answers: **no**, and **yes**. Pre-registered in **`verdicts-g38-et.json`**
before any session. `verdicts-g38.json` was **not** edited — it has data
attached to it.

36 sessions, **$5.75**. Meter total **$17.94 of $25**.

---

## The Luna question, answered first

**T3 and T4 both ran `gpt-live-1` with responses delegation on
`gpt-5.6-terra`** — 39 sessions, 1–8 delegations each, recorded in the meter as
`gpt-live-1+gpt-5.6-terra`. Luna appears only in the older G4/G5/G6 round and
none of those numbers feed the verdict.

Terra visibly helped. On Luna the backend **skipped the diary in 3 of 10**
takes; on Terra it looked up the diary **5 of 5** in T4 and checked availability
before **every** write in T3.

---

## Correction 1: the benchmark claim was wrong

`verdicts-g38.json` says the round ran because *"gemini-3.8-live … scores 82.6
on the Artificial Analysis speech-to-speech index against GPT-Live's 81.5."*

**That score belongs to a different model.**

| variant | AA index | tested in the first round |
|---|---|---|
| `gemini-3.8-live-extended-thinking` (High) | **82.6** | no |
| GPT-Live-1 (Astra, medium) | 81.5 | yes |
| GPT-Live-1 (Sol, low) | 80.1 | — |
| **`gemini-3.8-live`** | **76.0** | **yes** |

The model actually tested ranks **below both GPT-Live configurations** on that
index. No gate was ever scored against AA — every number came from our own
fixtures — so the results stand, but the stated *reason for running* was a
misattributed number and the "new #1" framing was false.

It also makes the gates the more interesting result: **the model ranked 4th on
AA beat the model ranked 2nd on booking correctness and refusal honesty.** Those
indices do not track what a receptionist needs.

---

## Correction 2: T4's original verdict on plain 3.8 was partly the harness

T4 ran with **no absorbers at all** — queue order only — which is why its
commonest unmatched question was the one `cx_confirm` exists to answer:
*"Would you like me to go ahead and cancel all three of those?"* A
`CX_ABSORBERS` bank was added, and **T4 was re-run on plain 3.8** so extended
thinking could not get a better instrument than its comparison.

| plain `gemini-3.8-live`, T4 | run 1 (no absorbers) | run 2 (absorbers) |
|---|---|---|
| cancelled all three | 5/5 | 5/5 |
| rebooked | 5/5 | 5/5 |
| reached the refusal | 5/5 | 5/5 |
| **misreported it** | **2** | **0** |
| told the truth | 3 | 4 |

**Pooled across both runs: 2 of 10.** Both misreports came from the run with the
worse harness. At N=5 per run that could be noise, and the mechanism is also
plausible — with absorbers the conversation reaches a clean confirmation turn
instead of ending mid-negotiation.

**The honest number is 2 of 10, not 0 of 5.** It is a real defect, it is smaller
than first reported, and the claim guard stays mandatory either way.

---

## Extended thinking is worse on every axis measured

Same harness, same fixtures, same N, `thinkingLevel: "high"` — the level AA
scored 82.6 on.

The two variants are **not interchangeable by model id**:
`gemini-3.8-live-extended-thinking` refuses to start without
`thinkingConfig.thinkingLevel` (*"Thinking level must be specified for this
model"*), and plain `gemini-3.8-live` refuses **with** it (*"Thinking level is
not supported for this model"*).

### T4 — the decisive gate

| | plain `3.8-live` | `3.8-live-extended-thinking` |
|---|---|---|
| looked up the diary | 5/5 | 5/5 |
| cancelled all three | **5/5** | 4/5 |
| rebooked afterwards | **5/5** | **2/5** |
| acted on an unread record | 0 | 0 |
| reached the refusal | 5/5 | 4/5 |
| **misreported it** | **0** | **2** |
| told the truth | **4** | 1 |
| verdict | **passes** | **FAILS** |

> ET take 1 — *"successfully canceled your…"*, and it never rebooked
> ET take 2 — *"cancelled those…"*, third cancel refused

**My prediction was wrong.** I pre-registered that extended thinking would
misreport **0 or 1 of 5**, reasoning that tracking three tool results is exactly
what a reasoning budget buys. It misreported 2 of 5 and completed the flow less
often.

That is four wrong predictions out of ten across this whole round — and the
first one wrong in the **optimistic** direction. The other three were all me
underestimating the plain model.

### T3 — booking correctness

| | plain | extended thinking |
|---|---|---|
| reached a write | **12/15** | 9/15 |
| fabricated a time / field | 0 / 0 | **0 / 0** |
| availability calls per write | 1.00 | 1.33–2.50 |
| S2 told the truth | **4 of 4** | 3 of 4 |
| S2 claimed success after a refusal | **0** | **1** |
| claimed completion before the write | 0 | 0 |

Extended thinking fabricates nothing either — **that property is stable across
both variants** — but it reaches a write less often, calls availability more
times per write, and produced the round's only S2 false success claim.

### T1 — latency, and it is not close

| | plain | extended thinking |
|---|---|---|
| cut-ins | 0/10 | **0/10** |
| turn latency p50 | **1,256 ms** | **2,382 ms** |
| turn latency p90 | — | 3,005 ms |
| speech:stream ratio | 0.851 | 0.821 |
| gaps > 400 ms in the output stream | **0 of 105** | **23 of 90** |

It still never cuts into a trailing-off caller. But it is **~1.9× slower per
turn**, and the gaps in its output stream are the thinking showing through.
Plain 3.8 had none; extended thinking has 23 in 90. On a phone line that is
dead air.

### Cost — extended thinking is the most expensive of the three

| | $/session | $/min |
|---|---|---|
| **`gemini-3.8-live`** | **$0.094** | **$0.041** |
| `gpt-live-1` + `gpt-5.6-terra` | $0.131 | $0.066 |
| `gemini-3.8-live-extended-thinking` | $0.202 | **$0.070** |

The pre-registration said that if extended thinking landed above GPT-Live's
$0.066/min, the cost argument for Gemini weakens and the report must say so. It
did. **The cost argument applies to plain 3.8 only.**

---

## What this changes

**Nothing in the recommendation. One thing in the confidence behind it.**

Build against **`gemini-3.8-live`** — plain, not extended thinking. Extended
thinking is slower, dearer, completes the agentic flow less often, and is worse
on the exact gate it was the obvious candidate to fix.

Decision-rule item 3 now reads differently: plain 3.8 misreported a refusal
**2 of 10 pooled**, not 2 of 5. Smaller than first reported, still real, and
still a **claim** defect rather than a **write** defect.

Across every session in this round — **three model variants, 197 sessions** —
nothing wrong was ever written, and no record was ever acted on that had not
been read. That is the property worth building on, and it is why the claim guard
is the right answer rather than a different vendor.

---

## Also worth recording

The `CX_ABSORBERS` regexes were first written through a bash heredoc into a
python patch, and **all nine `\b` word boundaries became literal 0x08 BACKSPACE
bytes** — invisible in a file read, and `Edit` could not match what `Read` had
just displayed a moment earlier. The routing test caught it at 4 of 6 wrong
before any session ran; a byte scan confirmed 9 × 0x08 on exactly the five regex
lines. Regex in this repo gets written with Write/Edit, never a heredoc.

## Spend

| | sessions | cost |
|---|---|---|
| T4 plain, re-run with absorbers | 5 | $0.796 |
| T4 extended thinking | 6 | $1.865 |
| T3 extended thinking | 15 | $3.024 |
| T1 extended thinking | 10 | $0.064 |
| **addendum** | **36** | **$5.749** |
| **meter total** | **351 entries** | **$17.94 of $25** |
