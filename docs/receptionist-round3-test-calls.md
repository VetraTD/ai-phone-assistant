# Round 3 — live test calls

Everything below is verified offline (1832 unit tests, 3 new eval scenarios, the
cutoff sim). None of it has answered a phone. These are the calls that decide
whether it ships.

Dial the staging test number used in the previous rounds — **+1 817 601 1171**,
on Twilio account B, the account whose token GCP does NOT hold. A number from
the other account 403s on every call. Do **not** dial +1 817 632 6969.

Confirm the number against Twilio before the first call; this one is carried
from earlier sessions, not from anything in the repo.

## Before the first call — two Railway settings

| Variable | Set to | Why |
|---|---|---|
| `VOICE_SPELL_POLICY` | leave **unset** (= `always`) | This is the new default and the thing being tested. Set it to `hard` only if call 3 annoys you. |
| `VOICE_HOLD_TRAILING_MS` | **800** | Round 2's headline fix ships at 0 and does nothing unless set. Confirm it survived. |
| `VOICE_INTENT_MARKER` | **true** | Worth ~900ms. Confirm on the service Railway actually deploys, not the other one. |

Check the deploy is the commit you think it is: **`curl https://<staging-host>/`**
prints `Build: <sha> (<branch>)`. Railway redeploys the CURRENT commit whenever an
env var changes, so "deployed 2 minutes ago" is not evidence your fix is live.

---

## Call 1 — a day with no time (the headline fix)

> "Hi, I'd like to book an appointment for next Wednesday."

Then **say nothing about a time** until you are offered one. If it asks an open
"what time works for you?", answer *"whenever you've got something — what have
you got?"*

**Pass:** it offers 2-3 specific times spread across the day ("I have 9, 1
o'clock or half past 4"), and asks which you want.
**Fail:** it names one time and asks you to confirm it. That is the reported bug.
**Also fail:** it asks "morning or afternoon?" first — the step order was
changed so the day case fires immediately.

## Call 2 — a normal booking, new caller (spelling)

> "Hi, can I book for Tuesday at 2pm? … It's Nithin Jayakumar Dharmaraj."

**Pass:** it asks you to spell the name **exactly once**, then books.
**Fail:** it asks twice, or asks for the name again after you gave it, or asks
you to spell something after you already spelled it.
**Expected and OK:** the spelling ask may come late — after you say "yes, book
it" — because the gate sits in front of the write. One extra turn. If that reads
badly to you, `VOICE_SPELL_POLICY=hard` reverts to only unusual names.

Afterwards **check the dashboard row** — the point of the whole change is that
the stored spelling is right.

## Call 3 — the same caller again (must NOT ask)

Call back from the same handset.

> "Hi, it's Nithin again — can I book another one for Thursday morning?"

**Pass:** it does **not** ask you to spell anything. Your name is on file; the
record is the spelling.
**Fail:** any spelling question at all.
**Also fail:** it reads your stored name back at you and asks you to confirm it —
that is disclosing before verifying, and a separate rule forbids it.

## Call 4 — a clean hang-up (the leak and the double goodbye)

> "Hi, what are your opening hours?" … "Great, that's all I needed." … "No,
> nothing else, thanks. Bye!"

**Pass:** one goodbye. Nothing machine-shaped, at any point.
**Fail:** you hear anything with braces, a word like `reason:`, `default_api`, a
tool name read aloud, or a flat/robotic-sounding fragment before the real reply.
**Fail:** the sign-off is said twice, in slightly different words.

This is also the call that should feel **faster to end** — a whole model
round-trip was removed after `end_call`.

## Call 5 — a slow tool (the hold line)

> "Hi, can I move my appointment? … Actually, what have you got on Friday?"

**Listen for the wording during the pause.** It should now match what it is
doing — "let me check the diary for you" for an availability check, "let me pull
that up" for a lookup — not a generic "one moment" for everything.

**Fail:** you hear the hold line **and** the model saying "one moment" too. That
doubling was fixed in round 2 and the prompt line that caused it was deleted in
this round; hearing it again is a regression.

## Call 6 — interrupt it (regression guard)

Book something, and **talk over the assistant mid-sentence**. Also pause
mid-thought — "I'd like to book, uh… …a cleaning."

**Pass:** it stops when you interrupt, and it waits when you pause mid-thought.
Nothing here changed, which is the point: the turn-taking subsystem has caused
two production incidents and this round touched the turn loop.

---

## After the calls

Read the counters (`GET /api/debug/latency`, needs `DEBUG_ENDPOINTS=true` and
`DEBUG_TOKEN`). New this round:

- `llm_tool_call_ms` / `tool_exec_ms` — splits "the model deciding to call a
  tool" from "the tool running". These are what turn "it takes 4-5 seconds" into
  something fixable. **Report both p50 and p95.**
- `text_channel_reask_text_suppressed` — non-zero means the doubled-goodbye
  path fired and was caught. Good, not bad.
- `internal_term_leaks` — must stay 0.
- Per-tool `tool_duration` lines are in the logs, keyed by tool name.

Nothing about the pause gets tuned until those numbers exist. That is
deliberate: every previous attempt to tune it by guessing was reverted.
