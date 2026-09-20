# Scope — separating "not yet" from "actually broken"

**Written 2026-09-20 as the brief for the next session. Owner-approved in
principle; nothing below is built.**

---

## The problem, in one paragraph

A tool call that is HELD by a gate and a tool call that genuinely FAILED both
come back to the model as `success: false`. The model cannot tell them apart, so
it guesses — and when it guesses "broken" it tells the caller the system is
down and offers to take a message. `CA1d405002` produced *"I'm sorry, that
cancellation didn't go through just yet. May I take your details so someone can
follow up?"* and *"I'll have someone call you back to sort this out."*

The owner's requirement, in their words: **it should not say the system is
having trouble unless it actually is. Worst case, clarify one more time and
then go from there.**

---

## READ THIS FIRST — the history, which is longer than it looks

`services/tools.js:185-215` carries the record and it must be read before
anything is changed. Summary:

- **LVX34.** The model read `success: false` as *"this cannot be done"* and
  offered the caller a callback twice rather than asking the one question it was
  told to ask. The `"NOT A FAILURE — nothing is wrong..."` wording was written
  for that, and **it worked**.
- **The cost of that fix.** With three sentences of reassurance in front of it,
  the only thing carrying "this did not happen" was one boolean. Measured on
  `call-corpus/`: **11 of 39 refused-write episodes were followed by the
  assistant telling the caller it was done, 4–11 seconds later. 28%.**
- So the two failure modes are opposite ends of one dial. Push toward "this is
  fine" and the model fabricates completion. Push toward "this failed" and it
  announces an outage. **Every attempt so far has moved the dial rather than
  changing what is on it.**
- **Six refusal rewordings have now failed**, and the LVX150 A/B closed "not
  demonstrated" at 0 of 7. That file's own note says it: *"If the rate does not
  move, wording is eliminated."* It has not moved. **Do not write a seventh
  wording.**

This scope is the first change that alters the SHAPE rather than the words.

---

## What already exists (do not rebuild it)

The distinguishing field is **already there, on three sites out of about
twenty**, and it already reaches the model:

```
services/tools.js:1101    gated: true
services/tools.js:1802    response: { success: false, gated: true, message }
services/tools.js:2027    response: { success: false, gated: true, message }
```

It is consumed only by instrumentation:

```
lib/voice/live/guards.js:468   outcome: success ? "written" : gated ? "held" : "refused"
lib/voice/live/index.js:4307   const gated = !ok && response?.gated === true
services/tools.js:2401         gated: durResponse?.gated === true
```

**So `gated` is a half-finished seam.** The model receives it on some holds,
nothing tells it what the field means, and most holds do not carry it. Tonight's
analysis leaned on it heavily — `gated=false` on three attempts is what proved
`CA1d405002` was never a consent problem — so it is trustworthy where present.

---

## The work

### 1. Inventory and classify every `success: false`

About twenty sites across `services/tools.js` and `capabilities/appointments.js`.
Each is exactly one of:

| class | meaning | example |
|---|---|---|
| **HOLD** | nothing is wrong; ask the caller something and call again | write-order gate, spelling gate, requirements check, the `in_addition` branch |
| **RULE** | the business says no; do not retry | slot taken, outside hours, capability disabled |
| **FAULT** | something is actually broken | pack threw, tool timed out, adapter error |

The classification is the deliverable, not a detail. Write it down per site.

`services/tools.js:398` is already the FAULT path and already says *"That didn't
go through. Apologise briefly and offer to take a message."* — which is the
right thing to say **when it is true**.

### 2. Mark them consistently

Every HOLD carries the marker; RULE and FAULT do not. Keep `gated` rather than
inventing a second name — three sites and three consumers already use it, and a
parallel field is how two things that must agree stop agreeing.

### 3. Make the marker mean something to the model

A field the model has never been told about is noise. This is the part with
genuine design choice in it, and the options are not equal:

- **Say it in the tool declarations once** — one sentence defining the field for
  every tool. Cheapest, and the declarations are already where `end_call`'s
  same-response rule lives.
- **Say it in the refusal message** — that is wording, and wording has failed
  six times. Not on its own.
- **Do not tell the model at all**, and use the marker only to decide whether
  the CALL reacts. Weakest for this goal, since the sentence is the model's.

Recommendation: the first. Measure before adding anything else.

### 4. Leave the reassurance alone

`"NOT A FAILURE"` stays. It is load-bearing for LVX34 and removing it while also
changing the shape is two variables.

---

## Risks, and the number that watches each

| risk | watched by |
|---|---|
| Model announces the write as DONE when it was only held | `claim_audit.note_sent`, `unbacked_action`, and `scripts/corpus/score-claims.mjs`, which scores the same 28% before and after |
| Model stops retrying a hold, treating it as final | writes that end with nothing written; `write_order_gate_ceiling` |
| Fault sentences do not fall | the detector at `scratchpad/lvx158-rate.mjs` — move it into the repo |

**The fabrication risk is the serious one**, and there is now direct evidence of
a net: on `CA1d405002` the claim guard caught **3 of 3** unbacked claims. So a
regression is visible on the first call rather than discovered from a customer.

---

## How to know it worked

Baseline, measured 2026-09-20 on `call-corpus/`:

```
calls with at least one write-order refusal : 24
...that then told the caller it COULD NOT   :  2  (8%)
...where the action then SUCCEEDED anyway   :  0
```

Rare **and terminal** — historically, when the model said it, the call ended
with nothing written. Both of those calls predate the ceiling.

Success is: fault sentences fall, `note_sent` and `unbacked_action` do **not**
rise, and no increase in writes that end with nothing written.

**The corpus is a set of investigations, not a sample.** 8% is not a population
rate and must not be quoted as one.

---

## Not in this scope

- **The external STT.** Parked by owner decision 2026-09-20. It is the only fix
  for a mangled *yes*, but that now costs a repeated question rather than a lost
  booking. See the dead-ends entry for why the two cheaper substitutes were
  falsified.
- **Rewording anything.** Six failures.
- **`speakLine` / suppressing the model's sentence.** Measured on `CAfc89ebd3`
  as costing three unheard yeses and an unconsented write.
- **The "model gave up → release the write" backstop.** Designed but deliberately
  held: it belongs after this, and only if this does not make it unnecessary.

---

## Still open, unrelated, small

- `LVX159` — name occasionally lands in BLOCK CAPITALS. Intermittent, not
  systematic: `CAf4df02ef` spelled a name and stored `Nithin Dodla` correctly.
- *"I've confirmed that booking for you"* is invisible to the claim detector —
  `CLAIM_LOOSE_OBJECT` needs 1–3 words between subject and participle and this
  has none. Same class as LVX151.
- `write_order_ceiling_kept_by_history` is a process counter and not in the
  per-call `closing` ledger, so LVX161 cannot be attributed per call. One line.
- `LVX163` is fixed and **unproven live** — needs the model to bundle a write
  and a hang-up, which it has done once in seven calls.

---

## Verification, unchanged

`npm test` (217 files, 4160 passed, 2 skipped) · `node scripts/corpus/sabotage.mjs
--census` (61 rows, every anchor landing) · a sabotage row for every new guard ·
`npm run corpus:score` before and after · commit before running the matrix ·
never write regex through a bash heredoc.

Deploy: `CLOUDSDK_CONFIG=~/.gcloud-vetra2`, build in `vetra-core-edc8ca` as
`vetra-deployer@`, deploy to `voice-uk-prod` in `vetra-uk-edc8ca`,
`europe-west2`, set `GIT_COMMIT_SHA`. Currently `voice-uk-prod-00092-tbs`,
image `61891ce`; the migrate job runs `4b3be9d`.
