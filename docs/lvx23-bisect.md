# LVX23 — is it the tools, or is it the prompt?

**Written 2026-09-03, before any call was made. The predictions in section 4
are pre-registered and are not to be edited afterwards** — the convention
`scripts/probes/verdicts*.json` and `scripts/spike/VERDICT.md` set, and the
reason those rounds are worth anything.

---

## 1. The question

The owner, unprompted:

> "When I first got gemini live it was working beautifully. Now it seems like
> it is having issues once connected to everything."

The spike had **no tools and a ten-line prompt**, and the recorded verdict was
"it sounds amazing". The current configuration gives the same model **ten tools
and a ~17,000-character system prompt**, and the fourth live call produced three
`book_appointment` calls with different arguments, a `cancel_appointment_db`, a
`get_caller_appointments_from_db`, a mid-booking `end_call`, and audible
confusion.

Nothing in the commits between those two states obviously explains it, and the
call *before* the bad one ran near-identical code and was acceptable. So the
honest hypothesis is the production surface itself rather than a specific bug —
and if that is true it undercuts the premise of the architecture, because the
reason to choose speech-to-speech was measured behaviour on a bare harness.

**This is a bisect, not a redesign.** The prompt is SHARED with the cascade,
which runs it acceptably, so here it is the control and not the variable. Most
of its 5,445-character GUARDRAILS block is scar tissue from specific past
failures. Nothing in it gets rewritten on the strength of a hypothesis.

## 2. The arms

| arm | prompt | tools | knobs |
|---|---|---|---|
| 0 | full | all ten | *(none — production defaults)* |
| 1 | full | none | `LIVE_TOOLS=none` |
| 2 | minimal | all ten | `LIVE_PROMPT=minimal` |

**Arm 0 is the point.** Without a control on the same handset, in the same
sitting, the other two measure nothing: the bad behaviour is not reliably
reproducible, so "arm 1 sounded fine" is worthless unless arm 0 sounded bad on
the same afternoon.

**Two calls per arm.** This repository has already had an N=1 probe return
opposite verdicts on consecutive runs. One call per arm is not a measurement.

**Interleave the order — 0, 1, 2, 0, 1, 2** — so drift across the sitting
(network, load, the owner's own patience) does not land entirely on one arm.

Everything else is held fixed: `LIVE_TURN_END=vendor` (the incumbent), the same
handset, the same tenant, the same script.

The minimal prompt is `lib/voice/live/minimalPrompt.js`. It is deliberately
**not** the spike's, which said the assistant had no tools and that "someone
will confirm" — wording that alone suppressed phone-number read-back (LVX4).
Reproducing it would build a known defect into the instrument. It keeps one
guardrail, "never say a tool name aloud", so this arm is not made more likely
than its comparators to leak on a real caller.

## 3. The script — read the same lines on every call

Deviating per call is what makes six calls incomparable. Read these, in order,
and let the assistant lead in between.

1. "Hi, I'd like to book an appointment."
2. *(answer whatever it asks about your enquiry, briefly and consistently)*
3. "My name is Marcus Bell."
4. "My mobile is 07700 900123."
5. "Can you do Thursday afternoon?"
6. **"Actually, make it Friday morning instead."** ← the flow-confusion probe;
   the bad call went wrong around a change of mind mid-booking
7. "Can you read that number back to me?"
8. "That's everything, thanks."

**Arm 1 cannot complete a booking** — it has no tools. That is expected and is
not a failure of arm 1. Score arm 1 on coherence only, and do not compare its
booking outcome against anything.

## 4. Pre-registered predictions

Scored pass/fail after all six calls, never before.

| # | prediction | confidence |
|---|---|---|
| P1 | Arm 0 shows audible confusion on **at least one** of its two calls | 50% |
| P2 | Arm 1 shows no confusion and no repeated questions on **both** calls | 70% |
| P3 | Arm 2 shows no confusion and no repeated questions on **both** calls | 40% |
| P4 | `live_outbound_leaks` is 0 across all six calls | 65% |
| P5 | If any leak fires, `live_outbound_cuts` exceeds `live_outbound_cut_missed` — the transcript arrives in time to cut | 50% |
| P6 | Every call ends with `close_reason` of `end_call_mark` or `twilio_stop`, never `end_call_fallback_timeout` | 80% |
| P7 | No call makes more than one `book_appointment` call with different arguments | 55% |

P5 is the one with no prior at all. Nobody has measured whether
`outputAudioTranscription` arrives while the audio it describes is still queued,
and the whole LVX21 guard rests on it.

## 5. Decision rule — agreed before the data exists

| outcome | reading |
|---|---|
| arm 1 clean, arm 2 confused | the **tools** are the fault. Look at declaration count, tool descriptions, the guards' refusal responses |
| arm 1 confused, arm 2 clean | the **prompt** is the fault. Only now is a prompt change earned, and it must be an eval-banded one because the cascade shares it |
| both clean, arm 0 confused | neither alone — the **interaction**, or the volume of both together |
| all three confused | **not the surface.** Look at the step machine, the reducer, the per-turn notes, the turn-end arm |
| all three clean | **the round is VOID.** The fault is intermittent and six calls did not catch it. Do not conclude that it is fixed |

The last row is the one to hold to. A quiet afternoon is not evidence.

## 6. Running it

Setup, per `docs/live-frontend-RESTORE.md` — §4 for the local rig, §3 for the
number, §5 for the environment traps:

```bash
npm run db:up
export DATABASE_URL="postgres://vetra:vetra_local_dev@localhost:55432/vetra"
node scripts/migrate.js
# import Digile Media's config from Supabase (config only) -- RESTORE.md §4
export LIVE_BUSINESS_PHONE=+441372656055
export MEDIA_STREAM_SECRET=<explicit, not derived>
export LIVE_TURN_END=vendor
cloudflared tunnel --url http://localhost:3000     # ngrok cannot auth on this machine
```

Then per arm, restarting the server between arms:

```bash
# arm 0
node server.js
# arm 1
LIVE_TOOLS=none node server.js
# arm 2
LIVE_PROMPT=minimal node server.js
```

Point `+18176011171` at the tunnel's `/twilio/live-voice`, **after** confirming
its captured state in RESTORE.md §3. Put it back afterwards and verify by
reading it back from Twilio — it is `ASSISTANT_NUMBER` in `.env` and leaving it
repointed silently breaks `npm run probe`.

## 7. Score sheet

Fill one row per call, from the caller's ear and from `live_call_summary`.

| # | arm | confused? | repeated a question? | spontaneous end_call? | book_appointment calls | leaks / cuts / missed | close_reason | felt latency |
|---|---|---|---|---|---|---|---|---|
| 1 | 0 | | | | | | | |
| 2 | 1 | | | | | | | |
| 3 | 2 | | | | | | | |
| 4 | 0 | | | | | | | |
| 5 | 1 | | | | | | | |
| 6 | 2 | | | | | | | |

## 8. Cost

Six calls of roughly three minutes: **~$0.85 Gemini + ~$0.18 Twilio ≈ $1.03**,
at the measured Live rate of ~$0.136 per three-minute call. Approved by the
owner on 2026-09-02 before the arms were built.
