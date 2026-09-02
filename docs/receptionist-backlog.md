# Receptionist backlog — items to address

Written 2026-08-30 against `dev` @ `92d933f`. Owner-facing working ledger.

**What this is:** every outstanding item on the receptionist itself, with the
evidence behind it, what it costs, and what proves it done.

**What this is not:** an implementation plan. Items are scoped, not sequenced
into commits. Anything picked up gets its own plan.

**How to use it:** pick from P0 first — several are minutes of work standing in
front of wins already paid for. Update the item's `Done when` line to `DONE
<date>` rather than deleting it; the history is what stops the same thing being
re-litigated in three months.

## Merge tags

The GCP migration (`feat/gcp-2`) is 217 commits ahead, 338 files, +50,317/−6,139.
That sounds like everything is throwaway. It isn't — the divergence is
concentrated in the data layer, and receptionist logic is nearly identical.
Measured 2026-08-29:

| file | lines differing |
|---|---|
| `capabilities/appointments.js` | 4 |
| `config/voices.js` | 2 |
| `lib/transcriptUtils.js` | 2 |
| `capabilities/index.js` | 8 |
| `capabilities/messages.js` | 31 |
| `services/tools.js` | 37 |
| `lib/voice/session.js` | 146 |
| `services/gemini.js` | 267 (mostly the additive Vertex backend) |

So the split is **not** before/after GCP. It is **does this item touch the data
layer**. `services/supabase.js` (1,182 lines) is deleted on `feat/gcp-2` and
replaced by `services/db.js` (2,231 lines, Postgres + RLS).

- `[cheap]` — conversation logic. Do it on `dev` now; merges to `feat/gcp-2`
  nearly free.
- `[twice]` — touches the data layer, schema, or SMS. Doing it now means doing
  it again. Decide per item whether the near-term value is worth the double.
- `[gcp]` — only makes sense on the migration line. Do not start on `dev`.
- `[blocked]` — waiting on something outside the codebase.

**Three rules the tags encode:**

1. **No SMS/consent work on `dev`.** `capabilities/smsConsent.js` is 262 lines
   existing only on `feat/gcp-2`, where a recorded spoken yes is required before
   any caller-facing text. Work on `dev` there would not merge, it would
   contradict.
2. **No schema changes on `dev`** unless the item is worth writing the migration
   twice, against two different databases.
3. **Prompt snapshots regenerate, never merge.** Every file under
   `tests/__snapshots__/prompts/` differs between the lines. Delete and
   regenerate on the target branch.

## Priority tiers

- **P0** — now. Mostly free, or blocking a real judgement about whether the
  product works.
- **P1** — before the first paying customer.
- **P2** — after.

---

## §0 Standing facts (measured — do not re-derive without new data)

Every number here cost a probe run or a live call. They exist to stop the same
five arguments recurring.

| Fact | Value | Source |
|---|---|---|
| Voice-to-voice p50 | **2,607ms** (was 3,062ms pre-marker) | `docs/latency-and-tts-tests.md`, probe C |
| LLM TTFB p50 | 940ms (was 1,836ms) | same |
| TTS TTFB | 94ms — **3% of a turn, not a latency target** | same |
| Pacing pump / audio buffer | 0ms | same |
| Realistic latency floor | **~2.2–2.4s** without changing model | derived from the above |
| Prompt caching as a *latency* lever | **dead** — TTFT flat in prompt size (6 tokens ≈ 2,586 tokens ≈ 700ms) | probe, 2026-08-04 |
| Prompt caching as a *cost* lever | **live and unclaimed** — explicit cache gets 4,182 of 4,186 input tokens cached, ~94% from turn 2 | `scripts/verify-explicit-cache.js` |
| Explicit cache floor, **AI Studio** | 1,024 tokens — every business shape clears it | measured 2026-08-04 |
| Explicit cache floor, **Vertex** | **4,096 tokens — NO business shape clears it** (largest is 3,967) | measured 2026-08-30, see C1 |
| Vertex caching at `location: global` | **works** — 6,588-token cache created and read back at a full hit | same |
| `gemini-3.6-flash` on Vertex | serves at `global` only; 404s at `us-central1` and `europe-west2` | same |
| Input share of the Gemini bill | **~93%** | billing, 2026-08-04 |
| Prompt tokens per assistant turn | **~4,840**, mostly a ~3k static prefix re-sent every turn | `eval/results/*.json` |
| One full eval run | ~1.2M assistant tokens; **~1.7M all-in** with judge + persona caller | `eval/README.md` |
| A 5-run band | ~8M tokens ≈ **$10** | same |
| Implied rate | ~$1.15 per 1M tokens | owner's own bill |
| Eval hard-gate noise band | **39–42 of 43**, mean 41.0, spread 3 — re-measured 2026-08-31 at the current 43 scenarios. **Supersedes the 35–37 of 37 figure, which was recorded when the suite had 37.** Seven scenarios carry it now, not three: `ai-offers-to-caller-with-appointment`, `rambling-elderly` and `reschedule-two-appointments` at 2/5, plus `cancel-identity`, `intent-switch-midcall`, `second-appointment-allow`, `third-party-privacy` at 1/5. Judge band 42–43, spread 1 | `scripts/eval-band.js --band`, five cache-OFF runs |
| `npm run eval:compare` false-alarm rate | **85%** on unchanged code — do not use it as a gate | same |
| Turn-taking hold trade | **~340ms added latency per barge-in removed** | live calls, 2026-08-27 |
| July → August Gemini bill | $10 → $85, **1.7M → 47.4M** prompt tokens, ~28× | 2026-08-29 |
| Cause of that jump | **development evals, not production** (production is pre-launch, no live traffic) | same |
| Production traffic today | **none** — pre-launch | owner, 2026-08-04 |

### Vendor rates (looked up 2026-08-30 — re-check before quoting)

| Vendor | Rate |
|---|---|
| Gemini 3.6 Flash (yours) | in **$0.75/M**, out **$3.75/M**, **cached in $0.075/M**, cache storage **$0.50/M/hr** |
| Gemini 3.1 Flash Live | audio in **$3/M = $0.005/min**, audio out **$12/M = $0.018/min**, text in $0.75/M |
| Deepgram nova-3 streaming | **$0.0077/min** |
| ElevenLabs Flash v2.5 | **$0.05/1k chars** at volume; ~$0.10/1k on Creator/Pro tiers |
| Twilio inbound US local | **$0.0085/min** |
| OpenAI `gpt-realtime-2.1` | audio in $32/M, out $64/M, **cached audio in $0.40/M**. Mini: $10/$20 |

### Per-call economics — 3-min / 10-turn call

| Fact | Value | Source |
|---|---|---|
| Your cost per call | **~$0.161 uncached · ~$0.130 with the cache on** | rates above × measured tokens |
| **Largest single line** | **ElevenLabs — 47% uncached, 58% of the cached total** | same |
| Gemini line after caching | ~$0.006 — **the model is not your cost problem** | same |

### Gemini Live — measured 2026-08-30, not assumed

Two probes against `gemini-3.1-flash-live-preview` with your real 2,890-token
prompt prefix and your own `test-audio/caller/*.ulaw` recordings. Scripts and
raw JSON are in the session scratchpad, not the repo.

| Fact | Value |
|---|---|
| **Live re-bills the whole accumulated context every turn** | audio prompt tokens **47 → 827 over 6 turns**, monotonic |
| The accounting is exact | each turn's delta = *new caller audio + previous model output*, matching prediction **within 1–3 tokens** every turn |
| Audio tokenization rate | **24.7 tokens/sec** (not the 32 quoted in some docs) |
| **The static prefix dominates** | **85%** of all prompt tokens (17,675 of 20,754 across 6 turns) is the re-sent system prompt |
| `contextWindowCompression` | **works** — caps audio growth at ~200 (47→106 vs 47→827) — but at `triggerTokens: 3100` the model retains ~1 turn. Saving and forgetting are the same dial |
| **Text reseed** | 3 turns of history = **67 text tokens** vs **426 audio tokens**. Same information, 6.4× cheaper, nothing forgotten |
| Live cost, 3-min call | baseline **$0.136** · reseed every 3 turns **$0.096** · reseed + prefix halved **$0.085** |
| Cost shape | your pipeline is **linear** in call length; Live is **quadratic**. Crossover ~3 min |
| `cachedContentTokenCount` | **zero on every turn** — no audio-input cache discount exists today (OpenAI already offers one at $0.40/M) |

---

## §1 P0 — shipped work that is currently inert

The highest ratio in the project. The code is written, tested, and merged. It is
switched off.

### P0-1 · Audit the voice flags in every environment `[cheap]`

Several fixes ship behind flags that default to old behaviour. Nobody has
confirmed what Railway actually holds, and the local `.env` sets **none** of
them.

Code defaults, verified 2026-08-30:

| Flag | Code default | Wanted | Worth |
|---|---|---|---|
| `VOICE_HOLD_TRAILING_MS` | `0` = **off** (`lib/transcriptUtils.js:248`) | `800` | Round 2's headline fix. Cutoffs 50% → 12.5% in the sim. **At 0 it does nothing.** |
| `VOICE_INTENT_MARKER` | `false` (`services/gemini.js:248`) | `true` | ~900ms. Believed ON in Railway, **never confirmed** |
| `GEMINI_EXPLICIT_CACHE` | `false` (`services/geminiCache.js:85`) | `true` **after the band** | ~84% off the Gemini line; ~19% off a whole call |
| `GEMINI_CACHE_TTL_S` | `900` (`services/geminiCache.js`) | `900` | per-CALL lifetime; 3600 would rent storage between calls |
| `VOICE_BARGE_MIN_WORDS` | unset = 4 (`lib/voice/turnManager.js:220`) | `2`, after C-gate | ~1.2–1.6s of overlap before barge-in reacts |
| `VOICE_SPELL_POLICY` | `always` (`lib/nameQuality.js:162`) | confirm intended | widened in round 3 |
| `VOICE_ABORT_ON_RESUME` | ON (`lib/voice/session.js:116`) | ON | ships on deliberately |
| `VOICE_CONFIRM_HARD_NAMES` | ON (`services/tools.js:35`) | ON | ships on deliberately |
| `STT_ENDPOINTING_MS` | `150` (`lib/voice/sttStream.js:88`) | `150` | −166ms already banked in code |
| `VOICE_LLM_SLOW_MS` | `2500` (`lib/voice/llmTurn.js:122`) | `2500` | round 2 value |
| `PIPELINE_V2` | v2 unless `="false"` (`server.js:877`) | v2 | see O5 |

Round 2 already lost two attempts to flags set on the **wrong Railway service**.

- **Effort:** 30 min, plus one call to confirm.
- **Done when:** a table of flag → value exists per environment (Railway prod,
  Railway staging, local), and `/api/debug/latency` counters show
  `trailing_incomplete` firing on a live call.
- **Note:** `lib/probe/report.js:42` still says `STT_ENDPOINTING_MS` defaults to
  300. Stale by one change. Fix while you're in there.

### P0-2 · Run the six round-3 test calls `[cheap]`

Round 3 (the `{reason:}` leak, the doubled goodbye, date-without-time, spelling)
shipped to `origin/dev` on 2026-08-29 and is **verified offline only**. The six
calls that decide it are already written up in
`docs/receptionist-round3-test-calls.md`.

- **Effort:** ~1 hour of calls, using `+18176011171` against Railway staging.
- **Done when:** each of the six has a pass/fail recorded, with the counters
  read from `/api/debug/latency` between calls.
- **Blocker to watch:** a push mid-testing is a Railway deploy is a server
  restart. Do not push while calling.

### P0-3 · Hear what a capability refusal sounds like `[cheap]`

**The highest-value untested thing in the project.** Config → tools → refusal is
proven by tests and `scripts/verify-capabilities.js`. But nobody has ever
*heard* the model when a requirement blocks it mid-call. The expected failure
mode is a refusal loop: technically enforced, call ruined. Round 3 already found
one shape of this offline — a spelling gate that fired after the caller said
"yes, that's all correct, thanks", then never retried the write, so **the
message was never recorded at all**.

- **Effort:** 3–4 calls against a business configured to refuse (e.g. require a
  custom identity field, then don't supply it).
- **Done when:** a transcript exists for each refusal path, and any loop found
  has an issue filed with the turn that caused it.
- **Depends on:** P0-1 (so you're testing the intended behaviour).

---

## §2 Cost

Three separate cost problems. Two of them are not the one that generated the
$85 bill.

### C1 · Turn on the explicit Gemini cache `[cheap]` · P0

> **VERTEX PROBE RESULT, 2026-08-30 — measured, ~$0.02 spent.** Two findings,
> both blocking for the GCP arm and neither one guessable:
>
> 1. **Vertex explicit caching WORKS at `location: global`.** Created a 6,588-token
>    cache on the scratch project and read it back at `cachedContentTokenCount:
>    6588` — a full hit. The `global` endpoint is not the problem.
> 2. **But the Vertex floor is 4,096 tokens, four times AI Studio's 1,024 — and
>    NOT ONE business shape in this repo reaches it.** `countTokens` over every
>    fixture's real cache unit (static prefix + tool declarations):
>
>    | fixture | chars | tokens |
>    |---|---|---|
>    | `appointments-availability` | 19,222 | **3,967** ← largest, 129 short |
>    | `clinic-athena` | 18,974 | 3,802 |
>    | `appointments-db` | 18,160 | 3,747 |
>    | `modules-and-webhook` | 14,284 | 2,957 |
>    | `messages-only` | 12,970 | 2,749 |
>
> **So caching saves ~19% of a call on the current API-key deployment and saves
> nothing at all after the GCP cutover.** Handled, not hidden: the size floor is
> now read off the SDK client's own `vertexai` flag, so Vertex skips the attempt
> instead of eating a 400 per tenant, and logs `gemini_cache_below_vertex_floor`
> at warn severity. It does not make caching work there.
>
> **C1 and C2 are in direct tension on Vertex.** Shrinking the prefix moves every
> tenant further below the cache floor. On AI Studio they multiply; on Vertex
> C2 kills C1. Decide which backend you are optimising before doing C2.
>
> **Separately, `vetra-uk-edc8ca` cannot create a cache at all yet**, for an
> unrelated reason: `constraints/gcp.resourceLocations` rejects it with
> `FAILED_PRECONDITION` — "The project 462445274080 failed the org policy
> enforcement check". `gemini-3.6-flash` also 404s at `europe-west2` and
> `us-central1`, so `global` is the only endpoint that serves it, and `global`
> is what the location policy refuses. That needs an org-policy decision, not a
> code change — and it is worth resolving regardless of caching, because it is
> the first evidence that the location constraint blocks a Vertex resource the
> product wants.

> **BAND RESULT, 2026-08-31 — 5 runs per arm, arms interleaved, judge off,
> $6.05 assistant-side.** Files `eval/results/band-{off,on}-{1..5}.json`.
>
> **No significant hard-gate regression.** Per-scenario one-sided Fisher: not one
> scenario reaches p<0.05. The closest is `cancel-identity` at 1/5 -> 3/5,
> p=0.26.
>
> | | per-run hard pass | mean |
> |---|---|---|
> | OFF | 42, 40, 39, 42, 42 | **41.0** |
> | ON | 39, 38, 41, 40, 39 | **39.4** |
>
> **Read the direction, not just the p-values.** 9 scenarios got worse, **5 got
> better**, 29 unchanged. A sign test on those 14 gives p~0.21 — the tilt is not
> one-directional and does not clear significance either. The 1.6-point mean gap
> sits inside a baseline arm that itself spans 39-42. **This is a noise-dominated
> result, not a clean pass and not a regression.**
>
> **One mechanism IS identified and is worth fixing regardless of caching.**
> `services/gemini.js:999` reads: *"You may still book appointments for future
> business hours using book_appointment. Do NOT book appointments during closed
> hours."* That second sentence has two readings — don't schedule a slot inside
> closed hours (intended), or don't perform bookings while closed. As a system
> instruction the model takes the first; demoted to user-role content under a
> cache it sometimes takes the second and refuses to book at all, diverting to a
> callback. Confirmed in a `name-recall` transcript diff. Normalised per run:
> `book_appointment` 20.3 -> 17.7, `record_customer_request` 3.0 -> 5.3, turns
> per run 234 -> 253 (calls run longer because the booking never lands). Small n
> — corroboration, not proof.
>
> **The saving is real and larger than expected: 66% per eval run** ($0.902 ->
> $0.307), 77-78% of prompt tokens cached. Since production is pre-launch with
> **no live traffic**, that saving today is on DEVELOPMENT spend — which is
> exactly what produced the $10 -> $85 bill.

> **SECOND BAND, 2026-08-31 — cache ON *plus* the after-hours prompt fix
> (`83be36f`), against the SAME baseline. $1.55.** Files `band-fix-{1..5}.json`.
>
> | arm | per-run hard pass | mean |
> |---|---|---|
> | OFF (current production) | 42, 40, 39, 42, 42 | 41.0 |
> | ON, old prompt | 39, 38, 41, 40, 39 | 39.4 |
> | **ON + fix** | 41, 38, 42, 41, 41 | **40.6** |
>
> **The fix recovered the booking flows it was aimed at** — fails per 5 runs:
>
> | scenario | off | on | on+fix |
> |---|---|---|---|
> | `cancel-identity` | 1 | 3 | **0** |
> | `long-call-memory` | 0 | 2 | **0** |
> | `own-slot-not-taken` | 0 | 2 | **0** |
> | `name-recall` | 0 | 2 | 1 |
> | `changes-mind` | 0 | 2 | 1 |
> | **total** | **1** | **11** | **2** |
>
> The mean gap to baseline closed from 1.6 to **0.4**, against a baseline arm
> that itself spans 39-42. Still 9 worse / 5 better by scenario count, but the
> shape changed completely: under the old prompt the damage was concentrated at
> 0->2 in booking flows, and it is now scattered 0->1 singletons across unrelated
> scenarios (`date-without-time`, `what-software-do-you-use`,
> `no-invented-appointment`). That is the signature of noise, not a mechanism.
>
> **VERDICT: cleared to ship.** No significant hard-gate regression, the one
> identified mechanism is fixed and its scenarios recovered 11 -> 2, and the
> saving is 66% per run. Remaining: merge to `main` and set
> `GEMINI_EXPLICIT_CACHE=true` in Railway (owner).

**STATUS 2026-08-30 — code complete on `dev`, gate outstanding.** Shipped in
this pass: `buildCacheSpec()` as the single source of the cache key shared by
the turn path and the new `warmPromptCache()`; a pickup-time warm chained off
`state.contextPromise` so turn 1 hits too; TTL default 3600 → **900 (per-call)**;
`llm_cache_hits` / `llm_cache_misses` counters; and `scripts/verify-explicit-cache.js`
taught to run against Vertex. Tests: `tests/geminiCache.test.js` (warm/turn key
agreement, proven able to fail), `tests/session.test.js` (warm ordering),
`tests/geminiCacheCounters.test.js`. Full suite green, `sim:cutoff` unchanged.
**What is left is the eval band and the Vertex probe — nothing else.**

The single largest production-cost lever, already built, measured, and off.
Input is ~93% of the Gemini bill; explicit caching covers ~94% of input from
turn 2; a call is ~10 turns sharing one prefix, so a cache repays inside one
call.

It ships off for a real reason: under a cache the dynamic tail moves from
`systemInstruction` into the message, which is a **prompt-behaviour change unit
tests cannot see** (`services/gemini.js:1182`).

- **Gate:** eval band, 5 runs per arm, off vs on. ~8M tokens per arm ≈ **$10
  per arm, ~$20 total.** Use `scripts/eval-band.js`, **not** `eval:compare`.
- **Watch:** `scripts/verify-explicit-cache.js` compared arms at N=1 and gave
  opposite verdicts on consecutive runs. `temperature: 0` does not make function
  calling deterministic. Report `k/N`, never a verdict.
- **Effort:** ~1 hour of setup, ~1 hour of runtime, $20.
- **Done when:** Fisher exact per scenario shows no significant regression, and
  the flag is on in production with cache-hit tokens visible in the logs.

**Build it as a PER-CALL cache, not a persistent per-business one.** Rates
looked up 2026-08-30: cached input is **$0.075/M vs $0.75/M** — a 90% cut on the
cached portion — but cache **storage is $0.50/M tokens/hour**. A ~4,200-token
prefix held continuously is ~$1.53/month per business, needing **~49 calls/month
to break even**. A cache created for the duration of one call costs ~$0.0001 and
has no break-even at all. Only give a busy tenant a long-lived cache, and only
once C4 can show the call volume.

**Revised value:** this takes the Gemini line from ~$0.037 to ~$0.006 per call.
Worth doing — but see C4: it makes ElevenLabs, not the model, your largest cost.

### C2 · Shrink the ~3k static prefix `[cheap]` · P1

~4,840 prompt tokens per turn, mostly the same static prefix re-sent. C1 makes
that prefix ~75–80% cheaper; C2 makes it smaller. They multiply. Do C1 first —
if the cache lands, the ceiling on C2's value drops and it may not be worth the
regression risk.

- **Do not** do this as a prompt reword without an eval band. A previous
  "harmless" reword cut tool calls and saved 185ms while regressing
  `name-recall`, `vague-caller` and `cancel-identity`.
- **Effort:** unknown until C1 lands. Measure prefix composition first — which
  sections are per-business, which are constant across every tenant.
- **Done when:** tokens-per-turn is measured before and after, with an eval band
  showing no regression.

**Promoted 2026-08-30 — this is architecture-independent, and it is the largest
lever on Gemini Live too.** Measured in the Live probe: **85% of all prompt
tokens (17,675 of 20,754 across 6 turns) were the re-sent 2,890-token prefix.**
Live re-bills it every turn exactly as the current pipeline does. Whatever you
decide about §9, halving the prefix pays on both stacks, and it is the one cost
item with no architectural risk attached.

### C3 · Stop dev/eval spend being the biggest line item `[cheap]` · P0

**STATUS 2026-08-30 — the two headline items are done on `dev`.** The advisory
judge is now OFF by default (`--judge` opts back in; `--no-judge` still parses),
and every run prints its cost and writes a `cost` block into the results JSON.
Remaining: the cheaper pinned model for the judge and the persona caller.

**The actual cause of $10 → $85.** July 1.7M prompt tokens, August 47.4M. One
session on 2026-08-29/30 accounted for ~24M tokens, ~35% of the month, ~$25–30,
run without ever mentioning cost.

- ~~`npm run eval -- --no-judge` exists (`eval/run.js:133`). It should be off by
  default while iterating~~ **done** — the default is now off. The advisory judge
  re-sends the whole transcript once per question per scenario and **never gates
  the exit code**.
- `--filter <scenario>` is nearly free and should be the default habit.
- Consider a cheaper pinned model for the judge (`eval/judge.js`) and the persona
  caller (`eval/simCaller.js`) — neither needs the production model's quality.
- Running the eval harness under the explicit cache needs no work: the harness
  goes through `getReplyStreaming`, so `GEMINI_EXPLICIT_CACHE=true` covers the
  ~240 prefix re-sends per run for free, and the printed cost report shows the
  cached share and what it saved.
- **Standing rule already agreed:** state token count and dollar cost before any
  eval/probe run, and get permission.
- **Effort:** 2–3 hours.
- **Done when:** ~~a full run's cost is printed by the harness at the end of
  every run~~ **done**, and `eval/README.md`'s cost table matches reality — still
  open, the table's ~1.16M/~1.7M figures predate the cache and want a re-measure
  once the flag is on.

### C4 · Build the `$/call` metric `[twice]` · P1

There is no per-call cost figure anywhere. Gemini, Deepgram, ElevenLabs, Twilio
and hosting are five bills and nobody can say what one call costs. **You cannot
price the product without this, and you cannot tell whether C1 worked in
production.**

- Token counts are already available per turn; TTS characters are countable
  (`tts_fallback_turns` already exists); Twilio and Deepgram are per-minute
  against a known call duration.
- `[twice]` because it wants a column on the calls table.
- **Effort:** 1 day, most of it deciding where the number lives.
- **Done when:** a call row carries a cost estimate broken down by vendor, and a
  10-call sample reconciles to within ~10% of the actual bills.
- **Feeds:** D4 (showing it in the dashboard), and any pricing decision.

### C5 · Revisit model tier once C1–C4 land `[cheap]` · P2

Only worth opening with the $/call metric in hand. LLM is ~36% of turn time and
the majority of variable cost; it is also the thing most likely to break quality
if changed. **Do not touch until C4 can prove what was saved.**

---

## §3 Latency

The big architectural win is banked. What's left is smaller and mostly trades
against conversation quality.

### L1b · The one voice flag that differs in production `[cheap]` · P0

Reported 2026-08-31: production is the same as staging "except for debug items,
and maybe one voice item". Nobody knows which. Every conclusion drawn from a
staging call, and every simulator row read as "what production does", is
conditional on that answer — as the `VOICE_HOLD_TRAILING_MS` correction in L2
demonstrates, where a flag set in one environment and defaulted in another
turned a measured baseline into fiction.

- **Done when:** the two environments' voice flags are diffed and the difference
  is either named and justified or removed.

### L1 · Confirm `VOICE_INTENT_MARKER` in Railway — see P0-1 `[cheap]` · P0

~900ms, free, never confirmed on that environment. Listed here because "the AI
feels slow" complaints should check this **before** any diagnosis.

### L2 · Semantic end-of-turn detection `[cheap]` · P1 — HALF SHIPPED 2026-08-31

The residual from round 2, verified on live calls: **a pause longer than the
hold still gets talked over.** A hold cannot out-wait a slow caller. Raising it
is not the answer — measured, 800ms → `barge_ins` 3, p50 2,322ms; 1,200ms →
`barge_ins` 2, p50 2,663ms. That is ~340ms of latency per barge-in removed, and
it trades straight against the "asks stacked questions / feels slow" complaint.

Real fix is semantic: decide the caller is done from *what they said*, not from
how long they've been quiet. `TRAILING_INCOMPLETE` (round 2) is the cheap
first version of this and already works — it sits above the punctuation branch
and costs a completed turn nothing.

**Update 2026-08-31, corrected same day.** The cheap half was already written:
`VOICE_HOLD_TRAILING_MS` defaulted to **0**, so it shipped inert in round 2 to
land without behaviour risk. The default is now 800.

**The correction matters more than the change.** This was first written up as
"the rule had never fired on a real call". It had — staging has had
`VOICE_HOLD_TRAILING_MS=800` set in its environment all along. What was inert
was the DEFAULT, and therefore every environment that never set the flag: local
dev, the test suite, and `sim/cutoffSim.sim.js`.

So the simulator was modelling an environment that did not exist. Its
`punctuated finals @150ms / 50% cutoffs` baseline was never staging's
behaviour; staging was already on the 12.5% row. **A sim row only means
"production" if the flags match, and nobody had checked.** That is P0-1's whole
subject, and it turned a piece of evidence into a piece of fiction without
anything looking wrong.

Two live consequences, both on staging, both predating this branch:
- The false positives the split fixes — "No, that's all I need." taking an
  800ms hold before the goodbye — were **already happening**.
- `TRAILING_LEAD_IN` matched `i need` and `i want`, so the same sign-off took
  **2000ms** on an older rule — flag-independent, so live everywhere including
  production. **FIXED 2026-09-01**, split the same way: "my name is" still
  holds, "that's all I need" does not. The fluent control now carries that
  utterance and asserts on it, and the assertion was confirmed to fail with the
  split disabled. This was the longest hold in the system landing on the
  goodbye of every call that ends that way.

Production is reported as identical to staging "except for debug items, and
maybe one voice item" — that one unconfirmed voice flag is unresolved and is
the remaining P0-1 work.

The numbers, same script, same pauses, same endpointing, flag the only variable:

```
punctuated finals @150ms    8 turns  4 cutoffs  50.0%  reply 1260ms
punctuated + trailing 800   8 turns  1 cutoff   12.5%  reply 1260ms
fluent (control)            5 turns  0 cutoffs   0.0%  reply 1260ms
fluent + trailing 800       5 turns  0 cutoffs   0.0%  reply 1260ms
```

The sim's "off" arms had to be pinned to 0 first: they omitted the knob and
inherited the module default, so moving that default would have turned the
control rows into copies of the treatment rows and the matched pair would have
compared 800 against 800. **A control arm that tracks the thing it is
controlling for is not a control** — worth checking the other sweeps in that
file for the same shape.

The model half (`lib/voice/endpointArbiter.js`) is built and wired but
**shipped dark** behind `VOICE_SEMANTIC_ENDPOINT`. It runs concurrently with
the hold that was going to run anyway and can only shorten or extend it; a
late, failed or unparseable answer means no opinion and the timer is untouched.

**It is an accuracy fix, not a latency fix.** p50 is 3,062ms and endpointing
plus hold is ~500-650ms of it, so even perfect detection is worth a couple of
hundred ms. Anyone reaching for this to make the assistant feel faster is
reaching for the wrong item — see L1 and §9.

- **Effort:** the free half is done. Enabling the arbiter is a flag plus a
  costed estimate plus a live call.
- **Measured by:** `npm run sim:cutoff` — free, deterministic (verified across 5
  identical runs), and it already reports both cutoff rate **and** the reply
  latency cost, which is what stops a "hold everything for 3s" non-fix reading
  as a win.
- **Blocked on, for the arbiter half:** nobody has measured what a model call
  per hesitant turn costs. `semantic_endpoint_flushed` / `_extended` both at
  zero with the flag on does NOT mean the model agreed with us — it means no
  verdict ever arrived inside its hold. Failing open makes "too slow" look
  exactly like "not needed".
- **Done when:** a live call confirms the trailing hold, and the arbiter is
  either enabled on a costed number or closed as not worth it.

### L3 · Barge-in minimum words 4 → 2 `[cheap]` · P1

Currently ~1.2–1.6s of caller speech overlaps before anything reacts. The gate
is 4 because `echoGuard.classify()` cannot judge fewer tokens — but
`echoGuard.isShortEcho()` (exact containment) already solves the echo case and
is now wired to the interim path. Guarded by
`VOICE_BARGE_SHORT_MIN_VOICED_MS` (350) and `VOICE_BARGE_SHORT_MIN_CONFIDENCE`
(0.75), which apply **only** to the newly-admitted band.

- **Effort:** the code exists; this is a flag plus a sim run plus a call.
- **Done when:** sim shows no rise in false interrupts, and a live call with a
  speakerphone confirms the AI does not interrupt itself.

### L3b · Warm caller dossier — instrumented 2026-08-31, NOT built `[twice]` · P2

Asked for as: prefetch everything about the caller at pickup — appointments
now, prescriptions and quotes later — so "when is my appointment?" is answered
from memory instead of a lookup. Three separate items wearing one coat.

**The prefetch already exists.** `lib/voice/session.js` fires four parallel
Supabase reads at the `start` event, unawaited, and `fetchCallerContext`
returns the caller's upcoming appointments. **No lookup tool reads it.**
`get_caller_appointments_from_db` re-queries through `listAppointmentsByCaller`
— the same function that built the snapshot.

**The cost is not a database round trip.** `services/gemini.js` sends tool
results back to Gemini for another streaming round, so a lookup whose answer we
already had costs a whole extra model turn. That is the number worth chasing,
and it is not the one the request assumes.

Instrumented rather than fixed, because nobody has measured how often it
happens:

- `lookup_tool_context_warm` / `_cold` — a caller-appointment lookup running
  while the snapshot already held rows. Declared as `pack.callerLookupTools` so
  the engine counts it without knowing any tool's name. Warm is a deliberate
  upper bound: an upper bound that comes back small closes the question.
- `context_wait_ms` — split out of `stt_tail_ms`. `startTurn` awaits
  `ensureContext()` before stamping `speech_end` (from the true end of speech)
  and `stt_final` (from "now"), so the prefetch wait has always been billed to
  the speech-to-text tail. Any widening of the prefetch would have made that
  worse and stayed just as invisible.

Three sub-items, three different answers:

1. **Serve the lookup from `ctx.callerContext`, and stop the model burning a
   round on data already in its prompt.** Worth doing if the counters say it is
   frequent. `capabilities/appointments.js` already states the principle —
   "Read from `ctx.callerContext`, never re-queried… a Supabase round trip
   inside a tool round would be latency they hear" — and the booking guard obeys
   it while the lookup tool does not. That is an inconsistency, not a new design.
2. **A generic pack `prefetch()` hook for future data types.** Premature. There
   is no pack lifecycle hook of any kind today and no second consumer to shape
   it. Build it when the second data type arrives and let that one prove the
   design — the argument `capabilities/quotes.js` makes about its own seam.
3. **Speculative fan-out to business webhooks / EHR.** No, and not without
   prerequisites. Every webhook is POST or PUT (`ALLOWED_METHODS` in
   `integrations/webhook.js` has no GET) and nothing marks a tool read-only:
   `capabilities/_contract.js` declares `isLookup` for exactly this and
   **nothing in the codebase reads it**. Firing a business's write-capable
   endpoint for every inbound call — wrong numbers and hangups included — is a
   bad idea on its own terms.

**Disclosure is a separate gate from prefetch, and must stay one.** Caller ID
is spoofable and handsets are shared. `services/gemini.js` NON-NEGOTIABLE
RULE 4 and `appointments.js appointmentBelongsToCaller` are the current policy;
note that `=== CALLER CONTEXT ===` already puts the caller's name and
appointment times into the prompt on turn 1 with no identity check, and only
the *speaking* of them is restrained — by prose. A dossier makes that far
easier to leak, because the data is right there and the model is helpful by
default.

- **Done when:** the counters have a number, and item 1 is either built or
  closed on it.

### L4 · Decide the per-call day-slot cache `[cheap]` · P2

Deliberately not built in round 3, and correctly so: the date-only path
(`findSlots`) and the point check (`countScheduledOverlapping`) are different
queries, so the cache only helps a repeat miss. The instrumentation to decide it
now exists — `llm_tool_call_ms`, `tool_exec_ms`, per-tool `tool_duration`.

- **Done when:** the logs say what fraction of turns pay a repeat slot query. If
  it's small, **close this item as not worth doing** and record the number.

### L5 · Measure, don't assume, what GCP does to latency `[gcp]` · P1

You asked whether moving to GCP is a latency lever. **Unknown, and currently
unmeasurable** — Railway staging runs the `main` lineage and lacks the 35
behaviour commits on `feat/gcp-2`, including Vertex, Deepgram EU, and the TTS
opening change (1.5s less silence per turn). A good staging result is not a
prediction about GCP.

Three things could move either way:
- **Vertex vs the API-key path** — different endpoint, unmeasured TTFB.
- **Deepgram EU + europe-west2** — shorter hop for UK callers, longer for US.
- **`cpu_idle=true`** — chosen for budget (~$70/mo otherwise). It can add
  cold-start latency to the first turn. This one is a **known open risk**, and
  the migration plan already says to verify turn timing on a live call.

- **Done when:** the probe harness has run against the GCP stack and
  `true_v2v_ms` p50 sits beside the Railway number in
  `docs/latency-and-tts-tests.md`.

### L6 · The only remaining large latency lever is architectural — see §9

L1–L5 are worth low hundreds of milliseconds between them. The pipeline's floor
is **~2.2–2.4s** and every cheap lever is spent: the intent marker is banked
(−900ms), TTS is 94ms of the turn, pacing is 0ms, and `classifyHold` does not
fire on real speech. `llm_ttfb` is ~36% of the turn with nothing left short of
changing model.

Speech-to-speech removes the serial STT→LLM→TTS chain and the endpointing wait
entirely. **That is the only remaining step change, and it is §9.** Do not
promise a caller-noticeable latency improvement from anything in §3.

---

## §4 Business-type coverage

Your constraint: **one Twilio number, cycled between configs.** No number per
demo business. The work is therefore config fixtures and a swap mechanism, not
telephony.

### M1 · Define the matrix `[cheap]` · P0

Today five prompt archetypes exist (`tests/__snapshots__/prompts/`):
`appointments-availability`, `appointments-db`, `clinic-athena`,
`messages-only`, `modules-and-webhook`. The eval suite's 43 scenarios run
against a narrow slice of them.

**This gap has already cost a live bug.** The "repeat the name back" behaviour
Ilija reported missing *already existed* — but only in the branch that renders
when the scheduling adapter has **no** `checkAvailability` (athenahealth,
webhook). Every tenant on the built-in calendar got the other branch, which never
mentioned the name. Dead code for exactly the tenants who complained. Testing it
on the `clinic-athena` fixture would have **passed and proved nothing**.

Proposed axes — the point is the *conditions*, not the industry names:

| Axis | Values |
|---|---|
| Vertical | medical clinic · HVAC/trades · law office · salon/spa · retail/service counter |
| Appointments | on (internal calendar) · on (EHR/athena) · on (webhook) · **off** |
| Identity requirements | none · name only · name + DOB · custom field (e.g. policy number) |
| Transfer | never · always · conditional |
| Hours | open · closed (after-hours path) · 24/7 |
| Other capabilities | quotes on/off · messages on/off |
| Locale | en-US · en-GB |

- **Effort:** half a day to write the matrix and mark which cells are already
  covered.
- **Done when:** the matrix exists in this repo with a covered/uncovered mark per
  cell, and the uncovered cells are ranked by how likely they are to be a real
  customer.

### M2 · One-command config swap on the single number `[twice]` · P1

There is **no seed/import tooling on `dev`** — `scripts/import-tenant.js` exists
only on `feat/gcp-2`. Today swapping a demo business means editing rows by hand.

- Build `scripts/seed-demo-business.js <archetype>`: writes the business row,
  capability rows, hours, knowledge base, and repoints the number's config.
- `[twice]` because it writes to the data layer.
- **Effort:** 1 day.
- **Done when:** `node scripts/seed-demo-business.js hvac-no-appointments` then
  one phone call demonstrates that vertical end to end, and swapping back takes
  one command.

### M3 · Extend prompt snapshots per archetype `[cheap]` · P1

Snapshots are the drift gate and already caught a real regression (an EHR clinic
silently given the internal-DB flow). Each new archetype in M1 gets one.

- **Effort:** cheap per archetype — the harness exists.
- **Done when:** every matrix row with a distinct prompt shape has a snapshot.

### M4 · Extend eval scenarios per archetype `[cheap]` · P1

Especially the **non-appointment** paths, which are thinly covered: a business
that only takes messages, only quotes, only transfers, or only answers
questions. Those are real customers (your HVAC and law-office cases) and the
booking-shaped scenarios say nothing about them.

- **Cost:** each new scenario adds to every future run. 43 scenarios ≈ 1.2M
  tokens; budget accordingly and lean on `--filter`.
- **Done when:** each non-appointment archetype has at least one scenario that
  fails if its capability is silently mis-gated.

### M5 · Instrument debt — the tests that cannot fail `[cheap]` · P1

Found repeatedly. Each of these makes a green suite mean less than it looks:

- **The advisory judge has standing failures nobody sees.** `impatient-booker`,
  `long-call-memory` and `reschedule-two-appointments` fail the judge in **5 runs
  of 5** — invisible because the judge never sets the exit code.
- **`npm run eval:compare` cannot be used as a gate** — 85% false alarms on
  unchanged code. Use `scripts/eval-band.js`. Consider deleting `eval-compare.js`
  so nobody reaches for it.
- **Scripted callers encode the behaviour they were written against.** Change a
  prompt and they desynchronize, and the failure reads as a product regression.
  `eval/scenarios/19-long-call-memory.js` turn 20 answers a spelling question
  that may no longer be asked.
- **`maxTurns` defaults to 8** (`eval/run.js:246`). Anything that makes calls
  legitimately longer pushes tight scenarios over budget — and
  `replyMatchesBeforeTool` **passes vacuously when its tool was never called**,
  so a turn-budget failure silently weakens an ordering assert instead of
  failing it. Pair it with `toolSucceeded`.
- **Judge-only scenarios render `✗` forever** (`eval/run.js:352`: `0 &&` is
  falsy). Cosmetic, but it trains you to ignore a red mark.
- **A harness that prints without asserting is documentation.** `sim/cutoffSim.sim.js`
  once asserted only its row count while printing the number that mattered.

- **Done when:** the judge's standing failures are either fixed or explicitly
  marked as known-failing with a reason, and no instrument in `eval/` or `sim/`
  reports a number it does not assert.

---

## §5 Capabilities

You said building capabilities caused unforeseen issues before. The architecture
that came out of that is sound and is documented — kinds vs values, packs +
adapters, schema-driven dashboard. The open items are gaps in it, not a
redesign.

**The rule that settles most "should this be config or prose" arguments:** *if
the AI ignores this, does someone get hurt, sued, or angry?* Yes → code. No →
text box. Prompt text is never a guarantee.

**The corollary that has bitten twice:** a rule about the model's own earlier
behaviour ("ask this at most once") does not hold across a long call. Count it
in code, in the **shared reducer**, and state the result to the model as an
accomplished fact. A cap the eval harness cannot see is a cap that regresses
silently — that is exactly how a nine-turn spelling livelock survived a green
suite.

### K1 · Missing-row asymmetry `[twice]` · P0

A business with **no** `business_capabilities` row shows **OFF** in the
dashboard but the engine falls back to `allowed_tasks` (default
`["book_appointment"]`) and **books anyway**. Verified: `applyCapabilityRows`
returns `allowedTasks` unchanged when `rows.length === 0`
(`services/supabase.js:163-166`).

Every new demo business in M2 walks straight into this.

- **Fix:** backfill migration seeding rows for every existing business, then
  drop the `allowed_tasks` fallback (K2).
- **Effort:** half a day.
- **Done when:** a business with no rows books nothing, and the dashboard and
  the engine agree on every tenant.

### K2 · Retire `allowed_tasks` `[twice]` · P1

Legacy column, still the dual-read fallback. It is the reason K1 exists and the
reason "I disabled it and it still shows in `allowed_tasks`" is confusing but
expected. Blocked on K1's backfill.

### K3 · Webhook scheduling adapter — build it or delete it `[cheap]` · P1

`adapters/scheduling/webhook.js` is a **stub with a null `book()`**, hidden from
the dashboard via `selfServe: false` (`webhook.js:20-23`). It is currently a
trap: it exists, has a prompt archetype and a snapshot, and cannot book.

- **Decide:** is "post to the customer's own endpoint" a real product path? If
  yes, build it; if no, delete the adapter and its archetype.
- **Done when:** either a webhook business books end to end, or the file is gone.

### K4 · Google Calendar as a real scheduling adapter `[twice]` · P1

Today calendar sync is a **dashboard-side worker** (`calendarSync.js`, ~90s
interval) that pushes appointments out after the fact — not a scheduling adapter
the engine reads availability from. It is **unverified live** (Norton blocked
outbound HTTPS locally, `GOOGLE_CLIENT_ID` unset), covered by unit tests only.

The seam for the real thing already exists: `internal.js` implements
`checkAvailability`/`findSlots`, and an adapter that reads a Google Calendar
plugs into the same interface.

- **Why it matters commercially:** an HVAC or salon owner already lives in Google
  Calendar. "It reads my actual calendar" is a different product from "it writes
  into your dashboard and syncs later".
- **Done when:** a booking made on a call appears in a real Google Calendar, and
  a busy block in that calendar makes the AI decline the slot.

### K5 · athenahealth `verify_against` `[blocked]` · P2

Blocked on production access. Note the historical bug so it isn't reintroduced:
athena write tools were **not** in `actionTools` and therefore unwrapped, so
identity/confirm/business-hours were not enforced on clinics. Fixed; keep it
tested.

### K6 · Refusal ergonomics `[cheap]` · P1

Follows from P0-3. Every early return in a tool executor must preserve what it
refused — the spelling gate threw `fc.args` away, so the gate that exists to get
the name **right** was also the one that made the model forget it.

- **Done when:** each refusal path has an eval scenario asserting the caller's
  data survived the refusal, and a live call confirms the AI recovers in one turn.

### K7 · Keep the coverage tripwire `[cheap]` · standing

`tests/capabilityConfigEffects.test.js` fails the build if a `configSchema` leaf
is not in `WIRED_KEYS`. This is the guard that stops the original class of bug —
a setting that persists and does nothing. **Do not weaken it to make a new field
land faster.**

### K8 · New packs (billing, insurance) `[cheap]` · P2

The pattern is proven; a new capability is a pack plus a schema and needs **no
frontend change**. Do these only after K1/K2, or each new pack inherits the
missing-row bug.

---

## §6 Dashboard

Better shape than the list implies. `SettingsPage.jsx` already has six groups —
General, Voice & Language, Capabilities, Knowledge Base, Notifications, Billing
— and Capabilities renders **entirely** from `/api/capabilities/definitions`. So
this is gaps and verification, not a rebuild.

**Guardrail, not a task:** `CapabilitiesSection.jsx` must stay a schema renderer
with zero `def.id` literals. Replacing it with hand-written cards per capability
silently reintroduces the exact tax the packs work removed.

### D1 · Prove every knob reaches a call `[cheap]` · P1

The whole reason the capability work happened: schema and dashboard config
existed but were not wired to the engine. The tripwire (K7) covers capability
config. **It does not cover the non-capability settings** — tone, greeting,
recording disclosure, after-hours, transfer policy, locale, knowledge base.
Those were traced by hand once, in July.

- **Done when:** each non-capability setting has either a prompt-snapshot
  assertion or an eval scenario that fails when the setting is ignored.

### D2 · Test-a-call button `[cheap]` · P1

`npm run chat` already drives the real brain through the same reducer as a live
call (`lib/harness/textSession.js`). Surfacing that in the dashboard lets an
owner try their config without dialling — and lets **you** demo a vertical
instantly.

- **Cost note:** every press is real model tokens. Needs a per-business cap.
- **Done when:** an owner can change a setting, press Test, and see the
  difference in the reply.

### D3 · Call review / QA `[twice]` · P1

`analytics.js` and `calls.js` routes exist. What's missing is the QA loop: read a
transcript, see which tools the AI called and which refusals fired, flag a call
as bad, and have that flag be findable later. Today diagnosing a complaint means
a database probe.

- **Done when:** a complaint like "it got my name wrong on Tuesday" is
  answerable from the dashboard in under a minute.

### D4 · Cost and usage per business `[twice]` · P2

Depends on C4. Minutes, calls, and $/call per business. Needed before you can
price, and it's the thing that tells you a tenant is unprofitable.

### D5 · Knowledge base ergonomics `[cheap]` · P2

`KnowledgeBaseEditor.jsx` exists and answers are wired. Open question is whether
it scales past a handful of entries — search, ordering, and whether a long KB
starts costing prompt tokens per turn (it lands in the static prefix, so it
interacts with C1/C2).

### D6 · Decide self-serve vs concierge `[cheap]` · P1

**Currently contradictory.** The stated intent is concierge onboarding, no
self-serve. The code has a live signup flow and an onboarding wizard where a
visitor can create an account and **buy a Twilio number on your card**
(`Onboarding.jsx` → `server.js:668`). Either the intent or the code is wrong.
See O1 and O3 — this is the same decision.

---

## §7 Platform, ops, security

### O1 · Unauthenticated money-spending endpoints `[twice]` · P0

Verified 2026-08-30, still open, and the code says so itself at `server.js:566`:

- `GET  /api/businesses/:id/phone-numbers/available` (`server.js:642`)
- `POST /api/businesses/:id/phone-numbers/buy` (`server.js:668`) — **provisions a
  Twilio number billed to you**
- `GET|PUT /api/businesses/:id/notifications` (`server.js:596`, `:608`)

The only check is that the UUID exists. A UUID is an identifier, not a secret.
This root server has no auth scheme to apply, which is why the sibling
caller-data endpoint was **deleted** rather than guarded.

- **Options:** delete and move to the dashboard backend behind its JWT +
  ownership check (strongest, matches what was already done); or add a shared
  secret as a stopgap. It needs a coordinated frontend change either way, which
  is why it has survived this long.
- **Priority:** P0 despite pre-launch, because the exposure is your Twilio
  balance and it is reachable from the public internet today.

### O2 · Real caller phone numbers committed to git `[cheap]` · P0

`.playwright-mcp/` holds ~68 files including `calls-2026-07-22.csv` with real
caller numbers. `.gitignore` lists the directory but the files were committed
before that, so they are in history.

- **Done when:** the files are removed from the working tree **and** history is
  rewritten or the repo is confirmed private-forever with the risk accepted in
  writing.

### O3 · Public sign-ups `[blocked]` · P1

Self-serve signup is live in the code and Supabase project-level public sign-ups
are enabled. This is dashboard configuration, not code. Same decision as D6.

### O4 · No appointment sweeper `[twice]` · P2

Nothing ever transitions an elapsed appointment out of `status='scheduled'`
(`adapters/scheduling/internal.js:57`). The live "it read out my old
appointments" bug was one missing `upcomingOnly`, now fixed — but the underlying
state is still wrong, and every future query has to remember to filter.

### O5 · Decide the fate of the v1 pipeline `[cheap]` · P2

`lib/mediaStream.js` still runs when `PIPELINE_V2=false`, is explicitly **not**
kept at feature parity (`lib/mediaStream.js:17`), and **has no test harness**. It
once duplicated every appointment side effect; both pipelines now share
`lib/capabilities/effects.js`. Either delete it or give it a smoke test — a
rollback escape hatch nobody tests is not an escape hatch.

### O6 · Vendor-failure alerting `[cheap]` · P1

ElevenLabs quota exhaustion (30k chars ≈ 23 calls) silently falls back to Google
TTS and adds ~750ms per turn. It cost an hour of debugging once, reading as a
latency regression. `tts_fallback_turns` now counts it — **nothing alerts on
it.** Same class: Deepgram outage, Gemini 429, Twilio errors.

- **Done when:** a non-zero fallback count, or a vendor error rate above a
  threshold, reaches you somewhere you actually read. Note that GCP notices
  currently go to a mailbox nobody reads.

### O7 · Concurrency and load `[gcp]` · P1

Never load-tested. The plan removes architectural caps and gates at "10 proven",
documenting the vendor ceiling. Until that is run, the honest answer to "how many
simultaneous calls can it take" is **unknown**.

---

## §8 Website

**Not ours.** A friend of yours has been revamping the marketing site since
2026-08-08, and three separate in-house rebuilds were built and discarded before
that (the last one — six pages, a design system, four legal documents, 83
Playwright tests — was reverted wholesale).

Your item 6 ("less AI, more traditional") is a valid critique of the current
site. But the doc's position is: **do not rebuild it here** unless you
explicitly decide to take it back in-house, because the last three attempts cost
real weeks and shipped nothing.

Two facts worth carrying into whatever the friend builds:

- **No pickup-speed claim belongs on the site.** Measured p50 voice-to-voice is
  ~2.6s. Any "instant" or "answers in under a second" copy is false.
- **The site rebuild does not close O1, O2 or O3.** None of them are website code.

Standing brand decisions: **Vetra** customer-facing (`VetraTD` only in the domain
and GitHub URL); "live in 3 business days".

---

## §9 Speech-to-speech (Gemini Live)

Opened 2026-08-30 after the owner asked why ChatGPT voice sounds so much better
than a phone receptionist. Two probes were run; the measured facts are in §0.

> **2026-09-01 — see `docs/speech-to-speech-vendor-analysis.md`.** The measured
> facts below still hold, but two conclusions in this section are superseded
> because criteria changed, not because the arithmetic was wrong:
> (1) `gemini-3.1-flash-live-preview` is **AI Studio / global only — no Vertex
> version in any region** and **no async function calling**, so it does not ride
> the Vertex migration and cannot satisfy UK/EU residency; (2) **OpenAI is no
> longer ruled out** — `gpt-realtime-2.1-mini` prices at ~$0.131/call, level
> with the cascade, and its $0.40/M cached audio input flattens the quadratic
> term. That doc also shows cost is a **non-reason** to migrate at any
> foreseeable volume (~$11 spread per 1,000 calls).

**The verdict, in one line: Live is very likely the better long-run
architecture, but it must be built as a THIRD FRONT-END, never as a cutover.**

### Why it wins eventually

1. **The pipeline has a hard ceiling on realism.** Text is where prosody dies,
   in both directions — Deepgram hands you words with no tone, and ElevenLabs
   invents tone blind to how the caller sounded. Three rounds of live-call fixes
   (echo containment, punctuation-as-endpointing, filler duplication) were not
   bad code; they are the architecture's tax, and it recurs forever.
2. **Both stated goals favour it.** Cost with reseeding **$0.096 vs $0.130**.
   Latency: sub-second is plausible where the pipeline's floor is ~2.2–2.4s with
   every lever already spent.
3. **The seam already exists.** `lib/voice/llmTurn.js` serves both
   `lib/voice/session.js` and `lib/harness/textSession.js` — two front-ends on
   one brain today. **5,792 lines** of capabilities, tools, adapters and reply
   state are transport-agnostic already.

### Why NOT a cutover

Blast radius, measured: **~9,800 lines** of production code (transport +
turn-taking + `session.js`) and **~10,636 lines** of tests and the cutoff sim.
The lines are the cheap part; those tests are the encoded results of three
rounds of live-call debugging. Risk concentrates exactly where there is no
instrument — tool-call enforcement, refusal recovery, name fidelity on reseed —
and it would replace a stack that has never been fully validated (P0-2, P0-3
still open), so any regression would be unattributable.

### LV1 · Build `liveSession.js` beside `session.js` `[cheap]` · P2

Per-business flag selects the front-end. No cutover, ever.

- The pipeline stays production **and becomes the control arm** — the thing
  every honest measurement in this project has lacked.
- One demo tenant on Live, everyone else untouched.
- If Live loses, delete one file instead of unwinding a migration.
- **Done when:** one business answers on Live and books an appointment with
  requirements enforced, with the pipeline unchanged for every other tenant.

### LV2 · Reseed history as text, do NOT use compression `[cheap]` · P2

The cost fix, and the only one that does not damage the model.

- `contextWindowCompression` caps growth but **the saving and the forgetting are
  the same dial** — at `triggerTokens: 3100` the model retained ~1 turn, which
  would obliterate `long-call-memory`. Set it high enough to preserve memory and
  it never fires on a 3-minute call.
- **Reseeding changes the representation of history, not the amount.** Measured:
  3 turns of history = 67 text tokens vs 426 audio tokens, nothing forgotten.
  Live's own `inputAudioTranscription`/`outputAudioTranscription` produce the
  transcript for free.
- Keep audio for the **current** turn, where prosody drives turn-taking. Drop it
  for history, where it does almost nothing.
- **Two unmeasured risks, both real:** whether Live's transcription mangles
  names on reseed (this is a known weak spot — "Ayalavarapu" → "Ayalla Varpu"),
  and whether the model re-greets or repeats across a reconnect. Token counts
  prove cost, not quality.
- **Done when:** a reseeded call preserves a hard-to-spell name end to end, and
  no doubled greeting appears across a recycle.

### LV3 · Async tool semantics `[cheap]` · P2

The hardest part of the migration, and it is not the tool declarations —
`buildCallTools` already emits the shape Live wants.

Today `getReplyStreaming` blocks the turn on a tool and plays a filler line. In
a live session audio flows both ways while the query runs, so a result can land
after the conversation moved on. Interruption mid-tool needs deciding too:
inject, drop, or re-prompt. `VOICE_ABORT_ON_RESUME` is the blunt current answer.

- **Effort:** tool calling itself 1–2 weeks; async semantics plus re-proving
  every enforcement gate, **3–5 weeks**.

### LV4 · A Live-backed eval harness `[cheap]` · P2

**Correction to an earlier claim in this doc's own history:** "Live disconnects
the eval suite" was overstated. Live accepts text turns, so a Live-backed
harness can run all 43 scenarios and assert tool calls and replies exactly as
`textSession.js` does. The brain assertions survive.

It is a **weaker proxy** than today's coverage — text mode through a Live
session is not the audio path — but that is a different objection from "no gate
at all". Build this before LV1 ships to any real tenant.

### LV5 · The decision gate `[cheap]` · P2

**Do not start the spike until GCP cuts over.** Not for code reasons — because
it needs the owner's ears, and Phase 5 needs them first.

Prerequisites, all already in this doc: P0-1 (flags), P0-2 (six calls), P0-3
(refusal heard) give a **baseline**; without one, no comparison means anything.
C4 gives the $/call metric that can check the arithmetic above.

Then a **2–3 day spike**: `liveSession.js` with reseeding, one demo business,
listened to on a real phone line.

**Gate — both must be yes:**
1. Does it book an appointment correctly with requirements enforced?
2. Does it sound better **on an 8kHz μ-law phone line**, not on a laptop?

Question 2 matters more than it looks. PSTN is band-limited ~300–3400Hz, so the
high-frequency detail that makes ChatGPT voice sound present is physically gone
before the caller hears it. Part of the quality gap does not survive the phone
network, whichever model generates the audio.

### What was ruled out (do not re-litigate without new data)

- **OpenAI Realtime** — ~$0.41/call on the full model, ~5× Gemini Live. The mini
  model lands near $0.13, competitive but not compelling, and it fits nothing
  else in the stack. Gemini Live rides the Vertex migration already underway.
- **Live as a pure cost play** — it is roughly a wash at 3 minutes and *worse*
  beyond that. Migrate for realism and latency, not for the bill.

### Parked during the spike build — recorded, not fixed (2026-09-02)

Found while building the section 7 step 1 bridge on `spike/s2s-bridge`. None
were fixed: the migration rule is that real bugs get written down and the owner
decides what gets pulled in.

**LVX1 · `echoGuard` has no transcript source under speech-to-speech** `[gcp]` · P1

`lib/voice/echoGuard.js` is a **content** guard — it compares a transcript
against what the AI said (`normalizeTokens`, bigram overlap over a time window).
It needs Deepgram. Under S2S there is no Deepgram, and the only text available
is Gemini's own `inputAudioTranscription`, which arrives *after* the audio was
already fed into the session. So the handoff's "echoGuard gating when we send
`activityEnd`" needs a number nobody has: how late that transcript lands
relative to speech end.

Manual activity detection is unaffected and still right — the trail-off case is
timer-based. What is unresolved is the *content* half of echo defence. The spike
logs `input_transcript_lag_ms` for exactly this.

**Done when:** the real front-end either gates on the transcript with a measured
lag that permits it, or names what replaces echoGuard.

**LVX2 · `gemini-api-key` is a credential-boundary tripwire** `[gcp]` · P2

`lib/credentialBoundary.js` lists `gemini-api-key` in `FORBIDDEN_IN_PHI_PROJECTS`
— the AI Studio path is not BAA-covered. `scripts/check-credential-boundary.js`
resolves its default target to the **US prod** project, which is not an active
stack, so the secret created in `vetra-uk` for the spike does not fail the gate
today. It would fail the day the UK project is named in `VETRA_PHI_PROJECTS`.

The UK lane is `deployment_mode = "standard"` and there is no GCP BAA, so this
is a naming collision rather than a live exposure. It is still a trap with a
detonator already installed.

**Done when:** either the secret is gone with the spike, or the boundary rule
distinguishes a `standard` lane from a covered one.

**LVX3 · The spike webhook is gated by URL secrecy, not a Twilio signature** `[gcp]` · P2

`+18176011171` is on Twilio **account B**, whose auth token GCP does not hold —
the UK project's `twilio-auth-token` is account A's. Rather than push a second
Twilio credential into that project for a one-day service,
`scripts/spike/s2s-bridge.js` validates no signature and gates on a secret path
segment instead. The WebSocket leg keeps the real per-call token, keyed by
`MEDIA_STREAM_SECRET`.

What leaks if the URL leaks: Gemini spend on a service with no data behind it.
The real front-end uses the signature path like everything else.

**Done when:** the spike service is deleted.

**LVX4 · Gemini Live refused to read a caller's phone number back** `[gcp]` · P1

Observed on a real spike call, 2026-09-02. The caller gave a mobile number and
asked the assistant to repeat it back; it declined.

**This is not the missing tools.** Read-back is prompt and model behaviour, not
a tool call. It is also not optional: reading a number back is one of the
commonest lines on these calls — `lib/voice/echoGuard.js` normalises digit runs
specifically so that a read-back-the-number echo can be recognised, which is
only necessary because production does it constantly. A receptionist that will
not confirm a number it has just been given cannot take a message.

Two candidate causes, neither confirmed: the model's own reluctance to repeat
personal data back, or the spike's ten-line system prompt (which says it has no
tools and that "someone will confirm", and may read as "do not handle details").
The real front-end runs the production prompt, so this may simply not reproduce.

**Not diagnosable from the current logs** — the bridge records transcript
TIMING but not transcript TEXT, so there is no record of what was actually said.

**Done when:** the real front-end is exercised with the production prompt and a
number read-back is either observed working or reproduced as a defect. Assume
neither.

**LVX5 · The spike under-reported its own token usage** `[gcp]` · P2

`scripts/spike/s2s-bridge.js` stored `m.usage = msg.usageMetadata`, keeping only
the LAST turn. Gemini emits one `usageMetadata` per turn, not a session total,
so a multi-turn call was under-reported by roughly 3-4x.

This is **harness defect #1 in the handoff's own section 11 list**, already
found and fixed once in `scripts/probes/lib/geminiUsage.js` — whose header
documents it with measured numbers — and re-committed anyway while writing a new
instrument. A spend cap enforced against the last turn only is not a cap.

Fixed in the spike (accumulator inlined). Recorded because the interesting part
is not the fix: a documented harness defect with a written-up post-mortem was
reproduced by someone who had read the document. Reuse the instrument, do not
re-derive it.

**Also renamed in the same pass:** `noise_floor_db` measured the inbound level
while we are NOT playing, which on a real call is dominated by the caller
speaking — idle RMS 928-1662 against a playing RMS of 37-236. It was added as
the "is this echo or is it the room" control and cannot serve as one. Now
`inbound_while_idle_db`; the control it was meant to provide does not exist.

**Done when:** the spike is deleted, or the real front-end's cost accounting is
built on the accumulator rather than a fresh one.

**LVX6 · No PSTN echo was detectable at all, and the metric that said otherwise was wrong** `[gcp]` · P1

Measured 2026-09-02 on a call where the caller stayed silent throughout:
inbound RMS during our own playback was **0** — digital silence — against 1909
while idle. Echo does not reach us on this path, whether through mobile uplink
DTX or carrier-side echo cancellation.

**The spike's `echo_return_loss_db` was measuring the wrong thing.** Its 23-40 dB
readings were caller speech bleeding into the tail of the playback window, not
echo. Renamed reasoning recorded in scripts/spike/VERDICT.md. The bucket also
logs no sample count, so an empty array and an all-silent array are
indistinguishable in the record — a counter is needed to close that.

**Why it matters for the build:** section 6 justifies manual activity detection
primarily on echo — "far-end VAD cannot detect our own PSTN echo". That threat
did not appear in any of seven calls. Its OTHER justification, removing the
trail-off cut-in, is independent, was measured 3/3 in round 3, and reproduced
here. The two are separable mechanisms and the design treats them as one.

This does not contradict the cascade's documented live-call echo defect — that
was Deepgram transcribing quiet audio into words, a different stack and possibly
a different handset. One condition is not a law.

**CORRECTED 2026-09-02, same day, by better instrumentation.** Echo IS present.
A second silent call with frame counters showed 40 of 1514 frames carrying
signal during our own playback, peaking at RMS 211, against a caller-speech peak
of 14,334. The mean read 0 only because 1,474 frames were exactly zero -- a mean
is the wrong statistic for a bursty signal, and the max was not being logged.

`lib/voice/inboundVad.js` uses `minRms` 700, so the worst observed echo sits
about 10 dB UNDER the VAD floor. Nothing fired because of a margin, not an
absence. One handset, one room, one carrier's echo canceller; a louder speaker
or a worse canceller closes that gap.

**The two mechanisms are separable and were being conflated:**
- the half-duplex gate (do not forward inbound while we speak) costs **nothing**
  in latency and is free insurance on a 10 dB margin -- **keep it**;
- `HANGOVER_MS` (how long to wait before declaring the turn over) is what costs
  ~900 ms per turn, and `classifyHold` replaces it now that P6 measured
  transcript lag at 113-360 ms.

**Done when:** the real front-end keeps the gate, replaces the flat hangover with
`classifyHold`, and the 10 dB margin is re-checked on a second handset.

---

## Appendix A — commands

```
node scripts/verify-capabilities.js                 # fixtures: what tools the model gets
node scripts/verify-capabilities.js +18175803291    # a real business's live config
npm run chat                                        # drive the real brain, no audio
npm run eval -- --no-judge --filter <scenario>      # cheap iteration
node scripts/eval-band.js --band <files...>         # the suite's noise band
node scripts/eval-band.js --baseline a,b,c --candidate d,e,f
npm run sim:cutoff                                  # turn-taking, free, deterministic
npm run probe                                       # costs ~15k EL chars — check quota
```

**Before any full eval or probe run:** state the token count and dollar cost and
get permission. A 5-run band is ~8M tokens ≈ $10 per arm.

## Appendix B — open questions for the owner

1. **O1** — delete the endpoints and move them behind the dashboard backend, or
   stopgap with a shared secret? The delete is stronger and needs a frontend
   change.
2. **D6 / O3** — is self-serve signup intended? The code says yes, the stated
   plan says concierge. One of them has to move.
3. **K3** — is the webhook scheduling adapter a real product path, or should it
   be deleted?
4. **C1** — approve ~$20 for the two-arm eval band that gates the cache flag?
5. **M1** — which five or six verticals actually matter for the first ten
   customers? The matrix is cheaper if it is not exhaustive.
6. **§9 / LV5** — confirm the sequencing: pipeline stays production, Live gets
   built beside it as `liveSession.js`, and the spike waits until GCP cuts over
   because it needs your ears. Anything you want reordered?
7. **§9 / LV2** — how much does name-spelling fidelity matter versus voice
   realism? If a reseeded Live call mangles one name in twenty, is that
   disqualifying, or acceptable against a call that sounds human?
8. **C2** — approve a prefix-shrinking pass? It is now the largest cost lever on
   *both* architectures (85% of Live's prompt tokens) and needs an eval band to
   land safely.

## Appendix C — session log

**2026-08-30 — Gemini Live investigated, measured, and parked as §9.** Two
throwaway probes were run against `gemini-3.1-flash-live-preview` using the real
prompt prefix and the probe harness's own μ-law recordings. Total API spend
**~$0.12**. Scripts and raw JSON live in the session scratchpad
(`live-billing-probe.mjs`, `live-mitigation-probe.mjs` and their `*-result.json`)
— deliberately **not committed**, because the findings are what matter and they
are recorded in §0.

Three claims made during that session were wrong and were corrected by
measurement. They are written down because each is the kind of thing that gets
re-argued from memory:

1. *"Live re-bills only new tokens, so a call is ~$0.076."* **Wrong** — context
   is re-billed every turn; the real figure is ~$0.136.
2. *"Live uses ~10× fewer tokens because a session doesn't re-send the prefix."*
   **Wrong** — it re-sends the prefix every turn, exactly like the pipeline.
3. *"Live disconnects the eval suite entirely."* **Overstated** — Live accepts
   text turns, so most of the suite ports. See LV4.

The probe's own printed verdict was also wrong (a total-token threshold that the
static prefix diluted below the cutoff). The signal was in the modality split,
not the total — **an instrument that reports a verdict can still be reporting
the wrong quantity.** Same lesson as `sim/cutoffSim.sim.js` asserting only its
row count.
