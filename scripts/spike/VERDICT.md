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

## Results — manual arm, 4 calls, 2026-09-02

Handset condition not recorded per call, which is itself a gap: **P1 and P3 are
NOT settled until a speakerphone call is matched against a manual one.**

| # | prediction | outcome |
|---|---|---|
| P1 | manual arm does not self-interrupt | **holding, not settled** — `interrupted_without_local_barge` = 0 on all 4 calls, but the speakerphone condition has not been run |
| P2 | auto arm is audibly worse | not run |
| P3 | echo return loss >= 15 dB | **passes so far** — 23.3 / 37.5 / 39.6 dB |
| P4 | ear vs speakerphone differ by >= 10 dB | not scorable — condition not recorded per call |
| P5 | intelligible, not worse than the cascade | **PASS** — owner: "it sounds amazing" |
| P6 | transcript lag < 500 ms | **PASS** — p50 215 / 301 / 326 ms |
| P7 | barge-in works under manual AD | **PASS** — 2 barges, both produced an `interrupted` |
| P8 | no drops or unexplained closes | **PASS** — `close_reason` null on all 4 |

### Unpredicted findings — flagged as unpredicted, not folded in as if expected

- **`language_pinned` = true on all four calls.** Handoff section 4 states that
  native audio "does not accept an explicit language code". The API accepted
  `en-GB` without error. Accepted is not the same as honoured, and this does not
  prove the accent came from the code rather than the prompt — but the doc claim
  as written is wrong.
- **Model leg 880-1140 ms with a real PSTN leg**, against 1,043 ms measured in
  round 3 with no phone line at all. The transport cost close to nothing. The
  ~2.2 s the caller actually feels is mostly the bridge's own 1,200 ms hangover,
  which is a tunable number and not a vendor property.
- **The assistant refused to read a caller's phone number back.** Recorded as
  backlog LVX4. Not caused by the missing tools — read-back is prompt behaviour.
- **The instrument under-reported its own token usage** (last turn only, not
  summed). Backlog LVX5. Cost per call is therefore still unmeasured.

## Final results

_Filled in after the calls. A prediction that missed is recorded as a miss._

| | |
|---|---|
| Score | — / 8 |
| Verdict | — |
| Spend | $— of the $3.00 cap |
