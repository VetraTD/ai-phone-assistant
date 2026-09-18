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
    find:
      "        const askedTheCaller =\n          (endCallArmed && !exitAfterTurn && /\\?['\")\\]\\s]*$/.test(replyAtTurnEnd)) || heldForInTurnAsk;",
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
    find: "        anythingElseRefusalSpent: anythingElseRefused,",
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
    find:
      '      askedAnythingElseThisCall ||\n      Boolean(getStrings(state.config)?.closingTicRe?.test(turnReplyText || "")),',
    replace:
      '      Boolean(getStrings(state.config)?.closingTicRe?.test(turnReplyText || "")), // SABOTAGE',
    red: [ASK],
  },
  {
    name: "ask-branch-in-turn",
    why:
      "drops the half that reads THIS turn's reply at tool time, so a model that asks and calls end_call in one breath is refused although it did exactly the right thing. The latch cannot cover that turn: it is written in auditTurn, at turnComplete, after the tool round.",
    file: "lib/voice/live/index.js",
    find:
      '      askedAnythingElseThisCall ||\n      Boolean(getStrings(state.config)?.closingTicRe?.test(turnReplyText || "")),',
    replace: "      askedAnythingElseThisCall, // SABOTAGE",
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
    find: "          endCallAskWasInTurnOnly = false;\n        } else {",
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

console.log("Baseline: the suites must be green BEFORE anything is broken.\n");
const targets = [...new Set(SABOTAGES.flatMap((s) => s.red))];
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
