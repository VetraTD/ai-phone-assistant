# Capacity — what actually binds, and how each number was obtained

**Written in Phase 3b, 2026-08-28. Every row says how it is known.** A capacity table whose
numbers cannot be traced to a measurement is worse than no table, because it gets quoted.

Three labels are used and they are not interchangeable:

| Label | Means |
|---|---|
| **MEASURED** | Observed on this machine, this session, with the command recorded below |
| **RECORDED** | Taken from the migration ledger's standing facts; not re-measured here |
| **UNKNOWN** | Nobody has read it. It is not estimated, and it must not be estimated |

---

## The bind order

1. **Shared call state** — was a correctness bug, not a capacity limit. Closed in Phase 3a
   (`CALL_STATE_STORE=pg`, migration 038).
2. **Cloud SQL connections** — `instances × DB_POOL_MAX` must stay under the instance's
   `max_connections`. **The instance does not exist until Phase 4.**
3. **Vendor caps** — and one of these binds long before GCP does. It does. See below.

---

## THE BINDING CONSTRAINT TODAY: ElevenLabs, at 10 concurrent

**MEASURED.** Not inferred from a plan page — the vendor said it, in the WebSocket close reason,
under load:

```
"event":"tts_el_unexpected_close","closeCode":1008,
"reason":"Too many concurrent requests. Your current subscription is associated
          with a maximum of 10 concurrent requests (running )"
```

That is the account whose key is in the local `.env`. **Whether the account that will serve
production is the same one, on the same tier, is an owner check and has not been done.**

### What happens at the cap, measured rather than assumed

The ledger's Gate E lists "graceful degradation at the vendor cap" as out of scope and records
*"Caller 11 when ElevenLabs caps at 10 is undefined behaviour."* **That is now measured, and it is
not undefined. It is defined and it is bad:**

| Concurrent calls | Legs served | ElevenLabs refusals | Time to first audio |
|---|---|---|---|
| 10 | 10 / 10 | 0 | **p50 762 ms**, p95 838 ms, max 838 ms |
| 20 | 20 / 20 | 10 | p50 729 ms, **p95 4,632 ms**, max 4,642 ms |
| 30 | 30 / 30 | 20 | **p50 4,617 ms**, p95 7,820 ms, **max 8,393 ms** |

**No call is dropped and no socket is refused.** Every call above the cap gets its greeting from
the Google Chirp3 fallback voice instead, after the ElevenLabs attempt has failed — so the caller
hears **silence for four to eight seconds and then a different voice**. After consecutive failures
the circuit breaker opens for 60 s (`tts_el_breaker_open`, `cooldownMs: 60000`), during which
*every* call uses the fallback voice, including the ones that would have fitted under the cap.

**The knee is exactly at the cap.** Below 10, nothing degrades. At 11, one caller waits.

An earlier run with a 5-second hold reported *"15 of 30 legs got no audio"*, which reads as dropped
calls and is not: raising the hold to 20 s brought all 30 in. **The failure mode is latency, not
loss** — and a load test that stops watching too early reports the wrong failure.

### Raising it

Concurrency is a function of the ElevenLabs plan tier. **The current tier and the next tier's
concurrency limit are UNKNOWN here and must be read off the account** — they are deliberately not
guessed. Billing is self-serve, so unlike Twilio the lead time is minutes rather than days. Owner
action.

---

## The rest of the vendor row

| Vendor | Cap | How known | Raising it |
|---|---|---|---|
| **ElevenLabs concurrent requests** | **10** | **MEASURED** — vendor's own close reason, above | Plan tier. Self-serve. **Next tier's number UNKNOWN — read it off the account** |
| **Deepgram concurrent streams** | **> 30** | **MEASURED** — 30 simultaneous `stt_open`, zero errors, on two runs. The cap was not reached, so this is a floor, not the cap | Not needed yet. The actual ceiling is UNKNOWN |
| **Twilio concurrent calls** | UNKNOWN | RECORDED: new accounts start low | Support request. **Has lead time. Owner work** |
| **Twilio CPS** | UNKNOWN | RECORDED: new accounts start low | Support request. **Has lead time. Owner work** |
| **Vertex QPM** | UNKNOWN | Not exercised. These runs used the AI Studio key (`VERTEX_ENABLED` is empty locally), so **they say nothing about Vertex quota at all** | Quota request against the project — which does not exist until Phase 4 |
| **Cloud SQL `max_connections`** | **PHASE 4 FILL-IN** | **The instance does not exist.** See below | — |

---

## Cloud SQL — deliberately left blank

**This row is not estimated. Phase 4 fills it in by reading it off the instance** (ledger P7, and
the plan's own instruction: *read that value off the provisioned instance; do not assume it*).

What Phase 3b contributes is the **left-hand side**, which is the term that normally gets guessed:

> **MEASURED: one instance draws up to `DB_POOL_MAX` backend connections, and reaches it.**
> At 10 concurrent calls, `pg_stat_activity` showed **10** connections. At 20 and at 30 concurrent
> calls it showed **10** — the pool caps, and calls queue rather than opening more.
> `DB_POOL_MAX` was unset, i.e. the default of 10 (`services/db.js`).

So `instances × DB_POOL_MAX` is not a pessimistic bound. **It is reached at roughly
`DB_POOL_MAX` concurrent calls per instance**, which for a voice product is a low number.

To complete the row in Phase 4:

```
SHOW max_connections;                        -- on the provisioned instance
max_instance_count × DB_POOL_MAX  <  max_connections − (reserve for the migrate job,
                                                       the dashboard backend, and
                                                       superuser_reserved_connections)
```

Both `max_instance_count` and `DB_POOL_MAX` were **deliberately not raised in Phase 2** for this
reason, and must not be raised from a guess.

---

## Reproducing all of it

```bash
npm run db:up
node server.js                                   # in another terminal

node scripts/load-test-calls.js --n 10 --hold 20000 --business "<a routable number>" --observe-db
node scripts/load-test-calls.js --n 20 --hold 20000 --business "<a routable number>" --observe-db
node scripts/load-test-calls.js --n 30 --hold 20000 --business "<a routable number>" --observe-db
```

**Restart the server between runs.** The TTS circuit breaker has a 60-second cooldown, so a second
run inside a minute measures the breaker rather than the cap.

**`--hold` must exceed the fallback path's latency** or the run reports missing audio where there
is only slow audio — see above.

**Each accepted socket is real vendor spend** (Deepgram stream, Gemini turns, ElevenLabs
synthesis). `--confirm` is required for any non-loopback target, and pointing this at production
consumes the same vendor concurrency real callers are using.

## What this cannot tell you

It measured **one process on one laptop**. It says nothing about Cloud Run's own limits, nothing
about Twilio, nothing about Vertex quota, and nothing about the Cloud SQL instance. It is a floor
and a shape. The ceiling is in an account console and on an instance that does not exist yet.
