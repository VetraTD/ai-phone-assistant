# In-band intent marker — design

**Date:** 2026-08-03
**Status:** approved, implementation on `feat/intent-marker`
**Supersedes:** the reverted prompt-rewording attempt of 2026-08-04 (see
`docs/latency-and-tts-tests.md`, "Attempted and reverted")

---

## Problem

The 2026-08-04 probe run (12 calls, 95 server-side turns, 73 clean probe turns) put real
voice-to-voice p50 at **3,062ms**. `llm_ttfb_ms` is p50 **1,836ms — 60% of the turn**.

The cause is structural, not a slow vendor. On most turns the model makes **two** model
round-trips before the caller hears anything:

```
tool:set_call_intent@684   FIRST_TEXT@1364
tool:set_call_intent@773   FIRST_TEXT@1490
```

Round 1 emits a `set_call_intent` function call and no text. We execute it, send the
`functionResponse` back (`services/gemini.js:1240`), and the model streams the actual
reply in round 2. Two ~700ms trips where one would do. An 8-turn call pays this ~7 times,
including on turns whose intent has not changed.

### The first round-trip buys nothing in the turn that pays for it

Established by tracing the tool end to end:

- **The handler is a pure no-op.** `services/tools.js:112-124` returns `{success:true}`
  and a `stateEffects.intentArgs`. No DB write, no notification, no capability effect, no
  async work. It is not in `ACTION_TOOL_NAMES`, so it does not unlock same-turn `end_call`.
- **It cannot influence this turn's prompt.** The system instruction is built at
  `services/gemini.js:1074`, before any tool executes, and the chat object is per-turn.
- **It is not even stored until the turn is over.** The reducer
  (`lib/voice/replyState.js:76-83`) runs from `session.js:2166`, after `tts.end()`.

Its entire payoff lands on the **next** turn:

1. the `| Intent: X` line and pack step-guidance selection in `buildDynamicTail`
   (`services/gemini.js:735`, `:825`);
2. the `identify_intent | confirm → gather_details` step transition;
3. one silence-nudge string (`session.js:468-486`);
4. log lines (`intent_set`, `turn_completed`, `call_ended.finalOutcome`).

Not persisted to the database, not read by the post-call summary (which re-derives an
outcome from the transcript), and it gates no tool — `services/tools.js` branches on
`ctx.step` and `ctx.transferAllowed`, never on intent.

So the caller waits ~700ms in silence for metadata that is not read until they have
spoken again.

### Why not just reword the prompt

Tried on 2026-08-04 and reverted. It cut the calls to 4-5 and saved ~185ms, but the same
run regressed three scenarios on the advisory judge (`name-recall`, `vague-caller`,
`cancel-identity`) against one improvement. `vague-caller` shares the sentence that had
to be edited, so the regression is plausibly causal.

That approach made each declaration **rarer**, which changes what the model decides. This
design makes each declaration **free**, which does not.

---

## Design

### The marker

The model writes, as the first line of its reply:

```
<<intent:book_appointment>>
Sure, I can get that booked for you. What day works?
```

We consume the first line, set `intentArgs`, and emit only the remainder downstream. The
caller hears "Sure, I can get that booked for you. What day works?"

`<<…>>` is chosen deliberately: it is not markdown, so `stripMarkdown` inside
`toSpeakable` (`lib/voice/speakableText.js:297`) will not eat or mangle it before the
parser sees it, and it does not occur in natural speech.

### Leading, not trailing

Leading costs a bounded hold on the first delta. Trailing would cost nothing at all — the
marker would land in the leftover sentence buffer and be stripped at flush — but a caller
who barges in mid-reply cuts the stream before the marker arrives, and the intent is lost
for that turn. Barge-in is common enough (`session.js:1528 onInterrupt`, with a dedicated
`barge_ins` counter) that losing intent on those turns is worse than ~30-60ms.

### One strip point, plus one defensive one

**Primary: the `getReplyStreaming` loop, `services/gemini.js:1141-1241`**, between
`textFromChunk` and `yield { delta }`. `fullText` accumulates stripped text only.

That single seam is why nothing else has to change. Every consumer is downstream of it:

| consumer | inherits the strip via |
|---|---|
| voice | `lib/voice/llmTurn.js` → `session.js` delta loop → `tts.write` |
| eval / benchmarks | `lib/harness/textSession.js` |
| `npm run chat` | same text session |
| history, transcript rows, post-call summary | `reply.text` |

**Defensive: `toSpeakable`** (`lib/voice/speakableText.js:290`) strips a marker appearing
anywhere, not just at the head. This covers a malformed marker, a marker the model emits
mid-reply, and a marker echoed back from history. Belt and braces on the one failure the
caller would actually hear.

### The buffering state machine

New pure module `lib/intentMarker.js`:

```
createMarkerStripper({ allowedIntents }) -> { push(delta), flush() }
```

- `push(delta)` returns `{ text, intent }`. While unresolved it holds text back.
- It releases **immediately** the moment the buffer cannot be a prefix of a marker. A
  reply starting `"Sure, I can"` fails the prefix check on the first character, so the
  common path holds for zero measurable time.
- Hard release caps: the first `\n`, or `MAX_MARKER_CHARS = 64`, whichever comes first.
  Worst case is one short line held.
- Tolerant of decoration the model will occasionally add — markdown wrapping
  (`**<<intent:x>>**`), backticks, leading whitespace. Tolerance lives in the parser and
  never in what gets spoken.

### Validation, and what an unknown value does

The parsed value is checked against `config.allowedTasks` — the same list that populated
the tool's `enum` (`services/gemini.js:128-130`, sourced from
`services/supabase.js:37-49`).

An unrecognised value is **stripped from the text but does not set an intent**, and bumps
a counter. Leaking `<<intent:whatever>>` to a caller is worse than losing one intent
update, so the strip is unconditional and the state change is not.

### Synthetic tool-call event

When a marker resolves, `getReplyStreaming` sets `intentArgs = { intent }` and pushes
`{ name: "set_call_intent", args: { intent } }` onto `toolCallEvents`.

This is what `ctx.toolCalls` in the eval runner is built from (`eval/run.js:164`) and what
`session.js:2178`'s `intent_set` log line reads. It is semantically honest: the model did
explicitly declare the intent, in its own output. Only the transport changed.

Two deliberate non-actions:

- **No `toolResult` is pushed.** `set_call_intent`'s message
  (`"How can I help you with that?"`) is speakable and is used by the zero-text fallback
  at `services/gemini.js:1256-1261`. Pushing it would change what a text-free turn says.
- **No `toolEffect` is yielded.** That event extends the turn deadline by
  `VOICE_LLM_TOOL_GRACE_MS` (4s, `lib/voice/llmTurn.js:100-106`) and would contaminate
  the `llm_first_tool` mark added for measurement.

### Feature flag

`VOICE_INTENT_MARKER`, default **off**. Both paths live simultaneously: off declares
`set_call_intent` and behaves exactly as today; on omits the declaration and uses the
marker. Flip on Railway without a redeploy; revert the same way if a live call sounds
wrong. The tool path and its snapshot set get deleted in a follow-up once it holds in
production.

### Honest cost of the trade

A function call cannot be malformed; text can. This design accepts a class of failure the
tool did not have, and mitigates rather than eliminates it: a forgiving parser, an
allowlist check that degrades a garbled marker to "no intent" rather than "wrong intent",
two independent strip points, and a flag that reverts in seconds.

### Security

The marker is parsed from model output only, never from caller transcript. A caller who
speaks the marker aloud can at worst have it echoed into history; intent gates no tool, so
the blast radius is one wrong line in the next turn's prompt. The allowlist check closes
it regardless.

---

## Measurement

The tool round-trip is currently **invisible at runtime**. `llm_first_chunk` is stamped on
the first *delta* (`session.js:1963`), so the whole first round hides inside
`llm_ttfb_ms`. The `tool:set_call_intent@684` figures above are hand-annotated in the
runbook, not emitted by the code. The ~700ms is an inference from a single run.

So instrumentation ships **first**, on its own, and the baseline is re-measured before any
behaviour changes:

- `mark("llm_first_tool")` on the first `toolEffect` event in the `startTurn` delta loop;
- `llm_tool_ms` = `llm_request` → `llm_first_tool`;
- `llm_reply_after_tool_ms` = `llm_first_tool` → `llm_first_chunk`.

`llm_tool_ms` disappearing from marker-mode turns is the direct proof the round-trip is
gone, rather than an inference from the total moving.

**Targets:** `llm_ttfb_ms` p50 1,836 → ≲1,200. `true_v2v_ms` p50 3,062 → ≲2,400.

---

## Verification gates

- **Unit:** full suite green (baseline 1,261). New `tests/intentMarker.test.js` including
  a delta-split property test — split a fixed marker+reply at every byte offset, assert
  identical emitted text. New leak-corpus test driving ~20 malformed markers through
  `toSpeakable`.
- **Prompt snapshots:** the full (fixture × step × intent) matrix frozen for **both**
  modes. The golden diff is the review artifact that makes this trade explicit — the
  reason those snapshots exist.
- **Eval — the merge gate.** Full suite flag-off and flag-on, judge verdicts diffed
  scenario by scenario. Hard asserts alone would not have caught the previous regression;
  they were green throughout. Merge requires: hard asserts 100% green in both, judge net
  non-negative, and **zero** regression on `name-recall`, `vague-caller`,
  `cancel-identity`.
- **`eval/scenarios/25-intent-switch-midcall.js`** must pass in both modes. Its
  `toolCalledWith` assertion keeps working via the synthetic event — but that makes it
  partly a test of our own parser, so a `finalState.intent` assertion is added, downstream
  of the reducer and independent of the synthesis.
- **Leak sweep:** automated grep for `<<` / `intent:` across every assistant turn in the
  eval results JSON. Zero hits or it does not ship.
- **Live:** probe run before and after; one manual call to the test number covering the
  scenario-25 mid-call switch, listening for a spoken marker.

---

## Out of scope

Test 2 (TTS blind A/B) and the `classifyHold` p95 tail. Both are separate passes. A mixed
change makes a judge regression unattributable, which is precisely what made the previous
attempt unsalvageable.
