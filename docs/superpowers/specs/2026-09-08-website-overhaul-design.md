# Website overhaul — design spec (2026-09-08)

Status: approved by the owner 2026-09-08. Implementation plan lives in the session plan file; this document records the decisions and constraints that outlive the session.

## Why

vetratd.com read as AI-generated and stated things that were not true. The owner asked for a full overhaul: same palette minus the gradient, mobile support, no price anywhere, a real multi-page layout, proper Terms and Privacy, a full-size footer, fewer FAQs, and the app.vetratd.com login page restyled to match. The dashboard after login does not change.

The site is this repo: `AI-phone-dashboard/frontend`, one Vite app built twice, selected by `VITE_BUILD_TARGET` (`marketing` default → Vercel/vetratd.com; `app` → Firebase/app.vetratd.com). Work lands on `feat/site-overhaul`; `main` is untouched until the owner approves on localhost.

## What was wrong (verified 2026-09-08 at 1440 and 375)

- AI tells: italic accent word in the serif hero, gradient buttons and gradient text, glow orbs, every section a centred H2 over three identical icon cards, a fake dashboard mock, FAQ filter pills, tricolon slogans, a shield "trust line", a three-button CTA block.
- Mobile: nav hidden under 768px with no menu; header actions wrapped to three lines at 375px.
- False copy vs code: `$149/mo`, "8 languages" (en/es/fr only), "port your number" (no porting), Google Calendar (deleted), "sign up in minutes" (self-serve closed), "unlimited calls" (never load-tested), "every call encrypted".
- Legal: ~600 words of boilerplate on one page, dated at render time, no entity, no jurisdiction, no sub-processors, no retention.
- Footer: one 85px row. Two different public emails.

## Decisions

| Topic | Decision |
|---|---|
| Pages | `/`, `/features`, `/about`, `/contact`, `/privacy`, `/terms`; `/legal` → `/privacy`. No pricing page; no price anywhere. |
| About | Real founder content supplied by the owner; `OWNER_TODO` slots until then; hidden from nav while any slot is empty. |
| Guided dashboard demo | Removed. |
| Demo phone number | Removed; kept as one nullable constant (`DEMO_NUMBER = null`) for later. |
| Hero | The real recorded demo call with a live, word-aligned transcript (Deepgram nova-3, one run). |
| Market | UK first, UK English. |
| Legal | Terms under Texas law; entity "VetraTD LLC"; Privacy covers UK GDPR (Art. 3(2)) and US; `support@vetratd.com`; calls not recorded, transcripts stored; sub-processors: Google Cloud (europe-west2), Google AI Studio/Gemini, Twilio, Deepgram, ElevenLabs, Microsoft 365, Sentry; retention until deletion or account closure; backups up to 35 days. |
| Fonts | Plus Jakarta Sans body, Fraunces display at weight 600, used straight. |
| Palette | Existing hex values, re-declared as `--site-*` under `.site-root`; existing `--vetra-*` values never edited (the dashboard reads them). No gradient. |
| Process | Impeccable 4.2.2: PRODUCT.md, rolled direction round locked by the owner, detector hook, bounded finish review, DESIGN.md written from the build. |

## Pinned constraints

- Palette: ink `#0e1c2c`, paper `#f4f9fe` / `#eaf2fb`, white surfaces, blue `#3a8ff2`, teal `#35d7d2` (sparingly), deep teal `#119c97`, muted `#56697e`. No gradient anywhere.
- Type: Fraunces 600 display, Plus Jakarta Sans text. No italic accent word, no two-colour heading, no ALL-CAPS eyebrow.
- Proof: the real call is the demonstration.
- One primary CTA per screen ("Request access"); a real mobile menu; footer ≥280px on desktop; six FAQs.
- Anti-tells: no 3-card icon grids, glow orbs, `→` on buttons, middle-dot metadata, tricolon slogans, fake stats, stock photos, emoji, per-section fade-ups.
- Motion: one orchestrated hero entrance and the transcript highlight; reduced-motion respected and scoped to `.site-root`.

## Copy truth

Say only what ships: natural-conversation call answering; book/reschedule/cancel; messages and callbacks; transfer per rules; knowledge-base answers; quote requests without quoting; summary, outcome and transcript per call; email/SMS alerts to the owner; English, Spanish, French; selectable voices; set up with you; live in 3 business days; data hosted in London; calls not recorded.

Never: prices, "unlimited", "instant", uptime/SLA, HIPAA, calendar or EHR integrations, number porting, "8 languages", self-serve, "encrypted end-to-end", customer counts or testimonials.

## Owner actions outside the repo

1. Vercel `VITE_API_URL` → the Cloud Run dashboard API (currently a dead Railway host; contact-form submissions are lost).
2. Pick the canonical host (`vetratd.com` vs `www.`) and redirect the other.
3. `support@vetratd.com` must be a monitored mailbox.
4. Form VetraTD LLC before the legal pages go live.
5. Fill the About slots.
