# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Owners and practice or office managers of UK small businesses — dental and medical practices, trades, salons, small law firms — who miss calls while they are working with a patient, on a job, or with a client. They are not technical. They evaluate on a phone or a laptop between tasks, and they decide by hearing what a call sounds like and by trusting the people who will set it up. A US market follows later; the UK is first and the live infrastructure runs in London (europe-west2).

Secondary: the staff who read call summaries and appointments in the dashboard after the fact.

## Product Purpose

Vetra answers a business's inbound phone calls in natural conversation, every hour of every day. On a call it books, reschedules and cancels appointments against the business's own appointment book, takes messages and callback requests, transfers to a person when the business's rules allow, answers questions from a knowledge base the business controls, and collects quote requests without quoting prices. After every call it writes a summary and outcome, stores the transcript, and alerts the owner by email or SMS.

Success: a business stops losing calls, and the owner can read exactly what was said and what was done without listening to anything.

## Positioning

The differentiator is the concierge set-up and the care taken with each client. Vetra is set up with the business by hand — number, hours, greeting, after-hours policy, transfer rules, knowledge base, voice — and is live in 3 business days. There is no self-serve sign-up by design. It runs on the business's real appointment book and knowledge, and every call leaves a written record the owner can read.

## Operating Context

- Calls arrive on a dedicated number the business gives out or forwards its existing line to.
- The owner configures nothing alone; configuration is done with Vetra during onboarding and adjusted through the dashboard afterwards (hours, after-hours policy, transfer policy, knowledge base, voice, notification preferences).
- After a call the owner receives a link-only email or SMS alert (no caller details in the message) and reads the summary, outcome and transcript in the dashboard at app.vetratd.com.
- Languages: English, Spanish, French. Several voices to choose from.
- Public site: vetratd.com. Dashboard: app.vetratd.com. Both are one React/Vite codebase built twice.

## Capabilities and Constraints

Shipped and verified on real calls: natural-conversation answering; book, reschedule, cancel, check availability, add a note to an appointment; take messages and callback requests (always on); transfer to a human (always on, policy-gated: always / business hours only / never); quote requests collected without quoting; knowledge-base answers; after-hours policies (take message / offer callback / book later / transfer if possible); per-call summary, sentiment and outcome; transcripts stored; owner notifications by email and SMS; caller data erasure on request.

Not shipped — the site must not claim: calendar or EHR integrations (Google Calendar was removed; athenahealth is not integrated), number porting, self-serve sign-up, "set up in minutes", call recording (calls are not recorded; transcripts are stored), any price or plan tier, "unlimited" calls or concurrency figures, pickup-speed or latency figures, uptime or SLA, HIPAA compliance, "8 languages", end-to-end encryption claims.

Undecided product facts: pricing (agreed per business during set-up; not published), the US launch date, caller-facing SMS confirmations (built, off by default, gated on recorded consent, not exercised on a real call).

Terminology: "Vetra" is the product and the receptionist. "Request access" is the only public call to action. "Live in 3 business days" is the sanctioned onboarding claim.

## Brand Commitments

- Customer-facing name is **Vetra**. The legal entity printed in Terms and Privacy is **VetraTD LLC** (Texas law for Terms; Privacy covers UK GDPR and US). "VetraTD" otherwise appears only in the domain and GitHub URL.
- Palette (binding): ink `#0e1c2c`, paper `#f4f9fe` and `#eaf2fb`, white surfaces, blue `#3a8ff2`, teal `#35d7d2` used sparingly, deep teal `#119c97`, muted `#56697e`. **No gradients.**
- Type (binding): Plus Jakarta Sans for text; Fraunces for display at weight 600, used straight — no italic accent words, no two-colour headings. Both are self-hosted (GDPR) in `AI-phone-dashboard/frontend/public/fonts`.
- Voice: plain and direct. Short sentences. Says exactly what happens. No hype, no slogans in threes, no invented numbers.
- UK English spelling throughout.
- Logo: `AI-phone-dashboard/frontend/public/vetra-logo.png` (mark) with the wordmark "Vetra"; favicon `public/favicon.svg`.
- Contact: `support@vetratd.com`.

## Evidence on Hand

- A real recorded demo call: `AI-phone-dashboard/frontend/public/vetra-demo-call.mp3` (2:43, Apex Wellness Clinic demo tenant; the receptionist books a GP consultation after hours). Word-timed transcript at `AI-phone-dashboard/frontend/src/site/content/demo-call.transcript.json`.
- The live dashboard at app.vetratd.com (not final; do not screenshot it for marketing yet).
- **Absent — must not be fabricated:** customers, testimonials, client logos, call volumes, satisfaction or accuracy statistics, press, case studies, founder photographs (owner will supply About content separately).

## Product Principles

1. Say only what ships. Every claim on the site traces to code that runs today.
2. The call is the proof. Show a real call doing the job before describing it.
3. One action per screen: "Request access". No competing calls to action.
4. We set it up with you. The site sets that expectation rather than promising self-serve speed.
5. Plain language, UK English, no filler.

## Accessibility & Inclusion

WCAG 2.2 AA contrast on all text; full keyboard operation with visible focus; `prefers-reduced-motion` respected; touch targets at least 44px; body text at least 16px on mobile; the demo call's transcript is available as plain text so the proof does not depend on audio.
