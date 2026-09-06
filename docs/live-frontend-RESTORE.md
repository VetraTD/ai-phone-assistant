# Live front-end — deploy, test, and put back

Written **before** any Twilio number is repointed, for the same reason
`scripts/spike/RESTORE.md` was: "I will remember" is how a test number stays
pointed at a deleted service.

The spike's restore file is the precedent and it worked. This one covers a
front-end that has a database behind it, so the stakes on the "put back" half
are higher.

---

## 0. What must NOT happen

**Do not point `+441372656055` at `/twilio/live-voice` casually.** It is Digile
Media's number, it resolves on the UK GCP stack, and people call it — it is the
demo a friend dials on a UK handset. Tier 1 has no fallback: tiers 2a, 2b and 3
are not built, so a caller who reaches a broken Live session gets nothing at
all, not voicemail.

Use `LIVE_BUSINESS_PHONE` instead. It makes a **test** number answer with
Digile Media's real config — real prompt, real ten tools, real appointments
rows — with nothing else changed:

```
LIVE_BUSINESS_PHONE=+441372656055
```

Repoint the real number only for a deliberate, watched window, and fill in
section 3 first.

---

## 1. Before anything: capture the current state

Run this and paste the output into section 3, **before** changing anything.

```js
// node -e, with dotenv loaded and the credentials of the account that owns it
const n = await client.incomingPhoneNumbers.list({ phoneNumber: "<the number>" });
console.log(JSON.stringify(n[0], null, 2));
```

The fields that matter: `sid`, `voiceUrl`, `voiceMethod`, `statusCallback`,
`statusCallbackMethod`, `voiceApplicationSid`.

`scripts/spike/RESTORE.md` records why this is not optional: the note saying
those numbers "point at Railway production" was close but not exact — it was
*staging* — and the difference between a dead host and a live app is the whole
reason to capture rather than recall.

---

## 2. Configuration

### Secrets

`GEMINI_API_KEY` goes in Secret Manager, not `.env`:

```
node scripts/push-secrets.js        # the existing tool; do not invent a second path
```

**This re-arms backlog LVX9.** `gemini-api-key` is on
`FORBIDDEN_IN_PHI_PROJECTS` in `lib/credentialBoundary.js` and passes the gate
today only because `scripts/check-credential-boundary.js` defaults to the
inactive US project. The UK lane is `standard` with no GCP BAA, so it is a
naming collision rather than an exposure — and `lib/voice/live/client.js`
refuses to construct the AI Studio client at all in `hipaa` mode, which is the
guard that actually matters. Recorded, not fixed.

### Set `MEDIA_STREAM_SECRET` explicitly

`lib/mediaStreamToken.js` derives its signing key from `TWILIO_AUTH_TOKEN` when
the override is absent. Two Twilio accounts are in play here, so leaving it
derived means changing account silently invalidates every websocket token — and
the symptom is a socket that will not connect, which reads as a broken
endpoint.

### Twilio account

Either account works, **properly signed**. `/twilio/live-voice` accepts a
signature from `TWILIO_AUTH_TOKEN` or `TWILIO_AUTH_TOKEN_ALT`, so a number on
account B needs only that second variable set — not a fallback to URL secrecy,
which is what backlog LVX3 was.

The cascade's own validation is unchanged and stays single-token.

### Arms

```
LIVE_TURN_END=vendor      # default, the incumbent, currently winning
LIVE_TURN_END=hangover    # manual + flat timer, what the spike ran
LIVE_TURN_END=hold        # manual + classifyHold, THE CANDIDATE
```

Nothing is locked. See §6 of the handoff, and do not ship `hold` on the
strength of its argument.

---

## 3. Captured state — FILL THIS IN BEFORE REPOINTING

| field | value |
|---|---|
| number | `+18176011171` |
| account (A / B) | **B** — `AC7253…ab09`, the account whose token is in the repo's local `.env` and which GCP does **not** hold |
| sid | `PN58e27f5f39727c40b279354409155ec3` |
| voiceUrl | `https://ai-phone-assistant-staging.up.railway.app/twilio/voice` |
| voiceMethod | `POST` |
| statusCallback | `https://ai-phone-assistant-staging.up.railway.app/twilio/status` |
| statusCallbackMethod | `POST` |
| voiceApplicationSid | *(empty)* |
| captured at | 2026-09-02, read live from Twilio immediately before repointing |
| captured by | this session |
| **status** | **RESTORED 2026-09-04 after a six-call verification round**, to `https://ai-phone-assistant-staging.up.railway.app/twilio/live-voice` + `/twilio/status`, and verified by re-reading the number from Twilio and comparing **all four fields one at a time**. The cloudflared quick tunnel is torn down and returns 502; that URL is dead and a future rig gets a new one. |
| **correction** | The 2026-09-03 row said the number had been put back "field-for-field" to the captured `voiceUrl` of `/twilio/voice`. It had not: re-reading it on 2026-09-04 returned **`/twilio/live-voice`**. Nothing was broken by it — the host was alive — but `npm run probe` was dialling the **Live** front-end rather than the cascade, so any number it reported was a Live number and not comparable with earlier cascade runs. `readiness.md:161` was the accurate document and this table was not. **Reading a number back is not enough on its own if the read-back is only glanced at.** |

### `+441372656055` — the UK demo number, captured 2026-09-05

**Captured BEFORE anything was changed**, read live from Twilio account A, which
is the account that owns it. Phase 1's verification call needs a UK number a UK
handset can dial, and this is the only one there is.

| field | value |
|---|---|
| number | `+441372656055` |
| friendlyName | `441372656055` |
| account (A / B) | **A** — `AC1828…43b6`, the account whose token GCP holds in `vetra-uk-edc8ca/twilio-auth-token` and which is **not** in the repo's local `.env` |
| sid | `PN143d2a428a1d27c601c0419f83309a2a` |
| voiceUrl | `https://voice-uk-prod-462445274080.europe-west2.run.app/twilio/voice` |
| voiceMethod | `POST` |
| statusCallback | `https://voice-uk-prod-462445274080.europe-west2.run.app/twilio/status` |
| statusCallbackMethod | `POST` |
| voiceApplicationSid | *(empty)* |
| voiceFallbackUrl | *(empty)* |
| smsUrl | `https://demo.twilio.com/welcome/sms/reply` — Twilio's stock demo, never ours |
| captured at | 2026-09-05, read live from Twilio immediately before any change |
| captured by | this session |
| **status** | **NOT YET REPOINTED.** Captured first, deliberately, per §1. |

**This is a different account from the number above it**, and that is the whole
reason this row exists separately. `+18176011171` is on account B, whose token is
in the local `.env`; this one is on account A, whose token lives only in GCP.
`twilioValidationLive` accepts either, so `/twilio/live-voice` works once
`TWILIO_AUTH_TOKEN_ALT` is set — but a number on the wrong account 403s every
single request, which reads as a broken endpoint rather than a credential.

**`statusCallback` is deliberately left pointing where GCP has it.** It goes to a
route mounted behind the single-token `twilioValidation` (`server.js:776`), so
Twilio's end-of-call report — signed by account A — will fail the check and get a
403. That is **LVX14's shape and it is accepted**: a Live call never reaches
`/twilio/status` in a useful way anyway (LVX30), so nothing is lost that is not
already lost, and the caller's experience is unaffected. The cost is one
`twilio_signature_invalid` log line per call, which looks exactly like a forged
request and is not. Recorded here so nobody chases it.

**What is at stake while it is repointed.** This is Digile Media's real line and
people ring it — it is the demo a friend dials on a UK handset. Tiers 2a, 2b and 3
are not built, but the **connect-time fallback is** and was verified on real calls:
a failure at pickup hands off in-process to the cascade or to voicemail, never
silence (`server.js:568`). What that does **not** cover is the host being gone. On
a laptop rig behind a quick tunnel, a closed laptop is a dead number. Keep the
window short and restore from this table immediately afterwards.

### Testing against a laptop, and why it is cloudflared and not ngrok

**ngrok cannot authenticate on the development machine.** Its control connection
fails with `x509: certificate signed by unknown authority` — Norton's TLS
interception again, the same root cause as LVX17, in a new place. The Go binary
does not trust Norton's root CA, so it retries forever and the reserved domain
serves a 404 from ngrok's edge, which reads exactly like a broken server.

**cloudflared is unaffected** and is what the local rig uses. Its quick-tunnel
URL is random and dies with the process, so `BASE_URL` must match it and the
Twilio number must be repointed each session. Signature validation covers the
EXACT url, so a stale `BASE_URL` is a 403 indistinguishable from a wrong token.

Run the server with the deployment's settings, not the laptop's defaults:

```
BASE_URL="https://<tunnel>.trycloudflare.com" TWILIO_VALIDATE_SIGNATURE=true DATABASE_URL="postgres://vetra:vetra_local_dev@localhost:55432/vetra" POSTCALL_VERIFY=count LIVE_DEBUG_TRANSCRIPT=1 PORT=3000 node server.js
```

`TWILIO_VALIDATE_SIGNATURE` is `false` in the local `.env` and true on the
deployment; `POSTCALL_VERIFY` and `LIVE_DEBUG_TRANSCRIPT` are unset locally and
set there. Left at their local defaults, the rig measures a configuration
production never runs — which is the LVX37 mistake exactly.

**`+18176011171` resolves to a LOCAL Brightwork Family Dental** on the throwaway
Postgres, created with real dental hours (Mon-Thu 08:00-17:00, Fri to 16:00, Sat
morning, Sun closed) so it does not offer midnight appointments the way Digile
Media legitimately does.

**Two things this number is, beyond a test line:**

- Its current `voiceUrl` host is **alive** — the Railway *staging* app answers
  there. This is not a dead endpoint being reclaimed.
- It is `ASSISTANT_NUMBER` in `.env`, which the latency probe's dial plan reads.
  **Leaving it pointed elsewhere silently breaks `npm run probe`.**

Restore:

```js
client.incomingPhoneNumbers("<sid>").update({
  voiceUrl: "<voiceUrl above>",
  voiceMethod: "<voiceMethod above>",
  statusCallback: "<statusCallback above>",
  statusCallbackMethod: "<statusCallbackMethod above>",
});
```

---

## 4. Before a live call — spend the cheap thing first

It needs a database it can resolve the tenant from. `db.isEnabled()` is false
without `DATABASE_URL` or `CLOUD_SQL_INSTANCE`, and the script refuses rather
than testing a prompt no caller will ever hear. The whole local path, which
touches no production database — Supabase is read for config only, every write
lands in the throwaway docker Postgres:

```bash
docker compose -f infra/docker-compose.dev.yml up -d      # or: npm run db:up
export DATABASE_URL="postgres://vetra:vetra_local_dev@localhost:55432/vetra"
node scripts/migrate.js                                    # 39 migrations

# Digile Media's config, out of Supabase and into the local DB. CONFIG ONLY:
# scripts/import-tenant.js refuses calls, transcripts, appointments and
# consents by name.
export IMPORT_TENANT_B64=$(node -e '
  import("dotenv/config").then(async()=>{
    const h={apikey:process.env.SUPABASE_SERVICE_KEY,
             Authorization:"Bearer "+process.env.SUPABASE_SERVICE_KEY};
    const q=process.env.SUPABASE_URL+"/rest/v1/";
    const B=await (await fetch(q+"businesses?phone_number=eq.%2B441372656055&select=*",{headers:h})).json();
    const C=await (await fetch(q+"business_capabilities?business_id=eq."+B[0].id+"&select=capability_id,enabled,config",{headers:h})).json();
    const business={...B[0]}; delete business.created_at;
    process.stdout.write(Buffer.from(JSON.stringify({business,capabilities:C})).toString("base64"));
  });')
node scripts/import-tenant.js

node scripts/live-exercise.js              # plan and estimate, spends nothing
node scripts/live-exercise.js --confirm    # ~53k input tokens over 6 turns
```

Verify before spending: the config should yield **ten** tools. Note that
Digile Media's real `business_hours` are `00:00-23:59` every day, so
availability legitimately offers midnight and 11 PM slots — that is a demo
tenant configured always-open, not a bug.

**Run 2026-09-02: LVX4 is CLOSED — read-back works**, unprompted and again on
request. It was the spike's ten-line prompt, not the model.

The same run confirmed **LVX8**: the assistant asked the caller to spell their
name three turns in a row, because `applyReplyState` — where `spellAskCap`
lives — does not run on this path.

It **cannot** answer whether `inputAudioTranscription` is punctuated (no audio
in, so no input transcription), how anything sounds, or how the arms compare.
Those need a handset.

---

## 5. Environment facts that cost an hour last time

- `gcloud` for **`admin@vetratd.com` is `access_denied: Account Restricted`** —
  restricted at Google, not logged out. Use `CLOUDSDK_CONFIG=~/.gcloud-vetra2`
  (`vetratd@gmail.com`), which reaches all three projects.
- The control project is **`vetra-core-edc8ca`**. `vetra-shared-c3a3bd` in
  `cloudbuild.yaml`'s header is an attempt-1 project that no longer exists.
- Builds need `--service-account=vetra-deployer@...` — see `cloudbuild.yaml`.
- **Poll the build id you created**, never "the most recent build". That
  mistake was made twice in one session and returns the *previous* build's
  terminal status immediately, which reads as a build that finished instantly.

---

## 6. Putting it back

1. Restore the number from section 3, and **verify by reading it back** rather
   than trusting the update call. This step was performed on 2026-09-03 and the
   read-back was recorded as "field-for-field"; it was not — `voiceUrl` came
   back `/twilio/live-voice` when the captured value was `/twilio/voice`.
   Reading it back is not enough on its own: **compare the fields to the table
   above one by one**, because a read-back that is glanced at proves as little
   as an update that is trusted.
2. Unset `LIVE_BUSINESS_PHONE` wherever it was set.
3. The Live routes can stay deployed — nothing reaches them without a Twilio
   number pointed at `/twilio/live-voice`, and the cascade's routes are
   untouched either way.
4. If the deployment is being torn down rather than left: delete
   `gemini-api-key`, which also re-closes LVX9.
