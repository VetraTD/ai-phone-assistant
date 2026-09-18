#!/usr/bin/env node
// ---------------------------------------------------------------------------
// call-corpus/*.json  ->  tests/fixtures/liveCalls/*.json
//
// WHY THIS EXISTS. Three fixes to the Live write-consent gate shipped on
// 2026-09-16, each on a single phone call, each with a consequence nobody
// predicted, and the full suite was green every time. The suite could not model
// what the next call would do because nothing in it had ever seen a real call.
//
// So the seven calls of 2026-09-16/17 become fixtures, and the gate is replayed
// against all seven before anything deploys.
//
// THE CORPUS IS NOT COMMITTED and must not be: assistant speech carries caller
// names and appointment times (LVX24). The FIXTURES are committed, with names
// pseudonymised here, so tests/liveCorpusReplay.test.js runs on a machine that
// has never seen call-corpus/.
//
// WHAT IS RECORDED AND WHAT IS DERIVED, because the difference is the whole
// trustworthiness of the output:
//
//   RECORDED, verbatim from Cloud Logging:
//     - every assistant turn's text and the caller text logged beside it
//     - every write_consent_probe's fields
//     - the outcome the gate actually produced (write_target.outcome)
//
//   DERIVED HERE, and labelled as such in the fixture:
//     - `target`, the slot a write was aiming at. Tool args are never logged
//       (correctly -- they are PHI), so the time is recovered by asking which
//       half-hour of the business day the standing read-back names. That uses
//       readBackMentionsSlot, the function under test. The circularity is
//       broken by COMMITTING the answer: the fixture freezes the derivation, so
//       sabotaging the matcher later changes the test's result and not its
//       expectations. Every derived time carries the sentence it came from, so
//       a human can check it.
//     - `caller_text`, when the logged text cannot be the text the gate saw.
//       live_debug_assistant_turn emits at TURN COMPLETION, so on a turn where
//       the model fired tools and kept talking, the caller text logged beside
//       the eventual reply is from later in the turn than the write. The probe
//       is the authority (LVX122 records three readers getting this wrong), so
//       where the logged text disagrees with `agreed_now` / `gate_ran`, a
//       canonical stand-in is substituted and marked `substituted`.
//
// `expect` is what SHOULD have happened, not what did. Four of these attempts
// were refused and should not have been. That is the point.
//
// Usage:  node scripts/corpus/build-fixtures.mjs [--check]
//         --check  rebuilds into memory and fails if the committed fixtures
//                  differ, so a fixture edited by hand is caught.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { readBackMentionsSlot } from "../../lib/voice/slotMention.js";
import { isAffirmative } from "../../lib/transcriptUtils.js";

const CORPUS_DIR = "call-corpus";
const OUT_DIR = path.join("tests", "fixtures", "liveCalls");

// ---------------------------------------------------------------------------
// Pseudonyms. Applied to every string that leaves this script.
// ---------------------------------------------------------------------------
// Order matters: the spelled-out forms and the all-caps forms go first, so the
// case-insensitive sweep at the end has nothing left to flatten.
const PSEUDONYMS = [
  [/W-H-I-T-E?-F-I-E-L-D/gi, "B-E-L-L"],
  [/W H I T E? ?F I E L D/gi, "B E L L"],
  [/M-A-R-C-U-S/gi, "M-A-R-C-U-S"],
  // CAd978554, 2026-09-18. The name is spelled out TWICE on that call in two
  // different shapes -- the caller says it as bare letters and the assistant
  // reads it back with the commas it inserted itself -- and both have to go
  // before the plain sweep below or eleven loose capitals survive it. The
  // letter counts differ (11 in, 10 out), which is fine: nothing downstream
  // measures the spelling, and the replacement has to be the same person the
  // rest of the corpus calls Marcus Bell.
  [/N,\s*I,\s*T,\s*H,\s*I,\s*N,\s*D,\s*O,\s*D,\s*L,\s*A/g, "M, A, R, C, U, S, B, E, L, L"],
  [/N\s+I\s+T\s+H\s+I\s+N\s+D\s+O\s+D\s+L\s+A/g, "M A R C U S B E L L"],
  [/WHITE?FIELDS?/g, "BELL"],
  [/Whit[ef]field/g, "Bell"],
  [/Whitfields/g, "Bells"],
  [/Whitfield/g, "Bell"],
  [/Whitefield/g, "Bell"],
  [/whit[ef]fields?/gi, "Bell"],
  [/BHAKTA/g, "FARROW"],
  [/DILLAN/g, "ELENA"],
  [/Dillan Bhakta/gi, "Elena Farrow"],
  [/Bhakta/gi, "Farrow"],
  [/Dillan/gi, "Elena"],
  // CAd978554 again. `Annett` is the transcriber's first attempt at the name
  // before it was spelled, so its replacement is a MIS-HEARING of Marcus rather
  // than Marcus itself -- LVX134 measures this call partly on the fact that the
  // name arrived wrong twice, and flattening both to the correct form would
  // erase the thing the fixture records.
  [/Nithin\s+Dodla/gi, "Marcus Bell"],
  [/Dodla/gi, "Bell"],
  [/Nithin/gi, "Marcus"],
  [/Annett/gi, "Marnie"],
  // The company, in the three shapes the transcriber produced for it.
  [/Aadhaar\s+Dak\s+Dairy/gi, "Riverbend Dairy"],
  [/Aadhaar\s+lekar/gi, "Riverbend"],
  [/Aadhaar/gi, "Riverbend"],
  [/Chandni/gi, "Riverbend"],
];

/** Anything still matching this after pseudonymisation is a leak and aborts. */
const LEAK_RE = /whit[ef]|bhakta|dillan|nithin|dodla|annett|aadhaar|chandni/i;

function pseudonymise(s) {
  let out = String(s || "");
  for (const [re, to] of PSEUDONYMS) out = out.replace(re, to);
  return out;
}

// ---------------------------------------------------------------------------
// What each call is for, and what the gate SHOULD do on each of its writes.
//
// Keyed by the call's first eight characters and the index of the write attempt
// within the call, oldest first. Written out by hand, from the transcripts,
// because "what should have happened" is a judgement and cannot be derived from
// a log that records what did.
// ---------------------------------------------------------------------------
const EXPECTATIONS = {
  CAb4c0eb: {
    note: "3.1. The original lost booking. Two refused writes, then 'Perfect, I've booked that in for you', and zero rows.",
    attempts: [
      {
        expect: "refuse",
        why: "fired before any read-back and before the caller agreed to anything. Correct then and correct now.",
      },
      {
        expect: "refuse",
        why:
          "THE PRONOUN FIX, PROVEN ON REAL TEXT FOR THE FIRST TIME. The probe recorded readback_now=false for 'Shall we book that in for you?'; today's confirmReadBackRe matches it, so the read-back half is now satisfied on the very sentence that lost this booking. The write still refuses, and correctly: the caller's answer transcribed as 'Ja.', which isAffirmative cannot read. A caller whose yes does not survive transcription is owed the post-call net, not a guessed write.",
      },
    ],
  },
  CA5b982c: {
    note: "3.1. A cancellation, correctly authorised and correctly written. No booking attempted.",
    attempts: [
      {
        expect: "write",
        why: "the caller heard the appointment read back in full and said yes on that turn. The row must move. This is the control: a fix that breaks this has broken the gate's whole purpose.",
      },
    ],
  },
  CA239046: {
    note: "3.1. Booked, via the consent latch rather than a recognised read-back. Also the call where an appended claim note made the model retract a false claim out loud.",
    attempts: [
      {
        expect: "write",
        why:
          "both halves of consent were present -- readback_now and agreed_now -- so the WRITE-ORDER gate should pass it, and that is what this replay asserts. In production it was held anyway, by the SPELLING gate: the caller's name had not been spelled yet, which is LVX77's lesson. The replay runs with VOICE_SPELL_POLICY=off so that gate's decisions do not masquerade as this one's, and tests/liveWritePathEndToEnd.test.js owns the spelling half.",
      },
      {
        expect: "write",
        why: "the latch carried the agreement across the spelling turn and the row landed. This is the one call in the corpus where the latch worked, and it worked because 3.1 said '4 30 p m' in digits.",
      },
    ],
  },
  CAb76b13: {
    note: "3.8. An unrequested cancel_appointment_db, refused by the silent-turn gate, then announced to the caller as done.",
    attempts: [
      {
        expect: "refuse",
        why:
          "the model fired a destructive write six seconds after ASKING whether to, without waiting. The caller had said nothing at all -- no read-back standing, no agreement, no caller text. This must never become a write, and it is the case that proves a widening went too far.",
      },
    ],
  },
  CAb9ca76: {
    note: "3.8. No writes at all. The model recited its own capabilities mid-call and the caller hung up.",
    attempts: [],
  },
  CA919b69: {
    note: "3.8 with the BLOCKING tool pin. One cancel and six booking attempts; the row landed only when the shared attempt budget ran out.",
    attempts: [
      {
        expect: "write",
        why: "the cancellation, read back in full and agreed to on that turn. Correctly written.",
      },
      {
        expect: "refuse",
        why: "no read-back standing and no agreement on the turn. The model was still offering times.",
      },
      {
        expect: "write",
        why:
          "THE ONE THAT SHOULD HAVE BOOKED. The standing read-back is 'I can book a thirty-minute strategy call ... at three o'clock ... Shall we go ahead?' and the caller said yes to it on that turn. It was refused because a STALE token -- the agreement from the cancellation three caller turns earlier -- differed from the standing read-back, and supersession treated that as reason to veto a turn the caller had just authorised.",
      },
      {
        expect: "write",
        why: "by this point the row exists, and an identical write is duplicate-suppressed by the guards and returns the original success. Asserting 'written' here asserts the dedupe, which is what stops five attempts becoming five rows.",
      },
      { expect: "write", why: "duplicate of the write that already landed." },
      { expect: "write", why: "duplicate of the write that already landed." },
      {
        expect: "write",
        why: "in production this was the attempt that finally wrote, and only because write_attempt_budget_released gave up. It should have been a duplicate of a row that already existed.",
      },
    ],
  },
  // -------------------------------------------------------------------------
  // THE 2026-09-17 CALLS, taken AFTER the gate fixes shipped. Every attempt in
  // this block did the right thing on the day, so they are regression
  // fixtures: they lock in behaviour that had to be fought for rather than
  // describing behaviour that has to be fixed.
  //
  // The gate went 4 for 4 across them, in both directions -- it let four
  // legitimate writes through with no argument, and it refused four that had no
  // read-back or no agreement behind them.
  // -------------------------------------------------------------------------
  CAaef5bd: {
    note: "3.8 on the gate fixes. The first successful booking of the round, and the call that proves the supersession removal on real audio.",
    attempts: [
      {
        expect: "refuse",
        why: "the model fired book_appointment straight after 'I'd like to offer you a free strategy call' -- no time named, nothing to agree to. A token from five caller turns earlier (confirming a phone number) was present and did NOT authorise it.",
      },
      {
        expect: "write",
        why:
          "THE COUNTERFACTUAL, visible in the probe: readback_now=true, agreed_now=true, token_present=FALSE. The token was nulled because the agreement on the ledger was for an earlier read-back, which is precisely the state the old supersession disjunct refused on. Five attempts died on CA03558d in exactly this shape. Here it wrote first time.",
      },
    ],
  },
  CA2556d4: {
    note: "3.8. A cancellation, and the call whose closing turn asked a question and then hung up 1.6 s later.",
    attempts: [
      {
        expect: "refuse",
        why: "the model proposed the cancellation and called the tool before the caller answered. Their reply was 'It's a 12:45' -- a correction, not consent.",
      },
      { expect: "write", why: "re-asked properly, agreed on the turn, cancelled." },
    ],
  },
  CAdfeb9d: {
    note: "3.8. The call whose websocket died mid-sentence: no stop, no close, so finish() never ran and neither did postcall_verify. The one real defect of the round, and nothing to do with the gate.",
    attempts: [
      {
        expect: "refuse",
        why: "'We can now offer the free strategy call and book it for Friday' is a statement, not a read-back, and the caller had not agreed to anything. The model produced a proper read-back on the next turn and the line died before it could be answered.",
      },
    ],
  },
  CA7d4f2d: {
    note: "3.8. A clean booking: one attempt, written first time, zero refusals, clean close.",
    attempts: [
      { expect: "write", why: "read-back naming four thirty PM in words, agreed on the turn, written." },
    ],
  },
  CAa88309: {
    note: "3.8. A cancellation the caller asked for, preceded by the model firing the write before reading anything back.",
    attempts: [
      {
        expect: "refuse",
        why:
          "fired immediately after REPORTING the appointment ('Yes, you have a strategy call scheduled for...'), which is a report and not a proposal. This is the guard that matters most: an unrequested destructive write must never reach the row.",
      },
      { expect: "write", why: "read back as a cancellation, agreed on the turn, cancelled." },
    ],
  },
  CAd48d7b: {
    note: "3.8. Booked despite the model switching to Spanish mid-call and apologising for it three times. The gate was unaffected by any of that.",
    attempts: [
      {
        expect: "write",
        why: "the read-back names the slot and the caller agreed on the turn. Worth keeping because the surrounding turns are a mess -- a gate that reads the conversation's mood rather than its structure would have got this wrong.",
      },
    ],
  },
  CAb08e4e: {
    note: "3.8. A 47-second cancellation, and the clearest example of end_call being called in the same turn as the action -- before the step machine reaches `confirm` and tells the model to ask whether anything else is needed.",
    attempts: [
      { expect: "write", why: "read back as a cancellation, agreed on the turn, cancelled." },
    ],
  },
  // -------------------------------------------------------------------------
  // THE FIRST RESCHEDULE IN THIS CORPUS, and the reason it is here.
  //
  // Before this call there were NINE cancel attempts across fourteen calls and
  // ZERO reschedules. The write-consent gate -- the write-order rule, the
  // latch, the read-back requirement -- was built and tuned entirely on
  // bookings and cancellations, and reschedule went to production having never
  // once been replayed through it. It then failed on the first live attempt.
  //
  // Seven write attempts, zero rows, and the caller told twice that things had
  // been done. The claim guard caught both false claims and the model corrected
  // itself on the call, so the caller did leave knowing the truth.
  //
  // THE ROOT CAUSE IS ONE THING, VISIBLE IN THE PROBES: the gate needs a
  // read-back AND agreement true at the same instant, and across all seven
  // attempts they were never simultaneously true.
  //
  //   readback=T agreed=F   the model fired 4 s after asking, before any answer
  //   readback=F agreed=T   the caller said yes to "Are you sure you would like
  //                         me to cancel your appointment?" -- a confirmation
  //                         that names no time, so it is not a read-back
  //
  // The second is the new one and the reason this call matters. Every
  // successful cancellation in this corpus was "read back in full"; this model
  // asked a detail-free question instead, and a detail-free question can never
  // satisfy a rule that looks for the slot. The gate is phrasing-dependent, and
  // this is the phrasing that broke it.
  // -------------------------------------------------------------------------
  CAb4427e: {
    note: "3.8. The first reschedule ever replayed here, and it failed -- seven attempts, zero rows, two false claims. A read-back and an agreement were never true at the same moment.",
    attempts: [
      {
        expect: "refuse",
        why: "fired while the three offered Monday times were still on the table and the caller had chosen none of them. No read-back, no agreement. Correct.",
      },
      {
        expect: "refuse",
        why: "'Shall I reschedule your appointment to Monday, September twenty-first at eleven-thirty AM?' was spoken four seconds earlier and the caller had not answered yet. readback=true, agreed=false. Correct, and the same shape CA2556d4 and CAb76b13 already record -- the model routinely writes before the answer exists.",
      },
      {
        expect: "refuse",
        why: "cancel fired with nothing read back and nothing agreed. Correct.",
      },
      {
        // THE FIXTURE THIS CALL WAS ADDED FOR. It is expected to FAIL until the
        // read-back stops being inferred from the model's phrasing.
        expect: "write",
        why:
          "THE ONE THAT MUST CHANGE. The assistant asked 'Are you sure you would like me to cancel your appointment?' and the caller said yes -- agreed_now=true, recorded by the probe. The appointment was unique, on file, and had been read to the caller at 00:41:57 ('Friday, September eighteenth, at three PM'). A human receptionist cancels here. The gate refused because the confirming sentence named no time, which is a fact about the model's wording and not about whether this caller consented. Until a read-back is something the system OWNS rather than something it parses out of the model's speech, this attempt refuses and the caller loses the thing they rang to do.",
      },
      {
        expect: "refuse",
        why: "the held-write retry, and it could not help: by now the standing reply was 'I've successfully rescheduled your appointment...' -- a claim, not a read-back. A retry fired at the moment the evidence has aged out is a retry that cannot succeed.",
      },
      {
        // These last two were authored expecting a refusal, because on the day
        // NOTHING had landed and every later attempt was still chasing an
        // uncancelled row. Once attempt 3 writes, they stop being attempts and
        // become duplicates -- and the corpus already has a convention for
        // that, from CA03558d: "duplicate of the write that already landed."
        //
        // The expectations were contingent on an earlier attempt's outcome and
        // nothing said so. The replay is what noticed.
        expect: "write",
        why: "a duplicate of the cancellation that now lands at attempt 3. The pack answers 'That appointment has been cancelled.' without touching the row, which is the duplicate guard doing its job -- cancelling an already-cancelled appointment is a no-op, not a second write.",
      },
      {
        expect: "write",
        why: "the same duplicate, one turn later. On the day this was the model re-asking properly ('Would you like me to proceed with cancelling it now?') and firing before the answer arrived; with the cancellation already committed there is nothing left for it to get wrong.",
      },
    ],
  },
  CA03558d: {
    note: "3.8 with the supersession fix that was reverted. The worst call: one cancel, six booking attempts, ZERO booked rows, three live_tool_rounds_capped, five writes in 2.3 seconds, and 'Yes, I have confirmed that your appointment is booked.'",
    attempts: [
      {
        expect: "write",
        why: "the cancellation, read back in full and agreed to on that turn. Correctly written -- and it is why the owner has no Friday appointment.",
      },
      {
        expect: "refuse",
        why:
          "no read-back was standing: the previous turn was 'Your appointment ... has been cancelled. Is there anything else?'. A token from the CANCELLATION was present, and this is exactly the write it must not authorise -- a booking at the time that was just cancelled. CA8c019c's shape.",
      },
      {
        expect: "write",
        why:
          "THE LOST BOOKING. The caller agreed to 'I have you down for a strategy call on Friday, September eighteenth at three thirty PM. Shall we go ahead and book that?' The standing read-back was the spelling check 'M-A-R-C-U-S ... Is that correct?' -- which the caller also answered yes to -- so both halves of the turn-local rule were satisfied and the write was refused anyway, on supersession.",
      },
      { expect: "write", why: "duplicate of the write that should already have landed." },
      { expect: "write", why: "duplicate of the write that should already have landed." },
      { expect: "write", why: "duplicate of the write that should already have landed." },
      { expect: "write", why: "duplicate of the write that should already have landed." },
    ],
  },
  // -------------------------------------------------------------------------
  // 2026-09-18, 01:55-02:21, four calls on voice-uk-prod-00077-xp9 (b87ee81).
  // The first two are what the gate looks like when it is RIGHT -- kept as
  // regression fixtures, not as a to-do list -- and the third is the call that
  // found LVX140.
  // -------------------------------------------------------------------------
  CA94f2b4: {
    note: "3.8. The FIRST reschedule ever to complete through the consent gate. One write, both halves of consent true at the same instant, and the row MOVED rather than being cancelled and rebooked.",
    attempts: [
      {
        expect: "write",
        why:
          "both halves present and turn-local: 'Just to confirm, you would like to move your appointment to Monday, September 21st at 1:00 PM?' and the caller answered inside the model's four-second gap. readback_now=true, agreed_now=true, no token needed. This is the shape every earlier reschedule in this corpus failed to reach.",
      },
    ],
  },
  CA64a36c: {
    note: "3.8. Book, cancel and reschedule in ONE call, all three correct, every claim backed, verdict ok. It refused to guess between two appointments: looked them up, asked which, read the chosen one back before writing.",
    attempts: [
      {
        expect: "refuse",
        why:
          "fired on 'Would Tuesday, September twenty-second at ten a-m Central work for the separate appointment?' -- a proposal, not a read-back the caller had answered. readback_now=false, agreed_now=false, and a token was present from an earlier agreement about a DIFFERENT appointment. Exactly the state a surviving token must not authorise.",
      },
      {
        expect: "write",
        why:
          "the same slot one turn later, after 'So, I have you down for a Strategy Call on Tuesday, September twenty-second at ten a-m Central -- shall I go ahead and book that?' and the caller's yes. Both halves true on the turn, point-verified slot, and it wrote first time.",
      },
      {
        expect: "refuse",
        why:
          "the caller asked to cancel 'my appointment' and there were TWO. Nothing was read back, nobody had agreed to anything, and guessing is the failure this gate exists to prevent. The model then did the right thing without being told: looked them up and asked which.",
      },
      {
        expect: "write",
        why:
          "after 'Shall I go ahead and cancel your appointment on Tuesday, September twenty-second at ten a-m?' and 'Actually, let's cancel the Tuesday one.' The caller named the one they meant and the sentence they answered names the same time.",
      },
      {
        expect: "write",
        why:
          "the reschedule, read back in full ('Shall I go ahead and reschedule your appointment to Monday, September twenty-first at two p-m?') and agreed to on the turn. Third correct write of one call.",
      },
    ],
  },
  CAd97855: {
    note: "3.8, the immediate repeat of CA64a36c with no code change between them. A refused reschedule was followed by 'I have successfully rescheduled...' and the claim guard stayed silent -- LVX140 -- and the fiction then took the caller's consent to cancel an appointment that did not exist.",
    attempts: [
      {
        expect: "refuse",
        why:
          "'That time is available. Would you like me to reschedule your appointment to Tuesday, September 22, at 3:00 PM?' and the tool fired three seconds later, before any answer. readback_now=true, agreed_now=FALSE -- the model asked and did not wait. Refusing is right; what happened next is the item.",
      },
      {
        expect: "refuse",
        why:
          "a cancellation with nothing standing: readback_now=false, agreed_now=false. The model has by this point told the caller the reschedule succeeded, and is acting on its own sentence rather than on anything the caller said.",
      },
      {
        expect: "write",
        why:
          "THE GATE IS RIGHT HERE AND THE CALL IS STILL WRONG, which is why this attempt is in the corpus. 'Just to confirm, you would like me to cancel your appointment on Tuesday, September 22, at 3 PM?' -- read back, agreed to, turn-local. The consent is real. The APPOINTMENT is not: it exists only in the false claim two turns earlier, and the row that died was the caller's Monday 2 PM one. No consent gate can see that; the claim guard was the thing that could, and it said nothing.",
      },
      {
        expect: "refuse",
        why:
          "the booking, fired before the answer again: 'To confirm, you'd like to book your free strategy call ... on Wednesday, September 23, at 11:30 AM?' with agreed_now=false. The token still standing was ten caller turns old and matched no current read-back.",
      },
      {
        expect: "refuse",
        why:
          "the held-write retry, half a second later. gate_ran=false, silent_turn_verdict=refused_no_consent: a retry fired before the caller had said anything cannot be more authorised than the write it is retrying.",
      },
      {
        expect: "refuse",
        why:
          "the same retry nine seconds on, after the model re-asked properly ('Just to confirm, I am booking your free strategy call for Wednesday, September 23, at 11:30 AM. Shall I go ahead and book that?') and fired again before the answer. Still refused_no_consent, and still right.",
      },
      {
        expect: "write",
        why:
          "the caller finally answers -- 'Yeah, that works. Yes.' -- and the booking lands. readback_now=true, agreed_now=true, and it is the one row this call actually produced. It is also the row that later vouched for the abandoned reschedule and suppressed the post-call escalation.",
      },
    ],
  },
  // -------------------------------------------------------------------------
  // 2026-09-18 05:08, the first call on the LVX140/141/142 build
  // (voice-uk-prod-00078-8fp, image 963dfef). It exercised NONE of the three
  // and found two defects neither of them covered.
  // -------------------------------------------------------------------------
  CA239c7c: {
    note: "3.8 on the LVX140 build. The reschedule was refused because the caller answered by naming the time back, and the model then said it had been done. claim_audit claimed:0 -- the sentence was never detected, so none of LVX140's work could reach it.",
    attempts: [
      {
        expect: "refuse",
        why:
          "fired the write while the offered times were still on the table and nothing had been read back: readback_now=false, agreed_now=false. The model asking 'which of those works best' and calling reschedule_appointment_db eight seconds later is the shape the gate exists for. Correct.",
      },
      {
        expect: "write",
        // THE CALLER TEXT IS DECLARED, and this is the only attempt in the
        // corpus where it is. The log records `agreed_now` and never the
        // sentence behind it, and on this call the utterance records close out
        // of order with the turn log, so the derivation picks the wrong one of
        // two adjacent caller turns. This is the transcript's own text for the
        // reply to that read-back; it is marked `declared` in the fixture so it
        // can never be read as observed.
        caller_text: "the Thursday 2 p.m.",
        why:
          "THE ONE LVX144 CHANGES. 'Shall we reschedule your appointment to Thursday, September 24 at 2:00 PM?' answered with 'the Thursday 2 p.m.' -- the caller naming the exact slot back, which is how people confirm times out loud. readback_now=true and agreed_now=FALSE, so the write was refused, changed_rows was 0, and the model told the caller it had been done anyway. The slot named is the slot being written, on the right weekday, with no withdrawal and no question mark, so this now reads as agreement and writes.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Slot derivation. Every corpus call is about Friday 18 September 2026; the
// grid is that business day at half-hour steps.
// ---------------------------------------------------------------------------
const CORPUS_DATE = "2026-09-18";
// THE GRID IS NO LONGER ONE DAY, and it had to stop being one.
//
// Every corpus call up to 2026-09-17 was about Friday 18 September, so a
// one-day grid derived their slots exactly. The calls of 2026-09-18 are about
// the following week -- Monday 21st, Tuesday 22nd, Wednesday 23rd -- and
// readBackMentionsSlot REFUSES a slot whose weekday the sentence contradicts
// (lib/voice/slotMention.js:195). So "Monday, September 21st at 1:00 PM"
// matched nothing on a Friday grid, every target came back null, and all three
// new calls failed the replay on the availability invariant: "That time has not
// been checked yet." A gate defect that is not there.
//
// Saturday and Sunday are left out: the tenant is closed and no read-back in
// the corpus names them.
const CORPUS_DAYS = [CORPUS_DATE, "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];
const GRID = (() => {
  const out = [];
  for (let h = 8; h <= 19; h += 1) {
    for (const m of ["00", "30"]) out.push(`${String(h).padStart(2, "0")}:${m}`);
  }
  return out;
})();

/**
 * Which grid slots does this sentence name?
 *
 * Returns whole naive datetimes now, not bare times, because a multi-day grid
 * makes the day part of the answer.
 */
function slotsNamedIn(text) {
  const hits = [];
  for (const day of CORPUS_DAYS) {
    for (const hhmm of GRID) {
      if (readBackMentionsSlot(text, `${day}T${hhmm}`)) hits.push(`${day}T${hhmm}:00`);
    }
  }
  // A SENTENCE THAT NAMES A TIME AND NO WEEKDAY names it on every day in the
  // grid, and that is one proposal rather than four. Collapsed onto the corpus
  // date, which is exactly what this function returned when the grid was a
  // single day -- so every fixture written before 2026-09-18 derives the same
  // target it did then, and the widening is invisible to them.
  const times = new Set(hits.map((s) => s.slice(11, 16)));
  if (hits.length > 1 && times.size === 1) return [`${CORPUS_DATE}T${[...times][0]}:00`];
  return hits;
}

const EVENTS_KEPT = new Set([
  "live_debug_assistant_turn",
  "write_consent_probe",
  "write_order_refused",
  "write_target",
  "write_refused_no_consent",
  "write_attempt_budget_released",
  "live_tool_rounds_capped",
  "live_write_retried",
  "tool_duration",
  "live_call_summary",
  "live_claim_unbacked_by_action",
  "live_claim_without_action",
]);

function loadCall(file) {
  const raw = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, file), "utf8"));
  return raw
    .map((r) => r.jsonPayload)
    .filter((p) => p && EVENTS_KEPT.has(p.event))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

function build(file) {
  const events = loadCall(file);
  const sid = events[0]?.callSid || file.replace(/\.json$/, "");
  const short = sid.slice(0, 8);
  const expectations = EXPECTATIONS[short];
  if (!expectations) throw new Error(`no EXPECTATIONS entry for ${short}`);

  const summary = events.find((e) => e.event === "live_call_summary") || {};

  // ---- the turns -----------------------------------------------------------
  const turns = events
    .filter((e) => e.event === "live_debug_assistant_turn")
    .map((e, i) => ({
      i,
      ts: e.ts,
      step: e.step,
      caller: pseudonymise(e.user_text || ""),
      assistant: pseudonymise(e.text || ""),
    }));

  // ---- the write attempts --------------------------------------------------
  // One attempt per write_consent_probe. The target/refusal events share its
  // millisecond, so they are matched by tool and nearest timestamp.
  const probes = events.filter((e) => e.event === "write_consent_probe");
  const targets = events.filter((e) => e.event === "write_target");
  const durations = events.filter((e) => e.event === "tool_duration");
  const orderRefusals = events.filter((e) => e.event === "write_order_refused");
  const consentRefusals = events.filter((e) => e.event === "write_refused_no_consent");
  const budgetReleases = events.filter((e) => e.event === "write_attempt_budget_released");
  const nearest = (list, ts, tool) => {
    let best = null;
    let bestGap = Infinity;
    for (const e of list) {
      if (e.tool !== tool) continue;
      const gap = Math.abs(Date.parse(e.ts) - Date.parse(ts));
      if (gap < bestGap) {
        bestGap = gap;
        best = e;
      }
    }
    return bestGap <= 50 ? best : null;
  };

  const attempts = probes.map((p, i) => {
    const target = nearest(targets, p.ts, p.tool);
    const exp = expectations.attempts[i] || {};

    // THE OUTCOME COMES FROM tool_duration, NOT write_target. write_target is
    // emitted by the booking-target branch of the guards, so cancellations
    // produce none at all and read as "unknown" -- which is how the first
    // version of this file scored a successful cancel as a mystery.
    // tool_duration fires for every tool, and its two flags separate the three
    // outcomes that matter: success is a row, gated is a gate holding it, and
    // neither is a failure on the way to the database.
    const dur = nearest(durations, p.ts, p.tool);
    const observed = dur
      ? dur.success === true
        ? "written"
        : dur.gated === true
          ? "held"
          : "failed"
      : (target?.outcome ?? "unknown");

    // WHICH gate held it. "held" alone cannot tell the write-order gate from
    // the spelling gate, and on CA239046 the difference is the whole story:
    // both halves of consent were present and the write was held anyway,
    // because the caller's name had not been spelled yet.
    const refusedBy = nearest(orderRefusals, p.ts, p.tool)
      ? "write_order"
      : nearest(consentRefusals, p.ts, p.tool)
        ? "no_consent"
        : observed === "held"
          ? "other_gate"
          : null;
    const budgetReleased = Boolean(nearest(budgetReleases, p.ts, p.tool));

    // The read-back standing when this write ran: the last assistant turn
    // before it. That is what lastReplyText held.
    const prior = turns.filter((t) => t.ts < p.ts);
    const standing = prior.length ? prior[prior.length - 1] : null;
    // The read-back the caller AGREED to, if the probe says one exists: walk
    // back `caller_turns_since_agreement` caller turns from the standing one.
    const back = Number(p.caller_turns_since_agreement);
    const agreedTurn =
      Number.isFinite(back) && prior.length > back ? prior[prior.length - 1 - back] : null;

    // Derive the slot from the STANDING read-back first, because that is the
    // proposal the write is following. Preferring the agreed one put
    // CA919b69's third attempt at four-thirty -- the time of the cancellation
    // the token happened to be recorded on -- when the sentence the caller was
    // actually answering said three o'clock. Fall back to the agreed read-back
    // only when the standing one names no time at all, which is CA03558d's
    // spelling check.
    const source = standing?.assistant && slotsNamedIn(standing.assistant).length
      ? standing
      : agreedTurn;
    const named = source ? slotsNamedIn(source.assistant) : [];

    // The caller text the gate saw. The probe is the authority.
    //
    // AND NOTHING IN THE LOG RECORDS IT. The probe carries `agreed_now` but not
    // the sentence it judged, so this is reconstructed from the turn AFTER the
    // standing read-back -- which is right whenever the transcript lands inside
    // its own turn and wrong when it does not.
    //
    // CA239c7c is where that bit. Its two caller turns around the read-back are
    // "the Thursday 2 p.m." and a 10-character fragment, the utterance records
    // close out of order with the turn log, and the heuristic picks the wrong
    // one. So an expectation may DECLARE the caller text, and when it does the
    // fixture says `declared` rather than `logged` -- because a hand-written
    // input that reads as an observed one is how a suite starts proving what it
    // was told instead of what happened.
    const logged = standing ? (turns[standing.i + 1]?.caller ?? "") : "";
    const loggedAgrees = isAffirmative(logged) === Boolean(p.agreed_now);
    const loggedRan = logged.trim() !== "" === Boolean(p.gate_ran);
    const useLogged = Boolean(logged) && loggedAgrees && loggedRan;
    const substitute = !p.gate_ran ? "" : p.agreed_now ? "Yes." : "Let me think about that.";
    const declared = typeof exp.caller_text === "string" ? exp.caller_text : null;

    return {
      at: p.ts,
      tool: p.tool,
      probe: {
        gate_ran: p.gate_ran,
        readback_now: p.readback_now,
        agreed_now: p.agreed_now,
        token_present: p.token_present,
        token_matches_current_readback: p.token_matches_current_readback,
        caller_turns_since_agreement: p.caller_turns_since_agreement ?? null,
        readback_ambiguous_ask: p.readback_ambiguous_ask,
        silent_turn_verdict: p.silent_turn_verdict,
      },
      observed,
      refused_by: refusedBy,
      budget_released: budgetReleased,
      expect: exp.expect || "UNREVIEWED",
      why: exp.why || "",
      // Indices, not text. Two turns on CAb76b13 are byte-identical ("On Friday
      // afternoon, we have openings at three thirty and four o'clock."), so
      // matching a replayed turn to its attempts by text would put both
      // attempts on the first one.
      standing_turn: standing ? standing.i : null,
      agreed_turn: agreedTurn ? agreedTurn.i : null,
      standing_read_back: standing ? standing.assistant : null,
      agreed_read_back: agreedTurn ? agreedTurn.assistant : null,
      target: named.length === 1 ? named[0] : null,
      target_candidates: named,
      target_from: source ? source.assistant : null,
      target_derived: true,
      caller_text: declared ?? (useLogged ? logged : substitute),
      caller_text_source: declared !== null ? "declared" : useLogged ? "logged" : "substituted",
    };
  });

  return {
    callSid: short,
    model: summary.model || null,
    note: expectations.note,
    date: CORPUS_DATE,
    counts: {
      turns: turns.length,
      probes: probes.length,
      write_order_refused: events.filter((e) => e.event === "write_order_refused").length,
      write_refused_no_consent: events.filter((e) => e.event === "write_refused_no_consent").length,
      tool_rounds_capped: events.filter((e) => e.event === "live_tool_rounds_capped").length,
      attempt_budget_released: events.filter((e) => e.event === "write_attempt_budget_released").length,
      claim_unbacked_by_action: events.filter((e) => e.event === "live_claim_unbacked_by_action").length,
    },
    claim_audit: summary.claim_audit || null,
    guards: summary.guards || null,
    turns,
    attempts,
  };
}

// ---------------------------------------------------------------------------

const check = process.argv.includes("--check");

if (!fs.existsSync(CORPUS_DIR)) {
  console.error(
    `${CORPUS_DIR}/ is not on this machine. It is gitignored on purpose; see its README for the re-pull command.`
  );
  process.exit(check ? 0 : 1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json")).sort();
let differed = 0;

for (const file of files) {
  const fixture = build(file);
  const json = `${JSON.stringify(fixture, null, 2)}\n`;

  // A missing EXPECTATIONS entry must be LOUD. The first version defaulted an
  // unreviewed attempt to "refuse", which is the answer that makes a broken
  // gate look correct -- exactly the direction a fixture must never guess in.
  const unreviewed = fixture.attempts.filter((a) => a.expect === "UNREVIEWED");
  if (unreviewed.length) {
    console.error(
      `REFUSING TO WRITE ${fixture.callSid}: ${unreviewed.length} of ${fixture.attempts.length} ` +
        `write attempts have no EXPECTATIONS entry. Add them by hand, from the transcript.`
    );
    for (const a of unreviewed) console.error(`   ${a.at}  ${a.tool}  observed=${a.observed}`);
    process.exit(1);
  }

  const leak = json.match(LEAK_RE);
  if (leak) {
    console.error(`REFUSING TO WRITE ${fixture.callSid}: a real name survived pseudonymisation (${leak[0]})`);
    process.exit(1);
  }

  const out = path.join(OUT_DIR, `${fixture.callSid}.json`);
  const existing = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
  if (check) {
    if (existing !== json) {
      differed += 1;
      console.error(`DIFFERS: ${out}`);
    }
    continue;
  }
  fs.writeFileSync(out, json);
  console.log(
    `${fixture.callSid.padEnd(9)} turns=${String(fixture.counts.turns).padStart(2)} ` +
      `attempts=${String(fixture.attempts.length).padStart(2)} ` +
      `should-write=${fixture.attempts.filter((a) => a.expect === "write").length} ` +
      `derived-slot=${fixture.attempts.filter((a) => a.target).length}/${fixture.attempts.length}` +
      `${existing === json ? "" : "  (changed)"}`
  );
}

if (check && differed) {
  console.error(`\n${differed} fixture(s) differ from a fresh build. Re-run without --check.`);
  process.exit(1);
}
