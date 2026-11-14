# Caller Experience (Intake) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every inbound caller, for every business, gets a sharp-receptionist call: the caller type decides the path,
answers already given are never re-asked, the calling number is the callback number, spelling only where it matters,
all of a business's questions asked well, a plain goodbye, and per-call counters that prove it.

**Architecture:**
- The model reports `caller_type` and `reason_given` on the existing `set_call_intent` tool. Live call state stores
  them, and the tool's REPLY hands back that type's short path. Live obeys a tool reply at once; a rule written only
  in the prompt holds about half the time.
- The messages protocol becomes a described goal, not a checklist. It reads two new message-pack settings, so a
  business's choice replaces our default instead of competing with it.
- Code backs the parts that matter:
  - the spelling gate follows the setting and the caller type
  - the read-back note follows the caller type
  - a reason re-ask is cut once the reason was given
- An `intake` block in live_call_summary measures the rest.

**Tech Stack:** Node.js (ESM), vitest, Gemini Live (lib/voice/live/index.js), cascade path services/gemini.js +
services/tools.js.

**Spec:** docs/superpowers/specs/2026-11-14-caller-experience-design.md (approved 2026-11-14). Read it before any
task.

## Global Constraints

- Generic code only: no business name, number or ID in runtime code (tests/noTenantInRuntimeCode.test.js). No new
  per-business switch: the two settings are capability config any business sets.
- **Setting names and values (exact).** Message pack config:
  - `confirmStyle`: `"end"` | `"each"`, default `"end"`.
  - `spellUpFront`: `"no"` | `"leads"` | `"everyone"`, default `"no"`.

  CamelCase, like `callbackLine`. The spec's `confirm_style` / `spell_up_front` are the same settings.
- **Caller types (exact).** `CALLER_TYPES` from lib/capabilities/customerRequests.js:162
  (`new_enquiry, existing_customer, personal, supplier, sales_pitch, other`) plus `wrong_number`, on `set_call_intent`
  only. "Lead" = `new_enquiry`, "client" = `existing_customer`, "seller" = `supplier` | `sales_pitch`,
  "unclear" = `other`.
- **Healthcare tier is unchanged.** When `config.complianceTier === "hipaa"`:
  - the messages protocol, spelling gate and read-back note behave exactly as today (byte-identical prompt text)
  - both settings are ignored
  - no path note is sent
- **Outbound is byte-identical.** No new declaration property, prompt line or tool reply on outbound.
- **Bookings are unchanged.** The appointments pack's spelling gate, read-back and slot logic are untouched.
- **New prompt text is described, never scripted.** No quoted sentence ending in `?` for the model to recite (the
  2026-09-05 tic rule). Every new prompt test asserts `!/"[^"]+\?"/.test(line)` on the lines it adds.
- **Always-on, enforced in code:** never re-ask a question the caller ANSWERED. A confirmation ("Did you say 2 pm?")
  is not a re-ask. Number asks with a real caller ID are a DEFAULT (a business may want them): counted, never cut.
- **Every behaviour change** gets:
  - a red-first test
  - a sabotage row in scripts/corpus/sabotage.mjs, with its name appended to the round's rows file, hand-verified
    once after commit per the S3 rules
  - `node scripts/corpus/sabotage.mjs --census` OK
- **Implementer rules:** .superpowers/sdd/2026-11-07-ilija/implementer-rules-s3.md applies in full:
  - CRLF, the Edit tool, `git add` by exact path
  - one vitest at a time with the Norton `NODE_EXTRA_CA_CERTS` export
  - no paid runs; never import sabotage.mjs
  - run the guard suites it names when you touch config, env, comments or prompt wording
- **Commit trailers:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: <the executing session's URL>
  ```

## Review Focus

1. **Caller type never reported** (the model skips set_call_intent, or marker mode, where the tool is not declared).
   `state.callerType` stays null. Expect the read-back and spelling decisions to treat null as `new_enquiry`, so a
   message still gets its spelled read-back. Test in Task 4.
2. **Withheld number or a call from the business's own line, on a personal call.** The number IS asked, once. The
   path note says so, and no counter calls it a fault. Test in Task 3.
3. **`confirmStyle: "each"`.** A per-answer confirmation like "So that's about the boiler, right?" is never cut as a
   reason re-ask, and the end read-back note is not sent. Test in Task 5 (cut) and Task 4 (note).
4. **A Spanish-language call.** The reason-ask detector and the goodbye-name counter must not misfire on Spanish. The
   reason detector covers the ES phrasings listed in Task 5 and stays silent on other Spanish. Test in Task 5 and
   Task 6.
5. **The type changes after the save** (a "personal" call turns out to be a lead). The later save merges onto the same
   row, and the read-back note fires on that later save. Test in Task 4.

---

### Task 1: The two settings, and the tier on the config

**Files:**
- Modify: `capabilities/messages.js` (configSchema at ~266-285)
- Modify: `lib/capabilities/configSchema.js` (validateCapabilityConfig, beside `existingAppointment` at ~85)
- Create: `lib/capabilities/intakeSettings.js`
- Modify: `services/db.js` (loadConfig at 487)
- Modify: `tests/capabilityConfigEffects.test.js` (WIRED_KEYS at 29-41)
- Test: `tests/intakeSettings.test.js` (new)

**Interfaces:**
- Produces, from `lib/capabilities/intakeSettings.js`:
  - `confirmStyleOf(config) -> "end"|"each"`
  - `spellUpFrontOf(config) -> "no"|"leads"|"everyone"`
  - `isHealthcareTier(config) -> boolean`
  - `INTAKE_CALLER_TYPES` (frozen array: CALLER_TYPES + `"wrong_number"`)
  - `LEAD_LIKE` (frozen Set: `new_enquiry`, `existing_customer`)
- Produces, on the config built by loadConfig: `config.complianceTier` (`"standard"|"hipaa"`, from
  `effectiveTier(business)`, lib/compliance.js:157).

- [ ] **Step 1: Write the failing tests.** In `tests/intakeSettings.test.js`:
  - `confirmStyleOf({})` is `"end"`.
  - `confirmStyleOf({capabilities:{messages:{confirmStyle:"each"}}})` is `"each"`.
  - An unknown value returns the default.
  - `spellUpFrontOf` covers its three values plus the default `"no"`.
  - `isHealthcareTier({complianceTier:"hipaa"})` is true, and `isHealthcareTier({})` is false.
  - `validateCapabilityConfig({confirmStyle:"each", spellUpFront:"leads"}, messagesPack)` keeps both.
  - `{confirmStyle:"loud"}` is dropped.
  - `loadConfig({...minimal row, compliance_tier:"hipaa"}).complianceTier === "hipaa"`.
- [ ] **Step 2: Run them and see them FAIL.** Run `npx vitest run tests/intakeSettings.test.js`; FAIL means the module
  is not found.
- [ ] **Step 3: Implement.**
  - Add schema leaves `confirmStyle` and `spellUpFront`, each `{type:"choice", label, options, optionLabels, default}`,
    with the same shape as appointments `existingAppointment`. Labels are plain owner words, e.g. "How should answers
    be confirmed?" with options "Once, at the end" / "After each answer".
  - Validate both in configSchema.js against `schema.<key>.options`.
  - Write the accessors, reading through `capabilityConfig(config, "messages")` (lib/capabilities/requirements.js:50).
  - Add `complianceTier: effectiveTier(business)` to loadConfig's return.
  - Add both keys to `WIRED_KEYS.messages`. Their effect tests land in Tasks 3 and 4.
- [ ] **Step 4: Run them and see them PASS.** Run tests/intakeSettings.test.js, then tests/capabilityConfigEffects.test.js
  (the tripwire). Then run tests/setBusinessConfig.test.js and any loadConfig suite `grep -l "loadConfig(" tests/`
  finds.
- [ ] **Step 5: Add the sabotage row and commit.**
  - Row `intake-settings-validate`: break the options check, so suite intakeSettings goes red.
  - Commit `feat(intake): confirmStyle and spellUpFront message settings`.

### Task 2: Caller type and reason_given reach call state; the intake audit block

**Files:**
- Modify: `services/gemini.js:654-676` (set_call_intent inbound declaration only)
- Modify: `lib/voice/replyState.js:308-314` (store type + reason flag)
- Modify: `lib/voice/live/index.js`:
  - `intakeAudit` beside `confirmAudit` (~1005)
  - logged at ~9815
  - tool ctx at ~5166-5183
  - the first-caller-words time
- Test: `tests/liveCallerType.test.js` (new), `tests/promptSnapshot.test.js` (`-u`; tools.json snapshots only)

**Interfaces:**
- Consumes: `INTAKE_CALLER_TYPES` (Task 1).
- Produces:
  - `state.callerType`: one of INTAKE_CALLER_TYPES or null. The latest valid report wins.
  - `state.reasonGiven`: boolean, sticky once true.
  - Tool ctx fields `callerType`, `reasonGiven`, `callerNumberReal` (`isRealCallerNumber(state.callerNumber)` and not
    the business's own line).
  - `intakeAudit`, logged as `intake` in live_call_summary, with all fields initialised. This task fills `caller_type`,
    `caller_type_changes`, `questions_asked` and `first_words_to_save_ms`. Later tasks fill `reason_reasked`,
    `reason_reask_cut`, `number_asked_with_caller_id`, `spell_asks`, `ended_before_save`, `goodbye_turns`,
    `goodbye_named_business`, `readbacks`, `readbacks_without_check`.

- [ ] **Step 1: Write the failing tests** in `tests/liveCallerType.test.js`. Use the real Live runner harness pattern
  from tests/liveToolContext.test.js, with both ends real.
  - The inbound declaration has `caller_type` (enum = INTAKE_CALLER_TYPES) and `reason_given` (boolean). Neither is
    required.
  - The outbound declaration is unchanged (deep-equal to today's).
  - A set_call_intent call `{intent, caller_type:"personal", reason_given:true}` leaves `state.callerType ===
    "personal"` and `state.reasonGiven === true`.
  - A later `{caller_type:"new_enquiry", reason_given:false}` gives `callerType "new_enquiry"`, reasonGiven still
    true, and `intake.caller_type_changes === 1`.
  - An invalid caller_type is ignored.
  - The tool ctx carries callerType, reasonGiven and callerNumberReal.
  - live_call_summary has `intake.questions_asked` equal to the count of `asksIn()` asks across assistant turns.
  - `intake.first_words_to_save_ms` is a number after a successful record_customer_request.
- [ ] **Step 2: Run the test and see it FAIL.**
- [ ] **Step 3: Implement.**
  - Declaration: inbound description gains one line, described, saying what kind of caller this is and whether they
    already said what the call is about, and to call it again if either changes.
  - Store the type and reason flag in replyState.
  - Declare, bump and log intakeAudit.
  - `ended_before_save` is set at call end when `state.callerType` is in `new_enquiry|existing_customer|personal`
    (or null with a reason given) and no message save succeeded.
- [ ] **Step 4: Run the test and see it PASS.**
  - Run `npx vitest run tests/promptSnapshot.test.js -u`.
  - The diff must be `*.tools.json` (and `*.marker.tools.json` if any) inbound files only, on the set_call_intent
    entry. No outbound snapshot changes.
  - Run tests/promptSplit.test.js and tests/liveToolContext.test.js.
- [ ] **Step 5: Add the sabotage row and commit.**
  - Row `caller-type-stored`: replyState drops callerType, so liveCallerType goes red.
  - Commit `feat(intake): caller type and reason_given reach call state`.

### Task 3: The intake protocol and the per-type path note

**Files:**
- Modify: `capabilities/messages.js`:
  - `messageProtocol(cfg)` at 221 becomes `messageProtocol(cfg, config)`
  - `messageGuidance` at 236
  - `NEXT_QUESTIONS_NOTE` at 42
  - `prompt(config)` ~298
- Create: `lib/voice/intakePath.js`
- Modify: `services/tools.js:535-551` (set_call_intent handler)
- Test: `tests/intakeProtocol.test.js`, `tests/intakePath.test.js` (new). Effect tests for both keys in
  `tests/capabilityConfigEffects.test.js`. Update the old-wording suites:
  - `tests/capabilityConfig.test.js`
  - `tests/askLedger.test.js`, `tests/liveRepeatCut.test.js`, `tests/liveStackedQuestions.test.js`,
    `tests/liveRepeatedPhrase.test.js`
  - `tests/fallbackFlow.test.js`
  - prompt snapshots

**Interfaces:**
- Consumes: Task 1 accessors and `LEAD_LIKE`. Tool ctx `callerType`, `callerNumberReal` (Task 2).
  `businessHandlesSellerCalls(config)` (lib/sellerCalls.js).
- Produces: `intakePathNote({ callerType, config, callerNumberReal, outbound }) -> string|null`, exported from
  lib/voice/intakePath.js.

**Protocol content, standard tier.** Described, not scripted. Replaces the STEP_* list for the standard tier only.
The healthcare tier keeps today's `messageProtocol` output byte-for-byte. In this order:
1. **Goal.** Get what is needed to pass this on. Anything the caller already said counts as answered; never ask it
   again; never guess a detail. If something is unclear, ask once.
2. **Before the first question,** one short line tied to what they asked for, saying why the questions follow. Never
   repeat the greeting's words. One question per turn, acknowledging the last answer without opening every question
   with thanks.
3. **Name.** First name for personal callers. Name for others.
4. **Number.** When THIS CALLER'S NUMBER is known, do not ask; it is the callback number. When it is not known, ask
   once.
5. **Save** as soon as the type's minimum is in hand: name + what it is about, plus a number if withheld.
6. **Then this business's own questions,** all of them, in the business's order. Skip any the caller already
   answered. If the caller says they are short of time, offer to leave the rest for the callback.
7. **Confirming:**
   - `confirmStyle "end"`: one read-back at the end for leads and clients (the surname spelled, plus the email if
     given), then ask whether that is right.
   - `"each"`: confirm each answer briefly as it is given, and no end read-back.
   - Personal and seller callers: a plain confirmation, no read-back.
8. **Spelling:**
   - `spellUpFront "no"`: never ask anyone to spell; the read-back spells it.
   - `"leads"`: ask leads and clients to spell their surname before saving.
   - `"everyone"`: ask every caller who leaves a message.
9. **The callback promise,** as today (callbackLine or standing).

**`intakePathNote` content.** Each note starts `[not caller speech]`. Null for the healthcare tier, for outbound, for
a null or unknown type, and for `wrong_number` (the guardrail bullet handles it).
- **personal:** first name and their message only. No number question when `callerNumberReal`. No spelling unless
  spellUpFront is "everyone". A plain confirmation of what you'll pass on.
- **new_enquiry / existing_customer:** name and what they want; save; then this business's questions; confirm per
  confirmStyle; spell per spellUpFront.
- **supplier / sales_pitch:** follow this business's own rule when `businessHandlesSellerCalls(config)`; otherwise the
  existing default bullet. No spelling unless "everyone".
- **other:** one open question about how you can help, before any detail question.

- [ ] **Step 1: Write the failing tests.**
  - **intakeProtocol.test.js:**
    - A standard config's prompt contains the described rules (match on short distinctive phrases you write: "already
      said", "one question", "do not ask" + "number", "this business's own questions", "short of time").
    - None of the new lines matches `/"[^"]+\?"/`.
    - A hipaa config's protocol equals the old protocol string (snapshot the old output in the test before changing
      the code).
    - `confirmStyle:"each"` has no "read-back at the end" line and has a per-answer line.
    - `spellUpFront` "leads" and "everyone" each produce their line, and "no" has a no-spelling-question line.
  - **intakePath.test.js:**
    - One case per type, with the values above.
    - personal with `callerNumberReal:false` asks for the number once.
    - hipaa, outbound, null and wrong_number return null.
    - No quoted question in any note.
  - **capabilityConfigEffects:** each new key changes `buildStaticSystemPrefix` output.
  - **set_call_intent handler:** an inbound reply has `next` = the path note. An outbound reply has no `next`.
- [ ] **Step 2: Run them and see them FAIL.**
- [ ] **Step 3: Implement.**
  - Write `messageProtocol` / `messageGuidance` / `NEXT_QUESTIONS_NOTE`. Keep one shared helper so the cascade
    guidance and the Live prefix use the same lines.
  - Write `intakePathNote`.
  - In the handler, attach `next` before `message`, the same ordering rule as messages.execute.
- [ ] **Step 4: Run them and see them PASS.**
  - Then update the old-wording suites deliberately. Each change must reflect the new design, not just a refreshed
    expectation.
  - Run promptSnapshot `-u` and read the diff: inbound static snapshots change in the messages protocol block only.
    Healthcare-tier fixtures (if any) and outbound must not change.
  - Run promptSplit, promptConversationTruth, a1PromptTrims, promptSellerDefault and recordingClaimLint.
- [ ] **Step 5: Add the sabotage rows and commit.**
  - Rows:
    - `intake-protocol-no-reask`: delete the "already said" rule, so intakeProtocol goes red.
    - `intake-path-note`: the handler omits `next`, so intakePath / handler goes red.
    - `healthcare-keeps-protocol`: route hipaa to the new protocol, so intakeProtocol goes red.
  - Commit `feat(intake): described protocol and per-caller-type path`.

### Task 4: Spelling gate and read-back note follow the setting and the type

**Files:**
- Modify: `services/tools.js`:
  - the spelling refusal branch (`pendingName` ~2638)
  - `spellingGateWouldHold` (3023)
- Modify: `capabilities/messages.js` (`spelledReadBackNote` at 82)
- Modify: `lib/voice/live/index.js` (count spell asks into `intakeAudit.spell_asks`)
- Test: `tests/intakeSpelling.test.js` (new); extend `tests/spelledReadBackNote.test.js`

**Interfaces:**
- Consumes: Task 1 accessors and `LEAD_LIKE`. Ctx `callerType` (Task 2).
- Produces: `messagesSpellingRequired(ctx) -> boolean`, exported from services/tools.js for tests:
  - healthcare tier: today's behaviour (gate decides as now)
  - "everyone": true
  - "leads": `LEAD_LIKE.has(ctx.callerType ?? "new_enquiry")`
  - "no": false

- [ ] **Step 1: Write the failing tests.**
  - **Gate (intakeSpelling.test.js):**
    - A messages-pack save with an unspelled name and default settings is NOT refused (spelling gate silent).
    - With `spellUpFront:"everyone"` it is refused as today.
    - With `"leads"`: refused for `new_enquiry`, not refused for `personal`.
    - An appointments booking with the default setting is refused exactly as today (bookings unchanged).
    - A hipaa config is refused as today.
  - **Note (spelledReadBackNote.test.js):**
    - `callerType:"new_enquiry"`, `callerSpelled:false`, confirmStyle "end" → `next` starts with the read-back note
      and contains the spelled surname from the saved name.
    - `callerType:"personal"` → no note.
    - `callerType:null` → the note fires (treated as new_enquiry).
    - `confirmStyle:"each"` → no note.
    - A personal-then-new_enquiry second save on the same call → the note fires on the second save.
- [ ] **Step 2: Run them and see them FAIL.**
- [ ] **Step 3: Implement.**
  - In the gate, when `pack.id === "messages"` and `!messagesSpellingRequired(ctx)`, set `pendingName = null` and make
    `spellingGateWouldHold` return false.
  - In the note, the name letters fire when `ctx.callerSpelled` OR (`LEAD_LIKE.has(callerType ?? "new_enquiry")` and
    not healthcare and confirmStyle "end"). They never fire for personal / supplier / sales_pitch / other unless
    `ctx.callerSpelled` and spellUpFront "everyone". Email letters follow the same type rule.
- [ ] **Step 4: Run them and see them PASS.**
  - Run the gate suites that pin the spelling gate today. Find them with
    `grep -l "spelling" tests/live*Spell* tests/*spelling*`; at minimum tests/spelledReadBackNote.test.js,
    tests/liveSavePolicy.test.js and tests/withheldSaveAsksDigits.test.js.
  - Each old assertion that a MESSAGE save is refused for spelling either moves to an explicit
    `spellUpFront:"everyone"` config or is deleted with a one-line reason. Booking assertions stay as they are.
- [ ] **Step 5: Add the sabotage rows and commit.**
  - Rows:
    - `messages-spell-gate-follows-setting`: the gate ignores the setting, so intakeSpelling goes red.
    - `readback-note-by-type`: the note ignores the type, so spelledReadBackNote goes red.
  - Commit `feat(intake): spelling follows the setting and the caller type`.

### Task 5: Never re-ask the reason; count number asks with a real caller ID

**Files:**
- Modify: `lib/voice/askLedger.js` (new fixed kind `reason` in the kind classifier; `asksIn` returns it)
- Modify: `lib/voice/live/index.js` (`inspectAsk` ~5810: flags at ~5826, cut path)
- Test: extend `tests/askLedger.test.js`; new `tests/liveReasonReask.test.js`

**Interfaces:**
- Consumes: `state.reasonGiven`, `state.callerNumber`, `intakeAudit` (Task 2). `confirmStyleOf` (Task 1).
- Produces: kind `"reason"` from `asksIn(text)`, and `REASON_ASK_RE` exported from askLedger.js for tests.

- [ ] **Step 0: Prototype the detector first** (memory: prototype detectors before editing). In a throwaway node script
  in the scratchpad, run a candidate `REASON_ASK_RE` over every assistant turn in tests/fixtures/liveCalls/*.json and
  call-corpus/.
  - Count hits and read every hit.
  - Required EN positives: "what is the call regarding", "what's this regarding", "what is your call regarding today",
    "reason for your call", "what are you calling about", "what's it about".
  - Required ES positives: "¿de qué se trata la llamada?", "¿cuál es el motivo de su llamada?".
  - Negatives: "is that about the boiler?", "what time suits you?", "what's the name of your business?", and
    confirmations ending "right?".
  - Settle the regex before Step 1. Put the counts in the commit message.
- [ ] **Step 1: Write the failing tests.**
  - **askLedger:** the positives above classify as `reason`; the negatives do not.
  - **liveReasonReask (real Live runner, real ledger):**
    - With `reasonGiven:true`, a reply fragment asking the reason is cut (same mechanism and audio clear as the repeat
      cut). `intake.reason_reasked === 1` and `reason_reask_cut === 1`.
    - With `reasonGiven:false`, the same ask is not cut and not counted.
    - A `confirmStyle:"each"` confirmation "So that's about Saturday, right?" is not cut.
    - A number ask with a real caller ID bumps `intake.number_asked_with_caller_id` and is NOT cut.
    - With a withheld number it is not counted.
- [ ] **Step 2: Run them and see them FAIL.**
- [ ] **Step 3: Implement.**
  - Add the classifier kind.
  - In `inspectAsk`, cut and count when `kind === "reason" && state.reasonGiven`. Count only for
    `kind === "number" && callerNumberReal`.
- [ ] **Step 4: Run them and see them PASS.** Also run tests/liveRepeatCut.test.js, tests/liveStackedQuestions.test.js
  and tests/liveCorpusReplay.test.js.
- [ ] **Step 5: Add the sabotage row and commit.**
  - Row `reason-reask-cut`: the cut condition is negated, so liveReasonReask goes red.
  - Commit `feat(intake): a reason the caller gave is never asked again`.

### Task 6: Plain goodbye, read-back check, and the spelled read-back counter fix

**Files:**
- Modify: `services/gemini.js` (end_call inbound description ~680-700; outbound unchanged)
- Modify: `lib/voice/live/index.js`:
  - `auditTurn` ~3360 (goodbye counters)
  - the post-save turn (read-back check)
  - `finalizeConfirmSave` ~1045 (readback_spelled fix)
- Test: `tests/liveGoodbyeNamedBusiness.test.js`, `tests/liveReadbackCheck.test.js` (new); update
  `tests/goodbyeNameFree.test.js`

**Interfaces:**
- Consumes: `intakeAudit` (Task 2); `readsContactBack(text)` (askLedger.js:126); `S.signOffRe`.
- Produces: `READBACK_CHECK_RE`, exported from lib/voice/strings.js per language like the other detectors.

- [ ] **Step 0: Prototype `READBACK_CHECK_RE` the same way as Task 5.**
  - Positives: "Is that right?", "Did I get that right?", "Have I got that correct?", "¿Es correcto?".
  - Negatives: "Is there anything else I can help you with?".
- [ ] **Step 1: Write the failing tests.**
  - **Description:** the inbound end_call description says to thank and wish well without saying the business's name,
    unless this business's own instructions give their own sign-off. No quoted sentence.
  - **Goodbye counter:** a goodbye turn armed by signOffRe that contains `config.businessName` (case-insensitive,
    names of 3+ letters) bumps `intake.goodbye_named_business`. Every armed goodbye bumps `intake.goodbye_turns`.
    "Thanks for calling, have a wonderful day" does not bump the name counter.
  - **Spanish goodbye:** a Spanish goodbye without the name bumps only `goodbye_turns`.
  - **Read-back check:** a post-save turn that reads back contact details or spelled letters bumps `intake.readbacks`.
    Without a READBACK_CHECK_RE match it also bumps `readbacks_without_check`; the S4 call 2 text (letters, then
    straight into "anything else?") bumps both.
  - **readback_spelled fix (S4-B5):** reproduce call …d9bfd8. The spelled letters are spoken in the same turn that
    carries the record_customer_request save, and the spelling flag is set. Expect `confirm.readback_spelled === 1`
    and `readback_spelled_missing === 0`. Today it reads 0 / 1.
- [ ] **Step 2: Run them and see them FAIL.**
- [ ] **Step 3: Implement.**
  - Change the description wording.
  - Add the counters.
  - Find why `save.spelled` misses same-turn letters and fix it at the source. Do not special-case the test.
- [ ] **Step 4: Run them and see them PASS.**
  - Run promptSnapshot `-u`: the inbound tools.json end_call entry only.
  - Then run toolMessageLeak, goodbyeNameFree, liveGoodbyeExit, liveSilentExitAfterGoodbye and closingOrder.
- [ ] **Step 5: Add the sabotage rows and commit.**
  - Rows:
    - `goodbye-named-counter`: the name check is negated, so liveGoodbyeNamedBusiness goes red.
    - `readback-check-counter`: the regex is never tested, so liveReadbackCheck goes red.
    - `readback-spelled-same-turn`: revert the fix, so the S4-B5 test goes red.
  - Commit `feat(intake): plain goodbye, read-back check, spelled read-back counted`.

---

## After the tasks (controller, not an implementer)

1. **Whole-branch review.** One fresh reviewer, most capable model, over the full diff. Named risks:
   - the healthcare tier byte-identity
   - outbound byte-identity
   - any cut that could fire on an answer rather than an ask
   - a business setting overridden by code
2. **Census, then the full gate.** Run census, then the full gate in mintty. Use a copy of
   `.superpowers/sdd/2026-11-07-ilija/run-gate-S4.sh` with this round's rows file. Root must be green, DB passed, every
   row red. MIGRATE exit=1 on the LF gate worktree is expected (memory prod-migration-checksums-crlf).
3. **Deploy** as S4 Deploy 4 (ledger):
   - Build from the MAIN checkout.
   - Run migrate `--args=scripts/migrate.js,--status`.
   - Deploy with `--no-traffic` and a tag.
   - Check the tag serves `Build: <sha>`.
   - The env diff vs the live revision must be GIT_COMMIT_SHA only, and the boot log must be clean.
   - **Ask the owner before the traffic move.**
4. **Live check, after the owner's yes, ~6 calls (~$2.40):** friend, new lead, seller, existing client, withheld
   number, "can I speak to <owner>?". Read the `intake` block per call. Success:
   - friend at 0-1 questions
   - lead saved within ~45 s of stating the need
   - `reason_reasked` 0
   - `goodbye_named_business` 0
   - `readbacks_without_check` 0
   - a set setting always followed

**Estimate:**
| Task | Time |
|---|---|
| T1 | 0.5 h |
| T2 | 0.75 h |
| T3 | 1.25 h |
| T4 | 0.75 h |
| T5 | 1 h |
| T6 | 0.75 h |
| Review | 0.5 h |
| Gate | 0.75 h |
| Deploy | 0.5 h |
| **Total** | **~6.75 h, in 2 sessions** |
