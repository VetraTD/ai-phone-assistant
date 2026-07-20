# ai-phone-assistant
An intelligent AI-powered phone assistant designed to handle calls, take messages, and more using natural language processing.

## PIPELINE_V2 — the two voice pipelines

There are two live call pipelines behind `/twilio/media-stream`, selected per-connection by an env var (`server.js`'s `selectPipelineHandler`). `PIPELINE_V2` is an **opt-OUT** switch — leave it unset:

- unset / anything other than `"false"` (**default**) → `lib/voice/session.js`, the rebuilt low-latency pipeline (streaming STT/LLM/TTS, barge-in, per-turn latency metrics, per-turn `requestId` log correlation). This is where new work happens.
- **`PIPELINE_V2=false`** → `lib/mediaStream.js`, the original pipeline. Retained this release purely as a rollback escape hatch. It lacks the LLM turn timeout (a hung Gemini stream holds the call to the 30-minute cap), the deterministic take-message fallback, ElevenLabs/per-business voice selection (the dashboard's voice picker writes columns legacy never reads), multilingual STT, the `toSpeakable` normalizer, the utterance cache, and VAD barge-in — so only fall back if v2 is actively misbehaving.

**Required env vars** (both pipelines):

| Var | Notes |
|---|---|
| `DEEPGRAM_API_KEY` | **Required at boot** — the server refuses to start without it (streaming STT has no legacy fallback). |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_DEFAULT_VOICE_ID` | TTS. Falls back to Google TTS per-turn if ElevenLabs fails (see `lib/voice/ttsStream.js`); a business can also be configured `voice_provider="google"` to skip ElevenLabs entirely. |
| `GEMINI_API_KEY`, `BASE_URL`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Existing, unchanged. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Optional but effectively required for anything beyond a bare greeting — most routes no-op or 4xx without them. |
| `NOTIFICATIONS_ENABLED` | **On by default** as soon as either SMTP or Twilio SMS creds are present (owner notifications: new appointment, new message, missed call). Set to `false` to force off (e.g. local dev). Caller-facing SMS follow-ups (`sendCallerSms` — appointment confirmation, message-received ack, missed-call text-back) are a separate, per-business opt-in (`businesses.sms_followup_enabled`), off by default regardless of this var. |
| `DEBUG_ENDPOINTS=true` | Enables `GET /api/debug/latency` (per-turn voice-to-voice/STT/LLM/TTS latency stats). 404s otherwise. |

**Local dev-number + ngrok testing**: see `docs/LOCAL_TESTING.md` for the full walkthrough (account setup, voice-catalog verification, `.env.dev`, ngrok, turn-taking/failure-path drills, production cutover). Short version:

```bash
npm install
cp .env.example .env.dev   # fill in the keys above (leave PIPELINE_V2 unset)
ngrok http 3000            # copy the https URL into BASE_URL, restart
node --env-file=.env.dev server.js
```
Point a **dev** Twilio number's Voice webhook at `https://<ngrok>/twilio/voice` — never the production number, until the checks in `docs/LOCAL_TESTING.md` pass.

**Single-instance constraint**: call state (`lib/callState.js`) lives entirely in process memory, keyed by Twilio `CallSid`. Running multiple server instances without sticky sessions (same instance for the whole life of a call) will corrupt or drop in-progress calls — there is no shared/external call-state store. Scale vertically, or add sticky routing before scaling horizontally.

**Degraded mode** (`lib/voice/health.js`): when the pipeline's STT/TTS dependencies are known to be down, `/twilio/voice` skips Media Streams entirely and returns a voicemail-only TwiML response (apology + `<Record>`) instead of a call the AI can't actually converse on. The recording lands as a `customer_requests` row (via `/twilio/voicemail`) and, if the business has SMS follow-ups enabled, the caller gets a `message_received` text back. `setDegraded()`/`clearDegraded()` currently have no automatic trigger wired to the pipeline's own failure paths — that's a follow-up; today it's an independently-testable flag other code can call into.

## Testing

Run the test suite (mocked by default; no real Twilio or Supabase required):

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

**What’s tested**

- **twilioNumbers** (search/purchase with mocked Twilio), **updateBusinessPhoneNumber** (mocked Supabase), and **phone-numbers API** routes (GET available, POST buy) with mocked dependencies.
- **Real Twilio search:** If `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set (e.g. in `.env`), the integration tests in `tests/twilioNumbers.integration.test.js` run and call the real Twilio API for **search only** (no numbers are purchased). If either env var is missing, those tests are skipped. Buy is always mocked everywhere; no test ever purchases a real number.
