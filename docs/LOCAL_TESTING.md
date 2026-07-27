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

**Speakerphone drills — do these on a real handset AND on speakerphone.** Echo is
the enemy, and every row here is a failure that was observed live.

| Drill | Expected |
|---|---|
| **Interrupt, pause ~1s, then finish the thought** | The AI waits through the pause (`⏳ settling after barge`) and answers the WHOLE thing once. It must not reply into the pause and then get cut off again. |
| **Speakerphone, max volume, say nothing while it talks** | `barge_ins` stays flat and `🛡 echo suppressed` lines appear. The AI must never interrupt itself or answer its own words. |
| **Interrupt, then keep talking each time it restarts** | The loop must break on its own within an exchange or two — WITHOUT you going silent. Going quiet is what ended it before the fix, so "it stopped" is not evidence. |
| **Right after it offers a slot, repeat it back ("Thursday at three?")** | Treated as your speech, not as echo. Short confirmations are deliberately never suppressed. |
| **Ask something needing a lookup** | The model's own "one moment while I check" plays, then `⏳ model stalled` + "Still working on that." if the tool runs long. Never both at once, never overlapping. |
| **Interrupt, then ask a follow-up about what it was saying** | It knows what it had already told you and does not repeat it — the interrupted turn is recorded in history (`📝 recorded interrupted turn`). |

If `🛑 LOOP BREAKER` ever appears, that is a bug report, not normal operation: the
echo guard and the settle window let a runaway through. Capture the log.

Tuning knobs, all env-overridable without a code change:

| Knob | Default | What it does |
|---|---|---|
| `VOICE_LOOKAHEAD_MS` | 100 | Unplayed audio held inside Twilio |
| `VOICE_BARGE_FADE_MS` | 40 | Length of the barge-in taper |
| `VOICE_PACED_PLAYOUT` | on | `=false` restores the old instant-blast playout |
| `STT_ENDPOINTING_MS` | 300 | Deepgram silence before a final |
| `VOICE_POST_BARGE_SETTLE_MS` | 700 | Silence required after a barge before replying. **`=0` reverts** |
| `VOICE_POST_BARGE_MAX_HOLD_MS` | 3000 | Ceiling on that wait |
| `VOICE_ECHO_GUARD` | on | `=false` disables self-echo suppression entirely |
| `VOICE_ECHO_TAIL_MS` | 1200 | How long after playback a transcript can still be echo |
| `VOICE_ECHO_MIN_RATIO` | 0.6 | Word-pair overlap needed to call something echo |
| `VOICE_ECHO_MIN_TOKENS` | 4 | Shorter transcripts are never suppressed |
| `VOICE_LOOP_BREAKER_BARGES` | 3 | Barge-ins that trip the backstop. **`=0` disables** |
| `VOICE_LOOP_BREAKER_WINDOW_MS` | 6000 | Window they must fall inside |
| `VOICE_LLM_STALL_MS` | 2500 | Mid-turn silence before a hold line. **`=0` disables** |
| `VOICE_LLM_TOOL_GRACE_MS` | 4000 | Extra turn budget per tool round. **`=0` reverts to a flat 8s** |
| `VOICE_LLM_HARD_TIMEOUT_MS` | 20000 | Ceiling no extension may pass |
| `WEBHOOK_TIMEOUT_MS` / `ATHENA_TIMEOUT_MS` | 6000 | Must stay inside the turn budget |

Counters for a batch of calls: `curl -s localhost:3000/api/debug/latency | jq .turnTaking`
— `nudges_fired`, `nudges_suppressed`, `holds_started`, `holds_capped`, `barge_ins`,
`barge_settles`, `echo_suppressed_interim`, `echo_suppressed_final`,
`loop_breaker_trips` (must be 0), `llm_stalls`.

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
