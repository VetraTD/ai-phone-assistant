# Speech-to-speech probes — round 2

Closes the gaps round 1 left, on both vendors. Predictions pre-registered in
`verdicts-r2.json` (2026-09-02T03:45:00Z) before any round-2 measurement except
phase-A discovery, which is enumeration and is recorded as finding F1.

**Round 2 spend $0.5661. Cumulative $2.2383 against the $5.0000 cap.**

**1 of 7 round-2 predictions held.**

---

## The three things that changed the answer

### 1. There is only one deployable Gemini, and it is not the one round 1 measured

Phase-A discovery connected 24 model/region cells. Three reachable:

- `gemini-live-2.5-flash-native-audio` — Vertex **europe-west1** (Belgium) and us-central1
- `gemini-3.1-flash-live-preview` — **AI Studio only** (consumer API key)

**`europe-west2` (London) serves no Live model at all.** Every candidate fails
the WebSocket upgrade with an HTTP 400 from the Google frontend; the bidi path is
not routed in that region. So a "your data stays in the UK" promise cannot be met
by Gemini Live — the closest is Belgium.

And round 1's headline Gemini numbers (1,043 ms, $0.0067/turn) came from the
3.1 preview on AI Studio: **not a residency path, not a BAA path, and a preview
model.** Everything in round 2 runs on the surface that could actually ship.

### 2. Gemini does not generate faster than OpenAI. It endpoints faster.

With automatic VAD disabled and an explicit `activityEnd`, Gemini's pure
generation time is **898 ms** — *slower* than OpenAI's ~790 ms.

| | Gemini 2.5 (Vertex) | OpenAI mini |
|---|---|---|
| pure generation | **898 ms** | ~790 ms |
| endpointing, complete utterance | ~152 ms | 169 ms @200 · 292 ms @300 · 483 ms @500 |
| total model leg | 1050 ms | 1680 @200ms · 1686 @300ms · 2192 @500ms |

Round 1 reported OpenAI as ~940 ms slower and I attributed it to the model. It
was `silence_duration_ms: 500`, a value this harness chose for OpenAI while
leaving Gemini's VAD at its default. Sweeping it does not close the gap.

### 3. round 1's V4 "pass" was a 9.7-second hang

Both round-1 and the first round-2 endpointing arm scored a binary: did the
vendor answer inside the window `classifyHold` charges? A "no" was scored as
"correctly waited". A "no" also covers "the caller got silence and nothing
happened", and those are opposite outcomes.

Timing the holds instead of counting them:

| configuration | `no_terminal_punct` | `trailing_lead_in` | `partial_digits` |
|---|---|---|---|
| Gemini · default VAD | 1453 ms | 2563 ms | 1758 ms |
| Gemini · END_SENSITIVITY_LOW, 1200 ms | 2792 ms | 3882 ms | 2875 ms |
| OpenAI · server_vad 500 ms | 2281 ms | 1346 ms | 2074 ms |
| OpenAI · semantic_vad low | 9727 ms | 2940 ms | 9384 ms |

Every cell responded — nothing was inert, so no earlier result was measuring a
dead session. But **OpenAI's `semantic_vad` at `low` holds for 9727 ms and
9384 ms.** On a phone call that is not patience, it is a caller
saying "Next Tuesday afternoon works" and hearing nine seconds of nothing.
Round 1 scored that cell as V4 passing.

On sane settings the two vendors converge: Gemini's default and OpenAI's
`server_vad` at 500 ms both hold between ~1.3 s and ~2.6 s — which is roughly
what our own `classifyHold` already charges. **Neither vendor solves
endpointing; both approximately reproduce what we do today.**

---

## The slope, not the median

A p50 across a conversation hides the shape. Per-turn-index medians:

| turn | 1 | 2 | 3 | 4 | 5 | drift |
|---|---|---|---|---|---|---|
| **Gemini 2.5 · Vertex** | 1137 | 1044 | 922 | 1022 | 1169 | **+32 ms** |
| **OpenAI mini · 200 ms** | 990 | 1202 | 2249 | 1828 | 2748 | **+1758 ms** |
| **OpenAI full · 500 ms** | 2082 | 1862 | 1558 | 1331 | 1469 | **-613 ms** |

**Gemini is flat. The mini degrades badly. The full model improves.**

At turn 1 the mini is the fastest thing measured (990 ms, faster than
Gemini's 1137 ms). By turn 5 it is 2748 ms — roughly triple —
while its endpointing stayed pinned at ~170 ms, so the drift is generation, not
VAD. A real receptionist call is 10-15 turns, which is past the right-hand edge
of this table and going the wrong way.

The full model does the opposite, most likely as its prefix cache warms. So
"OpenAI is slow" is not a fact about OpenAI: **the mini degrades, the full model
does not.** Round 1 asserted a vendor-level latency ranking from one
configuration at one point in a conversation, and that was wrong twice over.

---

## Round-2 verdicts

| ID | Prediction (locked 2026-09-02) | Result | Verdict |
|---|---|---|---|
| **W1** | Gemini at its most patient VAD holds no_terminal_punct AND trailing_lead_in >=4/5 | patient held 5/5 and 5/5 | **PASS** |
| **W2** | Gemini's DEFAULT VAD cuts into trailing_lead_in >=3/5 | cut in 0/5 | **FAIL** |
| **W3** | Gemini pure generation (manual activityEnd) p50 < 700 ms | 898 ms (n=5) | **FAIL** |
| **W4** | OpenAI mini at silence_duration_ms=200 gets leg p50 < 1,500 ms | 200ms->1680ms, 300ms->1686ms, 500ms->2192ms | **FAIL** |
| **W5** | Against a LONG reply, audio keeps arriving after the interrupt signal in >=3/5 on at least one vendor | Gemini 1/5, OpenAI 0/5 | **FAIL** |
| **W6** | OpenAI full at N=5 holds leg p50 < 1,600 ms with 0 dropped turns | 1558 ms p50 (n=23), 2 dropped | **FAIL** |
| **W7** | Gemini 2.5 on Vertex costs less per turn than OpenAI mini ($0.0048) | $0.0049 vs $0.0048 | **FAIL** |

- **W1** — True as a binary — but the hold-time diagnostic shows "held" here means 2792 ms and 3882 ms of silence. Patience and dead air are the same measurement until you time them.
- **W2** — Wrong in the useful direction: the default holds trailing_lead_in for 2563 ms, past the 2,000 ms our own classifyHold charges. It cut into no_terminal_punct instead (3/5).
- **W3** — Like-for-like on a fresh single turn, Gemini generates SLOWER than OpenAI's ~790 ms, so Gemini's total-leg lead is endpointing (~152 ms) and not the model. But single-turn is OpenAI's best case only: in a real conversation the mini's generation grows to ~1,480 ms by turn 5 while Gemini's stays flat. Neither number generalises without the slope table above.
- **W4** — Endpointing tracks the setting exactly (169ms@200, 292ms@300, 483ms@500), so the knob works. The leg still misses 1,500 ms because the mini's GENERATION grows through the call — turn 1 is 990 ms, turn 5 is 2748 ms. Round 1 blamed the vendor for a number this harness set; round 2 shows the setting was only part of it.
- **W5** — Both vendors mostly stop cleanly. But Gemini's worst trial delivered 2879 ms of audio AFTER announcing the interrupt — a tail a playout queue must still absorb.
- **W6** — Latency clause held (1558 ms < 1,600); the reliability clause did not — 2 turns produced no audio. Round 1's N=1 gave 1,375 ms and zero drops, which PLAN.md correctly said was "compared to nothing". Unlike the mini, the full model gets FASTER through a call (-613 ms).
- **W7** — Round 1's $0.0044 was an artefact of L5's shorter 4-turn script. On the identical 5-turn script the two vendors are within 2% — cost is a tie, not an argument.

---

## Endpointing, both vendors, same question

Cut-in counts inside `classifyHold`'s own window. Read them WITH the hold
times above — a low cut-in count is only good if the hold that produced it was
short enough to be a pause rather than a hang.

| fixture | Gemini patient | Gemini default | Gemini eager | OpenAI low | OpenAI medium | OpenAI high |
|---|---|---|---|---|---|---|
| `no_terminal_punct` | 0/5 | 3/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `trailing_lead_in` | 0/5 | 0/5 | 0/5 | 3/5 | 5/5 | 5/5 |
| `partial_digits` | 0/5 | 1/5 | 1/5 | 0/5 | 0/5 | 0/5 |

---

## Barge-in against a long reply

Round 1 interrupted 2–3 s replies that had usually finished streaming. Here the
model is forced into a long answer first, so there is guaranteed audio in flight.

| | Gemini 2.5 | OpenAI mini |
|---|---|---|
| trials with audio genuinely in flight | 5/5 | 2/5 |
| interrupt signalled | 5/5 | 5/5 |
| signal latency p50 | 667 ms | 470 ms |
| audio still arriving after the signal | 1/5 | 0/5 |
| worst tail | 2879 ms | 0 ms |

Both vendors stop cleanly most of the time. Neither stops cleanly *every* time,
and a single trial delivering seconds of audio after the interrupt is exactly the
case a playout queue exists for. **`turnManager`'s queue half survives on both
vendors**; its VAD/endpoint-decision half is genuinely replaceable on both.

*Two caveats.* The long reply was produced by instructing the model to monologue —
a real caller cannot do that, so this measures the mechanism, not a natural call.
And the instruction did not land equally: Gemini had audio genuinely in flight in
5/5 trials
against OpenAI's 2/5,
because OpenAI kept obeying the prompt's "1-2 short sentences" rule. **OpenAI's
clean 0/5 tail is therefore a weaker result than it looks** — it
was interrupted mid-reply far less often than Gemini was.

---

## Cost, on the identical script

| | $/turn | 12-turn call, 1,000 calls/mo |
|---|---|---|
| Gemini 2.5 native · Vertex europe-west1 | $0.0049 | $58.23 |
| OpenAI `gpt-realtime-2.1-mini` | $0.0048 | $57.78 |
| OpenAI `gpt-realtime-2.1` (full) | $0.0150 | $179.77 |

Round 1 reported Gemini on Vertex at $0.0044/turn and called it the
cheapest thing measured. That came from L5's 4-turn script, which omits the
`end_call` turn. On the identical 5-turn script the two are within 2%.

**Cost has now moved three times across two rounds** — Gemini expensive, then
OpenAI cheaper, then Gemini cheapest, now a tie. That is the strongest available
argument for not deciding on cost.

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
| R2 | $0.5661 |
| **Total** | **$2.2383** |
| Cap | $5.0000 |
| Headroom | $2.7617 |
