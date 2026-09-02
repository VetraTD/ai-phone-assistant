# Restore after the spike — read this before doing anything else

The spike repoints a Twilio number and creates cloud resources outside
terraform. This is what has to be put back, written down **before** any of it
was changed, because "I will remember" is how a test number stays pointed at a
deleted service.

## 1. Twilio number — the one that matters

`+18176011171` is on **Twilio account B** (`AC72…`, credentials in the repo's
local `.env` — GCP does **not** hold this account's token).

Captured 2026-09-02, before any change:

| field | value |
|---|---|
| sid | `PN58e27f5f39727c40b279354409155ec3` |
| phoneNumber | `+18176011171` |
| voiceUrl | `https://ai-phone-assistant-staging.up.railway.app/twilio/voice` |
| voiceMethod | `POST` |
| statusCallback | `https://ai-phone-assistant-staging.up.railway.app/twilio/status` |
| statusCallbackMethod | `POST` |
| voiceApplicationSid | *(empty)* |

**This host is ALIVE**, not dead. An unsigned POST to it returns HTTP 403 —
a Twilio signature refusal, which means the Railway *staging* app still answers.
The 2026-07-22 note saying these numbers "point at Railway production" was close
but not exact, and the difference between "dead host" and "live app" is the
whole reason this file exists.

Note also: `+18176011171` is `ASSISTANT_NUMBER` in `.env`, which the latency
probe's dial plan reads. Leaving it pointed at the spike silently breaks
`npm run probe`.

Restore:

```js
// node -e, with dotenv loaded and account B credentials
client.incomingPhoneNumbers("PN58e27f5f39727c40b279354409155ec3").update({
  voiceUrl: "https://ai-phone-assistant-staging.up.railway.app/twilio/voice",
  voiceMethod: "POST",
  statusCallback: "https://ai-phone-assistant-staging.up.railway.app/twilio/status",
  statusCallbackMethod: "POST",
});
```

## 2. Cloud resources created outside terraform

All in `vetra-uk-edc8ca` / `europe-west2`, all deliberately unmanaged so they
leave no drift and delete in one command each.

```
gcloud run services delete s2s-spike --project=vetra-uk-edc8ca --region=europe-west2
gcloud secrets delete gemini-api-key --project=vetra-uk-edc8ca
gcloud iam service-accounts delete s2s-spike@vetra-uk-edc8ca.iam.gserviceaccount.com --project=vetra-uk-edc8ca
```

Deleting `gemini-api-key` also clears backlog item **LVX2**: the name is on
`FORBIDDEN_IN_PHI_PROJECTS` in `lib/credentialBoundary.js`, and it only passes
the gate today because `scripts/check-credential-boundary.js` defaults to the
US project, which is not an active stack.

## 3. Code

```
git revert <the spike commit>   # or delete scripts/spike/ and the Dockerfile COPY line
```

`lib/voice/resample.js` and `tests/resample.test.js` are a **separate commit and
stay** — they are real, tested, and survive either verdict.

## 4. Environment facts worth keeping

- `gcloud` for **`admin@vetratd.com` is `access_denied: Account Restricted`** —
  restricted at Google, not merely logged out. Use `CLOUDSDK_CONFIG=~/.gcloud-vetra2`
  (`vetratd@gmail.com`), which reaches all three projects.
- The shared/control project is **`vetra-core-edc8ca`**. `vetra-shared-c3a3bd`
  in `cloudbuild.yaml`'s header comment is an attempt-1 project that no longer
  exists; `cloudbuild.frontend.yaml:74` already records being bitten by it.
- Image path: `us-central1-docker.pkg.dev/vetra-core-edc8ca/vetra/voice`.
  Production runs tag `304e70e` as `voice-uk-prod@vetra-uk-edc8ca.iam.gserviceaccount.com`.
