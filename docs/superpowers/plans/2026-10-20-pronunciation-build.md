# Pronunciation build plan (2026-10-20) — FOR OWNER REVIEW, nothing built yet

Branch feat/outbound-stage4. LIVE voice-uk-prod-00112-boh @ 4ae6f1d. Ledger: `.superpowers/sdd/2026-10-20-pronunciation/ledger.md`.

## Why
The receptionist (gemini-3.8-live) says "Digile Media" wrong. Listening test (2026-10-20, $0.54, blind, owner's ear):
Dij-aisle 7/10, Didge-isle 4/10, Dijile 2/10, today's Digile 1/10. None reached the 9/10 bar; **owner chose to build
the box with "Dij-aisle" anyway** (7 vs 1, p ≈ 0.02). Expect about 3 in 10 mid-call name mentions still wrong.
The model already says "we" when describing the business (0 of 24 such answers used the name).

## What callers will notice
1. **Greeting = a recorded clip** in the receptionist's voice, played the moment the call connects (faster than today:
   no wait for the AI). Same words every time, name said the approved way.
2. **Mid-call** the AI is given "Dij-aisle Media" instead of "Digile Media" → name right about 7 in 10 (was 1 in 10).
   It prefers "we / our team"; asked how it's spelled it spells D-I-G-I-L-E.
3. **Goodbye** is "Thanks for calling, have a great day" (no name) — every business.
4. **Fixed lines** ("Sorry, no one could take your call…", "technical problem", "time's up") in the receptionist's voice
   instead of the Polly robot voice; Polly stays as the fallback.
5. Owner side: Settings gets a **Pronunciation** box and a **▶ Hear greeting** button.

## Step 0 — ear test for the clip engine (~30 min + 10 min of your listening, ~$0.05; ask before running)
Render the Digile UK greeting four ways on one private page: (a) Google TTS "Kore" (Chirp 3 HD, en-GB) from the text
"Dij-aisle Media"; (b) Google TTS Kore with the exact phonetic spelling /ˈdɪdʒaɪl/ (Google supports it but one report
says it is sometimes ignored); (c) 5 takes from gemini-3.8-live itself ("say exactly"); plus one fixed line
("technical problem") in TTS and Live. You pick: which engine makes greetings, which makes fixed lines.
Reuse: `services/googleTts.js` (TTS, key already in .env), `lib/outbound/liveRender.js` `renderLines` (Live takes,
already checks every take's transcript against the text).

**Step 0 DONE (owner, 2026-10-20):** greeting = Google TTS Kore with the phonetic spelling (g1); fixed lines = Google
TTS. Live takes said the name right 2 of 5. So every clip is rendered by Google TTS Chirp 3 HD in the voice with the
same name as the business's live voice (`en-GB-Chirp3-HD-Kore`); no Live render sessions. A box entry is
`"Digile": "Dij-aisle"` or `"Digile": {"say": "Dij-aisle", "ipa": "ˈdɪdʒaɪl"}`; the IPA (operator-set) is used only
for clips; the dashboard edits "say" and drops the IPA when "say" changes.

## Step 1 — pronunciation box core (~2 h)
- Migration `055`: `businesses.pronunciations jsonb DEFAULT '{}'` (written → spoken, e.g. `{"Digile": "Dij-aisle"}`);
  same in `database/schema.sql`; `services/db.js` `loadConfig` maps it like `smsTemplates`.
- New `lib/voice/pronunciation.js`: `toSpoken(text, map)` (whole words; never inside an email, web address or @handle —
  so `info@digile-media.com` stays real), `toWritten(text, map)` (spoken → written, tolerant of "Dij aisle"/"Dijaisle"),
  `spokenConfig(config)` (copy with businessName, greeting, generalInfo, customInstructions, knowledge mapped).
- **Inbound Live only**: `lib/voice/live/index.js:9067` builds the prompt from `spokenConfig(config)`; tools, tool
  replies, SMS, emails keep the written config. **Outbound and the cascade are untouched** (outbound is off; its
  name check `lib/outbound/firstSeconds.js:561` would break on a spoken name — follow-up when outbound goes on).
- Prompt lines, only when the map is non-empty (`services/gemini.js`): prefer "we / our team"; asked the company name,
  say it; asked how it's spelled, spell the real letters (built from the written name).
- Goodbye: `services/gemini.js:1577` "thank them for calling ${businessName}" → "thank them for calling". Check
  `signOffRe` (`lib/voice/strings.js:976`) still matches "Thanks for calling, have a great day" (it should, via
  "have a … day"); a test pins it.
- Transcripts: map spoken → written where the AI's text is saved (`persistTurnTranscript`, `lib/voice/live/index.js:3120`),
  so stored transcripts, call summaries, post-call checks and emails say "Digile". Greeting-echo cut
  (`index.js:5366`) compares against the spoken greeting.
- `scripts/set-business-config.js`: add `pronunciations` (validated) so the Digile lines can be set via the migrate job.

## Step 2 — recorded greeting (~3–4 h)
- Migration `055` also: table `greeting_clips` (business_id, language_code, voice_name, engine, spoken_text, audio
  mu-law bytea, created_at), one row per business + language, row-level security like other tenant tables.
- A clip is used ONLY if voice, language, engine and the exact spoken text all match what the AI would say now
  (`greetingTextFor(config)` → `toSpoken`). Anything else → today's behaviour (AI speaks the greeting) and a re-render
  starts in the background, so a stale clip can never play and the next call has the new one.
- Custom greetings only; a business on the time-of-day default greeting keeps the AI-spoken greeting (3 variants =
  later).
- Pickup (inbound only, never outbound): load the clip with the config (300 ms limit, else fall back); play it with
  `audioOut.enqueue` + an end mark; do NOT send the "open the call" kick; prompt built with `greetingSpoken: true`
  ("already greeted, don't greet again"); seed the greeting as the AI's own turn (outbound's `seed` pattern,
  `index.js:8969`); hold back any AI audio until the clip's end mark (outbound's `onModelAudio` gate pattern,
  `index.js:6193`); tell the echo guard the greeting text; caller talking over the clip = same barge rules as today;
  silence after the clip arms the same "are you there?" handling as after a spoken greeting.
- Kill switch: env `GREETING_CLIP=on|off`, default off in code, set on in the prod deploy (env diff checked).
- Re-render on change: voice server route `POST /internal/greeting-clip` (Google-signed service identity, the
  verifier outbound already uses), called by the dashboard after a save that touches greeting, voice, language,
  name, disclosure or pronunciations. It renders if stale and returns the WAV.

## Step 3 — dashboard (~2 h; read the deployed dashboard images first)
- Backend (`AI-phone-dashboard/backend`): `pronunciations` validator + whitelist (`settingsValidation.js:282`; up to 10
  rows, letters/spaces/hyphens/apostrophes only, ≤ 40/60 chars, since the text goes into the AI's prompt); after save,
  trigger the re-render; `GET /api/business/:id/greeting-clip` proxies the voice route → WAV.
- Frontend: in `AIBehaviorSection.jsx` next to the greeting, **▶ Hear greeting** (plays the saved clip; "Save to hear
  your changes" while unsaved edits exist) and a **Pronunciation** box ("Written" → "Say it as"). The voice picker
  (`VoicePickerSection.jsx`) gets the same ▶, playing the greeting in the saved voice (pick → save → ▶).
- Infra: dashboard env `VOICE_INTERNAL_URL`; voice env `GREETING_CLIP_CALLER_SA` = dashboard's service account.

## Step 4 — LVX174 fixed lines (~2–3 h)
- Table `fixed_line_clips` (voice, language, line, text, engine, audio) — not tenant data. Rendered lazily: first time a
  line is needed it plays Polly and renders in the background; later calls `<Play>` the clip via a signed media URL
  (outbound's `lib/outbound/mediaUrl.js` + `mulawToWav` pattern). Four call sites: `server.js:980` (noAnswer),
  `index.js:8104` / `session.js:2659` (cantTransfer), `index.js:8463` (timeUp), `index.js:8533` (technical).
- Twilio fallback Function (`twilio/fallback/fallback.js`, runs when our server is down): optional `a=` parameter →
  `<Play>` a public Twilio Asset, else Polly as today. A script writes the WAVs (noAnswer + technical, Kore en-GB and
  en-US); **you upload them as Assets in each Twilio account's console** (~5 min each) and I add `&a=…` to the Digile
  numbers' fallback URLs (manual per client, as today).

## Step 5 — check, ship, test (~2–3 h)
- Red-first tests per step, each with a hand-verified RED sabotage row (`scripts/corpus/sabotage.mjs`; census).
- Opus review against the named risks: greeting said twice or not at all; clip/voice mismatch; stale clip after a
  settings change; spoken name leaking into tools/emails/dashboard/transcripts; cascade drift; outbound unaffected
  (outbound prompt byte-identical with a map present).
- Sharded gate in mintty (A then B, `.superpowers/sdd/2026-10-13-round-a1-say-it-once/run-shard-p6.sh`).
- ONE deploy (ask first): voice via Cloud Build `_TAG=<sha>` from the main checkout, migrate job (`055`, `--status`),
  stage `--no-traffic --tag`, env diff, 100%; dashboard after reading its deployed images. Then set Digile UK + US
  `pronunciations = {"Digile": "Dij-aisle"}` via the migrate job, ▶ the greeting in the dashboard, one test call on a
  Digile line.

## Size
~12–15 h over 3 sittings (more than the earlier 9–12 h: the dashboard ↔ voice-server link and the fallback Assets were
not counted). API spend ~$0.25 (ear test + test call). Cheaper models for mechanical edits; Opus for review.

## Defaults (owner reviewed 2026-10-20: plan APPROVED, ear test approved)
- **CHANGED by owner: the box applies to OUTBOUND too** (+~1 h): outbound prompt builders (`lib/outbound/prompt.js`,
  `firstSeconds.js` nudges, `index.js:1231` disclosure cue) get the spoken name; outbound's pre-rendered lines
  (`liveRender`) render the spoken text; `firstSeconds.firstTurnComplete` (`:561`) accepts the written OR spoken name;
  outbound transcripts map back to written. The cascade stays untouched.
- **CHANGED by owner: default (time-of-day) greetings get clips too** (+~0.5 h): three clips per business + language
  (morning / afternoon / evening), keyed by the same exact-text match, so the right one plays by the business's clock.
- KEPT: the voice picker's ▶ plays the SAVED voice; goodbye without the name for every business.
- New size: ~14–17 h over 3 sittings.

Owner to-do: Google Cloud free trial ends **2026-11-18** — billing must be a paid account by then.
