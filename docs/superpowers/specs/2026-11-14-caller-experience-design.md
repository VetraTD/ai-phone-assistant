# Caller experience: a sharp human receptionist, not a form (design)

Date: 2026-11-14. Status: approach A chosen by the owner; this document awaits the owner's approval.
Applies to EVERY business (generic code). Inbound calls only. No business is named in code.

## Intent

The owner, 2026-11-14: a caller should feel they are talking to a sharp, warm human receptionist. They get their call
done quickly. They never feel they are filling in a form or sitting through an interview ("ugh, this is taking so
long"). The caller's experience comes first, and businesses benefit: callers stay on the line, leave the message,
and come away with a good impression.

**Evidence: the S4 test calls, 2026-11-14, revision 00126-kem.** Per-call detail is in docs/ilija-test-calls.md
"S4 results" and the S4 ledger.
- A friend's one-line message ("ring me about Saturday") took four questions:
  - "Am I speaking with <name on file>?"
  - "spell it", after the caller had just confirmed it
  - "best number?"
  - "what is it regarding?", although they had already said
- "What is the call regarding?" was asked after the caller had said why, on three calls.
- One turn asked for the spelling and the number together.
- Two of the co-founder's four calls ended before anything was saved.
- A lead was asked seven questions back to back, each opening with "Thanks.", before anything was saved.
- The goodbye named the business on 4 of 5 calls; the name is hard to say and was said wrong.
- Read-backs never asked "is that right?".

**Root cause.** The code imposes a fixed checklist on every caller:
- capabilities/messages.js STEP_NAME -> STEP_NUMBER -> STEP_REASON -> STEP_URGENCY -> STEP_SUMMARISE ->
  STEP_EXTRA_QUESTIONS.
- A spelling gate refuses a message save until the name is spelled: services/tools.js spellingGateWouldHold,
  lib/nameQuality.js shouldConfirmSpelling.
- Each rule fixed a real failure: a misspelled name was saved, and a number was lost.
- Applied to everyone, the rules make a friend, a seller and a new lead all sit through the same interview.

The model is following our rules, not failing to understand.

**Research summary** (owner asked; sources at the end).
- Loyalty comes from low effort, not delight: CEB/Gartner, 75,000+ service interactions.
- Take answers in any order and ask only what is missing. A fixed form, one field per turn, is what feels like an
  interview.
- Confirm explicitly only what is error-prone or costly if wrong (numbers, emails, names that will be written to).
  Acknowledge the rest in passing. Confirming everything doubles the questions.
- One read-back of the whole set at the end, with an easy correction.
- A message needs who, number, reason, and urgency only when it matters.
- Ask only what the first contact needs; detailed qualification belongs on the follow-up call.
- End with the next step.

## Goals

1. **Fewest questions.** Each caller is asked only what is still missing for THEIR kind of call.
2. **Use what was said.** Anything the caller has already said counts as answered, in any order: the reason, their
   name, when suits, what they want. It is never asked again.
   - Never invent: a value counts only when it came from the caller's own words on this call (or the existing
     on-file record, as today).
   - Unclear means one short question, not a guess.
3. **Caller type decides the path.** The model judges the caller type from what the caller says, as the owner already
   decided on 2026-11-07. Each type has a default path; see "Caller types and their default paths".
4. **The calling number is the callback number.**
   - When the caller ID is real, do not ask "is this the best number?". The read-back says the business will call them
     back on the number they are calling from, and the caller can give another.
   - Ask only when the number is withheld or is the business's own line. The existing isWithheldCallerNumber /
     THIS CALLER'S NUMBER logic covers this.
5. **Spelling only where it matters (approach A).**
   - Leads and existing clients: no "please spell your name" question. The ONE read-back spells the surname and the
     email from what was heard, and the caller corrects it ("no, it's T-I-T-E"); a correction saves again.
   - Friend/personal, seller, wrong number: no spelling at all. A first name is enough.
   - Never ask to spell a name on file that the caller has just confirmed.
6. **One read-back, then "is that right?".** For leads and existing clients only:
   - What it covers: the spelled surname, the email, a number that is NOT the caller ID, a preferred time, and a
     one-line reason.
   - Everything else is acknowledged in passing.
   - Friend/personal callers get a plain confirmation instead ("I'll let him know you called about Saturday").
7. **Conversation glue.**
   - Acknowledge what they asked for.
   - Before the first question, give ONE short line saying why the questions follow, tied to their request.
   - Never repeat the greeting's own words.
   - One question per turn, never two at once.
   - No "Thanks." in front of every question.
   - Described in the prompt, never scripted: a quoted sentence becomes a tic (2026-09-05).
8. **Save early, then ALL the business's questions, asked well.**
   - Save as soon as the type's minimum is in hand, so a lead is never lost.
   - Then ask the business's own questions, in the business's order. NO CAP: a business asks as many as it wants
     (owner, 2026-11-14: customisation is never compromised).
   - What we guarantee is HOW they are asked: one at a time, with a short natural transition, acknowledging the last
     answer (no "Thanks." on every turn), and SKIPPING any the caller already answered in passing ("I run a consulting
     firm" answers "what is your industry?").
   - Caller-first default: if the caller says they are short of time, offer to leave the rest for the callback; the
     caller decides.

## Always-on rules vs defaults a business can replace

The approved three layers (memory "business setting beats default", 2026-11-11): always-on, then the business's
setting, then our default. Everything in this design is a DEFAULT unless listed as always-on.

**Always-on (no business can change):**
- Says it is an AI when asked.
- Emergency guidance.
- Never reads back full card, date-of-birth or ID numbers.
- Never claims something is done when it is not.
- Never invents a detail the caller did not give.
- Never asks again a question the caller has already ANSWERED. Confirming an answer ("Did you say 2 pm?") is not
  re-asking, and is allowed when a business wants it.
- Never reveals one caller's details to another.
- Consent and legal rules. The healthcare tier.

**Defaults (a business's own instruction replaces them):**
- How answers are confirmed: one read-back at the end, then "is that right?". A business may want each answer
  confirmed as it is given; then that REPLACES the end read-back. It is not added on top.
- Spelling: leads and clients spelled back in the read-back, nobody asked to spell up front. A business may require
  spelling up front, or for every caller type.
- Which questions each caller type gets: a business may ask friends for their number, or ask sellers its own questions.
- Which questions, how many, and their order: entirely the business's.
- The goodbye wording: our default thanks without the business name. A business may give its own sign-off.
- Seller handling (already built: lib/sellerCalls.js).

**Reliability.** A business's free-text instruction beats a default only about half the time when both sit in the
prompt (call 11: Ilija's seller rule lost to our generic line). It works reliably by construction: the business's
choice REPLACES the default, so the model never sees both.
- Free text stays fully supported.
- The two style choices businesses are most likely to make, confirmation style and spelling, become two simple
  settings on the message-taking capability: `confirm_style: end | each` and `spell_up_front: no | leads | everyone`.
  When set, the default sentence is left out of the prompt and the code checks follow the setting.
- Status: APPROVED by the owner, 2026-11-14 ("yes add the two settings"). In this round. Estimate +1 h. The future
  caller-type table and config chatbot set the same settings. Unset = our default. Both are generic capability
  settings (messages pack config), never per-business code. They must be readable by the prompt builder and the code
  checks (spelling gate, ask ledger, read-back note), and guarded by the WIRED_KEYS tripwire
  (tests/capabilityConfigEffects.test.js).
- Code enforcement never fights a business choice. For example, the ask ledger must not cut a confirmation question
  when confirm_style is "each".
9. **Plain goodbye.** Thank them and wish them well WITHOUT the business name.
   - The wrong-number line keeps saying where they reached ("you've reached <business>"): owner, 2026-11-14.
10. **Measured on every call.** Counters in live_call_summary, each with a denominator:
    - questions asked
    - seconds from first caller words to the save
    - asks for something the caller already gave
    - number asks with a real caller ID
    - spelling asks by caller type
    - calls that ended before a save on a message-type call
    - goodbye turns containing the business name
    - read-backs without a "right?" ask

## Non-goals (this round)

- The dashboard caller-type TABLE (a business choosing per-type questions on a settings screen). This round ships OUR
  defaults per type, plus the business's existing notes. The table is the next step and uses these types.
- Booking flows (appointments pack): the booking read-back, the booking spelling gate and the slot logic are unchanged.
  Only the shared rules apply to booking calls too: one question per turn, no repeated greeting, plain goodbye.
- Outbound calls: unchanged and byte-identical.
- Pronunciation work. Forwarding. The config chatbot. Any business's own question list (it is config, uncapped).
- S4-B1 "(No speech detected)" markup: not heard; stays backlog.

## Anti-goals (a failure even if it "works")

- A detail the caller never said appears in a saved message or a read-back.
- A lead is lost: a message-type call where the caller gave enough and nothing was saved. The caller ID is always
  stored with the message.
- A faster call that drops the message or the callback promise.
- Code that names or branches on one business.
- Weakening an always-on rule:
  - AI disclosure
  - emergency guidance
  - never reading full card or ID numbers
  - never claiming an action done when it is not
  - the healthcare tier

## Constraints (learned the hard way; see memory)

- **A rule written only in the prompt holds about half the time.** Every goal above needs code backing or a counter:
  "prompt caps need counters"; spelled read-back held 6/12.
- **On Live the prompt is built once, at the greeting step.** A step-scoped tail rule never reaches the model. Rules
  go in the static prefix or in TOOL REPLIES, which Live obeys at once ("live prompt built once", "live instruction
  timing").
- **Describe, never script.** No quoted sentences for the model to recite.
- **Existing machinery to reuse, not duplicate:**
  - lib/voice/askLedger.js (one ask per need, decline blocks a need for the call, the Live cutter)
  - set_call_intent (services/gemini.js ~654)
  - the spelling gate
  - spelledReadBackNote (capabilities/messages.js)
  - closingTicRe / the ask-gate (lib/voice/strings.js)
  - the end_call description (services/gemini.js ~692)
  - the THIS CALLER'S NUMBER block
  - VOICE_SPELL_POLICY (lib/nameQuality.js)
- **Business prose fields are capped at 2,000 characters**, truncated silently. Nothing here needs more prose from a
  business.
- **Every behaviour change gets** a red-first test, a sabotage row, census, and prompt snapshot updates (only where
  intended). The full gate then runs before deploy. CRLF checkout; builds come from the main checkout.

## Approaches considered

1. **Prompt-only rewrite.** Turn the checklist into a goal in the prompt and stop there. Cheapest, about 1.5 h, but
   unreliable: about half the time it would still re-ask and still spell. Rejected as the whole answer; its wording is
   part of approach 2.
2. **Caller type drives the path, with code backing (CHOSEN).**
   - The model reports the caller type early through the existing intent tool.
   - The tool's reply hands back that type's short path, which Live obeys at once.
   - Code enforces the parts that matter:
     - the spelling gate is skipped for message saves (leads correct the spelled read-back instead)
     - the ask ledger refuses a number ask when a real caller ID exists, and a reason ask once one was given
     - the goodbye check
   - Counters measure the rest. Matches the approved "business setting beats default" design: types now, the
     dashboard table later.
3. **A full state machine in code** that decides every next question, with the model only phrasing it. Most
   predictable, but a rewrite that fights how the Live model talks, and the slowest to ship. Rejected for now.

## Caller types and their default paths

The model sets the type once it is clear and may change it when the call turns out different. The types:

| Type | Minimum before saving | Asked only if missing | Read-back | Spelling |
|---|---|---|---|---|
| **personal** (friend, family, someone the owner knows) | first name + message | number only if withheld | none; a plain "I'll let them know you called about …" | never |
| **new lead / enquiry** (wants a service, price, consultation) | name + what they want | when suits (if they want a call back); then ALL the business's questions after the save, skipping any already answered; email only if the business asks for it or the caller offers it | one, ends with "is that right?" | surname + email (if given) spelled in the read-back, never asked first |
| **existing client** | name (on file: confirm once) + what it's about | when suits, urgency if relevant | one, ends with "is that right?" | as lead; never if on file and confirmed |
| **seller / supplier** | per the business's rule; our default when none: decline politely, or if taking a message: name + company + one line | nothing else | none | never |
| **wrong number** | nothing | nothing | none | never |
| **unclear** | ask ONE open question ("how can I help?") before any checklist | | | |

Urgency is asked only for existing clients and only when the reason suggests it might matter. The business's extra
questions apply to the lead type by default; a business that wants them for others says so in its notes (and later
in the table).

**The types are generic, not Ilija's.** The same six types fit any business; only the words change.

| Business | personal | new lead | existing client | seller / supplier |
|---|---|---|---|---|
| Dental clinic | the dentist's family | new patient wanting a check-up | patient asking about their appointment | dental-supply rep |
| Plumber | the owner's mate | "my boiler's broken, can you come?" | customer chasing last week's job | parts wholesaler |
| Law firm | a partner's friend | someone needing advice on a case | client asking for an update | legal software sales |
| Marketing agency (Ilija) | a friend about Saturday | wants Meta ads | current client with a question | SEO list seller |

Each business's own questions, settings and seller rule ride on these types. The future dashboard table lets a
business rename a type or add its own (e.g. "insurance company calling" for a clinic).

## What a call should sound like (targets, not scripts)

**Friend.** About 15 s, no questions except "anything else?".
> Caller: Hi, it's Mike, a mate of Ilija's, tell him to ring me about Saturday.
> Receptionist: Will do, Mike. I'll let him know you called about Saturday; he'll have your number. Anything else?
> Caller: No, cheers. -> Receptionist: Take care, bye.

**Lead.** About 60-75 s.
> Caller: I'd like to learn more about Meta ads and book a consultation.
> Receptionist: Happy to help. Ilija runs those consultations himself, so I'll take a couple of quick details for
> him. What's your name?
> ... name ... "And the business?" ... (saved) ... the business's questions, one at a time, with transitions,
> skipping any already answered ...
> "When suits you for a call back?" ...
> Receptionist: So that's Jonathan Daniel, D-A-N-I-E-L, from Daniel Consulting, about Meta ads; Ilija will call you
> on this number tomorrow around 2. Is that right?
> Caller: Yes. -> "Great. Anything else?" -> "No." -> "Thanks for calling, have a great day."

**Seller** (business says take a message): name + company + one line, plain confirmation, done.

## Settled after the builder check

Answered by what already exists:
- **Saving early does not mean early or duplicate emails.** Since the Ilija S1 work, every later save on the same call
  merges onto the SAME message row (answers into `details`). Packs no longer email at save. The owner notice is sent
  once, at call end (flushOwnerNotices from /twilio/status). So "save early, then extras, then a corrected re-save"
  is one row and one email. Keep it that way; a test must pin it.
- **The seller rule already has a detector.** lib/sellerCalls.js businessHandlesSellerCalls(config) tells "the
  business wrote a sales-call rule" from "none". Our default seller bullet (services/gemini.js guardrails) is left
  out when it fires. No new field.

Controller's calls (the owner can overrule any of them):
- **Email is not part of the lead minimum.** It is asked only when the business's own questions ask for it, or taken
  when the caller offers it. When given, it is spelled back in the one read-back. Fewest questions by default; a
  business that wants it says so.
- **"Existing client" is the model's judgement, as every type is.** The "confirm the on-file name once" step runs only
  when the calling number actually matches a record. A self-declared client with nothing on file is handled like a
  lead for the name (spelled back in the read-back). When the number matches a record but the caller is plainly a
  seller or a wrong number, what they SAY wins; the on-file name is not used.
- **Healthcare tier unchanged this round.** A business on the healthcare tier keeps today's spelling gate and
  read-back for every caller type. Approach A applies to the standard tier only.
- **Live is the product path.** The new enforcement (tool-reply paths, ledger refusals, counters) is built for Live.
  The cascade/text path gets the shared prompt wording only, and its existing tests must stay green. No new cascade
  enforcement.
- **A type can change mid-call.** If a personal call turns out to be a lead after the save, the new type's remaining
  steps apply from that point. A re-save merges onto the same row. Nothing already answered is asked again.

## Parts decided by the owner

- Approach A (quick for most callers; leads get one spelled read-back, no up-front spelling ask). Owner, 2026-11-14.
- Generic for every business. The caller's experience first. Owner, 2026-11-14.
- Wrong-number line keeps the business name. Goodbye never names it. Owner, 2026-11-14.
- Caller type is the AI's judgement from what the caller says. Owner, 2026-11-07.
- Business setting beats our default; the caller-type table delivers it later. Owner, 2026-11-11.

## Left to the builder

- **How the type is reported.** A new `caller_type` argument on set_call_intent, or a new small tool. It must be
  reported before the first detail question, and the type's path must arrive in that tool's REPLY.
- **How "already given" is detected** for the ask ledger's reason and when-suits needs. Options:
  - the model reporting `reason_given` / `time_given` with the type
  - the ledger reading the caller's words
  Pick the one a test can prove; both ends must be real (memory: "a test proves a wire only if both ends are real").
- **How the spelling gate steps aside for message saves** without touching bookings. The STEP_SUMMARISE correction
  re-save stays.
- **Counter names** and where each is incremented. Every counter needs its denominator.
- **Exact prompt wording**, within the rules above (described, never scripted).
- **Whether to ship behind an env off-switch.** Rollback is the previous revision either way.

## Verification

- Unit tests per goal, red first.
- One sabotage row per enforced behaviour.
- Prompt snapshots change only in the messages protocol, the end_call description and the new type guidance.
- Full gate before deploy, then deploy as S4 Deploy 4 was done.
- Live check, owner-approved, about 6 calls (~$2.40):
  - friend
  - new lead
  - seller
  - existing client
  - withheld number
  - "can I speak to <owner>?"
- Judged by the counters plus the owner's ear.
- Success:
  - friend at 0-1 questions
  - lead saved within about 45 s of stating the need
  - no re-asked answers
  - no goodbye naming the business
  - every read-back ends in a "right?" ask

## Sources

- HBR 2010 / CEB customer effort research (summaries): https://www.smartcompany.com.au/marketing/20100816-why-you-should-stop-trying-to-delight-your-customers/ ,
  https://www.renascence.io/journal/gartners-customer-effort-research-why-effort-beats-delight
- Amazon Alexa, collecting and confirming information: https://developer.amazon.com/en-US/docs/alexa/custom-skills/define-the-dialog-to-collect-and-confirm-required-information.html
- Vapi voice design playbook: https://vapi.ai/playbook/design
- CallSphere, form filling vs slot filling: https://callsphere.ai/blog/slot-filling-conversational-ai-collecting-information-natural-dialog
- OpenDialog, information collection: https://docs.opendialog.ai/opendialog-platform/conversation-designer/conversation-design/conversational-patterns/information-collection/components
- NextPhone, phone answering practices: https://www.getnextphone.com/blog/phone-answering-best-practices
- Specialty Answering Service, taking messages: https://specialtyansweringservice.net/how-to-take-a-phone-message-at-work
- Answering Legal, intake mistakes: https://answeringlegal.com/blog/law-firm-call-handling-seven-mistakes-new-leads-over-phone
