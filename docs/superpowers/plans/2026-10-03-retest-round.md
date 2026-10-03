# Re-test round after batch 2, 2026-10-03 (Saturday)

Real calls to check the five batch-2 fixes on the deployed build. **5 calls, ~40 min.** You call from or answer on
your US handset **+1 469 933 8887**; the business line is **+1 817 601 1171** (Digile US test tenant `2083c6a4`).
I send this script in its OWN message and fire nothing until you say **"ready"**.

**Build:** `voice-uk-prod-00100-nzn` @ `c755f56` (Section H [AS RUN] of `2026-09-24-outbound-part1-golive-commands.md`,
deployed 2026-10-03 01:44 CDT). Rollback `voice-uk-prod-00099-lkq`.
`OUTBOUND_ENABLED` stays false; only the test campaigns dial, and only your number.

## When
- **Inbound (R1, R2, R5):** any time.
- **Outbound (R3, R4):** **10:00-16:00 CDT** (the campaign's Saturday window, on your clock).

## Before the first call (me, ~10 min, nothing dials)
1. Production is `00100-nzn` at 100%, `OUTBOUND_ENABLED=false`, 0 ERROR since the deploy. **The smoke call (Section H4)
   comes first** -- R2 below doubles as it if nothing else has called the line since the deploy.
2. **Which campaigns can fire today.** One outreach per contact per campaign per UTC day, and the UTC day 2026-10-03
   began at 19:00 CDT on Friday. Last night's S20 (`c488edd2`, 00:08Z), S22 (`ba18bc95`, 00:30Z) and S24 (`7cb62d32`,
   00:39Z) triggers already used today's key. **Free today: S21 (`d7766147`) and S23 (`09f175e1`)**, both able to book.
   S20/S22/S24 free up again at 19:00 CDT, after the Saturday window. So R3 uses S23 and R4 uses S21.
3. Dry-run `status` for S20-S24 (migrate job) and read `reArmed`. S23 has last night's callback outreach (O3 booked
   a callback for Monday 10:00) and S20 the Gatekeeper's callback. A resume re-arms a parked row, so fire with the
   dry run's numbers in front of us.
4. **Returned-call check.** If any outreach for your number is `waiting`, every inbound call is treated as a returned
   call (`outbound_callback_recognized`) and CLOSES that outreach `called_back`. That is fine for R1/R2/R5, but read
   which row each inbound call closes.
5. Your contact has `last_name` "Dodla" (permanent), so both outbound calls are the **full-name-on-file** case: no
   name or spelling question. The new **first-name-only** rule (no surname ask) is NOT tested by a call today (owner
   decision: unit tests + sabotage row only; no production DB write).

## The calls, in this order

| # | Call | What you say | What should happen | What I read |
|---|---|---|---|---|
| R1 | Inbound: cancel O2's booking (Tue 6 Oct 9 AM) | "I'd like to cancel my strategy call on Tuesday." Answer the read-back with **"Yeah, go on."** At the end say **"That's all, thanks."** | Read-back, cancelled first time. After "That's all, thanks." **no "anything else?"** -- straight to goodbye. | `cancel_appointment_db` success, `end_call_ask_satisfied_by_caller_close` (or no `end_call_refused_no_ask`), `postcall_verify` ok |
| R2 | Inbound: question | "What does Digile Media actually do?" Then **"Okay. That's all, thanks."** | A short answer, then goodbye with **no "anything else?"**. | no `write_*`, no `end_call_refusals.no_ask`, `close_reason` end_call_mark |
| R3 | Outbound: booking with a loose yes (S23) | "Hello?" then "Yes, this is Nithin." Answer its question, agree to a call, **pick a time yourself**. When it reads the time back, answer loosely: **"Yeah, sounds about right then"** or a mumbled **"mm, go on"** (not a clean "yes"). | It reads the time back as a question and does **not** say "booked" before it is. **Booked on that first loose answer**, no second read-back, no "I cannot secure that time". No name/spelling question. | `write_consent_probe` `agreed_after_readback` true (if the transcript mangled it) or `agreed_now` true, no `write_order_refused` after the read-back, `write_order_released_unreadable_after_readback` 0 or 1, `outbound_name_from_file`, booked row |
| R4 | Outbound: Hold (S21) | "Reception?" then **"Hold on, I'll get him."** Then 20 s of silence or music, then "Hi, it's Nithin." Then **"Sorry, can't talk now, call me Monday."** | Only **"Sure, thank you."** then silence -- **nothing else said** (no "no speech", no second intro to the receptionist). Intro again after the hold. A Monday callback. | `outbound_hold_ack_audio` (`pre_tool_chunks`, `post_tool_chunks`, `played`, `reason`), `outbound_hold_entered`/`released`, `outbound_hold_intro_prompted` |
| R5 | Inbound: reschedule R3's booking, then cancel | "Can I move my call to another day?" Pick a time. When it reads it back, say **"Sorry, can you say the time again?"** Then **"Yes."** Then: "Actually, please just cancel it." "Yes." "That's all, thanks." | Repeats the time (4c not fixed: it may say it as a statement and ask again -- one extra turn is the known cost), moves it on your yes, then cancels. Goodbye with no extra "anything else?". | `reschedule_appointment_db` then `cancel_appointment_db` success, `write_order_refused` count, `postcall_verify` ok |

**On every call I also record** (owner decision 2026-10-02, no code): `outbound_first_reply.from_speech_end_ms` on the
outbound calls (> 2,000 ms on 2 of 5 on 10-02 -> attempt marked silent; Sunday decision if most re-test calls are
slow), `live_greeting_respoken` / `live_repeat_cut` counts, and **after each call I ask you whether anything sounded
doubled**.

How I fire each outbound call: `status active` (dry run, then `--confirm`), `r1-fire.sh <NN>`, pause right after.

## Afterwards (me, ~10 min)
- Cleanup: R1 cancels O2's booking; R5 cancels R3's. Pause S20-S24. Confirm no booking is left on the test tenant.
- One table: call, PASS/FAIL, first-reply ms, doubled audio (your answer), anything odd. Any FAIL is a Sunday
  must-fix or a parked item.

Logs: `bash .superpowers/sdd/2026-09-24-outbound-part1/r1-read.sh <since-UTC>` per call, plus a by-callSid query for
`write_*`, `end_call*`, `outbound_*`.
