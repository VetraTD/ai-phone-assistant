# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Owners and office or practice managers of small local businesses (clinics and dental practices, trades, salons, small firms, lead-generation agencies), UK first, US after. They are not technical. They miss calls while they are with a patient, on a job, or with a client.

Two people use the dashboard, with equal weight (confirmed 2026-11-22):

- **The owner, on a phone**, between jobs or patients. Opens it from an alert email to see who needs a call back and what was booked.
- **Front-desk or office staff, on a desktop**, working through calls and messages at a desk.

## Product Purpose

VetraTD answers a business's inbound phone calls in natural conversation, every hour of every day. On a call it books, reschedules and cancels appointments, takes messages and callback requests, transfers to a person when the business's rules allow, and answers questions from a knowledge base the business controls. After every call it writes a summary and outcome, stores the transcript, and emails the business.

The dashboard's job: show the owner what needs them (callers waiting for a call back, messages, today's bookings), let them read exactly what was said and done on any call, and let them adjust what the receptionist says, knows and does.

Success: no caller falls through the cracks, and the owner never has to wonder what the receptionist told someone.

## Positioning

Set up with the business by hand, on the business's own appointment book and knowledge, and every call leaves a written record the owner can read. Setup is concierge today; self-serve sign-up is planned for later, so the dashboard must not assume either one forever (confirmed 2026-11-22).

## Operating Context

- Calls arrive on a dedicated number the business gives out or forwards its existing line to.
- After each call the business gets an email from notifications@vetratd.com with a link into the dashboard.
- Dashboard lives at app.vetratd.com; the marketing site at vetratd.com. One React/Vite codebase.
- Languages on calls: English, Spanish, French. Several voices.
- Receptionist features (booking, messages, transfers, after-hours, intake fields) are defined by the voice engine and rendered from its schema; adding a feature must not need dashboard code.

## Capabilities and Constraints

Working today: answering in natural conversation; book, reschedule, cancel, check availability; messages and callback requests; policy-gated transfer; knowledge-base answers; after-hours policies; per-call summary, sentiment and outcome; stored transcripts; owner email alerts.

Not available, so the dashboard must not show or imply them: call recordings (calls are not recorded; transcripts are), billing or plan management (not built), texts to callers in production (off), outbound calling (off), CRM or calendar integrations beyond what is verified working.

Rule: never show a control or panel for something that does not work yet. It stays hidden until it is real.

Undecided: pricing shown in-app, staff logins and roles, the self-serve sign-up date.

## Brand Commitments

- Name in the dashboard: **VetraTD** (confirmed 2026-11-22).
- Mark: the gradient ribbon "V" on navy (`public/icon-192.png`, `public/vetra-mark.png` on GitHub main).
- Palette from the new site: navy `#010b29`, raised navy `#061438`, blue `#1273fe`, ink blue `#0038fd`, cyan `#00eafe`, soft `#f2f6ff`, muted `#4f5b78`; ribbon gradient cyan to blue to ink blue.
- Type from the new site: Fraunces for display, Plus Jakarta Sans for text.
- Voice: plain and direct, short sentences, says exactly what happens. UK English.
- Alerts and notes lead with the action, talk about the caller, and never alarm without cause.

## Evidence on Hand

- Test business: Brightwork Family Dental (synthetic data; safe to show in mock-ups, labelled as sample).
- Real call transcripts exist in the database; none may be shown outside the business they belong to.
- Absent, must not be fabricated: customer names, testimonials, usage statistics, uptime figures.

## Product Principles

1. Actions first. Open on what needs the owner, not on charts.
2. Every call is readable: summary, what it did, full transcript, in one place.
3. Simple by default; the detail is there when asked for.
4. Show only what works.
5. Phone and desktop are equal citizens.

## Accessibility & Inclusion

WCAG 2.2 AA contrast; full keyboard operation with visible focus; touch targets at least 44px; body text at least 16px on phones; `prefers-reduced-motion` respected.
