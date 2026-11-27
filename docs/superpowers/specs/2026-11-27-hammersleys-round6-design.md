# Hammersleys fix round 6 — one record per request, complete answers, clean endings, config v15

Date: 2026-11-27. Owner-approved scope (R58 and the 11-27 design talk): items 1-4 from the round-5 scorecard, plus a
receptionist-wide "same or different?" check. Code is generic for every business; Hammersleys' specifics live in
its config (v15).

Design approved 11-27. R59 (owner, 11-27): the "same request details" fallback is dropped. Code never merges two
different names on its own; a forgotten `replaces_name` gives a visible duplicate (R-visible).

## Why

Round 5 (prod `voice-uk-prod-00166-pow` @ `ba608d7`, config v14b) got emails right on 3 of 4 owner calls. Jason
(Hammersleys) does not get the number until every email is right. The fourth call failed on two things the notes
cannot fix, and two smaller defects showed up across the calls:

1. **A corrected name filed a second record.** Call 4: the AI heard "John Doe" for "James Doe", saved, said it back,
   the owner corrected it, the AI saved again as James Doe. The email had two bookings. Cause:
   `lib/capabilities/customerRequests.js` `saveCustomerRequest` merges a later save only when the names look alike
   (first word within edit distance 0.34), or onto a row with NO answers (`nameFix`). The first row held answers.
2. **A saved label counts as answered even when the answer is incomplete.** Call 4's pickup "Plaistow Street" had no
   house number or postcode, but `lib/capabilities/notesQuestions.js` `openQuestions` sees only labels, so the
   "questions with no saved answer yet" list dropped Pickup and nobody asked for the rest.
3. **A junk line in the email.** Call 1: the caller said "No, that's it" (Deepgram heard it right); Live's side
   transcript wrote "No hace"; `lib/voice/afterSaveNote.js` added `Said after the last save (unchecked transcript):
   "...anything else...?" — No hace.` to the email (owner ruling R54: fix in round 6 by checking Deepgram's words).
4. **The repeat hold waits on a markup tail.** After the already-asked note the model emitted `<no speech
   detected>` (2 of 2 fires). `holdWordsOf` turns it into three words ("no speech detected"), so the hold treats it as
   new words and plays it after the 1.5 s cap. On an earlier call (O1 CA591a92) such markup was spoken aloud.

Found in the design talk (owner asked, code read):

5. **A second request by the same caller overwrites the first.** "One for me at 8 from home, and one for my son at 4
   from his flat", or "there on Saturday, back on Monday": both saves carry the same caller name and nearly the same
   reason ("Taxi booking" — Jaccard ≥ 0.5), so `sameRequest` matches and `mergeDetails` replaces Pickup/When by label.
   The first trip is lost silently. Read from the code, not yet seen on a real call; proven by a failing test first.
6. **The same "same or different?" decision exists in other places** (owner: "make sure this isn't only addressed
   in this one feature"). Appointments already follow the two rules below (a `correct_appointment_name` tool; Fix 3
   asks "move your 9 to 10, or keep both?" when unsure); messages do not.

## The two rules (receptionist-wide)

Every place where code decides "is this save the same thing as an earlier one?" must follow:

- **R-visible.** When unsure, pick the outcome the business can see (a duplicate record, one more question) over one
  nobody sees (a silent overwrite, a silent move or merge).
- **R-say-it.** When the AI knows something (a correction, a second request), let it say so in the tool call. Do not
  guess it from comparing text.

Names alone can never separate "No, it's James Doe" (one record) from "and one for my son James Doe" (two records):
the saves look identical. Only the meaning separates them, and only the AI understands meaning. So the AI says it,
code checks what it said, and code rules are the fallback.

## Goals

- G1 A name correction of any size (first name, surname, both, sounds-nothing-alike) leaves ONE record.
- G2 One taxi for two people leaves ONE record (caller's name, Passengers: 2) — already true, kept true.
- G3 Two separate requests on one call leave TWO records; nothing is overwritten.
- G4 An answer the business says must contain certain parts (e.g. a street address needs a house number and
  postcode) is asked for the missing parts ONCE, then accepted as it is. A named place (pub, station, airport) is
  never asked.
- G5 No "Said after the last save" line when Deepgram heard only a plain closing.
- G6 A markup-only tail after a held question is never played.
- G7 Every place in the receptionist-wide table is tested against R-visible and R-say-it; gaps outside messages are
  recorded with a test and brought to the owner.

## Non-goals

- Fixing mishearing itself (scorecard items 4, 6, 8: the model misses answers Deepgram got; village not asked;
  "Ummm" heard as "yeah"). Parked or measured first.
- A postcode-lookup API (owner R25: rejected).
- A dashboard control for the new setting (operator-set on import, like `questionsSkipReasonPrefixes`).
- Fixing gaps found outside messages in this round (they go on the backlog with their test; owner decides).
- Airport hand-off time (round 5: 2:11, caused by a postcode read back wrong twice). No item targets it; it stays in
  DONE WHEN and may fail again.

## Anti-goals (a failure even if the tests pass)

- Two different people's bookings silently merged into one.
- A pub, hotel, station or airport pickup asked for a house number or postcode.
- More than one follow-up ask for a missing part, or insisting.
- Caller words in any log (counts, kinds, ms only).
- Added latency on the normal path.
- Client-specific code.

## Constraints (carried from the round-5 brief)

- Security: no caller words in new logs; secrets read straight into env, never printed; Twilio account A only and
  only the two Hammersleys numbers; caller audio to Deepgram only via the EU endpoint, inbound only, never for
  healthcare tenants; record every old value before changing it.
- Explain each mechanism plainly, then ask yes/no before any prod deploy, Twilio change, env change or tenant import.
- Ask before paid sims or live API spend, with the token and dollar estimate. Cap $3 for this round.
- Do not trust a sim pass on its own; prove every new assert can fail first.
- Generic code only; one client's specifics live in config.
- No added latency on the normal path. Tokens/turn ≤ 12.9k (round 5 pooled 12.4k).
- Debug transcript stays ON (R57) until the owner says otherwise after the calls are judged.

## Approaches considered

### Item 1 (name correction) and the overwrite gap

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | Same trip details under a new name = same record | Covers bookings with details; misses plain messages; misses a correction that also changes the details; silently merges two people with the same trip | Dropped (owner R59, 11-27): a silent merge of two people is an anti-goal |
| B | Same surname + same reason = same record | Covers "John→James Doe"; misses both names misheard; wrongly merges "my son James Doe" | Dropped |
| C | A or B | Still misses both-names-misheard plain messages; keeps B's wrong merge | Dropped |
| **D** | **The AI says it on the save (two optional fields), code checks the claim, today's rules as fallback** | Covers every size of correction and the two-requests case; depends on the AI filling a field (measured in sims and live counters); when it does not, today's behaviour (a visible duplicate) | **Chosen (owner, 11-27)** |

### Item 2 (answer must contain parts)

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| **A** | **An explicit per-business setting: per label, the parts it needs, from a fixed list of generic detectors, with an optional "only for a street address" condition** | Explicit, testable, survives rewording of the notes; needs an operator to set it | **Chosen** |
| B | Parse the parts from the notes text | No new setting, but a reworded note silently changes behaviour | Dropped |
| C | Let the AI flag incomplete answers | The AI alone already failed this (round-5 call 4) | Dropped |

Items 3 and 4 have one sensible way each (below); alternatives (a model call to judge the junk line; a general
markup filter on all audio) cost latency or touch the normal path.

## Design

### 1. One record per request (messages pack, every business)

**Tool declaration** (`capabilities/messages.js` `RECORD_CUSTOMER_REQUEST_DECLARATION`, so the standard tier's copy
and the healthcare tier both get it): two new optional properties.

- `replaces_name` (string): "Only when the caller corrects THEIR OWN name after you saved it: the name you saved
  before, exactly as you saved it. Never for another person."
- `separate_request` (boolean): "true only for a second, separate request on this call (another trip, another
  appointment, another message). Never for a correction or more details about the earlier one."

Exact wording is the builder's, within ~80 tokens for both (Live re-reads tool declarations every turn).

**Plumbing:** `messages.js` `onEffect` passes `replacesName` and `separateRequest` to `saveCustomerRequest`.
`capabilities/quotes.js` is unchanged (the new options default to off).

**Matching order in `saveCustomerRequest`** (this call's rows of the pack's types, newest first, as today):

1. `separateRequest === true` → a new row, unless the claim does not hold (my call, builder check Q2): every save
   reply says "save again with ... all the answers", so the model may resend the flag on each follow-up save for the
   second request. Code checks it against the call's NEWEST row: the save shares at least one label with it and every
   shared label has the same answer → a follow-up, not a new request: the flag is ignored and today's rules decide
   (counter `customer_request_separate_ignored`). The save conflicts with the newest row on a shared label, or shares
   no label with it → a new row (counter `customer_request_separate`).
2. `replacesName` given → the newest row whose `caller_name` is the same person as `replacesName` (today's
   `samePerson`, so "Jon Doe" finds "John Doe"). Found → update that row: the new name, `mergeDetails`, the message
   merged as today. Counter `customer_request_name_replaced`. Not found → fall through (counter
   `customer_request_replaces_unmatched`); a claim that matches nothing changes nothing.
3. Today's rules, unchanged: `sameKind`, `samePersonOnly`, `nameFix`.
4. Otherwise a new row (today). **No details fallback (R59).** A new row filed while a row of this call holds ≥ 2
   answers with the same label AND the same answer (case, spacing and punctuation ignored) under a different name is
   counted `customer_request_possible_duplicate` (a count, no behaviour change): it measures how often the AI forgot
   `replaces_name`. (Call 4: Pickup "Plaistow Street" and Destination "Dormansland" were equal on both saves.)

**Per-request state.** A `separate_request` save that actually files a new row starts a new request in
`capabilityState.messages`: `savedLabels`, `sayBackOwed` and the item-2 part state restart from this save's own
answers. An ignored flag resets nothing (so a resent flag cannot re-ask a part). Otherwise the second trip's questions
would count as answered by the first trip's labels and never be asked.

**Measuring the overwrite gap live:** counter `customer_request_answer_replaced` when a merge replaces a non-empty
answer with a different one (a count, no words). A genuine correction also counts; the number tells how often the
flag is missing.

**Known residuals (accepted, stated to the owner):**
- The AI leaves both fields empty on a second request by the same caller → today's overwrite.
- The AI leaves `replaces_name` empty → a duplicate record (visible, as call 4).
- After a separate request, a later save that adds to the FIRST request lands on the newest row.

### 2. Answer must contain parts (messages pack, every business; Hammersleys sets it)

**Setting:** `messages.answerParts`, schema type `list` (already handled generically by the engine loader
`lib/capabilities/configSchema.js` and the dashboard validator
`AI-phone-dashboard/backend/src/capabilityConfigValidation.js`, so a dashboard save keeps it). maxItems 5,
maxLength 60. Operator-set on import; no dashboard control.

**Entry syntax:** `<Label>: <part>[, <part>...][ if street]`, e.g. `Pickup: house_number, postcode_uk if street`.

**Parts (fixed vocabulary, generic detectors in a new pure module, e.g. `lib/capabilities/answerParts.js`):**

| part | present when the answer has | heard as |
|---|---|---|
| `house_number` | a number token (12, 12a, 5-7, "flat 3") or a number word at the start | "house number" |
| `postcode_uk` | a full UK postcode, spaced or spoken letter by letter ("R H 7 6 A U") | "postcode" |
| `zip_us` | a 5-digit ZIP (+4 optional) | "ZIP code" |
| `email` | an email address, written or spoken ("at", "dot") | "email address" |
| `phone` | 10 or more digits | "phone number" |

`if street`: the rule applies only when the answer looks like a street address (a street word: street, road, lane,
avenue, close, way, drive, crescent, place, gardens, grove, hill, court, terrace, row, square, mews; the builder
settles the list on fixtures). "The Greyhound, Lingfield", "East Grinstead Station", "Gatwick North" have no street
word and are never asked.

**Behaviour:**
- At each save, every answer whose label matches a rule's label (the same label matching `notesQuestions.js` uses;
  export it, do not copy it) is checked. Missing parts are kept in `capabilityState.messages` per label.
- The open-questions list in the save reply shows such a label as open with what it needs, e.g. `1. Pickup (still
  needs: house number, postcode)`. It stays listed until the AI's OWN words, after it was first listed, name the part
  ("house number", "postcode", ...): that is the one follow-up ask, and after it the label is answered whatever comes
  next (my call, builder check Q3: on Live the model often asks before it saves, so the reply that lists a part may be
  the deferred "when they answer" form; counting that reply as the ask could mean it is never asked). Safety cap: a
  part drops off after 3 save replies even if never named. Read the AI's words per turn, not as a length offset into
  a capped call-long string (the LVX192 trap). Where the list does not run (no numbered notes), one short line in the
  reply does the same job. A skip-reason save (e.g. URGENT) is exempt: an urgent caller is put through, never asked
  for a postcode (my call, Q5).
- A later save that adds the missing part clears it. A caller who does not know it is never asked again.
- An entry that does not parse is ignored (and `render-tenant-prompt` warns).

**Hammersleys v15:** `answerParts: ["Pickup: house_number, postcode_uk if street"]` on both tenants (UK 2ada1dd4,
US test 7df62558). Pickup only (my call: the dispatcher needs the exact pickup; the destination the driver can
sort). Notes as v14b except the Pickup line drops "else ask again" after the postcode format hint, so the code's one
follow-up is the only second postcode ask (my call, Q4). The format hint ("ends in digit + 2 letters (RH7 6BJ)")
stays. The `postcode_uk` detector likewise wants a full postcode (outward code + digit + 2 letters).

**Dashboard release point (builder check):** the dashboard validator keeps only settings in its generated schema
(`AI-phone-dashboard/backend/src/generated/capabilitySchemas.json`, from `scripts/export-capability-schemas.js`), and
a save replaces the whole config. The plan regenerates that file, then checks read-only whether the DEPLOYED
dashboard backend knows `answerParts` (and round 2's `questionsFor` / `questionsSkipReasonPrefixes`, which have the
same exposure). If stale, a dashboard backend deploy is proposed with a yes/no like any prod deploy.

### 3. No junk line when Deepgram heard a plain closing (Live, where the Deepgram shadow runs)

- `finish()` already snapshots `afterSaveFacts`. Add Deepgram's text heard after the last real save (from the
  in-memory `dgHeard`, finals only) and whether that window is fully covered (the shadow connected; the oldest kept
  entry is older than the last save; `DG_HEARD_KEPT` = 20 may not reach back).
- `afterSaveNote` gets an optional `heardByDeepgram` input. Covered window, Deepgram heard something, and none of it
  is informative (the same `isInformativeCallerTurn` with the business's `closingRe`) → no line. Counter
  `after_save_note_dropped_dg_closing`.
- Anything else (no shadow, not covered, Deepgram heard real words) → today's behaviour, byte for byte.
- Caller words stay in memory, never in a log. No new Deepgram traffic: the shadow already streams for the listed
  tenants (EU endpoint, inbound, never healthcare — `saveAfterSaveNote` already skips healthcare and outbound).

### 4. Never play a markup-only tail (Live repeat hold, every business)

- In the repeat hold, markup tokens (`<...>`, `{...}`) are removed before words are counted.
- A tail that is markup only → `pendingDrop`: dropped at the generation's end or the cap, never played. Counter
  `live_repeat_hold_dropped` with reason `markup`.
- Markup mixed with words → decided on the words, as today.
- Counter `live_model_markup_seen` for markup in any output transcription (count only), to measure markup outside
  the hold. No change to audio outside the hold.

### 5. Receptionist-wide "same or different?" check

For each place, a test of R-visible and R-say-it, then a short table in `docs/receptionist-backlog.md` with the
result:

| Place | File | What to test |
|---|---|---|
| Messages / callbacks | `lib/capabilities/customerRequests.js` | items 1 and 5 (fixed this round) |
| Appointments, name corrected | `capabilities/appointments.js` `correct_appointment_name` | correction updates, never books a second |
| Appointments, rebooked after a misheard name | `appointments.js` `samePersonBookings` | both names misheard, then `book_appointment` again: refused, asked, or a silent second booking? |
| Appointments, time corrected | `appointments.js` Fix 3 (`samePersonForMove`) | unsure → asks; never a silent move |
| Same question twice | `lib/voice/askLedger.js` | a miss means a repeat, never lost data |
| Question answered? | `lib/capabilities/notesQuestions.js` | item 2 |
| Outbound name on file | `services/tools.js` `outboundNameOnFile` | unsure → asks (outbound is off) |

A place that passes gets a normal test. A gap outside messages gets a test that documents it without turning the
suite red (e.g. vitest `test.fails`, which flips when someone fixes it) plus a backlog entry, and goes to the owner.

## What success looks like (DONE WHEN)

Round 5's list, unchanged: every email right (name with surname, pickup, destination, time) with no junk line;
local ≤ 1:45; airport hand-off ≤ 2:00; hand-off → hang-up ≤ 12 s; no question heard twice; an "Ahm" is not
answered; a pub pickup is not asked for a house number or postcode; ≤ 1 re-ask; no Spanish; reply p50 ≤ 1.9 s;
tokens/turn ≤ 12.9k. Plus:

- A corrected name (first, surname, both) leaves one record.
- Two trips on one call leave two records, nothing overwritten.
- One taxi for two people leaves one record with Passengers: 2.
- A street pickup without a house number or postcode is asked once; a named place is not asked.
- No markup tail played (`live_repeat_hold` reason `markup` when it happens).
- The receptionist-wide table is filled, every row tested.

The "still needs" ask is asking for a missing part, not a re-ask of an answered question (my call), so it does not
count against "≤ 1 re-ask".

## Proof

- TDD for every change, each new test shown failing first; a sabotage row per fix, each proven red in the gate tree.
- Gate: root suite with corpus replay, DB suite, dashboard backend, census (known p4-d1 only), all new rows red.
- Paid text sims (ask first, with the estimate): name corrections (first, surname, both), two trips, two people one
  taxi, a street pickup without number/postcode, a pub, a postcode given in part. Asserts shown failing first. Text
  sims cannot test hearing or audio timing; items 3 and 4 rest on their tests and the owner's calls.
- The real verdict: the owner's 4 calls, scripts written into the plan and given to the owner before calling.

## Left to the builder

- Exact field descriptions and reply wording (short; the token cap holds).
- Detector regexes, settled on fixtures from the owner's test-call emails and synthetic variants (no prod caller data
  printed).
- The street-word list.
- How "finals only" is read from the shadow's `onText` meta.
- Test layout, sabotage row names, gate script version (`gate-r16.sh` from `gate-r15.sh`).
- Branch: a new branch from `fix/lvx192-save-guard` @ `e725952` (prod is `ba608d7` + docs).
