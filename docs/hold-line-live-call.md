# Hold lines — the call that settles it

Branch `fix/hold-line-accuracy-2026-08-31`. Two commits, 2008 tests green,
`sim:cutoff` deterministic across two runs.

**None of that can hear what a caller hears.** That is exactly how the previous
two attempts at this shipped "verified" while the bug was still on the line, so
the offline result is a precondition here, not a verdict.

---

## Before dialling

| Env var | Expected | If it is set anyway |
|---|---|---|
| `VOICE_TOOL_HOLD_DELAY_MS` | **unset** (→ 0), or an explicit `0` | any other value reverts the timing half |
| `VOICE_ENGINE_FILLER` | unset or `true` | `false` means no engine line at all |
| `VOICE_PROMISE_GATE_MS` | unset (→ 350) | 0 restores the model's own wait lines |
| `VOICE_PROMISE_SWAP_DELAY_MS` | unset (→ 400) | |

**Staging was found carrying an explicit `VOICE_TOOL_HOLD_DELAY_MS=0`,** which
means it never ran the 1500ms threshold the code defaulted to and the timing
change is a no-op there. Removing the var is worth doing so the environment
stops diverging from the code, but it changes nothing on this call.

That matters for what to expect below, and it is the round-4 lesson arriving
from the other direction: a code default is not what an environment does, and
the check goes BOTH ways — a stale value can hide a fix, and it can equally
mean the fix was never the thing that mattered.

---

## The call

Book an appointment. Run it to a real booking: name, spelling, confirmation.

**What you should hear, turn by turn:**

| Turn | Tool | Line |
|---|---|---|
| "Tuesday at 2?" | `check_appointment_availability` | "One sec, checking the calendar." |
| "And your name?" → "Nithin" | none | *nothing* — the reply just arrives |
| if it asks you to spell it | `book_appointment`, refused | *nothing* |
| after you spell it | `book_appointment` | "Getting that scheduled now." |
| "Yes, book it" | `book_appointment` | "Getting that scheduled now." |
| "Take a message instead" | `record_customer_request` | *nothing* — a fast write |

**The name turn losing its line is the fix, not a regression.** There is no
name-capture tool: the name is an argument of `book_appointment`, never its own
call. A line was only ever heard there because the model was redundantly
re-checking the calendar.

Two failures to listen for specifically:

1. **"Checking the calendar" after you give your name.** The re-check gate did
   not hold. Read the `check_appointment_availability` count for the call — it
   should be one per agreed time, not three.
2. **A booking announced twice in different words** ("Getting that scheduled
   now." … "Putting that on the calendar."). The refused-tool suppression did
   not hold; the variant counter advanced on a booking that never happened.

---

## Then read the numbers

All new. None of this existed before today.

- **`hold_line_ms`** — the stopwatch number, from the true end of your speech to
  the line reaching you. Reported at ~3s.

  **Do not expect this to have moved.** Staging already ran delay 0, so the
  three seconds were never the tool-hold threshold, and nothing in this branch
  addresses what they actually were. This is now a MEASUREMENT, not a claim:

  ```
  ~700ms   Deepgram endpointing + inference     (not ours)
  0-800ms  classifyHold                          (deliberately untouched)
     X     Gemini round 1: decide + run the tool (the unknown)
  ~100ms   playout
  ```

  For the stopwatch to read 3s, X has to be around 1.5s. Read `llm_tool_call_ms`
  and `tool_exec_ms` on the same turn to split it: the model deciding versus the
  tool running. `tool_exec_ms` was measured at p50 ZERO on 2026-08-30, so the
  expectation is that nearly all of X is the model. If that holds, the next
  lever is the round-trip itself — backlog L1's `VOICE_INTENT_MARKER`, worth
  ~900ms and still unconfirmed on this environment — not the hold line at all.
- **`hold_line_played`** — `{ kind, text, tool, trigger }` per line. `kind` must
  match `tool`. `trigger` should be `tool` on booking turns; `slow` or `stalled`
  there means a watchdog covered it instead, which is a different problem.
- **`hold_line_suppressed`** — non-zero means the refusal/cache suppression
  fired. Zero on a call where you were asked to spell your name means it did not.
- **`hold_line_promise_swapped` / `_kept`** — swapped high and flat still means
  the prompt half is not holding and the code gate is carrying the fix alone.

## The one thing to judge by ear

At delay 0 a fast turn now carries a line it previously did not. That was an
accepted cost, not an oversight — but it was accepted on paper. If the call
reads as chatty, the number to move is `VOICE_TOOL_HOLD_DELAY_MS`, and unlike
every previous time it moved, there is now a measurement to move it from.
Try 300-400 before anything larger.
