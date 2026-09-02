# Overnight speech-to-speech probe run — 2026-09-01

Throwaway. Scripts live here, not in the repo. Output of this work is an
**answer**, not code we keep. Feeds `docs/speech-to-speech-vendor-analysis.md` §5.

## Hard rules

1. **$5.00 total ceiling, enforced in code.** Shared cost meter persisted to
   `spend.json` across all probes. Every probe checks before each session and
   aborts mid-run on breach. Not a guideline.
2. **Verdicts are pre-registered.** `verdicts.json` is written BEFORE the first
   run and never edited after. The report prints prediction beside result so a
   wrong prediction is visible, not retrofitted.
3. **N=5 per arm.** The explicit-cache probe gave opposite verdicts on
   consecutive runs at N=1. One run decides nothing.
4. **No deploys, no pushes, nothing that restarts a server.** A docs commit
   landing 52s before a probe dialled once produced "no data" and a wrong
   diagnosis.
5. **No Twilio, no ElevenLabs.** Direct vendor sockets only. No phone minutes,
   no TTS quota.
6. **Label the metric honestly.** There is no Twilio leg and no playout queue
   here, so the number is `model_leg_ms`, NOT voice-to-voice. Reporting an
   in-process window as v2v is exactly the 2026-08-04 error (1,500ms assumed vs
   3,062ms actual).
7. **Abort after 3 consecutive socket errors** on any probe. Log and move to
   the next probe rather than burning the night retrying.

## Baselines to beat (all [M], from docs/receptionist-backlog.md §0)

| Metric | Cascade today |
|---|---|
| `llm_ttfb_ms` p50 | 940 ms |
| voice-to-voice p50 | 2,607 ms |
| barge-in latency trade | ~340 ms added per barge-in removed |
| cost, 3-min call, cache on | $0.130 |

## Fixtures — all real, all already in the repo

`test-audio/caller/*.ulaw`, raw μ-law 8 kHz, no container. Sizes → duration at
8000 B/s:

| Fixture | Bytes | Sec | Used by |
|---|---|---|---|
| `clean_open` | 15,365 | 1.92 | L1 L2 L3 turn 1 |
| `rep_time_q` | 17,090 | 2.14 | L1 L2 L3 turn 2 |
| `rep_digits` | 21,920 | 2.74 | L1 L2 L3 turn 3 |
| `rep_confirm` | 16,347 | 2.04 | L1 L2 L3 turn 4 |
| `rep_close` | 7,059 | 0.88 | L1 L2 L3 turn 5 |
| `barge_in` | 19,845 | 2.48 | L1 L2 barge-in arm |
| `name_spelling` | 40,805 | 5.10 | L4 |
| `no_terminal_punct` | 16,645 | 2.08 | L2 semantic_vad arm |
| `trailing_lead_in` | 17,285 | 2.16 | L2 semantic_vad arm |
| `partial_digits` | 35,525 | 4.44 | L2 semantic_vad arm |

These exist because the cascade got them wrong. Both vendors face the real
failure cases, not synthetic ones.

## Probes

### L1 — Gemini Live latency + barge-in · ~$0.30
Model `gemini-3.1-flash-live-preview`, AI Studio WS (`GEMINI_API_KEY`).
Real prompt prefix as `systemInstruction`, real `buildCallTools` declarations,
`inputAudioTranscription` + `outputAudioTranscription` on.
Requires μ-law 8k → PCM16 16k upsample (throwaway; also evidence for the
6–10 h resampling tax claimed in the analysis doc).
Frames paced at real-time 20 ms. Dumping fast fakes VAD.

Arms: 5 conversation runs × 5 turns; 5 barge-in trials.

### L2 — OpenAI Realtime mini · ~$1.50
`gpt-realtime-2.1-mini`, WS, `g711_ulaw` in AND out — **no resampler**, which
is itself the evidence for the integration-tax claim.
Same script, same fixtures, same pacing, matched arms.
Extra arm: `semantic_vad` × `eagerness` ∈ {low, medium, high} against
`no_terminal_punct`, `trailing_lead_in`, `partial_digits`. 5 trials each.

### L3 — OpenAI Realtime full · ~$0.95
`gpt-realtime-2.1`, 1 run, reference ceiling only. **N=1 → compared to
nothing.** Sole question: categorically different behaviour on the same
fixtures? May 403 on a fresh account's spend tier — log and move on.

### L4 — Gemini reseed name fidelity · ~$0.15
`name_spelling.ulaw`. 6 turns, reseed history as text at turn 3 per LV2, ask
for read-back at turn 6. Assert **exact string equality** vs ground truth.
Read-back by ear cannot catch a spelling error.

### L5 — Vertex EU turn-2 repro · ~$0.10
`gemini-live-2.5-flash-native-audio`, Vertex, **project `vetra-uk-edc8ca`,
location `europe-west1`** (aiplatform confirmed enabled there; owner holds
roles/owner). NOT `physicianmessagingapp` — that is a stale unrelated default.
4 turns. Assert `model_turn` arrives on turns 2, 3, 4.
**Blocked on ADC** — needs `gcloud auth application-default login` +
`set-quota-project vetra-uk-edc8ca`. Sequenced last so it can land late.

## Pre-registered verdicts

Written to `verdicts.json` before the first run.

| ID | Probe | Prediction | Fails if |
|---|---|---|---|
| V1 | L1 | Gemini model leg p50 < 940 ms | ≥ 940 ms — no win at the leg that dominates the cascade turn |
| V2 | L1 | `serverContent.interrupted` fires on ≥4 of 5 barge-ins | ≤3 — the reported barge-in bug is real for us |
| V3 | L1 | barge-in stop latency < 340 ms | ≥ 340 ms — no better than the cascade's measured trade |
| V4 | L2 | at `eagerness: low`, no cut-in on `no_terminal_punct` / `trailing_lead_in` in ≥4 of 5 | ≤3 — `semantic_vad` does not solve our measured endpointing failures, and OpenAI's main advantage over Gemini evaporates |
| V5 | L2 | OpenAI mini model leg p50 < Gemini's (V1) | ≥ — no latency reason to prefer OpenAI |
| V6 | L4 | name read-back exact-matches ground truth 5/5 | <5/5 — kills LV2, which is the entire economic case for Gemini Live |
| V7 | L5 | turn-2 silence does NOT reproduce | reproduces — Gemini has no residency-compliant Live option and OpenAI wins the hard gate by default |
| V8 | all | measured cost/call within ±25% of the analysis doc's modelled figures | outside — §4 of the analysis doc needs re-deriving |

## Order

1. shared lib + cost meter + verdicts.json
2. L1 (validates harness and cost meter on the cheapest real arm)
3. L4 (reuses L1 transport)
4. L2
5. L3
6. L5 (if ADC landed)
7. report

## Report

`report.md` + `results.json`. Per probe: prediction, result, PASS/FAIL, tokens,
**cost column**. Plus a total spend line vs the $5 cap.

## What this CANNOT answer

- Whether either sounds better on a handset. No PSTN leg. Needs a real call,
  the owner's ears, a UK number. Band-limiting to 300–3400 Hz may erase the
  whole difference.
- True voice-to-voice. Model leg only.
- Booking correctness / conversation quality — that is the 43-scenario eval and
  needs the LV4 harness built first.
- Anything about real callers. 10 fixtures is not a distribution.
