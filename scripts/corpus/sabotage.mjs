#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AN INSTRUMENT THAT CANNOT FAIL IS NOT EVIDENCE.
//
// tests/liveCorpusReplay.test.js asserts that twenty real write attempts get
// the outcome they should. A green run is worth nothing unless a broken gate
// turns it red, and this repository has shipped at least three suites that
// could not: tests/liveSession.test.js spied the wrong stream and passed on an
// empty array for a deployment; lib/harness/liveTextSession.js sets none of the
// fields a consent gate reads, so every gate is dead in the eval driver; and
// the reverted 5232277's tests passed by rewriting the sentence they were
// supposed to be testing.
//
// So each row below breaks ONE thing and requires the named suites to go red.
//
// TWO RULES THIS OBEYS, both of which have cost a round here before:
//
//   1. IT ASSERTS THE SABOTAGE LANDED. A `find` string that no longer matches
//      would leave the source untouched, the suite green, and this script
//      reporting "green when sabotaged" -- which reads as a broken test and is
//      actually a broken saboteur. Every patch must match exactly once.
//   2. IT NEVER USES GIT TO RESTORE. The original text is held in memory and
//      written back in a finally block, so uncommitted work in the tree is not
//      at risk. A restore that does not verify is not a restore, so the bytes
//      are compared afterwards and a mismatch is a hard failure.
//
// Usage:  node scripts/corpus/sabotage.mjs [--only <name>]
// ---------------------------------------------------------------------------

import fs from "node:fs";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// A THIRD RULE, added 2026-09-18 after this script was killed mid-row.
//
// Rule 2 restores in a `finally` block. A finally does not run when the process
// is KILLED -- and on 2026-09-18 the OS killed this script for memory while it
// held lib/voice/strings.js patched. The working tree was left with a shipped
// fix silently removed.
//
// "Silently" is the whole problem. Most rows replace code with a line carrying
// a SABOTAGE marker, so a leftover is greppable. The row that was interrupted
// replaces a regex branch with the EMPTY STRING, because restoring an
// alternation to its prior text means deleting the branch -- so there was
// nothing to grep for, and the only evidence was a one-line `git diff` in a
// repository that had legitimate uncommitted work in it at the time.
//
// So: a journal file is written BEFORE any file is touched and removed only
// after the restore is verified. If one is found at startup, this refuses to
// run and names the file to restore. Cheap, and it converts a silent broken
// tree into a loud one.
// ---------------------------------------------------------------------------
const JOURNAL = "scripts/corpus/.sabotage-in-progress";

function claimJournal(file) {
  fs.writeFileSync(JOURNAL, `${file}\n`, "utf8");
}
function releaseJournal() {
  try {
    fs.unlinkSync(JOURNAL);
  } catch {
    /* already gone */
  }
}
if (fs.existsSync(JOURNAL)) {
  const stranded = fs.readFileSync(JOURNAL, "utf8").trim();
  console.error("A previous sabotage run did not finish. It was patching:\n");
  console.error(`    ${stranded}\n`);
  console.error("That file may still carry the sabotage, and a row whose replacement is empty");
  console.error("leaves NOTHING to grep for. Restore it before trusting anything:\n");
  console.error(`    git checkout -- ${stranded}`);
  console.error(`    rm ${JOURNAL}\n`);
  process.exit(3);
}

const REPLAY = "tests/liveCorpusReplay.test.js";
const LATCH = "tests/liveConsentLatch.test.js";
const SLOTS = "tests/slotMention.test.js";
const TOOLS = "tests/liveTools.test.js";
const SESSION = "tests/liveSession.test.js";
const HAMMER = "tests/liveWriteHammering.test.js";
const VERIFY = "tests/postCallVerify.test.js";
const SMS = "tests/notifications.sms.test.js";
const GOODBYE = "tests/liveGoodbyeExit.test.js";
const EXITCLOSE = "tests/liveExitClose.test.js";
const WATCHDOG = "tests/liveMediaWatchdog.test.js";
const ASK = "tests/liveEndCallAsk.test.js";
// LVX157's suite. A DIFFERENT question from ASK's: that one asks whether the
// gate refuses a caller who was never asked, this one whether an ask or a
// refusal spent on EARLIER work still counts for the write that just landed.
// Every call in ASK has exactly one completed action, so no case in it can tell
// the two apart -- the same shape as the CLAIM/CLAIMRACE split above.
const COMPLETIONASK = "tests/liveCompletionAsk.test.js";
// The claim predicate as the live guard now calls it: the regex plus the
// per-sentence question guard. tests/completionClaimRe.test.js owns the
// regexes AND the function, so LVX151's rows point here.
const CLAIMRE = "tests/completionClaimRe.test.js";
// The gate's own suite, which calls executeToolCall directly and is therefore
// the only place the CASCADE's side of a shared gate is visible at all.
const TOOLSGATE = "tests/tools.test.js";
const DENIAL = "tests/liveAvailabilityDenial.test.js";
const LANG = "tests/liveAssistantLanguage.test.js";
// LVX140's suite. NOT tests/liveClaimGuard.test.js: that file's `execute` stub
// returns { success: true } for every tool, so no case in it can produce a
// refused write at all -- the stubbed-execute trap, the same one that kept
// `sent-counts-attempts` green against postCallVerify.test.js.
const CLAIMRACE = "tests/liveClaimGuardRefusedWrite.test.js";
// The claim DETECTOR's own suite, which is a different question from the
// look-back's: LVX143 is about whether the sentence is seen at all.
const CLAIM = "tests/liveClaimGuard.test.js";
const AFFIRM = "tests/isAffirmative.test.js";
const ORDER = "tests/liveWriteOrder.test.js";
// The teardown wiring, which is a different question from what verifyCall does
// with what it is handed.
const POSTCALLWIRE = "tests/livePostCall.test.js";
// The byte-locked prompt. A language instruction that vanishes is invisible to
// every behavioural suite -- the model simply drifts on calls nobody is running.
const PROMPTS = "tests/promptSnapshot.test.js";

const SABOTAGES = [
  {
    name: "word-clock",
    why:
      "lib/voice/slotMention.js stops generating the word forms 3.8 speaks, which is the state the estate was deployed in. The latch can then never hold on a 3.8 read-back.",
    file: "lib/voice/slotMention.js",
    find: "  const hourWord = HOUR_WORD[hour12 % 12];",
    replace: "  return [...forms]; // SABOTAGE\n  const hourWord = HOUR_WORD[hour12 % 12];",
    // DENIAL too, since 2026-09-17: LVX137's detector reuses this matcher to
    // read a time out of a denial, so a matcher that cannot hear "two o'clock"
    // makes that counter read zero and report it as good news.
    red: [SLOTS, REPLAY, DENIAL],
  },
  {
    name: "supersession-veto",
    why:
      "puts `supersededHere` back into the write-order gate's refusal disjunction. This is the exact state that refused five booking attempts on CA03558d and four on CA919b69.",
    file: "services/tools.js",
    find: "if (hasTarget && !consentLatched && (!readBackMade || !callerAgreed)) {",
    replace:
      "if (hasTarget && !consentLatched && (!readBackMade || !callerAgreed || agreementSuperseded(ctx))) { // SABOTAGE",
    red: [REPLAY],
  },
  {
    name: "spent-token",
    why:
      "lets a token that has already authorised one action authorise the next. On a silent turn that skips the whole gate stack, so a cancellation's consent books the slot it just cancelled.",
    file: "services/tools.js",
    find: "          const tokenSpent = Boolean(ctx?.completedActionThisCall);",
    replace: "          const tokenSpent = false; // SABOTAGE",
    red: [LATCH],
  },
  {
    name: "spent-latch",
    why: "the same rule at the consent latch rather than at the silent-turn verdict.",
    file: "services/tools.js",
    find: "            const agreementSpent = Boolean(ctx?.completedActionThisCall);",
    replace: "            const agreementSpent = false; // SABOTAGE",
    red: [REPLAY],
  },
  {
    name: "hammer-brake",
    why:
      "removes the refusal echo, so an identical refused write is re-gated as many times as the model asks. CA03558d did it five times in 2.3 seconds.",
    file: "lib/voice/live/tools.js",
    find: "      isAction && state?.lastChance !== true ? refusalEcho.get(echoKey(fc, state)) : null;",
    replace: "      null; // SABOTAGE",
    red: [HAMMER],
  },
  {
    name: "hammer-brake-too-wide",
    why:
      "keys the echo on the tool and its arguments ALONE -- the obvious brake, and the one that loses bookings. A model that is refused, reads the details back and retries would get the stale refusal instead of the write it has now earned.",
    file: "lib/voice/live/tools.js",
    find: "      Number(state?.callerTurnCount) || 0,\n      textFingerprint(state?.lastCallerText ?? \"\"),\n      textFingerprint(state?.lastReplyText ?? \"\"),",
    replace: "      // SABOTAGE",
    red: [HAMMER],
  },
  {
    name: "blocking-pin",
    why:
      "undoes fdd3035's BLOCKING tool pin, which is the one change on this branch with clean before/after evidence from production: zero-text turns 3 -> 0, dead-air p50 4,178 -> 2,529 ms.",
    file: "lib/voice/live/tools.js",
    find: '  const raw = String(env.LIVE_TOOL_BEHAVIOR ?? "BLOCKING").trim().toUpperCase();',
    replace: '  const raw = String(env.LIVE_TOOL_BEHAVIOR ?? "DEFAULT").trim().toUpperCase(); // SABOTAGE',
    red: [TOOLS],
  },
  {
    name: "abandoned-escalation",
    why:
      "puts the escalation back behind reconcile()'s single ordered verdict. write_abandoned is tested before claim_without_row, so CA03558d -- six refused attempts, zero rows, a caller told it was confirmed -- told nobody anything.",
    file: "lib/postCallVerify.js",
    // RE-ANCHORED 2026-09-18 when LVX142 widened the disjunct from
    // abandonedWithNoRow to abandonedOutstanding. The old anchor matched zero
    // times, which this script reports rather than skipping -- but a row that
    // cannot run is a row that proves nothing, and the first sign of it is a
    // matrix that suddenly counts one lower.
    find: '  if (verdict === "claim_without_row" || bookingOwedNoRow || abandonedOutstanding) {',
    replace: '  if (verdict === "claim_without_row" || bookingOwedNoRow) { // SABOTAGE',
    red: [VERIFY],
  },
  {
    name: "sent-counts-attempts",
    why:
      "LVX122: makes `sent` count attempts again. sendCallerSms returns undefined on every path, so a blocked send reads as a delivered one and the net's own evidence overstates itself.",
    file: "services/notifications.js",
    find: "    return await sendSms({ to: toNumber, body });",
    replace: "    await sendSms({ to: toNumber, body });\n    return undefined; // SABOTAGE",
    // NOT tests/postCallVerify.test.js: it stubs `notifications` wholesale, so
    // the real sendCallerSms is never in its path and it stayed GREEN with this
    // reverted. That is the stubbed-execute trap this repository has already
    // written down twice, and it was caught here by the script's own rule
    // rather than by anyone noticing.
    red: [SMS],
  },
  {
    name: "farewell-adjective",
    why:
      "narrows signOffRe back to (great|good|lovely), the state that left CAaef5bd82 on an open line for fourteen seconds. Four of the six farewells in the corpus say 'wonderful'.",
    file: "lib/voice/strings.js",
    // THE WHOLE REGEX, restored to its pre-2026-09-17 text. The first version
    // of this row narrowed only the second alternative and the suite stayed
    // GREEN -- correctly, because every farewell in the corpus says "thanks for
    // calling" and so matches the FIRST alternative, which the fix also
    // widened. A sabotage that does not reproduce the broken state proves
    // nothing, and the script's own rule is what surfaced it.
    find:
      "      /\\b(?:thanks|thank you)(?:\\s+(?:again|so\\s+much|very\\s+much))?\\s+for\\s+calling\\b[^!?]{0,80}?\\b(?:good\\s*bye|bye|(?:great|good|lovely|wonderful)\\s+(?:day|weekend)|take\\s+care)\\b|\\bhave\\s+a\\s+[a-z]+\\s+(?:day|weekend|evening|afternoon)\\b[^a-z]{0,3}$/i,",
    replace:
      "      /\\b(?:thanks|thank you)(?:\\s+(?:again|so\\s+much|very\\s+much))?\\s+for\\s+calling\\b[^!?]{0,80}?\\b(?:good\\s*bye|bye|great\\s+day|good\\s+day|great\\s+weekend|lovely\\s+day|take\\s+care)\\b|\\bhave\\s+a\\s+(?:great|good|lovely)\\s+(?:day|weekend|evening)\\b/i, // SABOTAGE",
    red: [GOODBYE],
  },
  {
    name: "question-before-hangup",
    why:
      "arms the exit whatever the closing turn said. CA2556d43d asked 'Is there anything else I can help you with today?' and dropped the line 1.6 seconds later.",
    file: "lib/voice/live/index.js",
    // RE-ANCHORED 2026-09-18, and onto the WHOLE expression rather than the
    // positional half of it. LVX141 turned this into an alternation, and the
    // standing rule is that a widened alternation gets sabotaged back to its
    // prior text -- narrowing one branch proves nothing while the other still
    // carries the cases, which is how `farewell-adjective` stayed green on its
    // first run. The new branch has its own row below.
    //
    // The old anchor matched ZERO times after the split, and the run said so:
    // this script reports a stranded anchor instead of skipping it, which is the
    // only reason the row did not quietly stop testing anything.
    // RE-ANCHORED AGAIN when LVX145 added the third disjunct. Same rule as
    // last time: the whole expression, because narrowing one branch proves
    // nothing while the other two still carry the cases.
    find:
      "        const askedTheCaller =\n          (endCallArmed && !exitAfterTurn && /\\?['\")\\]\\s]*$/.test(replyAtTurnEnd)) ||\n          heldForInTurnAsk ||\n          heldForUnansweredAsk;",
    replace: "        const askedTheCaller = false; // SABOTAGE",
    red: [EXITCLOSE],
  },
  {
    name: "question-guard-reads-cleared-text",
    why:
      "reads turnReplyText AFTER applyTurn() has cleared it, which is how the guard was written the first time: present, plausible, and silently never firing. The most-repeated defect in this file.",
    file: "lib/voice/live/index.js",
    find: "      const replyAtTurnEnd = String(turnReplyText || \"\").trim();\n      applyTurn();",
    replace: "      applyTurn();\n      const replyAtTurnEnd = String(turnReplyText || \"\").trim(); // SABOTAGE",
    red: [EXITCLOSE],
  },
  {
    name: "zero-text-nudge-while-exiting",
    why:
      "lets the zero-text nudge ask the model to speak on a turn that is already closing. On CAaef5bd82 the nudge and the exit landed 1 ms apart and the caller heard a sentence start and get cut off.",
    file: "lib/voice/live/index.js",
    find: "      if (endCallArmed || pendingExit || exitAfterTurn) {\n        bumpCounter(\"live_zero_text_note_suppressed_exiting\");",
    replace: "      if (false) { // SABOTAGE\n        bumpCounter(\"live_zero_text_note_suppressed_exiting\");",
    red: [EXITCLOSE],
  },
  {
    name: "media-watchdog",
    why:
      "LVX131: the wall-clock check stops noticing a dead stream. CAdfeb9d's socket died mid-sentence with no stop, no close and no error, and because every other timer in the engine is driven by incoming media frames the session froze instead of tearing down -- no summary, no postcall_verify, no escalation, on a call with a refused booking attempt on it.",
    file: "lib/voice/live/index.js",
    find: "    return atMs - lastMediaAt >= MEDIA_TIMEOUT_MS;",
    replace: "    return false; // SABOTAGE",
    red: [WATCHDOG],
  },
  {
    name: "hangup-without-asking",
    why:
      "LVX132: the end_call gate stops refusing a hang-up on a caller who was never asked whether they needed anything else. 0 of 3 calls that called end_call before reaching the confirm step ever asked, and CA2556d4 ended a cancellation without offering to rebook.",
    file: "services/tools.js",
    find: "      if (allowedByExistingGates && !askedAnythingElse && !noAskRefusalSpent) {",
    replace: "      if (false) { // SABOTAGE",
    red: [ASK],
  },
  {
    name: "ask-gate-hits-the-cascade",
    why:
      "drops the wire check, so LVX132's gate runs on a driver that keeps no latch. The cascade passes neither half, so the refusal can never read as spent: it would refuse the first hang-up, and the next, and every one after it. A guard that can refuse twice can hold a caller on the line indefinitely, and that is what LVX21 cost.",
    file: "services/tools.js",
    find: "        askWireLive && !heardOnlyHesitation && (wrappingUp || didSomething || hadConversation);",
    replace: "        !heardOnlyHesitation && (wrappingUp || didSomething || hadConversation); // SABOTAGE",
    red: [TOOLSGATE],
  },
  {
    name: "ask-latch-missing",
    why:
      "LVX132's hair trigger. The one-shot latch never reads as spent, so the gate refuses every hang-up on a call where the model never finds the wording -- which is a caller held on the line with no way off it. LVX21 is what that costs, and a latch that is never set looks identical from services/tools.js's own tests.",
    file: "lib/voice/live/tools.js",
    // RE-ANCHORED 2026-09-19. LVX157 scoped the latch to a completed action, so
    // the expression gained its second conjunct. The sabotage is unchanged in
    // meaning -- the wire reads "never spent" -- and still has to break the same
    // suite, which is the point of re-anchoring rather than retiring a row.
    find:
      "        anythingElseRefusalSpent:\n          anythingElseRefused && anythingElseRefusedAtAction === completedActionCount,",
    replace: "        anythingElseRefusalSpent: false, // SABOTAGE",
    red: [ASK],
  },
  {
    // TWO ROWS FOR ONE EXPRESSION, and that is the rule rather than belt and
    // braces. `farewell-adjective` stayed GREEN on its first run because it
    // narrowed one branch of an alternation while every corpus case matched the
    // other. askedAnythingElse is an alternation of two DIFFERENT turns -- the
    // latch answers for earlier ones, the text test answers for this one -- so
    // each half needs its own row or half the fix has no test.
    name: "ask-branch-latch",
    why:
      "drops the call-scoped half of askedAnythingElse, so a question asked on an EARLIER turn is forgotten by the time the model tries to hang up. This is the ordinary shape: ask, caller answers, hang up.",
    file: "lib/voice/live/index.js",
    // RE-ANCHORED 2026-09-19, LVX157: the latch half is now scoped to the
    // action count it was asked at, so the branch carries its own parentheses.
    find:
      '      (askedAnythingElseThisCall && askedAnythingElseAtAction === completedActionCount) ||\n      Boolean(getStrings(state.config)?.closingTicRe?.test(turnReplyText || "")),',
    replace:
      '      Boolean(getStrings(state.config)?.closingTicRe?.test(turnReplyText || "")), // SABOTAGE',
    red: [ASK],
  },
  {
    name: "ask-branch-in-turn",
    why:
      "drops the half that reads THIS turn's reply at tool time, so a model that asks and calls end_call in one breath is refused although it did exactly the right thing. The latch cannot cover that turn: it is written in auditTurn, at turnComplete, after the tool round.",
    file: "lib/voice/live/index.js",
    // RE-ANCHORED 2026-09-19, LVX157, same reason as the row above.
    find:
      '      (askedAnythingElseThisCall && askedAnythingElseAtAction === completedActionCount) ||\n      Boolean(getStrings(state.config)?.closingTicRe?.test(turnReplyText || "")),',
    replace:
      "      (askedAnythingElseThisCall && askedAnythingElseAtAction === completedActionCount), // SABOTAGE",
    red: [ASK],
  },
  {
    name: "denial-detector-off",
    why:
      "LVX137: the assistant can tell a caller a slot is taken when the system's own availability response listed it as open, and nothing counts it. On CA6df19e98 that was 2:00 PM on a Friday with zero scheduled appointments, and it cost the caller their first-choice time with no row, no refusal and no counter anywhere.",
    file: "lib/voice/live/index.js",
    find: "            if (!S.deniedAvailabilityRe.test(sentence)) continue;",
    replace: "            if (true) continue; // SABOTAGE",
    red: [DENIAL],
  },
  {
    name: "denial-reply-level",
    why:
      "scores the denial over the WHOLE reply instead of sentence by sentence. The real reply turns one time down and offers two others in the same breath -- 'I'm sorry, 2:00 PM is not available. We do have 1:00 PM or 4:30 PM open' -- so a reply-level test counts three denials where there was one, and the number stops meaning anything.",
    file: "lib/voice/live/index.js",
    find: "          for (const sentence of replyText.split(/(?<=[.!?])\\s+/)) {",
    replace: "          for (const sentence of [replyText]) { // SABOTAGE",
    red: [DENIAL],
  },
  {
    name: "confirm-readback-are-you-sure",
    why:
      "restores confirmReadBackRe to its pre-2026-09-18 text, which is the state that lost CAb4427e: the caller said yes to 'Are you sure you would like me to cancel your appointment?' and the cancellation was refused, because this family knew 'shall I', 'would you like me to proceed' and 'are you happy for me to' but not this. Seven write attempts, zero rows, two false claims to the caller.",
    file: "lib/voice/strings.js",
    // The ONLY change made to this expression, removed whole. Both of that
    // call's other confirmations matched the untouched branches, so nothing
    // else can carry this case -- which is what the farewell-adjective row had
    // to learn the hard way.
    find:
      "|are\\s+you\\s+sure\\s+(?:you'?d\\s+like|you\\s+would\\s+like|you\\s+want)\\s+(?:me\\s+)?to\\s+${READ_BACK_ACTION_VERB}",
    replace: "",
    red: [REPLAY],
  },
  {
    name: "assistant-language-detector",
    why:
      "the assistant can answer an English caller in Spanish and nothing counts it. Three calls in eighteen did exactly that, and every one was reported by a human because no instrument watched what the assistant SAID.",
    file: "lib/voice/live/index.js",
    find: "      if (replyLooksNonEnglish(replyText)) {",
    replace: "      if (false) { // SABOTAGE",
    red: [LANG],
  },
  {
    name: "assistant-language-behind-caller-text",
    why:
      "puts the assistant-language check back inside `if (turnUserText)`, which is where it was first written. That guard makes it blind on exactly the calls it exists for: on CAdc602f the caller's 2,640 ms of speech transcribed to ZERO characters, so the turn that answered in Spanish carried no caller text at all. Present, plausible, and silent when it matters -- the most repeated defect shape in this file.",
    file: "lib/voice/live/index.js",
    find: "    if (englishOnlyTenant && replyText) {",
    replace: "    if (englishOnlyTenant && replyText && turnUserText) { // SABOTAGE",
    red: [LANG],
  },
  {
    name: "assistant-language-accent-blind",
    why:
      "stops normalising accents, so a marker that exists ONLY in an accented form stops matching. The Spanish turns survive this on their unaccented markers alone, which is why the first version of this row stayed GREEN and the fix had no test -- the case that fails is 'Voce prefere amanha ou quinta feira', whose only marker is accented.",
    file: "lib/transcriptUtils.js",
    find: "  const words = stripDiacritics(text)\n    .toLowerCase()",
    replace: "  const words = String(text) // SABOTAGE\n    .toLowerCase()",
    red: [LANG],
  },
  {
    name: "assistant-language-hits-multilingual",
    why:
      "drops the English-only condition, so a tenant configured for two languages is counted as faulty every time it does the thing services/gemini.js explicitly tells it to do -- reply in the caller's language. The counter would then fire hardest exactly where the behaviour is correct.",
    file: "lib/voice/live/index.js",
    find: "    if (englishOnlyTenant && replyText) {",
    replace: "    if (replyText) { // SABOTAGE",
    red: [LANG],
  },
  {
    name: "call-summary",
    why:
      "drops the per-call claim ledger from live_call_summary, the other half of fdd3035. Without it, 'did the claim guard evaluate this turn' has no per-call answer -- which is the question CAb76b13 is still waiting on.",
    file: "lib/voice/live/index.js",
    find: "      claim_audit: { ...claimAudit },",
    replace: "      // SABOTAGE",
    red: [SESSION],
  },
  // -------------------------------------------------------------------------
  // LVX140. The claim guard's look-back, and BOTH halves of the fix.
  // -------------------------------------------------------------------------
  {
    name: "claim-guard-counts-attempts",
    why:
      "restores the attempts-minus-refusals tally the claim guard used until 2026-09-18. The arithmetic is right and the TIMING is not: the attempt is counted before `await runner.handleToolCall` and the refusal after it, and nothing serialises that against turnComplete. On CAd978554 the turn rolled inside the await, so actionToolRanPrevTurn was written from a tally holding the attempt and not the refusal, and 'I have successfully rescheduled your appointment' went uncontradicted.",
    file: "lib/voice/live/index.js",
    find: "  const actionToolsRanThisTurn = () => actionToolSucceededThisTurn;",
    replace:
      "  const actionToolsRanThisTurn = () =>\n    actionToolCallsThisTurn - refusedActionCallsThisTurn > 0; // SABOTAGE",
    red: [CLAIMRACE],
  },
  {
    name: "claim-credit-ignores-late-result",
    why:
      "drops the half that credits a tool result to the turn it was CALLED on. Without it a write that succeeds while the turn is rolling is credited to nobody, the look-back reads false, and the guard accuses the model of fabricating a booking it actually made. The refusal half alone is satisfied by a guard that simply always speaks; this is what stops that being the fix.",
    file: "lib/voice/live/index.js",
    find: "        else if (seq === turnSeq - 1) actionToolRanPrevTurn = true;",
    replace: "        // SABOTAGE",
    red: [CLAIMRACE],
  },
  // -------------------------------------------------------------------------
  // LVX141. The closing seam. Three rows, because the fix is three facts: the
  // flag is SET only for an in-turn ask, it is READ by the hold, and it is
  // SPENT when the hold fires. Breaking one and watching the others carry the
  // cases is how `farewell-adjective` stayed green on its first run.
  // -------------------------------------------------------------------------
  {
    name: "exit-hold-ignores-in-turn-ask",
    why:
      "restores the exit hold to the positional test alone. CA94f2b4 asked 'Is there anything else I can help you with today?' and said 'have a great day' in the same breath: the reply ends with the farewell, so the positional test says no, and LVX132's ask gate had already allowed the hang-up on the strength of that same question. The caller got 1.5 seconds of dial tone in which to answer.",
    file: "lib/voice/live/index.js",
    find: "        const heldForInTurnAsk = endCallArmed && !exitAfterTurn && endCallAskWasInTurnOnly;",
    replace: "        const heldForInTurnAsk = false; // SABOTAGE",
    red: [EXITCLOSE],
  },
  {
    name: "in-turn-ask-ignores-the-latch",
    why:
      "makes every closing turn that contains the question look like an in-turn ask, by dropping the `askedAnythingElseThisCall` half. The distinction IS the fix: a caller asked on an earlier turn has already had their chance to answer, and holding that call costs an extra turn on every normal close. Red on the earlier-turn control rather than on the CA94f2b4 case, which is the point of having both.",
    file: "lib/voice/live/index.js",
    find: "        !askedAnythingElseThisCall &&",
    replace: "        true && // SABOTAGE",
    red: [EXITCLOSE],
  },
  {
    name: "in-turn-ask-hold-never-spent",
    why:
      "leaves the one-shot standing after it fires. `endCallArmed` is never lowered, so an unspent flag holds the exit at the end of every remaining turn and the line can never close -- trading a premature hang-up for a call nobody can end, which is the defect on the other call of that night.",
    file: "lib/voice/live/index.js",
    // RE-ANCHORED when LVX145 put its own spend between this line and the
    // `} else {` the anchor used to reach for. The preceding log line is what
    // makes it unique -- `endCallAskWasInTurnOnly = false;` now appears in both
    // branches, and an anchor matching twice is refused rather than guessed at.
    find:
      "            log.info(\"live_exit_held_unanswered_ask\", { callSid, step: state.step });\n          }\n          endCallAskWasInTurnOnly = false;",
    replace:
      "            log.info(\"live_exit_held_unanswered_ask\", { callSid, step: state.step });\n          }\n          // SABOTAGE",
    red: [EXITCLOSE],
  },
  {
    name: "unanswered-ask-hold-never-spent",
    why:
      "leaves LVX145's one-shot standing after it fires. The caller may still say nothing, so an unspent flag holds the exit at the end of every remaining turn and the line can never close -- trading a premature hang-up for a call nobody can end, which is CAaef5bd82's defect and the worse of the two.",
    file: "lib/voice/live/index.js",
    find: "          endCallAskUnanswered = false;\n        } else {",
    replace: "          // SABOTAGE\n        } else {",
    red: [EXITCLOSE],
  },
  // -------------------------------------------------------------------------
  // LVX142. The post-call escalation.
  // -------------------------------------------------------------------------
  {
    name: "abandoned-escalation-narrowed",
    why:
      "puts `&& bookedRows.length === 0` back in front of the abandoned-write escalation. `abandoned` already excludes any tool that later succeeded, so that conjunct never tested what its comment claimed -- it tested whether some OTHER tool succeeded. On CAd978554 an unrelated booking four minutes later vouched for an abandoned reschedule and nobody was told that a caller had been lied to.",
    file: "lib/postCallVerify.js",
    find: '  if (verdict === "claim_without_row" || bookingOwedNoRow || abandonedOutstanding) {',
    replace:
      '  if (verdict === "claim_without_row" || bookingOwedNoRow || abandonedWithNoRow) { // SABOTAGE',
    red: [VERIFY],
  },
  {
    name: "denial-scored-whole-sentence",
    why:
      "restores scoring the whole sentence, so a reply that turns one time down and offers two others in the SAME sentence counts all three. CA58bb3640 reported slots [13:30, 14:00, 14:30] for one refusal -- double, on the call meant to establish the rate. This counter decides whether the underlying defect is worth a gate, and a number that over-reports argues for building the wrong thing.",
    file: "lib/voice/live/index.js",
    find:
      "            const deniedClauses = sentence\n              .split(/\\b(?:but|however|although|though)\\b/i)\n              .filter((clause) => S.deniedAvailabilityRe.test(clause));\n            const denied = openSlots.filter((slot) =>\n              deniedClauses.some((clause) => readBackMentionsSlot(clause, slot))\n            );",
    replace:
      "            const denied = openSlots.filter((slot) => readBackMentionsSlot(sentence, slot)); // SABOTAGE",
    red: [DENIAL],
  },
  {
    name: "english-tenant-told-nothing",
    why:
      "puts the identity section back to saying NOTHING about language for languagesSpoken: [\"en\"] -- length 1, and it is English, so neither existing branch fires. That silence is why CA5b7e359 answered in Spanish and CA58bb3640 in French: live transcription handed the model a foreign-language turn and nothing in the prompt said what the business speaks.",
    file: "services/gemini.js",
    find:
      "  } else {\n    identity += `\\nThis business operates in English and ALWAYS replies in English.",
    replace:
      "  } else if (false) { // SABOTAGE\n    identity += `\\nThis business operates in English and ALWAYS replies in English.",
    red: [LANG, PROMPTS],
  },
  // -------------------------------------------------------------------------
  // LVX147. Two rows, because the fix is in two files: verifyCall has to UNION
  // the two readers, and the live teardown has to HAND IT the judge's answer.
  // Breaking one while the other stands is how half a fix ships looking whole.
  // -------------------------------------------------------------------------
  {
    name: "judge-claim-not-unioned",
    why:
      "puts the verdict back on the phrase matcher alone. It lost three times on three consecutive production calls -- CA239c7c 'has been SUCCESSFULLY rescheduled', CA7ec8af 'I have THAT CALL booked', CA299f23 'THAT IS all booked' -- with the judge right every time. Without the union a caller told they are booked, on a call that ran no tool at all, reads as verdict ok and nobody hears about it.",
    file: "lib/postCallVerify.js",
    find: '  const claimed = claims.some((c) => c?.kind === "claim") || judgeClaimedDone === true;',
    replace: '  const claimed = claims.some((c) => c?.kind === "claim"); // SABOTAGE',
    red: [VERIFY],
  },
  {
    name: "judge-answer-dropped",
    why:
      "stops the teardown handing the judge's answer to verifyCall, which is what it did until 2026-09-18: the answer was computed, logged and dropped on the floor. verifyCall's own tests still pass with this -- they hand it the field directly -- so only the wire test can see it. A producer whose field is never copied is the most-repeated defect in lib/voice/live/index.js.",
    file: "lib/voice/live/index.js",
    // RE-ANCHORED onto the CORRECT key. The first version of this row pointed
    // at `j?.claimed_done`, which was the bug it was meant to guard -- so the
    // row was sabotaging a line that already did nothing, and reported red
    // against a wire that was broken in production.
    find: "          return runVerify(j?.claimedDone === true ? true : undefined);",
    replace: "          return runVerify(undefined); // SABOTAGE",
    red: [POSTCALLWIRE],
  },
  // -------------------------------------------------------------------------
  // LVX145. The third closing shape. Two rows: the marker has to be RECORDED
  // when the question goes out, and it has to be READ when the exit arms.
  // -------------------------------------------------------------------------
  {
    name: "unanswered-ask-hold",
    why:
      "removes the hold for a question the caller never got to answer. CA06cadea6: asked at 17:28:08, end_call allowed at 17:28:14, line down at 17:28:23, with forty milliseconds of the caller's voice in between. LVX132's latch had already recorded that they were ASKED and is never reset, so every check downstream passed.",
    file: "lib/voice/live/index.js",
    find: "        const heldForUnansweredAsk = endCallArmed && !exitAfterTurn && endCallAskUnanswered;",
    replace: "        const heldForUnansweredAsk = false; // SABOTAGE",
    red: [EXITCLOSE],
  },
  {
    name: "unanswered-ask-marker-never-set",
    why:
      "leaves the caller-transcript marker at -1, so the hold can never fire however long the caller stays silent. The read and the write are separate rows because a guard reading a value nothing writes is this file's most-repeated defect -- present, plausible and permanently dead.",
    file: "lib/voice/live/index.js",
    find: "        askedAnythingElseAtCallerChars = callerSaidThisCall.length;",
    replace: "        // SABOTAGE",
    red: [EXITCLOSE],
  },
  // -------------------------------------------------------------------------
  // LVX143/144. The two detectors the first live call on 963dfef found.
  // -------------------------------------------------------------------------
  {
    name: "claim-adverb-slot",
    why:
      "puts the claim detector's adverb slot back to the literal word `now`. CA239c7cd2: 'Your appointment has been SUCCESSFULLY rescheduled to Thursday, September 24 at 2:00 PM' on a call with changed_rows 0 -- claim_audit read claimed:0, so the sentence was never detected and none of LVX140's look-back could reach it. One ordinary English word defeated the whole predicate.",
    file: "lib/voice/strings.js",
    find: "const CLAIM_ADVERB = String.raw`(?:(?:now|already|just|[a-z]+ly)\\s+)?`;",
    replace: "const CLAIM_ADVERB = String.raw`(?:now\\s+)?`; // SABOTAGE",
    red: [CLAIM],
  },
  {
    name: "no-worries-is-a-withdrawal",
    why:
      "restores the bare `no` in the withdrawal list. CAb4427e: 'Yeah, no worries.' answering a read-back, refused because an agreement idiom contains the word no. There is no reading of that turn in which the caller took anything back. No marker is possible -- the patch is inside a regex, which is the `confirm-readback-are-you-sure` shape and the reason the journal exists.",
    file: "lib/transcriptUtils.js",
    find: "(?:no(?!\\s+(?:worries|problems?|probs))|nope|nah|not|",
    replace: "(?:no|nope|nah|not|",
    red: [AFFIRM],
  },
  {
    name: "restated-slot-not-agreement",
    why:
      "removes LVX144 entirely: the caller answering 'Shall we reschedule to Thursday, September 24 at 2:00 PM?' with 'the Thursday 2 p.m.' goes back to reading as no answer at all. That is CA239c7c, changed_rows 0, and a caller told it had been done. Red in the corpus too, because the fixture for that call expects the write.",
    file: "services/tools.js",
    find: "            const callerAgreed = isAffirmative(lastCallerText) || callerRestatedSlot;",
    replace: "            const callerAgreed = isAffirmative(lastCallerText); // SABOTAGE",
    red: [ORDER, REPLAY],
  },
  {
    name: "restated-slot-ignores-question",
    why:
      "drops the question-mark guard, so 'Ten a.m.?' -- the caller CHECKING rather than agreeing -- authorises the write. The slot matcher cannot tell those apart and is not meant to; the punctuation is the one signal on this path that is not a judgement call, and it is the whole reason this widening was safe enough to take.",
    file: "services/tools.js",
    // RE-ANCHORED when the derivation moved up to the probe so the rule could
    // be logged. There is one copy now; there were briefly two, which is the
    // state where this anchor could have kept matching the dead one and gone on
    // reporting red about code nothing calls.
    find: "              !/\\?\\s*$/.test(lastCallerText.trim()) &&",
    replace: "              true && // SABOTAGE",
    red: [ORDER],
  },
  {
    name: "refusal-hides-the-outcome",
    why:
      "a held write goes back to opening with reassurance alone and never saying what the state of the world is, which is the text 11 of the 39 refused-write episodes in call-corpus/ were spoken into before the assistant told the caller it was done. LVX150. The whole point of that round is that `success: false` on its own is one boolean against three sentences of 'nothing is wrong', so if this clause can be removed with the suite still green, the round shipped nothing that is held in place.",
    file: "services/tools.js",
    find: "    `[not caller speech] NOTHING HAS BEEN WRITTEN — ${heldWriteState(toolName)}. ` +",
    replace: "    `[not caller speech] ` + // SABOTAGE",
    red: [ORDER],
  },
  {
    name: "ceiling-ignores-the-read-back",
    why:
      "the early ceiling stops distinguishing 'we asked properly and could not read the answer twice' from 'we never asked', so every held write waits for the third attempt again -- and the model gives up after two. CA9c8e42 is what that costs: the caller asked to cancel four times, was told three times that the system was broken, and the appointment is still standing. Measured across 45 refusals, 14 of the 18 where a read-back HAD been made had the caller speaking before the write, with the answer mangled in transcription -- 'go on' as 'gone', 'that works' as 'nada works'.",
    file: "services/tools.js",
    find: "              const orderCeiling = readBackMade",
    replace: "              const orderCeiling = false // SABOTAGE",
    red: [ORDER],
  },
  {
    name: "ceiling-keyed-on-wording",
    why:
      "the write-order ceiling goes back to identifying a proposal by the assistant's SENTENCE, so a model that rephrases its read-back resets the count to zero and the escape hatch can never be reached. Measured before the fix: 49 write_order_refused across 32 calls in call-corpus/ and write_order_gate_ceiling fired ZERO times. CA00649d86 is what that costs -- a caller asked to cancel, the yes came through as 'A la works.', three refusals across three wordings, the model gave up and offered a callback, and the appointment is still standing.",
    file: "services/tools.js",
    find: "            const sameProposal = orderScratch.writeOrderProposalKey === proposalKey;",
    replace:
      "            const sameProposal = orderScratch.writeOrderReadBackKey === readBackKey; // SABOTAGE",
    red: [ORDER],
  },
  {
    name: "refusal-noun-ignores-the-tool",
    why:
      "every held write says 'the appointment has NOT been booked', including a cancellation and a reschedule. Telling the model a cancellation was not BOOKED is a second false statement in the other direction, and it is the specific failure a single shared refusal string invites -- the message is one sentence away from being right for three tools and wrong for two of them.",
    file: "services/tools.js",
    find: "  const state = HELD_WRITE_STATE[toolName];",
    replace: "  const state = HELD_WRITE_STATE.book_appointment; // SABOTAGE",
    red: [ORDER],
  },
  // -------------------------------------------------------------------------
  // LVX157. FOUR ROWS, because the fix is four separate decisions and three of
  // them are one-line conjuncts that a suite could easily not be looking at.
  // -------------------------------------------------------------------------
  {
    name: "completion-ask-note",
    why:
      "removes the instruction that rides back with a completed write, which is the ONLY point at which a sign-off can be prevented rather than caught: end_call's declaration requires the farewell in the same response as the call, so every gate downstream runs after the words exist. bfb65fb tried to make the words wait instead and f603af4 reverted it the same day for six seconds of dead air.",
    file: "lib/voice/live/tools.js",
    find: "            result.functionResponse.response.next_step = COMPLETION_ASK_NOTE;",
    replace: "            // SABOTAGE",
    red: [COMPLETIONASK],
  },
  {
    // A THIRD ROW ON askedAnythingElse, and the reason is the rule this file
    // already states twice: ask-branch-latch and ask-branch-in-turn break the
    // two ALTERNATIVES, and neither of them can see the conjunct added inside
    // the first one. A row per decision, not a row per expression.
    name: "ask-latch-per-action",
    why:
      "restores the call-scoped ask latch -- 'never reset, a caller asked once has been asked'. CA0ef8d221 asked at 15:53:04 with NOTHING booked, booked at 15:55:37, and signed off unasked at 15:55:46 with end_call_refusals {no_ask: 0}. The gate was satisfied by a question about an empty diary two and a half minutes earlier. CA58bb3640 is the same shape with a cancel in front of it.",
    file: "lib/voice/live/index.js",
    find:
      "      (askedAnythingElseThisCall && askedAnythingElseAtAction === completedActionCount) ||",
    replace: "      askedAnythingElseThisCall || // SABOTAGE",
    red: [COMPLETIONASK],
  },
  {
    name: "no-ask-refusal-rearm",
    why:
      "puts the no-ask refusal back to one-shot per CALL. CA84dc64 spent it at 20:56:22 on a cancel the caller then abandoned, completed a booking at 20:58:31, and the sign-off at 20:58:36 went through ungated -- the gate was inert at the only moment it mattered. Re-arming requires a SUCCESSFUL write, so LVX21's livelock stays unreachable: a refused write re-arms nothing.",
    file: "lib/voice/live/tools.js",
    find: "        if (anythingElseRefused && anythingElseRefusedAtAction !== completedActionCount) {",
    replace: "        if (false) { // SABOTAGE",
    red: [COMPLETIONASK],
  },
  {
    name: "goodbye-held-per-action",
    why:
      "puts LVX146's hold back to one-shot per call. That door is the one a model walks through by simply SAYING a farewell and never calling end_call -- CA299f23ce, CAb4c0eb91 -- so the gate rows above cannot cover it at all. Spent on one piece of work, the back door stood open for the next.",
    file: "lib/voice/live/index.js",
    find: "        if (askStillOutstanding && goodbyeExitHeldAtAction !== completedActionCount) {",
    replace: "        if (askStillOutstanding && goodbyeExitHeldAtAction === null) { // SABOTAGE",
    red: [COMPLETIONASK],
  },
  // -------------------------------------------------------------------------
  // LVX151. THREE ROWS, for the same reason: two additions and the guard that
  // makes one of them safe. A single row switching the pair off would go red on
  // any of the three being broken and prove none of them individually.
  // -------------------------------------------------------------------------
  {
    name: "claim-open-head-noun",
    why:
      "closes the head noun back to appointment|booking|call|consultation adjacent to the determiner. The only tenant this project runs books a 'free strategy call' and sells an 'All-In-One Package' -- note that 'call' IS in that list and still does not help, because in 'your free strategy call' it is not next to the determiner. Five turns in the corpus, including CA954592e1's sign-off fabrication.",
    file: "lib/voice/strings.js",
    find: "    String.raw`(?:[a-z][a-z-]*\\s+){0,3}` +",
    replace: "    String.raw`(?:[a-z][a-z-]*\\s+){0,0}` + // SABOTAGE",
    red: [CLAIMRE],
  },
  {
    name: "claim-uncontracted-copular",
    why:
      "puts the copular branch back to contractions only. 'That is all booked.' was spoken on CA299f23ce eight seconds after a REFUSED book, on a call that wrote nothing, and claimCopular covers that's / it's / you're / you are and stops there. One character of contraction was the whole difference between a fabrication alert and silence.",
    file: "lib/voice/strings.js",
    find:
      "  String.raw`\\b(?:that|it|everything|you)\\s+(?:is|are)\\s+(?:all\\s+)?(?:${CLAIM_DONE_PARTICIPLES})\\b`,",
    replace:
      "  String.raw`\\b(?:that|it|everything|you)\\s+(?:'s|'re)\\s+(?:all\\s+)?(?:${CLAIM_DONE_PARTICIPLES})\\b`, // SABOTAGE",
    red: [CLAIMRE],
  },
  {
    name: "claim-question-guard",
    why:
      "lets interrogative sentences reach the two additions. Required by the open head noun and by nothing else: 'The phone number the appointment is booked under?' has exactly a claim's shape and is the assistant ASKING. The closed noun list protected the old predicate from that sentence for free; the open one has to be protected on purpose, and without this the guard starts contradicting the model for asking a question.",
    file: "lib/voice/strings.js",
    find: '    .filter((s) => s.trim() && !s.trim().endsWith("?"));',
    replace: "    .filter((s) => s.trim()); // SABOTAGE",
    red: [CLAIMRE],
  },
];

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
// RESUME. A killed run costs the whole matrix otherwise, and the rows already
// proven red do not become less red for having been interrupted. Named rather
// than numbered, so reordering the array cannot silently skip a different row
// than the one intended.
const from = process.argv.includes("--from")
  ? process.argv[process.argv.indexOf("--from") + 1]
  : null;
if (from && !SABOTAGES.some((s) => s.name === from)) {
  console.error(`--from ${from}: no row by that name.`);
  process.exit(1);
}
let reached = !from;

// ---------------------------------------------------------------------------
// A FOURTH RULE, added 2026-09-18: a run this cannot READ is not a red run.
//
// The corpus grew to eighteen calls and these suites log every gate decision,
// so the combined output of the target files went past spawnSync's 1 MB default
// and the call came back with status null and `spawnSync ... ENOBUFS`. The
// baseline then reported "Baseline is RED" against sixteen suites that were all
// green when run by hand. That is the harmless direction.
//
// The other direction is not. `ok: res.status === 0` is false for ENOBUFS too,
// so a PATCHED run that overflowed would have printed `v <name>: red, ? test(s)
// failed` and counted as a sabotage the suite caught -- with nothing measured
// at all. A matrix reporting a pass it never observed is the exact failure this
// script exists to object to, turned on itself.
//
// So: a large buffer, `--silent` so a run stops carrying every log line the
// tests print, and an UNREADABLE verdict distinct from both red and green.
// Neither caller is allowed to guess.
// ---------------------------------------------------------------------------
function runSuites(files) {
  // `--silent=true`, not a bare `--silent`: this vitest's CLI parser folds the
  // next positional into the flag and dies with
  //   Unexpected value "--silent=tests/postCallVerify.test.js"
  // which is a crash, not a red suite -- and before the unreadable verdict
  // below existed it would have read as one.
  // `--no-file-parallelism`: ONE worker, files in sequence.
  //
  // The OS killed this script for memory on 2026-09-18 for the second time,
  // twenty-three rows into a thirty-seven row matrix, holding
  // lib/voice/live/index.js patched. The journal did its job and named the file,
  // so the tree was restored in under a minute instead of being discovered days
  // later -- but the right answer to "this gets killed for memory" is to stop
  // using so much of it, not to keep getting better at cleaning up afterwards.
  //
  // Vitest's default pool spawns a worker per core and this repo's suites boot
  // whole Live sessions. Thirty-seven invocations of that back to back is what
  // the machine cannot take. Sequential costs wall clock and nothing else: the
  // matrix is not on anyone's critical path, and a run that finishes is worth
  // more than a fast one that dies holding a patch.
  const res = spawnSync("npx", ["vitest", "run", "--silent=true", "--no-file-parallelism", ...files], {
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  // Strip ANSI before matching. vitest colours the numbers, so a pattern
  // written against the visible text silently misses and reports "?" -- a tally
  // that cannot be read is the thing this whole script exists to object to.
  const out = `${res.stdout || ""}${res.stderr || ""}`.replace(/\[[\d;]*m/g, "");
  const failedMatch = out.match(/Tests\s+(\d+)\s+failed/);
  const passedMatch = out.match(/Tests\s+.*?(\d+)\s+passed/);
  // The tally line is the only proof vitest ran to completion. Without it, or
  // with no exit status at all, we know nothing -- and saying so is the whole
  // point of this return shape.
  const unreadable = res.error != null || res.status == null || (!failedMatch && !passedMatch);
  return {
    ok: !unreadable && res.status === 0,
    failed: failedMatch ? Number(failedMatch[1]) : unreadable ? null : 0,
    unreadable,
    reason: res.error?.message || (res.status == null ? "no exit status" : "no test tally in the output"),
  };
}

// ---------------------------------------------------------------------------
// --census: does every anchor still land, WITHOUT running a single suite.
//
// The full matrix was OOM-killed again on 2026-09-19, mid-row, leaving
// lib/voice/strings.js patched and the journal naming it -- the recovery this
// script's own docstring warns is dangerous when the file holds uncommitted
// work, which is why committing first is the rule.
//
// The two questions the matrix answers are separable, and only one of them is
// expensive. "Does the anchor still match exactly once" is a string count over
// files already on disk; "does the row still go red" needs vitest. An edit
// somewhere else in a patched file can only break the FIRST one, so after an
// ordinary change this is the check that is actually about the change -- and it
// runs in under a second for all of them instead of dying halfway.
//
// It is not a substitute for the matrix. A green census says the anchors point
// at live code, never that the suites can still see the damage.
// ---------------------------------------------------------------------------
if (process.argv.includes("--census")) {
  let drifted = 0;
  const seen = new Map();
  for (const s of SABOTAGES) {
    if (seen.has(s.name)) {
      console.error(`x ${s.name}: duplicate row name.`);
      drifted += 1;
    }
    seen.set(s.name, true);
    if (!fs.existsSync(s.file)) {
      console.error(`x ${s.name}: ${s.file} does not exist.`);
      drifted += 1;
      continue;
    }
    const hits = fs.readFileSync(s.file, "utf8").split(s.find).length - 1;
    if (hits !== 1) {
      console.error(`x ${s.name}: anchor matches ${hits} times in ${s.file}, not once.`);
      drifted += 1;
      continue;
    }
    for (const suite of s.red) {
      if (!fs.existsSync(suite)) {
        console.error(`x ${s.name}: names a red suite that does not exist -- ${suite}`);
        drifted += 1;
      }
    }
  }
  console.log(
    drifted === 0
      ? `census: ${SABOTAGES.length} rows, every anchor lands exactly once and every red suite exists.`
      : `census: ${drifted} problem(s) across ${SABOTAGES.length} rows.`
  );
  process.exit(drifted === 0 ? 0 : 1);
}

console.log("Baseline: the suites must be green BEFORE anything is broken.\n");
// NARROWED FOR --only, and this is a memory fix as much as a speed one.
//
// The baseline ran every suite named by every row -- nineteen of them, each
// booting Live sessions -- even when `--only` was going to break one line and
// check one file. That is most of the run, and the OS killed this script three
// times on 2026-09-18 under exactly that pressure.
//
// A single row's baseline question is only ever "are the suites this row claims
// to break green right now". The wider run is the right default when every row
// is going to execute; it is pure waste when one is.
const targets = only
  ? [...new Set(SABOTAGES.filter((s) => s.name === only).flatMap((s) => s.red))]
  : [...new Set(SABOTAGES.flatMap((s) => s.red))];
const baseline = runSuites(targets);
if (baseline.unreadable) {
  console.error(`Baseline could not be READ: ${baseline.reason}.`);
  console.error("That is not the same as red. Nothing was measured, so nothing below would mean");
  console.error("anything -- fix the run before trusting a single row.");
  process.exit(1);
}
if (!baseline.ok) {
  console.error("Baseline is RED. Fix the suite before asking whether it can fail.");
  process.exit(1);
}
console.log(`  green: ${targets.join(" ")}\n`);

let bad = 0;
for (const s of SABOTAGES) {
  if (only && s.name !== only) continue;
  if (from) {
    if (s.name === from) reached = true;
    if (!reached) continue;
  }

  const original = fs.readFileSync(s.file, "utf8");
  const hits = original.split(s.find).length - 1;
  if (hits !== 1) {
    console.error(`x ${s.name}: its anchor matches ${hits} times in ${s.file}, not once.`);
    console.error("  The code moved. Fix the anchor -- a sabotage that does not land reports as a broken test.");
    bad += 1;
    continue;
  }

  let result;
  // Claimed BEFORE the write, so a kill between the two leaves a journal
  // naming a file that is still intact -- the harmless direction.
  claimJournal(s.file);
  try {
    const patched = original.replace(s.find, s.replace);
    fs.writeFileSync(s.file, patched);
    // THE ASSERTION THE RULE IS ABOUT: the bytes on disk actually changed.
    if (fs.readFileSync(s.file, "utf8") === original) {
      throw new Error("the patch did not change the file");
    }
    result = runSuites(s.red);
  } finally {
    fs.writeFileSync(s.file, original);
    if (fs.readFileSync(s.file, "utf8") !== original) {
      console.error(`FATAL: ${s.file} was not restored. Check it before doing anything else.`);
      process.exit(2);
    }
    // Only once the bytes are confirmed back.
    releaseJournal();
  }

  if (result.unreadable) {
    // NOT counted as red. An overflowed or crashed run fails the same exit-code
    // test a genuine failure does, and letting it through here is how a row
    // nobody measured reports as a row the suite caught.
    console.log(`x ${s.name}: the run could not be READ (${result.reason}). Nothing was measured.`);
    bad += 1;
  } else if (result.ok) {
    console.log(`x ${s.name}: STILL GREEN with the fix removed. The suite is not watching this.`);
    console.log(`    ${s.why}`);
    bad += 1;
  } else {
    console.log(`v ${s.name}: red, ${result.failed ?? "?"} test(s) failed. ${s.red.join(" ")}`);
  }
}

console.log("");
if (bad) {
  console.error(`${bad} sabotage(s) did not produce a failure. The suite cannot see them.`);
  process.exit(1);
}
console.log("Every sabotage produced a failure, and every file was restored.");
