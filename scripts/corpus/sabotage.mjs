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
// Usage:  node scripts/corpus/sabotage.mjs [--only <name>] [--from <name>] [--to <name>] [--rows <file>]
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
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
// ---------------------------------------------------------------------------
// A FOURTH RULE, added 2026-10-21 (gate pron2, shard A): Windows refused the
// RESTORE write with `UNKNOWN: unknown error, open '...index.js'` (a transient
// lock -- antivirus or an indexer holding the file), the process died in the
// finally block, and only luck left the tree clean. A write that fails for a
// transient reason is retried for up to ~6 s before anything gives up.
// ---------------------------------------------------------------------------
const TRANSIENT_WRITE = new Set(["UNKNOWN", "EBUSY", "EPERM", "EACCES", "EAGAIN"]);
function writeFileRetrying(file, data) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (err) {
      if (!TRANSIENT_WRITE.has(err?.code) || attempt >= 20) throw err;
      console.error(`  (write to ${file} refused: ${err.code}; retry ${attempt}/20)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
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
const OUTBOUND_STRINGS = "tests/outboundStrings.test.js";
const EXITCLOSE = "tests/liveExitClose.test.js";
const WATCHDOG = "tests/liveMediaWatchdog.test.js";
const ASK = "tests/liveEndCallAsk.test.js";
// LVX157's suite. A DIFFERENT question from ASK's: that one asks whether the
// gate refuses a caller who was never asked, this one whether an ask or a
// refusal spent on EARLIER work still counts for the write that just landed.
// Every call in ASK has exactly one completed action, so no case in it can tell
// the two apart -- the same shape as the CLAIM/CLAIMRACE split above.
const COMPLETIONASK = "tests/liveCompletionAsk.test.js";
// LVX160/LVX161. The two ways a write the caller ASKED FOR ended with nothing
// written. Not a tail case: measured across call-corpus/ before either fix, of
// the calls that ATTEMPTED each write, the share ending with no row at all was
// book 24% (5 of 21), cancel 21% (4 of 19), reschedule 33% (3 of 9).
const RECOVERY = "tests/liveWriteRecovery.test.js";
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
// 2026-10-02 rows: the outbound name-on-file rule and the callback-question
// suppression, each proven through the suite that drives the real code path.
const NAMEFILE = "tests/outboundNameOnFile.test.js";
const CALLBACKLIVE = "tests/liveCallbackRecognition.test.js";
// The teardown wiring, which is a different question from what verifyCall does
// with what it is handed.
const POSTCALLWIRE = "tests/livePostCall.test.js";
// The byte-locked prompt. A language instruction that vanishes is invisible to
// every behavioural suite -- the model simply drifts on calls nobody is running.
const PROMPTS = "tests/promptSnapshot.test.js";
// Checkpoint 2b review, I5. The first-seconds controller's own suite -- the
// mark-echo confirmation has no wire into any OTHER suite, so this is the
// only place a broken re-arm can be seen at all.
const FIRSTSECONDS = "tests/outboundFirstSeconds.test.js";
// 2026-10-02 batch 2 rows.
const RETRY = "tests/liveWriteRetry.test.js";
const LIVEMODE = "tests/liveOutboundLiveMode.test.js";
const READBACKRE = "tests/confirmReadBackRe.test.js";
const OUTPROMPT = "tests/outboundPrompt.test.js";
const TWIML = "tests/twiml.test.js";
const DEGRADED = "tests/degradedMode.test.js";
// U4: the transfer Dial's action/timeout, and which Twilio account the REST update uses.
const TRANSFERLIVE = "tests/outboundTransfer.test.js";
const TRANSFERACCT = "tests/liveTransferAccount.test.js";
const TRANSFEROUTCOME = "tests/transferOutcome.test.js";
const TRANSFERRESULT = "tests/transferResult.test.js";
const SESSION_CASCADE = "tests/session.test.js";
// Round A1 "say it once" (2026-10-13, S2 T8).
const A1_SAVEPOLICY = "tests/liveSavePolicy.test.js";
// LVX179 + Fix 3 (round A1 part 5): the replay of the three live calls and the one-question rule.
const LVX179_REPLAY = "tests/lvx179Replay.test.js";
const A1_SAVEWIRE = "tests/liveSavePolicyWire.test.js";
const A1_READBACKSTMT = "tests/readBackStatement.test.js";
const A1_SPELLONCE = "tests/spellOnce.test.js";
const A1_LADDERWORDS = "tests/silenceLadderWords.test.js";
const A1_SILENCEREADBACK = "tests/liveSilenceReadBack.test.js";
const A1_CONFIRMAUDIT = "tests/liveConfirmAudit.test.js";
const A1_E2E = "tests/liveWritePathEndToEnd.test.js";
const A1_LIVESILENCE = "tests/liveSilence.test.js";
const A1_CLOSINGORDER = "tests/closingOrder.test.js";
// Round A1 S3 (2026-10-14): I3 -- a same-call correction updates; one email.
const S3_REQUESTS = "tests/customerRequestCorrection.test.js";
const S3_LIVEREQUESTS = "tests/liveCustomerRequestCorrection.test.js";
const S3_LASTCHANCE = "tests/messageLastChance.test.js";
// Batch-3 S2: the per-call clock (wrap-up 8:30, goodbye 9:00, hard end 9:30).
const CLOCK = "tests/liveCallClock.test.js";
const POLITE = "tests/livePoliteFailure.test.js";
// Batch-3 S3: the number block (price table + checkDial/checkText).
const DIALCOST = "tests/dialCost.test.js";
const DIALPARITY = "tests/dialCostVendorParity.test.js";
// Batch-3 S3 Task 3.2a: price check at voice transfers and texts.
const PRICELIVE = "tests/liveTransferPriceCheck.test.js";
const SETBIZ = "tests/setBusinessConfig.test.js";
const CAPCONFIG = "tests/capabilityConfig.test.js";
// Batch-3 S4 Task 4.2: pending dials and the inbound guards.
const PENDINGLIVE = "tests/livePendingDial.test.js";
const GUARDS = "tests/inboundGuards.test.js";
const GUARDROUTES = "tests/inboundGuardRoutes.test.js";
const GUARDROUTESCASCADE = "tests/inboundGuardRoutesCascade.test.js";
// Batch-3 S4 Task 4.3: the repeat-caller AI-minutes alert.
const STATUS = "tests/twilioStatus.test.js";
// Batch-3 S5 Task 5.1: the Twilio fallback Function.
const FALLBACK = "tests/twilioFallback.test.js";
const FALLBACK_URLS = "tests/fallbackUrls.test.js";

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
      "puts `supersededHere` back into the write-order gate's refusal disjunction. This is the exact state that refused five booking attempts on CA03558d and four on CA919b69. RETARGETED (LVX179): the gate's condition is now `(a1Decides ? !a1Save.agreed : !readBackMade || !callerAgreed)`; the veto is OR-ed onto the whole decision.",
    file: "services/tools.js",
    find: "if (hasTarget && !closeTimeMessage && !consentLatched && (a1Decides ? !a1Save.agreed : !readBackMade || !callerAgreed) && !spellFirst && !inAdditionFirst) {",
    replace:
      "if (hasTarget && !closeTimeMessage && !consentLatched && ((a1Decides ? !a1Save.agreed : !readBackMade || !callerAgreed) || agreementSuperseded(ctx)) && !spellFirst && !inAdditionFirst) { // SABOTAGE",
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
    // A1 part 3: the key also carries the A1 inputs (inTurnReplyText, the voiced
    // wire); left in, a read-back still changed the key and this row read GREEN.
    find:
      "      Number(state?.callerTurnCount) || 0,\n      textFingerprint(state?.lastCallerText ?? \"\"),\n      textFingerprint(state?.lastReplyText ?? \"\"),\n" +
      "      // Round A1 part 3 (F1, CAff059ed): the booking rule's own inputs. Without\n" +
      "      // them \"said the handed sentence, called again\" -- the designed path --\n" +
      "      // got the cached refusal five times and then the round cap, and a sound\n" +
      "      // the transcript lost after a held read-back never reached the gate.\n" +
      "      textFingerprint(state?.inTurnReplyText ?? \"\"),\n" +
      "      typeof state?.callerVoicedSinceReply === \"boolean\" ? String(state.callerVoicedSinceReply) : \"null\",",
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
    //
    // RE-ANCHORED again for the never-attempted-message net (Ilija inbound
    // Task N), which added `|| messageOwedNoRow` to the same condition. The
    // replace keeps that disjunct, so this row still removes only the abandoned
    // one.
    find: '  if (verdict === "claim_without_row" || bookingOwedNoRow || abandonedOutstanding || messageOwedNoRow) {',
    replace: '  if (verdict === "claim_without_row" || bookingOwedNoRow || messageOwedNoRow) { // SABOTAGE',
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
    //
    // RE-POINTED (checkpoint 2b review, I2, Controller Ruling OVERNIGHT):
    // Task 17's outbound alternation (D-a) was moved OFF this line entirely
    // -- lib/voice/strings.js's signOffRe is back to its exact 44e31ba text,
    // byte-for-byte (verified: `git diff 44e31ba -- lib/voice/strings.js`
    // shows no change on this line). The outbound alternation now lives at
    // OUTBOUND_STRINGS.signOffOutboundRe and has its own row below
    // ("outbound-signoff-alternation"), so this row goes back to its
    // pre-Task-17 find/replace/red, unchanged from before that task existed.
    find:
      "      /\\b(?:thanks|thank you)(?:\\s+(?:again|so\\s+much|very\\s+much))?\\s+for\\s+calling\\b[^!?]{0,80}?\\b(?:good\\s*bye|bye|(?:great|good|lovely|wonderful)\\s+(?:day|weekend)|take\\s+care)\\b|\\bhave\\s+a\\s+[a-z]+\\s+(?:day|weekend|evening|afternoon)\\b[^a-z]{0,3}$|\\b(?:thanks|thank you)(?:\\s+(?:again|so\\s+much|very\\s+much))?\\s+for\\s+calling\\b[^!?]{0,60}?\\b(?:all\\s+the\\s+best|wish(?:ing)?\\s+you\\s+(?:a\\s+[a-z]+\\s+(?:day|weekend|evening)|well))\\b[^a-z]{0,3}$/i,",
    replace:
      "      /\\b(?:thanks|thank you)(?:\\s+(?:again|so\\s+much|very\\s+much))?\\s+for\\s+calling\\b[^!?]{0,80}?\\b(?:good\\s*bye|bye|great\\s+day|good\\s+day|great\\s+weekend|lovely\\s+day|take\\s+care)\\b|\\bhave\\s+a\\s+(?:great|good|lovely)\\s+(?:day|weekend|evening)\\b|\\b(?:thanks|thank you)(?:\\s+(?:again|so\\s+much|very\\s+much))?\\s+for\\s+calling\\b[^!?]{0,60}?\\b(?:all\\s+the\\s+best|wish(?:ing)?\\s+you\\s+(?:a\\s+[a-z]+\\s+(?:day|weekend|evening)|well))\\b[^a-z]{0,3}$/i, // SABOTAGE",
    red: [GOODBYE],
  },
  {
    name: "outbound-signoff-alternation",
    why:
      "guts OUTBOUND_STRINGS.en.signOffOutboundRe (D-a): every model paraphrase of the canned outbound close ('Thanks for your time, {first_name}. Bye for now.', 'speak soon') stops arming the end_call gate on an outbound call, so Ava would sign off and never actually hang up.",
    file: "lib/voice/strings.js",
    // RE-POINTED (checkpoint 2b review, I2). The alternation no longer sits
    // inside the shared signOffRe -- it is its OWN key, so this row now
    // removes the whole regex's matching power at its own line rather than
    // trimming a branch off signOffRe. A literal that cannot appear in any
    // fixture, not an empty alternation: `//i` or `/(?:)/i` still matches
    // every string (a zero-width assertion), which would leave this row
    // silently passing.
    find:
      "      /\\b(?:thanks|thank you)(?:\\s+(?:again|so\\s+much|very\\s+much))?\\s+for\\s+your\\s+time\\b[^!?]{0,60}?\\b(?:good\\s*bye|bye(?:\\s+for\\s+now)?|take\\s+care|speak\\s+soon)\\b|\\bspeak\\s+soon\\b[^a-z]{0,3}$/i,",
    replace: "      /\\bZZZ_SABOTAGE_NEVER_MATCHES_ZZZ\\b/i, // SABOTAGE",
    red: [OUTBOUND_STRINGS],
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
    // Re-anchored for Task N's `|| messageOwedNoRow` (kept in the replace).
    find: '  if (verdict === "claim_without_row" || bookingOwedNoRow || abandonedOutstanding || messageOwedNoRow) {',
    replace:
      '  if (verdict === "claim_without_row" || bookingOwedNoRow || abandonedWithNoRow || messageOwedNoRow) { // SABOTAGE',
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
      "  } else {\n    identity += `\\nReply in English only.",
    replace:
      "  } else if (false) { // SABOTAGE\n    identity += `\\nReply in English only.",
    red: [LANG, PROMPTS],
  },
  {
    name: "language-line-restored",
    why:
      "puts the old English-only wording back (\"This business operates in English ... Never apologise for the language\"): a sentence about language the model can recite to a caller who was only mis-transcribed. LVX187 replaced it with the plain re-ask; tests/promptSplit.test.js asserts the old phrases are absent and the re-ask present.",
    file: "services/gemini.js",
    find:
      "    identity += `\\nReply in English only. If a caller's words reach you sounding like another language, or garbled, you misheard an English speaker. Take the most likely English meaning and say it back as their answer (\"Got it, Station Road.\") so they can correct you; ask them to say it again only if no English meaning fits. If they then correct what you said back, that fixes that answer: say the fix back; it is not the answer to your next question. Never reply in another language. Do not mention language.`;",
    replace:
      "    identity += `\\nThis business operates in English and ALWAYS replies in English. Never apologise for the language.`; // SABOTAGE",
    red: ["tests/promptSplit.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26).
    name: "reask-line-restored",
    why:
      "puts the LVX187 scripted re-ask back (\"Say: 'Sorry, I didn't catch that, could you say it again?'\"). On real calls that line was the most common re-ask -- 8 times on 7 of 30 debug-on calls, often to a caller the model had understood -- and each one costs a whole repeat. Round 3 tells the model to say back its best English reading instead; promptSplit and liveAssistantLanguage assert the say-back wording and the old sentence's absence.",
    file: "services/gemini.js",
    find:
      "Take the most likely English meaning and say it back as their answer (\"Got it, Station Road.\") so they can correct you; ask them to say it again only if no English meaning fits. If they then correct what you said back, that fixes that answer: say the fix back; it is not the answer to your next question. Never reply in another language. Do not mention language.`;",
    replace:
      "Do not mention language. Say: \"Sorry, I didn't catch that, could you say it again?\"`; // SABOTAGE",
    red: ["tests/promptSplit.test.js", LANG],
  },
  {
    // Hammersleys round 3 (2026-11-26).
    name: "language-note-sent",
    why:
      "stops the back-to-English note. Call A (CA15c9b7…fb66) had the assistant answer an English caller in Spanish for ~37 s on an English-only tenant and only a counter noticed; the caller could not understand that reply. Sabotaged, the Spanish turn is counted and the call carries on in silence about it.",
    file: "lib/voice/live/index.js",
    find: "          if (sendTurnNote(\"language\", LANGUAGE_NOTE)) {",
    replace: "          if (false && sendTurnNote(\"language\", LANGUAGE_NOTE)) { // SABOTAGE",
    red: [LANG],
  },
  {
    // Hammersleys round 3 (2026-11-26).
    name: "reply-veto-shared-words",
    why:
      "puts 'a', 'me' and 'no' back in the reply-side English veto. 'Perfecto, el sábado a las siete…' then reads as English on its 'a' alone, the non-English counter stays at 0 and the back-to-English note never fires.",
    file: "lib/transcriptUtils.js",
    find: "const REPLY_EN_VETO = new Set([...EN_FUNCTION_WORDS].filter((w) => ![\"a\", \"me\", \"no\"].includes(w)));",
    replace: "const REPLY_EN_VETO = EN_FUNCTION_WORDS; // SABOTAGE",
    red: [LANG],
  },
  {
    // Hammersleys round 3 (2026-11-26), owner ruling R16.
    name: "r3-handoff-carries-ask",
    why:
      "drops the ask from the all-answered note. Call B: the hand-off line ('…passed to the dispatcher, who will confirm.') stopped there, so the caller's 'Thank you' cost a separate 'Is there anything else?' turn and a goodbye turn -- ~21 s from hand-off to hang-up against 9 s on d8eaf5, where the ask rode the hand-off.",
    file: "capabilities/messages.js",
    find: "  \"; if nothing in this reply asks the caller a question, end it by asking whether there is anything else they need.\";",
    replace: "  \".\"; // SABOTAGE",
    red: ["tests/messagesOpenQuestions.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26), Opus review I4.
    name: "r3-no-ask-stacked-on-number",
    why:
      "always adds the anything-else clause, even when the same reply must ask for the caller's number (or read a spelled name back): two questions stacked in one turn (LVX25), and a caller answering the first one loses the second.",
    file: "capabilities/messages.js",
    find: "(readBack || needsNumber ? ALL_QUESTIONS_ANSWERED_NO_ASK_NOTE : ALL_QUESTIONS_ANSWERED_NOTE)",
    replace: "(ALL_QUESTIONS_ANSWERED_NOTE /* SABOTAGE */)",
    red: ["tests/messagesOpenQuestions.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26).
    name: "r3-repair-word-not-answer",
    why:
      "drops the lone-repair-word rule. 7eab36's 'What' (after 'Are you still there?') counts as an unsaved answer again: the save guard refuses the goodbye and the owner email carries a 'Said after the last save: What' junk line.",
    file: "lib/voice/unsavedAnswers.js",
    find: "  if (words.length === 1 && REPAIR_WORDS.has(words[0])) return false;",
    replace: "  // SABOTAGE: no repair-word rule",
    red: ["tests/unsavedAnswers.test.js", "tests/afterSaveNote.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26); split from r3-closer-after-ask after the Opus review (M9).
    name: "r3-garble-no-after-goodbye",
    why:
      "drops the garble-then-no rule. 6c0d37's 'Ayer no' (after 'anything else? … wonderful day') and the same after 'Are you still there?' count as unsaved answers again: a refused goodbye and a junk email line.",
    file: "lib/voice/unsavedAnswers.js",
    find: "    endsInGoodbyeOrNudge(prevReply) &&\n    words.length === 2 &&",
    replace: "    false && // SABOTAGE\n    words.length === 2 &&",
    red: ["tests/unsavedAnswers.test.js", "tests/afterSaveNote.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26).
    name: "r3-theres-nothing-closer",
    why:
      "takes \"there's\" out of the closer words. Call A's 'No. There's nothing.' after 'anything else?' counts as an unsaved answer again and reaches the owner email as a junk line.",
    file: "lib/voice/unsavedAnswers.js",
    find: "  // Round 3 (call A): \"No. There's nothing.\"\n  \"there's\", \"theres\",\n",
    replace: "  // SABOTAGE: no there's\n",
    red: ["tests/unsavedAnswers.test.js", "tests/afterSaveNote.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26), E3.
    name: "no-nudge-while-exit-armed",
    why:
      "puts the S4-F1 check back to the quiet-latched exit only. Call 2fdea1: a nudge fired 1.5 s after live_exit_armed, inside the hang-up's grace window, and the exit cut it 0.1 s later. Sabotaged, an exit armed by an ordinary goodbye leaves the ladder talking over the hang-up.",
    file: "lib/voice/live/index.js",
    find: "    if (pendingExit) {\n      ladderSince = atMs;\n      return;\n    }",
    replace: "    if (farewellHeldQuiet && pendingExit) { // SABOTAGE\n      ladderSince = atMs;\n      return;\n    }",
    red: ["tests/liveSilentExitAfterGoodbye.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26), E4.
    name: "goodbye-held-at-turn-end-goes-quiet",
    why:
      "call 6c0d37: 'anything else?' and a goodbye in one breath hold end_call at turn end. Sabotaged, the quiet latch is never set there, the ladder says 'Hello? Are you still there?' 4 s later, and the caller gets a second goodbye.",
    file: "lib/voice/live/index.js",
    find: "            latchFarewellHeld(\"held_turn_end_ask\");",
    replace: "            // SABOTAGE: the turn-end hold never latches",
    red: ["tests/liveSilentExitAfterGoodbye.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26), LVX181.
    name: "umm-hold-starts",
    why:
      "never holds. Call B (CAfd5c1c…fdaf): after 'What day and time would you like to be picked up?' the caller's thinking sound came through as 'A' and the model's re-ask played over them (~9 s lost); 5 such re-asks on 4 of 11 booking calls. Sabotaged, every reply to a wordless sound plays at once again.",
    file: "lib/voice/live/index.js",
    find: "      ummGen = shouldHoldUmm() ? \"holding\" : \"pass\";",
    replace: "      ummGen = \"pass\"; // SABOTAGE",
    red: ["tests/liveUmmHold.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26), LVX181.
    name: "umm-drop-spares-next-generation",
    why:
      "a drop after the kept reply's turnComplete marks the NEXT generation as discard. Then the caller's real answer ('Saturday at seven') gets a reply nobody hears -- dead air created by the fix itself.",
    file: "lib/voice/live/index.js",
    find: "    if (!h.turnCompleted) ummGen = \"discard\";",
    replace: "    ummGen = \"discard\"; // SABOTAGE",
    red: ["tests/liveUmmHold.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26), Opus review I1.
    name: "umm-late-words-release",
    why:
      "treats every late word as the caller carrying on. Live's copy of 'A ... yes' can land after the kept reply's turnComplete with no new voice; dropping then leaves silence, because Live thinks it has already answered -- the caller hears nothing until the first nudge.",
    file: "lib/voice/live/index.js",
    find: "            if (ummHold.resumed) dropUmmHold(\"caller_resumed_words\");",
    replace: "            if (true) dropUmmHold(\"caller_resumed_words\"); // SABOTAGE",
    red: ["tests/liveUmmHold.test.js"],
  },
  {
    // Hammersleys round 3 (2026-11-26), Opus re-review (new Important).
    name: "umm-resumed-holds-release",
    why:
      "lets the age release fire after the caller has resumed. Past turnComplete Live sends no interrupted, so a caller who pauses ~2 s and then answers hears the stale re-ask straight after their answer whenever Live’s copy of their words lands late.",
    file: "lib/voice/live/index.js",
    find: "      else if (!ummHold.resumed && age >= (hes ? UMM_HESITATION_MAX_HOLD_MS : UMM_MAX_HOLD_MS) && quietMs >= UMM_QUIET_MS) releaseUmmHold(\"silence\");",
    replace: "      else if (age >= (hes ? UMM_HESITATION_MAX_HOLD_MS : UMM_MAX_HOLD_MS) && quietMs >= UMM_QUIET_MS) releaseUmmHold(\"silence\"); // SABOTAGE",
    red: ["tests/liveUmmHold.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 1.
    name: "umm-ahm-hesitation",
    why:
      "forgets that Live writes umm as 'Ahm'. Call 3 (CA…283a9a) at 37.0 s: 'Ahm' alone after 'Where would you like to be picked up from?' was not seen as a hesitation, so the reply was not held and a re-ask played over the thinking caller (~8 s lost).",
    file: "lib/transcriptUtils.js",
    find: "const HESITATION_TOKEN_RE = /^(?:u+h+m*|u+m+|h+m+|m+|e+r+m?|a+h+m*|e+h+m*)$/i;",
    replace: "const HESITATION_TOKEN_RE = /^(?:u+h+|u+m+|h+m+|m+|e+r+m?|a+h+|e+h)$/i; // SABOTAGE",
    red: ["tests/callerTurnUsability.test.js", "tests/transcriptUtils.test.js", "tests/liveUmmHold.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 1.
    name: "umm-hesitation-skips-voiced-cap",
    why:
      "puts a long 'ummmm' back under the 600 ms voiced cap. A thinking sound longer than 600 ms is then never held, and the model's re-ask plays over the caller while they think.",
    file: "lib/voice/live/index.js",
    find: "    if (isHesitationOnly(turnUserText)) return ummCallerVoicedMs <= UMM_HESITATION_MAX_VOICED_MS;",
    replace: "    if (false) return true; // SABOTAGE",
    red: ["tests/liveUmmHold.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 1.
    name: "umm-hesitation-waits-longer",
    why:
      "releases a held reply to 'Ahm' after 2 s of quiet like a fragment. A caller who says 'Ahm' and thinks for 2-3 s hears the re-ask just before their answer.",
    file: "lib/voice/live/index.js",
    find: "      const hes = ummHold.kind === \"hesitation\";",
    replace: "      const hes = false; // SABOTAGE",
    red: ["tests/liveUmmHold.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 2, ruling R30.
    name: "r4-one-word-after-wrap-up",
    why:
      "reads a one-word garble after 'anything else?' as an unsaved answer. Call 3 (CA…283a9a): 'No, thanks' came through as 'esse' -> end_call refused (unsaved) -> goodbye latched silent -> 8 s silence exit (17 s ending), and the owner email got the junk line '\"Is there anything else I can help with?\" — esse'.",
    file: "lib/voice/unsavedAnswers.js",
    find: "    (askedWrapUp(prevReply, readBackRe, closingRe) || endsInGoodbye(prevReply))",
    replace: "    false // SABOTAGE",
    red: ["tests/unsavedAnswers.test.js", "tests/afterSaveNote.test.js", "tests/liveSaveGuard.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 3.
    name: "r4-correction-fixes-said-back",
    why:
      "drops the rule that a correction of a said-back answer fixes THAT answer. Call 1 (CA…9733b5): the pickup was said back wrong, the caller's correction '5 Plaistow Street' was filed as the destination ('postcode for this destination'), and the email had the wrong pickup and a made-up destination.",
    file: "services/gemini.js",
    find: "If they then correct what you said back, that fixes that answer: say the fix back; it is not the answer to your next question. ",
    replace: "",
    red: ["tests/promptSplit.test.js", "tests/promptSnapshot.test.js", "tests/outboundPromptSnapshot.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), brief 4b.
    name: "r4-each-no-one-read-back",
    why:
      "tells a confirmStyle 'each' business to make 'the one read-back' again. Every answer is already confirmed as given; the extra recap was ~19 s of speech at the hand-off on all three round-3 calls (owner ruling R26 cut it).",
    file: "services/gemini.js",
    find: "  const msgEachConfirm = msgRuleOnStandard && confirmStyleOf(config) === \"each\";",
    replace: "  const msgEachConfirm = false; // SABOTAGE",
    red: ["tests/promptSplit.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 7, ruling R31.
    name: "r4-summary-capped",
    why:
      "puts the last-call summary into every turn's prompt uncapped and uncleaned. It is generated text (up to 512 output tokens) re-sent on every Live turn, and a '===' in it reads as a prompt section header.",
    file: "services/gemini.js",
    find: "sanitizeFact(callerContext.lastCallSummary, 300)",
    replace: "callerContext.lastCallSummary",
    red: ["tests/a1OnFileNote.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 5, owner ruling R29.
    name: "gate-onset-kept",
    why:
      "hands over only the newest voiced frame (+200 ms) on a barge or release, not the start of the caller's stretch of speech. On 33 calls every loss of 200 ms or more was the start of speech said over our reply falling out of the ring (call 1's corrections lost 100-120 ms each, then were misheard).",
    file: "lib/voice/live/halfDuplex.js",
    find: "    for (let i = last - 1; i >= 0 && start - i <= gapFrames; i--) {",
    replace: "    for (let i = last - 1; false; i--) { // SABOTAGE: the stretch is never walked back",
    red: ["tests/liveHalfDuplex.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 5.
    name: "gate-continuation-release",
    why:
      "drops speech that is still going as our audio ends when under 200 ms of it was held: the start of an answer begun just before our last word is thrown away and the model hears it without its first syllable.",
    file: "lib/voice/live/halfDuplex.js",
    find: "      const carriesOn = keepStart && Boolean(voiced) && voicedInNewest(continueFrames) >= carryMinFrames;",
    replace: "      const carriesOn = false; // SABOTAGE",
    red: ["tests/liveHalfDuplex.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 5.
    name: "gate-ring-kept-long",
    why:
      "shrinks the ring back to 500 ms, so speech said over a long reply falls out of it again before the interruption registers (68/571 utterances on 33 calls lost voiced audio this way).",
    file: "lib/voice/live/halfDuplex.js",
    find: "  const maxFrames = keepStart ? Math.max(windowFrames, Math.ceil(KEEP_MS / FRAME_MS)) : windowFrames;",
    replace: "  const maxFrames = windowFrames; // SABOTAGE",
    red: ["tests/liveHalfDuplex.test.js", "tests/liveUtteranceRecord.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 5.
    name: "gate-kill-switch-wired",
    why:
      "ignores LIVE_GATE_KEEP_START=off. The switch is the one-command rollback for the gate change on a live line; unwired, turning it off changes nothing and the only rollback left is a redeploy.",
    file: "lib/voice/live/index.js",
    find: "  const gate = createHalfDuplexGate({ keepStart: !gateKeepStartOff });",
    replace: "  const gate = createHalfDuplexGate(); // SABOTAGE",
    red: ["tests/liveUtteranceRecord.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 5 instrument.
    name: "utterance-dropped-before-open",
    why:
      "stops charging frames lost while no utterance was open to the next utterance. Then live_utterance says the previous answer lost them (call 1: the name answer 'Sam Price.' carried 360 ms lost during our NEXT reply) and a gate loss at the start of an answer cannot be read off the record.",
    file: "lib/voice/live/index.js",
    find: "    else droppedWhileClosed += dropped || 0;",
    replace: "    else droppedWhileClosed += 0; // SABOTAGE",
    red: ["tests/liveUtteranceRecord.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 6, Deepgram shadow transcript.
    name: "shadow-never-hipaa",
    why:
      "sends a healthcare tenant's caller audio to Deepgram when the shadow is switched on. Healthcare tenants have no Deepgram BAA; the constructor's own guard only refuses a hipaa DEPLOYMENT, not a hipaa tenant on a standard one.",
    file: "lib/voice/live/shadowStt.js",
    find: "  if (hipaa || isHealthcareTier(config)) return { on: false, reason: \"healthcare\" };",
    replace: "  // SABOTAGE: no healthcare gate",
    red: ["tests/liveShadowStt.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 6.
    name: "shadow-eu-only",
    why:
      "lets the shadow stream caller audio to Deepgram's US endpoint. UK callers' audio must be processed in the EU (DEEPGRAM_REGION=eu); the US base URL is a different processing location whatever the DPA says.",
    file: "lib/voice/live/shadowStt.js",
    find: "  if (!String(deepgramEnvironment(env).production || \"\").startsWith(EU_STREAM)) return { on: false, reason: \"not_eu\" };",
    replace: "  // SABOTAGE: any region",
    red: ["tests/liveShadowStt.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 6.
    name: "shadow-never-outbound",
    why:
      "runs the shadow on calls WE place. The shadow is an inbound measurement; outbound answers copy calls.answers (with its _ keys) into the outbound webhook payload, so the shadow's text would leave the system.",
    file: "lib/voice/live/shadowStt.js",
    find: "  if (outbound) return { on: false, reason: \"outbound\" };",
    replace: "  // SABOTAGE: outbound too",
    red: ["tests/liveShadowStt.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 6.
    name: "shadow-gets-raw-frames",
    why:
      "never feeds the shadow any audio: the Deepgram stream opens (and is billed) but transcribes nothing, and the hard-word table on the owner's calls reads empty for Deepgram -- a measurement that cannot fail.",
    file: "lib/voice/live/index.js",
    find: "    shadow?.push(mulawFrame);",
    replace: "    // SABOTAGE: no frames to the shadow",
    red: ["tests/liveShadowStt.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 6.
    name: "shadow-saved-on-call-row",
    why:
      "drops the shadow's finals at hang-up instead of putting them on the call row. Then shadow-compare has nothing to read and the Deepgram-vs-Live table is empty.",
    file: "lib/voice/live/index.js",
    find: "                  await database.mergeCallAnswers(callSid, { _shadow_stt: { v: 1, ...r } });",
    replace: "                  void r; // SABOTAGE",
    red: ["tests/liveShadowStt.test.js"],
  },
  {
    // Hammersleys round 4 (2026-11-26), item 6.
    name: "deepgram-finalize-keeps-last-words",
    why:
      "ends the Deepgram stream without asking it to finalise what it has heard. The caller's last words (often the answer to the last question) never come back as a final.",
    file: "lib/voice/sttDeepgram.js",
    find: "          s.sendFinalize({ type: \"Finalize\" });",
    replace: "          // SABOTAGE: no Finalize",
    red: ["tests/sttDeepgramFinalize.test.js"],
  },
  {
    // Hammersleys round 4, Opus review I1.
    name: "gate-carry-needs-100ms",
    why:
      "lets one voiced frame after our audio (plus one in the last 300 ms) release the held audio. A click, a TV or echo crossing the floor on a thin-margin line then hands Live up to 1.5 s of our own last sentence -- a self-reply.",
    file: "lib/voice/live/halfDuplex.js",
    find: "      const carriesOn = keepStart && Boolean(voiced) && voicedInNewest(continueFrames) >= carryMinFrames;",
    replace: "      const carriesOn = keepStart && Boolean(voiced) && voicedInNewest(continueFrames) > 0; // SABOTAGE",
    red: ["tests/liveHalfDuplex.test.js"],
  },
  {
    // Hammersleys round 4, Opus review I1.
    name: "gate-stretch-dense",
    why:
      "chains sparse loud frames (1 in 6 voiced: a TV, line noise) into the caller's stretch, so a release hands over a second or more of noise and echo before the real speech.",
    file: "lib/voice/live/halfDuplex.js",
    find: "      if (!denseAround(i)) break;",
    replace: "      // SABOTAGE: no density check",
    red: ["tests/liveHalfDuplex.test.js"],
  },
  {
    // Hammersleys round 4, Opus review I2.
    name: "release-needs-200ms-voice",
    why:
      "marks the turn as the caller speaking whenever the gate released anything. Since 'keep the start' a 140 ms sound across the end of our audio is released; with no words it then counts as an unsaved answer and end_call is refused -- the 17 s ending R30 removed.",
    file: "lib/voice/live/index.js",
    find: "    if ((v.voiceActive && forwarded > 0) || releasedVoiced >= 10) callerVoicedThisTurn = true;",
    replace: "    if ((v.voiceActive && forwarded > 0) || released > 0) callerVoicedThisTurn = true; // SABOTAGE",
    red: ["tests/liveSaveGuard.test.js"],
  },
  {
    // Hammersleys round 4, Opus review I3.
    name: "one-word-not-after-readback",
    why:
      "reads 'Did I get everything right?' (and 'anything more about the problem?') as a wrap-up, so a one-word correction ('Heathrow.') is dropped from the save guard and the owner's email -- a wrong value left on file.",
    file: "lib/voice/unsavedAnswers.js",
    find: "  if ((readBackRe instanceof RegExp ? readBackRe : READ_BACK_RE).test(q)) return false;\n  if (closingRe instanceof RegExp && closingRe.test(q)) return true;",
    replace: "  if (closingRe instanceof RegExp && (WRAP_UP_RE.test(q) || closingRe.test(q))) return true; // SABOTAGE",
    red: ["tests/unsavedAnswers.test.js"],
  },
  {
    // Hammersleys round 4, Opus review I4.
    name: "one-word-not-after-nudge",
    why:
      "drops a one-word answer given after 'Are you still there?'. That reply is usually the answer to the question still pending ('Tuesday.'), and the 19/50 measurement covered wrap-up asks only.",
    file: "lib/voice/unsavedAnswers.js",
    find: "    (askedWrapUp(prevReply, readBackRe, closingRe) || endsInGoodbye(prevReply))",
    replace: "    (askedWrapUp(prevReply, readBackRe, closingRe) || endsInGoodbyeOrNudge(prevReply)) // SABOTAGE",
    red: ["tests/unsavedAnswers.test.js"],
  },
  {
    // Hammersleys round 4, Opus review I5.
    name: "umm-long-answer-not-held",
    why:
      "holds the reply to 2 s+ of voice whose transcript is still only 'Ahm'. That is a real answer with its words late: the right reply waits for 3 s of quiet (dead air), or a cough drops it.",
    file: "lib/voice/live/index.js",
    find: "    if (isHesitationOnly(turnUserText)) return ummCallerVoicedMs <= UMM_HESITATION_MAX_VOICED_MS;",
    replace: "    if (isHesitationOnly(turnUserText)) return true; // SABOTAGE",
    red: ["tests/liveUmmHold.test.js"],
  },
  {
    // Hammersleys round 4, Opus review P1.
    name: "deepgram-failed-open-closes",
    why:
      "leaves the SDK's ReconnectingWebSocket running when the first open fails (bad key, EU outage). It retries ~30 times over ~5 minutes with the API key and nothing holds it -- per call, on the shadow's line.",
    file: "lib/voice/sttDeepgram.js",
    find: "      try {\n        s.close();\n      } catch {\n        // already gone\n      }\n      throw err;",
    replace: "      throw err; // SABOTAGE: the socket is left retrying",
    red: ["tests/sttDeepgramFinalize.test.js"],
  },
  {
    // Hammersleys round 4, owner calls: the comparison script shipped without
    // being in the image.
    name: "shadow-compare-in-image",
    why:
      "drops the Deepgram-vs-Live comparison script from the image again: the migrate job fails `Cannot find module` when the owner's test calls are compared.",
    file: "Dockerfile",
    find: "COPY scripts/shadow-compare.js ./scripts/shadow-compare.js",
    replace: "# SABOTAGE: not copied",
    red: ["tests/cloudbuildSmoke.test.js"],
  },
  {
    // Hammersleys round 4, owner calls: smoke-verifiers imports the script.
    name: "shadow-compare-import-safe",
    why:
      "runs the comparison on import: the image build's smoke import prints the usage and exits 2, so every voice build fails.",
    file: "scripts/shadow-compare.js",
    find: "if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {",
    replace: "if (true) { // SABOTAGE",
    red: ["tests/shadowCompare.test.js"],
  },
  {
    // Hammersleys round 4, Opus re-review C1.
    name: "gate-handover-floor-is-old-window",
    why:
      "lets the density walk-back hand over LESS than the old gate's 500 ms window. An 'Okay', a 120 ms dip, then a syllable starting as our audio ends: the Okay is cut again -- the LVX70 loss (Live never learns the caller answered).",
    file: "lib/voice/live/halfDuplex.js",
    find: "    return Math.min(walked, Math.max(windowStart, firstVoiced - leadFrames));",
    replace: "    return walked; // SABOTAGE",
    red: ["tests/liveHalfDuplex.test.js"],
  },
  {
    // Hammersleys round 4, Opus re-review I1.
    name: "one-word-common-wrap-ups",
    why:
      "forgets the wrap-up wordings the locale regex does not list ('Lovely. Anything else?', 'Is that all for today?'). After them a one-word garble ('esse') again refuses the goodbye and writes a junk email line.",
    file: "lib/voice/unsavedAnswers.js",
    find: "  return WRAP_UP_ASK_RE.test(q);",
    replace: "  return false; // SABOTAGE",
    red: ["tests/unsavedAnswers.test.js"],
  },
  // -------------------------------------------------------------------------
  // LVX176 (2026-10-13). A saved message explains a claim ONLY on a call that
  // attempted no appointment tool and showed the caller no time they agreed to.
  // Three rows on one line: each half of the guard, and the explanation itself.
  // -------------------------------------------------------------------------
  {
    name: "message-explains-needs-no-appointment-tool",
    why:
      "lets a saved message explain away a booking claim on a call that ALSO attempted an appointment tool: a real failure (caller told they are booked, nothing written) is hidden because the caller left a message too.",
    file: "lib/postCallVerify.js",
    find: "  const messageExplainsClaims = Number(messagesRecorded) - (Number(afterCallMessages) || 0) > 0 && !appointmentToolAttempted && !bookingAgreed;",
    replace: "  const messageExplainsClaims = Number(messagesRecorded) - (Number(afterCallMessages) || 0) > 0 && !bookingAgreed; // SABOTAGE",
    red: [VERIFY],
  },
  {
    name: "message-explains-needs-no-agreed-time",
    why:
      "lets a saved message explain away a booking claim when the caller agreed to a time this call showed them: the fabricated booking the caller asked for, the one the business must ring about, goes unreported.",
    file: "lib/postCallVerify.js",
    find: "  const messageExplainsClaims = Number(messagesRecorded) - (Number(afterCallMessages) || 0) > 0 && !appointmentToolAttempted && !bookingAgreed;",
    replace: "  const messageExplainsClaims = Number(messagesRecorded) - (Number(afterCallMessages) || 0) > 0 && !appointmentToolAttempted; // SABOTAGE",
    red: [VERIFY],
  },
  {
    name: "message-explains-claim",
    why:
      "brings back the E1 live-check false alarm (CA6514cf8b): a caller leaves a message, the receptionist says 'I've recorded that', and the owner is emailed to call back about an appointment nobody discussed, with a duplicate request filed.",
    file: "lib/postCallVerify.js",
    find: "  const messageExplainsClaims = Number(messagesRecorded) - (Number(afterCallMessages) || 0) > 0 && !appointmentToolAttempted && !bookingAgreed;",
    replace: "  const messageExplainsClaims = false; // SABOTAGE",
    red: [VERIFY],
  },
  {
    name: "messages-recorded-not-counted",
    why:
      "stops the live teardown counting saved messages, so verifyCall always sees messagesRecorded 0 and the LVX176 explanation never fires in production. verifyCall's own tests hand it the field directly, so only the wire test can see this.",
    file: "lib/voice/live/index.js",
    find: "        messagesRecordedThisCall += 1;",
    replace: "        // SABOTAGE",
    red: [POSTCALLWIRE],
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
    // RE-ANCHORED 2026-10-01 (Gatekeeper call): the union line now also lets a
    // booked callback explain a callback-only claim. Same mutation: the judge's
    // answer is dropped from the verdict.
    find: "  const claimed = unbackedMatcherClaims.length > 0 || (judgeClaimedDone === true && !judgeExplainedByCallback);",
    replace: "  const claimed = unbackedMatcherClaims.length > 0; // SABOTAGE",
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
    // RE-ANCHORED 2026-10-01 (Gatekeeper call): the line also hands over the
    // judge's agreed action now. Same mutation: claimedDone is dropped.
    find: "          return runVerify(j?.claimedDone === true ? true : undefined, j?.ran === true ? j.agreedAction : undefined);",
    replace: "          return runVerify(undefined, j?.ran === true ? j.agreedAction : undefined); // SABOTAGE",
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
    // RE-ANCHORED 2026-10-02 (batch 2): the line gained the owner's
    // trust-after-read-back disjunct. The sabotage still removes ONLY LVX144.
    find: "            const callerAgreed = isAffirmative(lastCallerText) || callerRestatedSlot || callerAgreedAfterReadBack;",
    replace: "            const callerAgreed = isAffirmative(lastCallerText) || callerAgreedAfterReadBack; // SABOTAGE",
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
    // RE-ANCHORED 2026-09-20. LVX161 replaced `readBackMade` here with
    // `everReadBackThisProposal`, which asks the same question of the PROPOSAL
    // rather than of this turn. The sabotage is unchanged in meaning -- the
    // early ceiling never applies -- and must still break the same suite.
    find: "              const orderCeiling = everReadBackThisProposal",
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
    name: "closing-ledger-wire",
    why:
      "drops the per-call closing ledger from live_call_summary. LVX157's five counters shipped as process-global bumpCounters, and on CA98d6b04 -- the first real call on the fix -- whether the completion note had gone out or been honoured had NO per-call answer, so the only question the call was made to settle could not be settled from it. A ledger that is filled in and never emitted reads exactly like one that was never filled in.",
    file: "lib/voice/live/index.js",
    find: "      closing: { ...closingAudit },",
    replace: "      // SABOTAGE",
    red: [COMPLETIONASK],
  },
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
  // -------------------------------------------------------------------------
  // LVX160 and LVX161 — the write the caller asked for that never landed.
  // -------------------------------------------------------------------------
  {
    name: "ceiling-ignores-history",
    why:
      "puts the release ceiling back to reading `readBackMade` for THIS turn only, which inverted the gate: when the model answered a refusal with an apology instead of re-reading the proposal back, the read-back aged out, the flag went false, and the ceiling ROSE from one to two. The model apologising bought the gate another refusal against the caller. CAad88df4a needed four before a cancellation went through. Since LVX179 bookings never release, so the red case is a CANCEL (restored Round A1 Part 6).",
    file: "services/tools.js",
    find: "                readBackMade || (sameProposal && orderScratch.writeOrderEverReadBack === true);",
    replace: "                readBackMade; // SABOTAGE",
    red: [RECOVERY],
  },
  {
    name: "in-addition-stash",
    why:
      "drops the corrected arguments the pack stores when it refuses a booking for a caller who already has one. The refusal tells the model to re-call with in_addition_to_existing set; on CAad88df4a it asked the caller the right question TWICE and never re-sent the call with the flag, our own retry re-issued the original argument-less call, and the caller was told twice that it could not be booked. Six rewordings of a refusal have failed to make this model change a tool argument, which is why the argument is now stored rather than requested.",
    file: "capabilities/appointments.js",
    find: "                            args: { ...args, in_addition_to_existing: true },",
    replace: "                            args: { ...args }, // SABOTAGE",
    red: [RECOVERY],
  },
  {
    name: "write-target-arg-keys",
    why:
      "stops logging which arguments the model actually sent on a write. Tool arguments have never been logged anywhere, so on CAad88df4a 'the flag was never set' had to be deduced from the refusal branch reached plus the model's own sentences -- on a call that cost the caller their booking. Keys and booleans only, which is the same line the rest of that block already draws: an argument NAME is schema and a boolean is a branch, so no datetime, name or phone is printed.",
    file: "lib/voice/live/guards.js",
    find: "      const argKeys = Object.keys(fc.args || {}).sort();",
    replace: "      const argKeys = []; // SABOTAGE",
    red: [RECOVERY],
  },
  {
    name: "booked-row-id-in-snapshot",
    why:
      "puts `id: null` back on the row a booking adds to the caller snapshot. That snapshot is what fills a missing appointment_id for cancel and reschedule, so a caller who books and then changes their mind on the SAME call cannot name the row they just made. CA1d405002: nine cancel attempts failed, three of them after the consent gate had already released, two false 'I've cancelled it' claims, an offer to have someone call back, and it only worked once the model re-ran the lookup itself. Eighty seconds.",
    file: "capabilities/appointments.js",
    find:
      "      { id: data.id ?? null, client_name: data.client_name || null, scheduled_at: data.scheduled_at },",
    replace:
      "      { id: null, client_name: data.client_name || null, scheduled_at: data.scheduled_at }, // SABOTAGE",
    red: [RECOVERY],
  },
  {
    name: "ask-staleness-resolved-late",
    why:
      "resolves the ask-staleness check against lib/voice/live/index.js's MIRRORED action count instead of the runner's live one. The mirror is only written when a tool round returns, so a batch carrying the write and the hang-up together is judged against the world as it stood before the write. CA1dfe055f: book_appointment succeeded and end_call was allowed four milliseconds later on the strength of an 'anything else' asked two minutes earlier about an empty diary, and end_call_refusals read {no_ask: 0} on the exact shape LVX157 exists for.",
    file: "lib/voice/live/tools.js",
    find: "          typeof state.askedAnythingElseAtAction === \"number\"",
    replace: "          false // SABOTAGE",
    red: [RECOVERY],
  },
  // -------------------------------------------------------------------------
  // Checkpoint 2b review, I5. The first-seconds controller.
  // -------------------------------------------------------------------------
  {
    name: "first-turn-heard-mark",
    why:
      "treats an INTERRUPTED first turn as satisfying the disclosure check on its TEXT alone, which is the state I5 fixed. Live generates faster than audioOut plays: a barge into 'Hi, is that Priya?' -- before 'It's Ava, an AI assistant...' has been heard -- still hands the FULL sentence to onAssistantTurnText, so the check would pass on words nobody heard.",
    file: "lib/outbound/firstSeconds.js",
    find: '    if (!complete) return; // I5: interrupted -- never satisfies, never corrects here',
    replace: "    // SABOTAGE",
    red: [FIRSTSECONDS],
  },
  // -------------------------------------------------------------------------
  // 2026-10-02 receptionist fixes (CA1ff2c6, CAffb5c7).
  // -------------------------------------------------------------------------
  {
    name: "bare-affirmative-token",
    why:
      "stops reading a whole-turn one-word yes the transcript wrote in another language. CA1ff2c6: 'Shall we book your discovery call for Monday, October fifth at four thirty PM?' was answered 'Ja.', and CAffb5c7's cancellation read-back was answered 'bien' -- both read as no answer, so the write waited on the ceiling and the consent latch never recorded the agreement.",
    file: "lib/transcriptUtils.js",
    find: "  return AFFIRMATIVE_RE.test(trimmed) || isBareAffirmative(trimmed);",
    replace: "  return AFFIRMATIVE_RE.test(trimmed); // SABOTAGE",
    red: [AFFIRM],
  },
  {
    name: "ceiling-release-carried",
    why:
      "drops the write-order state the ceiling release now carries into the spelling gate's refusal. CA1ff2c6: the ceiling released a read-back booking, the spelling gate held it, the retry found writeOrderEverReadBack still false, fell back to the never-asked ceiling of two, and was refused again by the gate that had already let it go.",
    file: "services/tools.js",
    find: "                    ...(orderReleasePatch || {}),\n                    ...(priorSpellFacts.Name",
    replace: "                    // SABOTAGE\n                    ...(priorSpellFacts.Name",
    red: [ORDER],
  },
  {
    name: "outbound-name-on-file",
    why:
      "stops using the lead's name on file for a booking made for them on a call we placed. CA1ff2c6: the lead had agreed to a discovery call and was then asked to spell their full name, asked 'What do you have on file?', heard 'I cannot share the details on file', and lost three turns to a name the business already had.",
    file: "services/tools.js",
    find: "          const nameOnFile = outboundNameOnFile(fc, ctx);",
    replace: "          const nameOnFile = null; // SABOTAGE",
    red: [NAMEFILE],
  },
  {
    name: "callback-questions-suppressed",
    why:
      "hands the Live session the callback's leftover questions even when the caller already has an upcoming appointment. CAffb5c7: a caller ringing to cancel the discovery call they had booked was asked the outreach's 'what is the name of your clinic?' first.",
    file: "lib/voice/live/index.js",
    find: "        extras.callbackOutreach = callbackOutreachForCall(callbackOutreach, extras.callerContext);",
    replace: "        extras.callbackOutreach = callbackOutreach; // SABOTAGE",
    red: [CALLBACKLIVE],
  },
  // -------------------------------------------------------------------------
  // 2026-10-02 batch 2 (O3 CA9c2d26, O1 CA591a92, smoke/I3, O1/O2).
  // -------------------------------------------------------------------------
  {
    name: "unreadable-after-readback",
    why:
      "drops the owner's trust-after-read-back rule from the gate. O3 CA9c2d26: 'Shall we go ahead and book that?' answered with a yes the transcript wrote as 'nada más' -> refused -> 'I cannot secure that time right now' -> a callback instead of the booking the caller had just agreed to.",
    file: "services/tools.js",
    find: "            const callerAgreed = isAffirmative(lastCallerText) || callerRestatedSlot || callerAgreedAfterReadBack;",
    replace: "            const callerAgreed = isAffirmative(lastCallerText) || callerRestatedSlot; // SABOTAGE",
    red: [ORDER],
  },
  {
    name: "ledger-reads-loose-agreement",
    why:
      "puts the agreement ledger back on the word-level yes while the gate trusts a loose one. The gate then accepts 'nada más' on the turn, and the consent latch forgets it the moment a spelling question comes between -- the gate and the ledger disagreeing about the same answer, which is the CAf1d6447d34 shape.",
    file: "lib/voice/live/index.js",
    // RE-ANCHORED in the final-review fix pass (C1): the ledger now keeps a
    // strict and a loose record; this sabotage stops the LOOSE one, which is
    // the only one the consent latch reads.
    find: "        if (readBackThen && agreesAfterReadBack(said)) {",
    replace: "        if (readBackThen && isAffirmative(said)) { // SABOTAGE",
    red: [LATCH],
  },
  {
    name: "retry-stays-clear-yes",
    why:
      "lets the engine's OWN retry fire on a loose answer. The owner's rule trusts the AI because the model heard the audio and chose to write; this retry is code writing when the model did NOT call the tool, so on this row 'nada más' or 'my wife is coming too' would book a held write nobody re-requested.",
    file: "lib/voice/live/index.js",
    find: '        (retryReason === "write_order" || retryReason === "in_addition") &&\n        isAffirmative(turnUserText);',
    replace: '        (retryReason === "write_order" || retryReason === "in_addition") &&\n        agreesAfterReadBack(turnUserText); // SABOTAGE',
    red: [RETRY],
  },
  {
    name: "noncommittal-is-a-withdrawal",
    why:
      "removes the whole 2026-10-02 hedge addition from the refusal list at once (the alternation lesson: narrowing one branch proves nothing). After a read-back the list is now the only thing that stops a write, so 'maybe', 'let me think', 'tal vez' and 'how about Thursday' would all book.",
    file: "lib/transcriptUtils.js",
    // RE-ANCHORED in the final-review fix pass (I3): the WHOLE batch-2 addition,
    // both rounds of it, removed at once.
    find: "|let\\s+me\\s+(?:think|check|see|ask)|think\\s+about\\s+it|maybe|one\\s+(?:sec|second|moment|minute)|just\\s+a\\s+(?:sec|second|moment|minute)|how\\s+about|what\\s+about|quiz[aá]s?|tal\\s+vez|d[eé]jeme\\s+pensar|un\\s+segundo|can'?t|cannot|won'?t|doesn'?t|never|negative|stop|forget\\s+it|changed\\s+my\\s+mind|hold\\s+up|uh[\\s-]uh|give\\s+me\\s+a\\s+(?:sec|second|moment|minute)|think\\s+(?:it\\s+)?over|call\\s+(?:you\\s+)?back|get\\s+back\\s+to\\s+you|espera|esp[eé]rame|para\\s+nada|momentito)\\b/i;",
    replace: ")\\b/i; // SABOTAGE",
    red: [AFFIRM, ORDER],
  },
  {
    name: "names-a-time-is-not-a-loose-yes",
    why:
      "lets a caller who names a DIFFERENT time count as agreeing. 'Eleven a.m.' answering a ten o'clock read-back is a change of proposal without the word no; the same slot is carried by LVX144, which can compare against what is written.",
    file: "lib/transcriptUtils.js",
    find: "  if (NAMES_TIME_RE.test(trimmed)) return false;\n",
    replace: "  // SABOTAGE\n",
    red: [AFFIRM, ORDER],
  },
  {
    name: "hold-post-tool-audio",
    why:
      "plays the model's audio after wait_on_hold again. O1 CA591a92: the turn read 'Sure, thank you.<no speech>{pause}' and the owner heard 'no speech' -- Live continues the generation after a tool reply and the hold only engages at its close. Sims hf2/hf3 did the same, once as a ten-second ramble.",
    file: "lib/voice/live/index.js",
    find: "    if (holdRequestedAt !== null) {\n      if (holdAckBytes + mulaw.length <= HOLD_MUTED_AUDIO_MAX_BYTES) {",
    replace: "    if (false) { // SABOTAGE\n      if (holdAckBytes + mulaw.length <= HOLD_MUTED_AUDIO_MAX_BYTES) {",
    red: [LIVEMODE],
  },
  {
    name: "hold-ack-clean-check",
    why:
      "plays whatever the model said after a tool-first wait_on_hold, markup and all. With nothing said before the call, only one short clean line ('Sure, thank you.') may play; '<no speech>{pause}' or a re-introduction must leave the hold silent.",
    file: "lib/voice/live/index.js",
    find: '    else if (!isCleanHoldAck(turnReplyText)) reason = "not_clean";\n',
    replace: "    // SABOTAGE\n",
    red: [LIVEMODE],
  },
  {
    name: "caller-close-satisfies-ask",
    why:
      "makes the end_call ask gate ignore the caller's own close again. Smoke CAfd993a ('A nice day. That's all. Thanks.') and I3 CA1198b0: the hang-up was refused, the model asked 'Is there anything else...?', the caller said 'No.' and was thanked twice.",
    file: "services/tools.js",
    find: "      const askedAnythingElse = ctx?.askedAnythingElse === true || callerClosedCall;",
    replace: "      const askedAnythingElse = ctx?.askedAnythingElse === true; // SABOTAGE",
    red: [ASK],
  },
  {
    name: "caller-close-door",
    why:
      "the farewell door (a goodbye with no end_call, LVX146) ignores the caller's own close, so the line is held one more turn after 'That's all, thanks.' -- the two doors disagreeing about the same answer.",
    file: "lib/voice/live/index.js",
    // RE-ANCHORED in the final-review fix pass (I4).
    find: "          callerClosesCall(turnUserText) &&\n          !actionToolSucceededThisTurn &&",
    replace: "          false && // SABOTAGE\n          !actionToolSucceededThisTurn &&",
    red: [ASK],
  },
  {
    name: "first-name-only-no-spelling-ask",
    why:
      "puts the spelling question back for a lead with only a first name on file. O1 CA591a92: read-back to booked took 31 s, most of it a surname being spelled for a booking the lead had already agreed to; owner rule 2026-10-02: any name on file -> no spelling question.",
    file: "services/tools.js",
    find: "            CONFIRM_HARD_NAMES && ctx?.lastChance !== true && !nameOnFile",
    replace: "            CONFIRM_HARD_NAMES && ctx?.lastChance !== true && !nameOnFile?.fullName // SABOTAGE",
    red: [NAMEFILE],
  },
  {
    name: "readback-does-that-work",
    why:
      "drops the whole 'does that work for you?' read-back alternative. O2 CA577db9 112.4 s: '...Tuesday, October sixth, at nine AM. Does that work for you?' answered 'Now works.' was refused readBackMade:false, so the booking waited another full read-back.",
    file: "lib/voice/strings.js",
    find: "        `|${READ_BACK_DOES_THAT_WORK}`,",
    replace: "        ``, // SABOTAGE",
    red: [READBACKRE],
  },
  {
    name: "outbound-booking-discipline",
    why:
      "drops the live-mode booking-step sentence (read the time back as a question; never 'booked' before book_appointment succeeds). O2 said 'Great, I have you booked ...' before any write; O3 read back 'I've scheduled your discovery call ...'.",
    file: "lib/outbound/prompt.js",
    find: "        : `The next step: ${GOAL_LINES[cfg.goal]}${bookingDiscipline}`",
    replace: "        : `The next step: ${GOAL_LINES[cfg.goal]}` // SABOTAGE",
    red: [OUTPROMPT],
  },
  // -------------------------------------------------------------------------
  // 2026-10-02 batch 2 FINAL REVIEW fix pass (C1, C2, I1, I4, I5, I6).
  // -------------------------------------------------------------------------
  {
    name: "strict-agreement-for-post-call",
    why:
      "records the owner's LOOSE agreement in the strict ledger too, so post-call bookingOwed (POSTCALL_VERIFY=send texts the caller and opens a staff task), the recovery gate and the silent-turn token all treat 'nada más' -- or 'I'll think about the price' -- as the caller having agreed. Review C1.",
    file: "lib/voice/live/index.js",
    find: "        if (readBackThen && isAffirmative(said)) {",
    replace: "        if (readBackThen && agreesAfterReadBack(said)) { // SABOTAGE",
    red: [POSTCALLWIRE, LATCH],
  },
  {
    name: "retry-spelling-only-for-spelling-stash",
    why:
      "lets the sticky spellingSettled re-issue a write held for AGREEMENT at every turn end once a name was spelled, so code writes a held booking on whatever the caller says next -- where the AI did not call the tool. Review C2.",
    file: "lib/voice/live/index.js",
    find: "      if ((spellingSettled(state) && retryReason == null) || heldForAgreement) {",
    replace: "      if (spellingSettled(state) || heldForAgreement) { // SABOTAGE",
    red: [RETRY],
  },
  {
    name: "loose-readback-tied-to-slot",
    why:
      "drops the slot tie from the loose half: the model reads back B and writes B in one breath (CA6b662e's shape) and the caller's answer to A -- 'earlier would be better' -- authorises B. Review I1.",
    file: "services/tools.js",
    find: "              writeSlot &&\n              readBackMentionsSlot(probeReply, writeSlot) &&\n              agreesAfterReadBack(lastCallerText)",
    replace: "              agreesAfterReadBack(lastCallerText) // SABOTAGE",
    red: [ORDER],
  },
  {
    name: "latch-withdrawal-veto",
    why:
      "lets a standing agreement survive the caller withdrawing it on the turn the write arrives: 'No, forget it, I don't want it' in answer to the spelling question still books. Review I6.",
    file: "services/tools.js",
    find: "                !withdrawsAgreement(lastCallerText)\n            );",
    replace: "                true // SABOTAGE\n            );",
    red: [LATCH],
  },
  {
    name: "close-not-answer-to-readback",
    why:
      "counts 'Yes, that's it.' answering a READ-BACK as the caller closing the call, so a model that books and hangs up in that turn skips 'anything else?' -- the CAb08e4e shape the ask gate exists for. Review I4.",
    file: "services/tools.js",
    find: "        !closeAnswersReadBack &&\n",
    replace: "        // SABOTAGE\n",
    red: [ASK],
  },
  {
    name: "claim-guard-old-readback",
    why:
      "lets the write gate's 'does that work for you?' widening silence the claim guard: O2's 'Great, I have you booked ... Does that work for you?', said before any write, loses its correction note. Review I5.",
    file: "lib/voice/live/index.js",
    find: "    const readBackNotClaim = Boolean(replyText && S.readBackNotClaimRe?.test(replyText));",
    replace: "    const readBackNotClaim = Boolean(replyText && S.confirmReadBackRe?.test(replyText)); // SABOTAGE",
    red: [CLAIM],
  },
  {
    name: "readback-one-slot-only",
    why:
      "restores the first 'does that work' alternative: two times ('Tuesday at nine or Wednesday at ten -- does that work?') and 'does that still work?' about an existing appointment read as a read-back of one slot. Review I5.",
    file: "lib/voice/strings.js",
    // The anchor stops BEFORE the closing "$`": the runner applies rows with
    // String.prototype.replace, where "$`" in a replacement means "the text
    // before the match" -- the first version of this row wrote a corrupt file
    // and read as "could not be READ".
    find: "const READ_BACK_DOES_THAT_WORK = String.raw`^(?![\\s\\S]*${READ_BACK_SLOT_TIME}[\\s\\S]*${READ_BACK_SLOT_TIME})[\\s\\S]*?${READ_BACK_SLOT_TIME}(?:(?!\\bor\\b)[\\s\\S])*?\\bdoes\\s+that\\s+work",
    replace: "const READ_BACK_DOES_THAT_WORK = /* SABOTAGE */ String.raw`${READ_BACK_SLOT_TIME}[\\s\\S]*\\bdoes\\s+that\\s+(?:still\\s+)?work",
    red: [READBACKRE],
  },
  {
    name: "record-has-action",
    why:
      "buildMessageTwiml's Record tag loses its action attribute. Twilio then re-requests the document that served it when the recording ends, so the voicemail apology replays and records again in a loop (batch-3 finding A).",
    file: "lib/twiml.js",
    // The anchor includes the playBeep attribute before it: the transfer
    // builder carries the same action fragment and must not match.
    find: 'playBeep="true" action="${escapeXml(actionUrl)}" ',
    replace: 'playBeep="true" ',
    red: [TWIML],
  },
  {
    name: "vm-callback-to-param",
    why:
      "/twilio/voicemail stops reading the business from ?to= and goes back to req.body.To, which Twilio's recording-status callback never carries. Every voicemail then lands in degraded_voicemail_no_business and nothing is filed.",
    file: "server.js",
    find: "const twilioNumber = req.body.To || queryTo;",
    replace: "const twilioNumber = req.body.To; // SABOTAGE",
    red: [DEGRADED],
  },
  {
    name: "transfer-has-action",
    why:
      "The Live inbound transfer Dial loses its action URL. A no-answer then ends the call with nothing said and no message taken (batch-3 U4).",
    file: "lib/voice/live/index.js",
    find: "        actionUrl: `${outboundBaseUrl(env)}/twilio/transfer-result`,",
    replace: "        // SABOTAGE: no actionUrl",
    red: [TRANSFERLIVE],
  },
  {
    name: "cascade-transfer-has-action",
    why:
      "The cascade transfer Dial loses its action URL. A no-answer then ends the call with nothing said and no message taken (batch-3 U4).",
    file: "lib/voice/session.js",
    find: "          actionUrl: `${outboundBaseUrl(process.env)}/twilio/transfer-result`,",
    replace: "          // SABOTAGE: no actionUrl",
    red: [SESSION_CASCADE],
  },
  {
    name: "transfer-client-by-account",
    why:
      "The Live inbound transfer stops looking up the call's own Twilio account and always uses account A. On an account-B number the REST update 404s and the caller is hung up in silence (batch-3 U4, finding B).",
    file: "lib/voice/live/index.js",
    find: "await twilioClientForAccountSid(callAccountSid)",
    replace: "null /* SABOTAGE */",
    red: [TRANSFERACCT, TRANSFERLIVE],
  },
  {
    name: "transfer-result-completed-hangs-up",
    why:
      "/twilio/transfer-result stops hanging up when the staff member answered and the call ended. The caller who just had a real conversation is then told to leave a message (batch-3 U5).",
    file: "lib/transferOutcome.js",
    find: 'body?.DialCallStatus === "completed"',
    replace: "false /* SABOTAGE */",
    red: [TRANSFEROUTCOME, TRANSFERRESULT],
  },
  // LVX192 (2026-11-24): the save guard, the after-save note, the open-questions list, screened not-accepted.
  {
    name: "lvx192-save-guard-refuses",
    why:
      "end_call stops refusing when the caller spoke after the last save. The caller's later answers are then left on the line and nowhere else (LVX192).",
    file: "services/tools.js",
    find: "ctx.saveGuardSpent !== true &&",
    replace: "false /* SABOTAGE */ &&",
    red: ["tests/endCallSaveGuard.test.js", "tests/liveSaveGuard.test.js"],
  },
  {
    name: "lvx192-after-save-note-written",
    why:
      "finish() stops writing the after-save note onto the last saved message, so the owner never sees what the caller said after the save (LVX192).",
    file: "lib/voice/live/index.js",
    find: ".then(() => saveAfterSaveNote(afterSaveFacts))",
    replace: ".then(() => null /* SABOTAGE */)",
    red: ["tests/messageAfterSaveNote.test.js"],
  },
  {
    name: "lvx192-open-questions-listed",
    why:
      "The save reply stops naming the notes questions still open and falls back to the generic questions note (LVX192).",
    file: "capabilities/messages.js",
    find: "if (questions.length >= 2 && listStarts) {",
    replace: "if (false /* SABOTAGE */) {",
    red: ["tests/messagesOpenQuestions.test.js"],
  },
  // LVX192 fix round 2 (2026-11-24): the list on a label-less first save, the
  // skip words, and a corrected name taking over the bare row.
  {
    name: "lvx192r2-list-starts-label-less",
    why:
      "A first save with no labels yet stops starting the open-questions list, so an opener that gives two answers at once is asked nothing else and the call closes on 'anything else?' (owner's 08:17 call).",
    file: "capabilities/messages.js",
    find: "const startsHere = enquiry && (firstSave || savedLabels.length === 0);",
    replace: "const startsHere = false /* SABOTAGE */;",
    red: ["tests/messagesOpenQuestions.test.js"],
  },
  {
    name: "lvx192r2-confirm-first",
    why:
      "A save that added an answer at a business that confirms each answer stops leading with 'first confirm the answer you just saved', so the pickup is never read back and a wrong postcode reaches the email (owner's calls 1-2).",
    file: "capabilities/messages.js",
    find: 'const lead = added && confirmStyleOf(ctx?.config) === "each" ? CONFIRM_FIRST_NOTE : MODEL_NOTE_PREFIX;',
    replace: "const lead = MODEL_NOTE_PREFIX; void added; /* SABOTAGE */",
    red: ["tests/messagesOpenQuestions.test.js"],
  },
  {
    name: "lvx192r2-backchannel-not-answer",
    why:
      "A bare 'Mhm.' or 'Yeah.' counts as an answer again, so the save guard refuses a goodbye with nothing left to save and the after-save note fills with backchannels (owner's 08:17 call).",
    file: "lib/voice/unsavedAnswers.js",
    find: "    return backchannelAnswers(prevReply, readBackRe, closingRe);",
    replace: "    return true; // SABOTAGE",
    red: ["tests/unsavedAnswers.test.js", "tests/afterSaveNote.test.js"],
  },
  {
    name: "lvx192r2-transfer-batch-no-ask",
    why:
      "A save in the same round as request_transfer says 'ask whether there is anything else' again, so the caller hears that question while being put through (owner's call 5(i)).",
    file: "lib/voice/live/tools.js",
    find: '    const batchHasTransfer = calls.some((c) => c?.name === "request_transfer");',
    replace: "    const batchHasTransfer = false; // SABOTAGE",
    red: ["tests/liveOpenQuestions.test.js"],
  },
  {
    name: "lvx192r3-questions-for-customers",
    why:
      "A business whose numbered questions are for customers stops starting them for a returning customer, so a taxi regular's first save is asked nothing else (owner re-test call 1).",
    file: "capabilities/messages.js",
    find: 'return type === "new_enquiry" || (type === "existing_customer" && questionsForOf(ctx?.config) === "customers");',
    replace: 'return type === "new_enquiry"; // SABOTAGE',
    red: ["tests/messagesOpenQuestions.test.js", "tests/capabilityConfigEffects.test.js", "tests/spelledReadBackNote.test.js"],
  },
  {
    name: "lvx192r3-email-resolves-relative-day",
    why:
      "The owner email stops adding the date to 'Sunday' or 'tomorrow', so the dispatcher gets 'When: 3:00 p.m. Sunday' and has to work the date out (owner re-test call 1).",
    file: "services/notifications.js",
    find: 'const note = answer && dayNoteLabel(question) ? resolvedDayNote(answer, row.created_at, timezone) : "";',
    replace: 'const note = ""; // SABOTAGE',
    red: ["tests/notifications.callRequests.test.js"],
  },
  {
    name: "lvx192r3-email-date-when-labels-only",
    why:
      "The owner email adds a date to any answer with a day word, so '12 Friday Street' or a lost item's 'Trip date: Saturday night' gets a future date the dispatcher may act on (review I2/I3).",
    file: "services/notifications.js",
    find: 'const note = answer && dayNoteLabel(question) ? resolvedDayNote(answer, row.created_at, timezone) : "";',
    replace: 'const note = answer ? resolvedDayNote(answer, row.created_at, timezone) : ""; // SABOTAGE',
    red: ["tests/notifications.callRequests.test.js"],
  },
  {
    name: "lvx192r3-day-note-past-and-dates",
    why:
      "A past event ('left it on Saturday') or a date the caller gave in words ('the sixth of December') gets a future date in brackets, and the dispatcher sends a car on the wrong day (review C1/I2).",
    file: "lib/relativeDay.js",
    find: "  if (NOT_ONE_DAY_RE.test(text) || PAST_RE.test(text) || hasDate(text)) return \"\";",
    replace: "  if (NOT_ONE_DAY_RE.test(text)) return \"\"; // SABOTAGE",
    red: ["tests/relativeDayNote.test.js"],
  },
  {
    name: "lvx192r2-skip-words-honoured",
    why:
      "A save whose reason starts with the business's skip word (URGENT) gets the booking question list, so an urgent caller is asked the booking questions instead of being put through.",
    file: "capabilities/messages.js",
    find: 'skipWords.some((w) => typeof w === "string" && w.trim() !== "" && reason.startsWith(w.trim().toLowerCase()));',
    replace: "false; /* SABOTAGE */",
    red: ["tests/messagesOpenQuestions.test.js", "tests/capabilityConfigEffects.test.js", "tests/liveOpenQuestions.test.js"],
  },
  {
    name: "lvx192r2-name-fix-bare-row",
    why:
      "A name corrected on the same call files a second row instead of updating the bare first save, so the owner's email carries an empty entry under the misheard name ('Ayer').",
    file: "lib/capabilities/customerRequests.js",
    find: "const match = sameKind || samePersonOnly || nameFix;",
    replace: "const match = sameKind || samePersonOnly; void nameFix; /* SABOTAGE */",
    red: ["tests/customerRequestCorrection.test.js"],
  },
  {
    name: "lvx192-screened-not-accepted-message",
    why:
      "A screened dial the staff member did not accept hangs up on the caller instead of offering the message (LVX193).",
    file: "lib/transferOutcome.js",
    find: "screening?.flagged === true &&",
    replace: "false /* SABOTAGE */ &&",
    red: [TRANSFEROUTCOME, TRANSFERRESULT],
  },
  {
    name: "clock-stopped-in-finish",
    why:
      "finish() stops stopping the call clock. The finished call's wrap-up, goodbye and hard-end timers stay armed (and their handles uncleared) after a transfer or hang-up. With onHardEnd's closed check in place nothing visible leaks, so the test that goes red is the structural one: the clock's timers must be cleared once the call is over (batch-3 S2, review focus 1).",
    file: "lib/voice/live/index.js",
    find: "callClock?.stop();",
    replace: "null; /* SABOTAGE */",
    red: [CLOCK],
  },
  // NO row for onHardEnd's own `if (closed) return;`: it is the second layer
  // behind callClock.stop(), and a sabotage of it alone stays green because the
  // clock's `stopped` flag silences the timer first (hand-verified 2026-10-11,
  // Task B). It is the ONLY guard when finish() throws part-way (closed is set
  // before the stop() line, so a throw in between leaves the clock running).
  // Sabotaging both needs two spans, which a row cannot hold.
  {
    name: "time-note-waits-for-tool-continuation",
    why:
      "The turn end that follows a tool call stops deferring a due time note. Gemini sends turnComplete ~17 ms after the call, after a fast tool's response, so the note lands while Live is generating the continuation and chops it (batch-3 S2, review I1).",
    file: "lib/voice/live/index.js",
    find: "    toolCallSinceTurnEnd = true;",
    replace: "    toolCallSinceTurnEnd = false; /* SABOTAGE */",
    red: [CLOCK],
  },
  {
    name: "forced-goodbye-waits-for-next-turn",
    why:
      "A FORCED goodbye sets exitAfterTurn directly instead of waiting for the next turn boundary. The open turn it cut ends with turnComplete, arms the exit, and the call hangs up before any goodbye was spoken (batch-3 S2, review M1).",
    file: "lib/voice/live/index.js",
    // Re-pointed in round 3 (review M2 added the kept-umm-reply clause).
    find: '      if (forced && (modelSpeaking || (ummHold && !ummHold.turnCompleted) || String(turnReplyText || "").trim())) goodbyeExitPending = true;',
    replace: "      if (false /* SABOTAGE */) goodbyeExitPending = true;",
    red: [CLOCK],
  },
  {
    name: "wrap-note-respects-question-hold",
    why:
      "The wrap-up note stops waiting while an end_call is armed-but-held behind a question. The note provokes a reply that spends the hold, and a reply that ends without a question arms the hang-up under the unanswered one (batch-3 S2, review I2; CA2556d43d).",
    file: "lib/voice/live/index.js",
    find: '        : note.kind === "wrap" && endCallArmed',
    replace: "        : false /* SABOTAGE */",
    red: [CLOCK],
  },
  {
    name: "clock-config-under-google-limit",
    why:
      "resolveClockConfig stops bounding the hard end below Google's 9m49s cut. LIVE_CALL_HARD_END_SEC=600 is then accepted and the hard end is scheduled after Google has already closed the session (batch-3 S2).",
    file: "lib/voice/live/callClock.js",
    find: "    hardEndSec < GOOGLE_LIMIT_SEC;",
    replace: "    true; /* SABOTAGE */",
    red: [CLOCK],
  },
  {
    name: "hard-end-stands-down-for-exit",
    why:
      "The hard end stops standing down for an exit already under way (owner ruling O1). A transfer's <Dial> is overwritten with the time-up line, and an armed goodbye is talked over (batch-3 S2).",
    file: "lib/voice/live/index.js",
    find: "return Boolean(pendingExit) || transferInFlight;",
    replace: "return false /* SABOTAGE */;",
    red: [CLOCK],
  },
  {
    name: "deferred-end-fires-on-cancel",
    why:
      "cancelPendingExit stops releasing a deferred ending. The caller talks a hang-up back off at 9:29, the hard end that stood down for it never comes back, and the call runs into Google's cut with an open silent line (batch-3 S2).",
    file: "lib/voice/live/index.js",
    find: "    if (deferredEnd) {",
    replace: "    if (false /* SABOTAGE */) {",
    red: [CLOCK],
  },
  {
    name: "goodbye-note-waits-for-turn-end",
    why:
      "The goodbye sets exitAfterTurn when it is DUE rather than when it is sent. The turn that was already generating arms the exit and the call hangs up before the goodbye is ever said (batch-3 S2, owner ruling O2).",
    file: "lib/voice/live/index.js",
    find: "    pendingTimeNote = { kind, text };",
    replace: '    if (kind === "goodbye") exitAfterTurn = true; /* SABOTAGE */\n    pendingTimeNote = { kind, text };',
    red: [CLOCK],
  },
  {
    name: "polite-failure-on-drop",
    why:
      "The Live socket's onclose stops calling the polite failure. Gemini drops (any code) and the caller is left on a silent open line until the media watchdog or Twilio gives up (batch-3 S2, Task C).",
    file: "lib/voice/live/index.js",
    find: '            endWithPoliteFailure("live_dropped").catch((err) => {',
    replace: "            Promise.resolve().catch((err) => { /* SABOTAGE */",
    red: [POLITE],
  },
  {
    name: "polite-failure-not-after-close",
    why:
      "politeFailure stops standing down on a call that is already closed. After a normal end_call or a transfer our OWN close reaches onclose, and the caller who just said goodbye (or was put through) gets a stray apology and a recording prompt over the top (batch-3 S2, Task C, review focus 2).",
    file: "lib/voice/live/index.js",
    find: "if (closed || politeFailureSent) return false;",
    replace: "if (politeFailureSent) return false; /* SABOTAGE */",
    red: [POLITE],
  },
  {
    name: "polite-failure-on-connect-failed",
    why:
      "The connect catch stops calling the polite failure. The AI never starts and the caller hears nothing, then the call is finished with no message and no recording prompt (batch-3 S2, Task C).",
    file: "lib/voice/live/index.js",
    find: 'if (callSid) await politeFailure("connect_failed");',
    replace: "/* SABOTAGE */",
    red: [POLITE],
  },
  {
    name: "polite-failure-stands-down-for-exit",
    why:
      "politeFailure stops standing down for an exit already under way (owner ruling O1). A drop during a goodbye or a transfer overwrites the <Dial> or talks over the goodbye with an apology (batch-3 S2, Task C).",
    file: "lib/voice/live/index.js",
    find: "    if (exitUnderway()) {\n      deferredEnd = () => endWithPoliteFailure(reason);",
    replace: "    if (false /* SABOTAGE */) {\n      deferredEnd = () => endWithPoliteFailure(reason);",
    red: [POLITE],
  },
  {
    name: "polite-failure-blocks-transfer",
    why:
      "armExit stops refusing once the polite failure has committed. A transfer started while the message TwiML is in flight races it and the caller is put through to a number after being told to leave a message (batch-3 S2, Task C).",
    file: "lib/voice/live/index.js",
    find: '    if (politeFailureSent) {\n      log.info("live_exit_refused_polite_failure"',
    replace: '    if (false /* SABOTAGE */) {\n      log.info("live_exit_refused_polite_failure"',
    red: [POLITE],
  },
  {
    name: "polite-failure-outbound-never-voicemail",
    why:
      "The polite failure's twiml choice stops falling back to the start frame's direction. An outbound start that crashes before the outbound context exists (state.outboundCall unset) would offer the person we rang a voicemail recording prompt (batch-3 S2, Task D3).",
    file: "lib/voice/live/index.js",
    find: "const twiml = state.outboundCall || streamIsOutbound\n",
    replace: "const twiml = state.outboundCall /* SABOTAGE */\n",
    red: [POLITE],
  },
  {
    name: "hard-end-yields-to-polite-failure",
    why:
      "onHardEnd stops standing down once a polite failure has committed. The 9:30 hard end then sends a second redirect over the message TwiML that is in flight (batch-3 S2, Task D4a).",
    file: "lib/voice/live/index.js",
    find: '    if (politeFailureSent) {\n      log.info("live_max_duration_skipped"',
    replace: '    if (false /* SABOTAGE */) {\n      log.info("live_max_duration_skipped"',
    red: [POLITE],
  },
  {
    name: "polite-failure-yields-to-hard-end",
    why:
      "politeFailure stops standing down for a hard end whose redirect is in flight. A drop at 9:30 sends a second update over the time-up line (batch-3 S2, Task D4b).",
    file: "lib/voice/live/index.js",
    find: '    if (hardEndUnderway) {\n      log.info("live_polite_failure_skipped"',
    replace: '    if (false /* SABOTAGE */) {\n      log.info("live_polite_failure_skipped"',
    red: [POLITE],
  },
  {
    name: "polite-failure-awaits-inflight",
    why:
      "A second politeFailure caller stops waiting for the first redirect. The connect catch finishes the call, closing the socket, while the message TwiML is still in flight; Twilio runs past <Connect> and ends the call before the message lands (batch-3 S2, Task D1).",
    file: "lib/voice/live/index.js",
    find: "    if (politeFailureRun) await politeFailureRun;\n",
    replace: "    /* SABOTAGE */\n",
    red: [POLITE],
  },
  {
    name: "deferred-end-always-finishes",
    why:
      "A deferred ending that rejects is only logged. The caller talks the hang-up off, the stored ending throws, and the call is left open with no ending armed (batch-3 S2, Task D6).",
    file: "lib/voice/live/index.js",
    find: '        finish("deferred_end_failed");\n',
    replace: "        /* SABOTAGE */\n",
    red: [POLITE],
  },
  {
    name: "tool-latch-reset-at-flush",
    why:
      "The new-caller-turn flush stops clearing the tool-call latch. A tool turn that never got turnComplete defers the next real pause, so the wrap-up note waits for a pause that is not coming (batch-3 S2, Task D8).",
    file: "lib/voice/live/index.js",
    find: "      toolCallSinceTurnEnd = false;\n      // LVX70: an episode the strategy never opened",
    replace: "      /* SABOTAGE */\n      // LVX70: an episode the strategy never opened",
    red: [CLOCK],
  },
  {
    name: "dialcost-unknown-refuses",
    why:
      "A number with no price-table match is allowed instead of refused. Then any prefix Twilio does not list would be dialled at an unknown price (batch-3 S3).",
    file: "lib/dialCost.js",
    find: '    if (!cost) return { refuse: { ok: false, reason: "unknown" } };\n',
    replace: '    if (!cost) return { refuse: { ok: true, perMin: 0, iso: "XX" } };\n',
    red: [DIALCOST],
  },
  {
    name: "dialcost-never-category",
    why:
      "The premium / personal / satellite / pager / shared refusal is removed, so a premium-rate number priced under the ceiling can be dialled (batch-3 S3).",
    file: "lib/dialCost.js",
    find: '    if (NEVER_CATEGORIES.has(category)) return { refuse: { ok: false, reason: "never", perMin, iso } };\n',
    replace: "    /* SABOTAGE */\n",
    red: [DIALCOST],
  },
  {
    name: "dialcost-auto-max",
    why:
      "The automatic ceiling moves from 10 cents to a dollar a minute, so every number up to 60 cents is dialled without anyone switching it on (batch-3 S3).",
    file: "lib/dialCost.js",
    find: "export const AUTO_MAX_PER_MIN = 0.10;",
    replace: "export const AUTO_MAX_PER_MIN = 1;",
    red: [DIALCOST],
  },
  {
    name: "dialcost-nanp-never",
    why:
      "The North American premium-area list is neutralised. Twilio prices US 900/976 under plain +1 at about 1.4 cents, so the table alone would let them through (batch-3 S3).",
    file: "lib/dialCost.js",
    find: '    if (NANP_NEVER.test(e164)) return { refuse: { ok: false, reason: "never" } };\n',
    replace: "    /* SABOTAGE */\n",
    red: [DIALCOST],
  },
  {
    name: "dialcost-malformed-throws",
    why:
      "parseTable stops throwing on a bad price entry, so a garbled table boots and quietly prices numbers wrongly instead of failing loudly (batch-3 S3).",
    file: "lib/dialCost.js",
    find: "      throw new Error(`dialCost table: bad voice entry for prefix ${prefix}`);\n",
    replace: "      /* SABOTAGE */\n",
    red: [DIALCOST],
  },
  {
    name: "dialcost-vendor-parity",
    why:
      "The dashboard's copy of dialCost drifts by one character from lib/dialCost.js, so the dashboard and the voice server could judge the same number differently (batch-3 S3).",
    file: "AI-phone-dashboard/backend/src/dialCost.mjs",
    find: "export const TEXT_MAX_EACH = 0.25;",
    replace: "export const TEXT_MAX_EACH = 0.26;",
    red: [DIALPARITY],
  },
  {
    name: "live-transfer-price-checked",
    why:
      "Live's transfer price check is never acted on: a premium or over-ceiling number is sent a <Dial> (batch-3 S3, number block).",
    file: "lib/voice/live/index.js",
    find: '    if (!verdict.ok) {\n      log.error("dial_destination_refused", {',
    replace: '    if (false /* SABOTAGE */) {\n      log.error("dial_destination_refused", {',
    red: [PRICELIVE],
  },
  {
    name: "live-outbound-transfer-price-checked",
    why:
      "A refused OUTBOUND transfer stops ending in the Redirect to the transfer-result handler and plays the inbound message TwiML instead: the contact is asked to leave a message on a call WE placed (batch-3 S3).",
    file: "lib/voice/live/index.js",
    find: "    if (state.outboundCall) {\n      const resultUrl = ",
    replace: "    if (false /* SABOTAGE */) {\n      const resultUrl = ",
    red: [PRICELIVE],
  },
  {
    name: "live-transfer-switch-on-respected",
    why:
      "The per-client allow_pricier_numbers wire is forced on in Live: 10-60 cent/min numbers are dialled for every client, switched on or not (batch-3 S3).",
    file: "lib/voice/live/index.js",
    find: "{ allowPricier: state.config?.allowPricierNumbers === true });",
    replace: "{ allowPricier: true /* SABOTAGE */ });",
    red: [PRICELIVE],
  },
  {
    name: "cascade-transfer-price-checked",
    why:
      "The cascade's transfer price check is never acted on: a premium or over-ceiling number is sent a <Dial> (batch-3 S3).",
    file: "lib/voice/session.js",
    find: '      if (!verdict.ok) {\n        log.error("dial_destination_refused", {',
    replace: '      if (false /* SABOTAGE */) {\n        log.error("dial_destination_refused", {',
    red: [SESSION_CASCADE],
  },
  {
    name: "sms-price-checked",
    why:
      "sendSms's price check is neutralised: owner notifications, released held texts and caller texts go to premium or over-ceiling numbers (batch-3 S3).",
    file: "services/notifications.js",
    find: "  const verdict = checkText(to);\n  if (!verdict.ok) {",
    replace: "  const verdict = checkText(to);\n  if (false /* SABOTAGE */) {",
    red: [SMS],
  },
  {
    name: "caller-sms-checked-before-hold",
    why:
      "sendCallerSms loses its early price check: a refused number with no consent record is HELD, taking a slot in the bounded hold map, and is counted as released later (batch-3 S3).",
    file: "services/notifications.js",
    find: "  const verdict = checkText(toNumber);\n  if (!verdict.ok) {",
    replace: "  const verdict = checkText(toNumber);\n  if (false /* SABOTAGE */) {",
    red: [SMS],
  },
  {
    name: "onboarding-transfer-price-checked",
    why:
      "set-business-config stops price-checking transfer_phone_number: we can store a premium-rate transfer number for a client (batch-3 S3).",
    file: "scripts/set-business-config.js",
    find: "  const v = checkDial(value, { allowPricier });",
    replace: "  const v = { ok: true } /* SABOTAGE */;",
    red: [SETBIZ],
  },
  {
    name: "config-allow-pricier-strict",
    why:
      "loadConfig reads allow_pricier_numbers as truthy instead of strictly true: a stray string or number switches pricier numbers on (batch-3 S3).",
    file: "services/db.js",
    find: "    allowPricierNumbers: business.allow_pricier_numbers === true,",
    replace: "    allowPricierNumbers: Boolean(business.allow_pricier_numbers) /* SABOTAGE */,",
    red: [CAPCONFIG],
  },
  {
    name: "gate-blocked-destination",
    why: "evaluateGate stops closing an outreach whose number failed the price check: a never or pricier number is dialled (batch-3 S3).",
    file: "lib/outbound/gate.js",
    find: '  if (!f.destination.ok) return never("blocked_destination");',
    replace: '  if (!f.destination.ok && false /* SABOTAGE */) return never("blocked_destination");',
    red: ["tests/outboundGate.test.js"],
  },
  {
    name: "gate-destination-fact-required",
    why: "assertGateFacts stops requiring the destination fact: a wiring bug that drops it reads as fine to dial instead of throwing (batch-3 S3).",
    file: "lib/outbound/gate.js",
    find: '  if (typeof dest !== "object" || dest === null || typeof dest.ok !== "boolean") fail("destination", "must be an object with a boolean ok");',
    replace: "  /* SABOTAGE: destination shape check removed */",
    red: ["tests/outboundGate.test.js"],
  },
  {
    name: "dispatch-destination-switch-on-strict",
    why: "dispatch treats every business as having pricier numbers switched on: the 10-60 cent band is dialled without our say-so (batch-3 S3).",
    file: "lib/outbound/dispatch.js",
    find: "checkDial(r.phone_e164, { allowPricier: r.allow_pricier_numbers === true })",
    replace: "checkDial(r.phone_e164, { allowPricier: true /* SABOTAGE */ })",
    red: ["tests/outboundDispatch.test.js"],
  },
  {
    name: "lead-intake-price-checked",
    why: "the lead-intake route stops price-checking the phone: a public form can make us call an expensive number (batch-3 S3).",
    file: "lib/outbound/triggerRoute.js",
    find: "const dest = checkDial(phone, { allowPricier: campaign.allowPricierNumbers === true });",
    replace: "const dest = { ok: true } /* SABOTAGE */;",
    red: ["tests/outboundTriggerRoute.test.js"],
  },
  {
    name: "campaign-transfer-price-checked",
    why: "saving a campaign stops price-checking transfer.to: an expensive or premium transfer target is saved (batch-3 S3).",
    file: "lib/outbound/campaignSchema.js",
    find: "const dest = checkDial(transfer.to);",
    replace: "const dest = { ok: true } /* SABOTAGE */;",
    red: ["tests/outboundCampaignSchema.test.js"],
  },
  {
    name: "dashboard-transfer-price-checked",
    why: "the dashboard settings save stops price-checking the transfer number: a customer can point transfers at an expensive number (batch-3 S3).",
    file: "AI-phone-dashboard/backend/src/routes/settings.js",
    find: "const dest = checkDial(transferTo, { allowPricier });",
    replace: "const dest = { ok: true } /* SABOTAGE */;",
    cwd: "AI-phone-dashboard/backend",
    red: ["src/__tests__/settings.test.js"],
  },
  {
    name: "dashboard-notification-text-checked",
    why: "the dashboard settings save stops price-checking the notification number we text: a customer can make us text an expensive number (batch-3 S3).",
    file: "AI-phone-dashboard/backend/src/routes/settings.js",
    find: "const dest = checkText(notifyTo);",
    replace: "const dest = { ok: true } /* SABOTAGE */;",
    cwd: "AI-phone-dashboard/backend",
    red: ["src/__tests__/settings.test.js"],
  },
  {
    name: "pending-dial-expiry",
    why: "app_dial_bounced stops requiring an unexpired pending dial: a stale row (crash before the dial's action fired) would block a real caller forever (batch-3 S4, review focus 5).",
    file: "database/054_loop_guard_block_list.sql",
    find: "AND pd.expires_at > now()",
    replace: "AND true /* SABOTAGE */",
    red: ["tests/migration054Fold.test.js"],
  },
  {
    name: "pending-dial-recorded-live",
    why: "the Live transfer stops recording its dial. A forward-all bounce of the transfer then reaches the assistant as a fresh call, which transfers again: the business's own phone rings in a loop (batch-3 S4).",
    file: "lib/voice/live/index.js",
    find: "    await notePendingDial({",
    replace: "    await (async () => {})({ /* SABOTAGE */",
    red: [PENDINGLIVE],
  },
  {
    name: "pending-dial-recorded-cascade",
    why: "the cascade transfer stops recording its dial. A forward-all bounce of the transfer then reaches the assistant as a fresh call and loops the business's own phone (batch-3 S4).",
    file: "lib/voice/session.js",
    find: "              db.recordPendingDial({",
    replace: '              (async () => "SABOTAGE")({',
    red: [SESSION_CASCADE],
  },
  {
    name: "pending-dial-ended-on-result",
    why: "/twilio/transfer-result stops ending the pending dial. The row then lives out its full window after the dial is over, so a caller ringing back within it is refused as a loop (batch-3 S4).",
    file: "server.js",
    find: "    // Both outcomes end it, so this runs before the hangup early return.\n    try {\n      await db.endPendingDial(callSid);",
    replace: "    // Both outcomes end it, so this runs before the hangup early return.\n    try {\n      await Promise.resolve(); // SABOTAGE",
    red: [TRANSFERRESULT],
  },
  {
    name: "loop-guard-refuses-bounce",
    why: "the inbound guard stops refusing a call that is a forward-all bounce of our own transfer. The bounce is answered as a fresh call, transfers again, and the business's phone rings in a loop (batch-3 S4).",
    file: "lib/inboundGuards.js",
    find: "  if (facts.bounced) {",
    replace: "  if (false /* SABOTAGE */) {",
    red: [GUARDS, GUARDROUTES, GUARDROUTESCASCADE],
  },
  {
    name: "block-list-refuses",
    why: "the inbound guard stops rejecting a number on the block list. A caller the owner blocked gets through to the assistant (batch-3 S4).",
    file: "lib/inboundGuards.js",
    find: "  if (facts.blocked) {",
    replace: "  if (false /* SABOTAGE */) {",
    red: [GUARDS, GUARDROUTES, GUARDROUTESCASCADE],
  },
  {
    name: "repeat-calls-threshold",
    why: "the repeat-caller alert can never fire. A number ringing us dozens of times a day (burning minutes) raises nothing (batch-3 S4).",
    file: "lib/inboundGuards.js",
    find: "if (countable && facts.callsToday === REPEAT_CALLS_ALERT_AT) {",
    replace: "if (false /* SABOTAGE */) {",
    red: [GUARDS],
  },
  {
    name: "inbound-guards-live-route",
    why: "/twilio/live-voice computes the guard verdict and ignores it. Bounces and blocked callers are answered on the Live line (batch-3 S4).",
    file: "server.js",
    find: "if (guardTwiml) return res.send(guardTwiml);",
    replace: "if (guardTwiml) void guardTwiml; /* SABOTAGE */",
    red: [GUARDROUTES],
  },
  {
    name: "inbound-guards-cascade-route",
    why: "/twilio/voice computes the guard verdict and ignores it. Bounces and blocked callers are answered on the cascade line (batch-3 S4).",
    file: "server.js",
    find: "      return res.send(guardTwiml);",
    replace: "      void guardTwiml; /* SABOTAGE */",
    red: [GUARDROUTESCASCADE],
  },
  {
    name: "inbound-guard-fails-open",
    why: "a failing guard lookup rethrows instead of answering. On Live the throw lands in the cascade-fallback catch and a real caller is handed to the wrong front-end; on the cascade the call errors. A database blip must never stop a caller reaching the business (batch-3 S4).",
    file: "lib/inboundGuards.js",
    find: "    return null;\n  }\n  if (!facts) return null;",
    replace: "    throw err; /* SABOTAGE */\n  }\n  if (!facts) return null;",
    red: [GUARDS, GUARDROUTES, GUARDROUTESCASCADE],
  },
  {
    name: "repeat-minutes-crossing",
    why: "the crossing test never fires, so a caller who burns half an hour of AI time in a day is never flagged (batch-3 S4). The alert must fire exactly on the call that takes the day past the line.",
    file: "server.js",
    find: "      if (ai && ai.before < AI_MINUTES_ALERT_SEC && ai.after >= AI_MINUTES_ALERT_SEC) {",
    replace: "      if (false /* SABOTAGE */) {",
    red: [STATUS],
  },
  {
    name: "missed-call-text-skips-refused",
    why: "the skip never fires, so a blocked caller or one whose transfer bounced (both reach /twilio/status as a zero-duration busy) is texted 'sorry we missed you' (batch-3 S5 Task 5.0). The re-check must stop the text.",
    file: "server.js",
    find: "        if (skipReason) {",
    replace: "        if (false /* SABOTAGE */) {",
    red: [STATUS],
  },
  {
    name: "fallback-bounce-rejects",
    why: "the bounce check never rejects, so a call that comes back to a number from itself or from the transfer number is dialled out again and the forward-back loop runs (batch-3 S5 Task 5.1). The caller-ID trick only works if the bounce is turned away.",
    file: "twilio/fallback/fallback.js",
    find: "  if (event.From === event.To || (n && event.From === n)) {",
    replace: "  if (false /* SABOTAGE */) {",
    red: [FALLBACK],
  },
  {
    name: "fallback-record-has-action",
    why: "the Record loses its action, so Twilio re-requests the current document when the recording ends: the apology replays and a second message is filed (batch-3 S5 Task 5.1). recordingPathLint cannot see this file, so only this test pins it.",
    file: "twilio/fallback/fallback.js",
    find: '      action: base + "?step=done",',
    replace: "      action: undefined, /* SABOTAGE */",
    red: [FALLBACK],
  },
  {
    name: "fallback-callerid-ours",
    why: "the Dial shows the caller's number instead of ours, so the business's phone forwards the call straight back to us as a new call from a stranger and the loop guard cannot recognise it (batch-3 S5 Task 5.1).",
    file: "twilio/fallback/fallback.js",
    find: "    callerId: to,",
    replace: "    callerId: event.From, /* SABOTAGE */",
    red: [FALLBACK],
  },
  {
    name: "fallback-requires-to",
    why: "the Function dials without a valid To, so the Dial has no callerId and Twilio shows the CALLER's number as the caller ID, which defeats the loop guard; a missing From and To also compare equal (batch-3 S5 W2, F8).",
    file: "twilio/fallback/fallback.js",
    find: "  if (!to) return message(LINES.technical);",
    replace: "  if (false /* SABOTAGE */) return message(LINES.technical);",
    red: [FALLBACK],
  },
  {
    name: "fallback-url-encodes-number",
    why: "the URL carries the transfer number with a raw + instead of %2B, so Twilio reads the + as a space and the Function's n is mangled; every pasted URL would dial nothing and take a message (batch-3 S5 Task 5.2).",
    file: "scripts/fallback-urls.js",
    find: "  return { url: `${base}?${params.toString()}`, omitted };",
    replace: '  return { url: `${base}?${params.toString().replace(/%2B/g, "+")}`, omitted }; /* SABOTAGE */',
    red: [FALLBACK_URLS],
  },
  {
    name: "inbound-guard-timeout-fails-open",
    why: "the inbound guard lookup is no longer bounded: a slow database holds /twilio/live-voice and /twilio/voice for up to ~11 s, past Twilio's 15 s webhook timeout, and the caller hears 'application error' (batch-3 S5 final review F2).",
    file: "lib/inboundGuards.js",
    find: "    facts = await withTimeout(\n      database.inboundGuardFacts({ businessId, from, countCalls: countable }),\n      INBOUND_GUARD_TIMEOUT_MS\n    );",
    replace: "    facts = await database.inboundGuardFacts({ businessId, from, countCalls: countable }); // SABOTAGE",
    red: [GUARDS],
  },
  {
    name: "pending-dial-write-bounded",
    why: "the Live pending-dial write is no longer bounded at 2 s: a slow database leaves the caller in dead air for up to ~11 s after 'let me put you through' (batch-3 S5 final review F2).",
    file: "lib/voice/live/index.js",
    find: "      const id = await withTimeout(\n        database.recordPendingDial({",
    replace: "      const id = await Promise.resolve(\n        database.recordPendingDial({",
    red: [PENDINGLIVE],
  },
  {
    name: "outbound-completed-transfer-hangs-up",
    why: "a completed transfer whose attempt lookup failed (or whose ?attempt= mismatched) falls through to the 'we'll call you back' line, said to a person who just spoke to a human (batch-3 S5 final review F3).",
    file: "lib/outbound/doorRoutes.js",
    find: '    if (dialCallStatus === "completed") {\n      if (resolved) {',
    replace: '    if (dialCallStatus === "completed" && resolved) {\n      if (resolved) {',
    red: [TRANSFERLIVE],
  },
  // -------------------------------------------------------------------------
  // ROUND A1 "SAY IT ONCE" (LVX177 / LVX172 / LVX178 + T5b), 2026-10-13.
  // Hand-verified red row by row before the full run (S2 T8).
  // -------------------------------------------------------------------------
  {
    name: "message-skips-gates",
    why: "round A1 (owner 2026-10-13): a message is saved as soon as the model calls it. Puts messages back on the booking path, so a message with no read-back is held and the caller is asked to confirm it.",
    file: "lib/voice/savePolicy.js",
    find: "  if (rule === \"message\") {",
    replace: "  if (false) { // SABOTAGE",
    red: [A1_SAVEPOLICY],
  },
  {
    name: "message-skips-hesitation",
    why: "round A1: messages skip the hesitation/unusable gate too. Without it a message answered 'umm' is held again (the gate that refused messages in LVX177's 124).",
    file: "services/tools.js",
    find: "              (a1Save.applies && a1Save.rule === \"message\") || closeTimeMessage",
    replace: "              closeTimeMessage // SABOTAGE",
    red: [A1_SAVEPOLICY],
  },
  {
    name: "booking-garbled-answer-saves",
    why: "round A1: a booking read back once is saved unless the caller objects; a garbled or untranscribed answer is not a no (73% of LVX177's refusals were on saves that later went through). Back to the clear-yes rule. RETARGETED (LVX179): the objection is now computed in the previous-turn QUESTION branch of decideSave (`yesNamingATime`/times), not one line; garble that is not a yes is made an objection there.",
    file: "lib/voice/savePolicy.js",
    find: "      callerObjects(lastCallerText, { restatedSlot: Boolean(callerRestatedSlot) || times === \"same\" });",
    replace: "      (callerObjects(lastCallerText, { restatedSlot: Boolean(callerRestatedSlot) || times === \"same\" }) || !/^\\s*(?:yes|yeah|yep|sure|ok(?:ay)?)\\b/i.test(lastCallerText || \"\")); // SABOTAGE",
    red: [A1_SAVEPOLICY, A1_SILENCEREADBACK],
  },
  {
    name: "booking-objection-refuses",
    why: "round A1: 'save unless it HEARS a no' -- a no, a question or a change after the read-back holds the booking. Ignores the objection, so 'No.' books. RETARGETED (LVX179): anchored on the previous-turn question branch (readBackSource \"previous\"); the answered_earlier branch has its own identical line.",
    file: "lib/voice/savePolicy.js",
    find: "readBackSource: \"previous\", agreed: !objection, objection, awaitingAnswer: false };",
    replace: "readBackSource: \"previous\", agreed: true, objection, awaitingAnswer: false }; // SABOTAGE",
    red: [A1_SAVEPOLICY],
  },
  {
    name: "booking-question-refuses",
    why: "round A1: a question after the read-back ('what time was that?') is an objection, answered rather than booked over.",
    file: "lib/transcriptUtils.js",
    find: "  if (/\\?\\s*$/u.test(trimmed)) return true;\n  if (isHesitationOnly(trimmed)) return true;",
    replace: "  // SABOTAGE: a question no longer objects\n  if (isHesitationOnly(trimmed)) return true;",
    red: [A1_READBACKSTMT, A1_SAVEPOLICY],
  },
  {
    name: "in-turn-readback-counts",
    why: "round A1 (owner Q1): a read-back spoken in the same breath as the tool call saves. Without it the owner's own 'Tuesday at 3 for Jon Doe, booking that now' is refused and read back a second time.",
    file: "lib/voice/savePolicy.js",
    find: "  if (readsBackThisSlot(inTurnReplyText)) {",
    replace: "  if (false) { // SABOTAGE",
    red: [A1_SAVEPOLICY, A1_SAVEWIRE],
  },
  {
    name: "in-turn-readback-wire",
    why: "round A1: turnState produces the turn in progress for the save rule. Produced-but-not-sent is a dead rule (LVX45's shape); both ends real in liveSavePolicyWire.",
    file: "lib/voice/live/index.js",
    find: "    inTurnReplyText: turnReplyText || \"\",",
    replace: "    inTurnReplyText: \"\", // SABOTAGE",
    red: [A1_SAVEWIRE, A1_CONFIRMAUDIT],
  },
  {
    name: "readback-tied-to-slot-a1",
    why: "round A1 Review Focus 2: a read-back of one slot must not authorise a write for another (CA6b662e's shape). Drops the slot check.",
    file: "lib/voice/savePolicy.js",
    find: "    readBackMentionsSlot(text, writeSlot);",
    replace: "    true; // SABOTAGE",
    red: [A1_SAVEPOLICY],
  },
  {
    name: "engine-retry-stays-strict",
    why: "round A1: the engine's own retry (fc.id retry_*) keeps the old rule -- code never acts on a looser agreement than the model's own call (batch-2 principle).",
    file: "services/tools.js",
    find: "engineRetry: typeof fc.id === \"string\" && fc.id.startsWith(\"retry_\"),",
    replace: "engineRetry: false, // SABOTAGE",
    red: [A1_SAVEPOLICY],
  },
  {
    name: "cancel-stays-strict",
    why: "round A1 (owner): cancels are unchanged -- read-back AND a clear yes. Moves cancel_appointment_db onto the booking rule; the cancel pin must turn red.",
    file: "lib/voice/savePolicy.js",
    find: "  cancel_appointment_db: \"cancel\",",
    replace: "  cancel_appointment_db: \"booking\", // SABOTAGE",
    red: [A1_SAVEPOLICY],
  },
  {
    name: "spelling-once",
    why: "LVX172 (owner): a voiced answer to the spelling question settles it -- the transcript losing the letters must not make the caller spell twice.",
    file: "lib/voice/replyState.js",
    find: "  if (state.spellingCaptured || state.spellingDeclined || state.spellingVoiced) return true;",
    replace: "  if (state.spellingCaptured || state.spellingDeclined) return true; // SABOTAGE",
    red: [A1_SPELLONCE],
  },
  {
    name: "composed-readback-spells-surname",
    why: "LVX172: the handed read-back spells the surname letter by letter when the caller spelled it -- 'Dodla' said back as 'Dodla' proves nothing.",
    file: "lib/voice/savePolicy.js",
    find: "    if (callerSpelled) {",
    replace: "    if (false) { // SABOTAGE",
    red: [A1_SAVEPOLICY, A1_SAVEWIRE],
  },
  {
    name: "statement-readback-regex",
    why: "round A1: 'Tuesday at 3 for Jon Doe, booking that now' is a read-back (readBackStatementRe; confirmReadBackRe only sees offers). The WHOLE English expression is disabled (call-closing-defects: narrowing one branch proves nothing).",
    file: "lib/voice/strings.js",
    find: "    readBackStatementRe:\n      /\\b(?:(?:i'?m|i\\s+am)",
    replace: "    readBackStatementRe: /(?!)/, // SABOTAGE\n    readBackStatementReDisabled:\n      /\\b(?:(?:i'?m|i\\s+am)",
    red: [A1_READBACKSTMT, A1_SAVEPOLICY],
  },
  {
    name: "no-ask-refusal-no-goodbye",
    why: "LVX178: the no_ask refusal hands the model the ask alone. The old 'Do NOT say goodbye again' assumed the goodbye was said; on Live it was not yet, so the model said goodbye AND then asked.",
    file: "services/tools.js",
    find: "\"else they need. Say only this, nothing before it, no goodbye: \\\"Before you go — \" +",
    replace: "\"else they need. Do NOT say goodbye again. Say \\\"Before you go — \" +",
    red: [ASK, TOOLSGATE],
  },
  {
    name: "backwards-goodbye-counter",
    why: "LVX178's own number: goodbye before 'anything else?' (one breath or two turns). A defect whose only counters belong to the guards that miss it cannot be shown to improve.",
    file: "lib/voice/live/index.js",
    find: "        closingAudit.backwards_goodbye += 1;",
    replace: "        void 0; // SABOTAGE",
    red: [COMPLETIONASK],
  },
  {
    name: "confirm-ledger-wire",
    why: "round A1 T6: the per-call confirm block is the A1 done-when (saves_over_one_readback 0). A ledger filled in and never emitted reads like one never filled in.",
    file: "lib/voice/live/index.js",
    find: "      confirm: { ...confirmAudit, refusals_by_gate: { ...confirmAudit.refusals_by_gate } },",
    replace: "      // SABOTAGE: confirm ledger not emitted",
    red: [A1_CONFIRMAUDIT],
  },
  {
    name: "save-confirmations-counted",
    why: "round A1 T6: the runner reports which action writes landed; without it no save is counted and save_confirmations never fires.",
    file: "lib/voice/live/tools.js",
    find: "          completedActions.push(fc.name);",
    replace: "          void 0; // SABOTAGE",
    red: [A1_CONFIRMAUDIT],
  },
  {
    name: "gate-refusal-tags-reach-ledger",
    why: "round A1 T6: each write gate tags its refusal; the runner must carry the tag or refusals_by_gate reads zero on every call.",
    file: "lib/voice/live/tools.js",
    find: "      if (effects.writeGateRefusal) writeGateRefusals.push(effects.writeGateRefusal);",
    replace: "      // SABOTAGE: gate tags dropped",
    red: [A1_CONFIRMAUDIT],
  },
  {
    name: "silence-hello-first-rung",
    why: "T5b (owner 2026-10-13): the first silence rung checks the caller is there -- 'Hello? Are you still there?'. Back to 'I'm still here whenever you're ready.'",
    file: "lib/voice/strings.js",
    find: "    nudge1: \"Hello? Are you still there?\",",
    replace: "    nudge1: \"I'm still here whenever you're ready.\", // SABOTAGE",
    red: [A1_LADDERWORDS, A1_LIVESILENCE],
  },
  {
    name: "confirm-nudge-never-asks-yes",
    why: "T5b: rung 2 never asks for a yes. 'Just say yes to confirm' was a second confirmation, the exact thing round A1 removes.",
    file: "lib/voice/strings.js",
    find: "    nudgeConfirm: \"Sorry, are you still there? I've got that ready for you whenever you are.\",",
    replace: "    nudgeConfirm: \"Just say yes to confirm, or let me know if anything needs to change.\", // SABOTAGE",
    red: [A1_LADDERWORDS],
  },
  {
    name: "no-voice-since-readback-holds",
    why: "T5b (owner reversed S1): a read-back followed by NO voiced sound is held -- a person checks the caller is still there. Back to S1's silent save.",
    file: "lib/voice/savePolicy.js",
    find: "    if (callerVoicedSinceReply === false) {",
    replace: "    if (false) { // SABOTAGE",
    red: [A1_SAVEPOLICY, A1_SILENCEREADBACK, A1_E2E],
  },
  {
    name: "voiced-since-reply-wire",
    why: "T5b: turnState produces callerVoicedSinceReply; absent, the gate reads null and silently falls back to S1's silent save. Both ends real in liveSilenceReadBack.",
    file: "lib/voice/live/index.js",
    find: "    callerVoicedSinceReply,",
    replace: "    callerVoicedSinceReply: undefined, // SABOTAGE",
    red: [A1_SILENCEREADBACK, A1_E2E],
  },
  {
    name: "voiced-flag-survives-nudge",
    why: "T5b + LVX179, retargeted 2026-10-17: the old anchor (not resetting the flag on a ladder line) went GREEN because the LVX179 carry-over judge reads callerVoicedSinceReply at that same turn end. The judge itself must require a sound: without it, a read-back met by silence and a nudge is carried over as answered and books with no sound at all.",
    file: "lib/voice/live/index.js",
    find: "      asksReadBack(lastReplyText, getStrings(state.config)) &&\n      callerVoicedSinceReply\n    ) {",
    replace: "      asksReadBack(lastReplyText, getStrings(state.config)) &&\n      true // SABOTAGE\n    ) {",
    red: [A1_SILENCEREADBACK, LVX179_REPLAY],
  },
  {
    name: "echo-is-not-an-answer",
    why: "T5b: only voice the model heard counts. Our own audio echoing back while the read-back plays is withheld by the half-duplex gate and must not save a booking.",
    file: "lib/voice/live/index.js",
    find: "    if ((v.voiced && forwarded > 0) || releasedVoiced >= 10) callerVoicedSinceReply = true;",
    replace: "    if (v.voiced || releasedVoiced >= 10) callerVoicedSinceReply = true; // SABOTAGE",
    red: [A1_SILENCEREADBACK],
  },
  {
    name: "ladder-answer-sorry-is-yes",
    why: "T5b: 'Yes, sorry' answers 'Are you still there?'. 'sorry' is in the shared NEGATION_RE, so without this the caller who answered the ladder is asked to confirm again.",
    file: "lib/transcriptUtils.js",
    find: "  if (apologisingYes(trimmed)) return false;",
    replace: "  // SABOTAGE: apology reads as an objection",
    red: [A1_READBACKSTMT, A1_SILENCEREADBACK],
  },
  {
    name: "awaiting-wait-wording-silent-turn",
    why: "T5b: a booking held for silence tells the model to WAIT, never 'ask whether to go ahead' -- the silent-turn gate's own wording is a second yes.",
    file: "services/tools.js",
    find: "                  message: a1Save.awaitingAnswer === true\n                    ? a1AwaitingMessage(fc.name)",
    replace: "                  message: false // SABOTAGE\n                    ? a1AwaitingMessage(fc.name)",
    red: [A1_SAVEPOLICY, A1_E2E],
  },
  {
    name: "awaiting-wait-wording-write-order",
    why: "T5b: when the caller's last words predate the read-back, the write-order gate must say WAIT, not 'they did not agree' (which makes the model re-confirm).",
    file: "services/tools.js",
    find: "                const a1Awaiting = a1Booking && a1Save.awaitingAnswer === true;",
    replace: "                const a1Awaiting = false; // SABOTAGE",
    red: [A1_SAVEPOLICY],
  },
  // Round A1 final-review fix round (2026-10-13).
  {
    name: "in-turn-question-awaits",
    why: "LVX179 (retargeted from the S2 `asks` regex): a read-back QUESTION in the turn being spoken waits for the answer (awaitingAnswer true, readBackSource in_turn). Saving before the answer is the CA6b662e / LVX95 shape.",
    file: "lib/voice/savePolicy.js",
    find: "    if (asksAboutThisSlot(inTurnReplyText)) {",
    replace: "    if (false) { // SABOTAGE",
    red: [A1_SAVEPOLICY],
  },
  // RETIRED 2026-10-17 (P5 overnight gate, row went GREEN): a1-objection-before-write-order. Since LVX179 the
  // A1 decision is authoritative in the write-order gate (a booking is refused unless
  // agreed, and the ceiling never releases one), so the early "yes that objects" branch
  // no longer changes the outcome; booking-objection-refuses and p5-engine-retry-own-slot
  // certify what it used to. Its message still carries pre-LVX179 wording (backlog).
  // RETIRED 2026-10-17 (P5 overnight gate, row went GREEN): a1-objection-branch-only-for-a-yes. Since LVX179 the
  // A1 decision is authoritative in the write-order gate (a booking is refused unless
  // agreed, and the ceiling never releases one), so the early "yes that objects" branch
  // no longer changes the outcome; booking-objection-refuses and p5-engine-retry-own-slot
  // certify what it used to. Its message still carries pre-LVX179 wording (backlog).
  // RETIRED 2026-10-17 (P5 overnight gate, row went GREEN): a1-objection-branch-skips-time-cue.
  // Same cause as the two a1-objection rows retired below: since LVX179 the A1 decision is
  // authoritative in the write-order gate, so the early branch no longer changes the outcome.
  {
    name: "a1-objection-held-not-failed",
    why: "round A1 final review I4 follow-up: the objection hold is marked gated (held, not failed) -- retryPendingWrite and the claim guard branch on it, and an unmarked refusal is announced as a failure (CAa08fc3).",
    file: "services/tools.js",
    find: "                  response: consentRefusal.held",
    replace: "                  response: false // SABOTAGE",
    red: [A1_SAVEPOLICY],
  },
  {
    name: "apology-with-change-objects",
    why: "round A1 final review I4: the 'Yes, sorry' exemption must not swallow 'Sorry, yes, make it four'.",
    file: "lib/transcriptUtils.js",
    find: "  return isAffirmative(rest) && !NEGATION_RE.test(rest) && !callerObjects(rest);",
    replace: "  return isAffirmative(rest) && !NEGATION_RE.test(rest); // SABOTAGE",
    red: [A1_READBACKSTMT],
  },
  {
    name: "retry-note-booking-no-second-yes",
    why: "round A1 final review I1: a held engine retry of a BOOKING tells the model to call again, not to 'read the details back and ask whether to go ahead' -- the second read-back and second yes A1 removes.",
    file: "lib/voice/live/index.js",
    find: "        ? saveRuleFor(pending.name) === \"booking\"",
    replace: "        ? false // SABOTAGE",
    red: [RETRY],
  },
  {
    name: "awaiting-booking-stashed",
    why: "round A1 final review I1: a booking held awaiting the answer to its statement read-back is stashed, so the caller's answer can re-issue it (confirmReadBackRe never sees the statement form). RETARGETED (LVX179): the `|| awaitingAnswer` disjunct is redundant now (an awaiting decision always has readBackStanding true), so the break removes the whole stash condition for the A1 booking path.",
    file: "services/tools.js",
    find: "                    ...((a1Save.applies && a1Save.rule === \"booking\" ? a1Save.readBackStanding : probeReadBack) ||",
    replace: "                    ...(false && // SABOTAGE",
    red: [A1_SAVEPOLICY],
  },
  {
    name: "p5-in-turn-statement-holds",
    why:
      "LVX179: a statement read-back in the turn being spoken ('...booking that now') has not been answered by anyone; it HOLDS (agreed false, the caller still has to be asked). Saving on it is the S2 same-breath save that booked 9 AM on call b.",
    file: "lib/voice/savePolicy.js",
    find: "readBackStanding: false, readBackSource: \"in_turn_statement\", agreed: false, objection: false, awaitingAnswer: false };",
    replace: "readBackStanding: true, readBackSource: \"in_turn_statement\", agreed: true, objection: false, awaitingAnswer: false }; // SABOTAGE",
    red: [LVX179_REPLAY, A1_SAVEPOLICY],
  },
  {
    name: "p5-question-required",
    why:
      "LVX179: a previous-turn read-back saves only when it was a QUESTION about this slot (asksAboutThisSlot). A statement ('...booking that now') in the previous turn is held and the caller is handed the question; reading statements as questions books a time nobody was asked about.",
    file: "lib/voice/savePolicy.js",
    find: "  if (asksAboutThisSlot(lastReplyText)) {",
    replace: "  if (readsBackThisSlot(lastReplyText)) { // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-voiced-required",
    why:
      "T5b + LVX179: a question asked and met by NO sound from the caller is held awaiting the answer; whatever lastCallerText holds was said before the question. Without it the stale pre-question text reads as agreement.",
    file: "lib/voice/savePolicy.js",
    find: "    if (callerVoicedSinceReply === false) {",
    replace: "    if (false) { // SABOTAGE",
    red: [A1_SAVEPOLICY, LVX179_REPLAY],
  },
  {
    name: "p5-done-only-book",
    why:
      "LVX179: after a booking the tool reply tells the model to say ONLY 'Done, you're all set.' -- repeating day, time and name is the second read-back A1 removes.",
    file: "capabilities/appointments.js",
    find: "'. Say only: \"Done, you\\'re all set.\" Do not repeat the day, the time or the name, ' +",
    replace: "'. Tell the caller the day, the time and the name. ' + // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-done-only-reschedule",
    why:
      "LVX179: the same 'Done, you're all set' only-reply after a reschedule.",
    file: "capabilities/appointments.js",
    find: "message: 'Rescheduled. Say only: \"Done, you\\'re all set.\" Do not repeat the day, the time or the name.',",
    replace: "message: 'Rescheduled. Tell the caller the day, the time and the name.', // SABOTAGE",
    red: [TOOLSGATE],
  },
  {
    name: "p5-full-name-spelled",
    why:
      "LVX179 owner rule 2: when the caller spelled the name, the one question spells EVERY word of it, first name too ('Maja' and 'Maya' sound the same). Back to spelling the last word only.",
    file: "lib/voice/savePolicy.js",
    find: "who = words.map((w) => (spelled(w) ? `${w}, ${spelled(w)}` : w)).join(\", \");",
    replace: "who = words.map((w, i) => (i === words.length - 1 && spelled(w) ? `${w}, ${spelled(w)}` : w)).join(\", \"); // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-spell-ask-full-name",
    why:
      "LVX179 owner rule 2: the ask-now prompt line asks for the FIRST AND LAST name in one go ('Could you spell the first and last name for me?'). Back to the surname only.",
    file: "services/gemini.js",
    find: "ask them to spell the first AND last name in one go, in your very next reply — \"Could you spell the first and last name for me?\"",
    replace: "ask them to spell the last name in one go, in your very next reply — \"Could you spell the last name for me?\"",
    red: ["tests/a1AskNow.test.js"],
  },
  {
    name: "p5-carry-set",
    why:
      "LVX179: a booking question the caller answered with anything but a no is remembered (a1AnsweredReadBack) so a spelling or extra-or-move exchange between the answer and the write does not make the model ask again (CA03558d). Never set = asked again.",
    file: "lib/voice/live/index.js",
    find: "a1AnsweredReadBack = changed || A1_CANCEL_RE.test(lastReplyText) ? null : lastReplyText;",
    replace: "a1AnsweredReadBack = null; // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-carry-superseded",
    why:
      "LVX179: a newer question that names a time or a day clears the carried answer at once, so the old yes cannot stand for a different proposal (the yes now stands for 10, not 2).",
    file: "lib/voice/live/index.js",
    find: "        if (replyText && namesTimeOrDay(replyText) && asksReadBack(replyText, getStrings(state.config))) {",
    replace: "        if (false) { // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-carry-cancel-never",
    why:
      "LVX179 / CA8c019c: a cancellation question's yes is never carried to a booking.",
    file: "lib/voice/live/index.js",
    find: "a1AnsweredReadBack = changed || A1_CANCEL_RE.test(lastReplyText) ? null : lastReplyText;",
    replace: "a1AnsweredReadBack = changed ? null : lastReplyText; // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-carry-spent",
    why:
      "LVX179: any completed action spends the carried answer, so the booking it authorised cannot authorise a second person at the same time.",
    file: "lib/voice/live/index.js",
    find: "        // booking it authorised, or any other, after which it is stale.\n        a1AnsweredReadBack = null;",
    replace: "        // booking it authorised, or any other, after which it is stale.\n        // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-engine-retry-own-slot",
    why:
      "LVX179: the engine's own retry (fc.id retry_*) of a booking is dropped unless the one-question rule passes for ITS slot; otherwise a retry rides an answer given to a different question.",
    file: "services/tools.js",
    find: "            if (!a1Own.agreed) {",
    replace: "            if (false) { // SABOTAGE",
    red: [RETRY, LVX179_REPLAY],
  },
  {
    name: "p5-time-comparer-different",
    why:
      "LVX179 / CA94817d: a yes that names a DIFFERENT time ('Yeah, they're correct. 10:00 a.m. works.') is a change, not a yes. timesAgainst must say 'different'.",
    file: "lib/voice/savePolicy.js",
    find: "return said.every((t) => against.some((o) => same(t, o))) ? \"same\" : \"different\";",
    replace: "return said.every((t) => against.some((o) => same(t, o))) ? \"same\" : \"same\"; // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-time-reader-spoken",
    why:
      "LVX179: clockTimesIn must read spoken times ('ten o'clock works') as well as digits, or a spoken change rides on a yes.",
    file: "lib/voice/savePolicy.js",
    find: "  for (const m of text.matchAll(SPOKEN_TIME_RE)) {",
    replace: "  for (const m of \"\".matchAll(SPOKEN_TIME_RE)) { // SABOTAGE",
    red: [LVX179_REPLAY, A1_SAVEPOLICY],
  },
  {
    name: "p5-after-save-move",
    why:
      "LVX179 Fix 3: a correction cue and no addition cue right after a save classifies as 'move', so the ONE question handed is the move read-back ('So that's moving your 9 to 10...'), not move-or-keep.",
    file: "capabilities/appointments.js",
    find: "  if (move && !add) return \"move\";",
    replace: "  if (move && !add) return \"ask\"; // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-after-save-add",
    why:
      "LVX179 Fix 3: an addition cue and no correction cue ('also one at 2') classifies as 'add' -- an extra booking, no move question.",
    file: "capabilities/appointments.js",
    find: "  if (add && !move) return \"add\";",
    replace: "  if (add && !move) return \"ask\"; // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-after-save-ask",
    why:
      "LVX179 Fix 3: neither cue (or both) -> 'ask': ONE named move-or-keep question. Defaulting to 'move' silently moves a booking the caller may have wanted kept.",
    file: "capabilities/appointments.js",
    find: "  if (add && !move) return \"add\";\n  return \"ask\";",
    replace: "  if (add && !move) return \"add\";\n  return \"move\"; // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-after-save-same-person",
    why:
      "LVX179 Fix 3 (opus review #1): only the SAME person's booking is corrected (samePersonForMove: the same name, not F-E's loose family match); a daughter with the same surname right after the save is never a move of the first booking.",
    file: "capabilities/appointments.js",
    find: "  if (!samePersonForMove(args?.client_name, last.client_name)) return null;",
    replace: "  // SABOTAGE: any name counts as the same person",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-after-save-move-dispatch",
    why:
      "LVX179 Fix 3: a 'move' verdict calls moveJustBooked, which reschedules the row just written and never inserts. Without the dispatch the correction falls through to the in-addition path and becomes a SECOND booking (call b).",
    file: "capabilities/appointments.js",
    find: "        if (afterSave?.kind === \"move\") return moveJustBooked(fc, ctx, afterSave.last, anchoredScheduledAt);",
    replace: "        if (false) return moveJustBooked(fc, ctx, afterSave.last, anchoredScheduledAt); // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-after-save-look-ahead-stays",
    why:
      "LVX179 Fix 3: when Fix 3 decides a same-person booking right after a save, the write-order gate's in-addition look-ahead must NOT step aside for it (it let the move or extra one land with no question). Only `block` + add still refuses.",
    file: "capabilities/appointments.js",
    find: "  if (after && (after.kind !== \"add\" || policy !== \"block\")) return false;",
    replace: "  // SABOTAGE: look-ahead ignores Fix 3",
    red: [LVX179_REPLAY, "tests/a1InAddition.test.js"],
  },
  {
    name: "p5-a1question-move",
    why:
      "LVX179 Fix 3: the A1 gate hands the model the MOVE question (afterSaveQuestion) for a second booking right after a save, so the caller hears one question rather than a read-back and then a move/keep ask.",
    file: "services/tools.js",
    find: "  const after = fc.name === \"book_appointment\" ? afterSaveQuestion(fc.args || {}, ctx) : null;",
    replace: "  const after = null; // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-move-only-after-move-question",
    why:
      "LVX179 Fix 3 (opus review #1, Critical): correction words alone never move a booking -- after a plain read-back the move is ASKED ('confirm_move'). Sabotaged, a stray 'no' said to 'anything else?' silently moves the first booking.",
    file: "capabilities/appointments.js",
    find: '  return { kind: k === "move" ? "confirm_move" : "ask", last };',
    replace: '  return { kind: k === "move" ? "move" : "ask", last }; // SABOTAGE',
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-move-question-moves",
    why:
      "LVX179 Fix 3 (opus review #5): an answer to a question that NAMED the move ('Shall I move your 9 to 10?', the model's own or the gate's) moves the booking -- one question. Sabotaged, the caller is asked a second time.",
    file: "capabilities/appointments.js",
    find: '    return { kind: "move", last };\n  }\n  if (qk === "add")',
    replace: '    return { kind: "ask", last }; // SABOTAGE\n  }\n  if (qk === "add")',
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-move-capacity",
    why:
      "LVX179 Fix 3 (opus review #2): a move checks the slot first -- reschedule is a plain update with no overlap check, so a correction into a full slot would double-book it.",
    file: "capabilities/appointments.js",
    find: "      full = !available;",
    replace: "      full = false; // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-fix3-live-only",
    why:
      "LVX179 Fix 3 (opus review #3): Live only. The cascade has no words-since-save, so Fix 3 there asked move-or-keep forever and no second booking was ever written.",
    file: "capabilities/appointments.js",
    find: '  if (typeof ctx?.callerSaidThisCall !== "string") return null;',
    replace: "  // SABOTAGE: the cascade too",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-or-keep-no-keeps",
    why:
      "LVX179 Fix 3: 'No.' to 'Shall I move your 9 to 10, or keep both?' means do not move -- keep both. Sabotaged it is unclear and falls to the model's flag.",
    file: "capabilities/appointments.js",
    find: '  if (/^\\s*(?:no|nope|nah)\\b/i.test(t)) return "add";',
    replace: "  // SABOTAGE: a plain no is unclear",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-or-keep-answer-read",
    why:
      "LVX179 Fix 3: after the move-or-keep question the caller's ANSWER decides ('keep both' adds, 'move it' moves); the model's flag only fills in when the answer is unclear or not transcribed yet.",
    file: "capabilities/appointments.js",
    find: "    const k = classifyOrKeepAnswer(ctx?.lastCallerText);",
    replace: "    const k = null; // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-or-keep-alternative-not-move",
    why:
      "LVX179 Fix 3 (opus re-review, Critical): a move question WITH an alternative ('..., or keep the 9 as well?') is an either/or decided by the caller's answer, never a move by itself. Sabotaged, 'keep the nine as well' silently moves the 9 to 10.",
    file: "capabilities/appointments.js",
    find: '  if (at >= 0) return /\\bor\\b/i.test(q.slice(at)) ? "or_keep" : "move";',
    replace: '  if (at >= 0) return "move"; // SABOTAGE',
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-neg-move-is-add",
    why:
      "LVX179 Fix 3 (opus re-review): 'I won't move your 9 -- so that's an extra one at 10?' is an extra one. Sabotaged, the negated move reads as an either/or and a yes moves the booking.",
    file: "capabilities/appointments.js",
    find: '  if (FIX3_ADD_Q_RE.test(q)) return "add";',
    replace: "  // SABOTAGE: an extra / won't-move question is not read",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-handed-once",
    why:
      "LVX179 Fix 3 (opus re-review #3): a Fix 3 question is handed at most ONCE per slot; a paraphrased plain read-back answered yes then keeps both. Sabotaged, the move question is handed again (a loop if the model keeps paraphrasing).",
    file: "capabilities/appointments.js",
    find: '  if (k === "add" || handed) return { kind: "add", last };',
    replace: '  if (k === "add") return { kind: "add", last }; // SABOTAGE',
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-or-keep-move-before-add",
    why:
      "LVX179 Fix 3 (opus re-review #2): in the answer to move-or-keep, a word naming the move ('just the ten', 'only one', 'move it') outranks an addition word said in passing ('can you also text me').",
    file: "capabilities/appointments.js",
    find: '  if (OR_KEEP_MOVE_RE.test(t)) return "move";\n  if (OR_KEEP_ADD_RE.test(t)) return "add";',
    replace: '  if (OR_KEEP_ADD_RE.test(t)) return "add"; // SABOTAGE\n  if (OR_KEEP_MOVE_RE.test(t)) return "move";',
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-move-answer-keeps",
    why:
      "LVX179 Fix 3 (opus re-review 2, Critical): 'keep both please' (or the model's in_addition flag) after 'So that's moving your 9 to 10?' is never a move. The A1 gate saves unless it hears a no, so the answer must be read here.",
    file: "capabilities/appointments.js",
    find: '    if (answer === "add" || args?.in_addition_to_existing === true) return { kind: "add", last };',
    replace: "    // SABOTAGE: the answer to the move question is not read",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-same-person-exact",
    why:
      "LVX179 Fix 3 (opus re-review 2): the same person means the same name; a first name one letter away (Ana / Ada, Mark / Mary) is someone else, so it is never offered as a move of the first booking.",
    file: "capabilities/appointments.js",
    find: "  return (a.length === 1 || b.length === 1) && a[0] === b[0];",
    replace: "  return ((a.length === 1 || b.length === 1) && a[0] === b[0]) || withinOneEdit(a[0], b[0]); // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-move-names-old-slot",
    why:
      "LVX179 Fix 3 (opus re-review 3, High): a move question must name the OLD time of the booking it moves (lastBooked is always the latest). Sabotaged, 'Shall I move your 9 to 10?' moves the 2 p.m. booking made after it.",
    file: "capabilities/appointments.js",
    find: '  if ((qk === "move" || qk === "or_keep") && !namesOldSlot(askedQ, last, ctx)) qk = "plain";',
    replace: "  // SABOTAGE: the old time is not checked",
    red: [LVX179_REPLAY],
  },
  {
    name: "p5-keep-words-about-booking",
    why:
      "LVX179 Fix 3 (opus re-review 4, High): only keep-words ABOUT THE BOOKING mean 'keep both'. A bare 'also' / 'still' / 'plus' / 'one more' opens everyday asides ('Yes. One more thing...'); read as keep, a yes to the move question became a second booking (call b).",
    file: "capabilities/appointments.js",
    find: "  String.raw`\\b(?:keep|both|",
    replace: "  String.raw`\\b(?:also|still|plus|one\\s+more|keep|both|",
    red: [LVX179_REPLAY],
  },
  {
    name: "farewell-not-take-care-of",
    why: "LVX178 counter accuracy: 'I'll take care of that… anything else?' is not a goodbye; counted, it fails a target of 0 on a clean call.",
    file: "lib/voice/strings.js",
    find: "\\btake\\s+care\\b(?!\\s+of\\b)|",
    replace: "\\btake\\s+care\\b|",
    red: [A1_CLOSINGORDER],
  },
  {
    name: "farewell-skips-greeting-lead",
    why: "LVX178 counter accuracy: 'Good morning, thanks for calling …' is the greeting, not a goodbye.",
    file: "lib/voice/closingOrder.js",
    find: "      GREETING_LEAD_RE.test(text.slice(0, m.index))",
    replace: "      m.index === 0 // SABOTAGE",
    red: [A1_CLOSINGORDER],
  },
  {
    name: "confirm-readback-tied-to-slot",
    why: "round A1 T6 accuracy: a booking's read-backs are the ones naming its slot; counting 'I'm putting you through' or a read-back of a slot the caller changed makes saves_over_one_readback nonzero on a clean call.",
    file: "lib/voice/live/index.js",
    find: "    !(save.rule === \"booking\" && save.slot) || readBackMentionsSlot(text, save.slot);",
    replace: "    true; // SABOTAGE",
    red: [A1_CONFIRMAUDIT],
  },
  // Round A1 S3 (2026-10-14): I3 + the last-chance write.
  {
    name: "request-correction-updates",
    why: "round A1 S3 I3: a same-call correction ('no, it's 0 1 2 4') updates the row it corrects; broken, every correction files a second row and the first, wrong one stays.",
    file: "lib/capabilities/customerRequests.js",
    find: "          if (!match) return null;",
    replace: "          return null; // SABOTAGE",
    red: [S3_REQUESTS, S3_LIVEREQUESTS],
  },
  {
    name: "request-one-email",
    why: "round A1 S3 I3, re-anchored Ilija S3 (R68): one owner email per message. A message saved or corrected on a call emails nothing at save; the owner's one email goes at call end. Broken, every save and every correction emails at once. (Until R68 this row broke only the customer_request_corrected log line, since 4059bac moved the rule to ownerNoticePending.)",
    file: "capabilities/messages.js",
    find: "        if (!saved.ownerNoticePending) {",
    replace: "        if (true) { // SABOTAGE",
    red: [S3_REQUESTS, S3_LIVEREQUESTS],
  },
  {
    name: "request-one-email-quote",
    why: "round A1 S3 I3, re-anchored Ilija S3 (R68): the quotes half of one-email-per-request. A quote saved or corrected on a call emails nothing at save; the owner's one email goes at call end. Broken, every save and every correction emails at once. (Green in the S3 final gate: since 4059bac the old anchor guarded only a log line no quote test reads.)",
    file: "capabilities/quotes.js",
    find: "        if (!saved.ownerNoticePending) {",
    replace: "        if (true) { // SABOTAGE",
    red: [S3_REQUESTS],
  },
  {
    name: "request-abrupt-end-emails",
    why: "round A1 S3: a record (or a correction) whose turn never completed -- the line dropped -- is still written and emailed by finish(); broken, the caller was told 'passing that on' and nobody was.",
    file: "lib/voice/live/index.js",
    find: "        dispatchEffects(pendingCapabilityEffects);",
    replace: "        void 0; // SABOTAGE",
    red: [S3_LIVEREQUESTS],
  },
  {
    name: "last-chance-dispatches-effects",
    why: "round A1 S3 (owner: fix in S3): the message re-issued at close writes through its EFFECT; dropped, message_saved_last_chance counts a message with no row and no owner email.",
    file: "lib/voice/live/index.js",
    find: "          dispatchEffects(effects);",
    replace: "          void effects; // SABOTAGE",
    red: [S3_LASTCHANCE],
  },
  {
    name: "last-chance-not-abandoned",
    why: "round A1 S3: the post-call read derives `abandoned` at verify time; the finish()-time snapshot reports a last-chance message as abandoned and files a false 'may need a call back'.",
    file: "lib/voice/live/index.js",
    find: "        abandoned: [...refusedToolsThisCall].filter((n) => !completedToolsThisCall.has(n)),",
    replace: "        abandoned: abandonedTools, // SABOTAGE",
    red: [S3_LASTCHANCE],
  },
  // Round A1 S3 review round (opus C1, I1, I2).
  {
    name: "request-reason-without-names",
    why: "round A1 S3 C1: the caller's own name is not a reason; counted, 'Jon Smith wants a callback about his invoice' and 'Jon Smith says the gate code changed' merge and the second overwrites the first.",
    file: "lib/capabilities/customerRequests.js",
    find: "      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !names.has(w))",
    replace: "      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)) // SABOTAGE",
    red: [S3_REQUESTS],
  },
  {
    name: "request-person-not-number",
    why: "round A1 S3 C1: a clearly different name is a different person even on the same phone (Jon / Jane); merged, Jane's request overwrites Jon's.",
    file: "lib/capabilities/customerRequests.js",
    find: "  return editDistance(x, y) / Math.max(x.length, y.length) <= 0.34;",
    replace: "  return true; // SABOTAGE",
    red: [S3_REQUESTS],
  },
  {
    name: "request-no-reason-keeps-message",
    why: "round A1 S3 C1: a re-record that says only 'wants a call back' must not replace 'about invoice 4471' on the row.",
    file: "lib/capabilities/customerRequests.js",
    find: "          const message = !hasReason(reasonOf(row.message), row.callerName)",
    replace: "          const message = false // SABOTAGE",
    red: [S3_REQUESTS],
  },
  {
    name: "quote-reason-is-description",
    why: "round A1 S3 C1: a quote is matched on what it is FOR; with the Address/Urgency labels counted, two jobs at one address merge.",
    file: "capabilities/quotes.js",
    find: "      reasonOf: quoteReason,",
    replace: "      reasonOf: (m) => m, // SABOTAGE",
    red: [S3_REQUESTS],
  },
  {
    name: "quote-number-on-insert-only",
    why: "round A1 S3 I1: the caller ID fills a NEW quote only; on a correction that names no number it would overwrite the number the caller gave.",
    file: "capabilities/quotes.js",
    find: "        callbackNumber: data.callback_number || null,",
    replace: "        callbackNumber: data.callback_number || party.phone || null, // SABOTAGE",
    red: [S3_REQUESTS],
  },
  {
    name: "notify-reports-delivery",
    why: "round A1 S3 I2: notifyCustomerRequest says whether the owner was reached; a constant answer makes every correction either silent after a failed send or a second email.",
    file: "services/notifications.js",
    find: "    return reached;",
    replace: "    return true; // SABOTAGE",
    red: ["tests/notifications.phi.test.js"],
  },
  // ---- Round A1 part 3 (2026-10-15): F1-F4 from the part-2 live calls ----
  {
    name: "p3-echo-key-in-turn-reply",
    why: "A1 part 3 F1 (CAff059ed): the refusal echo must key on the words spoken THIS turn, or 'said the handed sentence, called again' gets the cached refusal until the round cap.",
    file: "lib/voice/live/tools.js",
    find: '      textFingerprint(state?.inTurnReplyText ?? ""),',
    replace: '      "", // SABOTAGE',
    red: ["tests/liveWriteHammering.test.js"],
  },
  {
    name: "p3-echo-key-voiced-wire",
    why: "A1 part 3 F1: a sound the transcript lost after a held read-back changes only the voiced wire; without it in the key the re-call gets the cached hold.",
    file: "lib/voice/live/tools.js",
    find: '      typeof state?.callerVoicedSinceReply === "boolean" ? String(state.callerVoicedSinceReply) : "null",',
    replace: '      "null", // SABOTAGE',
    red: ["tests/liveSilenceReadBack.test.js"],
  },
  {
    name: "p3-cap-reply-held-write",
    why: "A1 part 3 F1: past MAX_TOOL_ROUNDS a write the gates are holding is answered held; the generic 'Too many tool calls... speak with what you already have' made the model say it could not book.",
    file: "lib/voice/live/index.js",
    find: "            if (heldSayThisTurn.has(fc.name)) {",
    replace: "            if (false) { // SABOTAGE",
    red: ["tests/liveWriteHammering.test.js"],
  },
  {
    name: "p3-cap-held-line-recorded",
    why: "A1 part 3 F1: the cap hands back the line the hold gave the caller (the one read-back sentence); recorded empty, the model gets no sentence to say.",
    file: "lib/voice/live/index.js",
    find: "          if (lineFor.has(fr.name)) heldSayThisTurn.set(fr.name, { say: lineFor.get(fr.name), slot: slotFor(fr.name) });",
    replace: '          if (lineFor.has(fr.name)) heldSayThisTurn.set(fr.name, { say: "", slot: slotFor(fr.name) }); // SABOTAGE',
    red: ["tests/liveWriteHammering.test.js"],
  },
  {
    name: "p3-cap-held-no-line",
    why: "A1 part 3 F1: a spelling-held write has no caller-safe line but is still held; unmarked, the cap answers it 'Too many tool calls'.",
    file: "lib/voice/live/index.js",
    find: "        else if (fr?.response?.gated === true) {",
    replace: "        else if (false) { // SABOTAGE",
    red: ["tests/liveWriteHammering.test.js"],
  },
  {
    name: "p3-replay-log-callsid",
    why: "A1 part 3 F1: live_write_refusal_replayed without callSid is invisible to a per-call log read -- part 2 read CAff059ed as 'one tool ran'.",
    file: "lib/voice/live/tools.js",
    find: 'log.info("live_write_refusal_replayed", { callSid: extras.callSid || null, tool: fc.name });',
    replace: 'log.info("live_write_refusal_replayed", { tool: fc.name }); // SABOTAGE',
    red: ["tests/liveWriteHammering.test.js"],
  },
  {
    name: "p3-say-it-then-call",
    why: "A1 part 3 F1 (retargeted, LVX179 wording): the handed-question refusal says to STOP and WAIT for the answer, not to call again in the same breath; 'call this straight away' invites the five-call hammer before any audio.",
    file: "services/tools.js",
    find: 'Then stop talking and wait for their answer -- do ` +\n    `not call this again in the same breath. When',
    replace: 'Then call this straight away. ` + // SABOTAGE\n    `When',
    red: ["tests/liveWriteHammering.test.js"],
  },
  {
    name: "p3-on-file-never-asked",
    why: "A1 part 3 F4 (owner): a name on file is never asked for, said or not (LVX53's provenance ask is replaced by the spelled read-back).",
    file: "lib/nameQuality.js",
    find: '    if (count) bumpCounter(nameSpokenIn(name, callerSaidThisCall) ? "write_name_provenance_ok" : "write_name_on_file_unspoken");',
    replace: "    if (!nameSpokenIn(name, callerSaidThisCall)) return true; // SABOTAGE",
    red: ["tests/nameProvenance.test.js"],
  },
  {
    name: "p4-on-file-name-said",
    why: "A1 part 4 (owner, call d1 'felt weird'): the handed sentence SAYS a name on file; letters only for a surname spelled this call. Re-anchors p3-on-file-surname-spelled.",
    file: "services/tools.js",
    find: "callerSpelled: ctx?.callerSpelled === true,",
    replace: "callerSpelled: true, // SABOTAGE",
    red: ["tests/nameProvenance.test.js"],
  },
  {
    name: "p3-spell-ask-once-wording",
    why: "A1 part 3 F4 (CAfbe569): the spelling refusal tells the model to ask once and never re-ask itself; the model asked again after 'Don't you already have the spelling?'.",
    file: "services/tools.js",
    find: "              `as you heard it. Ask them once: whatever they answer — letters, a no, or a question — do ` +",
    replace: "              `as you heard it. ` + // SABOTAGE",
    red: ["tests/nameProvenance.test.js"],
  },
  {
    name: "p3-precheck-counts-nothing",
    why: "A1 part 3 F2: the write-order gate's look-ahead at the spelling gate decides only; counting there doubles write_name_* on every held booking.",
    file: "services/tools.js",
    find: "    count: false,\n  });\n}",
    replace: "    count: true, // SABOTAGE\n  });\n}",
    red: ["tests/nameProvenance.test.js"],
  },
  {
    name: "p3-letters-said-back-always",
    why: "A1 part 3 F3 (LVX172, LVX179 wording): a name the caller spelled is ALWAYS said back letter by letter inside the one question, not only when the letters look wrong.",
    file: "services/gemini.js",
    find: "so they can be misheard too: whenever the caller has spelled a name, say it back one letter at a time inside your one question",
    replace: "so they can be misheard too: if the letters look wrong, say them back one letter at a time inside your one question",
    red: ["tests/a1PromptTrims.test.js"],
  },
  {
    name: "p3-message-summary-spells",
    why: "A1 part 3 F3: the message summary spells a surname the caller spelled -- call (a)'s row held 'Dodole' for D-O-D-L-A.",
    file: "capabilities/messages.js",
    find: "Summarise it ONCE, in one breath — name (a surname they spelled, one letter at a time),",
    replace: "Summarise it ONCE, in one breath — name,",
    red: ["tests/a1PromptTrims.test.js"],
  },
  {
    name: "p4-on-file-said-in-prompt",
    why: "A1 part 4 (owner): the booking guardrail has the model SAY a name on file in its one read-back, never spell it. Re-anchors p3-on-file-spelled-in-prompt. RETARGETED (LVX179): wording is now 'In your one question'; the surname-spelled clause covers a name spelled on this call.",
    file: "capabilities/appointments.js",
    find: ' In your one question, just say the name — "for Nithin Dodla" — and do not spell it; letters are only for a name they spelled for you on this call.',
    replace: ' In your one question, say that name one letter at a time too — "for Nithin, N-I-T-H-I-N, Dodla, D-O-D-L-A" — so a mistake on file can be heard.',
    red: ["tests/a1PromptTrims.test.js"],
  },
  {
    name: "p4-on-file-said-in-message",
    why: "A1 part 4 (owner): message step 1 has the model SAY a name on file in its one summary, never spell it. RETARGETED (LVX179): wording is now 'In your one question'.",
    file: "capabilities/messages.js",
    find: ' In your one question, just say the name — "for Nithin Dodla" — and do not spell it; letters are only for a name they spelled for you on this call.',
    replace: ' In your one question, say that name one letter at a time too — "for Nithin, N-I-T-H-I-N, Dodla, D-O-D-L-A" — so a mistake on file can be heard.',
    red: ["tests/a1PromptTrims.test.js"],
  },
  {
    name: "p3-spell-before-readback",
    why: "A1 part 3 F2 (owner): when the spelling gate would hold a write with no read-back standing, the spelling is asked BEFORE the handed 'booking that now' sentence, never after it.",
    file: "services/tools.js",
    find: "              spellingGateWouldHold(fc, ctx, pack, nameOnFile);",
    replace: "              false; // SABOTAGE",
    red: ["tests/liveSavePolicy.test.js"],
  },
  {
    name: "p3-cap-pass-said",
    why: "A1 part 3 review I1: past the cap, the ONE call made after the handed sentence was said reaches the gate; otherwise the sentence is handed again (said twice) and the save waits for a sound from the caller.",
    file: "lib/voice/live/index.js",
    find: "      heldSentenceSaid(toolCall.functionCalls[0]);",
    replace: "      false; // SABOTAGE",
    red: ["tests/liveWriteHammering.test.js"],
  },
  {
    name: "p3-cap-already-said",
    why: "A1 part 3 review I1: a capped call after the held sentence was said is told it was already said -- never handed the sentence again.",
    file: "lib/voice/live/index.js",
    find: "              if (say && heldSentenceSaid(fc)) {",
    replace: "              if (false) { // SABOTAGE",
    red: ["tests/liveWriteHammering.test.js"],
  },
  {
    name: "p3-real-hold-overwrites",
    why: "A1 part 3 review M3: a later real hold of the same tool (the spelling gate, no line) replaces an earlier hold's sentence; kept, the cap hands 'booking that now' ahead of the spelling question.",
    file: "lib/voice/live/index.js",
    find: "          if (lineFor.has(fr.name)) heldSayThisTurn.set",
    replace: "          if (lineFor.has(fr.name) && !heldSayThisTurn.has(fr.name)) heldSayThisTurn.set",
    red: ["tests/liveWriteHammering.test.js"],
  },
  {
    name: "p4-onfile-readback-nameless",
    why: "A1 part 4 F-F (owner: a name on file is SAID, never spelled; replaces p3-onfile-readback-counted): an on-file booking whose read-back said neither first name nor surname is counted (d1b said no name), or the live call cannot show whether the prompt holds.",
    file: "lib/voice/live/index.js",
    find: "        else confirmAudit.onfile_readback_nameless += 1;",
    replace: "        else; // SABOTAGE",
    red: ["tests/liveConfirmAudit.test.js"],
  },
  {
    name: "p3-onfile-name-wire",
    why: "A1 part 3 review I2: the runner records each save's name; without it no save is ever on file and the counter reads 0 for every call.",
    file: "lib/voice/live/tools.js",
    find: "          completedActionNames.push(fc.args?.client_name ?? fc.args?.caller_name ?? null);",
    replace: "          completedActionNames.push(null); // SABOTAGE",
    red: ["tests/liveConfirmAudit.test.js"],
  },
  {
    name: "p4-ask-now-general",
    why: "A1 part 4 F-A (owner): when the caller says something that needs checking, the model checks it in its very next reply -- the general ask-now rule, in the static prefix Live is built from.",
    file: "services/gemini.js",
    find: "check it in your very next reply — not later, and never after you have started booking.",
    replace: "check it.",
    red: ["tests/a1AskNow.test.js"],
  },
  {
    name: "p4-ask-now-spelling",
    why: "A1 part 4 F-A (call b): on Live the step-scoped spelling block never reaches the model, so the static prefix must tell it to ask a new name's spelling straight away, before times and any read-back.",
    file: "services/gemini.js",
    find: "(!outbound && spellPolicy() !== \"off\"",
    replace: "(false // SABOTAGE",
    red: ["tests/a1AskNow.test.js"],
  },
  {
    name: "p4-meridiem-in-declaration",
    why: "A1 part 4 F-A (call b): the example teaches the read-back form; a bare 'Tuesday at 3' is one the gate's slot matcher cannot read, so the model's own read-back went unseen and S was handed twice. RETARGETED (LVX179): the declaration's example is now the one QUESTION 'So that's Tuesday at 3 p.m. for Jon Doe, is that right?'.",
    file: "capabilities/appointments.js",
    find: "e.g. \\\"So that's Tuesday at 3 p.m. for Jon Doe, is that right?\\\"",
    replace: "e.g. \\\"So that's Tuesday at 3 for Jon Doe, is that right?\\\"",
    red: ["tests/a1AskNow.test.js"],
  },
  {
    name: "p4-no-booking-now-while-open",
    why: "A1 part 4 F-A, retargeted (LVX179 dropped 'booking that now'): the book_appointment declaration -- which Live always carries -- says to ask any spelling or extra-or-move question BEFORE the one question.",
    file: "capabilities/appointments.js",
    find: "    \"Ask any spelling or extra-or-move question BEFORE that one question. \" +",
    replace: "    \"\" + // SABOTAGE",
    red: ["tests/a1AskNow.test.js"],
  },
  {
    name: "p4-in-addition-when-clear",
    why: "A1 part 4 F-A (owner, d1 'another appointment' was still asked): no in-addition ask when the caller's words make it clear or it is for someone else; the model sets the flag. RETARGETED (LVX179): the clear-cue list now includes 'one more'.",
    file: "capabilities/appointments.js",
    find: "      \"\\\"another\\\", \\\"also\\\", \\\"as well\\\", \\\"one more\\\", \\\"a second one\\\" — or it is for someone else, \" +",
    replace: "      \"\" +",
    red: ["tests/a1AskNow.test.js"],
  },
  {
    name: "p4-g2-count-and-next",
    why: "A1 part 4 G2 (owner): three or more bookings on file are said as a count and the next one; d1b named one of three.",
    file: "services/gemini.js",
    find: "    if (total >= 3) {",
    replace: "    if (false) { // SABOTAGE",
    red: ["tests/a1AskNow.test.js"],
  },
  {
    name: "p4-weekday-bare-hour",
    why: "A1 part 4 F-C (CAdefce6ab): 'Wednesday at 10 for Priya Raman, booking that now' must read as a read-back of a Wed 10:00 slot -- the gate missed it and handed S on top (read-back twice); the confirm counter missed it too.",
    file: "lib/voice/slotMention.js",
    find: " || weekdayBareHour(haystack, naive, openEnd)",
    replace: " /* SABOTAGE */",
    red: ["tests/slotMention.test.js","tests/liveSavePolicy.test.js"],
  },
  {
    name: "p4-bare-hour-word-bounded",
    why: "A1 part 4 F-C: the bare hour is word-bounded -- without it 'Wednesday at 10' authorises a write at 1 p.m.",
    file: "lib/voice/slotMention.js",
    find: "      end +",
    replace: "      \"\" +",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-bare-hour-daytime-only",
    why: "A1 part 4 F-C: a bare hour is read only for a daytime slot (07:00-19:59), where it has one reading; 'Wednesday at 10' must not authorise 10 p.m.",
    file: "lib/voice/slotMention.js",
    find: "hour24 < 8 || hour24 > 18",
    replace: "hour24 < 0 || hour24 > 23",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-bare-hour-no-minute-after",
    why: "A1 part 4 F-C: a minute after the bare hour ('Wednesday at 10 30', 'ten thirty') is a different time; it was already checked against the minute forms and disagreed.",
    file: "lib/voice/slotMention.js",
    find: "|o'clock|oclock|\\\\d+|${minuteWords})",
    replace: "|o'clock|oclock)",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-in-addition-first",
    why: "A1 part 4 F-E (F5, call d1): with no read-back standing the write-order gate steps aside when the in-addition guard would ask, so the caller hears the question BEFORE any 'booking that now'.",
    file: "services/tools.js",
    find: "              inAdditionWouldRefuse(fc.args || {}, ctx, ctx?.config || {});",
    replace: "              false; // SABOTAGE",
    red: ["tests/a1InAddition.test.js"],
  },
  {
    name: "p4-different-person-not-asked",
    why: "A1 part 4 F-E (owner, call b): a booking for a different person than those on file is never asked 'in addition?' -- it cannot be a move of theirs.",
    file: "capabilities/appointments.js",
    find: "  return { policy, all, existing: policy === \"block\" ? all : samePersonBookings(args?.client_name, all) };",
    replace: "  return { policy, all, existing: all }; // SABOTAGE",
    red: ["tests/a1InAddition.test.js"],
  },
  {
    name: "p4-same-person-fails-toward-asking",
    why: "A1 part 4 F-E: 'different person' must be clearly different -- a misheard first name (one edit) or a shared surname still asks, or a move would be booked as a second appointment.",
    file: "capabilities/appointments.js",
    find: "    if (withinOneEdit(words[0], theirs[0])) return true;",
    replace: "    if (words[0] === theirs[0]) return true; // SABOTAGE",
    red: ["tests/a1InAddition.test.js"],
  },
  {
    name: "p4-guard-reads-the-predicate",
    why: "A1 part 4 F-E: the guard decides with the same predicate the gate's look-ahead reads; a guard with its own copy drifts (the F2 look-ahead's recorded risk). RETARGETED: the guard passes guardArgs (Fix 3 may set in_addition_to_existing).",
    file: "capabilities/appointments.js",
    find: "          const blocked = inAdditionWouldRefuse(guardArgs, ctx, config);",
    replace: "          const blocked = true; // SABOTAGE",
    red: ["tests/a1InAddition.test.js"],
  },
  {
    name: "p4-g2-guard-count-next",
    why: "A1 part 4 G2 (owner): the guard says three or more bookings as a count and the next one, counted from the database (a sixth is never in the prompt's five).",
    file: "capabilities/appointments.js",
    find: "  const total = existing.length === (all || existing).length ? existing.length + overflow : existing.length;",
    replace: "  const total = Math.min(existing.length, 2); // SABOTAGE",
    red: ["tests/a1InAddition.test.js"],
  },
  {
    name: "p4-in-addition-after-readback-counted",
    why: "A1 part 4 F-E: an in-addition question that still lands after a read-back of the slot (the model said its own first) is counted, so the late ask is visible on a call.",
    file: "capabilities/appointments.js",
    find: "              bumpCounter(\"in_addition_asked_after_readback\");",
    replace: "              // SABOTAGE",
    red: ["tests/a1InAddition.test.js"],
  },
  {
    name: "p4-upcoming-total-from-db",
    why: "A1 part 4 G2: fetchCallerContext counts every upcoming booking, not only the five it lists -- 'You have 7 upcoming appointments' must be the real number.",
    file: "services/db.js",
    find: "    upcomingOverflow,\n    upcomingBeyond,\n",
    replace: "    upcomingBeyond, // SABOTAGE\n",
    red: ["tests/callerContext.test.js"],
  },
  {
    name: "p4-g2-prompt-db-count",
    why: "A1 part 4 G2: the prompt's count + next sentence uses the database's count; the five listed would say 5 for a caller with 7.",
    file: "services/gemini.js",
    find: "    const total = appts.length + Math.max(0, Number(callerContext.upcomingOverflow) || 0);",
    replace: "    const total = appts.length; // SABOTAGE",
    red: ["tests/a1AskNow.test.js"],
  },
  {
    name: "p4-allow-keeps-the-list",
    why: "A1 part 4 F-E review-of-self: under the allow policy the guard's helper must still hand back every upcoming booking -- the write path tells the model 'also has an existing upcoming appointment'; without it the booking threw ('There was an error booking').",
    file: "capabilities/appointments.js",
    find: "  if (policy === \"allow\") return { policy, all: upcomingForCaller(ctx), existing: [] };",
    replace: "  if (policy === \"allow\") return { policy, existing: [] }; // SABOTAGE",
    red: ["tests/tools.test.js"],
  },
  {
    name: "p4-readback-wait",
    why: "A1 part 4 F-D (F6, CAdefce6ab/CA046f67): Live sends the tool call before the read-back's transcript; without the wait the gate hands sentence S over the model's own read-back -- said twice.",
    file: "lib/voice/live/index.js",
    find: "        const waited = await waitForReadBack(readBackWait);",
    replace: "        const waited = { frozen: null }; // SABOTAGE",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-readback-wait-ends-on-words",
    why: "A1 part 4 F-D: the wait ends the moment a read-back of the slot arrives; otherwise every same-breath read-back costs the full 2 s and then S anyway.",
    file: "lib/voice/live/index.js",
    find: "      if (readBackWaiter && readsBackSlot(turnReplyText, readBackWaiter.slot, { open: true })) {\n        readBackWaiter.finish(\"arrived\");\n      }",
    replace: "      // SABOTAGE",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-readback-wait-only-if-spoke",
    why: "A1 part 4 F-D (owner): wait only when the model sent audio this turn -- a call made without speaking has no words coming, and waiting would add 2 s of silence.",
    file: "lib/voice/live/index.js",
    find: "    if (readBackWaitMs() <= 0 || modelAudioTurnSeq !== turnSeq) return null;",
    replace: "    if (readBackWaitMs() <= 0) return null; // SABOTAGE",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-readback-wait-skips-standing",
    why: "A1 part 4 F-D: a read-back already in this turn (or the last) needs no wait; waiting for words that already arrived only delays the save.",
    file: "lib/voice/live/index.js",
    find: "      if (readsBackSlot(turnReplyText, slot, { open: true }) || readsBackSlot(lastReplyText, slot)) continue;",
    replace: "      // SABOTAGE",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-readback-wait-turn-end",
    why: "A1 part 4 F-D: the turn ending stops the wait at once -- nothing more is coming, and the gate must answer the held call.",
    file: "lib/voice/live/index.js",
    find: "      if (sc.turnComplete && readBackWaiter) readBackWaiter.finish(\"turn_end\");",
    replace: "      // SABOTAGE",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-booking-writes-chained",
    why: "A1 part 4 F-D: a second booking call that lands during a wait runs after the first, never beside it -- two gate runs at once could write the booking twice.",
    file: "lib/voice/live/index.js",
    find: "      if (bookingEntry?.prior) await bookingEntry.prior;",
    replace: "      // SABOTAGE",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-readback-wait-freezes-state",
    why: "A1 part 4 F-D: the gate judges the turn state frozen when the wait ended -- a turnComplete in the same message would otherwise roll the turn first and the same-breath read-back would be held for an answer (silence, then the ladder).",
    file: "lib/voice/live/index.js",
    find: "        frozen = waited.frozen;",
    replace: "        // SABOTAGE",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-booking-entry-no-yield",
    why: "A1 part 4 F-D: entering the booking-write chain must not yield when nothing is ahead -- an await with nothing to wait for lets a turnComplete roll the turn before the gate reads it (liveClaimGuardRefusedWrite).",
    file: "lib/voice/live/index.js",
    find: "      if (bookingEntry?.prior) await bookingEntry.prior;",
    replace: "      await bookingEntry?.prior; // SABOTAGE",
    red: ["tests/liveClaimGuardRefusedWrite.test.js"],
  },
  {
    name: "p4-slot-forms-whole-word",
    why: "the slot matcher finds time forms by substring again: '1 pm' inside '11 pm', so a read-back of 11 p.m. vouches for a 1 p.m. write (round A1 part 4, M).",
    file: "lib/voice/slotMention.js",
    find: "forms.some((form) => padded.includes(` ${normalize(form)} `))",
    replace: "forms.some((form) => haystack.includes(normalize(form)))",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-readbacks-by-sentence",
    why: "A1 part 4 F-F (CAdefce6ab): a booking's read-backs are counted per TURN again, so call b's read-back said twice in one turn reads saves_over_one_readback 0.",
    file: "lib/voice/live/index.js",
    find: "save.rule === \"booking\" && save.slot ? Math.max(1, slotReadBackCount(text, save.slot, S)) : 1;",
    replace: "1; // SABOTAGE",
    red: ["tests/liveConfirmAudit.test.js"],
  },
  {
    name: "p4-split-glued-sentences",
    why: "A1 part 4 F-F: the splitter needs a space after the full stop again, so Live's glued 'booking that now.Wednesday, ...' is one sentence and call b's doubled read-back counts once.",
    file: "lib/voice/readBackCount.js",
    find: "    if (k < s.length && !/[A-Z]/.test(s[k])) continue;",
    replace: "    if (k === j || (k < s.length && !/[A-Z]/.test(s[k]))) continue; // SABOTAGE",
    red: ["tests/readBackCount.test.js","tests/liveConfirmAudit.test.js"],
  },
  {
    name: "p4-split-keeps-letters-and-meridiem",
    why: "A1 part 4 F-F: the splitter stops protecting a lone letter's full stop, so 'P.M. for', 'D. O. D. L. A.' split mid-sentence and a read-back's slot and statement land in different sentences.",
    file: "lib/voice/readBackCount.js",
    find: "      if (LETTER_END.test(head) && !MERIDIEM_END.test(head)) continue;",
    replace: "      // SABOTAGE",
    red: ["tests/readBackCount.test.js"],
  },
  {
    name: "p4-readback-sentence-names-slot",
    why: "A1 part 4 F-F: every read-back sentence counts, slot or not, so 'Just to confirm, Friday at 2 PM. Does that sound right?' reads as two read-backs (10 such turns in call-corpus).",
    file: "lib/voice/readBackCount.js",
    find: "isReadBack(p, S) && readBackMentionsSlot(p, slot)",
    replace: "isReadBack(p, S) /* SABOTAGE */",
    red: ["tests/readBackCount.test.js","tests/liveConfirmAudit.test.js"],
  },
  {
    name: "p4-interrupted-turn-audited",
    why: "A1 part 4 F-F (d1b, CA046f67): an interrupted turn's text is cleared without the confirm audit reading it again, so a save its caller heard read back reads 0.",
    file: "lib/voice/live/index.js",
    find: "        noteConfirmTurn(interruptedReply, getStrings(state.config));",
    replace: "        // SABOTAGE",
    red: ["tests/liveConfirmAudit.test.js"],
  },
  {
    name: "p4-spell-ask-after-readback",
    why: "A1 part 4 F-F (CAdefce6ab): a spelling ask after a read-back of a write not yet made is no longer counted, so the ask-now rule cannot be checked on a live call.",
    file: "lib/voice/live/index.js",
    find: "      if (confirmReadbackTexts.length || readBackBeforeSpellAsk(replyText, S)) {",
    replace: "      if (false) { // SABOTAGE",
    red: ["tests/liveConfirmAudit.test.js"],
  },
  {
    name: "p4-spell-ask-please",
    why: "A1 part 4 F-F: the counters' spell-ask test is the shared spellRequestRe alone again, which misses call b's own 'could you please spell'.",
    file: "lib/voice/readBackCount.js",
    find: "return Boolean(S?.spellRequestRe?.test(text) || SPELL_ASK_EXTRA.test(text));",
    replace: "return Boolean(S?.spellRequestRe?.test(text)); // SABOTAGE",
    red: ["tests/readBackCount.test.js","tests/liveConfirmAudit.test.js"],
  },
  {
    name: "p4-onfile-named-prior-turn",
    why: "A1 part 4 F-F: a read-back a turn before the save is no longer read for the name, so every on-file booking read back before its write reads nameless.",
    file: "lib/voice/live/index.js",
    find: "      save.named = mine.some((t) => namesPerson(t.text, save.name));",
    replace: "      save.named = false; // SABOTAGE",
    red: ["tests/liveConfirmAudit.test.js"],
  },
  {
    name: "p4-onfile-named-same-breath",
    why: "A1 part 4 F-F: a read-back in the same breath as the save (the usual Live order) is no longer read for the name, so those on-file bookings read nameless.",
    file: "lib/voice/live/index.js",
    find: "        if (namesPerson(replyText, first.name)) first.named = true;",
    replace: "        // SABOTAGE",
    red: ["tests/liveConfirmAudit.test.js"],
  },
  {
    name: "p4-names-person-whole-word",
    why: "A1 part 4 F-F: the name is found by substring again, so 'Priyanka' reads as saying Priya.",
    file: "lib/voice/readBackCount.js",
    find: "  return Boolean(words?.some((w) => wanted.has(w)));",
    replace: "  return [...wanted].some((n) => String(text || \"\").toLowerCase().includes(n)); // SABOTAGE",
    red: ["tests/readBackCount.test.js"],
  },
  {
    name: "p4-d1-lower-bound-utc",
    why: "the calls list lower bound goes back to a UTC ::date cast: the business day starts at the wrong hour (F-G).",
    file: "AI-phone-dashboard/backend/src/callDateBounds.js",
    find: "::date::timestamp AT TIME ZONE ${tzParam})`);",
    replace: "::date)`); /* SABOTAGE */",
    cwd: "AI-phone-dashboard/backend",
    red: ["src/__tests__/callsDateBounds.test.js"],
  },
  {
    name: "p4-d1-upper-bound-utc",
    why: "the calls list upper bound goes back to UTC midnight: calls after 7 PM CDT on the last day vanish until tomorrow (F-G).",
    file: "AI-phone-dashboard/backend/src/callDateBounds.js",
    find: "::date + 1)::timestamp AT TIME ZONE ${tzParam})`);",
    replace: "::date + 1))`); /* SABOTAGE */",
    cwd: "AI-phone-dashboard/backend",
    red: ["src/__tests__/callsDateBounds.test.js"],
  },
  {
    name: "p4-d1-tz-lookup-ignored",
    why: "the business timezone is read but ignored, always the default: a London business gets Chicago day bounds (F-G).",
    file: "AI-phone-dashboard/backend/src/callDateBounds.js",
    find: "return r.rows[0]?.timezone || DEFAULT_TIMEZONE;",
    replace: "return DEFAULT_TIMEZONE; /* SABOTAGE */",
    cwd: "AI-phone-dashboard/backend",
    red: ["src/__tests__/callsDateBounds.test.js"],
  },
  {
    name: "p4-d1-tz-lookup-always",
    why: "the timezone lookup runs on every list request, even with no date filter: an extra query per page load (F-G).",
    file: "AI-phone-dashboard/backend/src/routes/calls.js",
    find: "    if (from || to) {",
    replace: "    if (true /* SABOTAGE */) {",
    cwd: "AI-phone-dashboard/backend",
    red: ["src/__tests__/callsDateBounds.test.js"],
  },
  {
    name: "p4-d1-preset-sends-to",
    why: "a date preset sends the browser's local `to` again: the list is cut off at the wrong midnight (F-G).",
    file: "AI-phone-dashboard/frontend/src/callsQueryParams.js",
    find: "if (datePreset === \"custom\" && toDate) params.to = toDate;",
    replace: "if (toDate) params.to = toDate; /* SABOTAGE */",
    cwd: "AI-phone-dashboard/frontend",
    red: ["src/__tests__/callsQueryParams.test.js"],
  },
  {
    name: "p4-bare-hour-no-seven",
    why: "A1 part 4 review I1 (owner 2026-10-16): a bare 7 is read again -- 7 a.m. and 7 p.m. were both in the old 07:00-19:59 window, so 'Wednesday at 7' authorised either and the caller never heard which.",
    file: "lib/voice/slotMention.js",
    find: "hour24 < 8 || hour24 > 18",
    replace: "hour24 < 7 || hour24 > 19",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-bare-hour-month-only",
    why: "A1 part 4 review I1: any word may sit between the weekday and the bare hour again, so 'Wednesday evening at 10' authorises a 10 a.m. write.",
    file: "lib/voice/slotMention.js",
    find: "(?: (?:${MONTH}))?",
    replace: "(?: [a-z]+)?",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-bare-hour-part-of-day",
    why: "A1 part 4 review I1: a part of the day after the bare hour is ignored again, so 'Wednesday at 10 in the evening' authorises 10 a.m. (and a caller's evening correction reads as restating the slot).",
    file: "lib/voice/slotMention.js",
    find: "      `(?! (?:in the (?:morning|afternoon|evening)|at night|tonight|this (?:morning|afternoon|evening))(?: |$))`",
    replace: "      ``",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-readback-open-end",
    why: "A1 part 4 review I3 (owner: keep saving on arrival, never on a cut-off hour): while the read-back wait reads text still arriving, a bare hour that is the last word counts again -- 'at ten' then ' thirty' saves 10:00.",
    file: "lib/voice/slotMention.js",
    find: "  const end = openEnd ? \"(?= (?!(?:in|at|this|a|p|o|the) )\\\\S+ )\" : \"(?= |$)\";",
    replace: "  const end = \"(?= |$)\"; // SABOTAGE",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-slot-edge-punct",
    why: "A1 part 4 review M8: a colon or quote at a word's edge breaks the whole-word match again, so 'at 3 pm: is that right?' is not a read-back of 3 p.m.",
    file: "lib/voice/slotMention.js",
    find: "const padded = ` ${haystack.replace(/(^| )[':]+/g, \"$1\").replace(/[':]+(?= |$)/g, \"\")} `;",
    replace: "const padded = ` ${haystack} `; // SABOTAGE",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-same-person-shared-word",
    why: "A1 part 4 review M7: a name stored surname-first ('Dodla, Nithin') or behind a title ('Mr Dodla') is still the same person as 'Nithin Dodla' -- without the shared-word rule it reads as different and the in-addition question is never asked.",
    file: "capabilities/appointments.js",
    find: "    return words.some((w) => w.length >= 2 && theirs.includes(w));",
    replace: "    return false; // SABOTAGE",
    red: ["tests/a1InAddition.test.js"],
  },
  {
    name: "p4-upcoming-overflow-live",
    why: "A1 part 4 review M6: the guard's count is the LIVE list plus the database's overflow; a stale call-start total says '3 upcoming' after a cancel and misses a booking made this call.",
    file: "capabilities/appointments.js",
    find: "  const total = existing.length === (all || existing).length ? existing.length + overflow : existing.length;",
    replace: "  const total = existing.length === (all || existing).length ? Math.max(existing.length, 3) : existing.length; // SABOTAGE",
    red: ["tests/a1InAddition.test.js"],
  },
  {
    name: "p4-frozen-state-per-call",
    why: "A1 part 4 review I4: the runner ignores the per-call frozen state again, so a waited booking is judged on the NEXT turn's state when turnComplete lands in the same message.",
    file: "lib/voice/live/tools.js",
    find: "      const state = (frozenState ?? turnState()) || {};",
    replace: "      const state = turnState() || {}; // SABOTAGE",
    red: ["tests/liveToolContext.test.js","tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-retry-defers-to-waited-booking",
    why: "A1 part 4 review I2: the turn-end retry fires while the model's own booking waits for its read-back, so the stashed (unspelled) write and the model's call race for the slot.",
    file: "lib/voice/live/index.js",
    find: "    if (bookingWriteChain) {\n      if (queuedRetry) return queuedRetry;",
    replace: "    if (false) {\n      if (queuedRetry) return queuedRetry;",
    red: ["tests/liveWriteRetry.test.js"],
  },
  {
    name: "p4-wait-arrival-open-end",
    why: "A1 part 4 review I3 (owner: never save on a cut-off hour): the wait's arrival check reads the text as finished again, so 'at two' ends the wait before ' thirty' arrives and 14:00 is saved.",
    file: "lib/voice/live/index.js",
    find: "readsBackSlot(turnReplyText, readBackWaiter.slot, { open: true })",
    replace: "readsBackSlot(turnReplyText, readBackWaiter.slot)",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-saved-then-asked-counted",
    why: "A1 part 4 review I3 (owner: keep saving, COUNT it): a confirming question after a booking saved on its read-back words is no longer counted, so the live calls cannot show how often it happens.",
    file: "lib/voice/live/index.js",
    find: "    if (/\\?/.test(tail) && !S.closingTicRe?.test(tail)) marker.asked = true;",
    replace: "    // SABOTAGE",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-saved-then-asked-at-turn-end",
    why: "A1 part 4 review I3: the turn end no longer reads the words after a saved read-back, so 'saved, then asked' is never seen.",
    file: "lib/voice/live/index.js",
    find: "      if (!spokenLinePending) noteConfirmTurn(replyText, S);\n      noteArrivalTail();",
    replace: "      if (!spokenLinePending) noteConfirmTurn(replyText, S);",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-wait-ends-on-close",
    why: "A1 part 4 review M5: a hang-up no longer ends the read-back wait; the gate runs up to 2 s after close and answers a closed session.",
    file: "lib/voice/live/index.js",
    find: "    if (readBackWaiter) readBackWaiter.finish(\"closed\");",
    replace: "    // SABOTAGE",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-retry-queued-not-dropped",
    why: "A1 part 4 re-review I1 (LVX160): the turn-end retry is dropped, not queued, behind a booking in flight -- the caller's yes to the in-addition question is lost when the model's flagless call is refused.",
    file: "lib/voice/live/index.js",
    find: "          await runHeldWrite({ frozen, modelSpokeThisTurn, seq });",
    replace: "          // SABOTAGE",
    red: ["tests/liveWriteRetry.test.js"],
  },
  {
    name: "p4-open-hold-words",
    why: "A1 part 4 re-review M2: open text accepts a bare hour followed by a word still arriving ('at 10 in', 'at 10 p', 'at ten thir'), so the wait ends and 10:00 is saved before 'in the evening' / 'p.m.' / 'thirty' lands.",
    file: "lib/voice/slotMention.js",
    find: "  const end = openEnd ? \"(?= (?!(?:in|at|this|a|p|o|the) )\\\\S+ )\" : \"(?= |$)\";",
    replace: "  const end = openEnd ? \"(?= )\" : \"(?= |$)\"; // SABOTAGE",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-open-digit-stop",
    why: "A1 part 4 re-review M4: a full stop right after a digit closes open text again, so a UK 'at 10.' (then '30') ends the wait on 10:00.",
    file: "lib/voice/slotMention.js",
    find: "  const openEnd = open && !/(?:[,!?;:]|(?<![0-9])\\.)[\"')\\]]*$/.test(String(readBack).trimEnd());",
    replace: "  const openEnd = open && !/(?:[,!?;:]|\\.)[\"')\\]]*$/.test(String(readBack).trimEnd()); // SABOTAGE",
    red: ["tests/slotMention.test.js"],
  },
  {
    name: "p4-skip-check-open",
    why: "A1 part 4 re-review M3: the skip-the-wait check reads the turn's arriving text as finished, so a bare hour ending the words said before the call skips the wait and saves on half a time.",
    file: "lib/voice/live/index.js",
    find: "readsBackSlot(turnReplyText, slot, { open: true }) || readsBackSlot(lastReplyText, slot)",
    replace: "readsBackSlot(turnReplyText, slot) || readsBackSlot(lastReplyText, slot)",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-saved-asked-any-question",
    why: "A1 part 4 re-review M5: only a read-back-shaped question counts as 'saved, then asked' again, so 'Does that work for you?' after a saved read-back is missed.",
    file: "lib/voice/live/index.js",
    find: "    if (/\\?/.test(tail) && !S.closingTicRe?.test(tail)) marker.asked = true;",
    replace: "    if (/\\?/.test(tail) && S.confirmReadBackRe?.test(tail)) marker.asked = true; // SABOTAGE",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-arrival-marker-cleared-on-interrupt",
    why: "A1 part 4 re-review M5: after an interrupt the arrival marker is kept, and the next turn's text is sliced at the old length -- a later question counts as 'saved, then asked'.",
    file: "lib/voice/live/index.js",
    find: "      noteArrivalTail({ done: true });",
    replace: "      noteArrivalTail();",
    red: ["tests/liveReadBackWait.test.js"],
  },
  {
    name: "p4-name-title-only",
    why: "A1 part 4 re-review M7: a title alone ('Mrs') is a name again, so a row on file under just a title reads as a different person and the in-addition question is skipped.",
    file: "capabilities/appointments.js",
    find: "  return (normalizeName(raw) || \"\").split(\" \").filter((w) => w && !NAME_TITLES.has(w));",
    replace: "  return (normalizeName(raw) || \"\").split(\" \").filter(Boolean); // SABOTAGE",
    red: ["tests/a1InAddition.test.js"],
  },
  {
    name: "p4-overflow-cancel-unlisted",
    why: "A1 part 4 re-review M6: cancelling a booking beyond the five listed no longer shrinks the overflow, so 'You have N upcoming appointments' stays one high.",
    file: "capabilities/appointments.js",
    find: "    if (next.length === list.length && Number(base.upcomingOverflow) > 0) {",
    replace: "    if (false) {",
    red: ["tests/a1InAddition.test.js"],
  },
  {
    name: "p6-day-only-unique",
    why: "Round A1 Part 6 Fix 1 (owner, 2026-10-19): a move question naming only the old booking's DAY counts when that person has ONE booking that day. Sabotaged, any booking that day will do, so with two that day the day-only question moves one of them.",
    file: "capabilities/appointments.js",
    find: "  return bookingsFitting(last, ctx, fits) === 1;",
    replace: "  return bookingsFitting(last, ctx, fits) >= 1; // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p6-day-counts-beyond",
    why: "Round A1 Part 6 Fix 1: the day's count includes the rows past the five listed (upcomingBeyond). Sabotaged, a sixth booking on that day is invisible and the day-only question moves a row while the caller has two that day.",
    file: "capabilities/appointments.js",
    find: "  const rows = [...upcomingForCaller(ctx), ...(Array.isArray(beyond) ? beyond : []), last].filter((a) => {",
    replace: "  const rows = [...upcomingForCaller(ctx), last].filter((a) => { // SABOTAGE",
    red: [LVX179_REPLAY],
  },
  {
    name: "p6-day-other-weekday",
    why: "Round A1 Part 6 Fix 1: the old half of the move question must name THIS booking's weekday and no other. Sabotaged, 'move your appointment on Thursday' moves the Friday booking.",
    file: "capabilities/appointments.js",
    find: "  if (days.some((w) => w !== weekday)) return false;",
    replace: "  // SABOTAGE: any weekday",
    red: [LVX179_REPLAY],
  },
  {
    name: "p6-beyond-follows-call",
    why: "Round A1 Part 6 Fix 1: a cancel of a row past the five listed removes it from upcomingBeyond too. Sabotaged, the cancelled booking still counts for its day.",
    file: "capabilities/appointments.js",
    find: "    nextBeyond = beyond && beyond.filter((a) => a?.id !== data.appointmentId);",
    replace: "    // SABOTAGE",
    red: ["tests/capabilityEffects.test.js"],
  },
  {
    name: "p6-unusable-note-only-unanswered",
    why: "Round A1 Part 6 (call a): the unusable-transcript note goes only to a turn the model left unanswered. Sabotaged, it follows a reply the model already gave and the caller hears two replies.",
    file: "lib/voice/live/index.js",
    find: "    auditCallerTurn({ notes: !replyText && modelAudioTurnSeq !== turnSeq });",
    replace: "    auditCallerTurn({ notes: true }); // SABOTAGE",
    red: ["tests/liveUnusableTranscript.test.js"],
  },
  {
    name: "p6-onfile-note-in-reply",
    why: "Round A1 Part 6 Fix 2 (calls a/c; probe P6ONFILE spell 5/10 -> 0/10): set_call_intent's reply carries the on-file name, the moment the model acts on before its words. Sabotaged, the reply is bare and the on-file caller is asked to spell again.",
    file: "services/tools.js",
    find: "...(onFile ? { message: onFile } : {}) };",
    replace: "}; // SABOTAGE",
    red: ["tests/a1OnFileNote.test.js"],
  },
  {
    name: "p6-onfile-live-inbound-only",
    why: "Round A1 Part 6 Fix 2: the on-file note is Live + inbound only (the cascade has its own spelling gate; an outbound contact's name has its own rule). Sabotaged, the cascade's set_call_intent reply changes.",
    file: "capabilities/appointments.js",
    find: "  if (ctx?.callerSaidThisCall == null || ctx?.outboundCall) return null;",
    replace: "  if (ctx?.outboundCall) return null; // SABOTAGE",
    red: ["tests/a1OnFileNote.test.js"],
  },
  {
    name: "p6-onfile-another-not-on-block",
    why: "Round A1 Part 6 Fix 2: 'another = an extra booking' is said only where a second booking is allowed. Sabotaged, a business that blocks a second booking hears the model told to book it.",
    file: "capabilities/appointments.js",
    find: '    canBook && existingAppointmentPolicy(capabilityConfig(config, "appointments")) !== "block"',
    replace: "    true // SABOTAGE",
    red: ["tests/a1OnFileNote.test.js"],
  },
  {
    name: "p6-objection-one-question",
    why: "Round A1 Part 6 (P5 gate backlog): a yes that carries a change is held with the one-question instruction (LVX179). Sabotaged, it hands the pre-LVX179 'read the new ones back once in one sentence', and the caller hears a statement read-back plus the question.",
    file: "services/tools.js",
    find: "                          `ask ONE question that names the new day, time and name -- \"So that's ..., is that ` +",
    replace: "                          `read the new ones back once in one sentence and call this again -- \"So that's ..., is that ` +",
    red: ["tests/liveSavePolicy.test.js"],
  },
  {
    name: "p6-unusable-note-audio-counts",
    why: "Round A1 Part 6 (opus review): the model's AUDIO answers an unusable turn too. Sabotaged, a reply whose transcription never arrived is followed by the note and the caller hears two replies.",
    file: "lib/voice/live/index.js",
    find: "    auditCallerTurn({ notes: !replyText && modelAudioTurnSeq !== turnSeq });",
    replace: "    auditCallerTurn({ notes: !replyText }); // SABOTAGE",
    red: ["tests/liveUnusableTranscript.test.js"],
  },
  {
    name: "p6-day-fits-what-was-named",
    why: "Round A1 Part 6 (opus review H1): a day-only move question counts the bookings that fit what it NAMED -- 'your Friday appointment' fits every Friday. Sabotaged to the old date only, another Friday on file is ignored and the just-booked row is moved on an ambiguous question.",
    file: "capabilities/appointments.js",
    find: "    if (days.length && weekdayOf(Number(r[1]), Number(r[2]), Number(r[3])) !== weekday) return false;",
    replace: "    if (Number(r[3]) !== d || Number(r[2]) !== mo) return false; // SABOTAGE: the old date only",
    red: ["tests/lvx179Replay.test.js"],
  },
  {
    name: "p6-day-spelled-ordinal",
    why: "Round A1 Part 6 (opus review H1): a spelled date ('the twenty-fifth') is read like digits. Sabotaged, it is invisible, the question reads as weekday-only, and a move happens for a date that is not the booking's.",
    file: "capabilities/appointments.js",
    find: "  String.raw`\\d{1,2}(?:st|nd|rd|th)?|(?:(?:twenty|thirty)\\s+)?(?:${ORDINAL_UNITS.join(\"|\")})|` +",
    replace: "  String.raw`\\d{1,2}(?:st|nd|rd|th)?|` + // SABOTAGE: no spelled units",
    red: ["tests/lvx179Replay.test.js"],
  },
  {
    name: "p6-day-word-clock",
    why: "Round A1 Part 6 (opus review L1): a time said in words in the old half ('half past two', 'at eleven') names a time, so the day-only form never applies. Sabotaged, 'your Friday half past two appointment' moves the 9 a.m. booking.",
    file: "capabilities/appointments.js",
    find: "    String.raw`\\bat\\s+(?:${HOUR_WORDS})\\b|\\b(?:half|quarter)\\s+(?:past|to)\\b|\\bin\\s+the\\s+(?:morning|afternoon|evening)\\b|` +",
    replace: "    String.raw`` + // SABOTAGE: no word clocks",
    red: ["tests/lvx179Replay.test.js"],
  },
  {
    name: "p6-day-unknown-snapshot",
    why: "Round A1 Part 6 (opus review L2): no call-start snapshot means the caller's other bookings are UNKNOWN, not none. Sabotaged, a snapshot rebuilt from this call's booking alone reads as complete and the day-only question moves a row.",
    file: "capabilities/appointments.js",
    find: "  if (!cc || cc.snapshotMissing) return Infinity;",
    replace: "  if (!cc) return Infinity; // SABOTAGE",
    red: ["tests/lvx179Replay.test.js"],
  },
  {
    name: "p6-onfile-booking-intent-only",
    why: "Round A1 Part 6 (opus review M2): the on-file note rides only a BOOKING intent (its one question says the name back). Sabotaged, a message from someone else on the household phone is filed under the on-file name.",
    file: "capabilities/appointments.js",
    find: "  if (intent !== \"book_appointment\") return null;",
    replace: "  // SABOTAGE: every intent",
    red: ["tests/a1OnFileNote.test.js"],
  },
  {
    name: "p6-onfile-listed-names-only",
    why: "Round A1 Part 6 (opus review M3): names come from the LISTED bookings only, the spelling gate's own list. Sabotaged, a name past the five listed is called 'on record' and the gate then asks that caller to spell it.",
    file: "capabilities/appointments.js",
    find: "  const rows = Array.isArray(cc?.upcomingAppointments) ? cc.upcomingAppointments : [];",
    replace: "  const rows = [...(cc?.upcomingAppointments || []), ...(cc?.upcomingBeyond || [])]; // SABOTAGE",
    red: ["tests/a1OnFileNote.test.js"],
  },
  {
    name: "p6-onfile-in-addition-flag",
    why: "Round A1 Part 6 (opus review M1): 'another' tells the model to book with in_addition_to_existing set, or the in-addition guard asks its own question after the read-back. Sabotaged, the flag is not asked for.",
    file: "capabilities/appointments.js",
    find: "        \"move or reschedule one they already have, do not list the ones they already have, and book it with \" +",
    replace: "        \"move or reschedule one they already have, and do not list the ones they already have; \" + // SABOTAGE",
    red: ["tests/a1OnFileNote.test.js"],
  },
  {
    name: "p6-day-ordinal-anchored",
    why: "Round A1 Part 6 (opus re-review, High): a number or ordinal is a DATE only beside a weekday or month. Sabotaged, a stray one ('your eighteenth one', 'your first appointment') is read as a date and picks the row to move.",
    file: "capabilities/appointments.js",
    find: "  return new RegExp(String.raw`\\b(?:${DATE_TOKEN})\\b`).test(rest) ? null : dates;",
    replace: "  return [...dates, ...[...rest.matchAll(new RegExp(String.raw`\\b(${DATE_TOKEN})\\b`, \"g\"))].map((x) => dateValue(x[1]))]; // SABOTAGE",
    red: ["tests/lvx179Replay.test.js"],
  },
  {
    name: "p6-empty-snapshot-missing",
    why: "Round A1 Part 6 (opus re-review): fetchCallerContext's empty shape (withheld number, no database) is UNKNOWN, not none. Sabotaged, a withheld caller's day-only move question is accepted as if they had no other bookings.",
    file: "services/db.js",
    find: "  const empty = { callCount: 0, lastCallSummary: null, upcomingAppointments: [], snapshotMissing: true };",
    replace: "  const empty = { callCount: 0, lastCallSummary: null, upcomingAppointments: [] }; // SABOTAGE",
    red: ["tests/callerContext.test.js"],
  },
  {
    name: "p6-ordinal-not-one",
    why: "Round A1 Part 6 (opus re-review #2): an ordinal followed by 'one' is an order ('your Monday, the second one'), not a date. Sabotaged, it is read as the 2nd and can pick the row to move.",
    file: "capabilities/appointments.js",
    find: "  const notOne = String.raw`\\b(?!\\s+ones?\\b)`;",
    replace: "  const notOne = String.raw`\\b`; // SABOTAGE",
    red: ["tests/lvx179Replay.test.js"],
  },
  {
    name: "p6-weekday-ordinal-only",
    why: "Round A1 Part 6 (opus re-review #2): beside a weekday only an ORDINAL is a date; a bare number there is as likely a time ('your Monday 9 appointment'). Sabotaged, the 9 is read as the 9th.",
    file: "capabilities/appointments.js",
    find: "    String.raw`\\b(?:${WEEKDAY_NAMES.join(\"|\")}),?\\s+(?:the\\s+)?(${ORDINAL_TOKEN})${notOne}`,",
    replace: "    String.raw`\\b(?:${WEEKDAY_NAMES.join(\"|\")}),?\\s+(?:the\\s+)?(${DATE_TOKEN})${notOne}`, // SABOTAGE",
    red: ["tests/lvx179Replay.test.js"],
  },
  {
    name: "p6-withheld-not-looked-up",
    why: "Round A1 Part 6 (opus re-review #2): a withheld number is a shared placeholder, never looked up -- else every withheld caller reads as one returning caller (another caller's last-call summary in the prompt) and their bookings as known.",
    file: "services/db.js",
    find: "  if (!pool || !businessId || !callerNumber || !isRealCallerNumber(callerNumber)) return empty;",
    replace: "  if (!pool || !businessId || !callerNumber) return empty; // SABOTAGE",
    red: ["tests/callerContext.test.js"],
  },
  {
    name: "p6-failed-lookup-unknown",
    why: "Round A1 Part 6 (opus re-review #2): a failed appointment lookup marks the snapshot unknown. Sabotaged, it reads as 'no bookings' and a day-only move question is accepted blind.",
    file: "services/db.js",
    find: "    ...(lookupFailed ? { snapshotMissing: true } : {}),",
    replace: "    // SABOTAGE",
    red: ["tests/callerContext.test.js"],
  },
  {
    name: "lvx183-silence-latch-cleared",
    why: "LVX183 (CAd51783477c, 2026-10-20): a caller who speaks after the silence goodbye clears its exit latch. Sabotaged, the refused goodbye exit stays set and hangs up at the end of the NEXT reply -- one that asked the caller a question.",
    file: "lib/voice/live/index.js",
    find: "          silenceOwnsExit &&\n          exitAfterTurn &&\n",
    replace: "          false && // SABOTAGE\n",
    red: ["tests/liveSilence.test.js"],
  },
  {
    name: "lvx183-ladder-restarts",
    why: "LVX183 (opus review): clearing the silence goodbye restarts the ladder itself. Sabotaged, words below the VAD floor leave silenceStage at 3 and nothing but the 9:30 hard end closes a silent line.",
    file: "lib/voice/live/index.js",
    find: "          silenceStage = 0;\n          ladderSince = atMs;\n          suppressionNotedForStage = -1;\n          bumpCounter(\"live_silence_exit_cancelled_caller_back\");",
    replace: "          bumpCounter(\"live_silence_exit_cancelled_caller_back\"); // SABOTAGE: ladder not restarted",
    red: ["tests/liveSilence.test.js"],
  },
  {
    name: "lvx183-words-only",
    why: "LVX183 (opus review): only a transcript with words cancels the silence goodbye. Sabotaged, a '?' transcript of noise keeps the line open.",
    file: "lib/voice/live/index.js",
    find: "          /[\\p{L}\\p{N}]/u.test(callerWords) &&",
    replace: "          true && // SABOTAGE",
    red: ["tests/liveSilence.test.js"],
  },
  {
    name: "details-merge",
    why: "Ilija inbound: a lead's later save merges its answers onto the stored ones. Sabotaged, mergeDetails returns the incoming details alone and a partial save wipes the earlier answers.",
    file: "lib/capabilities/customerRequests.js",
    find: "  const answers = Array.isArray(stored?.answers) ? stored.answers.map((a) => ({ ...a })) : [];",
    replace: "  if (incoming) return incoming; // SABOTAGE: merge skipped\n  const answers = Array.isArray(stored?.answers) ? stored.answers.map((a) => ({ ...a })) : [];",
    red: ["tests/customerRequestCorrection.test.js"],
  },
  {
    name: "email-tier-rule",
    why: "Ilija inbound: the owner email carries caller details except for a healthcare-tier business. Sabotaged, detailsAllowed is always true and a clinic's email carries the caller's name and number.",
    file: "services/notifications.js",
    find: '    detailsAllowed: effectiveTier(business) !== "hipaa",',
    replace: "    detailsAllowed: true, // SABOTAGE: tier ignored",
    red: ["tests/notifications.phi.test.js"],
  },
  {
    name: "notice-unwired",
    why: "Ilija inbound: the owner's email is sent from the status callback. Sabotaged, the handler never calls the flush and no call's saved messages are ever emailed.",
    file: "server.js",
    find: "          await flushOwnerNotices({ db, notifications, log, captureException, businessId: noticeBusinessId, callSid });",
    replace: "          // SABOTAGE: flush not called",
    red: ["tests/statusCallbackNotices.test.js"],
  },
  {
    name: "notice-no-settle",
    why: "Ilija inbound: the flush waits settleMs for an in-flight write before claiming. Sabotaged, the wait is ignored and a late write misses the email.",
    file: "lib/ownerNotices.js",
    find: "    await sleep(settleMs);",
    replace: "    await sleep(0); // SABOTAGE: settleMs ignored",
    red: ["tests/ownerNotices.test.js"],
  },
  {
    name: "notice-lease-ignored",
    why: "Ilija inbound Task L: a claim is a lease (migration 060). Sabotaged, the claim's WHERE ignores owner_notice_claimed_at, so a live lease is claimed twice and a Twilio retry of the status callback sends the owner a second email. Real-Postgres proof is tests/db/customerRequestDetails.test.js (the matrix cannot run DB suites); the root suite sees the predicate leave the UPDATE's own row.",
    file: "services/db.js",
    find: "cr.owner_notice_claimed_at IS NULL OR cr.owner_notice_claimed_at <",
    replace: "cr.owner_notice_claimed_at IS NULL OR cr.owner_notice_claimed_at IS NOT NULL OR cr.owner_notice_claimed_at <",
    red: ["tests/ownerNotices.test.js"],
  },
  {
    name: "notice-sent-not-completed",
    why: "Ilija inbound Task L: a sent group is completed (pending and the lease cleared). Sabotaged, the sent branch skips complete, so every row stays pending and is sent again by each later call once its lease runs out.",
    file: "lib/ownerNotices.js",
    find: "        if (outcome === \"sent\" || outcome === \"off\") {",
    replace: "        if (outcome === \"off\") { // SABOTAGE: sent skips complete",
    red: ["tests/ownerNotices.test.js"],
  },
  {
    name: "graph-token-not-cached",
    why: "Ilija inbound Task M: the Graph token is cached until 60 s before expires_in. Sabotaged, the cache is never read and every owner email fetches a token of its own.",
    file: "services/graphMail.js",
    find: "    if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.token);",
    replace: "    // SABOTAGE: token cache never read",
    red: ["tests/notifications.graph.test.js"],
  },
  {
    name: "graph-plain-sends-html",
    why: "Ilija inbound Task M, R9 on the Graph path: a plainOnly email (the one carrying caller details) goes as Text with no html. Sabotaged, it goes as HTML.",
    file: "services/notifications.js",
    find: '      ? { contentType: "Text", content: text }',
    replace: '      ? { contentType: "HTML", content: text } // SABOTAGE: plainOnly sends HTML',
    red: ["tests/notifications.graph.test.js"],
  },
  {
    name: "callback-line-ignored",
    why: "Ilija inbound Task 7: a business's callbackLine must replace the urgency question and the standing promise in the message protocol and step guidance. Sabotaged, the prompt ignores the line and renders the default protocol, so the caller hears the standing promise instead of the business's own.",
    file: "capabilities/messages.js",
    find: '  return typeof cfg?.callbackLine === "string" && cfg.callbackLine.trim() ? cfg.callbackLine : null;',
    replace: "  return null; // SABOTAGE: callbackLine ignored",
    red: ["tests/capabilityConfig.test.js"],
  },
  {
    name: "own-number-identity",
    why: "Ilija inbound Task 8: a call from the business's own number is recorded and answered with no caller number. Sabotaged, the helper hands the own number through, so the stream's callerPhone is the business's own line and a message with no spoken number would call the business back on itself.",
    file: "lib/inboundGuards.js",
    find: '  if (isOwnNumber(business, from)) return "";',
    replace: "  if (isOwnNumber(business, from)) return from; // SABOTAGE: own number kept as the caller",
    red: ["tests/inboundGuardRoutes.test.js"],
  },
  {
    name: "emergency-911-everywhere",
    why: "Ilija inbound Task 9: a UK business's callers are told to dial 999, not 911. Sabotaged, the helper always answers 911, so a UK caller in an emergency is told a number that does not connect in the UK.",
    file: "lib/phone.js",
    find: 'return countryFromE164(e164) === "GB" ? "999" : "911";',
    replace: 'return "911"; // SABOTAGE: always 911',
    red: ["tests/phone.test.js"],
  },
  {
    name: "question-hold",
    why: "Ilija inbound Task 10, LVX185: a caller whose answer to 'anything else?' is a question back, or a request to hold on, keeps the call open for one more turn at both doors (end_call refused with caller_question, sign-off exit held), at most twice a call. Sabotaged, callerLeftQuestionOpen always says no, so both doors close the line on a caller who is still asking -- CA86103cd.",
    file: "lib/transcriptUtils.js",
    find: "  return asksBack || HOLD_REQUEST_RE.test(trimmed);",
    replace: "  return false; // SABOTAGE: a question back reads as nothing else",
    red: [ASK, EXITCLOSE, "tests/transcriptUtils.test.js"],
  },
  {
    name: "onfile-name-asserted",
    why: "Ilija inbound Task 12, LVX188: a name on file is a question, never assumed. The single-name note goes back to stating the on-file name as the caller's (\"that is their name: use it exactly as written\") with no 'Am I speaking with' check, so a name left on a shared phone by someone else is used without confirmation. tests/a1OnFileNote.test.js asserts the question and the absence of the old statement.",
    file: "capabilities/appointments.js",
    find: "      `If yes, use it exactly as written: do not ask for it again, do not ask them to spell it, and do not spell it back. If no, ask for their name.` +",
    replace: "      `that is their name: use it exactly as written. Do not ask for their name, do not ask them to spell it, and do not spell it back.` +",
    red: ["tests/a1OnFileNote.test.js"],
  },
  {
    name: "ask-cap",
    why: "Ilija inbound Task 13, LVX189/LVX169: one ask per need, counted in code. The ledger names an ask as a repeat after the caller asked something back or declined, and always after two answered asks. Sabotaged, repeatIn never names a repeat, so the contact number is asked on every turn again -- CAe52b758's seven asks.",
    file: "lib/voice/askLedger.js",
    find: "      if (callerWantsRepeat) return null;",
    replace: "      return null; // SABOTAGE: no ask is ever a repeat",
    red: ["tests/askLedger.test.js"],
  },
  {
    name: "ask-wire",
    why: "Ilija inbound Task 13, LVX189: the Live cutter judges every output fragment against the ask ledger and clears a repeated ask's audio with LVX78's tapered cut. Sabotaged, the per-fragment call is gone, so the ledger is never consulted on a live call and the repeated ask is not counted.",
    file: "lib/voice/live/index.js",
    find: "        inspectAsk(sc.outputTranscription.text);",
    replace: "        // SABOTAGE: the ask cutter is never called",
    red: ["tests/liveRepeatCut.test.js"],
  },
  {
    name: "notice-not-awaited",
    why: "Ilija inbound Task A1: Cloud Run throttles CPU once the response ends, so the status handler must await the flush. Sabotaged, the flush is fire-and-forget and the response goes out before the email is sent (it would be throttled and lost).",
    file: "server.js",
    find: "          await flushOwnerNotices({ db, notifications, log, captureException, businessId: noticeBusinessId, callSid });",
    replace: "          void flushOwnerNotices({ db, notifications, log, captureException, businessId: noticeBusinessId, callSid }); // SABOTAGE: not awaited",
    red: ["tests/statusCallbackNotices.test.js"],
  },
  {
    name: "notice-settle-default",
    why: "Ilija inbound Task A1: the server passes no settleMs and relies on the 2 s default for an in-flight write to land before the claim. Sabotaged, the default is 0 and nothing settles.",
    file: "lib/ownerNotices.js",
    find: "  settleMs = 2000,",
    replace: "  settleMs = 0, // SABOTAGE: default settle gone",
    red: ["tests/ownerNotices.test.js"],
  },
  {
    name: "email-accepted-reads-failed",
    why: "Ilija inbound Task A1, R12: once the email was accepted, a text still hanging at the 10 s deadline must not make the result failed (the rows would be released and the same email sent again). Sabotaged, the deadline resolves failed unconditionally.",
    file: "services/notifications.js",
    find: '        resolve(emailAccepted ? "sent" : "failed");',
    replace: '        resolve("failed"); // SABOTAGE: accepted email reads failed',
    red: ["tests/notifications.callRequests.test.js"],
  },
  {
    name: "release-rearms-completed",
    why: "Ilija inbound Task A1: a release may only touch a still-pending row. Sabotaged, the UPDATE has no pending predicate, so a flush stalled past its lease re-arms a row another flush already completed and it is emailed again. Real-Postgres proof is tests/db/customerRequestDetails.test.js; the root suite sees the SQL shape.",
    file: "services/db.js",
    find: "uuid[]) AND owner_notice_pending",
    replace: "uuid[])",
    red: ["tests/ownerNotices.test.js"],
  },
  {
    name: "speech-locale-phone-ignored",
    why: "Ilija inbound Task A2: speech recognition locale reads the business's own number (businessPhone from loadConfig) before the timezone. Sabotaged, step 4 reads the never-set phoneNumber, so a UK-numbered business in a US timezone is recognised as en-US.",
    file: "lib/voice/voiceLocale.js",
    find: "countryFromE164(config?.businessPhone || config?.mainPhone);",
    replace: "countryFromE164(config?.phoneNumber || config?.mainPhone); // SABOTAGE: business phone ignored",
    red: ["tests/voiceLocale.test.js"],
  },
  {
    name: "decline-not-sticky",
    why: "Ilija inbound Task A3: a decline blocks that need for the whole call. Sabotaged, repeatIn never consults the declined set, so a declined ask is allowed again after one unrelated turn.",
    file: "lib/voice/askLedger.js",
    find: "if (declined.has(key) && hasWords) return key;",
    replace: "if (false && declined.has(key) && hasWords) return key; // SABOTAGE: decline not sticky",
    red: ["tests/askLedger.test.js"],
  },
  {
    name: "decline-never-lifted",
    why: "Ilija inbound Task A3: the caller's own later words lift a decline. Sabotaged, the lift is a no-op, so a caller who changes their mind is still never asked again.",
    file: "lib/voice/askLedger.js",
    find: "for (const key of liftedBy(t)) declined.delete(key);",
    replace: "for (const key of liftedBy(t)) void key; // SABOTAGE: decline never lifted",
    red: ["tests/askLedger.test.js"],
  },
  {
    name: "decline-lift-late",
    why: "Ilija inbound Task A3 fix round 1: the reply to the turn that changes the caller's mind is spoken before turn close records the lift, so repeatIn lifts in-turn from callerWords. Sabotaged, the in-turn lift is empty and the ask the caller just invited is cut.",
    file: "lib/voice/askLedger.js",
    find: "liftedBy(callerWords);",
    replace: "new Set(); // SABOTAGE: in-turn lift neutralised",
    red: ["tests/askLedger.test.js", "tests/liveRepeatCut.test.js"],
  },
  {
    name: "onboarding-tier-optional",
    why: "Ilija inbound Task 14: a new business must answer the healthcare question. Sabotaged, the refusal is removed, so a new business silently takes the column default 'standard' and a healthcare client can go live on the wrong tier.",
    file: "scripts/import-tenant.js",
    find: "if (!COMPLIANCE_TIERS.includes(business.compliance_tier)) {",
    replace: "if (false) { // SABOTAGE: tier optional",
    red: ["tests/importTenantFields.test.js"],
  },
  {
    name: "abandoned-message-said-appointment",
    why: "Ilija inbound Task R1: a refused message save must be worded as a message, not a lost appointment. Sabotaged, the message-only branch is neutralised, so the row notes fall back to the booking sentence and no kind reaches the owner alert.",
    file: "lib/postCallVerify.js",
    find: "    abandonedOutstanding &&",
    replace: "    false &&",
    red: ["tests/postCallVerify.test.js"],
  },
  {
    name: "second-message-dropped",
    why: "Ilija inbound Task F (final review I-1): only a save that carries answers matches the same person whatever its reason. Sabotaged, a caller_type alone is enough, so a second, different request from the same caller merges onto the first row instead of filing a row of its own.",
    file: "lib/capabilities/customerRequests.js",
    find: "            : row.details?.answers?.length > 0",
    replace: "            : row.details // SABOTAGE: a caller_type alone takes the person-only match",
    red: [S3_REQUESTS],
  },
  {
    name: "spelling-one-need",
    why: "Ilija inbound Task F (final review I-2): a spelling ask is keyed by what is spelled (name, email, other). Sabotaged, every spelling is one need again, so declining the name spelling cuts the email spelling for the whole call and two name spellings use up the email's.",
    file: "lib/voice/askLedger.js",
    find: "    if (SPELL_RE.test(sentence)) {",
    replace: "    if (SPELL_RE.test(sentence)) { kinds.push(\"spelling:any\"); } else if (false) { // SABOTAGE: every spelling is one need",
    red: ["tests/askLedger.test.js"],
  },
  {
    name: "graph-empty-boots",
    why: "Ilija inbound Task F (final review I-3): MAIL_TRANSPORT=graph with none of the four MS_GRAPH_* values refuses to boot (graph_not_configured). Sabotaged, it boots with a notice, owner email is off, and every message saved on that revision is settled 'off' at call end and never emailed, even once the values arrive.",
    file: "lib/bootChecks.js",
    find: "  if (graphMode && graphMissing.length === GRAPH_MAIL_VARS.length) {",
    replace: "  if (false) { // SABOTAGE: graph mode with no graph values boots",
    red: ["tests/bootChecks.test.js"],
  },
  {
    name: "decline-blocks-offered",
    why: "Ilija inbound Task F follow-up R65 (re-review N-1): a declining clause blocks the fixed kinds it names, except one the same clause offers. Sabotaged, 'I'd rather not give my email just call me on my mobile' blocks the number for the whole call, and the later ask for the number the caller offered is cut.",
    file: "lib/voice/askLedger.js",
    find: "      if (!offersKind(key, clause, [])) out.push(key);",
    replace: "      out.push(key); // SABOTAGE: an offered kind is blocked too",
    red: ["tests/askLedger.test.js"],
  },
  {
    name: "message-owed-no-row",
    why: "Ilija inbound Task N: a message intent with no save and no attempt files the call-back row and the alert (production 2026-11-10: a lead hung up after the read-back and nobody was told). Sabotaged, the fact is never true, so such a call files nothing and the lead is lost silently again.",
    file: "lib/postCallVerify.js",
    // Re-anchored in fix round 4: the intent is no longer a conjunct, so the
    // fact is broken at another one.
    find: "    !messageAttempted &&",
    replace: "    false &&",
    red: ["tests/postCallVerify.test.js"],
  },
  {
    name: "message-intent-wire",
    why: "Ilija inbound Task N: the Live session latches a declared message intent and hands it to the post-call read. Sabotaged, the session passes false whatever intent was declared, so the net in lib/postCallVerify.js is correct and dead on every real call.",
    file: "lib/voice/live/index.js",
    find: "        messageIntent: messageIntentThisCall,",
    replace: "        messageIntent: false, // SABOTAGE: the declared intent never reaches the read",
    red: ["tests/livePostCall.test.js"],
  },
  {
    name: "message-owed-booked-call",
    why: "Ilija inbound Task N fix round 1 (C1): a caller who declared a message intent and then booked (or tried to) is not 'a message was not saved'. Sabotaged, the appointment-tool exclusion is gone, so a served caller gets a false call-back row and alert, and a refused booking is worded as a message.",
    file: "lib/postCallVerify.js",
    find: "    !appointmentToolAttempted;",
    replace: "    true;",
    red: ["tests/postCallVerify.test.js"],
  },
  {
    name: "message-owed-transfer",
    why: "Ilija inbound Task N fix round 1 (I1): request_transfer is not an action tool, so only the session's own latch tells the read that a person took the caller. Sabotaged, the session never reports a started transfer, and a message intent followed by a transfer files 'none was saved'.",
    file: "lib/voice/live/index.js",
    find: "        transferStarted: transferStartedThisCall,",
    replace: "        transferStarted: false,",
    red: ["tests/livePostCall.test.js"],
  },
  {
    name: "message-owed-needs-readback",
    why: "Ilija inbound Task N fix round 1 (I2, ruling R71): the model declares take_message for a mere offer, so the net also needs a spoken read-back of details after that intent. Sabotaged, an intent alone is enough, and a caller who declines the offer (or a robocall) files a call-back row.",
    file: "lib/postCallVerify.js",
    // Re-anchored in fix round 4 (renamed callerContactReadBack).
    find: "    callerContactReadBack === true &&",
    replace: "    true &&",
    red: ["tests/postCallVerify.test.js"],
  },
  {
    name: "message-owed-intent-free",
    why: "Ilija inbound Task N fix round 4: a tenant with no allowed tasks can only declare general_question, so the net must not need a declared message intent. Sabotaged, the intent is a conjunct again, and the lost-lead call's tenant files nothing (message_owed false on every call).",
    file: "lib/postCallVerify.js",
    find: "    callerContactReadBack === true &&",
    replace: "    messageIntent === true && callerContactReadBack === true &&",
    red: ["tests/postCallVerify.test.js", "tests/livePostCall.test.js"],
  },
  {
    name: "message-readback-business-number",
    why: "Ilija inbound Task N fix round 4: a number the assistant reads out that is the business's own (its line, main, transfer or notification number, or one in its notes) is not a caller's detail. Sabotaged, the exclusion is dropped, so 'you can reach the office on <our number>, or I can take a message?' to a caller who declines files a call-back row.",
    file: "lib/voice/contactReadBack.js",
    find: "    if (!own.numbers.has(run.slice(-TAIL))) return true;",
    replace: "    return true;",
    red: ["tests/livePostCall.test.js", "tests/contactReadBack.test.js"],
  },
  {
    name: "message-readback-business-email",
    why: "Ilija inbound Task N round 5: a spoken ' at ' becomes '@' for matching, so 'you can find us at digile.co.uk' reads as us@digile.co.uk. An address on one of the business's own domains (its notification email's, or any URL, bare domain or email in its notes) is not a caller's. Sabotaged, the exclusion is gone, so a caller who asks for the website and says goodbye files a false call-back row.",
    file: "lib/voice/contactReadBack.js",
    find: '    if ([...ownDomains].some((d) => host === d || host.endsWith("." + d))) continue;',
    replace: "    void ownDomains;",
    red: ["tests/livePostCall.test.js", "tests/contactReadBack.test.js"],
  },
  {
    name: "message-readback-www-host",
    why: "Ilija inbound Task N round 5: 'have a look at www.x.com' normalises to look@www.x.com; a www. host is a website, never a mailbox, whoever owns it. Sabotaged, a website the business did not write down reads as a caller's email.",
    file: "lib/voice/contactReadBack.js",
    find: '    if (host.startsWith("www.")) continue;',
    replace: "    void host;",
    red: ["tests/contactReadBack.test.js"],
  },
  {
    name: "message-owed-inbound-only",
    why: "Ilija inbound Task N round 5: an outbound call never takes a message, so the post-call message net must not run there (a contact who says 'ring my mobile' and books a callback is not a lost lead). Sabotaged, an outbound call that read a number back hands verify callerContactReadBack true.",
    file: "lib/voice/live/index.js",
    find: "        callerContactReadBack: !state.outboundCall && callerContactReadBackThisCall,",
    replace: "        callerContactReadBack: callerContactReadBackThisCall,",
    red: ["tests/outboundPostCallParty.test.js"],
  },
  {
    name: "request-type-split",
    why: "Ilija inbound Task N round 4b (production call CA082a6db7): message and callback are one pack and one request to the caller, so a same-call correction looks across both. Sabotaged, the messages pack matches on the save's own request type again, and a request saved as 'message' and then as 'callback' makes two rows and an owner email that lists the caller twice.",
    file: "capabilities/messages.js",
    find: "      matchTypes: MESSAGE_PACK_TYPES,",
    replace: "      matchTypes: null,",
    red: ["tests/customerRequestCorrection.test.js"],
  },
  {
    name: "message-readback-strict",
    why: "Ilija inbound Task N fix round 2 (R71): the message read-back latch asks readsContactBack (a 7-digit number, an email or a spelling), not 'any digit'. Sabotaged, any digit counts, so 'We open at 9 tomorrow. Would you like to leave a message?' after a take_message intent latches a read-back and a declined offer files a call-back row.",
    file: "lib/voice/live/index.js",
    // Re-anchored in fix rounds 3 and 4: the latch is readsCallerContactBack
    // alone, needs no intent, and skips the business's own contacts.
    find: "    if (readsCallerContactBack(replyText, businessContacts)) callerContactReadBackThisCall = true;",
    replace: "    if (/\\d/.test(replyText)) callerContactReadBackThisCall = true;",
    red: ["tests/livePostCall.test.js"],
  },
  {
    name: "message-readback-confirm-regex",
    why: "Ilija inbound Task N fix round 3 (R71): the booking confirm regex also matches an offer ('I can take a message for him, is that okay?'). Sabotaged, it feeds the message read-back latch again, so a declined offer files a call-back row.",
    file: "lib/voice/live/index.js",
    find: "    if (readsCallerContactBack(replyText, businessContacts)) callerContactReadBackThisCall = true;",
    replace: "    if (confirmReadBack || readsCallerContactBack(replyText, businessContacts)) callerContactReadBackThisCall = true;",
    red: ["tests/livePostCall.test.js"],
  },
  {
    name: "message-readback-run",
    why: "Ilija inbound Task N fix round 3: a number read out is 7+ digits in ONE run. Sabotaged, digits are summed across the turn, so opening hours ('8:30 to 5:30 ... 9 to 12') read as a phone number.",
    file: "lib/voice/askLedger.js",
    find: "    if (n > best) best = n;",
    replace: "    best += n;",
    red: ["tests/askLedger.test.js"],
  },
  {
    name: "withheld-number-block",
    why: "Task W: a caller whose number did not come through gets a block saying so and to ask for the digits. Sabotaged, the block keeps its header but loses the instruction, as before the fix a *67 caller 'using the number I am calling from' was told nothing.",
    file: "services/gemini.js",
    find: "        `Their number did not come through (it is withheld or hidden). If they say to use ` +",
    replace: "        `` +",
    red: ["tests/callerNumberInPrompt.test.js"],
  },
  {
    name: "withheld-save-asks-digits",
    why: "Task W: a save with no callback_number on a call with no usable caller number tells the model to ask for the digits. Sabotaged, the reply is a plain success again.",
    file: "capabilities/messages.js",
    find: "    const needsNumber = !hasCallback && !isRealCallerNumber(ctx?.callerPhone);",
    replace: "    const needsNumber = false;",
    red: ["tests/withheldSaveAsksDigits.test.js"],
  },
  {
    name: "message-owed-transfer-latch",
    why: "Ilija inbound Task N fix round 3 (I1): transferStarted is set when the transfer's redirect has succeeded, not when the exit is armed. Sabotaged, the latch is never set, so a call really handed to a person files 'none was saved'.",
    file: "lib/voice/live/index.js",
    find: "    transferStartedThisCall = true;",
    replace: "    void 0;",
    red: ["tests/livePostCall.test.js"],
  },
  {
    name: "seller-default-replaced",
    why: "S4-F1 (live seller call): a business's own sales-call rule REPLACES our seller default in the prompt, so the two never contradict. Sabotaged, the detector never sees the business's rule, our 'do not take a message' default sits beside 'take a short message' again, and the default won on the call that found this.",
    file: "lib/sellerCalls.js",
    find: "  return texts.some((t) => sellerRuleCategory(t) !== null);",
    replace: "  return texts.length < 0;",
    red: ["tests/promptSellerDefault.test.js"],
  },
  {
    name: "wrong-number-close-asks",
    why: "S4-F1 (live wrong-number call): the wrong-number close asks 'anything else?' once (described, never scripted: the quoted sentence is the 2026-09-05 tic), because the ask-gate holds an exit that never asked. Sabotaged, the bullet goes straight to goodbye and the gate holds that goodbye, as it did on the call.",
    file: "services/gemini.js",
    find: "wrong number, tell them politely in one sentence, then ask once whether there is anything else you can help with. If not, say goodbye",
    replace: "wrong number, tell them politely in one sentence, then say goodbye",
    red: ["tests/promptSellerDefault.test.js"],
  },
  {
    name: "silent-exit-after-goodbye",
    why: "S4-F1 (live wrong-number call): a goodbye spoken and held, then a quiet caller, ends the call with no line. Sabotaged, the latch never sets, so the ladder speaks 'Hello? Are you still there?' after the goodbye and then a second goodbye, as on the call.",
    file: "lib/voice/live/index.js",
    find: "    farewellHeldQuiet = true;",
    replace: "    farewellHeldQuiet = false;",
    red: ["tests/liveSilentExitAfterGoodbye.test.js"],
  },
  {
    name: "signoff-name-free",
    why: "S4-F4 (owner 2026-11-11): the goodbye thanks the caller without the business name, because a hard name is misheard on the line. Sabotaged, the canned close names the business again.",
    file: "lib/voice/strings.js",
    find: '    signOff: "Thank you for calling. Have a great day!",',
    replace: '    signOff: "Thank you for calling Acme Dental. Have a great day!",',
    red: ["tests/goodbyeNameFree.test.js"],
  },
  {
    name: "nudge-identify-no-booking",
    why: "S4-F2 (call 13): the second silence nudge offered 'book an appointment' on a line whose business takes no bookings. Sabotaged, it always returns the booking line again.",
    file: "lib/voice/session.js",
    find: "      return offersBooking(config) ? S.nudgeIdentify : S.nudgeIdentifyNoBooking;",
    replace: "      return S.nudgeIdentify;",
    red: ["tests/silenceLadderWords.test.js"],
  },
  {
    name: "signoff-wish-well",
    why: "S4-F2 part 2: end_call now says 'thank them for calling and wish them well'. Sabotaged, signOffRe stops hearing 'all the best' / 'wishing you a nice day' / 'I wish you well' after thanks-for-calling, so that goodbye does not arm the exit.",
    file: "lib/voice/strings.js",
    find: "|\\b(?:thanks|thank you)(?:\\s+(?:again|so\\s+much|very\\s+much))?\\s+for\\s+calling\\b[^!?]{0,60}?\\b(?:all\\s+the\\s+best|wish(?:ing)?\\s+you\\s+(?:a\\s+[a-z]+\\s+(?:day|weekend|evening)|well))\\b[^a-z]{0,3}$/i,",
    replace: "/i,",
    red: ["tests/strings.test.js"],
  },
  {
    name: "spelled-readback-note",
    why: "S4-F3 (call 15): a save made after the caller spelled carries a model-only note, first in next, to read back what was saved one letter at a time. Sabotaged, the note is never added, and a misheard surname ('Roman' for R-A-M-A-N) reaches the owner unread, as on the call.",
    file: "capabilities/messages.js",
    find: "    const readBack = spelledReadBackNote(args, ctx);",
    replace: "    const readBack = null;",
    red: ["tests/spelledReadBackNote.test.js"],
  },
  {
    name: "spelled-readback-no-double",
    why: "S4-F3: letters the assistant has already spoken (earlier, or in the same breath as the save, call 14's shape) are not read back a second time. Sabotaged, every item counts as unread, so a caller who just heard R-A-M-A-N is read it again.",
    file: "capabilities/messages.js",
    find: "  const unread = items.filter((item) => !item.voiced);",
    replace: "  const unread = items;",
    red: ["tests/spelledReadBackNote.test.js"],
  },
  {
    name: "intake-settings-validate",
    why: "Caller-experience Task 1: the options check on confirmStyle / spellUpFront is skipped, so an unknown value reaches the pack as if it were a real choice. tests/intakeSettings.test.js expects the bad value dropped.",
    file: "lib/capabilities/configSchema.js",
    find: "    } else if (Array.isArray(allowed) && !allowed.includes(raw[key])) {",
    replace: "    } else if (false) { // SABOTAGE",
    red: ["tests/intakeSettings.test.js"],
  },
  {
    name: "caller-type-stored",
    why: "Caller-experience Task 2: the reducer stops storing the caller type the model reports, so state.callerType stays null on every call and nothing built on it (read-back, spelling, path) ever sees a type. tests/liveCallerType.test.js reads state.callerType and the intake block.",
    file: "lib/voice/replyState.js",
    find: "    if (INTAKE_CALLER_TYPES.includes(intentArgs.caller_type)) state.callerType = intentArgs.caller_type;",
    replace: "    if (false) state.callerType = intentArgs.caller_type; // SABOTAGE",
    red: ["tests/liveCallerType.test.js"],
  },
  {
    name: "intake-protocol-no-reask",
    why: "Caller-experience Task 3: the standard-tier protocol loses its 'anything the caller already said counts as answered, never ask it again' rule, so the model is free to re-ask a reason the caller already gave. tests/intakeProtocol.test.js expects the rule.",
    file: "capabilities/messages.js",
    find: "Anything the caller has already said counts as answered: never ask it again, and never guess a detail. ",
    replace: "",
    red: ["tests/intakeProtocol.test.js"],
  },
  {
    name: "intake-path-note",
    why: "Caller-experience Task 3: the set_call_intent handler stops attaching the per-caller-type path note to its reply, so the Live model never gets the short path for the type it reported. tests/intakePath.test.js reads the reply's next.",
    file: "services/tools.js",
    find: "...(path ? { next: path } : {}), ",
    replace: "",
    red: ["tests/intakePath.test.js"],
  },
  {
    name: "messages-spell-gate-follows-setting",
    why: "Caller-experience Task 4: the message spelling gate stops consulting the spelling setting and the caller type, so a message save with an unspelled name is refused for spelling again on a business that never asked anyone to spell. tests/intakeSpelling.test.js pins the default-settings save going through.",
    file: "services/tools.js",
    find: "  return !messagesSpellingRequired({ config: ctx?.config, callerType: intakeTypeFor(fc?.args, ctx) });",
    replace: "  return false; // SABOTAGE",
    red: ["tests/intakeSpelling.test.js"],
  },
  {
    name: "readback-note-by-type",
    why: "Caller-experience Task 4: the read-back note's name letters ignore the caller type, so a lead who did not spell gets no spelled read-back and a personal caller who spelled gets one regardless of the business's setting. tests/spelledReadBackNote.test.js pins both.",
    file: "capabilities/messages.js",
    find: "    nameOn = lead ? ctx.callerSpelled === true || end : ctx.callerSpelled === true && everyone;",
    replace: "    nameOn = ctx.callerSpelled === true; // SABOTAGE",
    red: ["tests/spelledReadBackNote.test.js"],
  },
  {
    name: "spelling-nudge-follows-setting",
    why: "Caller-experience Task 4: the Live spelling nudge stops standing down for a message or callback call whose setting does not ask for a spelled name, so the model is told to ask for a spelling anyway. tests/intakeSpelling.test.js sends a take_message turn that hears the name and expects no nudge.",
    file: "lib/voice/live/index.js",
    find: "      !spellingOptionalForCall &&",
    replace: "",
    red: ["tests/intakeSpelling.test.js"],
  },
  {
    name: "healthcare-keeps-protocol",
    why: "Caller-experience Task 3: messageProtocol stops seeing the healthcare tier, so a hipaa business gets the new described protocol instead of today's checklist. tests/intakeProtocol.test.js pins the old text byte for byte.",
    file: "capabilities/messages.js",
    find: "function messageProtocol(cfg, config) {",
    replace: "function messageProtocol(cfg, config) { config = {}; // SABOTAGE",
    red: ["tests/intakeProtocol.test.js"],
  },
  {
    name: "reason-reask-cut",
    why: "Caller-experience Task 5: the reason-reask condition is negated, so a reason the caller gave is counted as a re-ask and one they did not give is not. tests/liveReasonReask.test.js pins both directions.",
    file: "lib/voice/live/index.js",
    find: "    if (state.reasonGiven !== true && pendingIntentArgs?.reason_given !== true) return false;",
    replace: "    if (state.reasonGiven === true || pendingIntentArgs?.reason_given === true) return false; // SABOTAGE",
    red: ["tests/liveReasonReask.test.js"],
  },
  {
    name: "outbound-reason-kind-off",
    why: "Caller-experience P25: the repeat ledger classifies a reason-style ask as the fixed reason kind on an outbound call too, so a phrasing with 'today' (never an ask before) is cut at the cap there. tests/liveReasonReask.test.js runs an outbound call that repeats it and expects no cut.",
    file: "lib/voice/live/index.js",
    find: "    reasonKind: () => !state.outboundCall && !isHealthcareTier(state.config),",
    replace: "    reasonKind: () => true, // SABOTAGE",
    red: ["tests/liveReasonReask.test.js"],
  },
  {
    name: "readback-check-name-aware",
    why: "Caller-experience fix round 1: the intake read-back counters count any run of capital letters again, so a business spelling its own name (or an acronym) in a scope turn reads as a read-back of the caller's details. tests/liveReadbackCheck.test.js asserts the intake counters stay 0 for both.",
    file: "lib/voice/live/index.js",
    find: "          (readsCallerContactBack(replyText, businessContacts) || nameVoicedIn(scope.name, replyText))",
    replace: "          (readsCallerContactBack(replyText, businessContacts) || Boolean(S.spelledLettersRe?.test(replyText))) // SABOTAGE",
    red: ["tests/liveReadbackCheck.test.js"],
  },
  {
    name: "reason-forgotten-after-save",
    why: "Caller-experience pre-review fix (P22 on the ledger path): the ledger keeps the reason need after a message is saved, so its cap cuts a reason ask about a new request. tests/liveReasonReask.test.js asks the reason twice, saves a message, and asks again.",
    file: "lib/voice/live/index.js",
    find: '        askLedger.forget("reason");',
    replace: "        // SABOTAGE",
    red: ["tests/liveReasonReask.test.js"],
  },
  {
    name: "goodbye-named-counter",
    why: "Caller-experience Task 6: the business-name check on an armed goodbye is negated, so a goodbye that says the name is not counted and a plain one is. tests/liveGoodbyeNamedBusiness.test.js pins both.",
    file: "lib/voice/live/index.js",
    find: "      if (saysBusinessName(replyText, state.config?.businessName)) {",
    replace: "      if (!saysBusinessName(replyText, state.config?.businessName)) { // SABOTAGE",
    red: ["tests/liveGoodbyeNamedBusiness.test.js"],
  },
  {
    name: "readback-check-counter",
    why: "Caller-experience Task 6: the read-back check is never tested, so every read-back in scope counts as unchecked. tests/liveReadbackCheck.test.js has a read-back that ends in a check and expects no readbacks_without_check.",
    file: "lib/voice/live/index.js",
    find: "          if (!readbackHasCheck(replyText, S.readbackCheckRe)) intakeAudit.readbacks_without_check += 1;",
    replace: "          intakeAudit.readbacks_without_check += 1; // SABOTAGE",
    red: ["tests/liveReadbackCheck.test.js"],
  },
  {
    name: "readback-spelled-same-turn",
    why: "S4-B5 (Caller-experience Task 6): spelled letters read back with the caller's details in the same turn as a message save stop counting as a spelled read-back, so readback_spelled_missing reads 1 again. tests/liveReadbackCheck.test.js reproduces the prod shape.",
    file: "lib/voice/live/index.js",
    find: '      if (save.rule === "message" && nameVoicedIn(save.name, replyText)) save.spelled = true;',
    replace: "      if (false) save.spelled = true; // SABOTAGE",
    red: ["tests/liveReadbackCheck.test.js"],
  },
  {
    name: "reason-final-clause",
    why: "Fix wave C1: the reason kind is tested on the whole sentence again, so a purpose clause in front of a different ask (so he knows what you are calling about, can I grab your name) reads as a reason ask and the name ask is cut. tests/askLedger.test.js and tests/liveReasonReask.test.js pin the lead-in sentences.",
    file: "lib/voice/askLedger.js",
    find: '    if (reasonKind && !tagged && REASON_ASK_RE.test(tail)) kinds.push("reason");',
    replace: '    if (reasonKind && !tagged && REASON_ASK_RE.test(sentence)) kinds.push("reason"); // SABOTAGE',
    red: ["tests/askLedger.test.js", "tests/liveReasonReask.test.js"],
  },
  {
    name: "reason-cut-honours-repeat",
    why: "Fix wave C1 step 5: the reason cut stops standing down for a caller who asked to hear it again, so a caller who says sorry and gets the ask repeated has it counted as a re-ask. tests/liveReasonReask.test.js says sorry before the ask.",
    file: "lib/voice/live/index.js",
    find: "    if (!flags.callerWantsRepeat && reasonAskedAgain(soFar)) {",
    replace: "    if (reasonAskedAgain(soFar)) { // SABOTAGE",
    red: ["tests/liveReasonReask.test.js"],
  },
  {
    name: "ask-seen-never-clears",
    why: "2026-11-16 cuts become counters: a repeated ask is counted (live_ask_repeat_seen) and never clears audio, because the transcript lags the audio and the cut landed after the caller heard it. Sabotaged, the count clears the audio again.",
    file: "lib/voice/live/index.js",
    find: '    bumpCounter("live_ask_repeat_seen");',
    replace: '    bumpCounter("live_ask_repeat_seen"); clearAudio(0); // SABOTAGE',
    red: ["tests/liveRepeatCut.test.js"],
  },
  {
    name: "reason-seen-never-clears",
    why: "2026-11-16 cuts become counters: a reason the caller gave, asked again, is counted (live_reason_reask_seen) on every tier and never clears audio. Sabotaged, the count clears the audio again.",
    file: "lib/voice/live/index.js",
    find: '      bumpCounter("live_reason_reask_seen");',
    replace: '      bumpCounter("live_reason_reask_seen"); clearAudio(0); // SABOTAGE',
    red: ["tests/liveReasonReask.test.js"],
  },
  {
    name: "across-seen-never-clears",
    why: "2026-11-16 cuts become counters: LVX78's across-turns restatement is counted (live_repeat_seen) and never clears audio. Sabotaged, the count clears the audio again.",
    file: "lib/voice/live/index.js",
    find: '      bumpCounter("live_repeat_seen");',
    replace: '      bumpCounter("live_repeat_seen"); clearAudio(0); // SABOTAGE',
    red: ["tests/liveRepeatCut.test.js"],
  },
  {
    name: "within-cut-after-across-seen",
    why: "2026-11-16 cuts become counters: counting an across-turns restatement must not stand the within-turn runaway cut down for the rest of the turn. Sabotaged, the count sets the cut latch, so a runaway after it is never cut.",
    file: "lib/voice/live/index.js",
    find: '      bumpCounter("live_repeat_seen");',
    replace: '      bumpCounter("live_repeat_seen"); repeatCutThisTurn = true; // SABOTAGE',
    red: ["tests/liveRepeatCut.test.js"],
  },
  {
    name: "hipaa-ledger-keeps-q-class",
    why: "Fix wave P29: the repeat ledger classifies a reason-style ask as the fixed reason kind on the healthcare tier, so the 'today' phrasing (never an ask before the round) is cut at the cap there. tests/liveReasonReask.test.js repeats it on a hipaa call.",
    file: "lib/voice/live/index.js",
    find: "    reasonKind: () => !state.outboundCall && !isHealthcareTier(state.config),",
    replace: "    reasonKind: () => !state.outboundCall, // SABOTAGE",
    red: ["tests/liveReasonReask.test.js"],
  },
  {
    name: "confirm-tag-each",
    why: "Fix wave I3b: a sentence ending in a confirmation tag is an ask again under confirm_style each, so 'So your surname is Daniel, right?' is a name ask the ledger cuts at the cap. tests/askLedger.test.js and tests/liveReasonReask.test.js pin it.",
    file: "lib/voice/askLedger.js",
    find: "    if (confirmTags && tagged) continue;",
    replace: "    // SABOTAGE",
    red: ["tests/askLedger.test.js", "tests/liveReasonReask.test.js"],
  },
  {
    name: "reason-asked-after-save-counted",
    why: "Fix wave M2: a reason asked after a message was saved is no longer counted, so reason_reasked 0 vouches for a phase it cannot see. tests/liveReasonReask.test.js reads intake.reason_asked_after_save.",
    file: "lib/voice/live/index.js",
    find: "      else if (messagesRecordedThisCall > 0 && reasonAskIn(replyText)) intakeAudit.reason_asked_after_save += 1;",
    replace: "      // SABOTAGE",
    red: ["tests/liveReasonReask.test.js"],
  },
  {
    name: "batch-type-at-save",
    why: "Fix wave I1: the tool runner's context stops preferring a caller type reported earlier in the same batch, so a save made with it reads the stale call state and a friend gets the lead read-back. tests/liveSaveCallerType.test.js sends [set_call_intent personal, save].",
    file: "lib/voice/live/tools.js",
    find: "        callerType: intakeTypeFor(intentArgs, { callerType: state.callerType }),",
    replace: '        callerType: typeof state.callerType === "string" ? state.callerType : null, // SABOTAGE',
    red: ["tests/liveSaveCallerType.test.js"],
  },
  {
    name: "turnstate-reads-pending-type",
    why: "Fix wave I1: turnState stops reading the type reported earlier in the turn (still pending), so a save in a later call of the same turn sees null. tests/liveSaveCallerType.test.js reports the type in one call and saves in the next.",
    file: "lib/voice/live/index.js",
    find: "    callerType: intakeTypeFor(pendingIntentArgs, state),",
    replace: "    callerType: state.callerType ?? null, // SABOTAGE",
    red: ["tests/liveSaveCallerType.test.js"],
  },
  {
    name: "other-reads-like-null",
    why: "Fix wave I1: an unclear (other) caller type is no longer read as a new enquiry by the read-back note, so a save with that type gets no spelled read-back. tests/liveSaveCallerType.test.js saves under other.",
    file: "capabilities/messages.js",
    find: "    const lead = LEAD_LIKE.has(decisionTypeOf(intakeTypeFor(args, ctx)));",
    replace: '    const lead = LEAD_LIKE.has(intakeTypeFor(args, ctx) ?? "new_enquiry"); // SABOTAGE',
    red: ["tests/liveSaveCallerType.test.js"],
  },
  {
    name: "other-reads-like-null-gate",
    why: "Fix wave I1: the leads spelling gate stops reading an unclear (other) type as a new enquiry. tests/intakeSettings.test.js pins the gate for other.",
    file: "lib/capabilities/intakeSettings.js",
    find: '  if (v === "leads") return LEAD_LIKE.has(decisionTypeOf(callerType));',
    replace: '  if (v === "leads") return LEAD_LIKE.has(callerType ?? "new_enquiry"); // SABOTAGE',
    red: ["tests/intakeSettings.test.js"],
  },
  {
    name: "intent-args-merge-turn",
    why: "Fix wave M4: two set_call_intent calls in different tool rounds of one turn keep only the last arguments again, so a reason_given or caller_type reported on the first and omitted on the second is lost. tests/liveSaveCallerType.test.js reports both and reads the call state.",
    file: "lib/voice/live/index.js",
    find: "    if (out.intentArgs) pendingIntentArgs = mergeIntentArgs(pendingIntentArgs, out.intentArgs);",
    replace: "    if (out.intentArgs) pendingIntentArgs = out.intentArgs; // SABOTAGE",
    red: ["tests/liveSaveCallerType.test.js"],
  },
  {
    name: "intent-args-merge-batch",
    why: "Fix wave M4: two set_call_intent calls in one batch keep only the last arguments again. tests/liveSaveCallerType.test.js sends both in one batch.",
    file: "lib/voice/live/tools.js",
    find: '      if ("intentArgs" in effects) intentArgs = mergeIntentArgs(intentArgs, effects.intentArgs);',
    replace: '      if ("intentArgs" in effects) intentArgs = effects.intentArgs; // SABOTAGE',
    red: ["tests/liveSaveCallerType.test.js"],
  },
  {
    name: "nudge-name-gated-intents",
    why: "Fix wave I4: the Live spelling nudge stops treating a booking, lookup, cancel or quote as an intent whose gate holds a name, so with the default setting it stands down for them too and a booking caller is never nudged to spell. tests/intakeSpelling.test.js sends a booking, a quote, a lookup and a cancel.",
    file: "lib/voice/live/index.js",
    find: "      !NAME_GATED_INTENTS.has(turnIntent) &&",
    replace: "      true && // SABOTAGE",
    red: ["tests/intakeSpelling.test.js"],
  },
  {
    name: "nudge-intent-agnostic",
    why: "Fix wave I4: the nudge stands down only for take_message and callback_request again, so a transfer that fell back to a message, a plain question or a call with no intent reported is nudged to spell on a business that never asked. tests/intakeSpelling.test.js sends each.",
    file: "lib/voice/live/index.js",
    find: "      !NAME_GATED_INTENTS.has(turnIntent) &&",
    replace: '      (turnIntent === "take_message" || turnIntent === "callback_request") && // SABOTAGE',
    red: ["tests/intakeSpelling.test.js"],
  },
  {
    name: "tool-description-standard",
    why: "Fix wave I5: the standard tier gets the old record_customer_request description again (after collecting the name, callback number and message), which Live reads every turn and which drives a number ask the protocol forbids. tests/intakeToolDescription.test.js reads it on both tiers.",
    file: "capabilities/messages.js",
    find: "    const declaration = isHealthcareTier(config)",
    replace: "    const declaration = true // SABOTAGE",
    red: ["tests/intakeToolDescription.test.js"],
  },
  {
    name: "closed-hours-take-message-standard",
    why: "Fix wave I6: the closed-hours take_message line tells the standard tier to collect name, number and message again. tests/intakeClosedHours.test.js renders at closed hours.",
    file: "services/gemini.js",
    find: "        afterHours += !isHealthcareTier(config)",
    replace: "        afterHours += isHealthcareTier(config) || true // SABOTAGE",
    red: ["tests/intakeClosedHours.test.js"],
  },
  {
    name: "closed-hours-callback-standard",
    why: "Fix wave I6: the closed-hours offer_callback line puts the ordered name-then-number asks back on the standard tier. tests/intakeClosedHours.test.js renders at closed hours.",
    file: "services/gemini.js",
    find: "        afterHours += isHealthcareTier(config)",
    replace: "        afterHours += isHealthcareTier(config) || true // SABOTAGE",
    red: ["tests/intakeClosedHours.test.js"],
  },
  {
    name: "protocol-questions-line-needs-notes",
    why: "Fix wave M8a: the business-questions protocol line renders for every business again, not only when the messages pack has notes. tests/intakeProtocol.test.js renders with none.",
    file: "capabilities/messages.js",
    find: "  if (hasMessageNotes(config)) {",
    replace: "  if (true) { // SABOTAGE",
    red: ["tests/intakeProtocol.test.js"],
  },
  {
    name: "protocol-no-set-caller-type-line",
    why: "Fix wave M8b: the protocol repeats 'Set caller_type whenever you can tell' again (the parameter description already says it). tests/intakeProtocol.test.js forbids it.",
    file: "capabilities/messages.js",
    find: "      ` plus a number if theirs did not come through.`",
    replace: "      ` plus a number if theirs did not come through. Set caller_type whenever you can tell.`",
    red: ["tests/intakeProtocol.test.js"],
  },
  {
    name: "end-read-back-says-which-number",
    why: "Fix wave M1: END_READ_BACK stops saying they will be called back on the number they are calling from and can give another. tests/intakeProtocol.test.js and tests/intakePath.test.js read it.",
    file: "lib/voice/intakePath.js",
    find: '  "the preferred time if given, and a one-line reason; when their own number came through, say they will be called back " +',
    replace: '  "the preferred time if given, and a one-line reason; " + // SABOTAGE',
    red: ["tests/intakeProtocol.test.js", "tests/intakePath.test.js"],
  },
  {
    name: "path-note-defers-to-notes",
    why: "Fix wave I3a: the path note's absolute lines (a friend's first name and message only, no number ask) stop deferring to the business's own notes. tests/intakePath.test.js renders with a notes config.",
    file: "lib/voice/intakePath.js",
    find: "  const notes = hasMessageNotes(config);",
    replace: "  const notes = false; // SABOTAGE",
    red: ["tests/intakePath.test.js"],
  },
  {
    name: "other-note-no-greeting-repeat",
    why: "Fix wave M6: the unclear-type note tells the model to ask one open question about how it can help, which repeats the greeting's own question. tests/intakePath.test.js forbids it.",
    file: "lib/voice/intakePath.js",
    find: "so do not ask that again: acknowledge them and ask what it concerns in your own words",
    replace: "Ask one open question about how you can help",
    red: ["tests/intakePath.test.js"],
  },
  {
    name: "readback-surname-only",
    why: "Fix wave I7 / P27: the read-back note spells every word of an unspelled name again, so a lead hears both names spelled instead of the surname only. tests/spelledReadBackNote.test.js and tests/liveSpelledReadBack.test.js pin the surname.",
    file: "capabilities/messages.js",
    find: "  const spellWords = surnameOnly ? nameWordsOf.slice(-1) : nameWordsOf;",
    replace: "  const spellWords = nameWordsOf; // SABOTAGE",
    red: ["tests/spelledReadBackNote.test.js"],
  },
  {
    name: "readback-on-file-no-letters",
    why: "Fix wave I7 / P27: a name confirmed on file that the caller did not spell is spelled back again. tests/spelledReadBackNote.test.js gives a caller context that holds the name.",
    file: "capabilities/messages.js",
    find: "      if (nameIsOnFile(name, ctx.callerContext)) nameOn = false;",
    replace: "      // SABOTAGE",
    red: ["tests/spelledReadBackNote.test.js"],
  },
  {
    name: "readback-deferred-for-leads",
    why: "Fix wave I8 / P28: the read-back is handed at the first save again, so a lead at a business with its own questions hears one read-back before the questions and another after. tests/spelledReadBackNote.test.js and tests/liveSpelledReadBack.test.js save before any answer.",
    file: "capabilities/messages.js",
    find: "    const deferReadBack =",
    replace: "    const deferReadBack = false && // SABOTAGE",
    red: ["tests/spelledReadBackNote.test.js", "tests/liveSpelledReadBack.test.js"],
  },
  {
    name: "readback-defer-leads-only",
    why: "Fix wave I8 / P28: the deferral stops being limited to leads, so an existing client at a notes business has the read-back held back too. tests/spelledReadBackNote.test.js saves as an existing client.",
    file: "capabilities/messages.js",
    find: "      questionsAreFor(args, ctx);",
    replace: "      true; // SABOTAGE",
    red: ["tests/spelledReadBackNote.test.js", "tests/liveSpelledReadBack.test.js"],
  },
  {
    name: "readback-check-hears-spelling-en",
    why: "Fix wave M9: the English read-back check stops hearing 'Did I spell that correctly?', so a spelled read-back that ends that way counts as unchecked. tests/liveReadbackCheck.test.js pins it.",
    file: "lib/voice/strings.js",
    find: String.raw`|\b(?:did|have)\s+i\s+(?:spell|spelled|write|written|wrote|get|got|take|taken|note|noted|put)\s+(?:down\s+)?(?:that|it|this|the\s+spelling|your\s+\w+)\s+(?:down\s+)?(?:right|correctly|properly)\b`,
    replace: "",
    red: ["tests/liveReadbackCheck.test.js"],
  },
  {
    name: "readback-check-hears-spelling-es",
    why: "Fix wave M9: the Spanish read-back check stops hearing 'Lo he anotado bien'. tests/liveReadbackCheck.test.js pins it.",
    file: "lib/voice/strings.js",
    find: String.raw`\blo\s+(?:tengo|he\s+(?:anotado|escrito|entendido))\s+bien\b`,
    replace: String.raw`\blo\s+tengo\s+bien\b`,
    red: ["tests/liveReadbackCheck.test.js"],
  },
  {
    name: "hipaa-gate-holds",
    why: "Fix wave M10: messagesSpellingRequired stops returning true for the healthcare tier, so a hipaa message save is judged by the spelling setting and a caller type instead of by the gate as it always was. tests/intakeSpelling.test.js pins it.",
    file: "lib/capabilities/intakeSettings.js",
    find: "  if (isHealthcareTier(config)) return true;",
    replace: "  // SABOTAGE",
    red: ["tests/intakeSpelling.test.js"],
  },
  {
    name: "reason-alt3-clause-start",
    why: "Fix wave P32 N1: 'what you're calling about' counts anywhere in the clause again, so a purpose clause after a name ask (so he knows what you're calling about) reads as a reason ask and the name ask is cut. tests/askLedger.test.js and tests/liveReasonReask.test.js pin the probes.",
    file: "lib/voice/askLedger.js",
    find: String.raw`|(?:^\W*(?:(?:and|so|okay|ok|sure|great|alright|now|then|well)\W+)*|\b(?:let\s+me\s+know|tell\s+me|(?:may|could|can)\s+i\s+ask|i'?d\s+(?:like|love)\s+to\s+know|i\s+(?:need|want)\s+to\s+know)\s+)what\s+(`,
    replace: String.raw`|\bwhat\s+(`,
    red: ["tests/askLedger.test.js", "tests/liveReasonReask.test.js"],
  },
  {
    name: "defer-first-save-only",
    why: "Fix wave P32 N2: the read-back deferral fires on every save without answers again, so a correction re-save never hands the corrected letters. tests/spelledReadBackNote.test.js and tests/liveSpelledReadBack.test.js re-save.",
    file: "capabilities/messages.js",
    find: "      ctx?.capabilityState?.messages?.firstSaveDone !== true &&",
    replace: "      true && // SABOTAGE",
    red: ["tests/spelledReadBackNote.test.js", "tests/liveSpelledReadBack.test.js"],
  },
  {
    name: "defer-needs-question-notes",
    why: "Fix wave P32 N2: the deferral applies to rules-only notes again, so the letters are deferred for good when no later save comes. tests/spelledReadBackNote.test.js uses rules-only notes.",
    file: "capabilities/messages.js",
    find: String.raw`      /\?|\bask\b/i.test(notes) &&`,
    replace: "      true && // SABOTAGE",
    red: ["tests/spelledReadBackNote.test.js"],
  },
  {
    name: "withheld-number-first",
    why: "Fix wave P32 N3: a withheld caller's number note goes after the business questions again, so a lead who hangs up during them leaves no way to call back. tests/spelledReadBackNote.test.js pins the order.",
    file: "capabilities/messages.js",
    find: "        ? [needsNumber ? NO_NUMBER_NOTE : null, scopedNote(NEXT_QUESTIONS_NOTE_DEFERRED, ctx?.config)]",
    replace: "        ? [scopedNote(NEXT_QUESTIONS_NOTE_DEFERRED, ctx?.config), needsNumber ? NO_NUMBER_NOTE : null] // SABOTAGE",
    red: ["tests/spelledReadBackNote.test.js"],
  },
  {
    name: "end-read-back-own-number-only",
    why: "Fix wave P32 m2: END_READ_BACK says unconditionally that they will be called back on the number they are calling from, wrong for a withheld caller. tests/intakePath.test.js pins the condition.",
    file: "lib/voice/intakePath.js",
    find: "when their own number came through, say they",
    replace: "say they",
    red: ["tests/intakePath.test.js"],
  },
  {
    name: "lead-number-fact-form",
    why: "Fix wave P32 m2: the lead path note says 'tell them' again in the set_call_intent reply, so a lead hears it early and again in the read-back. tests/intakePath.test.js pins the fact form for leads.",
    file: "lib/voice/intakePath.js",
    find: "  const leadNumberLine = numberLineFor(false);",
    replace: "  const leadNumberLine = numberLineFor(true); // SABOTAGE",
    red: ["tests/intakePath.test.js"],
  },
  {
    name: "repeat-run-spelled-word-one-token",
    why: "Hotfix 2026-11-15: longestSharedRun merges hyphen/dot-joined single letters into one token before punctuation is stripped. Without it a spelled surname closes into the next word ('R-A-M-A-N, a' reads 'ramana'), and the spelled surname plus the email carrying it is again read as a repeat. tests/liveRepeatedPhrase.test.js pins it.",
    file: "lib/transcriptUtils.js",
    find: "        .replace(SPELLED_PUNCTUATED_RE, (m) => m.replace(/[^a-z]/g, \"\"))",
    replace: "        // SABOTAGE: spelled letters no longer merged before punctuation is stripped",
    red: ["tests/liveRepeatedPhrase.test.js"],
  },
  {
    name: "aftercall-writes",
    why: "Message-owed round: finish() no longer writes the after-call message, so a lead who hangs up mid-intake leaves the owner nothing. tests/messageAfterCall.test.js drives the hang-up.",
    file: "lib/voice/live/index.js",
    find: "      .then(() => saveOwedMessage())",
    replace: "      .then(() => undefined) // SABOTAGE",
    red: ["tests/messageAfterCall.test.js"],
  },
  {
    name: "aftercall-on-end-call",
    why: "Message-owed round: a call the receptionist ends with end_call is treated as a close that owes nothing, so the message is lost on exactly the calls that end politely. tests/messageAfterCall.test.js ends the call with end_call.",
    file: "lib/voice/live/index.js",
    find: "      toolsAttempted: [...refusedToolsThisCall, ...completedToolsThisCall],",
    replace: "      toolsAttempted: [...refusedToolsThisCall, ...completedToolsThisCall, ...(endCallArmed ? [\"end_call\"] : [])], // SABOTAGE",
    red: ["tests/messageAfterCall.test.js"],
  },
  {
    name: "aftercall-not-twice",
    why: "Message-owed round: the owed write no longer re-checks that a message was saved, so a call that saved one also gets a second row. tests/messageAfterCall.test.js saves first, then hangs up.",
    file: "lib/voice/live/index.js",
    find: "      messagesRecorded: messagesRecordedThisCall, // read now, after the last chance settled",
    replace: "      messagesRecorded: 0, // SABOTAGE",
    red: ["tests/messageAfterCall.test.js"],
  },
  {
    name: "aftercall-hipaa-off",
    why: "Message-owed round: the healthcare tier is no longer excluded, so caller speech on a HIPAA business is written into a message. tests/messageAfterCall.test.js has a healthcare-tier call.",
    file: "lib/voice/live/index.js",
    find: "      healthcare: isHealthcareTier(state.config) || hipaa,",
    replace: "      healthcare: false, // SABOTAGE",
    red: ["tests/messageAfterCall.test.js"],
  },
  {
    name: "aftercall-declined-off",
    why: "Message-owed round: a caller who withdrew the message (\"Never mind. I'm done.\") still gets one written. tests/messageOwed.test.js and tests/messageAfterCall.test.js pin the decline.",
    file: "lib/voice/messageOwed.js",
    find: "  if (callerDeclined(worded[worded.length - 1])) return false;",
    replace: "  // SABOTAGE: the decline check is gone",
    red: ["tests/messageOwed.test.js", "tests/messageAfterCall.test.js"],
  },
  {
    name: "aftercall-seller-default-off",
    why: "Message-owed round: a sales caller leaves a message even where the business has no seller rule of its own, so the owner is emailed about every cold call. tests/messageAfterCall.test.js has a seller on a business with no rule.",
    file: "lib/voice/live/index.js",
    find: "      sellerRule: businessHandlesSellerCalls(state.config),",
    replace: "      sellerRule: true, // SABOTAGE",
    red: ["tests/messageAfterCall.test.js"],
  },
  {
    name: "aftercall-before-verify",
    why: "Message-owed round: the post-call read no longer waits for the owed write, so it reads messagesRecorded 0 and files a false \"a message was owed\" alarm over a message that was saved. tests/messageAfterCall.test.js reads verify's inputs.",
    file: "lib/voice/live/index.js",
    find: "      Promise.all([whenTranscriptSettled(), lastChanceSettled])",
    replace: "      Promise.all([whenTranscriptSettled()]) // SABOTAGE",
    red: ["tests/messageAfterCall.test.js"],
  },
  {
    name: "lastchance-consent-exempt",
    why: "Fix round 1 (B14): the close-time message write is refused by the older consent cascade whenever caller words are still in flight at the hang-up. tests/liveWriteConsent.test.js and tests/messageAfterCall.test.js (real gates) pin the exemption.",
    file: "services/tools.js",
    find: "            ctx?.lastChance === true && fc.name === \"record_customer_request\" && !isHealthcareTier(ctx?.config);",
    replace: "            false; // SABOTAGE",
    red: ["tests/liveWriteConsent.test.js", "tests/messageAfterCall.test.js"],
  },
  {
    name: "lastchance-requirements-exempt",
    why: "Fix round 1 (B15): the close-time message write is refused by required identity / fields / confirmBeforeWrite, which cannot be collected after the call. tests/requirements.test.js and tests/messageAfterCall.test.js (real gates) pin the exemption.",
    file: "services/tools.js",
    find: "            !isHealthcareTier(ctx?.config) && ctx?.lastChance === true && fc.name === \"record_customer_request\"",
    replace: "            false // SABOTAGE",
    red: ["tests/requirements.test.js", "tests/messageAfterCall.test.js"],
  },
  {
    name: "aftercall-real-gate",
    why: "Fix round 1: the owed write no longer goes out as the last chance, so the real gates (consent, requirements, spelling) judge it like an in-call save and refuse it. tests/messageAfterCall.test.js asserts lastChance on the write and runs the real gates.",
    file: "lib/voice/live/index.js",
    find: "      lastChanceWrite = true; // the owed write also writes as the last chance",
    replace: "      lastChanceWrite = false; // SABOTAGE",
    red: ["tests/messageAfterCall.test.js"],
  },
  {
    name: "aftercall-keeps-claim-alert",
    why: "Fix wave C1: the after-call message is counted as a message that explains an unbacked completion claim, so verify returns ok and the owner never gets the 'Follow-up needed' alert. tests/postCallVerify.test.js pins claim_without_row.",
    file: "lib/postCallVerify.js",
    find: "  const messageExplainsClaims = Number(messagesRecorded) - (Number(afterCallMessages) || 0) > 0 && !appointmentToolAttempted && !bookingAgreed;",
    replace: "  const messageExplainsClaims = Number(messagesRecorded) > 0 && !appointmentToolAttempted && !bookingAgreed; // SABOTAGE",
    red: ["tests/postCallVerify.test.js"],
  },
  {
    name: "aftercall-verify-input",
    why: "Fix wave C1: finish() no longer tells verify how many messages were the after-call one. tests/messageAfterCall.test.js reads verify's inputs.",
    file: "lib/voice/live/index.js",
    find: "        afterCallMessages: afterCallMessagesSaved,",
    replace: "        afterCallMessages: 0, // SABOTAGE",
    red: ["tests/messageAfterCall.test.js"],
  },
  {
    name: "lastchance-hesitation-exempt",
    why: "Fix wave I1/B17: a hesitation or unreadable word in flight refuses the close-time message write again. tests/liveWriteConsent.test.js (real executeToolCall) and tests/messageAfterCall.test.js (real gates) pin the exemption.",
    file: "services/tools.js",
    find: "              (a1Save.applies && a1Save.rule === \"message\") || closeTimeMessage",
    replace: "              (a1Save.applies && a1Save.rule === \"message\") // SABOTAGE",
    red: ["tests/liveWriteConsent.test.js", "tests/messageAfterCall.test.js"],
  },
  {
    name: "aftercall-handoff-off",
    why: "Fix wave I2/B18: a transfer still in flight no longer counts as a transfer, so a caller put through to a person gets a false owed message. tests/messageAfterCallHandoff.test.js stops the stream during the redirect.",
    file: "lib/voice/live/index.js",
    find: "      transferStarted: transferStartedThisCall || transferInFlight,",
    replace: "      transferStarted: transferStartedThisCall, // SABOTAGE",
    red: ["tests/messageAfterCallHandoff.test.js"],
  },
  {
    name: "aftercall-polite-failure-off",
    why: "Fix wave I2/B18: the voicemail hand-off no longer stands the owed write down, so one call files a false owed message and the real voicemail. tests/messageAfterCallHandoff.test.js closes the vendor socket.",
    file: "lib/voice/live/index.js",
    find: "    if (politeFailureSent) return;",
    replace: "    // SABOTAGE",
    red: ["tests/messageAfterCallHandoff.test.js"],
  },
  {
    name: "aftercall-appointment-flow-off",
    why: "Fix wave I3/B19: a read-only appointment call (a lookup, an availability check) is owed a message again, a false alarm on every such call. tests/messageOwed.test.js and tests/messageAfterCallHandoff.test.js pin it.",
    file: "lib/voice/messageOwed.js",
    find: "  if (f.appointmentToolCalled === true && f.takeIntent !== true) return false;",
    replace: "  // SABOTAGE",
    red: ["tests/messageOwed.test.js", "tests/messageAfterCallHandoff.test.js"],
  },
  {
    name: "aftercall-seller-needs-promise",
    why: "Fix wave I4/B20: a seller whose pitch the receptionist declined per the business's own rule is owed a message again, so the owner is emailed the pitch. tests/messageOwed.test.js and tests/messageAfterCall.test.js pin the promise.",
    file: "lib/voice/messageOwed.js",
    find: "f.sellerRule === true && f.assistantPromised === true;",
    replace: "f.sellerRule === true; // SABOTAGE",
    red: ["tests/messageOwed.test.js", "tests/messageAfterCall.test.js"],
  },
  {
    name: "lastchance-healthcare-unchanged",
    why: "Fix wave I5/B23: a healthcare tenant's close-time message is exempt from the consent gates, a path change for the healthcare tier. tests/liveWriteConsent.test.js pins that it is still refused.",
    file: "services/tools.js",
    find: "            ctx?.lastChance === true && fc.name === \"record_customer_request\" && !isHealthcareTier(ctx?.config);",
    replace: "            ctx?.lastChance === true && fc.name === \"record_customer_request\"; // SABOTAGE",
    red: ["tests/liveWriteConsent.test.js"],
  },
  {
    name: "lastchance-requirements-healthcare-unchanged",
    why: "Fix wave I5/B23: a healthcare tenant's close-time message skips its required identity fields, a path change for the healthcare tier. tests/requirements.test.js pins that they are still required.",
    file: "services/tools.js",
    find: "            !isHealthcareTier(ctx?.config) && ctx?.lastChance === true && fc.name === \"record_customer_request\"",
    replace: "            ctx?.lastChance === true && fc.name === \"record_customer_request\" // SABOTAGE",
    red: ["tests/requirements.test.js"],
  },
  {
    name: "aftercall-hipaa-deployment-off",
    why: "Fix wave M4/B23: a hipaa DEPLOYMENT is no longer excluded, so caller words land in customer_requests where transcripts are refused. tests/messageAfterCall.test.js boots DEPLOYMENT_MODE=hipaa.",
    file: "lib/voice/live/index.js",
    find: "      healthcare: isHealthcareTier(state.config) || hipaa,",
    replace: "      healthcare: isHealthcareTier(state.config), // SABOTAGE",
    red: ["tests/messageAfterCall.test.js"],
  },
  {
    name: "decline-contact-veto",
    why: "Fix wave M2/B24: a decline that asks in the same breath to be called, told or passed on is read as a decline again, losing the lead. tests/messageOwed.test.js pins four such sentences.",
    file: "lib/voice/messageOwed.js",
    find: "typeof lastUtterance === \"string\" && DECLINE_RE.test(lastUtterance) && !CONTACT_WANTED_RE.test(lastUtterance)",
    replace: "typeof lastUtterance === \"string\" && DECLINE_RE.test(lastUtterance) // SABOTAGE",
    red: ["tests/messageOwed.test.js"],
  },
  {
    name: "aftercall-message-sentence",
    why: "Fix wave B21: the message says 'They left before the message was finished' again, which is false for a caller who simply asked a question. tests/messageOwed.test.js pins the neutral sentence.",
    file: "lib/voice/messageOwed.js",
    find: "No full message was left on the call.",
    replace: "They left before the message was finished.",
    red: ["tests/messageOwed.test.js"],
  },
  {
    name: "aftercall-no-caller-sms",
    why: "Fix wave M3: the owed write's effect texts the caller 'we got your message' when SMS is on. tests/customerRequestCorrection.test.js pins that the marked effect sends no caller text.",
    file: "capabilities/messages.js",
    find: "party.verified && effect.afterCall !== true",
    replace: "party.verified /* SABOTAGE */",
    red: ["tests/customerRequestCorrection.test.js"],
  },
  {
    name: "aftercall-reason-gates",
    why: "Fix wave M6: the refusal log's closed reason loses the hesitation gate, so it logs 'refused' like an execution failure. tests/messageAfterCall.test.js forces a hesitation refusal.",
    file: "lib/voice/live/index.js",
    find: "[\"consent\", \"write_order\", \"spelling\", \"hesitation\", \"unusable\", \"requirements\"];",
    replace: "[\"consent\", \"write_order\", \"spelling\"]; // SABOTAGE",
    red: ["tests/messageAfterCall.test.js"],
  },
  {
    name: "aftercall-filler-counts",
    why: "Fix wave M8: 'Um' / 'Hmm' alone count as the caller speaking and appear in the message. tests/messageOwed.test.js and tests/messageAfterCall.test.js pin it.",
    file: "lib/voice/messageOwed.js",
    find: "/\\p{L}{2,}/u.test(text) && !isHesitationOnly(text)",
    replace: "/\\p{L}{2,}/u.test(text) // SABOTAGE",
    red: ["tests/messageOwed.test.js"],
  },
  // ---------------------------------------------------------------------------
  // Hammersleys round 5 (2026-11-26).
  // ---------------------------------------------------------------------------
  {
    name: "r5-save-reply-already-asked",
    why: "Round 5 Task 1: a save made right after the model asked its next question says 'ask them now' again, so Live asks the question twice. tests/alreadyAskedThisTurn.test.js and tests/liveToolWords.test.js read the reply's next.",
    file: "capabilities/messages.js",
    find: "      replyEndsWithQuestion(ctx?.inTurnReplyText) &&\n      !readBack &&",
    replace: "      false /* SABOTAGE */ &&\n      !readBack &&",
    red: ["tests/alreadyAskedThisTurn.test.js", "tests/liveToolWords.test.js"],
  },
  {
    name: "r5-intent-reply-already-asked",
    why: "Round 5 Task 1: set_call_intent sends the intake path note ('ask ...') after the model already asked, so the question is asked twice. tests/alreadyAskedThisTurn.test.js reads the reply's next.",
    file: "services/tools.js",
    find: "const alreadyAsked = Boolean(pathNote) && replyEndsWithQuestion(ctx?.inTurnReplyText);",
    replace: "const alreadyAsked = false; /* SABOTAGE */",
    red: ["tests/alreadyAskedThisTurn.test.js"],
  },
  {
    name: "r5-tool-words-logged",
    why: "Round 5 Task 1a (R45): the words-at-the-call instrument stops, so the owner's calls cannot show whether the question's words arrived before the save. tests/liveToolWords.test.js reads the log and counters.",
    file: "lib/voice/live/index.js",
    find: "    noteToolWords(toolCall);\n",
    replace: "",
    red: ["tests/liveToolWords.test.js"],
  },
  {
    name: "r5-name-owed",
    why: "Round 5 Task 2 (owner call 3): a name the caller gave that no save carries stops counting as unsaved, so the call closes and the email says 'not given'. tests/liveSaveGuard.test.js 'round 5: name owed'.",
    file: "lib/voice/live/index.js",
    find: "+ (openUnsaved ? 1 : 0) + nameOwed();",
    replace: "+ (openUnsaved ? 1 : 0) + 0; /* SABOTAGE */",
    red: ["tests/liveSaveGuard.test.js"],
  },
  {
    name: "r5-say-back-unheard",
    why: "Round 5 Task 5 (owner call 4): the save reply stops asking for a say-back of details the caller never heard, so a misheard opener street goes into the email uncorrected. tests/messagesSayBack.test.js reads next.",
    file: "capabilities/messages.js",
    find: "[sayBack.length ? sayBackNote(sayBack) : null, readBack,",
    replace: "[null /* SABOTAGE */, readBack,",
    red: ["tests/messagesSayBack.test.js"],
  },
  {
    name: "r5-say-back-added-only",
    why: "Round 5 Task 5: a detail an earlier save already carried is listed for say-back again on every later save (a recap the owner ruled out, R26). tests/messagesSayBack.test.js 'not listed again'.",
    file: "capabilities/messages.js",
    find: "    if (prior.has(label.trim().toLowerCase()) && !owed.has(label.trim().toLowerCase())) continue;\n",
    replace: "",
    red: ["tests/messagesSayBack.test.js"],
  },
  {
    name: "r5-say-back-owed",
    why: "Sim r5-sayback-1: a say-back put off because the turn ended with a question is never made, so the opener's destination and time are never said back. tests/messagesSayBack.test.js 'owed'.",
    file: "capabilities/messages.js",
    find: "      sayBackOwed = [...new Set([...priorOwed, ...addedLabels])];",
    replace: "      sayBackOwed = priorOwed; /* SABOTAGE */",
    red: ["tests/messagesSayBack.test.js"],
  },
  {
    name: "r5-sim-harness-turn-words",
    why: "Round 5 instrument fix: the text-sim harness stops giving the tool replies the turn's words and what was said, so every Live-only reply (already asked, say-back, intake path) silently vanishes from the sims. tests/liveTextSession.test.js.",
    file: "lib/harness/liveTextSession.js",
    find: "    inTurnReplyText: turnText,\n",
    replace: "",
    red: ["tests/liveTextSession.test.js"],
  },
  {
    name: "r5-repeat-hold-new-clause-plays",
    why: "Scoped re-review 3: the old question with a new clause ('...and how many suitcases?') is dropped whole, so the new question is never heard. tests/liveRepeatHold.test.js 're-review 3'.",
    file: "lib/voice/live/index.js",
    find: "      if (holdWordsOf(h.post).length - end > REPEAT_HOLD_TAIL_WORDS) {",
    replace: "      if (false /* SABOTAGE */) {",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-repeat-hold-drops-copy",
    why: "Round 5 Task 3 (owner call 2, R43): the repeat hold no longer drops a continuation that asks the question again, so the caller hears it twice. tests/liveRepeatHold.test.js asserts no media reaches Twilio.",
    file: "lib/voice/live/index.js",
    find: "    const end = repeatEndIn(h.question, h.post);",
    replace: "    const end = -1; /* SABOTAGE */",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-repeat-hold-not-on-statement",
    why: "Round 5 Task 3: the hold arms on any tool call the model spoke before, so a statement -> save -> question waits for words on the normal path. tests/liveRepeatHold.test.js 'statement, save, question: not held'.",
    file: "lib/voice/live/index.js",
    find: "    if (modelAudioTurnSeq !== turnSeq || !replyEndsWithQuestion(turnReplyText)) return;",
    replace: "    if (modelAudioTurnSeq !== turnSeq) return; /* SABOTAGE */",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-repeat-hold-kill-switch",
    why: "Round 5 Task 3: LIVE_REPEAT_HOLD=off stops disabling the hold, so the kill switch does nothing. tests/liveRepeatHold.test.js 'LIVE_REPEAT_HOLD=off'.",
    file: "lib/voice/live/index.js",
    find: "    if (repeatHoldOff || state.outboundCall || dialFirstSeconds || liveFirstLine) return;",
    replace: "    if (state.outboundCall || dialFirstSeconds || liveFirstLine) return; /* SABOTAGE */",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-repeat-hold-cap",
    why: "Round 5 Task 3: kept audio with no decision is never played (the 1.5 s cap is gone), so a reply whose words lag is silence. tests/liveRepeatHold.test.js 'no words within 1.5 s: played'.",
    file: "lib/voice/live/index.js",
    find: "      if (repeatHold.state === \"holding\" && atMs - repeatHold.startedAtMs >= REPEAT_HOLD_MAX_MS) releaseRepeatHold(\"timeout\");",
    replace: "      if (false /* SABOTAGE */) releaseRepeatHold(\"timeout\");",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-umm-dg-filler-holds",
    why: "Round 5 Task 4 (owner call 3, R46): Deepgram's 'Ahm' no longer holds the reply while Live's own transcript is late, so the receptionist answers a caller who is thinking. tests/liveUmmDeepgram.test.js.",
    file: "lib/voice/live/index.js",
    find: "    if (dg === null) return skipUmm(\"empty\");",
    replace: "    if (dg === null || dg === \"filler\") return skipUmm(\"empty\"); /* SABOTAGE */",
    red: ["tests/liveUmmDeepgram.test.js"],
  },
  {
    name: "r5-umm-dg-words-pass",
    why: "Round 5 Task 4: Deepgram's words ('Two.', 'Mm-mm.') stop counting as an answer, so a real short answer is held as thinking. tests/liveUmmDeepgram.test.js.",
    file: "lib/voice/live/index.js",
    find: "      if (DG_ANSWER_HUM_RE.test(t) || !isHesitationOnly(t)) return \"words\";",
    replace: "      if (false) return \"words\"; /* SABOTAGE */",
    red: ["tests/liveUmmDeepgram.test.js"],
  },
  {
    name: "r5-umm-dg-wait-capped",
    why: "Round 5 Task 4: a pending hold (Deepgram has nothing yet) never becomes a hesitation at 700 ms, so it is never settled by the round-4 rules. tests/liveUmmDeepgram.test.js 'nothing by 700 ms'.",
    file: "lib/voice/live/index.js",
    find: "    if (ummHold?.kind === \"pending\" && atMs - ummHold.startedAtMs >= UMM_DG_WAIT_MS) {",
    replace: "    if (false /* SABOTAGE */) {",
    red: ["tests/liveUmmDeepgram.test.js"],
  },
  {
    name: "r5-umm-dg-off-by-default",
    why: "Round 5 Task 4: with LIVE_UMM_DEEPGRAM absent or listing another business, Deepgram still drives the umm hold (every tenant changes). tests/liveUmmDeepgram.test.js 'exactly round 4'.",
    file: "lib/voice/live/index.js",
    find: "    if (ummDgRaw.toLowerCase() === \"on\") return true;",
    replace: "    return true; /* SABOTAGE */",
    red: ["tests/liveUmmDeepgram.test.js"],
  },
  {
    name: "r5-umm-dg-needs-shadow",
    why: "Round 5 Task 4 (Review Focus 3): with the shadow not connected (bad key, outage) the empty transcript is held as 'pending', adding a wait to replies. tests/liveUmmDeepgram.test.js 'never connected'.",
    file: "lib/voice/live/index.js",
    find: "    if (!shadow?.connected?.()) return false;\n",
    replace: "",
    red: ["tests/liveUmmDeepgram.test.js"],
  },
  {
    name: "r5-shadow-on-text",
    why: "Round 5 Task 4: the shadow stops handing Deepgram's finals to the call, so the umm hold never sees them. tests/liveShadowStt.test.js and tests/liveUmmDeepgram.test.js.",
    file: "lib/voice/live/shadowStt.js",
    find: "    tell(text, true);\n",
    replace: "",
    red: ["tests/liveShadowStt.test.js", "tests/liveUmmDeepgram.test.js"],
  },
  {
    name: "r5-umm-skip-counted",
    why: "Round 5 Task 4: the umm hold's skip reasons stop being counted, so a missed 'Ahm' cannot be explained from a call's counters (round 4 could not). tests/liveUmmDeepgram.test.js 'skip reasons'.",
    file: "lib/voice/live/index.js",
    find: "return skipUmm(\"not_question\");",
    replace: "return false; /* SABOTAGE */",
    red: ["tests/liveUmmDeepgram.test.js"],
  },
  // Round 5, Opus review fix pass.
  {
    name: "r5-review-clear-drops-hold",
    why: "Review I1: a clear (our barge, a leak or offer cut) leaves a held continuation in the repeat hold, and it plays after the cut. tests/liveRepeatHold.test.js 'review I1'.",
    file: "lib/voice/live/index.js",
    find: "    if (repeatHold?.state === \"holding\") dropRepeatHold(\"cleared\");",
    replace: "    if (false) dropRepeatHold(\"cleared\"); /* SABOTAGE */",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-review-intent-keeps-path",
    why: "Review I2: with the question already asked, set_call_intent's reply loses the caller-type path (number, spelling, read-back rules) for the whole call. tests/alreadyAskedThisTurn.test.js.",
    file: "services/tools.js",
    find: "When they answer, carry on this way: ",
    replace: "",
    red: ["tests/alreadyAskedThisTurn.test.js"],
  },
  {
    name: "r5-review-repeat-rule",
    why: "Scoped re-review 1: a re-ask that follows new information (an offer of slots) drops the whole continuation, so the caller never hears the offer. tests/liveRepeatHold.test.js 're-review 1'.",
    file: "lib/voice/live/index.js",
    find: "    for (let ps = 0; ps < Math.min(REPEAT_HOLD_MATCH_START_WORDS, p.length); ps++) {",
    replace: "    for (let ps = 0; ps < p.length; ps++) { /* SABOTAGE: a re-ask anywhere drops the whole continuation */",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-review-repeat-needs-whole-question",
    why: "Scoped re-review 2: a shared frame ('What's your ...') counts as a repeat, so a NEW question ('What's your phone number?') is dropped and the caller hears nothing. tests/liveRepeatHold.test.js 're-review 2'.",
    file: "lib/voice/live/index.js",
    find: "        if (qs + k === q.length) return ps + k;",
    replace: "        if (k >= 3) return ps + k; /* SABOTAGE */",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-review-drop-grace",
    why: "Review I4: a dropped repeat's late words, after its turnComplete, land in the next turn and read as a question already asked. tests/liveRepeatHold.test.js 'review I4'.",
    file: "lib/voice/live/index.js",
    find: "    if (h.turnCompleted) h.dropUntilMs = now() + REPEAT_HOLD_DROP_GRACE_MS;\n    repeatHold = h;",
    replace: "    if (h.turnCompleted) h.dropUntilMs = now() + REPEAT_HOLD_DROP_GRACE_MS;\n    repeatHold = h.turnCompleted ? null : h; /* SABOTAGE */",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-review-new-generation-settles",
    why: "Review M7: a hold still undecided past its turnComplete keeps the NEXT generation's audio too. tests/liveRepeatHold.test.js 'review M7'.",
    file: "lib/voice/live/index.js",
    find: "    if (repeatHold?.turnCompleted) {",
    replace: "    if (false /* SABOTAGE */) {",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-review-no-arm-on-end-call",
    why: "Ruling (review, declined-to-judge): a question plus end_call in one batch arms the hold, so an exit mark could queue ahead of a held goodbye. tests/liveRepeatHold.test.js 'end_call'.",
    file: "lib/voice/live/index.js",
    find: "    if ((toolCall?.functionCalls || []).some((fc) => fc?.name === \"end_call\")) return;\n",
    replace: "",
    red: ["tests/liveRepeatHold.test.js"],
  },
  {
    name: "r5-review-completion-ask-skipped",
    why: "Review I9: a save after '...Is there anything else?' still gets the completion ask, so the caller hears 'anything else?' twice. tests/liveToolWords.test.js.",
    file: "lib/voice/live/tools.js",
    find: "            } else if (replyEndsWithQuestion(state?.inTurnReplyText)) {",
    replace: "            } else if (false /* SABOTAGE */) {",
    red: ["tests/liveToolWords.test.js"],
  },
  {
    name: "r5-review-spaced-hums",
    why: "Review M10: a spaced hum ('Mm hmm.', 'Uh uh.') from Deepgram reads as thinking, so a yes or no waits up to 3 s. tests/liveUmmDeepgram.test.js.",
    file: "lib/voice/live/index.js",
    find: "const DG_ANSWER_HUM_RE = /\\b(?:mhm+|u?m+[- ]?h+m+|uh[- ]?huh|mm[- ]mm|uh[- ]uh|nuh[- ]uh)\\b/i;",
    replace: "const DG_ANSWER_HUM_RE = /\\b(?:mhmm|mm-?hmm|uh-?huh|mm-mm|uh-uh|nuh-uh)\\b/i; // SABOTAGE",
    red: ["tests/liveUmmDeepgram.test.js"],
  },
  {
    name: "r5-review-pending-resume-drops",
    why: "Review M10: the caller carrying on during a pending hold plays the kept reply over them when Deepgram's words land. tests/liveUmmDeepgram.test.js.",
    file: "lib/voice/live/index.js",
    find: "    if (v === \"words\" && ummHold.resumed) {",
    replace: "    if (false /* SABOTAGE */) {",
    red: ["tests/liveUmmDeepgram.test.js"],
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
// --to <name>: stop after that row (inclusive). With --from on a second tree
// at the same sha, the matrix runs as two shards (round A1 Part 6: the single
// run is ~9 h).
const to = process.argv.includes("--to")
  ? process.argv[process.argv.indexOf("--to") + 1]
  : null;
if (to && !SABOTAGES.some((s) => s.name === to)) {
  console.error(`--to ${to}: no row by that name.`);
  process.exit(1);
}
// --rows <file>: run exactly the rows named in the file (one per line), with a
// baseline of only THEIR suites -- a targeted pre-deploy check (2026-10-21:
// the rows a change added, and the older rows its edits sit next to) without
// the ~9 h full matrix. Every name must exist.
const rowsFile = process.argv.includes("--rows") ? process.argv[process.argv.indexOf("--rows") + 1] : null;
const rowSet = rowsFile
  ? new Set(fs.readFileSync(rowsFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
  : null;
if (rowSet) {
  const unknown = [...rowSet].filter((n) => !SABOTAGES.some((s) => s.name === n));
  if (unknown.length) {
    console.error(`--rows: no row by these names: ${unknown.join(", ")}`);
    process.exit(1);
  }
}
let pastTo = false;
if (only && !SABOTAGES.some((s) => s.name === only)) {
  console.error(`--only ${only}: no row by that name.`);
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
function runSuites(files, cwd) {
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
    // Optional per-row working directory (relative to the repo root, where this
    // runs). undefined for every row without `cwd`, which is spawnSync's default.
    cwd,
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
    // What failed, so a red BASELINE names its suite (gate pron2's shard B said
    // only "Baseline is RED" and had to be re-run to find out).
    failures: out.split("\n").filter((l) => /^\s*(FAIL|×)\s/.test(l)).slice(0, 25),
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
      if (!fs.existsSync(path.join(s.cwd || ".", suite))) {
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
// Targets are grouped by the row's optional `cwd` (undefined = repo root, the
// only group for every row that has no `cwd`); each group is one run.
const targetsByCwd = new Map();
for (const s of SABOTAGES) {
  if (only && s.name !== only) continue;
  if (rowSet && !rowSet.has(s.name)) continue;
  if (!targetsByCwd.has(s.cwd)) targetsByCwd.set(s.cwd, new Set());
  for (const suite of s.red) targetsByCwd.get(s.cwd).add(suite);
}
const targets = [];
for (const [cwd, suites] of targetsByCwd) {
  const group = [...suites];
  targets.push(...group.map((x) => (cwd ? `${cwd}/${x}` : x)));
  const baseline = runSuites(group, cwd);
  if (baseline.unreadable) {
    console.error(`Baseline could not be READ${cwd ? ` in ${cwd}` : ""}: ${baseline.reason}.`);
    console.error("That is not the same as red. Nothing was measured, so nothing below would mean");
    console.error("anything -- fix the run before trusting a single row.");
    process.exit(1);
  }
  if (!baseline.ok) {
    console.error(`Baseline is RED${cwd ? ` in ${cwd}` : ""}. Fix the suite before asking whether it can fail.`);
    for (const l of baseline.failures || []) console.error(`  ${l.trim()}`);
    process.exit(1);
  }
}
console.log(`  green: ${targets.join(" ")}\n`);

let bad = 0;
for (const s of SABOTAGES) {
  if (only && s.name !== only) continue;
  if (rowSet && !rowSet.has(s.name)) continue;
  if (from) {
    if (s.name === from) reached = true;
    if (!reached) continue;
  }
  if (pastTo) break;
  if (to && s.name === to) pastTo = true;

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
    writeFileRetrying(s.file, patched);
    // THE ASSERTION THE RULE IS ABOUT: the bytes on disk actually changed.
    if (fs.readFileSync(s.file, "utf8") === original) {
      throw new Error("the patch did not change the file");
    }
    result = runSuites(s.red, s.cwd);
  } finally {
    writeFileRetrying(s.file, original);
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
