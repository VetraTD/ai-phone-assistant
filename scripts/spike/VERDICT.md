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

## Arm comparison — speakerphone, matched conditions, N=1 each

| | manual (148 s, 10 turns) | auto (218 s, 17 turns) |
|---|---|---|
| echo return loss | 37.5 dB | 32.7 dB |
| inbound RMS while we spoke | 52 | 84 |
| `interrupted` total | 1 | 3 |
| **`interrupted` our VAD did NOT corroborate** | **0** | **2** |
| caller stops → hears a reply (p50) | 2,246 ms | **1,325 ms** |
| transcript lag (p50) | 249 ms | 113 ms |

### P2 — partially held, and the split matters

Predicted: the auto arm self-interrupts and is **audibly worse**.

- **The instrument agrees.** Two interrupts in the auto arm that our own VAD
  never corroborated, against zero in the manual arm. The mechanism showed up
  exactly where it was predicted to.
- **The ear does not.** The owner reported no self-interruption on either call.

So the gate does something measurable that the caller cannot hear. Recording
this as **partially held** rather than a pass, because scoring it as a pass
would credit a prediction whose audible half missed.

### Two readings of those 2 uncorroborated interrupts, not yet separated

1. **Echo** — the vendor hearing our own output and cutting itself off. This is
   the defect manual activity detection exists to prevent.
2. **Short caller backchannel** — an "mm-hm" or a half-word below the 300 ms
   sustained-voice threshold `voicedRunMs` requires. Our VAD would not
   corroborate it, and it would look identical in this data.

**These are not distinguishable from a call where the caller talks.** The clean
experiment is a call where the caller says nothing at all after the opening
question: then inbound-while-playing is echo plus line noise, inbound-while-idle
is line noise alone, and the difference is the echo. Cheap, decisive, no code
change.

### The finding nobody predicted: manual activity detection costs ~900 ms a turn

`reply_after_last_voice_ms` is 2,246 ms manual against 1,325 ms auto. That gap is
almost entirely the bridge's own `HANGOVER_MS` of 1,200 — a flat number chosen
for this spike, not a tuned one, and not a vendor property.

So the trade as measured today is: **manual activity detection buys echo
protection the caller cannot hear, at ~900 ms per turn the caller can.** That is
not an argument against section 6 — the hangover is tunable and
`classifyHold`'s real rules are shorter than 1,200 ms except in specific cases.
It is an argument that the number needs choosing deliberately rather than
inheriting the spike's placeholder.

**N=1 per arm.** One call each, one room, one handset. This codebase has already
had a probe give opposite verdicts on consecutive runs. Suggestive, not settled.

## The silent call — decisive, and it invalidates my own headline metric

Caller silent throughout after the opening question. Auto arm, no gate.

```
in_rms while WE speak  (echo + line noise) = 0
in_rms while IDLE      (line noise alone)  = 1909
interrupted = 0        without local barge = 0
```

**Zero.** Not low — zero. Inbound audio during our own playback was digital
silence: mu-law 0xFF decodes to PCM 0, so the RMS is exactly 0.000.

### What this means

**No echo reaches us on this path.** Not "well attenuated" — absent at the
sample level. Whether that is the mobile network's uplink DTX suppressing the
channel while the caller is quiet, or carrier-side echo cancellation removing
our audio, the consequence is the same: the vendor never hears our output come
back.

### It also means `echo_return_loss_db` was never measuring echo

Every earlier call reported 23-40 dB and I reported those as echo return loss.
They were not. With the caller silent the playing bucket is 0; with the caller
talking it is 37-84. So the metric was measuring **caller speech bleeding into
the tail of our playback window**, which is a window-overlap artefact and not
echo at all. The numbers were real; the name and the interpretation were wrong.

**Known remaining ambiguity, stated rather than papered over:** the summary does
not log a sample COUNT for that bucket, so `mean([]) === 0` and "every sample was
digital silence" are indistinguishable in the record. The earlier auto call on
identical code reported 84, which makes the empty-array reading very unlikely —
but "very unlikely" is not "ruled out", and closing it needs a counter.

### Consequences for the build

- **The 2 uncorroborated interrupts in the earlier auto call were NOT echo.**
  They were the caller — short backchannel below the 300 ms `voicedRunMs`
  threshold. The competing explanation is eliminated by this call.
- **Section 6's echo justification is not demonstrable on this path.** "Far-end
  VAD cannot detect our own PSTN echo" describes a threat that did not
  materialise here. This does NOT contradict the cascade's live-call echo
  defect, which was real and documented — but that was a different stack
  (Deepgram transcribing very quiet audio into words) and possibly a different
  handset. One condition, not a law.
- **Manual activity detection's OTHER justification is untouched and still
  stands on its own:** it removes the trail-off cut-in, measured 3/3 in round 3
  and reproduced on call 1 here. That reason never depended on echo.
- **So the ~900 ms per turn the hangover costs is currently being paid for a
  threat that has not been demonstrated**, while the benefit that HAS been
  demonstrated (trail-off) is a property of who decides the turn ends, not of
  half-duplex gating. Those are two separable mechanisms and the spike has been
  treating them as one.

## CORRECTION — echo is present, and the previous entry in this file was wrong

The silent call above reported `in_rms_playing_mean = 0` and I recorded "no echo
reaches us on this path... absent at the sample level". **That was wrong**, and
the counters added specifically to check it are what caught it.

Second silent call, auto arm (no gate), 61 s:

```
WHILE WE SPOKE   frames=1514   nonzero=40    mean=0   max=211
WHILE IDLE       frames=1394   nonzero=805   mean=1623 max=14334
interrupted=0    without local barge=0
```

**Echo arrives.** 40 of 1514 frames — 2.6% — carried signal while we were
speaking, peaking at RMS 211. The mean rounded to 0 only because 1,474 of those
frames were exactly zero. A mean is the wrong statistic for a signal that is
absent 97% of the time and present in bursts; the max is the one that matters,
and I was not logging it.

### What the numbers actually say

| | |
|---|---|
| worst echo frame | RMS **211** |
| caller's own speech, peak | RMS **14,334** (68x louder) |
| `inboundVad` `minRms` floor | **700** |
| **headroom, echo peak to VAD floor** | **~10 dB** |

The carrier's echo canceller is working but leaks — most likely at speech onset
before it adapts. What it leaks lands about 10 dB under the absolute floor
`lib/voice/inboundVad.js` uses, which is why neither our VAD nor Gemini's ever
fired on it. **Nothing fired because of a margin, not because of an absence.**

### This changes the design conclusion, and separates two things I had conflated

- **The half-duplex gate is not guarding an empty road.** It guards a road with
  light traffic that currently stays under the limit. ~10 dB of margin on ONE
  handset, in one room, through one carrier's canceller. A louder speaker, a
  harder surface or a worse canceller closes that gap.
- **The gate costs nothing in latency.** Not forwarding inbound audio while we
  speak adds no delay whatsoever. **Keep it** — it is free insurance on a
  10 dB margin.
- **`HANGOVER_MS` is the thing that costs ~900 ms a turn, and it is a SEPARATE
  mechanism.** I had been treating "manual activity detection" as one decision.
  It is two: who decides the turn ended (the hangover, expensive, replaceable
  by `classifyHold`) and whether we forward our own echo (the gate, free, keep).
  Earlier entries in this file conflated them.

### Recorded as a miss

Two confident claims of mine, disproved by better measurement in the same
session that made them:

1. "`echo_return_loss_db` = 23-40 dB" — was measuring caller speech in the
   window tail. Correct, and still correct.
2. "No echo reaches us at all, absent at the sample level" — **wrong.** Echo is
   present at up to RMS 211. A mean over a bursty signal hid it, and I drew a
   design conclusion from a statistic that could not support one.

The handoff's section 3 exists because nine confident conclusions were disproved
by measurement. This is the tenth and eleventh, and both are mine.

## Final results

Nine calls, 2026-09-02. Torn down the same day: number restored to its recorded
values, Cloud Run service, secret and service account all deleted and verified
gone.

| # | prediction | outcome |
|---|---|---|
| P1 | manual arm does not self-interrupt | **PASS** |
| P2 | auto arm audibly worse | **PARTIAL** — 2 uncorroborated interrupts, inaudible to the caller |
| P3 | echo return loss >= 15 dB | **VOID** — the metric was measuring caller speech, not echo |
| P4 | ear vs speakerphone differ by >= 10 dB | **not scorable** — condition not recorded per call |
| P5 | intelligible, not worse than the cascade | **PASS** — "it sounds amazing" |
| P6 | transcript lag < 500 ms | **PASS** — 113-360 ms |
| P7 | barge-in works under manual AD | **PASS** |
| P8 | no drops or unexplained closes | **PASS** |

**Score: 5 pass, 1 partial, 1 void, 1 unscorable. Spend ~$0.65 of the $3.00 cap.**

### Verdict

**Echo does not break speech-to-speech. Proceed to section 7 step 2.**

The decision rule fixed in advance was P1 and P5. Both passed.

### What the spike actually bought, beyond the go/no-go

1. **`classifyHold` and `echoGuard` can survive.** Transcript lag 113-360 ms,
   comfortably inside any hold. This was the open question behind backlog LVX1
   and it resolves in the good direction. P6 is the most valuable pass here.
2. **Echo is real but ~10 dB under `inboundVad`'s floor** on this handset. The
   half-duplex gate is free insurance on a thin margin: keep it.
3. **`HANGOVER_MS` and the gate are separate mechanisms.** The gate costs no
   latency. The flat hangover costs ~900 ms a turn and `classifyHold` replaces
   it. Section 6 treats these as one decision; they are two.
4. **The model leg is 880-1140 ms with a real PSTN leg**, against 1,043 ms
   measured with no phone line at all. Transport cost almost nothing.
5. **`en-GB` is accepted** — `language_pinned` true on every call — contradicting
   section 4's vendor-doc claim.

### What it did NOT settle

- **LVX4** — it refused to read a caller's phone number back. Needs the
  production prompt; untestable in a spike with a ten-line one.
- **Booking correctness** — no tools were declared. That is the eval port,
  section 7 step 4.
- **A second handset.** Every acoustic number here is one phone, one room, one
  carrier.

### Instrument defects found in my own harness, for the next person

1. `usage` overwritten instead of accumulated — **harness defect #1 from the
   handoff's own section 11, reproduced by someone who had read it.**
2. `echo_return_loss_db` measured caller speech leaking into the playback
   window tail.
3. A mean reported over a bursty signal that is zero 97% of the time, from
   which a design conclusion was drawn. The max was not logged.
4. `noise_floor_db` measured the caller talking, not the room.
5. A wait loop keyed on "the latest build" rather than a build id, which exited
   on the *previous* build's status. Made twice.

Five instrument defects against roughly one vendor observation. That ratio
matches round 1's and is the honest headline: **most of what a new harness
measures at first is itself.**
