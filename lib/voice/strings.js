// ---------------------------------------------------------------------------
// strings.js — localized fixed caller-audible strings for the voice pipeline.
//
// Every hardcoded line a caller can hear (fillers, silence nudges, goodbyes,
// the default greeting, transfer lines, error apologies, tool-fallback lines)
// lives here in one table per language, so a Spanish-configured business
// never mixes English boilerplate into an otherwise-Spanish call.
//
// Language selection: the FIRST configured language is the call's primary
// (single-language business → that language; multi-language → first entry).
// LLM replies themselves follow the caller's language via the prompt rule in
// services/gemini.js — these tables only cover the non-LLM fixed lines.
//
// Known limitations (deliberate for this pass):
//   - the deterministic take-message fallbackFlow script is English-only
//   - business-authored copy (custom greeting, recording disclosure) is
//     spoken exactly as written, never auto-translated
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE COMPLETION-CLAIM PREDICATE, WRITTEN ONCE. LVX107, 2026-09-10.
//
// This regex had been widened three times for three object shapes -- `you`
// (LVX94), a determiner-headed noun phrase (LVX103), and bare proper names,
// which was still missing. A fourth alternation was the wrong move, and the
// reason is the verb list: it carries a bare `down` for "I have you down for
// Wednesday", so any general object slot in front of it turns "I have your
// number written down" into a fabrication alert. A negative fixture has
// guarded that exact sentence since LVX57.
//
// So the object side loosens and THE VERB SIDE TIGHTENS AT THE SAME TIME,
// which is the whole trade:
//
//   OBJECT   any 1-3 word run that is not headed by a closed-class function
//            word. This is one rule about sentence shape, and it covers the
//            pronoun, the noun phrase and the proper name without the regex
//            knowing any of them by name.
//   VERB     that loose object may only be followed by an UNAMBIGUOUS booking
//            participle. `down`, `noted`, `recorded`, `sent` keep the tight
//            `you`-only object they always had.
//
// That split is not a preference, it is measured. Putting `moved|recorded|sent`
// into the loose slot makes "I have your message recorded for the team" and
// "I have your details sent over to them" both read as completion claims.
//
// Certified against 38 positives and 62 negatives, 24 of which are verbatim
// assistant turns from the production calls of 2026-09-10 -- seven real claims
// the old predicate missed, and seventeen offers and proposals from the same
// calls that must stay silent ("I have openings at 9 AM, 1 PM, or 4 30 PM",
// "I have that set for tomorrow ... Shall I go ahead and book that?").
//
// The narrow and wide predicates are BUILT FROM THESE SHARED PIECES rather
// than maintained as two near-identical literals. That is also LVX107: LVX97
// was one alternation present in one copy and absent from the other, and two
// hand-maintained supersets drift by construction.
// ---------------------------------------------------------------------------

/**
 * Who is doing the claiming.
 *
 * `you have` is here because of 2026-09-10: "So you now have a consultation
 * scheduled for Monday" was spoken on a real call and counted as zero claims,
 * which is what made `postcall_verify` return `row_without_claim` on a call
 * whose booking was perfectly real. The lookbehind keeps the QUESTION form out
 * -- "Do you have that appointment booked already?" is the assistant asking,
 * not claiming.
 */
const CLAIM_SUBJECT = String.raw`(?:(?:i|we)(?:’ve|'ve)|(?:i|we)\s+have|(?<!\b(?:do|did|does)\s)you(?:’ve|'ve)|(?<!\b(?:do|did|does)\s)you\s+(?:now\s+)?have)`;

/** The object slot that AMBIGUOUS verbs are restricted to. Unchanged since LVX94. */
const CLAIM_TIGHT_OBJECT = String.raw`(?:you\s+)?(?:booked|scheduled|cancell?ed|rescheduled|moved|recorded|noted|sent|made a note|put you down|got you down|down)`;

/**
 * Closed-class words an object may not start with. A closed class is the point:
 * this is a grammatical rule, not a list of observed objects, which is what the
 * determiner list it replaces had become. `not` and `never` are what keep
 * "I have not booked that yet" out; `another`, `two`, `some` are what keep
 * "I have another client booked at that time" out.
 */
const CLAIM_OBJECT_STOPWORDS = String.raw`(?!(?:not|never|no|yet|another|other|one|two|three|four|five|six|several|many|few|some|any|both|all|nothing|anything|something|to|been|being)\b)`;

/** Any short object, followed by a participle that can only mean "booked". */
const CLAIM_LOOSE_OBJECT = String.raw`(?:${CLAIM_OBJECT_STOPWORDS}[a-z0-9’'-]+\s+){1,3}(?:booked|scheduled|cancell?ed|rescheduled|confirmed)\b`;

/**
 * "that's all done" -- the `all` was added 2026-09-10 after that exact sentence
 * was spoken on a completed booking and counted as nothing.
 */
const claimCopular = (predicates) =>
  String.raw`(?:that'?s|it'?s|you'?re|you are)\s+(?:all\s+)?(?:${predicates})`;

/**
 * The noun-subject branch. The clause-boundary prefix is load-bearing and must
 * not be relaxed: it is the only thing that stops "the phone number the
 * appointment is booked under?" from reading as a claim.
 */
const claimNounSubject = (verbs) =>
  String.raw`(?:^|["'“‘]|[.,;:!?—-]\s*|\b(?:and|but|so|then|okay|ok|great|perfect|yes|now|also|plus|confirm)[,]?\s+)(?:your|the|that|this|those|these|both)\s+(?:appointments?|bookings?|calls?|consultations?)\b[^.?!]{0,60}?\s+(?:is|are|'s|(?:has|have)\s+(?:now\s+)?been)\s+(?:now\s+)?(?:${verbs})\b`;

/**
 * @param {{wide?: boolean}} opts - `wide` adds the LVX97 phrasings. The wide
 *   predicate must remain a strict SUPERSET of the narrow one; because both are
 *   assembled here from the same pieces, that is now true by construction
 *   rather than by a test that notices when it stops being true.
 */
function buildCompletionClaimRe({ wide = false } = {}) {
  const copular =
    String.raw`booked|scheduled|cancell?ed|rescheduled|confirmed|updated|all set|set|sorted|done` +
    (wide ? String.raw`|finali[sz]ed|taken care of` : "");
  const nounVerbs =
    String.raw`booked|scheduled|confirmed|cancell?ed|rescheduled|moved|updated|all\s+set|set|sorted|done` +
    (wide ? String.raw`|finali[sz]ed` : "");
  // "we're all set" is wide-only on purpose: "we're booked up on Wednesday" and
  // "we're done for today" are ordinary business speech, so this branch keeps a
  // deliberately short predicate list of its own.
  const wePlural = wide ? String.raw`|(?:we'?re|we are)\s+(?:all set|confirmed|finali[sz]ed)` : "";
  return new RegExp(
    String.raw`(?:\b(?:${CLAIM_SUBJECT}\s+(?:got\s+)?(?:${CLAIM_TIGHT_OBJECT}|${CLAIM_LOOSE_OBJECT})|${claimCopular(copular)}${wePlural})\b|${claimNounSubject(nounVerbs)})`,
    "i"
  );
}

/**
 * A bounded gap for the read-back patterns. LVX107's shape: every one of these
 * regexes assumed two words sit next to each other and was defeated by an
 * ordinary English word between them ("Is that ALL correct?").
 *
 * One word, no punctuation, so it cannot reach across a clause boundary. The
 * lookahead excludes the DETAIL nouns, because "Is that name correct?" is the
 * assistant checking a spelling, not reading a proposal back -- and the write
 * gate spends its escape-hatch budget on the difference (LVX104).
 */
const READ_BACK_GAP = String.raw`\s+(?!(?:name|names|spelling|number|address|email|phone|surname)\b)[a-z’'-]+`;

/**
 * The adjective must END the clause.
 *
 * Found by running the candidate against fixtures rather than by reading it:
 * without this, "Is that the right number to reach you on?" is a read-back and
 * hands the write gate a false `readBackMade=true`. It separates the predicate
 * ("Is that all right?") from the attributive ("the right number").
 */
const READ_BACK_END = String.raw`(?=\s*(?:[?.!,]|$))`;

/**
 * `<head> <tail>` adjacent, OR with exactly one ordinary word between them.
 *
 * THE TWO HALVES ARE NOT SYMMETRIC AND THAT IS THE POINT. The adjacent form is
 * left exactly as it always was, with a plain `\b` — it is unambiguous, because
 * nothing can sit between the words to change what they mean.
 *
 * Only the GAPPED form carries READ_BACK_END. Applying the terminal guard to
 * both was a real regression, shipped and caught on the very next call: it
 * silently narrowed four phrasings that had matched for months —
 *
 *   "Is that correct for you?"      "Is that right for Thursday?"
 *   "Is that okay with you?"        "Does that sound right to you?"
 *
 * — because the adjective no longer ended the clause. A miss here is not
 * cosmetic: it spends the write gate's escape-hatch budget (LVX104), so a fix
 * for LVX107 had begun causing the exact harm LVX107 is about.
 *
 * The guard belongs only where the ambiguity it resolves can arise: once a word
 * IS between them, "the right number" becomes reachable and the adjective has to
 * close the clause to prove it is a predicate.
 */
const readBackGapped = (head, tail) =>
  String.raw`${head}\s+${tail}\b|${head}${READ_BACK_GAP}\s+${tail}${READ_BACK_END}`;

/**
 * The verb that turns a modal into an OFFER TO ACT, as one list.
 *
 * Three alternations of confirmReadBackRe front the same offer -- "shall I X",
 * "would you like me to X", "you'd like to X" -- and each had drifted into its
 * own verb list. On 2026-09-11 that cost three refusals across two calls, each
 * on a verb the OTHER lists had:
 *
 *   "Are you sure you'd like to GO AHEAD with that?"   -- `go ahead` was on the
 *                                                        `would you like me to`
 *                                                        list and not this one
 *   "Would you like me to MAKE that change?"           -- `make` was on none
 *   "Shall I TRY to make that change now?"             -- `try` was on none
 *
 * All three are textbook read-backs. The gate refused two and its ceiling
 * released the third unchecked, and the caller was moved off the time they
 * asked for while being told it was unavailable. Same shape as LVX107 one level
 * up, where the MODAL was the incomplete list.
 *
 * STILL A CLOSED CLASS, and that is the point rather than an oversight. It is
 * the only thing separating "shall I book that?" from "can I get your full
 * name?", and a modal followed by any verb at all would stop the gate gating --
 * the model would only have to front a question with a modal before a write.
 * Certified against both directions in tests/confirmReadBackRe.test.js: `check`,
 * `see`, `get`, `ask` and `help` are deliberately absent and are asserted so.
 */
const READ_BACK_ACTION_VERB = String.raw`(?:go\s+ahead|book|cancel|move|reschedule|change|make|update|put|try)`;

export const STRINGS = {
  en: {
    // Which table this is. Carried on the table itself so a consumer that has
    // been handed the strings does not also have to be handed the language —
    // lib/spellingSignal.js needs it to pick a letter lexicon, and threading
    // the config that far just to re-derive it would be the third place the
    // same lookup happens.
    lang: "en",
    filler: "One moment.",
    // Tool-specific hold lines. "One moment." in front of every lookup is
    // accurate and says nothing; a receptionist who is checking the diary says
    // so. Same one-per-turn budget as the generic filler — this changes WHAT is
    // said during a tool round, never how often.
    // One set PER ACTION, cycled within a call.
    //
    // Short, but SPECIFIC — and the second of those was learned the hard way.
    //
    // Cut to two words ("Let me check.") they were cheap but vague, and a
    // caller heard one during a reschedule and said it "is not the right thing
    // to say". Two words cannot carry context. Every line now names what it is
    // doing, at a cost of roughly half a second of speech.
    //
    // Still bounded: audio plays serially, so every word delays the reply
    // queued behind it. A test caps these at seven words in both locales.
    //
    // Only the appointment actions have lines at all. Taking a message and
    // recording a quote are quick writes the caller just dictated -- they know
    // what they said, and being told it is being written down is noise.
    holdAvailability: [
      "One sec, checking the calendar.",
      "Let me see what's open.",
      "Checking the calendar now.",
    ],
    holdLookup: ["Let me pull up your appointment.", "One sec, finding your appointment."],
    holdBook: ["Getting that scheduled now.", "Putting that on the calendar."],
    holdReschedule: ["Moving that for you now.", "Getting that changed now."],
    holdCancel: ["Canceling that for you now.", "Taking care of that now."],
    // NOT keyed to a tool — keyed to what the CALLER just said.
    //
    // Every other line here waits on a tool, and a tool cannot exist until
    // Gemini has finished a round trip. The spelling turn is the one place that
    // wait is avoidable: lib/spellingSignal.js can tell from the transcript
    // alone that letters were just spelled, so the line can go out at turn
    // start rather than a second and a quarter later.
    //
    // Reported live 2026-08-31, and it was the ONLY long silence the owner
    // could still hear. It is also the turn least likely to call a tool at all
    // — the model acknowledges and reads the details back — so nothing keyed to
    // a tool was ever going to cover it.
    holdSpelling: ["Writing that down.", "Let me get that down."],
    // Played when the model goes quiet mid-turn, which in practice means a
    // slow tool round (see lib/voice/llmTurn.js's "stalled" event). Reassures
    // without promising anything, and works whether the wait ends in an
    // answer or an apology.
    stillWorking: "Still working on that.",
    maxDuration:
      "I'm sorry, but we've reached the maximum call time. Please call back if you need further assistance. Goodbye!",
    fallbackFail:
      "I'm sorry, I'm having trouble helping you right now. Please call back and we'll be happy to assist. Goodbye!",
    todMorning: "Good morning",
    todAfternoon: "Good afternoon",
    todEvening: "Good evening",
    greetingDefault: (tod, businessName) =>
      `${tod}, thanks for calling ${businessName}. How can I help you today?`,
    nudge1: "I'm still here whenever you're ready.",
    nudgeIdentify:
      "I'm here to help — are you calling to book an appointment, leave a message, or something else?",
    nudgeGatherBooking:
      "Take your time — I just need something like a preferred date or time to get started.",
    nudgeGatherMessage: "Whenever you're ready — I just need your name and a brief message.",
    nudgeGatherDefault: "Take your time — just let me know what you need and I'll help.",
    nudgeConfirm: "Just say yes to confirm, or let me know if anything needs to change.",
    nudgeDefault: "I'm still here — feel free to continue whenever you're ready.",
    goodbyeWithPhone: (phone) =>
      `It seems like you may have stepped away. Feel free to call us back at ${phone} anytime. Have a great day. Goodbye!`,
    goodbyeNoPhone:
      "It seems like you may have stepped away. Feel free to call us back anytime. Have a great day. Goodbye!",
    // The closing line when the model ends the call without writing its own
    // goodbye. Was a bare "Goodbye!" — correct, and cold. A receptionist thanks
    // you for calling and uses the practice name; that is the last thing the
    // caller hears and the whole impression they leave with.
    signOff: (businessName) => `Thank you for calling ${businessName}. Have a great day!`,
    transferring: "Transferring you now. Please hold.",
    transferUnavailable:
      "I'm sorry, I'm unable to transfer you at this time. Let me try to help you directly.",
    llmSlowApology: "Sorry, I'm taking a bit longer. Could you repeat that?",
    llmErrorApology: "Sorry, I'm having a technical issue. Could you repeat that?",
    sttFailGoodbye:
      "I'm having trouble hearing you. Please call back and we'll be happy to help. Goodbye!",
    toolDone: "Done. Is there anything else I can help you with?",
    toolFail:
      "I'm sorry, I wasn't able to complete that. Let me take your details so someone can follow up.",
    // Spoken when the assistant told the caller it was checking or updating
    // something and then nothing actually happened — a tool call the model
    // wrote as text, or promised and never made.
    //
    // Deliberately NOT the technical-issue apology: on the call this was found
    // on, hearing something machine-shaped sent the caller into eleven turns of
    // asking what software we run. This names nothing, and offers a way
    // forward instead of an explanation.
    actionNotCompleted:
      "I'm sorry — I wasn't able to make that change just now. Let me take your details and someone will confirm it for you.",
    // "I am about to do something" — the shape of a turn that owes the caller a
    // result. Localized because a Spanish call promises in Spanish, and a guard
    // that only recognizes English promises protects only English callers.
    promiseRe:
      /\b(one moment|just a moment|bear with me|hold on|let me (just )?(check|look|see|update|pull up|find)|i'?ll (check|look|update|get|pull)|checking (that|on that)|looking (that|it) up|give me (a|one) (second|moment))\b/i,
    sayAgain: "I'm sorry, could you say that again?",
    // "here is my name" -- the caller INTRODUCING themselves.
    //
    // Keyed on the caller's own words rather than on the assistant's read-back,
    // because the caller says it plainly ("it's Jane Fitzgerald") while the
    // read-back can be phrased a hundred ways. This is what tells the spelling
    // nudge WHEN to fire: the turn the name arrives, which is the moment the
    // prompt already asks for and does not reliably get.
    //
    // Requires a capitalised word after the lead-in, and excludes the
    // capitalised words that are not names and do follow "it's" -- weekdays,
    // months, "Tuesday" being the obvious false positive on a booking call.
    //
    // Like spellRequestRe, this can be widened but never completed: a caller
    // can give a name in words nobody listed. A miss costs the nudge, not the
    // gate -- services/tools.js still refuses the write.
    nameGivenRe:
      /\b(?:[Mm]y name(?:'?s| is)|[Ii]'?m|[Ii]t'?s|[Tt]his is|[Nn]ame'?s)\s+(?!(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|(?:Tomorrow|Today|Tonight|Yesterday|Fine|Okay|Good|Great|Right|Yes|No|Just|About|The)\b)[A-Z][a-z'’-]{1,}(?:\s+[A-Z][a-z'’-]{1,})?/,
    // "Thanks, Marcus Bell —" -- the assistant reading a name back, which is
    // the OTHER side of the same moment nameGivenRe watches for.
    //
    // Added 2026-09-04 because the nudge shipped and did not fire on either of
    // the two calls after it shipped: live_spelling_ask_nudged 0 against
    // spelling_gate_refusals 2, so the precondition held and the trigger
    // missed. The caller had said "let's do uh Nathan Dodla", which has no
    // lead-in for nameGivenRe to anchor on, and widening that pattern to accept
    // a bare capitalised word would fire on every weekday, month and place name
    // a caller mentions.
    //
    // This side has a shape because the PROMPT demands one, in three separate
    // places: "repeat their FULL name back once in your very next sentence --
    // 'Thanks, Marcus Bell — ...'". A caller can introduce themselves a hundred
    // ways; the assistant was told how to answer.
    //
    // The exclusion list is the same problem nameGivenRe has and then some, and
    // one entry is load-bearing above all others: EVERY call opens with "Thanks
    // for calling <Business>". That is excluded structurally rather than by
    // name -- "for" is lower case, so [A-Z] cannot match it -- which is why the
    // pattern anchors on the capital immediately after the acknowledgement.
    //
    // No /i flag, deliberately, for the same reason as nameGivenRe: [A-Z] is
    // doing real work and the lead-ins spell their own case.
    nameReadBackRe:
      /\b(?:[Tt]hanks|[Tt]hank you|[Gg]ot it|[Pp]erfect|[Gg]reat)\s*,?\s+(?!(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|(?:January|February|March|April|May|June|July|August|September|October|November|December)\b|(?:Tomorrow|Today|Tonight|Yesterday|Okay|Yes|No|Sure|Great|Perfect|Just|About|The|That|This|These|Those|And|But|So|Now|Here|There|What|When|Where|How|Let|Your|You|We|Our|My|It|One|Both|All|Right|Fine|Good|Sorry|Please)\b|I\b)[A-Z][a-z'’-]{1,}(?:\s+[A-Z][a-z'’-]{1,})?/,
    // "someone else will deal with it later" -- the shape of a turn that has
    // handed the caller's request off instead of doing it.
    //
    // A THIRD speech act, and none of the others covers it. promiseRe is "I am
    // about to do it"; completionClaimRe is "I have done it"; this is "I am not
    // going to, and somebody will ring you". On its own that is a legitimate
    // thing for a receptionist to say. Paired with a write the tools REFUSED on
    // the same turn it is LVX34: the gate told the model to ask the caller to
    // spell their name and wait, and the model treated the refusal as a cue to
    // take a message instead.
    //
    // Localized for the same reason promiseRe is: a Spanish caller gets brushed
    // off in Spanish, and a guard that only recognizes English brush-offs
    // protects only English callers.
    deferralRe:
      /\b(?:(?:someone|somebody|a member of (?:our|the) team|one of (?:our|the) team|the team|our team|a colleague)\s+(?:will|'ll|can|is going to)\s+(?:call|ring|phone|get back to|contact|reach out to|be in touch)|(?:i'?ll|i will|we'?ll|we will)\s+(?:have|get|ask)\s+(?:someone|somebody|a colleague|the team)\s+(?:to\s+)?(?:call|ring|phone|contact|get back)|(?:we'?ll|we will|i'?ll|i will)\s+(?:get back to you|be in touch|call you back|ring you back)|call(?:ing)? you back (?:within|in|later)|within the next business day)\b/i,
    // "I have already done it" -- the shape of a turn that has told the caller
    // an action is COMPLETE. Distinct from promiseRe, which is "I am about
    // to". A promise with no tool call is a stall; a claim with no tool call is
    // a caller who believes they have an appointment that does not exist.
    // Observed on a real call: "I've booked your free strategy call for 10 AM
    // on Monday, September 7th", with no tool call anywhere in the session and
    // no row in the database.
    // WIDENED 2026-09-04, and the limits of widening written down beside it.
    //
    // Measured against the four claims actually observed on 2026-09-03, this
    // caught two. Both misses were ordinary English and both were structural:
    //
    //   "Your appointment for Tuesday, September 8th, at 12 pm is all set."
    //     -- the old third branch required "appointment" and "is" to be
    //     ADJACENT, so a date between them made the claim invisible. And "all
    //     set" defeated an alternation that listed "set".
    //   "the appointment is now updated under Nathan Dodla"
    //     -- one article. The branch required "your".
    //
    // A 50% miss rate on the instrument that every LVX27 judgement starts from,
    // and postcall_verify duly filed row_without_claim on two consecutive calls
    // where a claim was plainly made -- a false alarm, which is worse than a
    // miscount because it teaches the reader to ignore the instrument.
    //
    // The gap is bounded by the SENTENCE, not by a word count. What sits
    // between the noun and the verb on a real call is a date and a time, seven
    // words of it; a long subordinate clause ending "is set" is equally a
    // claim. [^.?!] is therefore the right fence and 60 characters is the
    // runaway stop. The completion verb stays a closed list so "is not
    // confirmed" and "is still pending" cannot match.
    //
    // DOES THIS BELONG IN A PATTERN AT ALL? No, and there is no better option
    // here. The alternative is making the model state completions in a form the
    // engine recognises -- a marker -- which is what VOICE_INTENT_MARKER does,
    // and LVX37 is what that cost: the model spoke its markers aloud on every
    // deployed call and the leak guard shredded the audio. A second marker is a
    // second chance at that on the one path where the model IS the voice. So
    // this is widened, not replaced, and it can never be completed. The
    // phrasings it is known to cover are in tests/completionClaimRe.test.js;
    // anything not in that table is a guess.
    // CORRECTED 2026-09-04, on the first real call after the widening above.
    //
    // Adding `the|that|this` to the third branch introduced a false positive
    // immediately, and it is the mirror image of the defect being fixed:
    //
    //   "...would you mind telling me the last four digits of the phone number
    //    THE APPOINTMENT IS BOOKED under?"
    //
    // A question about which number, counted as a claim that a booking
    // completed. `postcall_verify` duly reported `claim_without_row` on a call
    // where nothing had been claimed — a false alarm, which is the thing this
    // entry says is worse than a miscount because it teaches the reader to
    // ignore the ledger.
    //
    // The discriminator is position, not vocabulary. In the false positive the
    // phrase sits INSIDE a noun phrase, directly after another noun ("the phone
    // number ..."), which is what makes it a relative clause rather than an
    // assertion. So the third branch now has to begin at a clause boundary:
    // start of string, an opening quote, punctuation, or a discourse marker.
    // The first two branches keep their plain \b, because "I've booked" and
    // "that's booked" are assertions wherever they appear.
    //
    // Verified against 35 cases -- every claim observed on calls 1-4, every
    // previous negative, and this false positive. Which is also the standing
    // point: it was widened, it broke, it was narrowed, and it still cannot be
    // completed. The table in tests/completionClaimRe.test.js is the only
    // record of what it is known to handle.
    // WIDENED 2026-09-09, after a call where THREE false claims were made and
    // this matched ONE of them. LVX94.
    //
    // The call: the caller asked to cancel two appointments. No cancel or
    // reschedule tool ran at any point — verified in the tool trace — and the
    // rows were still there afterwards. What the assistant said was:
    //
    //   "Both appointments have been canceled for you."     MISSED
    //   "I've rescheduled your appointment."                matched
    //   "That appointment has now been canceled for you."   MISSED
    //
    // Two grammatical gaps, both of them ordinary receptionist speech:
    //
    //   PASSIVE VOICE. "has been cancelled" was already here, but only as
    //   `has been` followed by an optional `now` — and people say "has NOW
    //   been cancelled", with the adverb inside the verb phrase. The plural
    //   ("appointments have been") had no cover at all, and neither did the
    //   determiners a cancellation of several uses: "both", "all".
    //
    //   AN OBJECT BETWEEN THE PRONOUN AND THE VERB. "I've booked you in"
    //   matched; "I have you booked" did not, and that is the phrasing an
    //   earlier call used. Same for "I've got you booked", "I have you down",
    //   and "we" instead of "I".
    //
    // The negatives in tests/completionClaimRe.test.js are the constraint that
    // matters here, not the positives — a guard that nags a model which has
    // just done the thing it said is worse than one that misses. "I have your
    // appointment here in front of me" must still be silent, and is: `you\s+`
    // cannot match "your ".
    // Assembled at the top of this file. This is the NARROW predicate: it is
    // the one that drives CLAIM_NOTE, so a widening here changes what the model
    // is told mid-call, not just what gets counted.
    completionClaimRe: buildCompletionClaimRe(),
    // THE SAME PREDICATE, ONE STEP WIDER, AND DELIBERATELY NOT THE ONE THAT
    // TALKS TO THE MODEL. LVX97, 2026-09-09.
    //
    // Call 156fb2, production config, every tool declared and working. The
    // assistant said, with `book_appointment` never called anywhere in the call
    // and no row before or after:
    //
    //   "Thanks, <name>. So, we're all set for your free consultation on
    //    Wednesday, September ninth at one in the afternoon."
    //
    // Zero claim events of any kind on a fourteen-turn call containing a
    // fabricated booking. `you're all set` was already covered here and `we're
    // all set` was not -- one missing alternation, and the phrasing it missed
    // is the WORST one to miss: it names a weekday, a date and a time, which is
    // exactly the form a real confirmation takes, so it is the phrasing most
    // likely to send a caller away believing they have an appointment.
    //
    // The caller then rang back to move it. reschedule_appointment_db correctly
    // returned false, and the model told them three times, politely and
    // accurately, that no such appointment existed -- twice suggesting the
    // error was theirs. LVX97 is that second act.
    //
    // WHY `we` IS NOT SIMPLY ADDED TO THE ALTERNATION ABOVE. "We're booked up
    // on Wednesday" is availability, not a claim, and "we're done" is an
    // ordinary wrap-up. Only `all set` / `confirmed` / `finalised` can follow a
    // `we` subject here, which is the difference between covering LVX97 and
    // manufacturing false alarms on the commonest sentences a receptionist
    // says. `you`/`that`/`it` keep the wider list they already had.
    //
    // A STRICT SUPERSET, on purpose. Everything completionClaimRe matches this
    // matches too, so the DIFFERENCE between the two counters is exactly the
    // population being measured -- the same construction LVX93's pair uses, and
    // the reason a count can be read as evidence rather than as a coincidence.
    //
    // This one does NOT drive the turn note. Widening what the model is told
    // mid-call changes what every subsequent call measures, and the ladder this
    // project keeps returning to is: count first, act once the counter has said
    // how often it fires when nothing is wrong. What it DOES drive is the
    // post-call ledger and the reconciliation, neither of which speaks.
    // The ledger and the counters. Same pieces, one step wider — see
    // buildCompletionClaimRe at the top of this file.
    completionClaimWideRe: buildCompletionClaimRe({ wide: true }),
    // "here are some times you could have" -- an OFFER of availability, which
    // is a different act from claiming something is done and happens earlier,
    // before the caller has committed to anything. Paired with guards.js's
    // verifiedSlots: this only says that times were offered, and the tool
    // record says whether anything ever verified one.
    //
    // Deliberately anchored on "we/I have ... <availability noun>" rather than
    // on times themselves. Speech renders times a dozen ways and they appear
    // in sentences that are not offers at all ("we're open nine to five",
    // "your appointment is at ten"), so a time parser here would be a
    // false-positive generator.
    slotOfferRe:
      /\b(?:we|i)\b[\s\w']{0,15}\b(?:have|got)\b[^.?!]{0,70}\b(?:available|availability|opening|openings|slot|slots|times)\b/i,
    // "Please spell that" — the shape of a turn that has just spent the ONE
    // spelling request a call is allowed. Localized for the same reason
    // promiseRe is: a Spanish call asks in Spanish, and a cap that only
    // recognizes the English phrasing caps only English callers.
    // Widened 2026-08-29. The cap only closes once this matches what the
    // assistant SAID, so every phrasing it misses is an ask that was never
    // counted and a gate left armed for the next write. "How would I write that
    // down?" and "letter by letter?" are asks; they used to be free.
    spellRequestRe:
      /\b(spell (that|it|your|the|them|those)|spelling of|(could|can|would|will) you spell|how (do|would) (you|i) spell|spell (that|it) (out|for me)|letter by letter|how (do|would) (you|i) write (that|it)|write that down)\b/i,
    // "Is there anything else I can help you with today?" -- the tic.
    //
    // Turns 2, 3, 4, 5 and 6 of one call all ended with it, including
    // immediately after a plain factual answer, and five consecutive turns of
    // another did the same. It is not a defect with a victim; it is the
    // clearest "this is not a person" signal a prospect gets, and nothing has
    // ever counted it.
    //
    // Deliberately NOT anchored to the end of the reply. It also shows up
    // mid-turn, bolted onto a spelling request before anything had been done,
    // which is LVX35's inverted ordering arriving through a different door.
    //
    // Its known weakness, written down rather than discovered later: this
    // matches WORDS, so an LVX73 transcription fragment could in principle
    // manufacture a match. The stacked-question count below cannot -- a
    // spurious token does not carry a question mark -- and that difference is
    // why the two are counted separately rather than as one "verbal tic"
    // number.
    // WIDENED 2026-09-05, after the tic survived nine calls at 3-4 turns in ten
    // and two of its commonest forms turned out not to be counted at all:
    //
    //   "Anything else you'd like to know?"     -- the headless form. The first
    //      branch led with "is|was there", so the same sentence with its opener
    //      dropped went uncounted. A tic the model shortens is still the tic.
    //   "What else can I help you with today?"  -- carries no "anything" at all,
    //      so no amount of widening AROUND "anything else" could ever have
    //      reached it.
    //
    // A THIRD, added 2026-09-05 after the first UK-tenant call, where it was the
    // fifth ask in fourteen turns while this counter reported four:
    //
    //   "Just let me know if there's anything else."
    //
    // "there's" is not "is there", and nothing followed "anything else" to catch
    // it either. It is the form worth having, because it is the one bolted onto
    // a goodbye -- the model asking on its way out of the call.
    //
    // Widening a phrasing list is normally exactly the treadmill this file warns
    // about. It is safe HERE for one specific reason: NOTHING ACTS ON THIS. It is
    // a count with no turn note and no guard behind it, so a miss costs a number
    // that reads quieter than the call was and a false hit costs one that reads
    // louder. Neither reaches a caller. That is not true of spellRequestRe or
    // completionClaimRe, where the same widening buys a false refusal -- which is
    // why those two stay narrow and this one does not have to.
    //
    // NOT widened to a bare "anything else", and that is the line that matters.
    // Digile Media's own custom_instructions open with "Find out why they are
    // calling before you ask anything else" -- an ordinary English idiom, sitting
    // in the prompt, meaning something entirely different. Every branch below
    // "Thanks for calling Digile Media, have a great day" -- the assistant
    // signing off.
    //
    // On 2026-09-06 it said exactly that and then did NOTHING: end_call never
    // ran, the line stayed open, and the silence ladder nudged eleven seconds
    // later. The owner's rule, and it is the right one: once the receptionist
    // says thank-you-for-calling, the call should end unless the caller speaks.
    //
    // Anchored on the FAREWELL, not on "thanks": "thanks for that" and "thank
    // you for correcting me" are ordinary mid-call politeness and appear
    // constantly. It needs a leaving word.
    // WIDENED 2026-09-09, on call CA7e12d0, where it missed TWO goodbyes out of
    // three and the caller heard all three:
    //
    //   "Thanks again for calling Brightwork Studio. Take care."     MISS
    //   "I understand. Thanks for calling Brightwork Studio.
    //    Take care."                                                 MISS
    //   "Thanks for calling Brightwork Studio. Have a great day."    match
    //
    // Two separate holes, both ordinary English:
    //
    //   AN ADVERB BETWEEN. "thanks AGAIN for calling" -- `thanks` and `for
    //   calling` had to be adjacent. Exactly LVX94's object-between miss, in a
    //   different regex, found the same way: by reading what was actually said.
    //
    //   THE LEAVING WORD IN THE NEXT SENTENCE. `[^.!?]*` cannot cross a full
    //   stop, and "Thanks for calling X. Take care." puts one in the middle.
    //   The gap now excludes only `?` and `!` and is bounded at 80 characters:
    //   a question or an exclamation means the turn went somewhere else and the
    //   farewell is no longer the same thought, while a full stop is just how
    //   the model punctuates a two-sentence goodbye.
    //
    // What made this expensive rather than cosmetic: the same call exposed that
    // `end_call` was being duplicate-suppressed after its first success, so the
    // sign-off path was the ONLY remaining way to end that call. Two soft holes
    // in different files became one call running 53 seconds past its end with
    // three goodbyes in it.
    //
    // STILL NOT ADDING a bare "take care" to the second alternative, and this is
    // the line to hold: "I'll take care of that for you" is one of the commonest
    // sentences a receptionist says, and it would arm a hang-up mid-booking.
    // "take care" only counts as a farewell when "thanks for calling" preceded
    // it, which is what the first alternative already requires.
    signOffRe:
      /\b(?:thanks|thank you)(?:\s+(?:again|so\s+much|very\s+much))?\s+for\s+calling\b[^!?]{0,80}?\b(?:good\s*bye|bye|great\s+day|good\s+day|great\s+weekend|lovely\s+day|take\s+care)\b|\bhave\s+a\s+(?:great|good|lovely)\s+(?:day|weekend|evening)\b/i,
    // "Just to confirm, you'd like to cancel all three?" -- the assistant
    // reading a change back to the caller BEFORE making it. LVX95.
    //
    // The call this comes from, `be9bd6`, 2026-09-09, sixty seconds:
    //
    //   04:53:13  cancel_appointment_db  success=true
    //   04:53:13  cancel_appointment_db  success=true
    //   04:53:13  cancel_appointment_db  success=true
    //   04:53:27  "Of course. Just to confirm, you'd like to cancel all three
    //              of your upcoming appointments? ..."
    //   04:53:33  end_call
    //
    // The three writes committed FOURTEEN SECONDS before the confirmation was
    // asked, and the model went to end_call six seconds after asking, without
    // waiting for an answer that could not have changed anything. Every claim
    // it made was TRUE -- three tools ran, three rows changed. The defect is
    // ordering: the caller heard a safeguard being applied that had already
    // been overtaken by the write. A confirmation landing after the write is
    // worse than no confirmation, because it tells the caller a check exists.
    //
    // A PHRASING LIST, with the treadmill risk this file warns about, and it is
    // bounded in two ways rather than argued away. The gate that reads it
    // carries a per-call refusal ceiling, so an unrecognised phrasing costs a
    // bounded number of extra turns and never a livelock; and
    // `write_order_gate_ceiling` counts every time that ceiling is spent, which
    // is the number that says the list is too narrow. A miss here is expensive
    // and measurable, not silent.
    //
    // Anchored on the ASK, not on the details. Times and names are spoken a
    // dozen ways and parsing them here would be a false-positive generator; the
    // question is whether the assistant put the action to the caller and waited.
    // LVX107. Two live misses on 2026-09-10, both inside a single turn that was
    // a textbook read-back:
    //
    //   "Thanks, Nitin. JUST TO MAKE SURE I HAVE THAT RIGHT, that's
    //    N I T I N D O T L A? And I'm booking that for tomorrow, Friday,
    //    September 11th, at 1 30 PM. IS THAT ALL CORRECT?"
    //
    // recorded as `readBackMade=false`. That is not cosmetic: services/tools.js
    // keys the escape-hatch budget to `"none"` when no read-back is recognised,
    // so every attempt hashes the same and the ceiling depletes. A phrasing miss
    // here spends the allowance LVX104 exists to protect.
    //
    // The modal is a CLOSED CLASS and is listed as one. `shall I` and `should I`
    // were here; `may I` and `can I` were not, and on 2026-09-10 the gate refused
    // "may I go ahead and confirm the appointment for 9 AM tomorrow under that
    // name?" -- a correction put to the caller as plainly as it can be put. The
    // verb list after it is what keeps "Can I get your full name?" out: this
    // matches an offer to ACT, not any question the assistant happens to front
    // with a modal.
    //
    // Fixed as a shape, not as two more alternations: a bounded one-word gap
    // wherever this pattern assumed adjacency. Built through readBackGapped, so
    // the ADJACENT form keeps the exact behaviour it always had and only the
    // GAPPED form carries the clause-terminal guard -- see the note on that
    // helper for the four phrasings that guard silently broke when it was
    // applied to both. Certified 18 positives / 13 negatives, plus the four
    // regressions and the live turn from 2026-09-10 that exposed them.
    confirmReadBackRe: new RegExp(
      String.raw`\b(?:just\s+to\s+confirm|to\s+confirm\b|can\s+i\s+(?:just\s+)?confirm|let\s+me\s+confirm|confirming\s+that` +
        `|${readBackGapped(String.raw`is\s+that`, String.raw`(?:right|correct|okay|ok)`)}` +
        `|${readBackGapped(String.raw`does\s+that\s+(?:sound|look)`, String.raw`(?:right|good|correct)`)}` +
        `|${readBackGapped(String.raw`does\s+that`, String.raw`(?:sound|look)\s+(?:right|good|correct)`)}` +
        `|${readBackGapped(String.raw`(?:did|have)\s+i\s+(?:get|got)\s+(?:that|this|it|everything|them|the\s+details|those\s+details)`, String.raw`right`)}` +
        `|${readBackGapped(String.raw`(?:just\s+)?to\s+(?:make\s+sure|be\s+sure|double[\s-]?check)\s+(?:i|we)\s+(?:have|'?ve\s+got|got)\s+(?:that|this|it|everything|them|the\s+details|those\s+details)`, String.raw`(?:right|correct)`)}` +
        String.raw`|would\s+that\s+be\s+right|(?:shall|should|may|can)\s+i\s+${READ_BACK_ACTION_VERB}|(?:would|do)\s+you\s+(?:like|want)\s+me\s+to\s+${READ_BACK_ACTION_VERB}|are\s+you\s+happy\s+for\s+me\s+to|you'?d\s+like\s+(?:me\s+)?to\s+${READ_BACK_ACTION_VERB})\b`,
      "i"
    ),
    // "My apologies, I haven't actually booked that yet." -- the assistant
    // narrating its own unreliability to the caller. LVX98.
    //
    // COUNT ONLY, and the entry it comes from is filed next to the good news
    // because it is the same event. On call 7aef50 the claim guard worked
    // exactly as designed: a claim fired, the note went in, the model retracted
    // and then made a real booking with a row that exists. What the CALLER
    // heard across a third of the call was:
    //
    //   "My apologies, I haven't actually booked that yet."
    //   "Sorry for the confusion."
    //   "I really apologize for the back and forth -- I had meant to say that I
    //    had not yet finalized the booking."
    //   "I truly apologize for how confusing this has been. My earliest
    //    statements were mistaken."
    //
    // Six apologies, escalating. The outcome was correct and the experience is
    // one no business would put in front of a customer -- a caller told "my
    // earliest statements were mistaken" has been advised, accurately, not to
    // trust the receptionist.
    //
    // The family: LVX76 (the hesitation refusal is re-read aloud), LVX96 (a
    // refused end_call makes the model pre-write a sign-off that is then
    // spoken), and this. EVERY internal control message this system sends the
    // model ends up audible, and not one was written to be heard. `callerSafe`
    // exists to mark the ones that may be spoken and has NO reader on this
    // path -- services/gemini.js:2714 is the only place it is consulted, and
    // that is the cascade.
    //
    // Nothing acts on this yet, which is why it can be a phrasing list at all:
    // a miss reads quieter than the call was and a false hit reads louder, and
    // neither reaches a caller. That stops being true the moment it drives a
    // cut, and the cut would go where inspectRepeat's does -- per fragment,
    // before the words reach turnReplyText, with clearAudio behind it.
    //
    // ANCHORED TO THE OPENING of the turn. A mid-sentence "sorry" is ordinary
    // politeness ("sorry, could you repeat that?") and appears constantly; the
    // defect is a turn that BEGINS by apologising for itself. The two
    // self-correction phrases at the end are deliberately not anchored, because
    // "I had meant to say" and "my earliest statements were mistaken" have no
    // innocent reading wherever they appear.
    apologyPreambleRe:
      /^\s*["'“‘]?\s*(?:my\s+(?:sincere\s+|deepest\s+)?apolog(?:y|ies)|i\s+(?:really\s+|truly\s+|do\s+|deeply\s+)?apologi[sz]e|i(?:'m| am)\s+(?:so|really|truly|very|terribly)\s+sorry|sorry\s+(?:about|for)\s+(?:the|that|any|all)|i(?:'m| am)\s+sorry\s+(?:about|for|if)|my\s+mistake)\b|\b(?:i\s+had\s+meant\s+to\s+say|my\s+(?:earlier|earliest)\s+statements?\s+(?:was|were)\s+mistaken|i\s+misspoke)\b/i,
    closingTicRe:
      /\b(?:is|was)\s+there\s+anything\s+else\b|\banything\s+else\s+(?:i|we)\s+(?:can|could)\b|\banything\s+else\s+(?:for\s+you|you\s+need|today)\b|\banything\s+else\s+(?:you'?d|you\s+would|you'?re\s+wondering)\b|\b(?:what|how)\s+else\s+(?:can|could|may)\s+(?:i|we)\b|\b(?:if|whether)\s+(?:there'?s|there\s+is)\s+anything\s+else\b/i,
  },

  es: {
    lang: "es",
    filler: "Un momento.",
    holdAvailability: [
      "Un segundo, reviso la agenda.",
      "Déjeme ver qué hay libre.",
      "Revisando la agenda ahora.",
    ],
    holdLookup: ["Déjeme buscar su cita.", "Un segundo, busco su cita."],
    holdBook: ["Le agendo la cita ahora.", "Reservando esa hora ahora."],
    holdReschedule: ["Le cambio la cita ahora.", "Moviendo esa cita ahora."],
    holdCancel: ["Le cancelo la cita ahora.", "Me encargo de eso ahora."],
    // See the English holdSpelling above — keyed to the caller's own turn, not
    // to a tool. The letter lexicon that detects it is per-locale
    // (lib/spellingSignal.js reads `lang` off this table).
    holdSpelling: ["Lo estoy anotando.", "Déjeme anotar eso."],
    stillWorking: "Sigo trabajando en eso.",
    maxDuration:
      "Lo siento, hemos llegado al tiempo máximo de llamada. Por favor, vuelva a llamar si necesita más ayuda. ¡Hasta luego!",
    fallbackFail:
      "Lo siento, estoy teniendo problemas para ayudarle en este momento. Por favor, vuelva a llamar y con gusto le atenderemos. ¡Hasta luego!",
    todMorning: "Buenos días",
    todAfternoon: "Buenas tardes",
    todEvening: "Buenas noches",
    greetingDefault: (tod, businessName) =>
      `${tod}, gracias por llamar a ${businessName}. ¿En qué puedo ayudarle hoy?`,
    nudge1: "Sigo aquí cuando esté listo.",
    nudgeIdentify:
      "Estoy aquí para ayudarle — ¿llama para agendar una cita, dejar un mensaje, o algo más?",
    nudgeGatherBooking:
      "Tómese su tiempo — solo necesito una fecha u hora de preferencia para comenzar.",
    nudgeGatherMessage: "Cuando esté listo — solo necesito su nombre y un mensaje breve.",
    nudgeGatherDefault: "Tómese su tiempo — dígame qué necesita y le ayudaré.",
    nudgeConfirm: "Diga sí para confirmar, o dígame si algo necesita cambiar.",
    nudgeDefault: "Sigo aquí — continúe cuando esté listo.",
    goodbyeWithPhone: (phone) =>
      `Parece que se ha alejado. Puede llamarnos de nuevo al ${phone} cuando guste. Que tenga un buen día. ¡Hasta luego!`,
    goodbyeNoPhone:
      "Parece que se ha alejado. Puede llamarnos de nuevo cuando guste. Que tenga un buen día. ¡Hasta luego!",
    signOff: (businessName) => `Gracias por llamar a ${businessName}. ¡Que tenga un buen día!`,
    transferring: "Le transfiero ahora. Por favor, espere.",
    transferUnavailable:
      "Lo siento, no puedo transferirle en este momento. Permítame intentar ayudarle directamente.",
    llmSlowApology: "Disculpe, estoy tardando un poco. ¿Podría repetirlo?",
    llmErrorApology: "Disculpe, tengo un problema técnico. ¿Podría repetirlo?",
    sttFailGoodbye:
      "Tengo problemas para escucharle. Por favor, vuelva a llamar y con gusto le ayudaremos. ¡Hasta luego!",
    toolDone: "Listo. ¿Hay algo más en lo que pueda ayudarle?",
    toolFail:
      "Lo siento, no pude completar eso. Permítame tomar sus datos para que alguien le dé seguimiento.",
    actionNotCompleted:
      "Lo siento, no pude hacer ese cambio en este momento. Permítame tomar sus datos y alguien se lo confirmará.",
    promiseRe:
      /\b(un momento|permítame (revisar|verificar|buscar|actualizar)|déjeme (revisar|verificar|buscar)|voy a (revisar|verificar|buscar|actualizar)|estoy revisando|un segundo)\b/i,
    // See the English completionClaimRe. Localized for the same reason
    // promiseRe is: a Spanish call claims completion in Spanish, and a guard
    // that only recognises English claims protects only English callers.
    completionClaimRe:
      /\b(?:(?:ya\s+)?(?:he|hemos)\s+(?:reservado|agendado|cancelado|programado|anotado|enviado)|(?:est[aá]|queda|qued[oó])\s+(?:reservad[oa]|agendad[oa]|cancelad[oa]|confirmad[oa]|list[oa]))\b/i,
    // THE NARROW ONE, VERBATIM, and that is the honest state of it.
    //
    // The English widening came from two calls that were read line by line.
    // No Spanish call has ever been read that way, so there is no evidence
    // here to widen ON -- and widening a detector by translating the English
    // phrasings would produce a pattern whose false-positive rate nobody has
    // measured, feeding a reconciliation that telephones a business owner.
    //
    // Present rather than absent because the key parity check in
    // tests/strings.test.js is right to demand it: a locale silently missing a
    // key is how a guard comes to protect only English callers. Identical to
    // the line above means Spanish behaviour is unchanged, which is the correct
    // default until a Spanish call has been read.
    completionClaimWideRe:
      /\b(?:(?:ya\s+)?(?:he|hemos)\s+(?:reservado|agendado|cancelado|programado|anotado|enviado)|(?:est[aá]|queda|qued[oó])\s+(?:reservad[oa]|agendad[oa]|cancelad[oa]|confirmad[oa]|list[oa]))\b/i,
    // See the English confirmReadBackRe. Localized because the write-order gate
    // REFUSES on it, and a gate whose read-back list only speaks English would
    // refuse every Spanish write until its per-call ceiling released it --
    // which is worse than not having the gate, and is exactly the shape LVX50
    // and the promiseRe comment both warn about.
    confirmReadBackRe:
      /\b(?:para\s+confirmar|confirmo\s+que|le\s+confirmo|¿?es\s+correcto|¿?est[aá]\s+bien|¿?le\s+parece\s+bien|¿?procedo|¿?(?:quiere|desea)\s+que\s+(?:lo|la|se\s+lo)\s+(?:reserve|agende|cancele|cambie|mueva)|¿?sigo\s+adelante|¿?confirma(?:mos)?\b)/i,
    // See the English apologyPreambleRe. Count only, so a miss here costs a
    // number that reads quieter than the call was and nothing else.
    apologyPreambleRe:
      /^\s*["'“‘¡]?\s*(?:mis\s+disculpas|disc[uú]lpe(?:me)?|perd[oó]n(?:e|eme)?|lo\s+siento\s+(?:mucho|much[ií]simo|por)|le\s+pido\s+disculpas)\b|\b(?:me\s+equivoqu[eé]|quise\s+decir|fue\s+un\s+error\s+m[ií]o)\b/i,
    // See the English deferralRe.
    deferralRe:
      /\b(?:(?:alguien|un compañero|una compañera|el equipo|nuestro equipo)\s+(?:le|te)\s+(?:llamará|llamara|contactará|contactara|devolverá la llamada)|(?:le|te)\s+(?:llamaremos|llamamos|contactaremos|devolveremos la llamada)|nos pondremos en contacto|dentro del próximo día hábil)\b/i,
    // See the English slotOfferRe.
    slotOfferRe:
      /\b(?:tenemos|tengo)\b[^.?!]{0,70}\b(?:disponible|disponibles|disponibilidad|hueco|huecos|cita|citas|horarios?)\b/i,
    sayAgain: "Lo siento, ¿podría repetirlo?",
    // See the English nameGivenRe.
    nameGivenRe:
      /\b(?:[Mm]e llamo|[Mm]i nombre es|[Ss]oy|[Hh]abla)\s+(?!(?:lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b)[A-ZÁÉÍÓÚÑ][a-záéíóúñ'’-]{1,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ'’-]{1,})?/,
    // See the English nameReadBackRe. "Gracias por llamar a ..." is the
    // greeting on every call and is excluded structurally: "por" is lower case.
    nameReadBackRe:
      /\b(?:[Gg]racias|[Pp]erfecto|[Ee]ntendido|[Mm]uy bien)\s*,?\s+(?!(?:lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b|(?:Mañana|Hoy|Ayer|Vale|Sí|No|Le|Su|Un|Una|El|La|Los|Las|Y|Pero|Ahora|Entonces)\b)[A-ZÁÉÍÓÚÑ][a-záéíóúñ'’-]{1,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ'’-]{1,})?/,
    // Widened alongside the English one — see the note there.
    spellRequestRe:
      /\b(deletrear|deletrea|deletree|cómo se escribe|como se escribe|cómo se deletrea|como se deletrea|puede deletrear|podría deletrear|letra por letra)\b/i,
    // See the English signOffRe. Same anchor: a farewell word, not "gracias",
    // which appears constantly mid-call.
    signOffRe:
      /gracias\s+por\s+llamar[^.!?]*(?:adi[oó]s|hasta\s+luego|buen\s+d[ií]a|buen[ao]s?\s+(?:d[ií]as|tardes|noches))|que\s+tenga\s+un\s+buen\s+d[ií]a/i,
    // See the English closingTicRe. Left NARROW deliberately rather than widened
    // alongside it: "algo mas" already matches headlessly, so the Spanish table
    // never had the gap the English one did, and inventing rephrasings nobody has
    // heard on a Spanish call would be a phrasing list built out of a guess.
    closingTicRe: /\b(?:hay\s+)?algo\s+m[aá]s\b/i,
  },
};

/**
 * Resolve a call's primary language from the business config.
 * @param {object} config - normalized business config
 * @returns {"en"|"es"}
 */
export function resolveLang(config) {
  const primary = Array.isArray(config?.languagesSpoken) ? config.languagesSpoken[0] : null;
  return STRINGS[primary] ? primary : "en";
}

/**
 * Get the string table for a language (or a config object).
 * @param {string|object} langOrConfig
 * @returns {typeof STRINGS.en}
 */
export function getStrings(langOrConfig) {
  const lang =
    typeof langOrConfig === "string" ? langOrConfig : resolveLang(langOrConfig);
  return STRINGS[lang] || STRINGS.en;
}

/**
 * Which hold line fits the tool that just started.
 *
 * An EXPLICIT map, not a regex over the name. The regex version bucketed every
 * write tool together, so cancelling an appointment was announced with the same
 * sentence as booking one — "just getting that sorted for you" — and a caller
 * noticed it did not match what they had asked for. The line is spoken because
 * a specific tool started; it should say what that tool is doing.
 *
 * Locale-independent: tool NAMES are the same everywhere, and the line each one
 * maps to is looked up per-locale by the caller. Anything unrecognised — a
 * business's own webhook tool — falls back to the generic filler, because
 * guessing what someone else's integration does would be worse than
 * "One moment."
 */
const HOLD_KIND_BY_TOOL = {
  check_appointment_availability: "holdAvailability",
  get_available_slots: "holdAvailability",
  get_caller_appointments: "holdLookup",
  get_caller_appointments_from_db: "holdLookup",
  book_appointment: "holdBook",
  book_appointment_in_ehr: "holdBook",
  cancel_appointment: "holdCancel",
  cancel_appointment_db: "holdCancel",
  reschedule_appointment: "holdReschedule",
  reschedule_appointment_db: "holdReschedule",

  // Explicitly SILENT — null, not absent. Absent means "unknown tool" and gets
  // the generic line, which for these would be wrong in three different ways.
  //
  // The two engine-owned tools first, and set_call_intent is the dangerous one:
  // under VOICE_INTENT_MARKER it is synthesised on EVERY turn from the marker
  // line, so treating it as unknown would announce "One moment." before every
  // single reply in the call.
  set_call_intent: null,
  end_call: null,
  // The transfer has its own spoken line already (strings.transferring).
  request_transfer: null,
  // Quick writes the caller has just dictated. They know what they said; being
  // told it is being written down is noise, and it is fast enough that the
  // threshold would rarely let it speak anyway.
  record_customer_request: null,
  record_quote_request: null,
};

/**
 * @param {string} toolName
 * @returns {string} a key into the locale table
 */
export function holdKindForTool(toolName) {
  if (typeof toolName !== "string" || !toolName) return null;
  // `in` rather than a truthy lookup: a mapped null means "known, and
  // deliberately silent", which is a different answer from "never heard of it".
  if (toolName in HOLD_KIND_BY_TOOL) return HOLD_KIND_BY_TOOL[toolName];
  // A business's own webhook tool. It can be genuinely slow — an external HTTP
  // call with a 6s timeout — and silence there is the worst case, so it gets
  // the generic line rather than a guess at what someone else's integration
  // does.
  return "filler";
}

/**
 * Every hold kind, for warming the utterance cache at call start.
 *
 * Mostly derived from the tool map, so a capability added later cannot forget
 * to warm its line. `holdSpelling` is appended explicitly because it is the one
 * kind no tool maps to — it fires off the caller's own transcript — and a warm
 * MISS there would fall through to live TTS on exactly the turn this line
 * exists to make fast.
 */
export const HOLD_KINDS = [
  ...new Set([...Object.values(HOLD_KIND_BY_TOOL), "holdSpelling"]),
].filter(Boolean);

/**
 * Resolve a hold line, cycling through the variants for its kind.
 *
 * A kind may be a single string (the generic filler, the stall line) or a list
 * of alternatives. `n` is a per-call counter, so a caller hearing three tool
 * rounds hears three different sentences rather than the same one three times.
 *
 * @param {object} strings - the resolved locale table
 * @param {string} kind
 * @param {number} [n]
 * @returns {string}
 */
export function holdLineFor(strings, kind, n = 0) {
  const v = strings?.[kind];
  if (Array.isArray(v)) return v.length ? v[Math.abs(n) % v.length] : "";
  return typeof v === "string" ? v : "";
}

/** Every variant of a hold kind, for warming the utterance cache. */
export function holdLineVariants(strings, kind) {
  const v = strings?.[kind];
  if (Array.isArray(v)) return v.filter(Boolean);
  return typeof v === "string" && v ? [v] : [];
}
