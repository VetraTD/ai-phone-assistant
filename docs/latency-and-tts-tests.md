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
| `llm_ttfb_ms` dominates | The Groq test is worth running. Do NOT wait on the prompt cache — a ~0% hit rate is expected on `gemini-3.6-flash` and is not a prefix bug (see the caching section at the end). |
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

## Smoke-test results, 2026-08-04 — two adapters were broken

First live API call these adapters had ever made, and the gate earned its place:

- **Inworld** — `model_id: inworld-tts-1.5 is not supported`. That model does not
  exist. Probing the API, the live IDs are `inworld-tts-1`, `inworld-tts-1-max`,
  `inworld-tts-1.5-max`, `inworld-tts-2`. Now defaults to `inworld-tts-2` so the
  vendor is judged on its current best. List price corrected $0.02 → $0.025 per
  1k chars on demand (Inworld tiers down steeply on monthly spend).
- **Gemini** — `gemini-3.1-flash-preview-tts` not found; the live ID is
  `gemini-3.1-flash-tts-preview`. A transposition.

## The premise of Test 2 has changed: it is not sound-and-price for all four

Test 1 concluded TTS is worth 95ms of a 3,062ms turn. That is true **of
streaming vendors**. The batch APIs are a different animal, and the blind-pack
run measured it:

| vendor | TTFA p50 | TTFA range | $/1k chars |
|---|---|---|---|
| ElevenLabs Flash v2.5 | 187ms | 171-281ms | $0.05 |
| Cartesia Sonic 3.5 | 181ms | 94-431ms | $0.035 |
| Inworld TTS 2 | 1,268ms | 774-2,271ms | $0.025 |
| Gemini 3.1 Flash TTS | 8,708ms | 2,549-9,247ms | $0.01 |

For a batch API the first audio byte genuinely arrives only once the whole
utterance is synthesized, so these numbers are what a caller waits. Against a
3,062ms turn, Inworld adds ~1.3s and Gemini adds ~8.7s — Gemini would roughly
quadruple the turn to save $0.04 per thousand characters.

**So the real choice is ElevenLabs vs Cartesia**, which are within 6ms of each
other and differ by 30% on price. Score the pack blind first as the runbook says;
the objective table is written separately for exactly this reason.

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
  fixing for token cost; worthless for speed. **See the caching section at the
  end — the cost side turned out to be worth real money, and the fix is not the
  one the prefix split was built for.**
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

---

# The intent round-trip, removed — 2026-08-04

Design: `docs/superpowers/specs/2026-08-03-intent-marker-design.md`.
Shipped behind `VOICE_INTENT_MARKER`, default **off**.

The model now declares intent as a line at the top of its reply
(`<<intent:book_appointment>>`), stripped in `services/gemini.js` before any
consumer sees it, instead of through a `set_call_intent` function call. One
model round-trip per turn instead of two. `reply.intentArgs` arrives in the same
shape, so the reducer, step machine, nudge strings and logs are untouched.

`llm_tool_ms` and `llm_reply_after_tool_ms` were added first, so the round-trip
is now visible at runtime rather than inferred — `llm_first_chunk` is stamped on
the first *text* delta, which hid the whole first round inside `llm_ttfb_ms`.

## Eval results

Two runs on the tool path, three on the marker path (all post-leak-fix):

| | hard asserts | judge questions | marker leaks |
|---|---|---|---|
| tool path (flag off) | 47/50 — 94.0% | 91/98 — 92.9% | 0 |
| marker (flag on) | **74/75 — 98.7%** | 137/147 — 93.2% | 0 |

Judge quality is indistinguishable; hard assertions are equal or better. Harness
turn latency p50: **1,654ms → ~950ms**. That is the text harness, not a phone
call — the live probe number is still outstanding.

Read these as aggregates, not as any single pair. Individual pairs disagree; see
the next section for why.

## The suite is noisier than the effect it was asked to measure

Two *identical* baseline runs, same model pins, minutes apart:

| baseline run | hard | judge questions |
|---|---|---|
| 1 | 22/25 | 43/49 |
| 2 | 25/25 | 48/49 |

Each candidate/baseline pair showed exactly one judge regression, and it was a
**different scenario each time** (`name-recall`, then `long-call-memory`). In the
`name-recall` case both transcripts asked the caller to spell their surname —
identical behaviour, opposite verdicts. The prompt *mandates* that ask
(`appointments-db.static.txt:68`), so the judge question and the guardrail are in
tension in both modes.

Consequence for future work: a single pair of runs cannot resolve a difference of
one or two judge verdicts. Note that the 2026-08-04 rewording attempt was
reverted on exactly that kind of evidence — three judge regressions against one
improvement, from one run. That does not make the revert wrong, but the finding
was inside this noise band and was never re-measured.

## A leak the tests did not catch, and the run did

The first live eval run leaked a marker into the spoken reply of 4 of 25
scenarios. Every one was a turn that called a tool: the model writes the intent
line at the top of every **round**, and the stripper resolved once per **turn**,
so the copy at the head of round two streamed straight through. Fixed by
re-arming the stripper between rounds; the unit tests that now cover it were
written from the four transcripts.

## A worse bug the review found: silence, not a leak

A review pass over the branch found the failure this design can actually cause,
and it was the opposite of the one being defended against.

`couldBeMarker` only validated the `<<intent:` prefix, never the value. A value
the strict pattern rejects — **one space, one hyphen** — left the buffer open to
the end of the reply, and the unterminated-marker sweep (`[^\n]*`, and a voice
reply rarely contains a newline) then deleted the entire thing. The caller heard
the generic "say that again" line instead of a perfectly good answer. At
temperature 0.4, one wrong character in an identifier is not a rare event.

The sweep is now two bounded alternatives, and the rule is explicit: **a
malformed marker costs the intent, never the reply.** Two smaller defects from
the same review: a delta containing only a newline resolved the round before the
marker began and discarded the following declaration, and a lagging separator
could leave a stray backtick or blank line in `reply.text` — which never passes
through `toSpeakable`, so it reached history and the stored transcript.

Security review was otherwise clean: the parser never sees caller text, `intent`
gates no tool or authorization anywhere, the `allowedTasks` check resists case
and unicode bypass, and none of the three regexes backtrack. One low finding
fixed — the rejected-value log line could echo a digit string, so it now redacts
anything outside `[a-z_]+` (every real task name qualifies, so no diagnostic
value is lost).

`npm run eval:compare <baseline.json> <candidate.json>` diffs two runs per
scenario, names the judge questions that moved, and sweeps every assistant reply
for anything marker-shaped. It exists because `npm run eval`'s exit code comes
from hard assertions alone — judge verdicts set `judgePass` and nothing else, so
a regression there is invisible unless it is diffed deliberately.

## Live probe, 2026-08-04 — measured, not estimated

Two runs, 12 calls each, **same deploy**, differing only in
`VOICE_INTENT_MARKER`. Probe A is not "the old code": every fix on this branch
was already live, so the comparison isolates the marker and nothing else.

| stage p50 | A (tool) | B (marker) | |
|---|---|---|---|
| `true_v2v_ms` | 4,040ms | **3,551ms** | −489ms |
| `llm_ttfb_ms` | 1,855ms | **969ms** | **−886ms, −48%** |
| `llm_tool_ms` | 1,030ms | 1,113ms | see below |
| `tts_ttfb_ms` | 777ms | 913ms | drifted up in both |
| turns paying a tool round-trip | 80% | **35%** | the actual result |
| `intent_marker_leaks` | 0 | **0** | gate passed |

**`set_call_intent` cost 1,030ms, not the ~700ms hand-annotated from the first
run.** The split validates itself: on probe A, `llm_tool_ms` + 
`llm_reply_after_tool_ms` = 1,030 + 835 = 1,865 ≈ `llm_ttfb_ms` 1,855.

`llm_tool_ms` does **not** vanish in marker mode, and expecting it to was a
misreading of the metric: it marks the first tool of *any* turn, so a turn that
legitimately calls `check_appointment_availability` still registers one. The
evidence is the share of turns paying a round-trip at all — 80% → 35% — which is
`set_call_intent` no longer taxing turns that needed no tool.

The probe's own verdict, chosen by rules written before any numbers existed,
moved from *"LLM time-to-first-token dominates (46% of the turn)"* to:

> Cost is spread evenly across stages. No single fix pays for itself.

The LLM is no longer the dominant cost of a turn, which was the objective.

## Probe C — the clean run, and why A and B were not

Probes A and B were both measured on the **Google fallback voice**. The
ElevenLabs quota (30,000 characters) ran out mid-testing; every request was
rejected, `ttsStream` fell back per sentence to batch Google synthesis, and the
sticky-Google rule kept the rest of each call there. Nothing counted that, so it
surfaced only as an 8x rise in `tts_ttfb_ms` that read like a latency regression.

After a top-up, probe C — marker mode, healthy ElevenLabs, same 12 calls:

| stage p50 | original (tool, healthy EL) | probe C (marker, healthy EL) | |
|---|---|---|---|
| `true_v2v_ms` | 3,062ms | **2,607ms** | −455ms |
| probe-leg p50 | 2,664ms | **1,810ms** | **−854ms** |
| `llm_ttfb_ms` | 1,836ms | **940ms** | **−49%** |
| `tts_ttfb_ms` | 95ms | **94ms** | unchanged |
| `stt_endpoint_ms` | 690ms | 700ms | unchanged |
| `tts_fallback_turns` | — | **0** | |
| `intent_marker_leaks` | — | **0** | |

`tts_ttfb_ms` returning to **94ms** against the original 95ms is what confirms
the fallback diagnosis outright: nothing in the TTS path ever regressed.

The two clocks disagree on magnitude (−455ms server, −854ms probe-leg) because
`stt_tail_ms` happened to fire more in probe C (304ms vs 1ms) — `classifyHold`
is stochastic across runs. Both agree on direction and that the win is large.

**`tts_ttfb_ms` is not a target and never was.** It is 94ms, 3.6% of the turn.
Calling it "the next thing to look at" was a conclusion drawn from
fallback-contaminated data.

## Still outstanding

- ~~`stt_endpoint_ms` is the second-largest stage~~ — **done, see probe E.**
  Lowered 300 → 150, worth −140ms, kept.
- ~~The probe over-interrupts~~ — **fixed**, see below.
- ~~`classifyHold` has no representative data~~ — **it does now, and the answer
  is that classifyHold costs nothing.** See below.
- One manual call doing the scenario-25 mid-call switch, listening for a spoken
  marker.
- Unset `DEBUG_ENDPOINTS` / `DEBUG_TOKEN` on Railway. They were found still
  enabled from the previous run, days later.

---

# Probe D, 2026-08-04 — the first run on realistic speech

Two things changed since probe C: the probe stopped interrupting itself, and
the caller script stopped being rigged.

## The probe was talking over the assistant

`handleInbound` cancelled its end-of-turn countdown on voiced audio — guarded by
`state !== STATE.GAP`. But entering the gap from `LISTENING` sets `state = GAP`
in the same step, so the cancel could only ever fire during the greeting. On a
reply the countdown ran to completion however long the assistant kept talking.

| | probe C | probe D |
|---|---|---|
| barge-ins recorded | 30 | **12** (exactly the 12 scripted) |
| turns timed out | 11 | **0** |
| clean probe turns | 73 | **108** |
| server turns | 95 | **120** |

Every spurious interruption desynced the turns after it, which is where the
phantom timeouts came from. The runbook has warned since the first run to
cross-check probe anomalies against the server's turn count; this was the
harness, again.

## classifyHold does not fire on real speech

The old script hand-picked utterances to trigger each branch — 4 of its 8 lines
carried an `expectRule`. `REPRESENTATIVE_LINES` is shaped from 1,000 real caller
utterances in `call_transcripts` (aggregate statistics only, no text copied):
median **6 words**, ~25% are 1-3 word acknowledgements, ~34% questions, ~10%
carry digits. Real callers are far terser than the script assumed.

Run on that, across 120 turns:

| rule | holds | total ms |
|---|---|---|
| `post_barge_settle` | 12 | 4,404 |
| `complete` | 108 | 0 |

**Zero `partial_digits`, zero `trailing_conjunction`, zero
`no_terminal_punctuation`.** `stt_tail_ms` p50 **0ms**, p95 362ms. The only
holds are the post-barge settles from the one scripted interruption per call.

So `classifyHold` costs nothing in production-like conditions. The runbook's
"fires on ~36% of turns and costs 1.5-2s when it does" described the *script*.
**Item #3 is closed: there is nothing to tune.** The code stays as insurance
against the mid-sentence finals it was written for — which is exactly what makes
lowering the endpointing window safe to try.

## Where the turn goes now

| stage p50 | ms | share |
|---|---|---|
| `llm_ttfb_ms` | 1,128 | 44% |
| `stt_endpoint_ms` | 700 | 27% |
| `tts_ttfb_ms` | 97 | 4% |
| `stt_tail_ms` | 0 | 0% |
| `true_v2v_ms` | **2,569** | |

`intent_marker_leaks` 0, `tts_fallback_turns` 0.

---

# Probe E, 2026-08-04 — endpointing 300 → 150. Kept.

Only the endpointing window is ours to spend: of ~700ms measured, the rest is
Deepgram inference plus network. Predicted ceiling ~150ms. What happened:

| stage p50 | D (300ms) | E (150ms) | |
|---|---|---|---|
| `stt_endpoint_ms` | 700ms | **560ms** | **−140ms** |
| `stt_tail_ms` | 0ms | **0ms** | unchanged |
| `true_v2v_ms` | 2,569ms | **2,403ms** | **−166ms** |
| `llm_ttfb_ms` | 1,128ms | 1,052ms | noise |
| `tts_ttfb_ms` | 97ms | 95ms | unchanged |
| barge-ins / timeouts | 12 of 12 / 0 | 8 of 8 / 0 | clean |

The win landed at the predicted size and **`classifyHold` did not absorb it** —
one `trailing_conjunction` hold across 83 turns, p50 still 0ms. The cost appears
only in the tail: `stt_tail_ms` p95 362 → 500ms, max 407 → 2,001ms. Earlier
finals do land mid-sentence more often; the hold logic catches them, which is
what it is for.

Caveat on the comparison: D is 12 calls, E is 8 (the run was interrupted and the
report re-rendered from server data with `--report-only`). Single runs either
way. The direction is consistent and the mechanism understood, but this is not a
large sample.

**Stop here rather than trying 100ms.** At 150 the stage is 560ms, of which
~410ms is inference and network. The whole remaining knob is worth ~150ms, and
taking it means more premature finals for ~2% of a turn.

## Do not push while a probe is running

Probe E had to be run twice. The first attempt returned **0 turns from 12
calls**, every call dead in under a second. Cause: a docs commit pushed at
08:42:25Z triggered a Railway redeploy, and the probe dialled at 08:43:17Z —
the server restarted underneath the run.

The report said "no data" and pointed at `DEBUG_ENDPOINTS` and whether the calls
connected. Right to flag it, wrong cause. A push is a deploy is a restart: treat
any commit during a run as invalidating it.

---

# Prompt caching, 2026-08-04 — implicit is dead, explicit works

Billing confirmed what telemetry only hinted at. Two days of Gemini spend,
$20.04, and the summary reads **"includes $0.00 in savings"** with a single
dominant SKU — `Generate content input token count gemini 3.6 flash text` at
**$18.62 of $20.04**. No cached-input line at all. **Input tokens are ~93% of
the Gemini bill and none of them are cached.**

## Why the prefix split never paid off

Three byte-identical 4,186-token requests, run three ways:

| where the stable content sits | `cachedContentTokenCount` |
|---|---|
| `systemInstruction` (what `services/gemini.js` does today) | **absent** |
| leading turn of `contents` | **absent** |
| explicit `ai.caches.create` + `config.cachedContent` | **4,182 of 4,186** |

**Implicit caching does not engage on `gemini-3.6-flash` at all** — not from
`systemInstruction`, not from `contents`. Moving the prefix around will not fix
it; the mechanism simply is not there for this model. Explicit caching works
perfectly on the same model.

So `buildStaticSystemPrefix` / `buildDynamicTail` was built for a mechanism that
never fires. The split is still correct and the byte-stability the snapshot
tests enforce is exactly what an explicit cache needs — only the mechanism
changes.

## What it is worth

Cache reads are 10% of base input price; explicit storage is ~$1.00 per 1M
tokens per hour on Flash. The static prefix is ~5,000 tokens, and **a call is
~10 turns that all share it**, so a cache pays for itself inside a single call:

| per call (~10 turns) | uncached | cached |
|---|---|---|
| input billed | 54,000 @ $0.50/M ≈ $0.027 | ~4,000 @ $0.50/M + ~50,000 @ $0.05/M ≈ $0.005 |

Roughly **75-80% off the dominant cost line**. Held 24/7 the storage is $3.60
per business per month (break-even ~160 calls/month); created on demand with a
~1 hour TTL it collapses to pennies and pays back almost immediately.

## Shape of the fix, when someone takes it

One cache per business keyed on the static prefix, created lazily, TTL ~1 hour,
recreated on config change or expiry, and **falling back to the uncached path on
any cache error** — a caching failure must never fail a call. `cachedContent`
and `systemInstruction` are mutually exclusive on a request, so the prefix moves
into the cache and the dynamic tail stays on the request.

Still a cost lever only. TTFT is flat in prompt size; none of this makes a call
faster.

---

# Explicit caching implemented, 2026-08-04 — measured on the real turn path

`scripts/verify-explicit-cache.js` answered the three unknowns that blocked
writing this correctly. All three came back different from the guess:

| question | answer |
|---|---|
| minimum cacheable size | **1,024 tokens**, hard-rejected below (`min_total_token_count=1024`) |
| does function calling survive with `tools` only in the cache? | **yes** — the hard gate passed |
| error shape for a dead cache | **403 `PERMISSION_DENIED`**, "CachedContent not found" — *not* 404 |

Then, on `getReplyStreaming` itself with `GEMINI_EXPLICIT_CACHE=true`:

| turn | prompt tokens | cached | |
|---|---|---|---|
| 1 | 4,005 | 0 | cache created in background, turn runs uncached at full speed |
| 2 | 4,038 | 3,786 | **94%** |
| 3 | 4,036 | 3,786 | **94%** |
| 4 | 4,036 | 3,786 | **94%** |

One cache created, three reuses. Cache reads bill at 10% of input, so a ~10-turn
call goes from ~40,000 billed input tokens to ~9,700 effective — **~76% off the
dominant line**, matching the 75-80% predicted above.

## The trap: the SDK mutates your tool declarations

First run created **two** caches — `d83268…` on turn 1, `f0475f…` on turn 2 —
and only reused the second. The prefix was byte-stable and `extras` was not
mutated, so neither was the cause.

`@google/genai` normalizes JSON-Schema `type` values **in place** when a request
is sent (`"object"` → `"OBJECT"`), and the declaration objects are module-level
and shared by reference. So the same business hashes one way before its first
request of the process and another way after — one wasted cache per process,
whose storage is paid for and never read.

`computeCacheKey` now lower-cases every `type` before hashing
(`canonicalizeTools`). Regression-tested in `tests/geminiCache.test.js`.

Worth remembering beyond caching: **anything hashed or compared after being
handed to the SDK may not be what you passed it.**

## Design notes

`resolveCachedContent` is **synchronous and never blocks a turn** — creation is
a 200-500ms round trip, and awaiting it would put that on TTFT on a path where
140ms was fought for. It returns a handle or null and schedules the create in
the background, so turn 1 pays nothing and caching can never make a call slower
or fail.

`CALLER CONTEXT` moved from `buildStaticSystemPrefix` to `buildDynamicTail`. It
rendered per-caller data, which would have meant one cache per caller — and it
would have parked caller names, summaries and appointment times in Google's
cache store for the TTL. Two invariants in `tests/promptSplit.test.js` now
enforce that the prefix is byte-identical across callers and contains no caller
data.

**Still a cost lever only.** `llm_ttfb_ms` must stay flat; if it moves, the
non-blocking design has been violated.
