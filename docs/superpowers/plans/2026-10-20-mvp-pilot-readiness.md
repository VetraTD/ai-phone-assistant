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
