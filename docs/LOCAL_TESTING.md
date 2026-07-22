# Local Testing — v2 Voice Pipeline

How to test the rebuilt AI receptionist against a **dev phone number** before touching production. Nothing here affects the live number until the final cutover step.

## 1. Accounts / keys needed

| Key | Where | Notes |
|---|---|---|
| `ELEVENLABS_API_KEY` | elevenlabs.io → Profile → API Keys | Starter plan ($5) is enough for testing; Creator ($22) for real volume |
| `ELEVENLABS_DEFAULT_VOICE_ID` | elevenlabs.io → Voices | Pick one; see step 2 |
| `DEEPGRAM_API_KEY` | console.deepgram.com | $200 free credit covers all testing. **Now required at boot** |
| `GEMINI_API_KEY` | existing | unchanged |
| Twilio dev number | console.twilio.com → Phone Numbers → Buy | ~$1.15/mo, separate from production number |

## 2. Verify the voice catalog

`config/voices.js` ships with 8 curated voice IDs, verified against a live account on 2026-07-20. If it's been a while (ElevenLabs occasionally retires/renames premade voices), re-check before relying on the picker:

```bash
node --env-file=.env scripts/verify-voices.js
# add --preview to also write a sample mp3 per voice to ./voice-previews/
```

Fix any `MISSING` entries it reports in `config/voices.js` (and mirror the change into `AI-phone-dashboard/backend/src/constants.js`'s `ELEVENLABS_VOICE_IDS` and `AI-phone-dashboard/backend/src/routes/settings.js`'s `VOICE_CATALOG` — all three must stay in sync).

## 3. Local server + tunnel

```bash
npm install
cp .env.example .env.dev     # fill in the keys above
```

`.env.dev` essentials (leave `PIPELINE_V2` unset — v2 is the default; set it
to `false` only if you deliberately want to exercise the legacy pipeline):
```
DEEPGRAM_API_KEY=...
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
ELEVENLABS_DEFAULT_VOICE_ID=...
SUPABASE_URL=...            # test project or same project + test business row
SUPABASE_SERVICE_KEY=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
DEBUG_ENDPOINTS=true        # enables GET /api/debug/latency
BASE_URL=https://<your-ngrok-subdomain>.ngrok-free.app
```

Run:
```bash
ngrok http 3000              # copy the https URL into BASE_URL, restart server
node --env-file=.env.dev server.js
```

In Twilio console, point the **dev number** (not production):
- Voice → A call comes in → Webhook → `https://<ngrok>/twilio/voice` (HTTP POST)
- Call status changes → `https://<ngrok>/twilio/status`

Create a `businesses` row whose `phone_number` matches the dev number, then call it from your cell.

## 4. What to check on the first calls

**Latency** — after a few calls:
```bash
curl -s localhost:3000/api/debug/latency | jq
```
Targets: `voice_to_voice_ms` p50 ≤ 800ms (ideal 500), `llm_ttfb_ms` and `tts_ttfb_ms` each a few hundred ms. Watch the `turn_latency` log lines live during a call.

**Turn-taking drills**

Run these with the live monitor attached — it renders the ladder/hold/barge-in
decisions, which are otherwise invisible in raw logs (the important case is a
nudge that correctly *didn't* fire):

```bash
LOG_LEVEL=DEBUG node --env-file=.env.dev server.js | node scripts/watch-call.js --passthrough
```

| Drill | Expected |
|---|---|
| Talk continuously for 30+ seconds | Zero nudges, no hangup. Monitor shows `🎙 caller speaking` then `⏸ ladder held off`. |
| Leave a TV/radio playing, say nothing | Suppression caps at 30s (`⚠ suppression capped`), then the ladder escalates and ends the call. |
| "I need to book an appointment for…", pause ~2.5s, finish | `⋯ holding` → one combined turn, not two. Repeat mid-phone-number and mid-date. |
| "and… and… and…" | Flushes at the 3s ceiling (`→ flushed … (hit ceiling)`), not held forever. |
| Same mid-sentence pause in Spanish | Same behaviour. Harder case: `endpointing` is 100ms for Spanish, so fragments are more frequent. |
| Interrupt mid-sentence with "wait" | AI stops within roughly half a second and **tapers** rather than chopping (`✂ barge-in — faded 40ms`). Listen for a click. |
| Say "uh-huh" / "yeah" while it talks | It should **keep talking** (backchannel, not interruption). |

Tuning knobs, all env-overridable without a code change:
`VOICE_LOOKAHEAD_MS` (100), `VOICE_BARGE_FADE_MS` (40), `VOICE_PACED_PLAYOUT=false`
to restore the old instant-blast playout, `STT_ENDPOINTING_MS` (300).

Counters for a batch of calls: `curl -s localhost:3000/api/debug/latency | jq .turnTaking`
— `nudges_fired`, `nudges_suppressed`, `holds_started`, `holds_capped`, `barge_ins`.

**Conversation**
- Ask something the knowledge base can't answer → it should offer to take a message, never invent an answer.
- Leave a message → name, callback number read back digit by digit, reason, urgency, callback promise. Check the `customer_requests` row and the email/SMS notification.
- Ask for a human ("can I speak to someone?") and in Spanish ("quiero hablar con una persona") → both should transfer.

**Failure paths**
- Temporarily break `GEMINI_API_KEY` mid-call → after two failures, the scripted take-message fallback should take over and still capture a message.
- Break `DEEPGRAM_API_KEY` at boot → server should refuse to start with a clear message.

## 5. Cutover to production

Only after the checks above pass:
1. Run migrations 013–018 against the production database (staging first).
2. Set the same env vars in production. Leave `PIPELINE_V2` unset — v2 is the default; `PIPELINE_V2=false` is the rollback escape hatch if v2 misbehaves.
3. Repoint the production number's webhooks to the production `BASE_URL`.
4. Keep the dev number for future testing.

## Known constraints

- **Single instance only.** Call state lives in process memory; running multiple instances without sticky sessions will break in-progress calls.
- **Degraded mode**: if the voice stack is unavailable, callers get an apology plus voicemail recording, which lands in `customer_requests`.
- **Midnight-spanning business hours** (e.g. 22:00–02:00) are read as always-closed — pre-existing limitation, not yet fixed.
