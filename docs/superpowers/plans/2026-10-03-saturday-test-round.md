# Saturday test round, 2026-10-03

Real calls on the deployed build before Sunday night's freeze and Monday's scoping call. **9 calls, ~60-75 min.**
You call from or answer on your US handset **+1 469 933 8887**; the business line is **+1 817 601 1171** (Digile US
test tenant `2083c6a4`). I fire each outbound call and read the logs after each one, within about 5 minutes.

**Build:** `voice-uk-prod-00099-lkq` @ `b772acb` (Section G of `2026-09-24-outbound-part1-golive-commands.md`, deployed 2026-10-02).
`OUTBOUND_ENABLED` stays false. Only campaigns S20-S24 dial, and only to your number.

## When
- **Inbound (I1-I4):** any time.
- **Outbound (O1-O4) and I5:** **10:00-16:00 CDT** only. The campaign's Saturday calling window is 10:00-16:00 in
  the contact's time zone, which is narrower than the 08:00-20:00 legal floor. A trigger outside that window just waits.

## Before the first call (me, ~10 min, nothing dials)
1. Confirm production is `00099-lkq` at 100% and `OUTBOUND_ENABLED=false`.
2. Dry-run `status` for S20-S24 (migrate job) and read each campaign's state and `reArmed`. S23's "parked row" was
   most likely closed `called_back` by the 10-02 cancel call (CAffb5c7, 16:27Z). S20's waiting outreach b9d70e34 was
   closed `called_back` by the G4 smoke call (21:10Z). Confirm both, don't assume them; O4 needs a fresh trigger.
3. Confirm **no outreach is `waiting`** for your number. Otherwise every inbound call is treated as a "returned call",
   and I1-I4 would test the wrong thing.
4. Your contact record has a first name only, which is what O1 needs. O2 adds `--last-name Dodla`, and that can't be
   undone by a later trigger, so **O1 must run before O2**.

## The calls, in this order

| # | Call | What you say | What should happen | What I read |
|---|---|---|---|---|
| I1 | Inbound: book | "Hi, I'd like to book a discovery call." Give your name, spell it when asked (inbound still asks), pick a weekday slot. When it reads the time back, answer just **"Yeah."** | One read-back, then booked. One "anything else?", then goodbye. | `write_consent_probe` (readback_now + agreed_now true), no `write_order_refused` after the read-back, `consent_agreement_recorded`, `postcall_verify` ok, 1 booked row |
| I2 | Inbound: reschedule | "Can I move my discovery call to another day?" Pick a slot. Answer the read-back with just **"Mm-hm."** | The booking moves. "Mm-hm" counts as a yes (new rule). | `reschedule_appointment_db` success, `agreed_now` true on the read-back turn, `changed_rows` 1 |
| I3 | Inbound: question | "What does Digile Media actually do?" then "Okay, thanks, that's all." | A short answer, no tool writes, clean goodbye. | no `write_*`, `close_reason` end_call_mark, 0 ERROR |
| I4 | Inbound: wrong number | "Is this Tony's Pizza?" | Says who it is, offers help, ends politely. No message taken. | no `customer_request`, no write, end_call |
| O3 | Outbound: Gatekeeper (S23) | Answer "Reception." When asked for Nithin: **"He's not in, can you call back at three?"** | No reason given, nothing confirmed, nothing offered. Callback task at 15:00 CDT. The outreach stays waiting. | no `outbound_identity_confirmed` true, callback task row, outreach `waiting` |
| I5 | Inbound: cancel (the Problem 2 check) | Right after O3: "I want to cancel my discovery call." Answer the read-back with **"Yes."** | Recognised as a returned call, and **no clinic or campaign question**. Read-back, then cancelled. | `outbound_callback_recognized`, **`outbound_callback_questions_suppressed`**, no `record_answer`, `cancel_appointment_db` success, `postcall_verify` ok |
| O1 | Outbound: Hold + surname only (S24) | "Reception?" then "Hold on, I'll get him." Then 20 s of silence or music, then "Hi, it's Nithin." Agree to a discovery call, pick a time, **spell only the surname when asked**: "D-O-D-L-A". "Yes" to the read-back. | Only "Sure, thank you." on hold. Intro again after the hold. Asks for the **surname only**, never the first name. Booked as "Nithin Dodla". | `outbound_hold_*`, `outbound_hold_intro_prompted`, **`outbound_surname_spell_asked`**, `spelling_gate_refusals` 1, booked row `client_name` |
| O2 | Outbound: Hello + full name on file (S22, triggered with `--last-name Dodla`) | "Hello?" then "Yes, this is Nithin." Answer its question, agree to book, pick a time. Answer the read-back with **"Yep."** | **No name or spelling question at all.** Booked as "Nithin Dodla". | **`outbound_name_from_file`**, no `spelling_gate_refusals`, booked row `client_name` = "Nithin Dodla" |
| O4 | Outbound: no answer / voicemail (S20 or S21, whichever dry-run shows is fresh) | **Don't answer.** Let it ring out to voicemail. | AMD machine verdict, voicemail left (attempt 1), retry scheduled. I pause the campaign straight away so it doesn't redial. | `outbound_amd*`, voicemail played, outreach `next_attempt_at`, then `paused` |

How I fire each outbound call: `status active` (dry run, then `--confirm`), `r1-fire.sh <NN>`, then pause right after.
O2 uses r1-fire's trigger with `--last-name,Dodla` added after `--first-name,Nithin`. That needs the Section G migrate
image, which is the first image with `--last-name`.

## Afterwards (me, ~15 min)
- Cleanup: cancel the O1/O2 bookings (dashboard, or one inbound "cancel" call each) and pause S20-S24.
- One table: call, PASS/FAIL, first-reply ms, anything odd. Any FAIL becomes a Sunday must-fix (or a parked item if
  it isn't a demo risk).
- You can't force a mangled "yes" ("Ja.", "bien"). If one happens naturally, `agreed_now` should now read true on
  that turn.

Logs: `bash .superpowers/sdd/2026-09-24-outbound-part1/r1-read.sh <since-UTC>` per call, plus a by-callSid query for
`write_*`, `spelling_*`, `outbound_*`.
