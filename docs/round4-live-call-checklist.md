# Round 4 live call — what to say, and what to read afterwards

Four changes shipped on `fix/receptionist-round4-2026-08-31`. Two of them
(greeting, hold lines) **cannot be verified any other way** — no test and no
simulator can hear what the caller hears.

Make the call, then read the log lines named below. The point of writing them
down now is that "it sounded fine" is not a result, and neither is "it sounded
off" without a number beside it.

---

## Before dialling

Confirm on the deployed environment, or the call proves nothing:

| Env var | Expected | Why it matters |
|---|---|---|
| `VOICE_GREETING_PREROLL_MS` | unset (→500) | the greeting fix |
| `VOICE_PROMISE_GATE_MS` | unset (→350) | the hold-line fix |
| `VOICE_HOLD_TRAILING_MS` | unset (→800) | now ON by default; was 0 |
| `VOICE_SPELL_MISS_CAP` | unset (→2) | the spelling escape hatch |
| `VOICE_SEMANTIC_ENDPOINT` | unset or `false` | must stay OFF; costs money per turn |
| `VOICE_INTENT_MARKER` | check it | backlog L1 — unconfirmed on that env, worth ~900ms |

**None of the first four should be SET at all.** Every fix in this round is a
changed default, so an environment still carrying an old explicit value
silently reverts that fix and the call reads as "it did not work". The two that
matter most: `VOICE_HOLD_TRAILING_MS=0` reverts the turn-taking fix outright,
and `VOICE_SPELL_ASK_CAP=1` restores the old cap that let a caller who ignored
the question have their mis-heard name written down.

An env that carries an old explicit value for any of the first four silently
reverts that fix, and the call will read as "it didn't work".

---

## Test 1 — the greeting (item 2)

**Say nothing.** Let the greeting play from the first ring.

- **Listening for:** the business name. The reported symptom is the first few
  words missing, and the default greeting opens
  `"Good <morning/afternoon/evening>, thanks for calling <Business>."` — so if
  the name is intact, the front of the line survived.
- **Then read:** `greeting_audio_timing` (one line per call).
  - `firstWireMs` — pickup to the first audio frame on the socket.
  - `ttsFirstByteMs` — pickup to ElevenLabs' first real byte.
  - **The verdict:** if `ttsFirstByteMs` is reliably LARGER than `prerollMs`
    (500), the pre-roll finished before the speech began, it covered nothing,
    and it should be reduced or removed. If it is smaller, the pad is doing
    the work it was added for.
- **If the greeting is still clipped:** the cause is not what the pre-roll
  addresses. Do not raise the number — that is guessing twice. The next
  suspects are Twilio's own answer timing and the carrier, neither of which
  this repo controls.

## Test 2 — the hold lines (item 3)

Book an appointment. Let it run to a real booking.

- **Listening for:** the wait line matching the action. Booking should say
  *"Getting that scheduled now"* / *"Putting that on the calendar"* — NOT
  *"Let me check the calendar"*, which is the availability line and the
  reported bug.
- **Then read the counters:**
  - `hold_line_promise_swapped` — the code gate caught a wrong line and
    replaced it.
  - `hold_line_promise_kept` — a promise was spoken as the model wrote it.
- **How to read them:** swapped > 0 means the gate is earning its place AND
  the prompt half is not holding on its own. Both at zero means the model
  stopped volunteering wait lines entirely, which is the prompt working and the
  best outcome. **Swapped high and flat across several calls is the signal to
  strengthen the prompt rather than lean on the gate.**

## Test 3 — spelling (item 1)

Three separate calls; the whole change is about telling them apart.

1. **Spell it.** Give a name, and when asked, spell it. Expect: asked once,
   accepted, booked. Check the database row matches the letters.
2. **Refuse.** Give a name, and when asked say *"no, it's spelled how it
   sounds"*. Expect: accepted immediately, no second ask, booking completes.
3. **Ignore it.** Give a name, and when asked, ask about parking instead. Then
   ignore it once more. Expect: **it asks twice, then stops and books anyway.**
   This is the escape hatch, and a call that gets stuck here is the one
   regression that would be worse than the original bug.

Also worth doing once: **give a name, then correct it with a spelling that
disagrees** ("It's Nathan" … "actually, N-I-T-H-I-N"). The stored row must say
Nithin. That is the 2026-08-31 staging failure, and it now has an eval scenario
but has never been heard on a real call.

## Test 3b — the spelling correction that has never been heard live

Give a name, then correct it with a spelling that DISAGREES with it:
"My name is Nathan" ... "actually, N-I-T-H-I-N".

The stored row must say Nithin. This is the 2026-08-31 staging failure, and the
eval now covers it — in every run that reached a booking the letters won — but
only 2 of 4 runs booked at all, because a scripted caller cannot adapt. So the
behaviour is evidenced and the SCENARIO is not yet trustworthy. A live call is
what settles it.

## Test 4 — turn-taking (item 4, free half)

**Pause mid-sentence, deliberately.** *"I'd like to book…"* — stop for about a
second — *"…an appointment for Tuesday."*

- **Listening for:** it waits, rather than answering the fragment.
- **Then read:** `hold_rule` attribution for `trailing_incomplete`. Non-zero is
  the rule firing on a real call for the first time; it defaulted to 0 and had
  never run in production.
- **The cost side:** speak one whole fluent sentence too. It must feel no
  slower than before. The rule sits above the punctuation branch and should
  never match a complete turn — if fluent speech feels laggier, that assumption
  is wrong on real transcripts and the number comes back down.

---

## Reading it afterwards

`context_wait_ms` is new and worth a look on any call that felt slow to start:
it is the first turn's wait on the call-start prefetch, which until now was
being reported as STT tail. And `lookup_tool_context_warm` / `_cold` answer the
caller-dossier question (backlog L3b) — if warm is rare, that whole subsystem
can be closed rather than built.
