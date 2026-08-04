# Test 1 (measure the voice path) and Test 2 (TTS blind A/B) — runbook

Test 1 decides whether Test 2 matters. Run it first: if TTS time-to-first-byte
turns out to be 5% of a turn, the voice is chosen on sound and price alone; if
it is 30%, Cartesia's TTFA claim is worth paying for.

---

## What was added

**Instrumentation** — the four existing deltas measured an in-process window.
`speech_end` was stamped when Deepgram's final reached us and `first_audio_sent`
when audio was handed to the pacing queue, so Deepgram's endpointing, both
carrier hops and the pump's lookahead were all outside the numbers. Three
additions close that:

| delta | spans | why it was invisible |
|---|---|---|
| `stt_endpoint_ms` | `audio_speech_end` → `speech_end` | reconstructed from Deepgram word timings vs. audio streamed (`lib/voice/sttStream.js` `getLastSpeechEndAt`) |
| `playout_ms` | `first_audio_sent` → `first_frame_wire` | `lib/voice/audioOut.js` paces playout; enqueue ≠ on the wire |
| `true_v2v_ms` | `audio_speech_end` → `first_frame_wire` | the wait a caller actually experiences |

Plus per-`classifyHold`-branch attribution (count and total ms), and prompt-cache
hit rate — `cachedContentTokenCount` was previously logged at DEBUG and then
dropped before it left `services/gemini.js`.

**Security** — the debug routes now need `DEBUG_ENDPOINTS=true` **and** a
matching `DEBUG_TOKEN`, compared over SHA-256 digests. They fail closed (no
token configured = no access) and return 404 rather than 401, so a rejected
request cannot confirm the route exists. Unset both when the run is over.

---

## Test 1

### One-time setup

1. A second Twilio number to originate from (the assistant's own number is the
   only permitted destination).
2. On the **server under test**: `DEBUG_ENDPOINTS=true`, `DEBUG_TOKEN=<secret>`.
3. Locally, in `.env`: `ASSISTANT_NUMBER`, `PROBE_NUMBER`, `DEBUG_TOKEN` (same
   value), and `PROBE_BASE_URL` if the target differs from `BASE_URL`.

### Run

```bash
npm run probe:synth        # cache the caller audio once (Google TTS, 8kHz mulaw)
npm run probe              # dry run — prints the plan and the cost, dials nothing
npm run probe -- --confirm # place the calls
```

Guardrails, all enforced in `lib/probe/dialPlan.js` before anything dials: the
destination must equal `ASSISTANT_NUMBER`, the run is capped at 25 calls,
`--confirm` is required, and the estimated cost is printed first. ~12 calls is
about $0.60.

Output lands in `latency-runs/<runId>/` — `report.md`, `server.json`,
`probe.json`.

### What the report tells you

`report.md` states a verdict chosen by rules written **before** any numbers
existed (`lib/probe/report.js`), so the conclusion isn't fitted to the result:

| finding | conclusion |
|---|---|
| `stt_tail_ms` dominates | `classifyHold` — the attribution table names the branch. Self-inflicted, no vendor involved. |
| `stt_endpoint_ms` dominates | Deepgram's window. `STT_ENDPOINTING_MS` is a deploy-time knob; possibly no code change at all. |
| `llm_ttfb_ms` dominates | The Groq test is worth running — but fix the cache prefix first if the hit rate is ~0. |
| `tts_ttfb_ms` dominates | Cartesia's TTFA is worth real money. Weight Test 2 toward latency. |
| `playout_ms` dominates | The pacing pump. Cheapest possible fix, entirely ours. |
| probe − server is large | Carrier transit. Nothing here fixes it — stop optimising. |
| spread evenly | Cheap wins in §12 order, then stop. |
| p50 < 800ms | The 1,500–1,900ms reconstruction was wrong; none of this is urgent. |

The probe measures voice-to-voice on the originating leg, past both carrier
hops — a quantity the server structurally cannot see. Subtracting the server's
own `true_v2v_ms` gives the remainder Twilio and the carrier own.

---

## Test 2

```bash
npm run voice:ab -- --smoke               # one line per vendor: checks keys and formats
npm run voice:ab                          # full blind pack
npm run voice:ab:call -- --run <runId> --to +1...   # play it down a handset
```

Needs `CARTESIA_API_KEY`, `INWORLD_API_KEY`; ElevenLabs and Gemini reuse
existing keys.

**Fairness.** ElevenLabs and Cartesia emit 8kHz mu-law natively. Inworld and
Gemini return 48kHz/24kHz PCM and go through `lib/audio/resample.js`, which
low-passes to 3.4kHz **before** resampling. Plain decimation would fold
sibilance back into the voice band as grit and lose the test for those two on a
technicality — `tests/resample.test.js` asserts it doesn't.

**Blindness.** Filenames carry no vendor identity, order is shuffled within each
sentence and differs between sentences, and the mapping goes to
`answer-key.json` (gitignored). Score `SCORECARD.md` first; `OBJECTIVE.md`
(TTFA, cost) is written separately so the numbers can't bias the ears.

Judge over a handset. Telephony bandwidth erases most of what separates these
models — if the scores come out close, that is a real result, and an argument
against paying top of range.

---

## After the run

Unset `DEBUG_ENDPOINTS` and `DEBUG_TOKEN` on the server. The probe websocket
route and the debug endpoints all disappear with them.

---

# Results — first run, 2026-08-04

12 calls, 95 server-side turns, 73 clean probe turns.

| stage | p50 | p95 | share of turn |
|---|---|---|---|
| `true_v2v_ms` | **3062** | 9199 | — |
| `llm_ttfb_ms` | **1836** | 2347 | **60%** |
| `stt_endpoint_ms` | 690 | 5784 | 23% |
| `tts_ttfb_ms` | 95 | 251 | 3% |
| `stt_tail_ms` | 1 | 2502 | ~0 at p50 |
| `playout_ms` | 0 | 0 | 0 |

Probe p50 2664ms against server 3062ms. The gap is expected: the synthesized
caller clips carry trailing silence, so the probe stops its stopwatch later
than Deepgram places the last word. Two independent clocks agreeing to within
400ms is what makes the rest of the table trustworthy.

## Levers that measurement killed

- **TTS vendor.** 95ms of a 3062ms turn. Even a zero-latency vendor saves 3%.
  Test 2 is a sound-and-price decision, not a latency one.
- **Prompt caching.** Three byte-identical 4468-token requests back to back
  never produced a `cachedContentTokenCount` — implicit caching does not engage
  on `gemini-3.6-flash`. And it would not matter if it did: TTFT is flat in
  prompt size (6 tokens ≈ 700ms, 2586 tokens with 8 tools ≈ 680ms). Worth
  fixing for token cost; worthless for speed.
- **The pacing pump.** `playout_ms` p50 of 0.
- **`classifyHold`.** 1ms at p50. It fires on ~36% of turns and costs 1.5-2s
  when it does, so it owns the p95 tail, not the median. Note the run's rule
  mix is not representative — the script was built to trigger those branches.

## Where the time actually goes

One model round-trip is ~700ms, and the assistant spends **two** before
speaking: it emits `set_call_intent` first, then the reply.

```
tool:set_call_intent@684   FIRST_TEXT@1364
tool:set_call_intent@773   FIRST_TEXT@1490
```

Rows two and three are `gather_details` turns whose intent was already set —
it re-declares an unchanged intent and pays a full round-trip to do it. An
8-turn eval call makes ~7 of these.

**Attempted and reverted.** Rewording the step guidance and the tool
description cut it to 4-5 calls and saved ~185ms, but the same run regressed
three scenarios on the advisory judge (`name-recall`, `vague-caller`,
`cancel-identity`) against one improvement. `vague-caller` shares the sentence
that had to be edited, so the regression is plausibly causal. 185ms does not
justify a coin-flip on conversation quality, and the golden prompt snapshots
exist to make exactly this trade explicit.

The real fix is architectural: don't route intent through a tool call that
blocks speech. That deserves its own design pass, not another prompt tweak.

## Harness bug found and fixed

The first run reported 11 turns with no reply (~11.5%) and produced impossible
measurements — an 8ms reply, a negative one. Cause: the probe treated 800ms of
silence as end-of-turn, which is shorter than the gaps inside a real reply, so
it interrupted (30 barge-ins recorded against 12 scripted) and every following
turn was measured against the wrong boundary. The server's own counters showed
95 turns for 96 utterances and zero `llm_stalls` — the assistant had answered
nearly everything. Threshold raised to 2000ms.

**Always cross-check a probe-side anomaly against the server's turn count
before treating it as a product defect.**
