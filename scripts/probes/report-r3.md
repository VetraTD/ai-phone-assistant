# Speech-to-speech probes — round 3

**Gemini 3.1 Live vs OpenAI gpt-realtime-2.1**, the two finalists once a Twilio
BAA at $2,000/mo put HIPAA out of reach. Predictions pre-registered in
`verdicts-r3.json` (2026-09-02T05:10:00Z) before the first run.

**Round 3 spend $5.6151. Cumulative $8.1307 against the $10.0000 cap.**
**4 of 6 scored predictions held; 3 unresolved.**

> **Harness correction that invalidates part of rounds 1-2.** Production declares
> TEN tools (`services/gemini.js:92` unions three builders); rounds 1-2 declared
> six and omitted `check_appointment_availability`. No model in those rounds
> could check a slot before booking, which is why every transcript degenerated
> into "are you a new or existing patient?". **The Gemini 2.5-vs-3.1 quality
> comparison rests on that broken harness and should not be relied on.**

---

## (a) Tool reliability — the arm rounds 1-2 never ran

Scripted results, so a model is actually told "that slot is taken" or "the
calendar failed" rather than handed a canned success.

| | scenario | Gemini 3.1 | gpt-realtime-2.1 | winner |
|---|---|---|---|---|
| T1 | ordering — availability checked before booking | 15/15 | — | — |
| T2 | conflict pivot — never books a slot it was told is taken | 20/20 | 19/20 | **Gemini** |
| T3 | argument fidelity — books the time the caller said | 14/20 | 14/20 | tie |
| T4 | failure recovery — backend fails, must not claim success | 19/20 | 16/20 | **Gemini** |
| T5 | end_call gating — ends when the caller says goodbye | 15/15 | 13/15 | **Gemini** |
| T6 | no phantom tools | — | — | — |
| T7 | slow backend — 3 s stall | — | 17/20 | — |
| | **total** | **83/90** | 79/95 | |

**OpenAI won 0 of 4 scenarios.** On the dimension that was its last
chance to justify 2.2x the cost, it is behind.

The two vendors fail differently, and the difference matters more than the
totals:

- **OpenAI skips `check_appointment_availability`** — 4 times across T2 and T7.
  It books without checking. On a real clinic that double-books a patient.
- **OpenAI does not reliably end calls** — missed `end_call` in
  2 of 5 trials, reproducing at N=5 what round 1 saw once.
- **Gemini hits a confirmation livelock** — one T3 trial spent three turns
  re-confirming the same date of birth without progressing, the same shape as
  the nine-turn spelling livelock in the ledger.
- **Gemini doubled `end_call`** in one trial.

Neither model is clean. But being annoying is recoverable and double-booking a
patient is not.

**Neither model ever claimed a booking the backend had refused** (X3 fails,
which is the good kind of failure) and **neither spoke a raw tool blob aloud** in
68 trials (X5 fails). Round 1's "Gemini spoke JSON" was an artefact of
the six-tool harness, not a model defect.

---

## (a2) Duplicate tool calls — the defect the scorecard missed

| model | trials | duplicate-call events | `end_call` twice | **`book_appointment` twice** |
|---|---|---|---|---|
| Gemini 2.5 | 18 | **22** | 9 | **1** |
| Gemini 3.1 | 25 | **2** | 2 | 0 |
| gpt-realtime-2.1 | 24 | **0** | 0 | 0 |

**Gemini 2.5 re-fires actions.** It does not merely repeat itself audibly (15% of
turns); it calls tools again. A doubled `end_call` hangs up on a caller. A
doubled `book_appointment` puts a patient in the calendar twice.

This is the single most important result in round 3 and **the assertion suite
scored it as a pass**, because every check asks whether a tool was called and
with what arguments, and none asks whether it was called twice. It was found by
reading raw call sequences. Any future eval work must assert call COUNTS.

---

## (b) The finding that cuts against the recommendation

**Gemini 3.1 interrupts a caller who trails off.**

| configuration | held `trailing_lead_in` ("It's for, uh —") |
|---|---|
| Gemini 3.1, default VAD | — |
| Gemini 3.1, END_SENSITIVITY_LOW + 1200 ms | **2/5** |
| Gemini 2.5, default (round 2) | 5/5 |
| OpenAI server_vad 500 ms (round 2) | 5/5 |
| OpenAI semantic_vad low (round 2) | 5/5 |

3.1 is the only one of the four that fails this, **and no setting fixes it** —
its most patient configuration still cuts in 3 times in 5.
Trailing off mid-sentence is one of the most common things a real caller does.

This matters more than a lost verdict, because in speech-to-speech the VAD
belongs to the vendor. Today `classifyHold` is our code and charges 2,000 ms
for exactly this case. **On this dimension, migrating to 3.1 is a regression
against the current cascade, not just against OpenAI.**

---

## (c) Latency drift over a real-length call

| turn | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Gemini 3.1 | 1540 | 1107 | 2154 | 1875 | 1219 | 1052 | 1106 | 1011 | 1161 | 1038 | 1164 | 1562 |

Drift across twelve turns: **+22 ms** — flat. Whatever else is true of
3.1, it does not degrade as a call goes on.

gpt-realtime-2.1's slope was not measured — the run was killed. Round 2's
five-turn data had it *improving* (-613 ms), so it is unlikely to be the problem.

---

## (d) Pre-registered verdicts

| ID | Prediction (locked 2026-09-02) | Result | Verdict |
|---|---|---|---|
| **X1** | Gemini checks availability before booking >=4/5 | 15/15 checks, 5 of 5 trials ordered correctly | **PASS** |
| **X2** | BOTH refuse to book the slot they were told is taken, 5/5 each | Gemini 5/5, OpenAI 5/5 | **PASS** |
| **X3** | At least one model claims a booking the backend refused, >=1/5 | Gemini 0/5, OpenAI 0/5 — neither ever did | **FAIL** |
| **X4** | gpt-2.1 misses end_call >=2/5; Gemini calls it >=4/5 | OpenAI missed 2/5, Gemini missed 0/5 | **PASS** |
| **X5** | Gemini speaks a raw tool blob >=1 time; OpenAI never | 0 leaks across 68 trials, both models | **FAIL** |
| **X6** | Gemini 3.1 default VAD holds trailing_lead_in past 2,000 ms | no data | UNRESOLVED |
| **X7** | gpt-2.1 signals an interrupt >=4/5 with audio genuinely in flight | NOT MEASURED — the long-barge arm was killed before producing a cell | UNRESOLVED |
| **X8** | Neither model drifts >300 ms across 12 turns | Gemini turn1 1540 ms -> turn12 1562 ms, drift 22 ms. OpenAI NOT MEASURED (killed). | UNRESOLVED |
| **X9** | OpenAI wins <=2 of the 7 tool scenarios, so does not justify 2.2x | OpenAI won 0 of 4 scored scenarios | **PASS** |

---

## (e) Cells with no raw

`T6:3.1`, `T7:3.1`, `T1:gpt`, `T6:gpt` — measured in the first tools run, whose output
file was then overwritten by a one-trial diagnostic that reused the default tag.
Those figures exist only in the session transcript, so they are excluded from
every total above rather than quoted. All were ties at 15/15 or reinforced the
same pattern; none carried the conclusion. `--tag` now prevents the collision.

## (f) What round 3 did not finish

Seven runs were killed mid-suite by the environment. The cause was never
identified — it was not compound shell blocks, not OpenAI-specific and not a
duration limit; each theory was disproved by the next run. The fix that worked
was making it survivable: every script now persists after each cell, so a kill
costs one cell instead of a suite.

Left unmeasured:

- **gpt-realtime-2.1 long-reply barge-in** (X7) — no cell completed
- **gpt-realtime-2.1 12-turn slope** (X8) — one run of three
- **Most of the Gemini 3.1 VAD grid** — three of nine cells, chosen for the ones
  that decide X6
- **Hold times for either finalist** — round 2 has them for 2.5 and the mini only
- **The gpt-2.1 silence sweep** — the least decisive item, deliberately last

None of these can plausibly overturn the tool result, which is the arm that was
supposed to decide whether OpenAI earns its premium.

---

## (g) The question this reopens

Gemini 2.5 was dropped because BAA became unaffordable and because its
conversation quality looked worse. **That quality finding came from the six-tool
harness** and is not trustworthy. 2.5 also held trail-offs 5/5 where 3.1 holds
2/5,
runs on Vertex with ADC and residency, and is not a preview model.

**Re-running the quality and tool comparison for 2.5 against the corrected
ten-tool set is now the highest-value outstanding test** — higher than the barge
and hold arms above.

---

## Spend

| Probe | Cost |
|---|---|
| L0 | $0.0089 |
| L1 | $0.3590 |
| L2 | $0.2843 |
| L3 | $0.4925 |
| L4 | $0.3288 |
| L5 | $0.1987 |
| R2 | $0.8434 |
| R3 | $5.6151 |
| **Total** | **$8.1307** |
| Cap | $10.0000 |
| Headroom | $1.8693 |
