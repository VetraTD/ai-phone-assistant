# Outbound Part 1: live round 1, day 1 (2026-09-26, America/Chicago evening)

Production `voice-uk-prod-00094-87t` (image `96e356b`), `OUTBOUND_ENABLED=false`, allow-list `+14699338887` (the owner's US handset). Caller ID `+18176011171` (Twilio account B) on tenant `2083c6a4…` ("Digile Media", America/Chicago). Model `gemini-3.8-live`, voice Kore, en-US.

Setup:
- There was one campaign per scenario (`R1-S01` … `R1-S11`, plus `R1-S01b` and `R1-S05b`), all from the `speed_to_lead` template. Each used caller ID +18176011171 and a calling window of 08:00–21:00 every day. S08 had `transfer.to` set to the handset.
- Each campaign was paused straight after its call. **All 14 campaigns are paused now.**
- Trigger: `outbound-admin trigger --consent-manual`, then the sweep was forced about 2 min later.

**Spend:** P1-LIVE-R1 $0.3410 (9 outbound calls + 19 clip renders + 1 test inbound call, priced from logged usage). P1-DEPLOY $0.00244. P1 total $0.7133 of $10. Twilio minutes are extra, about $0.03 per call.

## Results, per call, in the unit a caller feels

| # | Scenario | What the owner heard | Verdict |
|---|---|---|---|
| 13 | Ordinary inbound call (verify, 21:03Z) | Normal greeting, one question, goodbye. 56 s, `direction:"inbound"`, row completed with summary and transcript | **PASS** |
| 3 | Answers and says nothing (call 1, S01: the owner waited, then said hello) | The opener "Hi, is that Nithin? It's Ava, an AI assistant from Digile Media." played **2.09 s** after pickup. Live then continued, but re-asked "I'm calling for Nithin, are you available to speak?" It asked for the owner's "best contact number" and asked the company name three times | **PARTIAL.** The backstop works, but its playout at 2,089 ms is over the 2,000 ms limb, so the call was flagged `outbound_silent_call` (T1). It re-asked identity after the clip |
| 1 | Answers "Hello?" first (call 1b, S01b) | Hello onset at 1.68 s. Live had not replied 1.6 s later, so the stored opener played at 1.68 s from speech (G2 limb met). Live's own late reply then followed **immediately after the clip**: "Hello, are you Nithin? I'm sorry, I seem to have the wrong person…", **while the owner was saying "it's me"** | **FAIL.** `path=live_reply` was never reached. The call was double-talked, and the outcome was recorded as `wrong_person` (D1, D4) |
| 2 | "This is Nithin, how can I help?" (S02; the owner spoke during the opener while switching to speaker) | The opener played at 2.11 s. Live, 1.8 s after the owner stopped: "Thanks for speaking with me, Nithin. I'm calling to see if you have time for a quick strategy call about your clinic systems." Then it asked twice for his name to be spelled | **PASS** on content (name used, reason given, no re-introduction). Spelling loop (D5). Silent flag (T1) |
| 12 | Rings back | Normal inbound greeting. It offered to take details "so someone can reach out and clarify why we called". Logged as inbound and completed | **PASS** (recognition is stage 3) |
| 4 | Lets it go to voicemail | Rang 29 s. AMD detected `machine_end_beep` 11 s into the greeting. Voicemail `result=left`, retry scheduled. The owner confirmed the message was complete and started after the beep | **PASS** |
| 5 | Doesn't answer (S05b: `voicemail_on [5]`, so attempt 1 rings 25 s) | Rang about 25 s, then stopped. `answered=false`, retry scheduled, not `not_interested` | **PASS** |
| 6 | Declines | The carrier forwarded to voicemail. The beep was detected and the voicemail was left, retry scheduled | **PASS** (voicemail branch) |
| 7 | Hangs up during the first line | The opener played at 2.09 s, and the owner hung up 1.5 s into it. Post-call ran once | **PARTIAL.** Post-call ran once (pass), but the call was flagged silent. The cause is T1 (2,093 ms), not the hang-up |
| 8 | Asks for a human | Identity asked twice after the clip. The reply was transcribed as non-Latin script. Then contact number and spelling were asked. "Can I speak to a real person, please?" got "Of course… One moment while I connect you." The transfer rang the handset (call waiting), which the owner ignored. After about 25 s: **a robotic Twilio voice, "…call you back", then the line ended** | **PASS** on mechanics (transfer, unanswered branch, outcome `callback_requested`). **FAIL** on voice (D6) |
| 10 | Gatekeeper "Reception, who's calling?" | "I'm following up on an enquiry **Nithin made regarding marketing systems**" (said twice). "I'm not able to share specific details — could you please put Nithin on the line?" On "Let me put you through": "Thank you, I will wait." On "call back another time": agreed, then "Is there anything else I can help you with today?" | **MOSTLY PASS.** It over-disclosed, and the topic was wrong: the campaign says "clinic systems" (D8). Inbound closing phrase (D7). Silent flag (T1) |
| 11 | "He's not here, I'm his son" | "Thank you for letting me know. I will call back another time. Is there anything else I can assist you with today?" On "What is this about?": "I'll make sure to call back another time." Then it ended. `callback_requested` | **PASS** (shared nothing, asked the son nothing). D7 phrase |
| 9 | "Stop calling me" | **Not run.** The owner's "ready" came at 00:54 local. The gate refused with `outside_window` (the calling window was **verified live**), and the campaign was paused before the morning re-dial | Next session, then `unsuppress` with the owner's YES |

## Measurements (carry items 14-16 and the hello timing)

**Hello onset** (human, measured by `from_answer_ms − from_speech_ms`):
- Detected before 2.0 s on 3 calls: **1,675 / 1,536 / 1,179 ms**.
- Not detected before 2.0 s on 4 calls (owner silent, slow, or switching to speaker).
- Voicemail greetings started at 978 and 1,160 ms.
- Earlier spike measurements: 1.87 s and 2.2 s.

**First audio:**
- **`path=live_reply` occurred 0 times.** When a hello was heard, the slow-Live safety net fired every time, at 1,679 / 1,690 / 1,708 ms from speech (1.6 s plus about 90 ms playout).
- Live's replies came **1.5–1.9 s after the caller stopped** (p50 across calls), and 6.9 s once when it called `confirm_identity` first.
- So with today's latency, Live cannot beat a 1.6 s net measured from onset. The two-limb design is met by the clip, and Live's reply then lands right after the clip. That is the D1 double-talk.

**Silence backstop:** playout at 2,089 / 2,111 / 2,093 / 2,095 ms after pickup, so **4 of 4 silent-path calls were flagged `outbound_silent_call`** (T1).
- Owner decision O-28: tune after the round, from these timings. The earlier guess was about 1.8 s.

**Clip render latency (O-25):**
- Opener rendered 5.0–6.3 s after the dial; voicemail clip 11.3 s after.
- Dial to answer: 8.1 / 8.5 / 8.9 / 10.0 / 11.3 / 11.4 / 11.8 s for humans; 13.8 / 29.2 s for voicemail.
- **The clip was stored at answer on 9 of 9 answered calls.** Nobody answered faster than 8.1 s, so the "no clip → prompt path" risk did not occur. It stays a risk for fast answerers.

**Session start (b5):** `lookup_ms` 27–46, `context_ms` 17–121, `connect_ms` 23–39. This is far below 1.5 s, so a cold DB never talked over a hello.

**Post-call vs call end (M4, cpu_idle):**
- `outbound_attempt_result` arrived +1.1 to +2.1 s after the session ended on normal calls.
- It arrived +11 to +14 s on voicemail and gatekeeper calls, where it waits for the status callback.
- It arrived +27 s after a transfer, which waits for the `<Dial>` result.
- It ran once per call on every call.

**AMD:** `human` detected 3.3–5.5 s after answer; `machine_end_beep` about 11 s after answer.

**Other checks:**
- The pause works: the S05b retry reached the gate and was refused `campaign_paused`, verdict `later`.
- Daily-cap exemption: 10 dials in one day, none refused `daily_contact_cap`.
- Account B dialled every call (C17 verified live).
- The internal routes are live and OIDC-guarded. Every sweep logged `reenqueued` and `due` with no failures.

## Defects (backlog; none blocked the round)

| id | What a caller notices | Evidence | Likely area |
|---|---|---|---|
| **D1** | Ava says "wrong person" (or re-asks "is that Nithin?") right after her opener, over the person's answer | S01b (outcome recorded `wrong_person`); S01 and S08 re-asks | The clip-then-Live handoff: Live's late first reply is not suppressed, or re-grounded, after a `backstop_slow` clip; `confirm_identity` resolved on "Hello." |
| **D2** | English heard as Turkish or non-Latin script | S01b "Evet, annemden"; S08 | Known Live limitation (no input-language pin, memory *live-api-no-input-language*) |
| **D3** | Asks the person Ava called for "your best contact number" | S01, S01b, S08 | Inbound gather-details flow leaks into the outbound prompt |
| **D4** | Live's own first reply is slow (up to 6.9 s), or never beats the 1.6 s net | All human calls | Latency, plus a tool call before speaking; the design of §9.3 |
| **D5** | Asks you to spell a name the campaign already has | S02 (twice), S08 | `live_spelling_ask_nudged` fires on outbound |
| **D6** | After an unanswered transfer, a robotic Twilio voice says "…call you back" and hangs up abruptly | S08 | The transfer-unanswered `<Say>` uses Twilio TTS, not the Live voice (spec D6: one voice) |
| **D7** | "Is there anything else I can help you with today?" on a call Ava placed | S01, S10, S11 | Inbound closing phrase on outbound |
| **D8** | Tells a receptionist "an enquiry Nithin made regarding **marketing** systems" | S10 | Gatekeeper disclosure level, plus a topic drift from the campaign's "clinic systems" |
| **T1** | Every silent pickup is flagged as a silent call (72 h hold) | 4 of 4 silent-path calls | The 2.0 s backstop timer plus about 90 ms playout breaks the 2,000 ms limb. O-28 |

Observations, not defects:
- The `stacked_questions` counter counted a transcript artefact: the owner heard the question once in S01.
- S01's outcome was `not_interested` (terminal) for a confused test caller, so the classifier deserves review in stage 3.

## Owner direction from this round (2026-09-27)
- The first-cut §9.6 situations table is too thin, and inbound habits leak through (D3/D5/D7). The owner wants a **structured, human-sounding playbook** for every situation, including ones not yet listed. Examples: gatekeepers and family members asked to fetch the person, or for a specific callback time; a "when's good?" callback booked into the system.
- **Two layers:**
  1. a platform playbook, shared by every business, holding the compliance and manners rules;
  2. business-level use cases, per campaign: template, topic, goal, questions, notes, persona, voicemail, transfer and retries, plus a few playbook settings where it makes sense.
- **Next:**
  1. A design session (brainstorming) on the playbook and the business settings.
  2. Build it into stage 3, which already brings the callback, outcome and opt-out tools. D1–D8 and T1 get fixed in the same pass.
  3. Round 2 re-tests with accent testers.

## Still to do from round 1
- **Scenario 9** ("stop calling me"), inside 08:00–21:00 CDT. Check that a suppression row is written at post-call (detector; the stage-3 tool is not built).
- Then `outbound-admin unsuppress --phone +18176011171 --contact-phone +14699338887`, with the owner's YES.
- **Spike #9** (Twilio `canceled` on an answered call): docs-only, not done this session.
