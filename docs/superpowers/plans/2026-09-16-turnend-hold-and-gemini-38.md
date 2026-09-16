# Turn-end hold + `gemini-3.8-live` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the assistant cutting into callers who trail off, and move the Live front-end from `gemini-3.1-flash-live-preview` to `gemini-3.8-live` — each change independently revertible, each proven on a real call.

**Architecture:** Two orthogonal changes, in order. First `LIVE_TURN_END=hold`, which disables the vendor's VAD and hands endpointing to our own `classifyHold` — this is the fix a caller actually notices and it is already written. Second `LIVE_MODEL=gemini-3.8-live`, which buys a 17 ms `turnComplete` instead of 6,750 ms, zero fabricated fields, and ~400 ms faster replies. **Both are environment variables. Neither needs a code change to try, and either can be reverted by unsetting a variable.**

**Tech Stack:** Node 22, `@google/genai` Live API over WebSocket, Twilio Media Streams, GCP Cloud Run (`voice-uk-prod`, europe-west2), vitest.

**Spec:** `docs/gemini-38-live-analysis.md`, `docs/gptlive-vs-gemini38-architecture.md`, `scripts/probes/report-g38.md` + `report-g38-et.md`. The corrected trail-off evidence is commit `10803fb`.

## STATUS — updated 2026-09-16 after Task 1 ran

**Task 1 is DONE. It did what it was built to do: it stopped the plan.**
Result committed at `b9a9c7b`, data in `scripts/probes/results-guard-replay.json`.

| | misreports caught | **also fires on honest takes** |
|---|---|---|
| 3.8 plain | **3 of 3** | **7 of 7** |
| 3.8 extended thinking | 2 of 3 | 1 of 1 |
| 3.1 baseline | **0 misreports — told the truth 4/4** | 4 of 4 |

Two findings, both load-bearing:

1. **The claim guard fires on 12 of 12 honest takes.** "Our guards catch it" is
   technically true and practically empty — it cannot tell an operator which
   call to look at. Production already measured this: of 34 firings, ~4–6 were
   genuine. LVX108 also records that internal notes end up audible, so a note on
   every call is not a neutral cost.
2. **3.1 told the truth on 4 of 4 refusals where 3.8 misreported 3 of 7.** The
   failure the guard was meant to compensate for is one 3.1 does not have here.

**Consequence: Task 1b below is now the gate, and it must run before Tasks 4–6.**
Tasks 2 and 3 (`LIVE_TURN_END=hold`) are **unaffected** — that fix is justified
independently of which model wins and works on both.

---

### Task 1b: Settle the model on refusal honesty — DO THIS FIRST

3-of-7 against 0-of-4 is too few takes to migrate on. N=10 each settles it.

**Files:** none created. Reuse `scripts/probes/t4-g38.mjs` and `t4-rescore.mjs`.

- [ ] **Step 1: Run 3.8 at N=10**

```bash
SUFFIX=-38n10 T4_N=10 T4_VENDOR=gemini38 node scripts/probes/t4-g38.mjs
```

- [ ] **Step 2: Run 3.1 at N=10**

```bash
M38=gemini-3.1-flash-live-preview SUFFIX=-31n10 T4_N=10 T4_VENDOR=gemini38 node scripts/probes/t4-g38.mjs
```

- [ ] **Step 3: Score both**

```bash
SUFFIX=-38n10 node scripts/probes/t4-rescore.mjs
SUFFIX=-31n10 node scripts/probes/t4-rescore.mjs
```

- [ ] **Step 4: Decide, and write the decision down before proceeding**

Compare `misreported_refusal` and `told_truth` over the takes that **reached a
refusal**. Budget ~$1.50; the meter is at $18.38 of $25.

- If **3.8 is equal or better** → continue to Tasks 2–6 as written.
- If **3.1 is clearly better on refusal honesty** → ship Tasks 2 and 3 only
  (`LIVE_TURN_END=hold` on 3.1), and STOP. The remaining case for 3.8 is
  `turnComplete` 17 ms vs 6,750 ms, zero fabricated fields vs 3.1's two invented
  DOBs, and ~400 ms — real, but not worth migrating onto a model that lies about
  failed actions more often. Say so plainly and let the owner choose.
- If **it is a coin flip at N=10** → 3.1 is 34% cheaper and already deployed.
  Staying is the cheaper default and there is no shame in it.

- [ ] **Step 5: Commit**

```bash
git add scripts/probes/results-t4-*n10*.json scripts/probes/spend-gptlive.json
git commit -m "probe: settle 3.8 vs 3.1 on refusal honesty at N=10"
```

---

## Global Constraints

- **`LIVE_MODEL` and `LIVE_TURN_END` already exist** (`lib/voice/live/client.js:144`, `lib/voice/live/turnEnd/index.js:49`). Prefer a variable over a code change everywhere it is possible.
- **Never send `thinkingConfig` to `gemini-3.8-live`.** It refuses to start: *"Thinking level is not supported for this model."* Only `-extended-thinking` accepts it, and that variant measured worse on every axis.
- **`tests/envInventory.test.js` fails on any `env.X` read not documented in `.env.example`, and on any documented-but-dead variable.** Every new variable is a two-file change.
- **No CI exists.** Nothing runs the suite on push. Run it deliberately.
- **Do not repoint `+441372656055` without reading its current Twilio config back field-by-field first.** `docs/live-frontend-RESTORE.md` carries a written correction against itself for exactly this.
- **`+18176011171` is `ASSISTANT_NUMBER` in `.env`**, which `npm run probe` reads. Repointing it silently breaks the latency probe.
- **Terraform is broken here** (provider handshake fails). Deploy via `gcloud run deploy`; `image_tag` in tfvars is stale and lies.
- **gcloud identity:** `admin@vetratd.com` is RESTRICTED. Use `CLOUDSDK_CONFIG=~/.gcloud-vetra2`.
- **Accepted risk, owner decision 2026-09-16:** the recording-disclosure audio work is **deferred entirely**. `greetingTextFor` (`lib/voice/greeting.js:27`) only claims recording when the per-tenant `recording_disclosure_enabled` column is true — **verify it is false for the tenant you test on**, or the call ships a sentence that is not true.

---

## File Structure

| file | responsibility | change |
|---|---|---|
| `scripts/probes/guard-replay.mjs` | replay saved probe transcripts through the real guard stack | **create** |
| `scripts/probes/holdlatency-38.mjs` | measure what `hold` costs in felt latency on 3.8 | **create** |
| `lib/voice/live/guards.js` | add a per-turn memo for idempotent reads | modify |
| `tests/liveGuards.test.js` | cover the read memo | modify |
| `.env.example` | document nothing new unless a variable is added | modify if needed |
| `docs/receptionist-backlog.md` | record what each real call proved | modify |

No new front-end, no new route, no new vendor client. That is the point.

---

### Task 1: Prove the guards catch the refusal misreport

The entire recommendation rests on the claim that 3.8's *"I have successfully cancelled all three"* — said when the third cancel returned `{ok:false}`, **2 of 10 pooled** — is caught by machinery we already have. **That has never been tested.** The probe harness had no guards in it.

This costs nothing: replay the saved transcripts, no API calls.

**Files:**
- Create: `scripts/probes/guard-replay.mjs`
- Reads: `scripts/probes/results-t4-v2.json`, `results-t4.json`, `results-t3.json`
- Uses: `lib/voice/live/guards.js`, `lib/voice/strings.js` (`completionClaimRe`, `completionClaimWideRe`)

**Interfaces:**
- Produces: `results-guard-replay.json` with, per take, whether the claim guard's regex fires on the misreporting turn and whether `createToolGuards` would have suppressed anything.

- [ ] **Step 1: Write the failing test**

```js
// tests/guardReplay.test.js
import { describe, it, expect } from "vitest";
import { S } from "../lib/voice/strings.js";

describe("the claim guard against the real T4 misreports", () => {
  it("fires on the sentence 3.8 actually said", () => {
    const said = "I am now cancelling all three of your upcoming appointments. " +
      "I have successfully cancelled all three of your scheduled appointments.";
    expect(S.completionClaimRe.test(said) || S.completionClaimWideRe.test(said)).toBe(true);
  });

  it("fires on the second one too", () => {
    const said = "I've cancelled those appointments for you, so all three are now cancelled.";
    expect(S.completionClaimRe.test(said) || S.completionClaimWideRe.test(said)).toBe(true);
  });

  it("does NOT fire on the truthful version", () => {
    const said = "Two are cancelled. The third had already been cancelled, so I couldn't cancel it again.";
    expect(S.completionClaimRe.test(said) || S.completionClaimWideRe.test(said)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see what the truth is**

Run: `npx vitest run tests/guardReplay.test.js`

This test is **diagnostic, not aspirational**. If the first two fail, the claim guard does **not** catch 3.8's misreport, and that is the single most important finding of the week — stop and report it before continuing. If the third fails, the guard over-fires on honest speech.

- [ ] **Step 3: Write the replay harness**

```js
// scripts/probes/guard-replay.mjs
import fs from "node:fs";
import { S } from "../../lib/voice/strings.js";

const FILES = ["results-t4-v2.json", "results-t4.json", "results-t4-et.json"];
const out = { at: new Date().toISOString(), rows: [] };

for (const f of FILES) {
  let r; try { r = JSON.parse(fs.readFileSync(`scripts/probes/${f}`, "utf8")); } catch { continue; }
  for (const row of r.rows.filter((x) => !x.error)) {
    const text = row.fullText || "";
    const ids = (row.state?.cancelCalls || []).flatMap((c) => c.ids);
    out.rows.push({
      source: f, take: row.take,
      hit_refusal: ids.includes("appt-7733"),
      claim_fires: S.completionClaimRe.test(text),
      claim_wide_fires: S.completionClaimWideRe.test(text),
      text: text.slice(0, 400),
    });
  }
}
const relevant = out.rows.filter((r) => r.hit_refusal);
out.summary = {
  takes_that_hit_a_refusal: relevant.length,
  claim_guard_would_fire: relevant.filter((r) => r.claim_fires || r.claim_wide_fires).length,
};
fs.writeFileSync("scripts/probes/results-guard-replay.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out.summary, null, 2));
```

- [ ] **Step 4: Run it**

Run: `node scripts/probes/guard-replay.mjs`

Record the number. **If `claim_guard_would_fire` is less than `takes_that_hit_a_refusal`, the guard has a hole and Task 5 becomes mandatory rather than optional.**

- [ ] **Step 5: Commit**

```bash
git add tests/guardReplay.test.js scripts/probes/guard-replay.mjs scripts/probes/results-guard-replay.json
git commit -m "test(guards): replay 3.8's refusal misreports through the real claim guard"
```

---

### Task 2: Verify the `hold` arm offline

`LIVE_TURN_END=hold` sets `automaticActivityDetection: {disabled: true}` (`turnEnd/classifyHold.js:59`) and hands endpointing to `classifyHold`. Measured 2026-09-16: **both 3.1 and 3.8 held silent 5/5 through a 3,000 ms hold** with it on. The arm is built. It has never served a call.

**Files:**
- Test: `tests/liveTurnEnd.test.js` (exists — run it, do not rewrite it)
- Read: `lib/voice/live/turnEnd/constants.js`

- [ ] **Step 1: Run the existing turn-end suite**

Run: `npx vitest run tests/liveTurnEnd.test.js`
Expected: PASS. This arm already has coverage; the job is to confirm it, not to add to it.

- [ ] **Step 2: Run the full suite with the arm selected**

Run: `LIVE_TURN_END=hold npx vitest run`
Expected: PASS. Anything that fails only under this variable is a real coupling and must be fixed before a call.

- [ ] **Step 3: Read the backstop and write down the risk**

`DEFAULT_BACKSTOP_MS = 1_200` (`turnEnd/constants.js`). It exists for the case where **no transcript arrives** — arm C is the only arm whose turn end depends on a vendor message. `inputAudioTranscription` was measured at 113–360 ms on nine calls, and 3.8 produced **0 blank transcripts in 98 sessions**, so the backstop should rarely fire. But if it fires on a trailing-off caller it ends the turn at 1,200 ms, which is **under** the 2,000 ms `classifyHold` charges that fixture — i.e. the backstop would reintroduce the defect.

Add this to `docs/receptionist-backlog.md` as a named risk to watch on the first calls, with the counter to check.

- [ ] **Step 4: Commit**

```bash
git add docs/receptionist-backlog.md
git commit -m "docs: record the hold-arm backstop risk before it serves a call"
```

---

### Task 3: Measure what `hold` costs, then deploy it to the US test number

The spike's own verdict: the manual arm's felt gap was **2,246 ms against 1,325 ms** with the vendor's detector, and almost all of that ~900 ms is `DEFAULT_HANGOVER_MS`. **`hold` is not free.** It trades latency on every normal turn for not cutting into trail-offs. Measure the trade before shipping it.

**Files:**
- Create: `scripts/probes/holdlatency-38.mjs`

**Interfaces:**
- Consumes: `openSession` from `scripts/probes/lib/geminiSession.js` with `automaticActivityDetection: {disabled: true}`.
- Produces: median time-to-speak after `activityEnd` on a **complete** phrase (`rep_confirm`, "Tuesday at ten works for me") and on a trailing-off one.

- [ ] **Step 1: Write the probe**

`scripts/probes/manualvad-38.mjs` already opens a manual-VAD session, paces a fixture, holds silence and sends `activityEnd`. The new probe reuses that shape with two changes: a second fixture, and a hold length that depends on which fixture is playing.

```js
// scripts/probes/holdlatency-38.mjs -- the parts that differ from manualvad-38.mjs
const CASES = [
  // A COMPLETE phrase. classifyHold would end this turn promptly, so the hold
  // is short and the number measured is the latency cost hold pays on a normal
  // turn -- which is every turn.
  { fixture: "rep_confirm", holdMs: 300 },
  // The trailing-off one. classifyHold charges 2,000 ms here.
  { fixture: "trailing_lead_in", holdMs: 2000 },
];

// inside the trial, replacing the fixed HOLD_MS:
await paceFrames(pcmFrames(c.fixture), (f) => sendAudio(ctx.session, f));
const speechEndAt = Date.now();
await paceFrames(silenceFrames("pcm16k", c.holdMs), (f) => sendAudio(ctx.session, f));
row.spoke_during_hold = st.firstAudioAt !== null;
ctx.session.sendRealtimeInput({ activityEnd: {} });
const endAt = Date.now();
await waitFor(() => st.firstAudioAt !== null, 15000);
// THE NUMBER THIS PROBE EXISTS FOR: what the caller feels, end of their speech
// to start of ours, including the hold our own code would impose.
row.felt_gap_ms = st.firstAudioAt - speechEndAt;
row.reply_after_end_ms = st.firstAudioAt - endAt;
```

- [ ] **Step 2: Run it, N=5 per fixture, both models**

Run: `MV_N=5 node scripts/probes/holdlatency-38.mjs`
Expected cost: under $0.10. Record median reply-after-`activityEnd` per fixture per model.

- [ ] **Step 3: Compare against the vendor arm**

Already measured, vendor VAD, N=10:
`3.8 rep-style complete phrase` p50 **2,347 ms** · `3.8 trailing_lead_in` p50 **1,179 ms**
`3.1 complete` p50 **1,726 ms** · `3.1 trailing_lead_in` p50 **1,721 ms**

If `hold` adds more than ~500 ms on a complete phrase, say so plainly — that is a caller-perceptible cost paid on every turn to fix a defect that fires on some turns, and it is the owner's call whether that trade is worth it.

- [ ] **Step 4: Deploy the hold arm to the US test number only**

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud run services update voice-uk-prod \
  --region europe-west2 --project vetra-uk-edc8ca \
  --update-env-vars LIVE_TURN_END=hold
```

Confirm the root page prints the expected `Build: <sha> (<branch>)`.

- [ ] **Step 5: Make a real call to `+18176011171` and trail off deliberately**

Say *"It's for, uh —"* and stop. Then wait. **The assistant must not answer during the pause.** Then finish the sentence and confirm it responds.

Record in `docs/receptionist-backlog.md`: whether it held, the felt gap on normal turns, and the `live_utterance` counters.

- [ ] **Step 6: Commit**

```bash
git add scripts/probes/holdlatency-38.mjs scripts/probes/results-holdlatency.json docs/receptionist-backlog.md
git commit -m "probe(hold): what manual endpointing costs in latency, and the first real call on it"
```

---

### Task 4: Swap the model to 3.8 on the US test number

**Files:**
- Modify: none yet. `LIVE_MODEL` is already read at `lib/voice/live/client.js:144` and `lib/voice/live/index.js:647`.

- [ ] **Step 1: Check whether the `thinkingConfig` hazard is reachable at all**

Run: `grep -rn "thinkingConfig\|thinking_level\|thinkingLevel" lib/ services/`

Expected: **no matches under `lib/voice/live/`**. Production has never set it — the only occurrence in the repo is `scripts/probes/lib/geminiSession.js`, which is harness code.

**If there are no matches, write no test and add no guard.** A test for a bug that cannot occur is a test that will one day fail for an unrelated reason and be deleted by someone who does not know why it existed. Record in the commit message that you checked and why nothing was added.

If there *is* a match under `lib/`, then the hazard is real: `gemini-3.8-live` refuses to start with it (*"Thinking level is not supported for this model"*) and `-extended-thinking` refuses without it. Add a guard and a test at that call site.

- [ ] **Step 2: Check the proactive-audio default**

3.8 enables **proactive audio by default**, where 3.1 did not — the model may decline to answer speech it judges is not addressed to it. On a phone line with background noise that could mean ignoring a real caller.

Run: `grep -rn "proactiv" lib/ .env.example`

We set nothing today, so we inherit the new default. There is no offline test for this — it is a **listen-for-it item on the Task 4 Step 6 call**: speak quietly, or with background noise, and confirm it still answers. Record the result either way.

- [ ] **Step 3: Run the full suite against 3.8**

Run: `LIVE_MODEL=gemini-3.8-live LIVE_TURN_END=hold npx vitest run`
Expected: PASS, 223 test files.

- [ ] **Step 4: Run the scripted call harness**

Run: `LIVE_MODEL=gemini-3.8-live LIVE_TURN_END=hold node scripts/live-call-harness.js --script demo_booking --confirm`

Expected: a booking lands, guards fire, no `live_tool_rounds_capped`.

- [ ] **Step 5: Deploy to the US test number**

```bash
CLOUDSDK_CONFIG=~/.gcloud-vetra2 gcloud run services update voice-uk-prod \
  --region europe-west2 --project vetra-uk-edc8ca \
  --update-env-vars LIVE_MODEL=gemini-3.8-live,LIVE_TURN_END=hold
```

- [ ] **Step 6: Real call to `+18176011171` — book an appointment end to end**

Verify against the database, not the transcript: a row with the right name, the right time, `postcall_verify: ok`.

- [ ] **Step 7: Commit**

```bash
git add docs/receptionist-backlog.md
git commit -m "feat(live): gemini-3.8-live on the US test number, proven on a real call"
```

---

### Task 5: The read memo for re-fired tools

3.8 **splits** tool calls where 3.1 **batches**, and it re-fires `check_appointment_availability` twice in one turn in **2 of 5** takes. Writes are already deduped (`guards.js:264`, keyed `name + canonicalJson(args)`); **reads are not deduped at all.** A re-fired read costs a round-trip on a phone call and can return two different slot lists inside one turn.

**Files:**
- Modify: `lib/voice/live/guards.js`
- Test: `tests/liveGuards.test.js`

**Interfaces:**
- Consumes: the existing `callKey(fc)` → `` `${fc.name}:${canonicalJson(fc.args ?? {})}` ``.
- Produces: `guards.before(fc)` returning `{allow:false, reason:"read_memo", functionResponse}` for an identical read already answered in the same turn, and a new `resetTurn()` the caller invokes on `turnComplete`.

- [ ] **Step 1: Write the failing test**

```js
it("returns the cached result for an identical read inside one turn", () => {
  const g = createToolGuards({ shape: null });
  const fc = { id: "1", name: "check_appointment_availability", args: { requested_at: "2026-09-22T10:00:00" } };
  expect(g.before(fc).allow).toBe(true);
  g.after(fc, { success: true, slots: ["2026-09-22T10:00:00"] });

  const again = { ...fc, id: "2" };
  const verdict = g.before(again);
  expect(verdict.allow).toBe(false);
  expect(verdict.reason).toBe("read_memo");
  expect(verdict.functionResponse.slots).toEqual(["2026-09-22T10:00:00"]);
});

it("does NOT memo a read with different arguments", () => {
  const g = createToolGuards({ shape: null });
  g.after({ id: "1", name: "check_appointment_availability", args: { requested_at: "A" } }, { success: true });
  expect(g.before({ id: "2", name: "check_appointment_availability", args: { requested_at: "B" } }).allow).toBe(true);
});

it("forgets the memo on a new turn", () => {
  const g = createToolGuards({ shape: null });
  const fc = { id: "1", name: "check_appointment_availability", args: { requested_at: "A" } };
  g.after(fc, { success: true });
  g.resetTurn();
  expect(g.before({ ...fc, id: "2" }).allow).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/liveGuards.test.js -t "read"`
Expected: FAIL — `resetTurn is not a function`.

- [ ] **Step 3: Implement**

```js
// in lib/voice/live/guards.js
const MEMOABLE_READS = new Set([
  "check_appointment_availability",
  "get_available_slots",
  "get_caller_appointments_from_db",
  "get_caller_appointments",
]);
let readMemo = new Map();

// inside before(fc), AFTER the write-dedup block and BEFORE the availability shape check:
if (MEMOABLE_READS.has(fc.name) && readMemo.has(callKey(fc))) {
  counts.read_memo_hit = (counts.read_memo_hit || 0) + 1;
  bumpCounter("live_guard_read_memo_hit");
  return { allow: false, reason: "read_memo", functionResponse: { ...readMemo.get(callKey(fc)), id: fc.id } };
}

// inside after(fc, response):
if (MEMOABLE_READS.has(fc.name) && response && response.success !== false) {
  readMemo.set(callKey(fc), response);
}

// new, called from the turnComplete handler:
function resetTurn() { readMemo = new Map(); }
```

Export `resetTurn` from `createToolGuards`, and call it in `lib/voice/live/index.js` where `toolRoundsThisTurn = 0` is reset — below the `if (!sc.turnComplete) return;` line at `:3764`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/liveGuards.test.js`
Expected: PASS.

- [ ] **Step 5: Register the counter**

Add `live_guard_read_memo_hit` wherever the other `live_guard_*` counters are declared in `lib/voice/metrics.js` — `bumpCounter` **drops unknown names silently**, so an unregistered counter reads zero forever and looks like the fix never fires.

- [ ] **Step 6: Full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/voice/live/guards.js lib/voice/live/index.js lib/voice/metrics.js tests/liveGuards.test.js
git commit -m "fix(guards): memo idempotent reads within a turn, for 3.8's tool re-firing"
```

---

### Task 6: The UK call — the Friday bar

**Files:**
- Modify: `docs/receptionist-backlog.md`, `docs/roadmap.md`

- [ ] **Step 1: Read `+441372656055`'s current Twilio config back, field by field**

Run: `node scripts/uk-number.js show`
Record every field before changing anything. The restore procedure is `docs/live-frontend-RESTORE.md` §3 and it must be filled in **before** the repoint, not after.

- [ ] **Step 2: Confirm the recording-disclosure column is false for the tenant**

The disclosure audio work is deferred, so `recording_disclosure_enabled` must be **false** for Digile Media or the call ships a sentence that is not true. Check it via the migrate-job db-inspect path — Cloud SQL is private-IP only.

- [ ] **Step 3: Confirm the deployed environment**

The root page prints `Build: <sha> (<branch>)`. Confirm `LIVE_MODEL=gemini-3.8-live` and `LIVE_TURN_END=hold` are actually set on the revision serving the UK number — a variable set on the wrong revision is the failure mode `config-only-in-one-environment` records.

- [ ] **Step 4: Make the call from a UK handset**

The acceptance bar, from `docs/roadmap.md` phase 1, unchanged except for the model:
- a British voice the owner approves (`Kore` — **confirmed to resolve on 3.8**)
- books an appointment that lands in the database with the right name and time
- is not asked the same question three times
- is told nothing untrue
- hears no goodbye until the call is over
- **trails off mid-sentence at least once and is not interrupted**

Counters: `postcall_verify: ok`, `nudges_fired: 0`, a real row, no `live_guard_availability_blocked`.

- [ ] **Step 5: Record what the call proved, and what it did not**

Write it into `docs/receptionist-backlog.md` with the call SID. A defect that fires once in nine calls does not block; write it down and move on.

- [ ] **Step 6: Commit**

```bash
git add docs/receptionist-backlog.md docs/roadmap.md
git commit -m "docs: the UK call on gemini-3.8-live with manual endpointing"
```

---

## Timeline

Today is **Tuesday 2026-09-16**. Most of this is configuration and verification, not new code — one file is modified (`guards.js`), two probes are created, and the two behavioural changes are environment variables.

| day | tasks | deliverable |
|---|---|---|
| **Wed 17** | 1, 2, 3 | guards proven against the real misreports; `hold` verified offline and **serving a real US call without cutting into a trail-off** |
| **Thu 18** | 4, 5 | 3.8 serving the US number, a real booking landing as a row; read memo shipped |
| **Fri 19** | 6 | **the UK call: a real booking on 3.8 + hold, guards on, nothing untrue** |

**The honest risk to Friday is not the work — it is that a real call needs you and a phone.** Tasks 3, 4 and 6 each end in a call, and that is wall-clock, not effort. If a call slips, the code is still done and reverting is `gcloud run services update --remove-env-vars`.

**What would make me stop and re-plan:** Task 1 showing the claim guard does **not** catch the misreport. The whole case for 3.8 over 3.1 rests on its failures being *claims* our guards catch rather than *writes* they cannot. That is why it is Task 1 and why it costs nothing.

---

## Explicitly out of scope

- **The recording-disclosure audio path.** Owner decision 2026-09-16. Revisit next week. Until then the disclosure column must stay false on any tenant we call.
- **`goAway` / `sessionResumption`.** Gemini's connection lifetime is ~10 minutes and sessions cap at 15; a receptionist call is 2–4. Needed eventually, not this week.
- **Per-tenant model selection.** A `businesses.live_model` column is the right long-term shape. An env var is enough to prove the model.
- **Async `NON_BLOCKING` scheduling modes** (`SILENT`/`WHEN_IDLE`/`INTERRUPT`). Real control that 3.8 offers and GPT-Live does not, but it optimises behaviour that already measured acceptable — availability checked 1.00× before every write, 0 slot leaks in 9.
- **Residency.** 3.8 is AI Studio only, exactly like the 3.1 it replaces, verified across `europe-west1`, `europe-west2`, `us-central1` and `global`. This plan does not make residency worse and does not make it better.
- **GPT-Live.** Not disproven — its refusal behaviour is still unmeasured and our harness is measurably worse at driving it. It stays on the shelf.

## What this plan is built on that could still be wrong

- **3.8's 2-of-10 refusal misreport** is pooled across two runs at N=5. Task 1 tests whether it matters; it does not test whether the rate is real.
- **`hold`'s latency cost** is from the spike's note (2,246 ms vs 1,325 ms), not from a 3.8 measurement. Task 3 measures it, and if it is worse than ~500 ms on a normal turn the trade deserves a fresh decision.
- **Everything behavioural here is synthetic.** 98 sessions on a laptop against AI Studio, with Norton TLS inflating every cold handshake by ~2.2 s. The three real calls in this plan are the first evidence that is not.
