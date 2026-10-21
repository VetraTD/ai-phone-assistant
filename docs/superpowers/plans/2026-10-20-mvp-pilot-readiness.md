# MVP pilot readiness — four sessions (owner-approved 2026-10-20)

**Verdict at the start (2026-10-20).** The receptionist is fit for a supervised pilot (Digile, the owner listening)
but not yet for paying clients left unattended. Live voice: `voice-uk-prod-00112-boh` @ `4ae6f1d` (Part 6 + LVX183).
The client dashboard API is the 2026-09-08 build + the D1 hotfix (`dashboard-api-uk-prod-00003-hc7` @ `f130aee`);
22 dashboard commits (~16k lines) on `feat/outbound-stage4` are undeployed. `feat/outbound-stage4` is 438 commits
ahead of `main`. Launch checklist: `docs/readiness.md`.

**Owner decisions (2026-10-20):** order = security → name → dashboard → trust, then a client-day test. The name
fix is a per-business **pronunciation box** (the AI only ever sees the sound-spelling; dashboard, emails and
transcripts keep the real spelling), chosen by an ear test. The dashboard is **checked, redesigned (left-sidebar
navigation), then deployed once** — not deployed as-is first. Each session: a plan the owner reviews, red-first
fixes, hour estimates, ask before any paid run, deploy or destructive step.

## Session 1 · Security clean-up (~2–3 h)

Facts (2026-10-20): two Railway hosts still answer 200 — `ai-phone-assistant-staging.up.railway.app` and
`ai-phone-assistant-production-2300.up.railway.app` (`-3e90`, `-1f53` answer 404). No voice number points at Railway
(Twilio account B: +18176011171 and +18175803291 voice → `voice-uk-prod`), but **+18175803291's SMS URL points at
Railway production** (`/twilio/voice`) and +18176011171's SMS URL is Twilio's demo page. `main` still has backlog O1
(unauthenticated endpoints that spend money; closed on this branch). Supabase still exists behind Railway.

Steps: (1) read what Railway and Supabase still serve (env, last deploys, any traffic) — read-only; (2) merge
`feat/outbound-stage4` into `main` (fast-forward if possible; never force) and confirm `main` builds/tests;
(3) repoint 3291's SMS URL (to voice-uk-prod's SMS route if one exists, else Twilio's default) — ask first;
(4) shut down Railway services and Supabase — **ask before each delete, export/back up first**; (5) re-run
`curl` on every old host and the Twilio number list; (6) tick the readiness item.

## Session 2 · Pronunciation box + Digile (~3–5 h + ~$0.30 ear test)

The model (gemini-3.8-live, native audio) reads "Digile" as "Digital" or mispronounces it; an instruction ("Pronounce
Digile as DIJ-ILE") did not work and was removed (memory digile-lead-gen-tenant). Plan: a per-business map of written
→ spoken names (business name, and names the business enters: staff, services); the prompt builder and the greeting
use the spoken form wherever the model speaks; the written form stays in tools, dashboard, emails, transcripts.
Probe (pre-registered): 3–4 candidate spellings, ~10 greeting samples each, saved as audio for the owner to judge by
ear (STT would "correct" it too). Set it for both Digile tenants (UK `55c7c8c4…`, US `2083c6a4…`) with
`set-business-config`; the Settings field lands with the dashboard redesign. Check the claim detector / tenant-noun
matching still works when the spoken name differs from the written one.

## Session 3 · Dashboard check, redesign, one deploy (~8–13 h, 2–3 sittings)

(1) Check (~1.5–2 h): run the dashboard locally (memory dashboard-local-dev: Brightwork test business) and drive every
page and button with Playwright; list what is broken or off. (2) Design: left-sidebar main navigation (drawer on
phones); Settings keeps its own sections as a second column or tabs; mock-ups for owner approval before building
(impeccable / frontend-design skills). (3) Build the new shell (~4–6 h) and fix the listed buttons (~2–4 h); hide the
outbound-only setting cards; add the pronunciation field. (4) One deploy of dashboard API + frontend — read the
deployed images first (memory: the live API was 5+ weeks behind HEAD), then a live check with the test business.

## Session 4 · Receptionist trust (~4–6 h + ~$1–2 calls)

LVX182 (says "Done, you're all set" for a change it never made — the code makes the agreed change when the model
claims it without a tool call and the last move question was answered with anything but a no; post-call compares the
row's time with the last agreed slot) and warmth with upset callers (LVX168, LVX169, LVX184: no phantom "connect you",
no repeated business-only line, 988 kept). Measure on scripted calls before and after.

## Then · Client-day test (~2–3 h + ~$3–4)

~10 scripted calls on Digile UK and US (hours, book, move, cancel, message, silence, after-hours, long call, upset
caller); each must appear correctly in the dashboard and the owner email.

## Owner to-dos in parallel (no code)

**Google Cloud free trial ends 2026-11-18** — make billing a paid account (~15 min; every call stops otherwise).
Gemini daily spend alert (~10 min). Twilio country limits (~10 min). LLC → EIN → bank → Stripe; insurance; terms + DPA;
support inbox + "when it breaks" plan; Digile pilot agreement.

## Session 1 starting message (paste into a fresh session)

```text
MVP pilot readiness, session 1: security clean-up. Read docs/superpowers/plans/2026-10-20-mvp-pilot-readiness.md
(Session 1) and docs/readiness.md (Launch checklist: "Merge feat/outbound-stage4 into main, then shut down Railway and
Supabase"). Live voice voice-uk-prod-00112-boh @ 4ae6f1d; branch feat/outbound-stage4.
FIRST: reiterate in one short plain paragraph (steps, hours, $) and ask anything needed (AskUserQuestion).
Read-only first: what Railway (staging, production-2300) and Supabase still serve; Twilio SMS URL of +18175803291 still
points at Railway production. Then: merge to main (never force), repoint that SMS URL (ask), back up, then shut down
Railway services and Supabase -- ask before EACH delete. Verify every old host and the Twilio number list after.
Conserve usage; cheaper models for mechanical work; detail in a ledger; never git checkout over uncommitted work.
```

## Owner update (2026-10-20, later): new order + pronunciation design

**Order now:** pronunciation (next) → dashboard → trust → client-day test → **security clean-up LAST** (owner). The
Railway hosts stay up meanwhile; nothing calls them except +18175803291's SMS URL.

**Pronunciation = all three layers + LVX174 (~6–9 h + ~$0.50), owner-approved after a plain explanation:**
1. **Recorded greeting** — per business (and language), a clip of the greeting made once and approved by ear; played
   at pickup while the model is told the greeting was already said (reuse the outbound seeded-first-line mechanism:
   Live's own audio for that line is dropped; prompt `greetingSpoken`); regenerated when the greeting changes; falls
   back to the model's spoken greeting if the clip is missing. Voice source: try BOTH Google TTS "Kore" and the best of
   several takes from gemini-3.8-live itself; the owner picks on a phone.
2. **Pronunciation box** — per business written → spoken map (business name; staff/service names it enters); the model
   only ever sees the spoken form; written form kept in tools, dashboard, emails, transcripts; a prompt line to say
   "we / our team" rather than repeat the business name. Check the claim detector's tenant-noun matching.
3. **Listening test** — ~10 samples per candidate spelling + the greeting in both voices, saved as audio for the owner
   (STT normalises spellings and calls are not recorded, so no automatic check). Pre-register the pick rule.
4. **LVX174** — the fixed lines (noAnswer, cantTransfer, technical, technicalOutbound, timeUp) as clips in the
   receptionist's voice, Polly as fallback; Twilio fallback Function clips as Assets per account.

## Pronunciation session starting message (paste into a fresh session)

```text
MVP pilot readiness: pronunciation session. Read docs/superpowers/plans/2026-10-20-mvp-pilot-readiness.md
("Owner update ... pronunciation design") and docs/receptionist-backlog.md LVX174; memory digile-lead-gen-tenant
(the earlier "pronounce Digile as DIJ-ILE" instruction failed). Live voice voice-uk-prod-00112-boh @ 4ae6f1d; branch
feat/outbound-stage4. Owner decisions (final): all three layers + LVX174 -- recorded greeting per business (voice:
try Google TTS "Kore" AND the best gemini-3.8-live take, owner picks by ear), pronunciation box (model sees only the
spoken form, says "we/our team" mid-call), listening test (~$0.50, ask before spending), fixed lines in the
receptionist's voice; dashboard greeting preview (▶, exact clip, no phone toggle); goodbye without the name; no
mid-call name-check button. Digile tenants: UK 55c7c8c4 (+441372656055), US 2083c6a4 (+18176011171).
FIRST: reiterate in one short plain paragraph (steps, hours, $) and ask anything needed (AskUserQuestion). Then the
listening test FIRST as a go/no-go for the box (owner rule >= 9/10 by ear; see "listening test FIRST"). Then a
plan for owner review before building; red-first tests with sabotage rows; sharded gate in mintty; ask before deploy.
Conserve usage; cheaper models for mechanical work; detail in a ledger; never git checkout over uncommitted work.
```

## Owner decisions on the pronunciation design (2026-10-20, after "do we even need the box?")

- **Greeting preview in the dashboard: YES, preview only** — a ▶ next to the greeting plays the exact clip callers
  hear in the business's chosen voice (Settings already has a 5-voice Live picker, `VoicePickerSection.jsx`, with no
  preview — this also gives it one). The clip is remade automatically when the greeting, voice or pronunciation
  changes. No "as on a phone" toggle.
- **Pronunciation box: KEPT.** It is the fix lever for the clip (the clip's voice engine can misread "Digile" too:
  preview sounds wrong → fix the box → clip remade) and for everything the AI says live mid-call.
- **No "hear it say our name mid-call" button** — mid-call pronunciation is checked with a test call.
- **The goodbye drops the business name** ("Thanks for calling, have a great day") to cut mid-call mentions. Asked
  the company name, the AI says it (spoken form); asked how it is spelled, it spells the real written letters.
- Mid-call slips are reduced, not impossible; the listening test measures the leftover rate with mid-call sentences
  in the live voice. Splicing a recorded name into live speech is ruled out for now (seams, timing).
- Built in the pronunciation session inside today's Settings panels (greeting + voice); they carry into the redesign.

## Owner decision: listening test FIRST, as a go/no-go (2026-10-20)

Owner asked "will the box work for sure?" -- honest answer: for the greeting yes (an approved clip is fixed audio);
for live mid-call speech nobody knows until measured. So the pronunciation session STARTS with a paid listening test
(~$0.30, ~1 h, ask before running): gemini-3.8-live with the real prompt says mid-call sentences with the business name
("Digile Media helps businesses grow", "This is Digile Media", an answer to "what's the company called?") ~10 times
for each of 3-4 sound-spellings; audio saved for the owner to judge on a phone. **Pre-registered rule: a spelling
passes if the owner judges it right in >= 9 of 10 samples.** One passes -> build the box as planned. None passes -> no
mid-call box; rely on the recorded greeting, "we / our team", the goodbye without the name, and spelling the real
letters when asked; the owner then decides whether a bigger fix (splicing the recorded name) is worth it. The recorded
greeting + dashboard preview + LVX174 are built either way.
