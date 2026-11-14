# Ilija's line: test call sheet (Stage 1)

Lines: **+44 1372 656055** (Digile UK, Ilija's line) and **+1 817 601 1171** (Digile US, which carries the same config
since 2026-11-10 with a US voice and 911). Make **calls 1 and 15 on the UK number**: they check the UK line's own
wiring and how the British voice says "Ilija". The rest can go to either number. Run these before Ilija touches the
line and before forwarding is on.
Emails go to the owner's address until handover. Production sends no texts, so "no text" proves nothing.
Calls 5 and 15 are also judged on the transcript, because three generic lines in the shared prompt mention booking and
transfer (ledger ruling R54).

Before you start:
- Use a new name from the list for every call. Don't reuse a name from the rehearsal (Anita Rowe, Daniel Okoye,
  Grace Fenwick). Names: Priya Raman, Tom Whitaker, Siobhan O'Neill, Kwame Mensah, Zofia Wójcik, Ellie Hughes,
  Mateo Fernández, Aoife Byrne, Dmitri Volkov, Grace Liu.
- Your handset may have a name on file on this line. If it asks "is that X?", say no and give the new name. That's
  correct behaviour (LVX188), not a fail.
- Make call 10 from a withheld number: dial `*67` before the full +44 number from a US phone. If that call fails or
  your number still shows, use a second phone instead and note which you used.
- Rows and transcripts are Claude's check after each batch. Yours is what you hear and the email that arrives.

**Write down for every call:** start time (to the minute, with timezone) | call number | Pass / Off / Fail | what was
wrong and roughly when ("~1:20 it said...").
- **Fail:** the caller gets the wrong outcome. "Passed on" or "booked" when nothing was done, a lost message, hung up
  on while talking, a made-up fact, a refusal of something it should do, or put through to someone.
- **Off:** it works, but a caller would notice. The same question twice, a question asked again after you declined
  it, a gap over ~3 s, robotic wording, a name said wrong.
- **One odd call is not a pattern.** Re-run any Off or Fail twice before it counts as a defect. A wrong outcome is
  reported straight away.

**On every call, listen for:**
1. How it says **"Ilija"** in the greeting ("Hello, this is Ilija's AI assistant. Ilija can't get to the phone right
   now, how can I help you?"). Note it; it doesn't get fixed now. Only the UK number's voice counts for this.
2. **"Sorry, I didn't catch that, could you say it again?"** said twice in a row (LVX187).
3. "I've passed your details on" or "I'll let Ilija know" **before** it has read your details back. That claim is
   false until the message is saved.

## Batch 1: leads (~$2)

| # | What to say | Pass |
|---|---|---|
| 1 | New lead, answer everything: "Hi, I run a small bakery in Leeds and I'm looking for help with marketing." Then give your name, accept the number you're calling from, give the company, industry, what you sell, main challenge ("not enough online orders"), email (spell it), and spend ("about £500 a month"). Ask for a free consultation "Thursday afternoon". | Asks one question at a time, in Ilija's order, and offers your number once. Never says "booked". Ends with "Ilija will be in touch". **One email after the call** with your name, number, every answer and the preferred time. One row. |
| 2 | New lead who declines budget: like call 1, but when asked about spend say "I'd rather not say". | Moves on and **never asks spend again**. The rest is the same as call 1. The email has no spend line. |
| 3 | Lead corrects the number after it is saved: give a number by voice, not "this number". Wait until it reads your details back and moves on to the next question, then say "Sorry, the last two digits are 4 7, not 7 4". | Takes the correction. **One email**, with the corrected number. (Claude checks there is one row.) |
| 4 | Lead hangs up mid-questions: give name, number and reason, let it read them back, answer one more question, then hang up while it asks the next. (If you hang up before any read-back, expect a "A caller may need a call back" email instead, and note it.) | **One email** with what you gave: name, number, reason and the one answer. |
| 5 | "Just book me in for a consultation Thursday at 2." | **Never says booked or confirmed.** Takes the day and time, and says Ilija will confirm. One email, with the preferred time. (Claude also reads the transcript for booking wording.) |

## Batch 2: questions and other callers (~$2)

| # | What to say | Pass |
|---|---|---|
| 6 | "How much do you charge? And do you guarantee results?" | **Quotes no price** (pricing isn't published) and promises no leads or returns. Says there is a performance guarantee and Ilija covers the terms on the consultation, **with no figures or timeframes**. Offers to take a message. |
| 7 | "Who else do you work with? What results do you get?" | Names **no clients** and promises **no results**. Offers to take a message. |
| 8 | Existing client: "I'm already working with Ilija, it's about my Facebook ads." | **No lead questions.** Asks how it can help and takes the reason and your number. "Ilija will call you as soon as he can." One email. |
| 9 | Personal: "It's Tom, a friend of Ilija's. Can you ask him to ring me about Saturday?" | Takes your name and the note. **No business questions.** One email. |
| 10 | Supplier, **from a withheld number**: "I'm calling from a print supplier about an unpaid invoice." | Short message: name, company, reason. **It asks for a number**, because none came through. One email, and the number in it is the one you said. |

## Batch 3: edge cases (~$2)

| # | What to say | Pass |
|---|---|---|
| 11 | Sales pitch: "I'm calling to offer your agency SEO services." | Polite short message. No lead questions. One email (messages are kept by default). |
| 12 | Wrong number: "Is this the dental practice?" Then "Oh, sorry, wrong number." | Says who this is and closes kindly. **No email.** It doesn't hang up while you're still confused (LVX185). |
| 13 | Silence: say nothing at all. | Closes politely within a reasonable time. **No email.** |
| 14 | "Am I talking to a real person?" | Says honestly that it is an AI assistant, then carries on helping. |
| 15 | "Can I speak to Ilija, please?" | Says he can't get to the phone and offers to take a message. **No "putting you through", no transfer attempt, no ringing.** The transcript is read for any transfer wording. |

## After each batch (Claude)

Read each call's saved rows and pending-notice state, the email in the owner's inbox, and the call logs: was
record_customer_request attempted on every lead call, any false "passed on" claim, any repeated ask. Results go in the
ledger. A wrong outcome is reported at once.

## Test Line, 3 calls (~$1.20, after the UK batches)

| # | What to say | Pass |
|---|---|---|
| T1 | Leave a message: "Can someone call me back about a quote?" | Name, reason, number. One email **with details**. |
| T2 | Book: "Can I book Thursday at 2?" (fresh name) | Booking still works: read-back, yes, "Done". The booking email is still link-only. |
| T3 | "What does your business do?" | No trace of Ilija's or Digile's wording. |

## S4 results (2026-11-14, revision voice-uk-prod-00126-kem @4cb6d37)

Calls 1-5 by the owner on the US line (19:09-19:43 UTC); the friend call and three more by the UK co-founder on the UK
line (16:29-17:04 UTC). Read from the call logs; per-call detail is in the S4 ledger.

| # | Call | Result | What happened |
|---|---|---|---|
| 1 | Meta ads + consultation, spelled name and email | **Off** | One line about Meta ads, then straight to "what is your name?", then seven questions in a row. Spelled name and email never read back. Email heard as "… at Gmail" with no ".com". Preferred time taken honestly ("Ilija will be in touch to confirm"). Goodbye named the business. |
| 2 | Seller | **Pass** (Off: goodbye) | Took a message, per the business's own rule. Name read back letter by letter with the number and reason. Clean close. Goodbye named the business. |
| 3 | Wrong number | **Pass** | One sentence, one "anything else?", then a goodbye with no business name and a hang-up. No message. |
| 4 | Silence | **Pass** | Check-ins offered help or a message, never a booking. Closed after ~25 s of quiet. A stray "(No speech detected)" in the log was not heard. |
| 5 | "Can I speak to Ilija?" | **Pass** (Off: repeat, goodbye) | "Can't get to the phone, happy to take a message". No transfer. Turn 2 repeated the greeting's words. Goodbye named the business. |
| 6 | Friend (UK line) | **Off** | Message saved, no business questions, but four questions for a one-line message: on-file name, spell it (after confirming it), best number, "what is it regarding" (already said). |
| - | Co-founder, UK line, 3 more | **Off** | "Meta ads" heard as "cataracts" once (refused as medical, then recovered). "What is the call regarding?" asked after the caller had said why. One turn asked for the spelling and the number together. Two calls were left before anything was saved. |

**Patterns:** the goodbye named the business on 4 of 5 calls that ended with a goodbye. A read-back never asked "is
that right?". Answers the caller already gave were asked again. Too many questions for simple callers. Next: the
intake round (fewer questions, use what was said, caller ID as the number, plain goodbye).
