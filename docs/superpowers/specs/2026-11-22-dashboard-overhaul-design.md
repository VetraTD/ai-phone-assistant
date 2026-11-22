# Dashboard overhaul: design

Date: 2026-11-22. Status: draft for the owner's approval.
Product context: `PRODUCT.md` at the repo root (users, brand, the "show only what works" rule).

## 1. Why

The owner dashboard (`AI-phone-dashboard/frontend`) is clunky, hard to navigate, carries the old brand, and has
parts that do not work or are fake (a hard-coded "Starter / Not connected yet" billing panel, a `?demo=1` mode open to
anyone). The owner wants a dashboard a non-technical business owner can live in: see who needs them, read exactly what
the voice agent said and did on any call, and change what it says, knows and does, on a phone or a desktop.

Success: no caller falls through the cracks, the owner never wonders what the agent told someone, and every control on
screen changes what happens on a real call.

## 2. Who it is for

Equal weight (owner decision, 2026-11-22):

- **The owner, on a phone**, between jobs, usually arriving from an alert email.
- **Front-desk staff, on a desktop**, working through calls and messages.

Setup is concierge today (we configure each business); self-serve sign-up comes later. The design must not assume
either one forever.

## 3. Goals, non-goals, anti-goals

**Goals**
- Five tabs: Home, Inbox, Calendar, Voice agent, Settings. Same structure on phone and desktop.
- Home opens on what needs the owner, with the action on the row (Call back, Done).
- Every call readable in one place: what needs doing, summary, what VetraTD did, the whole conversation.
- A "handled" state so the team can clear what they have dealt with.
- Every receptionist setting in one tab (Voice agent), grouped as Voice & greeting, Business info, Actions.
- New brand: navy/blue/cyan palette, Fraunces + Plus Jakarta Sans, the ribbon mark, VetraTD's own icons.
- Real URLs, so alert emails and the browser back button land in the right place.

**Non-goals (this round)**: phone app or push notifications; a test call in the browser; undo/version history; an
in-app AI helper; integrations (GoHighLevel and others); billing; staff logins and roles; editing bookings from the
dashboard; texts to callers; outbound calling; self-serve custom actions.

**Anti-goals (a failure even if it works)**
- Any control, panel or number that does not reach a real call or reflect real data.
- Jargon a business owner would not use ("capabilities", "webhook", "intake", "says/knows/does").
- Stock-icon, card-grid "AI dashboard" look.
- Client-specific code: everything specific to one business is configuration.

## 4. Constraints

- **Show only what works.** Hidden until real: recordings (no call is recorded), billing, caller texts (production SMS is
  off), outbound, integrations, custom actions that have not been proven on a live call.
- **Actions stay schema-rendered.** `CapabilitiesSection.jsx` renders from `/api/capabilities/definitions` and contains
  no capability-id literals. Adding a capability to the voice engine adds a row and its settings panel with no
  dashboard code. Outbound-only packs (`qualification`, `outcome`, `callback`, `optOut`) and `smsConsent` must not
  appear on an inbound business; filter them by a pack property, never by id.
- **Generic code, configuration for specifics** (no per-client branches).
- **Tenant scoping.** Every new read and write goes through `withTenantHandler`; unscoped writes fail closed under RLS,
  so tests must assert the row actually changed.
- **The repo is public.** No client data, transcripts or call logs in code, fixtures or docs. Mock-ups use the synthetic
  Brightwork Family Dental business.
- UK English in the interface. WCAG 2.2 AA, keyboard operable, visible focus, 44 px touch targets, 16 px minimum body
  text on phones, `prefers-reduced-motion` respected.
- Ask before spending API money (any new post-call model step counts).

## 5. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Restyle the current dashboard in place: new colours and fonts, rename things, keep `App.jsx` switching pages by state. | Cheapest (about 20–30 h). Keeps the structure that makes it hard to navigate: no URLs, settings spread over twelve sections, phone layout bolted on. |
| **B** | **New shell with real URLs inside the same React/Vite app. Move one page at a time and reuse the parts that work: the capability renderer, knowledge editor, hours editor and save logic. Small backend additions only.** | About 35–52 h. Fixes navigation and the phone layout properly. Each page can ship on its own. |
| C | A separate new app. | A clean slate, but it redoes auth, the API client and the tests, and leaves two dashboards running during the switch. The longest route, and nothing it buys that B does not. |

**Chosen: B** (owner, 2026-11-22). It fixes the structural problems A leaves in place, without C's rebuild.

## 6. What gets built, in order

**Leaner plan (owner, 2026-11-22: save time and usage without losing quality).** This table replaces the one below it.

| Stage | What | Hours |
|---|---|---|
| 0 | **Security and honesty first** (section 10a): prove the sign-in takeover gap stays closed; add security headers; delete `?demo=1` and the language switcher; remove the fake billing panel; fix the CSV export; the "every setting reaches a call" tripwire. No separate deploy of the old dashboard. | 5–8 |
| 1 | Shell and brand, porting the prototype's styles and layouts directly. | 5–8 |
| 2 | Home and Inbox, the Done state and the 7-day backfill. | 8–11 |
| 3 | Voice agent tab: move the existing settings sections, renames, Quotes hidden. **First deploy of the new dashboard** (old Calendar and Settings shown inside the new shell until replaced). | 4–6 |
| 4 | Calendar: week grid on computer, day list on phone, cancelled and moved bookings shown. | 3–5 |
| 5 | Settings, CSV download, Email me bookings, Call trends (the existing Analytics page restyled in place, not redesigned). | 3–5 |
| 6 | **One voice-service change and one deploy**: alert emails link to the call, and booking moves and cancellations are recorded against the call that made them. | 4–6 |
| 7 | Security review of everything changed, browser check, one real test call, final deploy. | 2–3 |

Total about 34–52 h. The equivalent scope under the old table, with moves, cancellations and the security work added,
would be about 47–72 h. The savings come from: reusing the prototype's styles, no deploy of the old dashboard,
restyling Call trends instead of redesigning it, one voice deploy instead of two, deferring the optional
"Questions it couldn't answer" card, and working practice (one review per stage, not per task; a cheaper model for
mechanical moves; one browser check per stage). The only visible trade is the deferred card.

Original table, kept for reference:

| Stage | What | Hours |
|---|---|---|
| 0 | **Make the current one honest, then deploy it.** Remove the fake billing panel (`App.jsx:459`); delete `?demo=1` (`App.jsx:469`) and its link in `Landing.jsx` (owner, 2026-11-22: not used; the clickable prototype serves as a demo); remove the dashboard language switcher (owner: interface is English only until fully translated); add a tripwire test proving every non-capability setting on screen reaches a call (greeting, tone, house rules, voice, languages, call notice, business details, hours, after-hours policy, transfer policy and number, alert email, knowledge base), modelled on `tests/capabilityConfigEffects.test.js`; deploy (readiness checklist, "Deploy the current dashboard"). | 8–12 |
| 1 | **Shell and brand.** Routes, side navigation (desktop) and bottom tab bar (phone), tokens, fonts, icons, responsive layout. Pages not yet rebuilt render their current component inside the new shell. | 8–12 |
| 2 | **Home and Inbox**, plus the "handled" state and a home summary endpoint. | 10–14 |
| 3 | **Voice agent tab.** Move every existing settings section into its new place (section 8), rename, apply plain labels. | 5–8 |
| 4 | **Calendar** week view, read-only. | 4–6 |
| 5 | **Settings** (alerts, number, login, usage, help) and removal of the old pages. | Included above |
| 6 | **Kept features and email links** (owner, 2026-11-22): the Analytics page restyled as "Call trends"; CSV download of calls in the Inbox; "Email me bookings" in the Calendar; alert emails link to the call (voice-service change and deploy). | 6–10 |
| Optional | **"Questions it couldn't answer"** on Home, with "Add the answer". Needs new data (section 9). | 4–7 |

Total about 41–62 h, plus the optional item.

## 7. Navigation and URLs

| Tab | Phone label | URL |
|---|---|---|
| Home | Home | `/home` |
| Inbox | Inbox | `/inbox`, `/inbox/:callId` |
| Calendar | Calendar | `/calendar` (shown only to businesses with bookings on) |
| Voice agent | Agent | `/voice-agent/:section/:item`, sections `voice`, `info`, `actions` |
| Settings | Settings | `/settings/:item` |

- Desktop: navy side navigation with the mark, business name, the five items (Settings at the bottom), and a count of
  open items on Home. The active icon turns cyan.
- Phone: bottom tab bar with five items; "Voice agent" shortens to "Agent" because it does not fit five across.
- Alert emails link to the call they are about, `/inbox/:callId` (owner, 2026-11-22). Today every owner email links to
  the bare dashboard address (`dashboardLine()` in `services/notifications.js`), so this is a voice-service change,
  including the link-only email that healthcare-tier businesses get, and a voice-service deploy (ask the owner before
  deploying). The bare address keeps working and opens Home.
- **Call trends** (the Analytics page, kept by the owner) is reached from the week sentence on Home ("See call trends")
  and from Settings > Usage, at `/trends`. It is not a sixth tab, so the phone bar stays at five. Its charts show only
  real data and follow the project's chart guidance at build time. (Placement is the author's call.)
- Leaving a settings panel with unsaved changes asks first.

## 8. Screens

The clickable prototype shows each of these working, with sample data: `.superpowers/brainstorm/28460-1795364952/content/prototype-v1.html`
(local only, gitignored). Where this document and the prototype disagree, this document wins.

### Home
- A greeting in Fraunces and one sentence: how many callers need you, how many calls VetraTD answered today, and how
  many bookings it made (appointments created on today's calls; moves are not counted, see Inbox).
- **Needs you**: one row per open item, oldest first. The row starts with the call time, then what is needed in the
  caller's terms ("Call back after 3 pm"), the name, and one line. Inline buttons: **Call back** (where there is a
  number) and **Done**. Clicking the row opens the call.
- **Done today**: calls with nothing to do and items the team marked done, with **Reopen** on the latter.
- Desktop right rail (below the list on narrow screens): today's bookings with a "now" line, and one sentence for the
  week so far.
- Empty state: "Nothing needs you right now. New calls that need you will show up here, and you'll get an email."

### Inbox
- Desktop: list, call, and caller columns (the caller column drops below 1180 px). Phone: list, then the call on its
  own screen with Call back and Done fixed at the bottom.
- List: "Needs you (n)" and "All calls" switch, search over name, number and call text, grouped by day. The status,
  sentiment and direction filters go: the switch and search replace them, and outbound is off.
- **Download calls (CSV)**, kept from today's dashboard, sits at the top of the list on desktop.
- Call: name, number, time and length; a coloured line saying what is needed or that it is done; Summary; What VetraTD
  did (ticked list); the booking it made, with "See it in the calendar"; Conversation, first four lines then "Show the
  whole conversation".
- "What VetraTD did" and the status line use only what is recorded per call today: a booking made on the call
  (`appointments.call_id`), a message or call-back request (`customer_requests`), a transfer (`calls.status`).
  "Nothing for you to do" appears only when the call produced a booking, a booking change or a transfer. Any other call
  without a message says "No message was left." and lets the summary tell the rest, because a hang-up, a refused
  message or a technical failure would make "VetraTD handled this call" false.
- **Moves and cancellations are shown** (owner, 2026-11-22), once stage 6 records them: "Moved her check-up from
  Wednesday 25 November, 9:00 am to Tuesday 24 November, 9:00 am", "Cancelled her check-up, Wednesday 25 November,
  11:00 am". Until stage 6 ships they appear only in the summary text. Home's week sentence counts bookings made, and
  bookings moved or cancelled, separately.
- Caller column: other calls from the same number, and this week's bookings for that caller.
- **Call back** is a `tel:` link. On a desktop the number is also shown as text.

### Calendar
- Desktop week grid, Monday to Saturday, 8 am to 6 pm, with Today, previous and next week, and a "now" line. Phone:
  week strip and a day list.
- Clicking a booking shows its type and time, "Booked by VetraTD on a call on ..." (the call in
  `appointments.call_id`, which stays the booking call after a move) with a link to that call, and, once stage 6
  ships, "Moved here" or "Cancelled" by VetraTD on a call, with a link to that call.
- Cancelled bookings stay on the grid, struck through and hatched, so the front desk can see the freed slot.
- Shown only to businesses with bookings on whose bookings live in VetraTD's own calendar. Businesses on athenahealth
  keep their bookings in that system, not in `appointments`, so they get no Calendar tab.
- Dates and "today" use the business's timezone, not the database's.
- No "Booked by VetraTD" legend: the dashboard has no way to add a booking, so every booking in VetraTD's calendar came
  from a call. The legend comes back if and when an outside calendar is shown here.
- Read-only. Calls can still move and cancel bookings.
- **Email me bookings**, kept from today's dashboard (`POST /api/appointments/email`: today, next 7 days, upcoming),
  sits in the Calendar header and sends to the alert address.

### Voice agent
Header: "To try a change, call (business number). Saved changes apply from the next call." with Copy number.
Desktop: list on the left, the chosen item's panel on the right with a Save bar. Phone: list, then the item on its own
screen. Turning an action on or off applies at once; everything else uses Save and Discard.

| Section | Item | Comes from today |
|---|---|---|
| Voice & greeting | Greeting, Tone of voice, House rules | `AIBehaviorSection` |
| | Voice | `VoicePickerSection` (writes `live_voice`) |
| | Languages, Call notice | `LanguagesSection` |
| Business info | Business details | `BusinessInfoSection` |
| | Opening hours | `BusinessHoursEditor` |
| | When you're closed | `AfterHoursSection` |
| | Questions and answers | `KnowledgeBaseEditor` (saves per answer, no Save bar) |
| Actions | Bookings, Messages | `CapabilitiesSection` (schema-rendered) |
| | Quotes | Hidden (owner, 2026-11-22: not every business uses it). Generic rule: a pack marked as opt-in appears only for a business where it is switched on, so if we turn Quotes on for one business it shows for that business only. Confirm no business has it on today before hiding. |
| | Transfers | `TransferRulesSection` (policy and number) |
| | Your custom actions | Hidden in this round (see below) |

- Action names and labels change in the voice engine's pack definitions, since the dashboard renders them: Appointments
  → **Bookings**, Messages & callbacks → **Messages**, Transfer to a person → **Transfers**, Quote requests → **Quotes**;
  field labels become plain statements ("Information callers must give", "Read the details back and wait for a clear
  yes", "Your booking rules"). Confirm the labels are dashboard-only and do not reach the prompt before changing them.
- The list shows a switch for actions that can be turned off, "Always on" for `core` packs, and the transfer policy for
  Transfers.
- Bookings panel: information callers must give (built-in name, date of birth, number on file, plus the business's own
  items with how the agent asks and a format such as "8 digits"), read-back, opening-hours-only, booking rules, and
  under More options: length, bookings per slot, existing-appointment rule. Formats are offered as choices; regular
  expressions are never shown to the owner.
- **Custom actions stay concierge** (owner, 2026-11-22). The "Your custom actions" group appears only for a business that
  has one, and only after a webhook action has been proven on a live call. "Ask us to add it" opens a message to us.
- `TasksSection` writes the legacy `allowed_tasks` list, which `business_capabilities` has replaced as the source of
  truth. Confirm and remove it rather than move it.

### Settings
- **Email alerts**: the one address that gets the after-call email, and the existing on/off switch.
  `businesses.notification_email` holds a single address and the voice service sends to it, so the prototype's "add
  another address" is not built this round. The text alert-phone field and "What callers get afterwards" stay hidden
  while texts are off.
- **Your number**: the VetraTD number and how call forwarding works.
- **Your login**: email and change password.
- **Usage**: minutes this month, from `/api/usage`.
- **Help**: a short "how VetraTD works" and a way to message us.
- **Sign out.** No billing, plan or team panels.

## 9. Backend changes

- **Handled state.** Add who and when a call's open item was marked done (for example `handled_at`, `handled_by` on
  `calls`), with an endpoint to set and clear it. Tenant-scoped, with a test that the row changed.
- **Launch backfill** (owner, 2026-11-22): when this ships, open items from the last 7 days stay under "Needs you"; older
  ones start as done, marked as set at launch rather than by a person, and can be reopened.
- **What counts as "needs you".** An open item exists when the call produced a message or call-back request
  (`customer_requests`) and has not been marked handled. The item text comes from the request (call-back time, message);
  calls that only booked, transferred or turned down a seller have nothing to do.
- **Home summary endpoint**: open items, today's counts, today's bookings, and the week sentence in one request.
- **Calendar**: the existing `/api/appointments` with a date range, plus the call id for each booking.
- **Booking changes per call** (stage 6, voice service). Today a move rewrites `scheduled_at` on the same row and a
  cancel only sets `status`; nothing records which call did it or the old time. Add a small change record (booking,
  call, kind, old time, new time), written by the voice engine when a move or cancel succeeds, and read by the Inbox,
  Home and Calendar. Ships in the same voice deploy as the email links.
- **Optional: questions it couldn't answer.** Deferred to save time. Nothing records these today. It needs a post-call step that saves the
  questions the agent could not answer from Business info against the call. That is a model call per call, so the cost
  needs the owner's approval before it is built.

## 10. Look and feel

- Palette from `PRODUCT.md`: navy `#010b29` for the side navigation and the phone frame, ink blue `#0038fd` for primary
  buttons and the active state, cyan `#00eafe` only for the active navigation icon and the Home count, soft `#f2f6ff` for
  the page. Amber marks "needs you" text, green marks done. Colour is never the only signal.
- Fraunces only for the Home greeting; Plus Jakarta Sans everywhere else, tabular figures for times.
- Five solid navigation icons drawn for VetraTD (house, tray, calendar, sound wave for the voice agent, sliders for
  settings). No icons in coloured circles; list rows lead with the time or the words.
- Flat surfaces with hairline borders, one radius per element type, no decorative gradients or shadows except on
  popovers and dialogs.

## 10a. Security and compliance

Owner, 2026-11-22: make it as hard as possible for attackers and leave as little room for problems as possible. No
system is risk-free; the aim is layers that each hold on their own, tests that prove them, and a review before every
deploy.

**Found while writing this up, fixed in stage 0**
- **Account takeover risk at sign-in: already closed** (checked while planning, 2026-11-22; the earlier note here was
  wrong). Migration 036 resolves a login by the account id, not the email (`getBusinessIdForUser` →
  `app_lookup_user_by_auth_uid`), `users.auth_uid` is NOT NULL, new staff are attached only by an operator
  (`app_attach_user_to_business`, migration 040), and `tests/db/userDirectoryAuthUid.test.js` proves changing an email
  moves nobody. Stage 0 adds one dashboard-level test that a fresh account using a client's email gets no business.
- **No security headers on the dashboard site.** Firebase Hosting (`frontend/firebase.json`) sets only `Cache-Control`:
  no content security policy, no framing protection. Stage 0 adds them.
- **Spreadsheet export.** `callsCsv.js` does not neutralise cells starting with `=`, `+`, `-` or `@`. Caller-influenced
  text (names, summaries) could become a formula when opened in Excel. Prefix such cells so they are always text.
- **Demo mode open to anyone**: deleted.

**Rules for everything built**
- Every new endpoint requires login, runs inside `withTenantHandler`, and has a test proving business A cannot read or
  change business B's calls, bookings or Done state.
- Reading call content (call detail, CSV export, Home) is recorded in the existing access log (`phiAudit.js`).
- Caller speech and AI-written text are always shown as plain text, never as HTML. `tel:` links are built only from
  validated numbers.
- Alert email links carry only the call id. Opening one still requires login and the tenant check; no tokens in URLs.
- Writes are rate-limited like today's sensitive routes. No new public endpoints.
- Security headers on the dashboard: a content security policy, no framing, HTTPS only. Confirm what is set today.
- Dependencies checked for known vulnerabilities before each deploy; high-severity ones fixed.
- No secrets in the frontend bundle or the public repo; no client data in code, fixtures or docs.
- Stage 7 runs a security review of the full change set, with extra attention on sign-in, tenant isolation and the
  export.

**Compliance, unchanged this round**: UK GDPR basics (login, each business sees only its own data, access logging,
the call notice setting). Larger items stay separate decisions: a data retention and deletion policy, and anything
for US healthcare (no BAA today).

## 11. Verification

- Unit tests for each new endpoint, including tenant scoping. Frontend tests for routing, the handled flow, the unsaved
  changes guard, and that outbound-only packs never render on an inbound business.
- The stage 0 tripwire stays in CI, so a setting added later without being wired to calls fails the build.
- A browser pass on desktop and phone sizes per stage; `impeccable detect` on changed files; the Impeccable finish
  review and a `DESIGN.md` written from the shipped result at the end.
- One real test call after the Voice agent tab ships, changing a setting and reading the result in the Inbox.

## 12. Later

The "Questions it couldn't answer" card; Quotes for businesses that need it (switch on per business); several alert addresses; integrations tab with GoHighLevel first, together with saving the information the agent collects on the call record
and turning message questions into a fixed list (both decided to go with the GoHighLevel work); "send every call to a
web address" as a self-serve option; a guided builder for custom actions; editing bookings from the Calendar; staff
logins; billing; texts to callers; a phone app with push.

## 13. Calls made while writing this up

Settled by the author after the builder check, for the owner to check while reading:

- Calls show only actions that are recorded. Moves and cancellations get recorded in stage 6 (owner asked for them);
  until then they appear only in the summary text.
- "Nothing for you to do" only after a booking, a booking change or a transfer; otherwise "No message was left."
- Cancelled bookings stay visible on the Calendar, struck through.
- Quotes hidden by a generic opt-in rule, so it can return for one business without code.
- First deploy after stage 3; old Calendar and Settings run inside the new shell until replaced.
- One alert address, as stored today; several addresses move to Later.
- Calendar only for businesses whose bookings live in VetraTD's own calendar; business timezone throughout.
- Outbound-only and text packs hidden by a new pack property, not by id.
- Call trends reached from Home and Settings > Usage, not a sixth tab; CSV download in the Inbox; Email me bookings in
  the Calendar; the status, sentiment and direction filters dropped.

## 14. Left to the builder

Component structure, state management, how the shell hosts not-yet-rebuilt pages, the exact column and pack properties
used for "handled" and for inbound filtering, the redirect for old email links, and loading, error and offline states
(each must say what happened and what to do).
