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
