# Outbound calling — design spec

**Date:** 2026-09-24
**Status:** Approved direction. **Revised 2026-09-24 (session 1)** with the results of spike A and spike B, and with the owner's decisions on the voice, the first seconds and the situations Ava must handle. The spike data are in §9.8. The changed sections are D6, D7, D8, G2, G3, §9.3, §9.4, §9.5, §15 and §17.
**Scope of this spec:** Part 1 in full (the generic outbound engine, built before the Digile scoping call). Parts 2 and 3 are outlined only, in §15 and §16, so that Part 1 leaves the right seams. Part 2 gets its own spec after the scoping call (plan step 5.2).
**Companion page:** https://claude.ai/artifact/3379bzmqHG1gVDSQB2mdrv. It holds the reasoning, research, diagrams, compliance background and the step-by-step plan. This spec is the build contract. Where the two disagree, this spec wins.

---

## 1. Summary

The receptionist today can only answer. This spec adds the ability to place calls, as a second door into the **same** engine. The engine is the Gemini Live session, the prompt builder, the capability packs, the write guards, the tools, the database and post-call processing. The outbound door comes with the machinery a door needs:

- **triggers**, which turn "something happened" into an outreach request;
- an **outreach engine**, holding contacts, consent, the do-not-call list, an eligibility gate, the scheduler and the dialer;
- the **outbound door** itself, where an answered call joins the existing live-stream session carrying an outbound call context;
- **outcomes**: structured results, retries and a signed results webhook.

Every client scenario is a **campaign**: configuration copied from a template, never code. Code changes only when a scenario needs a new *kind* of behaviour. This is the kinds-vs-values rule from `2026-07-22-capability-packs-design.md`.

The first campaign is Digile Media's speed-to-lead qualifier. In Part 1 it runs as a demo, booking into the built-in calendar. In Part 2 it books into GoHighLevel.

## 2. Locked decisions

| # | Decision | Locked value |
|---|---|---|
| D1 | Schedule | Fast schedule: Part 1 in about one week, and the rest in about a month. Fall back to the standard schedule if a gate slips. |
| D2 | Google Cloud | Stay on the current estate (`vetra-uk-edc8ca`). Outbound is consent-only by design. Write a short internal note (`docs/compliance/outbound-and-the-2026-08-appeal.md`) recording that the August appeal's "no outbound" statement was true then, and what changed and why. |
| D3 | Recording | No audio recording in Part 1. A per-campaign recording option is a Part 2 item, built only if Digile wants audio. |
| D4 | False disclosure | Replace "calls are recorded for quality" everywhere it is emitted with **"This call may be transcribed to help us assist you."** This is plan step 0.3. It is independent of outbound and ships first. |
| D5 | Reactivation | Supported only for contacts holding a recorded consent to automated/AI calls, enforced in code. The `marketing_consented` compliance class is **refused at campaign save in Part 1** and enabled in Part 3. |
| D6 | Voice and persona | **Revised after spike A.** Ava speaks in the tenant's **Gemini Live voice throughout** (default `Kore`). The owner compared the Chirp 3 HD pre-rendered opener with the Live-spoken one by ear and chose Live: the Chirp handoff "sounds off" in tone and pace. `services/googleTts.js` is **not** used on outbound calls. Any audio made in advance (the silent-pickup backstop line and the voicemail message, §9.3) is rendered by **Gemini Live itself** in that same voice, so there is one voice throughout. The demo persona is "Ava from Digile". |
| D7 | Test caller ID | `+441372656055` (Digile's number, Twilio account A). A callback to it reaches Digile's inbound tenant, which exercises callback recognition. **Owner, 2026-09-24:** no UK legs for now. Spike B ran from `+18176011171` (account B) to the owner's US mobile. Both accounts are confirmed to own their numbers and to have US and GB dialing permission. |
| D8 | API budget | $10 for Part 1 across Gemini and Twilio test spend, recorded in `scripts/probes/lib/spendLive.js`. **Implemented:** `CAP_USD` was raised by exactly $10, to $31.73, and `reserveP1(probe, worstUsd)` refuses anything that would take the `P1-` total past $10 (commit `695b4d9`). Session 1 spent **$0.19**, which is an over-estimate. |
| D9 | Parallel runs | Allowed on the fast schedule, for the dashboard and paperwork. |
| D10 | Spec location | Committed on `fix/closing-sequence-2026-09-17` (production's branch). Step 0.2 fast-forwards local `main` and `dev` to it. **Nothing is pushed** until the owner confirms whether Railway still auto-deploys `main`. |

**Deferred until after the scoping call:** pricing of outbound minutes, Digile's relationship to us (customer, referrer or reseller), Conversations entry vs contact note, and Digile's persona details, questions, hours and retry schedule.

**Owner prerequisites that are not code:**
- the Twilio console check (profile type, voice geo permissions for UK and US, whether `+441372656055` is SMS-capable);
- a UK handset for live rounds;
- 2–3 UK accent testers;
- Claude plan capacity;
- **the LLC.** It blocks go-live, not Part 1: the Digile DPA must name the company and needs the UK IDTA addendum.

## 3. Goals and success criteria

Part 1 is done when all of the following hold on the deployed service with outbound switched off except for allow-listed test numbers.

| # | Criterion | How it's measured |
|---|---|---|
| G1 | The AI can place a call to an allow-listed number and hold a normal conversation using the same brain as inbound | Live round 1, scenario 1 |
| G2 | The person hears Ava **within 2,000 ms of starting to speak**, or within 2,000 ms of answering if they say nothing. These are Ofcom's two limbs (§9.3). | `outbound_first_audio{from_answer_ms, from_speech_ms}` within those limits on every live-round call |
| G3 | Ava's first turn always contains the business name and an AI disclosure | The backstop line and voicemail are validated at campaign save. A Live-spoken first turn is checked by the first-turn detector, which re-prompts if either element is missing (§9.3). Counted on every live-round call |
| G4 | Voicemail is detected and handled by policy: message left after the beep, or a clean hang-up | Live round 1, scenario 2; `call_attempts.answered_by` |
| G5 | No call outside the calling window, to a suppressed number, without the required consent, or beyond attempt caps | Gate unit tests, each shown to fail when its check is removed |
| G6 | No contact is ever dialled twice for the same attempt | Concurrency test: duplicate dispatch of the same task produces exactly one Twilio call |
| G7 | "Stop calling me" suppresses the number before the call ends (tool), or at the latest in post-call processing (detector) | Live round 1, scenario 7; the detector sabotage test |
| G8 | A lead ringing back is recognised by inbound, which knows why we called, and their pending retries stop | Live round 1, scenario 8 |
| G9 | Inbound behaviour is unchanged | Every existing golden prompt snapshot byte-identical; full suite green; one ordinary inbound call placed during live round 1 |
| G10 | A Digile-style qualifier campaign asks its questions, stores answers as structured data, books into the built-in calendar, and fires a signed results webhook | Live round 2; `calls.answers`; webhook test endpoint |

## 4. Non-goals for Part 1

GoHighLevel (any part), CSV/list upload, TPS/CTPS screening, audio recording, patient campaigns (`audience: "patient"` is modelled but refused at save in Part 1), the `marketing_consented` class, warm (conference) transfer, the agency/partner layer, plan/tier enforcement or pricing of outbound minutes, the US launch, and any change to the cascade front-end (`/twilio/voice`). Outbound runs on the Live front-end only.

## 5. Architecture

```
Triggers ──request──▶ Outreach engine ──dial──▶ Twilio ──rings──▶ the person's phone
 (JSON webhook,       (contacts, consent,         │
  job script;           suppressions, gate,        │ on answer
  inbound events        scheduler, dialer)         ▼
  in Part 3)
                             ▲              /twilio/outbound-answer (NEW)
                             │                     │ <Connect><Stream> to the SAME
                             │                     ▼ /twilio/live-stream/<token>
                             │        Live session (EXISTING) + outbound call context
                             │                     │ call ends
                             │                     ▼
                             └── next attempt ── Outcomes & post-call ──▶ outbox ──▶ results webhook
```

**Where it runs.** All new HTTP routes live on the existing `voice-uk-prod` Cloud Run service. Postgres (Cloud SQL, RLS) is the source of truth for every lead and attempt. **Cloud Tasks** is the alarm clock that wakes the dialer at an attempt's due time. A **Cloud Scheduler** job hits a sweep endpoint every 5 minutes as a safety net. In-process timers are not used for anything that must survive: `cpu_idle=true` throttles CPU between requests, instances restart, and two instances would both fire.

**Cross-instance rule.** The Twilio webhooks (answer, status, AMD), the Cloud Tasks callback and the WebSocket session can each land on a different instance. So every piece of shared state goes through Postgres (the new tables, plus `call_state`), never through process memory. Voicemail is handled by redirecting the call through the Twilio REST API from whichever instance receives the AMD callback (§9.4), so it never needs to reach the session.

## 6. Data model

All tables are tenant-scoped with RLS on `business_id`, following the existing pattern (`app.business_id` set by `withTenant`). The service runs as `vetra_app` NOBYPASSRLS, so a tenantless write matches zero rows and reports success. Every write path must therefore run inside `withTenant(businessId, …)`, and tests must assert the row landed. The migrations are **042 onward**. Each is checksummed and never edited once applied.

### 6.1 New tables

**`campaigns`**: one per outbound scenario.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `business_id` | uuid fk | RLS |
| `name` | text | |
| `template_key` | text | `speed_to_lead`, `missed_call_callback`, `reminder`, `no_show`, `aftercare`, `review_request`, `reactivation`, `custom` |
| `compliance_class` | text | `solicited`, `service`, `marketing_consented`; the last is refused at save in Part 1 |
| `audience` | text | `business` or `patient`; `patient` is refused at save in Part 1 |
| `status` | text | `draft`, `active`, `paused` |
| `current_version` | int | |
| `created_at`, `updated_at` | timestamptz | |

**`campaign_versions`**: immutable config snapshots. Every call records the version that ran.

| column | type | notes |
|---|---|---|
| `campaign_id` | uuid fk | |
| `business_id` | uuid | RLS |
| `version` | int | pk is (`campaign_id`, `version`) |
| `config` | jsonb | validated against the campaign config schema (§7) |
| `created_at` | timestamptz | |

**`contacts`**: people a business may call. Inbound callers are **not** written here in Part 1; the one-timeline view is a Part 3 item.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `business_id` | uuid | RLS |
| `phone_e164` | text | unique per business, normalised on write |
| `first_name`, `last_name`, `email` | text | |
| `timezone` | text | IANA. Null means derive: a +44 number is `Europe/London`, otherwise the business timezone |
| `external_ids` | jsonb | e.g. `{ "ghl_contact_id": "…" }` in Part 2 |
| `attributes` | jsonb | trigger data and stored answers keyed by campaign |
| `created_at`, `updated_at` | timestamptz | |

**`consents`**: evidence of permission.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `business_id` | uuid | RLS |
| `contact_id` | uuid fk | |
| `purpose` | text | e.g. `enquiry_followup`, `appointment_service` |
| `channels` | text[] | `call`, `sms` |
| `covers_automated` | boolean | true only if the captured wording mentions automated or AI calls |
| `source` | text | `form`, `api`, `inbound_call`, `manual` |
| `source_ref` | text | form ID or submission ID |
| `wording_version` | text | |
| `wording_text` | text | |
| `captured_at` | timestamptz | |
| `expires_at` | timestamptz | |
| `revoked_at` | timestamptz null | |

**`suppressions`**: the do-not-call list.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `business_id` | uuid | RLS |
| `phone_e164` | text | unique per business |
| `reason` | text | `opted_out`, `wrong_number`, `complaint`, `manual`, `tps` (Part 3) |
| `source_call_id` | uuid null | |
| `created_by` | text | `tool`, `detector`, `dashboard`, `api` |
| `created_at` | timestamptz | |

**`outreach`**: one contact in one campaign; the retry state machine (§8).

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `business_id` | uuid | RLS |
| `campaign_id` | uuid fk | |
| `campaign_version` | int | pinned at creation |
| `contact_id` | uuid fk | |
| `state` | text | `waiting`, `dialing`, `in_call`, `closed` |
| `attempts_made` | int | |
| `next_attempt_at` | timestamptz null | |
| `last_attempt_at` | timestamptz null | |
| `hold_until` | timestamptz null | silent-call block |
| `outcome` | text null | |
| `close_reason` | text null | |
| `trigger` | jsonb | source plus the raw normalised payload |
| `idempotency_key` | text | unique (`business_id`, `idempotency_key`) |
| `created_at`, `updated_at`, `closed_at` | timestamptz | |

Index: (`state`, `next_attempt_at`).

**`call_attempts`**: every dial, answered or not. Kept 6 months for Ofcom.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `business_id` | uuid | RLS |
| `outreach_id` | uuid fk | |
| `attempt_no` | int | unique (`outreach_id`, `attempt_no`); this is the double-dial lock (§10.2) |
| `twilio_call_sid` | text | unique |
| `from_number`, `to_number` | text | |
| `dialed_at`, `answered_at`, `ended_at` | timestamptz | |
| `twilio_status` | text | |
| `answered_by` | text | Twilio `AnsweredBy` value: `human`, `machine_start`, `machine_end_beep`, `machine_end_silence`, `machine_end_other`, `fax`, `unknown` |
| `amd_duration_ms` | int | |
| `first_audio_ms` | int | answer to first outbound audio frame |
| `silent` | boolean | |
| `result` | text | `no_answer`, `busy`, `failed`, `canceled`, `voicemail_left`, `voicemail_skipped`, `connected` |
| `call_id` | uuid null | fk to `calls` |
| `status_completed_at`, `session_finished_at`, `post_call_started_at` | timestamptz null | the exactly-once post-call claim (§11) |
| `opener_audio` | bytea null | raw 8 kHz μ-law, cleared at `ended_at` |
| `voicemail_audio` | bytea null | same format, same clearing rule |
| `created_at` | timestamptz | |

**`webhook_endpoints`**: where results webhooks go.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `business_id` | uuid | RLS |
| `url` | text | HTTPS only |
| `secret_ciphertext` | bytea | encrypted with the existing KMS key; never logged |
| `events` | text[] | |
| `active` | boolean | |
| `created_at` | timestamptz | |

**`outbox`**: pending deliveries.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `business_id` | uuid | RLS |
| `kind` | text | `webhook` in Part 1; `crm` in Part 2 |
| `target_id` | uuid | |
| `event_type` | text | |
| `payload` | jsonb | |
| `idempotency_key` | text | unique per business |
| `status` | text | `pending`, `delivered`, `dead` |
| `attempts` | int | |
| `next_attempt_at` | timestamptz | |
| `last_error` | text | no PII |
| `created_at`, `delivered_at` | timestamptz | |

### 6.2 Changed tables

- **`call_attempts`** (above) and the **generic trigger webhook** (§12.1) differ from the companion page's first draft. The page put trigger intake in Part 2 and `integration_connections` in Part 1. Here the generic JSON trigger is in Part 1 (stage 3), because any webhook source can use it. `integration_connections` moves to Part 2, where GoHighLevel needs it. This spec wins.
- **`calls`** gains:
  - `direction` text not null default `'inbound'`, check in (`inbound`, `outbound`);
  - `campaign_id`, `campaign_version`, `outreach_id`, `attempt_id`, `contact_id`, all nullable;
  - `answered_by` text;
  - `outcome_code` text;
  - `answers` jsonb.

  **`caller_number` keeps the meaning "the other party"** on outbound calls (the contact's phone), and `twilio_number` keeps "our number". That way the data-subject export and erase paths and the analytics keyed on `caller_number` keep working unchanged.
- **`businesses`** gains `outbound_enabled` boolean default false and `outbound_max_concurrent` int default 2.
- **`call_state`**: `SHARED_FIELDS` (in `lib/callStateStore.js:43` and the SQL allow-list in `app_call_state_merge`) gains `direction` and `attemptId`. Both are written once at session start.

### 6.3 SECURITY DEFINER functions

These are needed because some reads happen before the tenant is known. They mirror `app_lookup_business_by_phone`: each returns the minimum, sets `app.business_id` where a single tenant is involved, and is granted to `vetra_app` only.

> **Amended by the Part 1 plan** (`docs/superpowers/plans/2026-09-24-outbound-part1.md` §0.3):
> - **C1:** FORCE RLS binds a SECURITY DEFINER function's owner, and Cloud SQL's `postgres` cannot bypass it. So these functions read trigger-maintained, no-RLS directory tables, exactly as migration 033 does, never the tenant tables directly.
> - **C13:** capacity counts outbound only, from `call_attempts`. No trigger is added to `calls`.
> - **C2:** `app_open_outreach_by_phone` becomes an ordinary tenant-scoped query.
> - **C15:** the media route keys on CallSid.

- `app_outbound_attempt_by_call_sid(sid text)` returns `business_id` and the attempt, outreach and campaign-version identifiers, and sets `app.business_id`. The outbound door, the status and AMD callbacks, and the session all use it.
- `app_outbound_due(limit int)` returns `(business_id, outreach_id)` pairs whose `state = 'waiting'` and `next_attempt_at <= now()`. It is used by the sweep.
- `app_active_call_counts()` returns `(inbound, outbound)` counts of `calls` rows with `ended_at IS NULL AND started_at > now() - interval '1 hour'`. The one-hour bound stops a call row that was never completed from blocking capacity forever. It is used by the capacity check.
- `app_open_outreach_by_phone(business_id uuid, phone text)` returns the most recent open outreach for that phone, with `last_attempt_at` within 14 days. It is used by inbound callback recognition.

The RLS test suite (`test:db`) must prove all of these: every new table refuses a cross-tenant read and write as `vetra_app`; each definer function returns nothing for an unknown key; `app_outbound_due` returns IDs only.

> **Amended 2026-09-25 (Task 20, session 2b; owner decision O-5).** The sweep needed a fourth cross-tenant read that did not exist above: which attempts are STUCK -- dialled with no CallSid ever recorded, dialled with a CallSid but no terminal status in a long time, or completed with no post-call claim -- across every tenant. Migration 045 adds it the same way: one more no-RLS routing table (`postcall_pending`, kept true by a trigger on `call_attempts`) and one more definer, `app_outbound_stale_attempts(p_limit int, p_sidless_minutes int, p_lost_minutes int, p_postcall_seconds int) RETURNS TABLE (business_id uuid, attempt_id uuid, kind text)`, `kind` one of `sidless` (044's `dial_registry` with no `call_attempt_directory` row, §11), `lost_callback` (`dial_registry` WITH a directory SID, older than `p_lost_minutes`) or `postcall_pending` (a `postcall_pending` row older than `p_postcall_seconds`). Ids only, bounded by `LEAST(GREATEST(p_limit,1),500)`, `REVOKE`d from `PUBLIC` and granted to `vetra_app` by name. The sweep enumerates stale attempts through this one function (the C1 pattern), never by reading `call_attempts`/`dial_registry` directly.

## 7. Campaign config

Validated on save by a schema in `lib/outbound/campaignSchema.js`. That schema is exported to the dashboard the same way capability schemas are (`scripts/export-capability-schemas.js` pattern, with a drift test). Unknown keys are rejected at save (strict), unlike the lenient engine-side capability validation.

```jsonc
{
  "persona_name": "Ava",                       // ≤ 30 chars
  "caller_id": "+441372656055",                // must be a number on the service's Twilio account (checked at save)
  "calling_window": {                          // local time of the contact
    "mon_fri": "09:00-20:00", "sat": "10:00-16:00", "sun": null,
    "outside_window": "queue"                  // "queue" | "queue_and_text"
  },
  "opener": "Hi, is that {first_name}? It's {persona_name}, an AI assistant from {business_name}.",   // the SHORT backstop line and the must-say content of Ava's first turn (§9.3); the reason for the call comes in her next sentence
  "topic": "our clinic systems",               // ≤ 80 chars
  "objective": "Qualify the clinic and book a 30-minute discovery call.",   // ≤ 500 chars
  "notes": "",                                 // free text, ≤ 2000 chars, never truncated silently
  "questions": [                               // qualification pack, stage 3
    { "key": "clinic_name", "ask": "What's the clinic called?", "required": true, "type": "text" }
  ],
  "capabilities": ["qualification", "appointments", "transfer", "callback", "opt_out"],
  "booking": { "adapter": "internal", "length_min": 30 },
  "transfer": { "to": "+44…", "when": "Mon-Fri 09:00-18:00", "whisper": true },
  "retries": {
    "schedule": ["now", "+10m", "+3h", "next_day 10:00", "day_3 17:30"],
    "voicemail_on": [1, 5],
    "text_after_missed": [1],
    "give_up_after_days": 7
  },
  "voicemail": "Hi {first_name}, it's {persona_name}, the AI assistant from {business_name}, about your enquiry. We'll try again later, or call us back on {caller_id_spoken}.",
  "consent_window_days": 30,
  "max_call_minutes": 10
}
```

`{caller_id_spoken}` (`spokenNumber` in `lib/outbound/campaignSchema.js`) groups a UK number for speech: 020 (London) and the other 02x area codes that share its shape (023, 024, 028, 029) as `02X XXXX XXXX` (amended 2026-09-26, post-2c, owner decision O-24/a8 -- the prior generic grouping read "020 7123 4567" as "02071 234 567"). Every other UK shape (07x mobile, 01x) is unchanged, e.g. `07700 900 333`, `01372 656 055`.

**Save-time validation beyond types.** Each rule is a coded rule because ignoring it would hurt, get someone sued, or make them angry.

- The opener must contain `{business_name}` **and** an AI disclosure matching `/\b(AI|artificial intelligence|automated assistant|virtual assistant)\b/i`, and must render to **at most 120 characters** (about 4 seconds of speech). It is the backstop line, and a person who says nothing must not sit through a speech.
  - The limit was 300 before spike A. The 138-character demo opener took 9.2–10.3 s to say, and the owner said a long line "spoke over" them.
- The voicemail template has the same content requirement and renders to at most 300 characters.
- The calling window must sit inside 08:00–21:00 local on every day, and each open day's entry must be **at least 30 minutes** long (amended 2026-09-26, post-2c, owner decision O-24/a9; `CAMPAIGN_LIMITS.min_window_minutes`) -- e.g. "20:59-21:00" and "09:00-09:29" are refused, "09:00-09:30" is allowed. The refusal names the entry.
- `compliance_class = marketing_consented` and `audience = patient` are refused, with a message that they arrive in Part 3.
- The retry schedule has at most 6 entries, and `give_up_after_days` is at most 30.
- `caller_id` must be an owned number, looked up through the Twilio API at save.
- **`persona_name` must not double as the AI disclosure (amended 2026-09-26, post-2c, owner decision O-24/a7).** Refused at save when, after the same `foldDottedAI` fold the transcript-side disclosure check uses, it reads as only "AI" (case-insensitive) -- "AI", "Ai", "A.I.", "a. i." all refused; "Aiden", "Aisha", "Kai" are unaffected. A persona whose NAME is the disclosure ("It's AI, an AI assistant from...") tells the caller nothing a real name would.
- Rendered text never exceeds its field's budget. A field over budget is refused, never truncated (compare the silent `.slice(0, 2000)` problem in `services/gemini.js:1244`).
- **A contact with no first name (amended 2026-09-25, Task 14 fix round 2, owner decision O-9).** `contacts.first_name` is optional. When it is empty, the opener and the voicemail are rendered without the template's sentences that use `{first_name}`. Sentences split after `.`, `?` or `!` followed by whitespace, applied to the TEMPLATE (never the rendered text, so a business name like "Dr. Patel Clinic" cannot split one). The remainder is used only if it still contains the business name AND matches the AI-disclosure regex. Otherwise there is no line: the opener takes the §9.3 prompt path, and no voicemail audio is rendered (AMD then records `voicemail_skipped`, reason `no_audio`). The shipped `speed_to_lead` opener becomes "It's {persona_name}, an AI assistant from {business_name}."; its voicemail has no usable remainder, so no message is left for a contact without a first name. One helper (`renderCampaignLine` in `lib/outbound/campaignSchema.js`) renders the lines for both dispatch (the clip text) and the Live session (the seed), and it never emits "null", "undefined" or an unfilled placeholder. `validateCampaign` has no warnings channel, so there is no save-time signal for a template whose no-name form is unusable; one would need a warnings channel added first.

**Templates** are named presets of this object in `lib/outbound/templates.js`. Part 1 ships `speed_to_lead` only. `missed_call_callback` needs an inbound-event trigger and arrives with Part 3 (plan step 8.1), as do the rest.

## 8. The outreach state machine

States: `waiting` → `dialing` → `in_call` → (`waiting` | `closed`).

- **Creation** puts the outreach in `waiting` with `next_attempt_at = now()` (or the window start) and enqueues a task.
- **Dispatch**, if the gate passes, moves it to `dialing` (§10). If the gate says "later", it stays `waiting` with a new `next_attempt_at` and a new task. If the gate says "never", it moves to `closed` with a `close_reason`.
- **Answered by a human**: `in_call`.
- **Attempt ended.** Post-call (§11) sets the outcome and either closes the outreach or schedules the next attempt:
  - Terminal outcomes close it: `booked`, `not_interested`, `not_a_fit`, `opted_out`, `wrong_person`.
  - `callback_requested` schedules the requested time.
  - Everything else takes the next schedule entry.
- **Close reasons:** `terminal_outcome`, `attempts_exhausted`, `give_up_window`, `consent_missing`, `consent_expired`, `suppressed`, `called_back`, `campaign_deleted`.
- **A paused campaign** holds its outreach in `waiting` without closing it. Resuming re-enqueues them.

**Schedule grammar:**
- `now`: immediately.
- `+Nm` or `+Nh`: that long after the previous attempt ended.
- `next_day HH:MM`: that time on the next calendar day in the contact's timezone.
- `day_N HH:MM`: day N counted from outreach creation, where day 1 is the creation day.

Any computed time outside the calling window moves to the next window opening plus 0–10 minutes of jitter.

## 9. The outbound door and the call

### 9.1 Routes (all on `voice-uk-prod`)

| Route | Auth | Purpose |
|---|---|---|
| `POST /twilio/outbound-answer` | Twilio signature | Returns `<Connect><Stream url=".../twilio/live-stream/<token>">` with `<Parameter name="direction" value="outbound"/>`. The token is minted exactly as for inbound (`mintMediaStreamToken(callSid)`). **Session 2b, owner decision:** on a CallSid that does not resolve (`app_outbound_attempt_by_call_sid` misses), the door does NOT return a bare `<Hangup/>` — the person picked up and must hear who called. It returns `<Response><Say>Sorry, this is {business} calling. We'll try you again later. Goodbye.</Say><Hangup/></Response>`, where `{business}` is the name of the business that owns OUR number (the request's `From`), resolved with the existing `lookupBusinessByPhone`. Ruling P-1: if that lookup misses or throws, it says `Sorry, we'll try you again later. Goodbye.` instead — never silence. |
| `POST /twilio/outbound-status` | Twilio signature | Every event updates `call_attempts.twilio_status`; `in-progress` also stamps `answered_at`. The terminal statuses -- `completed`, `busy`, `no-answer`, `failed` and `canceled` -- also stamp `ended_at`/`status_completed_at`, set `result` on the four non-`completed` ones, and trigger post-call (`postCall.tryClaim`). **Fix round 1, item 9:** the `calls` row is completed only on the FIRST terminal stamp of an attempt that was actually answered -- an attempt that never connected has no `calls` row, and a duplicate terminal callback must not move `calls.ended_at` a second time. It **never** sends the inbound "missed call" text and never applies the inbound spam heuristic. |
| `POST /twilio/outbound-amd` | Twilio signature | The async AMD verdict (§9.4). |
| `GET /media/outbound/:callSid/:kind.wav?exp=…&sig=…` | HMAC-signed URL, 10-minute TTL | Serves the voicemail audio to Twilio `<Play>`, wrapped as WAV μ-law. `kind` is `voicemail`. **Plan correction C15:** the path carries the CallSid, not the attemptId — the door resolves the tenant with `app_outbound_attempt_by_call_sid`, which works before the tenant is known; an attemptId would need a fourth definer function. |
| `POST /internal/outbound/dispatch` | Google OIDC ID token from the `outbound-tasks` service account; audience is the service URL | The Cloud Tasks handler (§10). |
| `POST /internal/outbound/sweep` | Same OIDC check | The Cloud Scheduler handler, every 5 minutes. |
| `POST /v1/triggers/:triggerToken` | A 32-byte random token per campaign, stored hashed | The generic JSON trigger (§12.1). |

OIDC verification reuses the existing `jsonwebtoken` + `jwks-rsa` stack (Identity Platform verification) against Google's certs, checking `aud`, `iss` and `email`.

### 9.2 Session start (`lib/voice/live/index.js` `onStart`)

- When `customParameters.direction === "outbound"`, the session resolves context **by CallSid** through `app_outbound_attempt_by_call_sid`. It never trusts stream parameters for identity; the token binds only the CallSid. If there is no match, it logs `outbound_context_missing` and closes the call.
- It loads the business **by ID**, under the tenant scope that `app_outbound_attempt_by_call_sid` sets, using the existing `fetchBusinessById` / `fetchBusinessCapabilities`. No new `lookupBusinessById` is needed; see plan correction C7. It then runs the existing `loadConfig` and builds an `outboundContext`:
  - direction and attempt;
  - campaign version config;
  - contact (first name and timezone only in the prompt);
  - trigger summary;
  - the opener text as rendered;
  - `party: { phone, source: "dialed", verified: false }`.
- It creates the `calls` row with `direction: 'outbound'` and the link columns, and writes `direction` and `attemptId` to `call_state`.
- **Inbound code paths are untouched**: an absent `direction` parameter means inbound, exactly as today.
- **Amended 2026-09-25 (Task 14, session 2b; owner decision D-b and Ruling P-3).**
  - **No caller history, no "THIS CALLER'S NUMBER" block on outbound (D-b).** The session does not call `fetchCallerContext` for an outbound call, and the `THIS CALLER'S NUMBER` prompt block (`services/gemini.js`) is not emitted. Inbound is byte-identical.
  - **`extras.callerPhone` stays empty on outbound (P-3).** `state.callerNumber` is the contact's dialled number, because `calls.caller_number` means "the other party" (§6.2) and `createCall` receives it as `callerNumber`, with the campaign's `caller_id` as `twilioNumber`. With `extras.callerPhone` empty the number block emits nothing, and the phone-keyed tools (`phone_on_file`, `lookupByCaller`, `clientPhone`) fail closed until `ctx.party` (§9.6, Task 18) carries the phone.
  - **Identity is the token's CallSid.** `ws.authorizedCallSid` (bound by the signed media-stream token) is resolved; `customParameters.businessPhone`/`callerPhone` and the `LIVE_BUSINESS_PHONE` override are not read on the outbound branch. `direction` only selects the branch: a forged `direction` on an inbound call's stream finds no attempt and is closed with 1008 and `outbound_context_missing`. With token enforcement explicitly off (`TWILIO_VALIDATE_SIGNATURE=false`, a local rig) the start frame's CallSid is used; with it on and no CallSid bound, the stream is refused.
  - **The business config is the inbound one.** The business row plus its capability rows (`fetchBusinessById` + `fetchBusinessCapabilities`, the same shape `lookupBusinessByPhone` returns) go through the same `loadConfig`; the campaign config and the rest of the context live on `state.outboundCall` / `extras.outboundCall` (named for the "outbound means model audio" collision in `lib/voice/live/index.js`).
  - **The opener is re-rendered at call time** from the current values (O-4). Over 120 characters, the stored clip is not used (`outbound_backstop_render_refused {attemptId, chars}`) and the §9.3 prompt path applies.

### 9.3 The first seconds (revised 2026-09-24 after spikes A and B, owner-approved)

**The rule is Ofcom's, and it has two limbs.** The person must hear us no later than **2 seconds after they begin to speak**, or no later than **2 seconds after pickup** if they say nothing (Ofcom, *Revised statement of policy on persistent misuse*). The earlier draft read this as "2 s from pickup, always". Measured on the owner's two answered calls, people say "Hello?" **1.87 s and 2.2 s after answering**, so that reading makes Ava talk over them. The owner reported exactly that on spike B call 1 ("it did not let me say hello").

**Ava responds to what the person says. She does not recite a line at them.**

1. **Rendering while it rings.** After `calls.create`, dispatch opens a short Gemini Live session in the tenant's Live voice (D6) and has it speak two lines verbatim, then stores them as 8 kHz μ-law.
   - The first is the **backstop line**, the rendered `opener`: at most 120 characters, e.g. "Hi, is that Sam? It's Ava, an AI assistant from Digile Media." It goes in `call_attempts.opener_audio`.
   - On attempts in `voicemail_on` it also renders the voicemail message, into `voicemail_audio`.
   - Spike A measured this path: Live spoke a given line verbatim in 3/3 runs, session setup took about 140 ms, and first audio arrived 0.54–0.85 s after the request.
   - If rendering fails, the call proceeds without a backstop, logs `outbound_backstop_missing`, and the silence path in step 3 prompts Live directly. G2 is then monitored on that call, not guaranteed.
   - **Amended 2026-09-25 (Task 13, session 2b).** The opener and voicemail TEXT are rendered from the claimed row's CURRENT values (`lib/outbound/dispatch.js`, `renderTemplate` + the row's `first_name`/`business_name`/`persona_name`/`topic`/spoken `caller_id`) before Live ever runs. A business renamed after the campaign was saved can push that rendered text over budget even though save-time validation (§7) passed against a worst-case name length. Over budget at render time is **refused, never truncated -- the same outcome as a failed render**: the field is omitted from the `lines` passed to the Live rendering step, logged `outbound_backstop_render_refused` / `outbound_voicemail_render_refused` `{attemptId, chars}`, and whichever key is missing takes the same path as a failed render above (`outbound_backstop_missing` for the opener, prompted directly by Live). If neither line is safe to render, the Live rendering step is not even called.
2. **Listen first.** When the stream starts, the session opens Live with the OUTBOUND CALL prompt (§9.5), forwards the caller's audio from the first frame, and **stays silent**.
3. **Three ways the first turn happens:**
   - **The person speaks first.** The existing inbound VAD (`lib/voice/inboundVad.js`) marks speech onset, and Live hears the person and replies in context:
     - "Hello?" gets "Hi, is that Sam? It's Ava, an AI assistant from Digile Media."
     - "This is Sam, how can I help?" gets "Hi Sam, it's Ava, an AI assistant from Digile Media. You recently filled in our form about…"
     - "Who's calling?" gets name, company and reason, then "Is Sam available?"

     Spike A measured the end of the caller's speech to Live's first audio at **0.93–1.06 s**, well inside the 2 s from speech onset.
   - **Live is slow.** If speech onset was detected but Live has produced no audio **1,600 ms after onset**, the session plays the backstop clip and seeds its text as Live's own first turn. Spike A: seeding is a GO, 6/6 across both seed shapes, with no speech before the caller, no second introduction and a coherent next question. Live then carries on from what the person says next.
   - **Nobody speaks.** At **2,000 ms after pickup**, the session plays the backstop clip and seeds it the same way.
     - The pickup time is the stream start minus the measured 320–370 ms offset from answer to stream start, i.e. about 1,650 ms after the stream starts.
     - Spike B fired at 1,500 ms after stream start, which is 1.83 s after pickup. That caught the owner's hello at 1.87 s by 36 ms.
4. **The backstop is short and interruptible.** If the person starts talking while it plays, it stops through normal barge-in and Live answers them, the way two people who say hello together sort it out. This replaces the earlier rule that "the opener cannot be cut". That rule only made sense for a 10-second pre-recorded speech.
5. **First-turn check (G3).** After Ava's first turn, a detector checks her transcript for the business name and an AI disclosure (§7 regex). If either is missing, the session sends Live a one-line note to say it now, and logs `outbound_first_turn_incomplete`. On Live a sentence cannot be blocked before it is spoken, only corrected immediately after, so this is detect-and-correct (see *live-removes-the-text-chokepoint*).
6. **Measurement.** `outbound_first_audio{from_answer_ms, from_speech_ms, path}`, where `path` is `live_reply`, `backstop_silence` or `backstop_slow`. A human-answered call that breaks the applicable limb is a silent call (§13.4).
7. **Voicemail greetings sound like speech.** Live may start answering the greeting. That is harmless, because nothing is recorded before the beep, and it ends when the AMD verdict redirects the call (§9.4). The first-turn detector and outcome resolution ignore machine-answered calls.
8. **The backstop timing is tuned in live round 1** against real hello timings. The two measured hellos straddle 2.0 s, so an occasional overlap is expected, and step 4 is what makes that acceptable.
9. **Amended 2026-09-25 (Task 14, session 2b; fix rounds 1-2, owner decisions O-6, O-7, O-8).** `lib/outbound/firstSeconds.js` implements the steps above with these refinements:
   - **Speech onset is confirmed speech (O-6).** Onset is the inbound VAD's sustained flag (`voiceActive`, about 200 ms of unbroken voice), not a single voiced frame, and its time is backdated to the start of that voiced run. A lone loud frame (pickup handling noise) therefore cannot move the deadline from pickup + 2.0 s to onset + 1.6 s, and a real hello keeps its true start for `from_speech_ms`. If a voiced run is under way but not yet confirmed when the silence deadline arrives, the backstop waits up to `ONSET_CONFIRM_DEFER_MS` (200 ms): a run that confirms takes the slow-Live path; a run that dies fires the backstop at once.
   - **The queue deadline is unchanged; the metric is taken at playout (O-7).** The silence backstop is still queued at pickup + 2.0 s (stream start + 1,650 ms). `outbound_first_audio{from_answer_ms, from_speech_ms, path, measured}` is measured when our first audio STARTED PLAYING, on every path (`live_reply`, `backstop_silence`, `backstop_slow`, the prompt path): a mark (`outbound-first-audio`) is queued immediately before the first frame of our first audio, and its echo is the playout time. If the echo never arrives (the person hung up first), the queue-time values are logged with `measured: "enqueue"`, never silently in place of a playout time. Truly silent pickups therefore read about 2.1-2.3 s until live-round-1 tuning; post-call (§13.4) flags them.
   - **The slow-path seed waits for the clip (O-8).** On `backstop_slow` the seed is sent only when the clip's end mark (`outbound-backstop-end`) echoes: a `clientContent` seed interrupts Live's in-progress generation, and the resulting `interrupted` would clear our own clip. Live's audio stays suppressed while the clip plays. A slow-path clip cleared before its end (a barge) is never seeded; one whose end mark never echoes is not seeded late either. The silence path still seeds when the clip is queued (Live is not generating then; spike A's shape).
   - **A cut clip is not a disclosure (fix round 1, I1).** A backstop cleared while still playing re-arms the first-turn check (step 5), so Live's next turn must carry the AI disclosure and the business name or it is corrected.
   - **Safety lift (fix round 1, M9).** The suppression lifts at clip length + 1,500 ms even if the end mark never echoes (`outbound_backstop_mark_timeout`).
   - **The opener is stored as soon as it is rendered (fix round 1, I4).** Dispatch stores each verified clip in its own write as it finishes, so the opener never waits for the voicemail; a session that found no clip at stream start re-reads it once, 400 ms before the deadline, and takes the prompt path if the read has not answered by then.
   - **No first name (O-9):** see §7. When no opener text is usable, the silence path asks Live to introduce itself with the disclosure instead of reading a line.

### 9.4 Answering machines (async AMD)

`calls.create` uses `MachineDetection=DetectMessageEnd`, `AsyncAmd=true` and `AsyncAmdStatusCallback=/twilio/outbound-amd`. AMD takes one of the four per-call stream forks, alongside the one bidirectional stream.

**`Timeout` is 40 s on attempts listed in `voicemail_on` and 25 s otherwise. This was revised after spike B.** Ofcom needs at least 15 s of ringing and sets no maximum.
- With `Timeout=25`, the owner's US carrier rang for 24 s and ended `no-answer` (SIP 487) **before voicemail picked up**, so no message could be left.
- With 45 s, voicemail answered after **26.6 s** of ringing.

**A declined call ends one of two ways, and both are handled by what Twilio reports, not by guessing.**
- **Sent to voicemail**, as measured on spike B call 3 (the owner's US carrier): voicemail answered 7 s after ringing began, then `machine_end_beep`, and a message was left. This is handled as a voicemail attempt (`voicemail_left` / `voicemail_skipped`).
- **Ended outright:** some carriers, phones and settings (e.g. "decline with busy", some UK networks) end the call immediately. Twilio then reports `busy`, or `no-answer`/`failed`, and it is handled **exactly like an unanswered attempt**: `result` is `busy` or `no_answer`, no message is left, and the next schedule entry applies (§8).

Neither path is treated as "not interested", because a decline often just means "not now". UK carriers are unmeasured (D7).

On the AMD callback:
- **`human`, `unknown`:** record the value and change nothing.
- **`machine_end_beep`, `machine_end_silence`, `machine_end_other`:** if the attempt is in `voicemail_on` **and** the campaign's class permits a message, `calls(sid).update({ twiml: <Play>signed voicemail URL</Play><Hangup/> })`; result `voicemail_left`. Otherwise `calls(sid).update({ status: "completed" })`; result `voicemail_skipped`. Redirecting the call ends the media stream, and the session's normal `stop` handling tears it down.
- **`machine_start`** (reported before the greeting has finished, which DetectMessageEnd should not normally return): wait for the `machine_end_*` event, which DetectMessageEnd guarantees.
- **`fax`:** hang up; result `failed`.

A machine-answered call is excluded from silent-call accounting.

### 9.5 Prompt and wording (`services/gemini.js`, `lib/voice/strings.js`)

- **Static prefix identity**, outbound only: "You are {persona_name}, an AI assistant calling on behalf of {business_name}." The inbound identity line stays byte-identical, and G9 is enforced by the golden snapshots.
- **New dynamic block `OUTBOUND CALL`**, rendered only when direction is outbound:
  - who you are calling (first name), and why (objective, topic, trigger summary);
  - **the first-turn rule (§9.3):** wait for the person. Your first reply must include your name, that you are an AI assistant, and the business name, and must respond to what they actually said. If the backstop line was already played (it is seeded as your own turn), do not repeat it;
  - that the person's identity is not yet confirmed. For a `business` audience, confirming their name is enough. If it's the wrong person, say who you're calling for, offer to call back, and share nothing else;
  - how to handle a call screener: state your name and reason once, then wait;
  - that you never claim to be human, and if asked, you confirm you are an AI;
  - the allowed actions (the campaign's capabilities), and how to end the call politely.
- **Direction-aware strings:** sign-off ("Thanks for your time, {first_name}"), silence nudges ("Are you still there?"), and the goodbye detection used by the `end_call` gate. `closingTicRe` and `signOffRe` gain the outbound phrasings. Per the earlier closing-sequence defects, sabotage the **whole** alternation, not one branch.
- The recorded-call disclosure line is never emitted on outbound. Ava's first turn carries the AI disclosure, and the transcription notice (D4) is said on request, or in the first turn if the tenant's disclosure flag is on.
- **Who picks up: the situations Ava must handle** (owner-approved 2026-09-24). Most of this is prompt guidance in the OUTBOUND CALL block. The tools named are already in §12.2.

  | Who or what answers | What Ava does |
  |---|---|
  | The contact | Confirms their name (`confirm_identity`), then gives the reason for the call. |
  | A receptionist, secretary or gatekeeper | Asks for the contact by first name and gives only a vague reason ("following up on an enquiry {first_name} made"). Waits politely if put through or on hold. Otherwise offers a callback (`schedule_callback`) or leaves a short message. Discloses no enquiry details. |
  | A child, relative or anyone else | Asks for the contact and shares nothing else. **Never asks a child anything.** Offers to call back and ends kindly. Outcome `wrong_person`, unless a callback is booked. |
  | A wrong number | Apologises and ends. Adds a suppression with reason `wrong_number`. Outcome `wrong_person`. |
  | A phone's call-screening assistant (Google Call Screen, iOS) | States name and reason once, then waits. |
  | "Bad time", driving, busy | Offers a specific callback time (`schedule_callback`). |
  | "How did you get my number?" | Explains the enquiry or form. Offers to stop calling (`opt_out`). |
  | "Stop calling" / "take me off your list" | `opt_out` immediately, then confirms (§13.3). |
  | "Are you a robot / real person?" | Always says it is an AI assistant (§13.2). |
  | A voicemail greeting | Nothing special. AMD redirects the call (§9.4). |

  Live round 1 (§15) adds a gatekeeper scenario and a "someone else answers" scenario.

**Amended 2026-09-25 (Task 16, session 2b; owner decisions D-b, D-c, O-1, O-2).**
- **D-b, made explicit for the prompt too.** The "THIS CALLER'S NUMBER" block (`services/gemini.js`) is skipped on outbound by an explicit `!outbound` check, not only because `extras.callerPhone` happens to be empty (Ruling P-3) — Task 18's `ctx.party` must not resurrect it by way of a different field.
- **D-c + O-1 (amends §12.2 too).** The situations table's tool names (`confirm_identity`, `schedule_callback`, `opt_out`, `wrong_person`) are the eventual shape once the stage-3 packs (`qualification`, `outcome`, `callback`, `opt_out`) and Task 18's `confirm_identity` exist. Until then, none of those tools are declared, so the OUTBOUND CALL block states every row's behaviour in plain English only — never a function name the model was not given (the same phantom-tool failure `hasAppointments` gating exists to prevent). The **allowed-actions** bullet is likewise limited to capabilities that already have a real pack (`appointments`, `transfer` today): `lib/outbound/prompt.js`'s `CAMPAIGN_CAPABILITY_LABELS` grows by one line the day each stage-3 pack ships, in the same commit that registers it.
- **O-2, the transcription notice.** With `config.recordingDisclosureEnabled` on, the OUTBOUND CALL block tells Ava her first reply must carry the notice too (`recordingDisclosureText` or `TRANSCRIPTION_DISCLOSURE`), UNLESS the opening line already appears in the conversation as her own turn (the backstop was seeded first — spec §9.3), in which case she gives it on her very next reply instead. The prompt cannot know in advance which case applies (the backstop timing is decided after the prompt is frozen at connect, per LVX46), so both instructions are always present and the model resolves the branch from what it can see in the conversation. With the flag off, the notice is given on request only, worded to avoid `lib/voice/disclosure.js`'s own `claimsRecording` patterns (a literal "call is/are ... recorded" reads as a claim to that detector, and this line is the answer to a caller's question, not a claim).
- **D-c also narrows PROMPT TEXT, not only tool declarations.** `messages` and `transfer` are `core: true` and contributed their static/dynamic prompt fragments unconditionally before this task — `messages` is not even a legal outbound campaign capability (`lib/outbound/campaignSchema.js` `CAMPAIGN_ENUMS.capabilities` has no `messages` entry), so the MESSAGE PROTOCOL section naming `record_customer_request` would otherwise appear on every outbound call, forever, for a tool that call can never have. `lib/capabilities/promptAssembler.js`'s `outboundAllowsPack` gates all three pack-contributed prompt channels (static fragments, step guidance, caller-context rules) on the same campaign-capability intersection as the tool declarations; `services/gemini.js`'s two remaining hardcoded, pack-independent mentions (the TOOL CONTRACT bullet naming `request_transfer`, and the NON-NEGOTIABLE availability rule naming the check-availability tool) get the same guard inline. A no-op whenever `extras.outboundCall` is absent, so inbound is unaffected.

**Amended 2026-09-25 (Task 16 fix round 1; owner decisions O-10, O-11).**
- **O-10.** The `IDENTIFY_INTENT` step guidance's opening clause, "Your task: Figure out why the caller is calling.", is suppressed on outbound (`buildStepGuidance`'s `identify_intent` case) — backwards framing for a call Ava placed, and the OUTBOUND CALL block already says who and why. Only that opening clause is dropped; the mechanical instruction that follows it (call `set_call_intent` as soon as the intent is clear) is unchanged, because O-1 still needs it to leave `IDENTIFY_INTENT`. Every OTHER step's guidance (`gather_details`/booking, `confirm`, `ending`, …) is untouched on outbound.
- **O-11.** The whole `=== AFTER-HOURS BEHAVIOR ===` block is suppressed outright on outbound (`!outbound &&` added to its existing `!open && config.businessHours` gate). It describes whether the TENANT's own office is open to answer an inbound call, which has nothing to do with a call Ava placed — the campaign's `calling_window` (§7) is what governs when we call at all, and a closed slot is still refused through the ordinary scheduling rules (`businessHoursOnly`, `check_appointment_availability`), neither of which lives in this prompt block.
- **Review fix (Important).** Two GUARDRAILS bullets and one VOICE RULES bullet were unconditionally self-described as "a receptionist", contradicting the outbound identity ("an AI assistant calling on behalf of …"): the medical/legal/financial-advice disclaimer, the internal-vocabulary ban, and the "ask for what you need the way a receptionist would" line (which also carried an inbound-only example question, "what are you coming in for?", dropped on outbound). All three now branch on `outbound`, self-describing as "an AI assistant" and keeping the rest of each bullet's policy unchanged; inbound wording is byte-identical.
- **Deferred to the checkpoint (not this round):** `set_call_intent`'s declared parameter still enumerates the tenant's full intent list (from `config.allowedTasks`) with no corresponding tool declared for most of them on a narrow campaign — flagged, not fixed, this round.

### 9.6 Identity and appointments

`ctx.callerPhone` consumers (`adapters/scheduling/internal.js:47-53`, `appointments.js:837-878`, `requirements.js:98-107`) read a new `ctx.party`. For outbound, `party.phone` is the dialled number, and `phone_on_file` is satisfied **only after** the model has confirmed the person's name (new engine tool `confirm_identity({ name_confirmed: true })`, outbound only). Bookings write `clientPhone = party.phone`. The Live write-order consent gate (read-back plus yes) applies unchanged. Inbound keeps `callerPhone` semantics exactly.

**Amended 2026-09-25 (Task 18, D-c, filled in retroactively — this paragraph documents what shipped but was never written back into this section).** `confirm_identity` is an ENGINE tool, exactly like `set_call_intent`/`end_call` — it belongs to no capability pack, is declared unconditionally whenever `extras.outboundCall` is present (never gated by the campaign-capabilities filter that gates every pack tool), and is handled by its own `case` in `services/tools.js` `executeToolCall`, beside the other two engine tools. `{name_confirmed: true}` sets the session's `ctx.party.verified` true; `{name_confirmed: false}` sets (or leaves) it false — a straight passthrough, so a later call can flip either direction. D-c: every TEXT-SENDING deferred effect on an outbound call — the booking confirmation SMS, `sms_consent`'s held-text release, and (should they ever reach outbound) the `messages`/`quotes` callback SMS — requires `party.verified`; the OWNER-facing alerts (`notifyAppointmentBooked`, `notifyCustomerRequest`) are deliberately not gated, because they are not sent to the party.

**Amended 2026-09-25 (fix round 1, opus review).**
- **Owner ruling O-12.** `ctx.party` being unverified refuses **every ACTION tool** the capability packs declare (`pack.actionTools` — booking, rescheduling, cancelling, notes, EHR writes, …), not merely the ones a tenant happened to configure `phone_on_file` for. This is an IMPLICIT `phone_on_file` on outbound, unconditional on the tenant's own opt-in, enforced in `services/tools.js` `executeToolCall` ahead of every other action-tool gate (consent, spelling, `checkRequirements`). The refusal is a single line telling the model to call `confirm_identity` first.
- **Owner ruling O-13.** Every capability effect (`stateEffects.capabilityEffects`) is STAMPED with `ctx.party` at the moment `executeToolCall`'s `default` case produced it — an immutable snapshot, because the tool runner (`lib/voice/live/tools.js`) reassigns its `party` variable rather than mutating the object in place. Dispatch (`capabilities/*.js` `onEffect`, via `lib/capabilities/party.js`'s `partyOfEffect(effect, engineCall)`) reads the STAMP, never the live value at dispatch time. This closes the race O-12 alone does not: without it, a `confirm_identity(false)` on a LATER turn could cancel a text a verified write had already earned, and a `confirm_identity(true)` on a later turn could release a text for something that (had O-12 ever been bypassed) happened while unverified.
- **Important I2.** The unconditional `partyOf(ctx).phone` substitution Task 18 made at `smsConsent.js`'s consent write and `appointments.js`'s EHR `caller_phone` reopened both paths for an unverified party, because neither tool is DECLARED on outbound today but nothing at the EXECUTION layer enforced that. Fixed two ways: (a) both sites now read `party.verified ? party.phone : null`, which the sites' own existing "no caller ID" refusals already turn into a fail-closed refusal; (b) **Controller Ruling 1819-a** adds an EXECUTION-time gate to `executeToolCall`'s `default` case — on outbound, a tool name reaching dispatch must belong to a pack the campaign's own `capabilities` list actually names, the same D-c filter `buildAllDeclarations` already applies to what the model is even offered. A tool `packForTool` resolves but the campaign never listed is refused before it can execute, closing the gap the reviewer's probe found (`record_sms_consent`, never declared on outbound, still wrote `granted: true` for an unverified party).
- **Important I3.** Post-call teardown (`lib/voice/live/index.js`, `verifyCall`/`recoverOwedBooking`) read `state.callerNumber` — the CONTACT's phone on outbound — unconditionally. Fixed: at call end, on outbound, when the party is not verified (`runner.party.verified`, the live value at teardown), `callerNumber` is nulled before it reaches `verifyCall` (whose own `isValidE164` check then refuses its `appointment_request_pending` text), and `recoverOwedBooking` is skipped OUTRIGHT rather than merely de-identified — nulling `callerNumber` alone is not enough, because it still writes a booking (`clientPhone: null`) regardless of whether a number was given; only the name lookup inside it is gated on the number.
- **Important I5.** `confirm_identity`'s description dropped the parenthetical "(or a business contact has done so on their behalf)" — it let a gatekeeper's word stand in for the contact's own, which is exactly what O-12 exists to prevent. It now requires the person THEMSELVES to confirm they are `{first_name}` (or, with no first name on file, their own identity generally) and says so explicitly: never on a gatekeeper's, receptionist's or relative's word.

### 9.7 Transfer

The existing `request_transfer` / `redialForTransfer` (`live/index.js:5148-5162`), outbound variant:
- `callerId` is the campaign's `caller_id`, **not** the contact's number.
- The dialled number carries `<Number url="/twilio/outbound-whisper?attempt=…">`, whose TwiML says "Transfer from {persona_name}: {first_name}{, clinic_name if answered}." before the call is bridged.
- The allowed window comes from `transfer.when`.
- If nobody answers the transfer (a `<Dial>` timeout of 20 s), `<Dial action>` returns TwiML that says "{transfer name} will call you back shortly" and hangs up. Post-call records the outcome `callback_requested` with a `transfer_unanswered` note, and the owner notification says so. Resuming the AI session after a failed transfer is out of scope for Part 1.

**Amended 2026-09-25 (fix round 1, owner ruling O-14).** The outbound `<Dial>` also carries `ringTone`, resolved from the BUSINESS config exactly the way the inbound branch already resolves it (`resolveRingTone(state.config)`) — the staff member being transferred to hears ringing even when their own carrier supplies no early media, the same as an inbound transfer target does.

### 9.8 Spike results (2026-09-24, session 1)

**Spike A** (`scripts/spikes/spike-a-opener.mjs`; `gemini-3.8-live` on AI Studio, voice Kore, en-GB; N=3 per arm; $0.035).

| Arm | Before the caller spoke | Re-introduced itself | Coherent next question | API errors | Caller end to reply |
|---|---|---|---|---|---|
| S1: opener seeded as a lone `role:"model"` turn, `turnComplete:false` | 0/3 spoke | 0/3 | 3/3 | 0 | 927–948 ms |
| S2: `(call connected)` user turn, then the model turn | 0/3 spoke | 0/3 | 3/3 | 0 | 938–946 ms |
| F: Live speaks the opener itself (system prompt plus kick) | spoke it verbatim 3/3 | 0/3 | 3/3 | 0 | 940–1,057 ms; opener first audio 538–846 ms after the kick |

- **The seeding decision:** the pre-registered rule said GO for seeding, for both shapes. Seeding is used for the backstop path (§9.3).
- **The voice decision, by ear, the owner's (D6):** Live's voice throughout. The Chirp 3 HD samples (Kore, Aoede, Leda) were rejected for tone and pace. Chirp also runs slow through `buildSayContent`'s 300 ms-per-sentence SSML breaks: the 138-character opener took 9.2–10.3 s.
- **Session setup** took 134–151 ms warm and 599 ms cold.

**Spike B** (`scripts/spikes/spike-b-dial.mjs`; account B, `+18176011171` to the owner's US mobile; a cloudflared tunnel; async AMD, DetectMessageEnd; a bidirectional `<Connect><Stream>`; five calls; about $0.13, over-estimated).

| Call | What happened | Measured |
|---|---|---|
| 1: answer | Clip played at stream start and talked over the owner's "Hello?" | Answer to stream start 334 ms; audio at about 0.39 s; hello at 2.2 s; AMD `unknown` after 5.7 s |
| 2: let it ring, `Timeout=25` | `no-answer` (SIP 487) before voicemail picked up | Rang 24 s |
| 2b: let it ring, `Timeout=45` | Voicemail answered; beep detected; REST redirect `<Play>`ed the message. **The owner confirmed the message is there and starts cleanly** | Voicemail answered after 26.6 s of ringing; AMD `machine_end_beep` after 10.6 s; redirect to fetch 114 ms |
| 3: decline | Went to voicemail; message left | Voicemail after 7 s; beep after 10.5 s |
| 4: answer and say "Hello?" (clip waits up to 1.5 s after stream start) | The timer fired 36 ms before the owner's hello, so the owner still felt talked over | Answer to stream start 319 ms; hello at 1.87 s; AMD `human` after 3.4 s |

**What changed because of the spikes:** §9.3 (listen first, the two-limb rule, a short interruptible backstop), §9.4 (a 40 s ring on voicemail attempts; decline reads as voicemail), §7 (the opener is at most 120 characters), D6 (the voice) and G2/G3.

**Still unmeasured:** UK carriers (the UK leg is deferred per D7), the real distribution of hello timings (live round 1), and Gemini Live under load.

## 10. Dispatch, gate, capacity and dialling

### 10.1 Dispatch flow (`POST /internal/outbound/dispatch`, payload `{ business_id, outreach_id }`)

1. `withTenant(business_id)`: `SELECT … FROM outreach WHERE id = $1 FOR UPDATE SKIP LOCKED`. If the row is locked or its state is not `waiting`, return 200 and do nothing.
2. Run the gate (§10.3). On "later", update `next_attempt_at`, enqueue a new task and return. On "never", close the outreach and return.
3. `INSERT call_attempts (outreach_id, attempt_no = attempts_made + 1, …)`. A unique violation means another dispatcher won the race: return and do nothing. **This is the double-dial lock.**
4. Set the outreach to `dialing`, increment `attempts_made`, commit.
5. Resolve the Twilio account that owns `caller_id` (amended 2026-09-26, post-2c, owner decision O-26/C17; `lib/outbound/twilioAccounts.js`) and call ITS `calls.create`, then store the `twilio_call_sid`. If `calls.create` fails, record `result = failed`, return the outreach to `waiting` with the next schedule entry, and log `outbound_dial_failed`. Every other outbound REST call about this attempt -- hanging up an unroutable call, the AMD voicemail update, the transfer redial, the sweep's lost-callback fetch -- resolves the SAME way, from the attempt's own campaign `caller_id`.
6. Render the opener and voicemail audio (§9.3) and store them. Return 200.

Cloud Tasks retries a non-2xx response up to 3 times. Because of steps 1 and 3, a retry can never produce a second call.

### 10.2 Enqueueing

`lib/outbound/tasks.js` wraps `@google-cloud/tasks`: queue `outbound-dispatch` in `europe-west2`, a task name derived from `outreach_id` and `next_attempt_at` (so a duplicate enqueue deduplicates), `scheduleTime = next_attempt_at`, and an OIDC token for the `outbound-tasks` service account. The sweep (`app_outbound_due`) re-enqueues anything overdue by more than 2 minutes.

### 10.3 Eligibility gate (`lib/outbound/gate.js`), evaluated in this order

The first failure decides. Every refusal logs `outbound_gate_refused{reason}`.

| # | Check | Result on failure |
|---|---|---|
| 1 | `OUTBOUND_ENABLED=true`, **or** the destination is in `OUTBOUND_TEST_ALLOWLIST` | never: `global_disabled` |
| 2 | `businesses.outbound_enabled` | never: `business_disabled` |
| 3 | Campaign `status = active` | later (held, not closed): `campaign_paused` |
| 4 | Destination not in `suppressions` | never: `suppressed` |
| 5 | Consent satisfies the compliance class (§13.1) | never: `consent_missing`, `consent_expired` or `consent_not_automated` |
| 6 | `hold_until` has passed (the silent-call block) | later: `silent_hold` |
| 7 | Inside the calling window in the contact's timezone | later: `outside_window` |
| 8 | Attempts under the schedule length; creation within `give_up_after_days` | never: `attempts_exhausted` or `give_up_window` |
| 9 | Per contact: at most 3 dial attempts per local day across all campaigns (amended 2026-09-26, owner: not applied while OUTBOUND_ENABLED=false — only allow-listed test numbers are reachable then) | later (next day): `daily_contact_cap` |
| 10 | Capacity: global outbound < `OUTBOUND_MAX_CONCURRENT` − `OUTBOUND_INBOUND_RESERVE`, and business outbound < `outbound_max_concurrent` | later (+30 s): `capacity` |
| 11 | `caller_id` is still an owned number on exactly one CONFIGURED Twilio account (checked at most once an hour per number; amended 2026-09-26, post-2c, owner decision O-26/C17 -- was account A only) | never: `caller_id_invalid` |

The defaults are `OUTBOUND_MAX_CONCURRENT=8` and `OUTBOUND_INBOUND_RESERVE=2`, together with the existing Cloud SQL connection budget (38 of 50). Twilio's own account limit, which is unknown until the console check, may be lower. If `calls.create` returns Twilio's concurrency error, it is treated as `capacity`.

## 11. Post-call

Post-call (`lib/outbound/postCall.js`) runs **exactly once per attempt**, even though its two inputs can arrive on different instances in either order:

- **Answered calls** need both the `completed` status callback (which stamps `call_attempts.status_completed_at`) and the session's `finish` (which persists tool results and stamps `session_finished_at`).
- **Unanswered calls** need only the status callback.

Whichever arrives second claims the run with an atomic `UPDATE call_attempts SET post_call_started_at = now() WHERE id = $1 AND post_call_started_at IS NULL AND <inputs present> RETURNING id`. If a session dies without finishing, the sweep runs post-call for any attempt whose `status_completed_at` is more than 2 minutes old and whose `session_finished_at` is null. It logs `outbound_postcall_without_session`.

> **Amended 2026-09-26 (post-2c, owner decision O-23/b29).** This no-session path used to resolve the outcome from the summary ONLY. It now resolves it the SAME way an answered call with a session does -- the door/tool-set `outcome_code` first, then effects (`outboundCallEffects`), then the summary -- so a contact who booked (or was flagged opted-out) before the session crashed is not redialled. Only the `outbound_postcall_without_session` log/counter, and the silent-call verdict (§13.4, a separate ruling), still branch on whether a session ever finished.

> **Amended 2026-09-25 (Task 20, session 2b).** The sweep finds these attempts (and the `sidless`/`lost_callback` backstops alongside them) through migration 045's `app_outbound_stale_attempts` (§6.3), never by scanning `call_attempts` itself -- it has no tenant, and 042-044 gave it no cross-tenant list to read. A `sidless` row is failed and rescheduled the same way dispatch's own `failAndReschedule` would (never twice: the outreach's `attempts_made`/state guard applies here too). A `lost_callback` row is resolved with one read-only `calls(sid).fetch()` against Twilio, stamped exactly as the status door would on a terminal result, then handed to `postCall.tryClaim`.

The steps:

1. Set `call_attempts.result` and `ended_at`, and clear `opener_audio` and `voicemail_audio`.
2. Resolve the outcome:
   - the model's `set_call_outcome` if it was called;
   - otherwise derive it from effects: a booking means `booked`, an opt-out means `opted_out`;
   - otherwise use the existing summary generation (`generateSummaryAndSentiment`), extended with the outbound outcome enum, falling back to `unknown`.
3. Run the opt-out detector (§13.3).
4. Persist `calls.outcome_code`, `calls.answers`, `contacts.attributes.answers[campaign_id]`.
5. Apply the state machine (§8): close the outreach, or compute and enqueue the next attempt.
6. On a miss, if the attempt is in `text_after_missed` and SMS is available (§12.4), send the text.
7. Write outbox rows for `call.completed` (every attempt) and `outreach.closed` (on close).

Unanswered attempts (no-answer, busy, failed) follow steps 1 and 5–7 only.

## 12. Stage 3 features

### 12.1 Generic trigger webhook

`POST /v1/triggers/:triggerToken`, body:

```jsonc
{ "phone": "+447…", "first_name": "…", "last_name": "…", "email": "…",
  "timezone": "Europe/London",                      // optional
  "consent": { "purpose": "enquiry_followup", "channels": ["call","sms"],
               "covers_automated": true, "wording_version": "v1",
               "wording_text": "…", "captured_at": "ISO", "source_ref": "form-123" },
  "data": { "any": "form fields" },
  "idempotency_key": "form-123" }                    // defaults to a hash of phone + source_ref
```

The endpoint validates E.164, upserts the contact, records the consent, creates the outreach (idempotent), enqueues, and returns 202 with `{ outreach_id }`. A request without a `consent` block is accepted only for `service`-class campaigns. In Part 2, GoHighLevel's workflow webhook maps its payload onto this body.

**Operator trigger for testing:** `scripts/outbound-trigger.js --campaign <id> --phone <e164> [--first-name …] --confirm` is a dry run by default. It runs through the migrate job (Cloud SQL is private-IP). It needs a Dockerfile COPY line and a `.dockerignore` negation (the scripts allowlist).

### 12.2 Capability packs (following `capabilities/_contract.js`; registered in `capabilities/index.js`)

- **`qualification`** (tool `record_answer({ key, value })`):
  - Rejects unknown keys. Values are at most 500 characters.
  - Answers accumulate in the session and are persisted post-call.
  - Required questions gate `book_appointment` with **one** refusal naming the missing keys (a ceiling of 1). After that the booking proceeds and the missing keys are flagged in the outcome. A missing answer never costs a booking; see the `guards-that-ask-get-declined` and `a-mangled-yes` findings.
  - Optional questions are never enforced.
- **`outcome`** (tool `set_call_outcome({ outcome, note? })`): the enum is `qualified_no_booking`, `not_interested`, `not_a_fit`, `callback_requested`, `wrong_person`, `other`. `booked` and `opted_out` are set by effects, not by this tool.
- **`callback`** (tool `schedule_callback({ when_iso, when_text })`): must fall inside the calling window and within 14 days, or the tool returns the nearest valid time for the model to offer instead.
- **`opt_out`** (tool `opt_out()`): inserts the suppression **immediately** (not post-call), sets the outcome to `opted_out`, and the model confirms: "I've made sure we won't call you again."
- **`confirm_identity`** (§9.6) is an engine tool, like `end_call`, not a pack.

All tools are declared only on outbound calls, except `qualification`, which inbound also gets during callback recognition (§12.3). New counters must be registered in `lib/voice/metrics.js`, because `bumpCounter` silently drops unknown names.

**Amended 2026-09-25 (Task 16, session 2b; D-c + O-1).** None of the five entries above exist as a registered pack yet (`capabilities/index.js` has `appointments`, `messages`, `quotes`, `transfer`, `sms_consent` only); they remain stage 3. Until they ship, the outbound tool set is `campaign.capabilities ∩ {packs the registry actually has} ∩ {tasks the tenant enabled}`, plus the engine tools `end_call` and `set_call_intent` (`set_call_intent` is kept — owner decision O-1 — because Live's step machine needs it to leave `IDENTIFY_INTENT`; `confirm_identity` is Task 18). In practice today that means `appointments` and `transfer` can reach an outbound call and nothing else does; `services/gemini.js`'s `filterForOutboundCampaign` (`buildAllDeclarations` / `buildCallTools` / `buildDbAppointmentTools`) is the join point, keyed on `packForTool(name).id ∈ campaign.capabilities`, and it degrades safely: a campaign that lists only stage-3 names is left with exactly the two engine tools, never a phantom one. Tenant WEBHOOK integration tools (`buildIntegrationTools`) are excluded outright on outbound (Ruling P-4) — "tenant tools" means the capability packs the campaign lists, not the operator's generic webhook escape hatch.

**Amended 2026-09-25 (Task 18, filled in retroactively).** `confirm_identity` shipped as a THIRD unconditional engine tool alongside `end_call`/`set_call_intent` (§9.6): the sentence above ("exactly the two engine tools") describes the state before Task 18 landed. From Task 18 on, a campaign that lists only stage-3 names is left with THREE engine tools (`set_call_intent`, `end_call`, `confirm_identity`), never a phantom pack tool — `confirm_identity` never passes through `filterForOutboundCampaign` at all, the same as the other two.

**Amended 2026-09-25 (fix round 1, Controller Ruling 1819-a).** The join point above was declaration-time only: nothing at EXECUTION time re-checked that a dispatched tool name was one the campaign actually listed, so a model calling an undeclared pack tool by name still reached that pack's `execute()` — the reviewer's probe reached `record_sms_consent` this way on a call where `sms_consent` was never a legal campaign capability. `services/tools.js` `executeToolCall`'s `default` case now applies the SAME `packForTool(name).id ∈ campaign.capabilities` filter at execution time, refusing anything that fails it before it can run. Inbound is unaffected — the gate only activates when `ctx.outboundCall` is present.

### 12.3 Callback recognition (inbound)

At inbound `onStart`, once the business is resolved, `app_open_outreach_by_phone(business_id, From)` runs. On a hit:
- The prompt gains a `CALLER CONTEXT` block: "We called this person on {date} about {topic}. Questions still unanswered: {…}."
- The `qualification` tool is declared with that campaign's remaining questions.
- The outreach is **closed** with `called_back` when the inbound call ends, unless a `schedule_callback` was made on it.
- The inbound call's `calls` row gets `outreach_id`.

### 12.4 Text after a missed call

This is only available when `TWILIO_SMS_FROM` is set for the service. It is unset in production today, and a UK mobile number is needed; `+441372656055` is likely voice-only. It also requires the consent's `channels` to include `sms`. The template ("Hi {first_name}, it's {business_name}. We just tried to call about your enquiry. Reply here or call {caller_id_spoken}.") is at most 300 characters and validated like the opener. It is sent through the existing `services/notifications.js` SMS path. If SMS isn't available, the feature is off and says so at boot (`outbound_sms_unavailable`).

### 12.5 Results webhook

- **Events:** `call.completed` (every attempt, including unanswered ones) and `outreach.closed`.
- **Payload:**

  ```jsonc
  { "event": "call.completed", "delivery_id": "…", "occurred_at": "ISO",
    "campaign": { "id": "…", "name": "…", "version": 3 },
    "outreach": { "id": "…", "attempt": 2, "state": "closed", "close_reason": "terminal_outcome" },
    "call": { "result": "connected", "answered_by": "human", "duration_seconds": 312 },
    "outcome": "booked",
    "contact": { "id": "…", "phone": "+447…", "first_name": "…", "external_ids": {} },
    "answers": { "clinic_name": "…" },
    "booking": { "start": "ISO", "length_min": 30, "appointment_id": "…" },
    "summary": "…",
    "next_attempt_at": null }
  ```

- **Headers:** `X-Vetra-Event`, `X-Vetra-Delivery`, and `X-Vetra-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + raw_body)>`.
- **Delivery:**
  - HTTPS only, with the existing SSRF guard from `integrations/webhook.js` and a 6 s timeout.
  - Backoff of 1 m, 5 m, 30 m, 2 h and 12 h, then `dead`.
  - Each outbox insert enqueues a delivery task on the same queue mechanism, with the sweep as backstop.
- **Documentation:** `docs/outbound-webhook-contract.md`, alongside the existing `integrations-webhook-contract.md`.

### 12.6 Booking on the built-in calendar

The appointments pack with the `internal` adapter works as-is on outbound, with `ctx.party` in place of `callerPhone` (§9.6). Availability, capacity and the `create_appointment_if_available` RPC are unchanged. Part 2 swaps in the GoHighLevel adapter behind the same interface (`checkAvailability`, `findSlots`, `book`).

## 13. Compliance enforcement

This is not legal advice. The rules below implement the positions on the companion page (§8 there) in code.

### 13.1 Compliance classes (checked by gate step 5)

- **`solicited`** (for example an enquiry follow-up) needs a consent with a matching `purpose`, `channels` containing `call`, `covers_automated = true`, and `captured_at` within `consent_window_days` (default 30, maximum 90). It is not revoked.
- **`service`** (reminders, neutral no-show, aftercare) needs an existing relationship. In Part 1 that means the contact has a past or future `appointments` row, or a trigger flagged `existing_customer: true`. The templates carry no promotional wording, and a campaign's objective and notes for this class are held to the same rule by review. That rule can't be checked automatically, and the spec says so.
- **`marketing_consented`** is refused at save in Part 1 (D5).

### 13.2 Disclosure

The opener and voicemail must name the business and state that this is an AI (§7). A post-call detector over the assistant transcript flags claims to be human (`/\b(I'?m|I am) (a )?(real|human|person)\b/i` without a following negation) as `outbound_claimed_human`. That's a count and an alert, because on Live it can only detect, not prevent (`live-removes-the-text-chokepoint`).

### 13.3 Opt-out, belt and braces

1. The `opt_out` tool writes the suppression immediately.
2. Post-call, a detector scans the **assistant** transcript for confirmations ("won't call you again", "remove you from our list", "take you off our list") and the **caller** transcript for requests ("stop calling", "don't call me", "take me off", "remove me"). Any hit without an existing suppression inserts one (`created_by = detector`) and logs `outbound_optout_detector_fired`.
3. The caller transcript is lossy (`live-transcript-is-lossy`), which is why the assistant-side confirmation is also scanned.

### 13.4 Silent calls

A human-answered call breaks the two-limb rule (§9.3) when either of these holds:
- `from_speech_ms > 2000` after the person began to speak;
- `from_answer_ms > 2000` when they never spoke.

Either case, or an answered call whose stream never connected, sets `silent = true`. It also sets `outreach.hold_until = answered_at + 72h` and logs `outbound_silent_call`. Machine-answered calls are excluded.

### 13.5 Records

`call_attempts` is kept for 6 months. The retention schedule document (`docs/compliance/`) gains the new tables. `contacts`, `consents` and `suppressions` are covered by the existing data-subject erase path, keyed on phone. A suppression outlives erasure: the phone is kept, hashed, as a do-not-call marker. Recording that exception is part of the paperwork step.

## 14. Observability, flags and deployment

**Log events:** `outbound_dial`, `outbound_dial_failed`, `outbound_gate_refused{reason}`, `outbound_answered`, `outbound_amd{answered_by}`, `outbound_first_audio{from_answer_ms, from_speech_ms, path}`, `outbound_backstop_played`, `outbound_backstop_missing`, `outbound_first_turn_incomplete`, `outbound_silent_call`, `outbound_voicemail{left|skipped}`, `outbound_attempt_result`, `outbound_outreach_closed{reason}`, `outbound_optout_tool`, `outbound_optout_detector_fired`, `outbound_claimed_human`, `outbound_context_missing`, `outbound_webhook_delivery{status}`, `outbound_callback_recognized`.

`live_call_summary` gains `direction`, `attempt_id` and `campaign_id`. Log-based alert policies (in `monitoring.tf`, applied by hand while Terraform is broken locally) cover `outbound_silent_call`, `outbound_dial_failed` bursts and dead webhook deliveries. Event names are checked against real `log.error` call sites, because a metric on a name nothing logs is a permanently green alert.

**Flags and environment.** All of these are documented in `.env.example`, because the `envInventory` test fails otherwise.

| Variable | Default | Purpose |
|---|---|---|
| `OUTBOUND_ENABLED` | `false` | Global switch |
| `OUTBOUND_TEST_ALLOWLIST` | empty | E.164 list, the only numbers dialable while the switch is off |
| `OUTBOUND_MAX_CONCURRENT` | 8 | Global outbound cap |
| `OUTBOUND_INBOUND_RESERVE` | 2 | Lines always kept for inbound |
| `OUTBOUND_TASKS_QUEUE` | — | Queue path |
| `OUTBOUND_TASKS_SA` | — | Service account for task OIDC |
| `OUTBOUND_MEDIA_URL_SECRET` | — | Signs the voicemail media URLs. Derived from `MEDIA_STREAM_SECRET` if unset, the same derivation idea as the stream token. |

**Deployment.** Cloud Build (`--service-account=vetra-deployer@vetra-core-edc8ca…`), then the migrate job, then `gcloud run services update` with the new env and `GIT_COMMIT_SHA` set. Terraform's provider handshake fails on this machine, so these go in through gcloud:
- the queue (`gcloud tasks queues create outbound-dispatch --location=europe-west2 --max-dispatches-per-second=1 --max-concurrent-dispatches=5 --max-attempts=3`);
- the scheduler job (`*/5 * * * *` against `/internal/outbound/sweep` with OIDC);
- the `outbound-tasks` service account with `roles/run.invoker` on the service;
- Cloud Tasks enqueuer rights for the runtime service account.

All of them are recorded for later Terraform import. The deploy itself needs owner approval, and nothing is pushed to git.

## 15. Testing

**Baseline first:** run the full suite with `DATABASE_URL` **unset**, and `test:db` with `DATABASE_URL=postgresql://vetra:vetra_local_dev@localhost:55432/vetra`. Record the counts before any change.

- **Unit tests for each module:**
  - the gate: every reason, each **sabotaged** to prove its test can fail;
  - schedule grammar and window arithmetic across DST in `Europe/London`;
  - campaign schema validation, including every refusal;
  - the state machine;
  - the webhook signer (verified against an independent implementation);
  - the opt-out and claimed-human detectors, on transcript fixtures;
  - AMD callback routing;
  - OIDC verification (a wrong audience or wrong service account is refused).
- **Database tests (`test:db`):** migrations up; RLS on every new table as `vetra_app`; the definer functions; the double-dial lock under concurrent inserts; the `calls.direction` default preserving inbound rows.
- **Golden prompt snapshots:** all existing snapshots byte-identical (G9), plus new outbound fixtures (speed-to-lead demo, missed-call callback) reviewed by hand once and then frozen.
- **Simulated outbound call:** extend the media-stream probe harness to drive `/twilio/live-stream/<token>` with `direction=outbound`. It fakes the Twilio answer, status and AMD callbacks and **echoes marks back, paced**, because without that no latency gets logged. It asserts:
  - with a caller who speaks first, Ava stays silent until speech onset and then replies;
  - with a silent caller, the backstop plays at about 2.0 s after pickup and is seeded;
  - the `calls` row has `direction = 'outbound'`;
  - post-call closes or reschedules correctly.
- **Live round 1 (plan step 2.7).** Per D7 it runs on the owner's US handset for now, from `+18176011171`. The UK handset from `+441372656055` is deferred. The scenarios:
  1. answer with "Hello?" (Ava waits for it, then replies in context);
  2. answer with "This is {name}, how can I help?" (Ava's reply uses it);
  3. answer and say nothing (the backstop at about 2 s);
  4. let it go to voicemail;
  5. don't answer;
  6. decline the call. Either outcome of §9.4 passes: a voicemail attempt if the carrier forwards it, or `busy`/`no_answer` if it ends the call. Either way no conversation happens and the next attempt is scheduled;
  7. hang up during Ava's first line;
  8. ask for a human;
  9. say "stop calling me";
  10. play a gatekeeper ("Digile clinic reception, who's calling?");
  11. play someone else ("He's not here, I'm his son");
  12. ring back afterwards;
  13. place one ordinary inbound call during the round.

  Every answered call records the hello timing. Those timings tune the 2.0 s backstop (§9.3 step 8).

  **Pass criteria:** G1, G2, G4, G7, G8 and G9.
- **Live round 2 (plan step 3.7):** 10–20 calls through the demo qualifier, including 2–3 regional accents and a noisy line. Pass criterion is G10. Report per call, the unit a caller feels, not per gate event.

## 16. Part 2 and Part 3 outline (not specified here)

**Part 2 (after the Digile scoping call; its own spec at step 5.2):**
- **Auth:** a GoHighLevel **private app** (unlisted, OAuth, installed by link, up to 5 agencies), with a Private Integration Token as the fallback credential behind one `CredentialSource` interface.
- **`CrmConnector` interface:** `upsertContact`, `setCustomFields`, `addTags`, `removeTags`, `addNote`, `logCall` (conversation provider), `upsertOpportunity`, `moveStage`.
- **A `ghl` scheduling adapter** implementing `checkAvailability`, `findSlots` and `book`, which inbound can use too.
- **Install flow:** only expected installs accepted; renewal serialised under a row lock, because GoHighLevel refresh tokens are single-use; the uninstall webhook.
- **Integration plumbing:** outbox `kind = crm`, mapping from GoHighLevel's workflow webhook onto §12.1, and an `integration_connections` table.
- **Digile's campaign:** their questions, hours, retries, persona, transfer and mapping.
- **Recording:** only if they want audio.

**Part 3:**
- templates for reminders, no-show, aftercare and review requests;
- list upload with TPS/CTPS screening;
- the `marketing_consented` class and consented reactivation (after solicitor review);
- the `patient` audience with name confirmation before any detail;
- inbound callers upserted into `contacts` for one timeline;
- an agency layer, if Digile resells;
- outbound minutes in plans;
- load tests of inbound and outbound together;
- a monthly compliance report.

## 17. Risks and open questions

| Risk | Handling |
|---|---|
| ~~Live may not accept a seeded first turn cleanly (spike A)~~ | **Resolved 2026-09-24:** seeding is a GO, 6/6 (§9.8). |
| ~~The Chirp 3 HD voice may not sound identical to the Live voice~~ | **Resolved:** the owner chose Live's own voice for everything (D6). Pre-rendered clips are made by Live. |
| People say "Hello?" close to Ofcom's 2 s silence limit (measured 1.87 s and 2.2 s) | Listen first; the two-limb rule; a short, interruptible backstop at about 2.0 s after pickup (§9.3). Tuned in live round 1. |
| The first turn is model-spoken, so its disclosure cannot be pre-gated | First-turn detector plus a correction note (§9.3 step 5). Counted per call (G3). |
| AMD accuracy and timing on UK mobile voicemail is unmeasured | US measured in spike B (§9.8). The UK leg is deferred (D7). `unknown` is treated as human, which is safe because the AI discloses. |
| Whether an AI voice counts as Ofcom's "live operator" is untested | The design meets the stricter reading anyway (§9.3). Flagged for the solicitor with the paperwork (step 0.6). |
| Twilio account A limits are unknown (profile type) | Gate reason `capacity` handles Twilio's concurrency error. The Business profile follows the LLC. |
| Gemini Live concurrent-session limit is unmeasured | `OUTBOUND_MAX_CONCURRENT` is kept low (8). A load test is a Part 3 item. |
| No UK handset | The owner decided on 2026-09-24: no UK legs for now (D7). Live round 1 runs on the owner's US handset. |
| `services/googleTts.js` is not configured on the serving revision | **Checked:** `isConfigured()` is false (neither env var is set), and `texttospeech.googleapis.com` is enabled. This is **moot for outbound** now that clips are rendered by Live (D6). Recorded for any future TTS use. |
| Cloud Tasks API not enabled on `vetra-uk-edc8ca` | A stage 2 deploy item (plan Task 22). |
| Rendering clips needs a Live session during ringing | About 150 ms setup plus the speaking time, roughly $0.002–0.004 per render. It counts against Gemini Live concurrency, so it is included in `OUTBOUND_MAX_CONCURRENT` headroom. |
| LLC not yet formed | Blocks go-live (the DPA), not Part 1. |
| The August appeal said "no outbound" | D2 note, plus consent-only design. |

## 18. References

- **Companion page:** https://claude.ai/artifact/3379bzmqHG1gVDSQB2mdrv
- **Capability packs:** `docs/superpowers/specs/2026-07-22-capability-packs-design.md`
- **Code touchpoints:**
  - `server.js:494-601`: the inbound Live route; its pattern is reused
  - `lib/mediaStreamToken.js`
  - `lib/voice/live/index.js`: `onStart` at about line 5185, transfer at 5148–5162, and the voice resolution around line 284
  - `services/gemini.js`: `buildStaticSystemPrefix`, and the greeting at 1551–1557
  - `services/db.js`: `lookupBusinessByPhone` at 733, `withTenant` at 2106
  - `services/googleTts.js`: `synthesizeMulaw` (**not used on outbound** after D6's revision; the backstop and voicemail clips are rendered by a short Gemini Live session, see `scripts/spikes/spike-a-opener.mjs` for the proven shape)
  - `lib/callStateStore.js:43`
  - `adapters/scheduling/internal.js`
  - `capabilities/_contract.js`
  - `integrations/webhook.js`: the SSRF guard
  - `services/notifications.js`: SMS
- **Compliance background:** PECR regs 19, 21, 24; ICO telephone marketing guidance and the 2025 avatar-call penalties; Ofcom persistent misuse statement (2016); Twilio Voice Services Policy; Google Cloud AUP and the Generative AI Prohibited Use Policy. Links are on the companion page.

## 19. Amendments 2026-09-27 (stage-3 decisions, owner-approved after live round 1)

The decisions and the tasks that implement them are in `docs/superpowers/plans/2026-09-27-outbound-stage3.md` ("Owner decisions" table, S3-D1 to S3-D7). Where they conflict with an earlier section, this section wins.

- **Supersedes §9.3 steps 2–3 (S3-D2):**
  - The stored opener clip ALWAYS plays first: at the end of the person's hello (`path=backstop_hello_end`), at onset + 1,600 ms (`backstop_slow`), or at the silence timer (`backstop_silence`).
  - Live never speaks first. Its stale reply is discarded; it is seeded with the opener and continues from what the person says next.
  - `path=live_reply` survives only behind `OUTBOUND_FIRST_SPEAKER=live`, for a later switch once `outbound_live_shadow` shows Live reliably under about 1 s.
  - The opener renders BEFORE the dial (D10).
- **Supersedes §9.5's situations table (S3-D1):**
  - Outbound has its own conversation layer. Inbound-only guards (the LVX132 ask-before-hangup gate, the spelling nudge, the gather-details fallbacks) are skipped on outbound.
  - Gatekeepers are told name + company + "returning {first_name}'s enquiry", never the topic. A possible child is asked one availability question only.
  - `outcome`, `callback` and `opt_out` are PLATFORM packs, always declared on outbound. They are not action tools.
- **Amends §7 (S3-D4):**
  - New keys: `goal`, `details_fields`, `language`, `why_allowed`, `review_url`, `message_text` and `custom_basis`.
  - `caller_id` defaults to the business number.
  - The `custom` template is allowed for `asked_to_be_contacted` (solicited) and `existing_customer` (service); `selling` is refused until Part 3.
- **Amends §10.3 and §13 (S3-D5):**
  - A per-country legal floor sits beneath the campaign window. US v1 (P-b, owner-approved 2026-09-27): Mon–Sat 08:00–20:00, Sun 12:00–20:00; with no contact timezone, the call must be inside the window in both NY and LA. GB: 08:00–21:00.
  - Any other country (including non-US NANP) is refused with `no_legal_floor`. Counsel confirms the values.
- **Amends §12.5 (S3-D3):**
  - The results channel is direction-neutral (`lib/connections/`, `"direction"` in the payload). Its key is `CONNECTIONS_WEBHOOK_KEY` (C3, P-c).
  - Inbound is not wired in stage 3.
- **Amends §13.5:** on erasure a suppression keeps only `phone_hash = HMAC-SHA256(SUPPRESSION_HASH_KEY, phone)`.
- **§12.3 callback recognition** moves to stage 4. It is still required before `OUTBOUND_ENABLED=true`.
- **§12.4, the text after a missed call,** moves to the Ilija setup session (P-d).
