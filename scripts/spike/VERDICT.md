# Spike verdict — pre-registered

**Written 2026-09-02, BEFORE the first call.** Committed before dialling and not
edited afterwards. Results go in the "Actual" column and nowhere else.

Why this file exists: predictions were pre-registered per probe round in
`scripts/probes/verdicts*.json` and never edited, and the scores were **3/8**,
**1/7** and **4/6**. Nine confident conclusions were disproved by measurement —
`docs/speech-to-speech-handoff.md` section 3 lists them. A verdict written after
hearing the call is not a verdict, it is a memory of having expected it.

## What the spike is asking

One question that $8.62 of probes could not reach, because no probe had a Twilio
leg and no echo path existed at all: **does PSTN echo break speech-to-speech?**
Two more the owner answers by ear: does it sound acceptable through 300–3400 Hz,
and does ~1.4 s per turn feel like anything.

**If echo wrecks it, we stop here** — a day spent instead of 73–134 hours.

## The calls

| # | arm | handset | purpose |
|---|---|---|---|
| 1 | `manual` | to the ear | does it work at all, does it sound acceptable |
| 2 | `manual` | **speakerphone** | the echo test. Without this the spike answers nothing |
| 3 | `auto` | **speakerphone** | the comparison — how bad is it with the vendor's own VAD |
| 4–5 | either | either | only if a result is ambiguous |

Call 2 is the one the spike exists for. Call 3 is what turns "manual activity
detection is load-bearing" from an assumption into an observation.

## Predictions

| # | prediction | scored by | Actual |
|---|---|---|---|
| P1 | Call 2 (`manual`, speakerphone) does **not** self-interrupt | owner's ear + `interrupted_count` | |
| P2 | Call 3 (`auto`, speakerphone) **does** self-interrupt, audibly worse than call 2 | same, compared against call 2 | |
| P3 | `echo_return_loss_db` ≥ 15 dB on speakerphone | logged | |
| P4 | `echo_return_loss_db` on call 1 (to the ear) is ≥ 10 dB better than call 2 | logged | |
| P5 | Audio is intelligible and not obviously worse than the cascade | owner's ear | |
| P6 | `input_transcript_lag_ms_p50` < 500 ms | logged | |
| P7 | `activityStart` mid-generation produces a `serverContent.interrupted` — i.e. barge-in works at all under manual AD | `barges` vs `interrupted_count` | |
| P8 | No session drops or unexplained closes across the three calls | `close_reason` | |

**Latency is recorded, not scored.** `+18176011171` is a US number dialled from
a UK handset, so every turn carries an international carrier leg production does
not have. `first_audio_ms_p50` is a pessimistic upper bound and is **not**
comparable to the 1,043 ms model leg measured in round 3.

## Decision rule, fixed in advance

- **P1 yes and P5 yes** → proceed to section 7 step 2, the real front-end.
- **P1 no** → stop. Echo breaks the approach. Write up, keep
  `lib/voice/resample.js` and its tests, delete the bridge and the service.
- **P1 yes, P5 no** → not a stop. Quality is a tuning question; record what was
  heard and decide separately.
- **P6 no** (transcript arrives too late) → not a stop, but `echoGuard` and
  `classifyHold` cannot gate turn ends in the real front-end and the design owes
  a different answer. Record it; do not quietly build around it.

## Results

_Filled in after the calls. A prediction that missed is recorded as a miss._

| | |
|---|---|
| Score | — / 8 |
| Verdict | — |
| Spend | $— of the $3.00 cap |
