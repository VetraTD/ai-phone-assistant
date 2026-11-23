# Dashboard overhaul, part 2 (stages 4–7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the last old pages (Calendar, Settings, Call trends), record booking moves and cancellations against the call that made them, link alert emails to the call, then review everything and ship.

**Architecture:** Part 1 shipped the shell, Home, Inbox and Voice agent. This part builds on that code (`feat/dashboard-overhaul`, `732bc02`; live as `dashboard:d50c9b0`).
- **Dashboard pages:** Calendar, Settings and Call trends become pages in `frontend/src/pages/`, and the `legacy/` hosts are deleted.
- **Voice engine:** One change, in one deploy. The internal booking adapter writes a change row whenever a call moves or cancels a booking. Alert emails link to `/inbox/<call id>`.
- **Dashboard backend:** Reads the change rows. The Calendar's date range uses the business's timezone.

**Tech Stack:** As in part 1.
- **Frontend:** React 19, react-router-dom 7 data router, Vite 7, vitest 4 + testing-library.
- **Backend:** Express 5 (CommonJS), `pg`, supertest.
- **Voice engine:** ESM, `services/db.js`.
- **Database:** Postgres 16 with FORCE row-level security. Real-database tests run through `npm run test:db`.

**Spec:** `docs/superpowers/specs/2026-11-22-dashboard-overhaul-design.md`. It wins over this plan. The stages are in §6, the screens in §8, the backend in §9 and security in §10a. Product context: `PRODUCT.md`.

**Already shipped in part 1, so not rebuilt here:** the Inbox's "Download calls (CSV)" and Home's "See call trends" link.

**Scope:** Part 2 of 2: stages 4–7, about 12–19 h. That figure does not include the owner's design notes (Task 10), which are sized once they arrive.

## Global Constraints

Everything in part 1's Global Constraints still applies (`docs/superpowers/plans/2026-11-22-dashboard-overhaul-part-1.md`, lines 28–65). In short:
- **Interface:** UK English and WCAG 2.2 AA, with 44 px targets and 16 px phone text. The palette and fonts are the ones in part 1.
- **Words:** the interface never uses "capabilities", "webhook", "intake", "says/knows/does" or "receptionist".
- **Code:** no capability-id literals in the dashboard, and no per-client branches.
- **Every new or changed endpoint:**
  - uses `authenticate` + `withTenantHandler`;
  - is listed in `backend/src/phiAudit.js`;
  - has a test that business A can't reach business B's rows.
- **Text:** caller and AI text are rendered as text. `tel:` links come only from `telHref()`.
- **Public repo:** no client data. Fixtures use synthetic Brightwork and `+1555…` numbers. Never commit `.superpowers/`.
- **Process:** commit per task on `feat/dashboard-overhaul`. Never push or deploy without asking the owner, and ask before spending API money.

New for part 2:
- **Dates:**
  - Business timezone everywhere: Calendar days, "today", the email ranges and "this month".
  - The week starts on Monday.
  - The desktop grid runs Monday–Saturday, 08:00–18:00 (spec §8).
- **The voice engine's tenant filter is unconditional.** Every new `services/db.js` function:
  - refuses to run without `businessId`;
  - calls `noteAccess(...)`;
  - has an entry in `lib/phiAudit.js`.
- **Prompt snapshots must not change.** Stage 6 touches booking writes and email text, never the prompt. If a snapshot changes, stop and tell the owner.
- **Low memory:**
  - Run vitest files one process at a time.
  - Run the full root suite in a mintty window with a log file. In part 1 this was `.superpowers/sdd/2026-11-22-dashboard-overhaul-part-1/root-suite.sh`; copy it into this plan's workspace.
  - If a background server is stopped for memory, tell the owner and don't restart it on your own.
- **Local data:** a full `npm run test:db` deletes `+1555…` test businesses. The local Brightwork business uses `+447700900555` for that reason. Re-seed it if it is gone (part 1 ledger, "Local-only lesson").
- **Browser checks need a local sign-in.** The part 1 test login was deleted on 2026-11-23. At Gate A, ask the owner to approve re-creating it on the same terms, or to sign in themselves.

## Review Focus

1. **Bookings outside the grid** (Sunday, before 8 am, at or after 6 pm) must stay visible, never silently dropped. Task 2 (`gridSlot` returns null) and Task 3 ("Outside these hours" list).
2. **A week that crosses a clock change.** Positions and "today" must stay right in both Europe/London and America/Chicago. Task 2 tests 25 Oct (UK) and 1 Nov (US).
3. **Several changes on one call.** A booking moved twice, or moved then cancelled, gives one row per change, in order. The Calendar shows the latest. Task 7 (database) and Task 9 (Inbox list).
4. **An alert for a call whose id is unknown** (missed call, `null`, `undefined`, a Twilio SID). The email keeps the bare address. It must never say `/inbox/undefined`. Task 8.
5. **"Email me bookings" with no alert address, or with mail not configured.** The message says what to do and links to Settings > Email alerts. Nothing is sent. Task 3.

---

## Stage 4: Calendar (≈ 3–5 h)

### Task 1: Bookings by date range, in the business's timezone (1–1.5 h)

Today `GET /api/appointments` and `POST /api/appointments/email` compare `scheduled_at::date` with `CURRENT_DATE`, which is the database's day (UTC). The email count also scopes through `calls.business_id` and counts cancelled bookings.

**Files:**
- Modify: `AI-phone-dashboard/backend/src/routes/appointments.js`
- Create: `tests/db/dashboardAppointments.test.js`

**Interfaces:**
- Produces:
  - `GET /api/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD`, inclusive days in the business timezone, returning `[{ id, call_id, client_name, client_phone, scheduled_at, status, notes }]` ordered by `scheduled_at`.
  - Without `from`/`to`, the old `range=today|7days|upcoming` still works, now in the business timezone.
  - Bad input returns `400 { error: "Choose a date range of up to six weeks." }`. Bad input means: a non-date, `from > to`, more than 42 days, or only one of the two.
- Produces: `POST /api/appointments/email`. Same body, same response. Its count is `appointments.business_id = $1`, `status IS DISTINCT FROM 'cancelled'`, in business-timezone days.

- [ ] **Step 1: Write the failing database tests.** Model the setup on `tests/db/dashboardHome.test.js`: `bootApp()` with the fake `authenticate`, two tenants, the business timezone `America/Chicago`. Also replace `services/mailer.js` in `require.cache` with `{ isConfigured: () => true, sendMail: vi.fn() }`.
  - `it("returns bookings in the business's days, not the database's")`: a booking at 23:30 Chicago on `to` is included; one at 00:10 Chicago the next day is not.
  - `it("never returns another business's bookings")`: tenant B's booking in the same range is absent.
  - `it("rejects a range it cannot serve")`: each of these returns 400 with the message above:
    - `from=2026-13-01&to=2026-13-02`;
    - `from=2026-11-30&to=2026-11-23`;
    - `from=2026-11-01&to=2026-12-13` (43 days);
    - `from=2026-11-23` alone.
  - `it("counts only this business's live bookings in its own today")`:
    - setup: two scheduled bookings today (Chicago), one cancelled today, one tenant-B booking today, and one booked at 23:30 UTC that is still today in Chicago;
    - expect: `{ success: true, count: 3 }`, and `sendMail` called once to the alert address.
- [ ] **Step 2: Run** `npx vitest run tests/db/dashboardAppointments.test.js` with `DATABASE_URL` from part 1's `gate.sh`. Expected: the four new tests fail. Check the summary shows them; they don't skip.
- [ ] **Step 3: Implement it in `routes/appointments.js`.**
  - Read the business timezone the way `routes/home.js` does.
  - Build the bounds with a single helper, `dayBounds({ from, to, range })`, returning `{ sql, params }` and shared by both routes. The lower bound is `($n::date::timestamp AT TIME ZONE $tz)`; the upper bound is the same expression on `to` + 1 day.
  - `upcoming` means from the start of today, with no upper bound.
- [ ] **Step 4: Run it again.** Expected: PASS. Then run `npx vitest run` in `AI-phone-dashboard/backend`. Expected: all pass. `LegacyAppointments` still calls `?range=` and keeps working.
- [ ] **Step 5: Commit** `fix(dashboard-api): bookings and the bookings email use the business's days`.

### Task 2: Calendar week maths (0.5–1 h)

**Files:**
- Create: `AI-phone-dashboard/frontend/src/pages/calendar/week.js`
- Create: `AI-phone-dashboard/frontend/src/pages/calendar/__tests__/week.test.js`

**Interfaces:**
- Consumes: `localDay(iso, tz)` from `src/calls/format.js`.
- Produces (all days are `"YYYY-MM-DD"` strings; pure functions with no `Date` in local time):
  - `GRID_START_MIN = 480`, `GRID_END_MIN = 1080`;
  - `addDays(day, n) → day`;
  - `mondayOf(day) → day`;
  - `weekDays(monday, count = 6) → day[]`;
  - `todayIn(tz, now = new Date()) → day`;
  - `placeBooking(iso, tz) → { day, minutes }`, where `minutes` is minutes since local midnight;
  - `gridSlot({ day, minutes }, days) → { col, top } | null`. `col` is an index into `days`, `top = (minutes − 480) / 600`, and the result is null when `day` is not in `days` or `minutes < 480 || minutes >= 1080`;
  - `isValidDay(s) → boolean`.

- [ ] **Step 1: Write the failing tests.**
  - `mondayOf("2026-11-29") === "2026-11-23"` (a Sunday), and `mondayOf("2026-11-23") === "2026-11-23"`.
  - `weekDays("2026-11-23")` equals `["2026-11-23", …, "2026-11-28"]`, and `weekDays("2026-11-23", 7)` ends `"2026-11-29"`.
  - `addDays("2026-12-31", 1) === "2027-01-01"`.
  - `placeBooking("2026-11-24T15:00:00Z", "America/Chicago")` equals `{ day: "2026-11-24", minutes: 540 }`.
  - **UK clock change:**
    - `placeBooking("2026-10-23T08:00:00Z", "Europe/London").minutes === 540` (BST);
    - `placeBooking("2026-10-26T09:00:00Z", "Europe/London").minutes === 540` (GMT).
  - **US clock change:**
    - `placeBooking("2026-10-30T14:00:00Z", "America/Chicago").minutes === 540` (CDT);
    - `placeBooking("2026-11-02T15:00:00Z", "America/Chicago").minutes === 540` (CST).
  - `gridSlot` returns null:
    - at 07:30 (minutes 450);
    - at exactly 18:00 (1080);
    - for Sunday `"2026-11-29"` against `weekDays("2026-11-23")`.
  - `gridSlot` at 13:00 (780) on Tuesday returns `{ col: 1, top: 0.5 }`.
  - `todayIn("America/Chicago", new Date("2026-11-24T05:30:00Z")) === "2026-11-23"`.
  - `isValidDay("2026-02-30") === false` and `isValidDay("2026-02-28") === true`.
- [ ] **Step 2: Run** `npx vitest run src/pages/calendar/__tests__/week.test.js` in `frontend`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement `week.js`.** Do the day arithmetic in UTC on `Date.UTC(y, m - 1, d)`. Read local minutes with `Intl.DateTimeFormat(…, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })`.
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): calendar week maths in the business's timezone`.

### Task 3: The Calendar page (1.5–2.5 h)

**Files:**
- Create: `AI-phone-dashboard/frontend/src/pages/Calendar.jsx`
- Create: `AI-phone-dashboard/frontend/src/pages/calendar/BookingDetail.jsx`
- Create: `AI-phone-dashboard/frontend/src/pages/calendar/calendar.css`
- Modify: `AI-phone-dashboard/frontend/src/routes.jsx`, so `/calendar` renders `<CalendarRoute><Calendar /></CalendarRoute>`
- Create: `AI-phone-dashboard/frontend/src/pages/__tests__/Calendar.test.jsx`

**Interfaces:**
- Consumes:
  - from Task 1: `GET /api/appointments?from&to`, `POST /api/appointments/email { range }`;
  - from Task 2: everything in `week.js`;
  - `formatTime`, `formatDate`, `formatDateTime`, `telHref` from `calls/format.js`;
  - `useBusiness()` (`business.timezone`, `business.notification_email`);
  - `useAutoRefresh(refresh)`.
- Produces: the URL `/calendar?date=YYYY-MM-DD`, which part 1's `CallView` already links to. A missing or invalid `date` means today in the business timezone.
- Produces: `BookingDetail({ booking, tz, onClose })`. Task 9 adds change lines to it.

**Behaviour (spec §8 Calendar):**
- **Header:**
  - The title is "Calendar" and the week label reads, for example, "23–28 November 2026".
  - Buttons: Previous week, Today, Next week. Each sets `?date` ±7 days or today, with a router push so Back works.
  - "Email me bookings" sits beside a select: Today / Next 7 days / Upcoming.
- **Data:** a single request, `from = mondayOf(date)`, `to = addDays(monday, 6)` (Monday–Sunday), so Sunday bookings are known.
- **Desktop (container wider than 760 px):** a six-column grid, Monday–Saturday.
  - Hour lines run from 8 am to 6 pm.
  - A "now" line shows when today is in the week and the time is inside the grid.
  - Each booking is a `<button>` placed with `gridSlot`. Its accessible name is `"{time}, {client_name || 'Caller'}"`, with `", cancelled"` added when cancelled.
- **Phone:** a seven-day strip (Monday–Sunday, so every booking is reachable) and the list for the chosen day, which is `?date`.
- **Outside these hours:** under the desktop grid, a list of bookings whose `gridSlot` is null, in time order, headed "Outside 8 am–6 pm". It is hidden when empty.
- **Cancelled bookings:** they stay in place, with class `vt-cal-cancelled` (line-through and hatch) and the visible word "Cancelled". Colour is never the only signal.
- **Detail** (a popover on desktop, a panel on phone; closed with Escape, focus returns to the booking):
  - when (`formatDateTime`), name, number (a `tel:` link from `telHref`, or the number as text if there is no link), and `notes` as its own line;
  - "Booked by VetraTD on a call", with "Open the call" → `/inbox/{call_id}` when there is a `call_id`.
- **Email me bookings:**
  - **No `notification_email`:** "Add an alert email first." with a link to `/settings/alerts`. No POST is sent.
  - **Success:** "Sent to {email}. It says how many bookings there are; the details stay here."
  - **Failure:** the server's `error`, or "Couldn't send the email. Try again in a minute."
- **States:**
  - loading: "Loading your bookings…";
  - error: "Couldn't load your bookings. Check your connection, then try again." with a Try again button;
  - empty week: "No bookings this week."

- [ ] **Step 1: Write the failing tests.** Mock `api` and `useBusiness` the way `src/pages/__tests__/Home.test.jsx` does, with `createMemoryRouter`, `tz = "America/Chicago"` and synthetic Brightwork rows.
  - `it("opens the week of ?date and asks for Monday to Sunday")`: with `?date=2026-11-25`, `api.get` is called with `("/api/appointments", { params: { from: "2026-11-23", to: "2026-11-29" } })`.
  - `it("falls back to this week for a missing or broken date")`: with `?date=2026-02-30`, the request covers the current week. Fake the clock with `vi.setSystemTime`.
  - `it("lists a 7 pm booking under Outside 8 am–6 pm instead of dropping it")`.
  - `it("keeps a cancelled booking, struck through and labelled")`: the booking has class `vt-cal-cancelled` and the text "Cancelled".
  - `it("shows who, when and a link to the call that booked it")`: clicking the booking opens the detail; its link `href` is `/inbox/c1`.
  - `it("Next week moves the date by seven days")`: the router location becomes `?date=2026-12-02`.
  - `it("asks for an alert address before emailing bookings")`: with an empty `notification_email`, the link goes to `/settings/alerts` and `api.post` is not called.
  - `it("emails the chosen range")`: choose "Next 7 days" and click; `api.post` is called with `("/api/appointments/email", { range: "7days" })` and a status line reads "Sent to …".
  - `it("shows the server's reason when email isn't set up")`: `api.post` rejects with `{ response: { data: { error: "Email sending is not configured on the server." } } }`, and that text is shown.
  - `it("says what happened when bookings fail to load")`: shows the error text, and Try again calls `api.get` again.
  - `it("shows a name that looks like HTML as text")`: `client_name: "<b>Sam</b>"` renders literally.
- [ ] **Step 2: Run** `npx vitest run src/pages/__tests__/Calendar.test.jsx`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement** `Calendar.jsx`, `BookingDetail.jsx` and `calendar.css`. Use part 1's tokens (`shell/tokens.css`) and its state styles (`shell/states.css`). Swap the route in `routes.jsx`. Leave `LegacyAppointments.jsx` on disk; Task 6 deletes it.
- [ ] **Step 4: Run it again.** Expected: PASS. Then run the full frontend suite, `npx vitest run`, and eslint on `src/pages`. Expected: all pass and 0 errors.
- [ ] **Step 5: Commit** `feat(dashboard): Calendar week view with Email me bookings`.

---

## Stage 5: Settings and Call trends (≈ 3–5 h)

### Task 4: The Settings page (1.5–2 h)

**Files:**
- Create: `AI-phone-dashboard/frontend/src/pages/Settings.jsx`
- Create: `AI-phone-dashboard/frontend/src/pages/settings/items.js`
- Create: `AI-phone-dashboard/frontend/src/shell/DraftSaveBar.jsx`, extracted from the save bar in `pages/VoiceAgent.jsx` lines 245–260, which then uses it.
- Modify: `routes.jsx`, so `/settings` and `/settings/:item` render `Settings`.
- Modify: `AI-phone-dashboard/backend/src/routes/analytics.js`. `/api/usage` counts the month in the business timezone.
- Create: `AI-phone-dashboard/frontend/src/pages/__tests__/Settings.test.jsx`
- Create: `tests/db/dashboardUsage.test.js`

**Interfaces:**
- Consumes:
  - `useBusinessDraft`;
  - `NotificationsSection` (`settings/NotificationsSection.jsx`, unchanged; rendered inside `<div className="set-root">`);
  - `useUnsavedChangesGuard`;
  - `formatPhone`;
  - `currentUser()`, `sendPasswordReset(email, { continueUrl })` and `signOut()` from `auth.js`;
  - `GET /api/usage → { calls_this_month, minutes_this_month }`.
- Produces:
  - `SETTINGS_ITEMS = [{ id: "alerts", label: "Email alerts" }, { id: "number", label: "Your number" }, { id: "login", label: "Your login" }, { id: "usage", label: "Usage" }, { id: "help", label: "Help" }]`;
  - `DraftSaveBar({ message, dirty, saving, onSave, onDiscard })`, which renders the same markup and roles as part 1's Voice agent bar.

**Behaviour (spec §8 Settings):**
- **Layout:** the Voice agent's list-and-panel layout, reusing its classes from `voice-agent.css`.
  - Desktop: `/settings` opens Email alerts.
  - Phone: `/settings` shows the list, and an item opens on its own screen.
  - Sign out sits at the foot of the list.
- **Email alerts:** the address and the on/off switch, with the draft, save bar and leave guard.
- **Your number:**
  - The formatted number, with Copy number.
  - Text: "Callers reach VetraTD on this number. If your own business number forwards here, calls ring through the way we set up together. To change how calls reach us, message us." "message us" links to `/contact`.
  - No claims about forwarding settings the dashboard can't see.
- **Your login:**
  - Shows the signed-in email and a button: "Email me a link to change my password".
  - Success: "We've sent a link to {email}. Open it to choose a new password."
  - Failure: "Couldn't send the link. Try again in a minute."
- **Usage:**
  - Minutes used and calls answered this month, with "Counts from the 1st, in your business's time zone."
  - A link: "See call trends" → `/trends`.
- **Help:** three plain sentences on how VetraTD works (answers, takes messages, books where switched on; alert email after a call that needs you; changes apply from the next call) and "Message us" → `/contact`.
- **Never shown:** billing, plan or team panels.

- [ ] **Step 1: Write the failing frontend tests.**
  - `it("lists the five items and opens Email alerts by default")`.
  - `it("saves only the alert address")`: after changing the email and pressing Save, `api.put` is called with `("/api/business/b1/settings", { notification_email: "new@brightwork.example" })`.
  - `it("asks before leaving with an unsaved address")`: navigating to `/home` shows the leave dialog.
  - `it("sends the password link to the signed-in email")`: `sendPasswordReset` is called with `"owner@brightwork.example"`.
  - `it("shows this month's usage and links to call trends")`.
  - `it("has no billing, plan or team panel")`: `queryByText(/billing|plan|team/i)` is null.
  - `it("signs out")`: `signOut` is called.
  - A Voice agent test still passes against `DraftSaveBar`. Rerun `VoiceAgent.test.jsx` unchanged.
- [ ] **Step 2: Write the failing database test:** `it("counts the month in the business's time zone")`. The business is `America/Chicago`.
  - Seed two calls: one 30 min after and one 30 min before `date_trunc('month', now() AT TIME ZONE 'America/Chicago') AT TIME ZONE 'America/Chicago'`.
  - Expect `calls_this_month === 1`.
  - Add a tenant-B call in the month and check it is not counted.
- [ ] **Step 3: Run both files.** Expected: FAIL.
- [ ] **Step 4: Implement** `Settings.jsx`, `items.js` and `DraftSaveBar.jsx`, with the VoiceAgent switch-over, and update the usage query: month bounds `date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2` and the same plus 1 month.
- [ ] **Step 5: Run** both files, then the full frontend and backend suites. Expected: PASS.
- [ ] **Step 6: Commit** `feat(dashboard): Settings page; usage counts the business's month`.

### Task 5: Call trends, restyled in place (1–1.5 h)

**Files:**
- Create: `AI-phone-dashboard/frontend/src/pages/Trends.jsx`, a copy of `legacy/LegacyTrends.jsx` restyled.
- Create: `AI-phone-dashboard/frontend/src/pages/trends.css`
- Modify: `routes.jsx`, so `/trends` renders `Trends`.
- Create: `AI-phone-dashboard/frontend/src/pages/__tests__/Trends.test.jsx`

**Interfaces:**
- Consumes: `GET /api/analytics-breakdown?period=7d|30d|90d`, unchanged. It is the page's only data call today.
- Produces: no new interface.

**Rules:**
- Load the `dataviz` skill before touching a chart.
- Same charts, same data, same periods. Not a redesign (spec §6 stage 5).
- Use part 1 tokens. Drop `Dashboard.css` and `legacy/strings.js`.
- Add a back link: "← Home".
- Real data only. With no calls in the period: "No calls in this period yet."
- Never say "receptionist".

- [ ] **Step 1: Write the failing tests.**
  - `it("shows the period's totals from the server")`.
  - `it("asks again when the period changes")`: `period: "30d"`.
  - `it("says so when there are no calls")`.
  - `it("says what happened when trends fail to load")`.
  - `it("never says receptionist")`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and the full frontend suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): Call trends in the new style`.

### Task 6: Remove the old pages (0.5–1 h; a cheaper model, like part 1's Task 7)

**Files:**
- Delete:
  - `frontend/src/legacy/` (all four files);
  - `settings/SettingsPage.jsx`, `settings/SettingsNav.jsx`, `settings/groups.js`, `settings/AccountSection.jsx`;
  - `settings/SaveBar.jsx` and `Dashboard.css`, but only if `grep` finds no importer;
  - their tests, including `settings/__tests__/settingsHistory.test.jsx`.
- Keep: everything the Voice agent imports from `settings/`, including `Settings.css`, `useBusinessDraft.js` and the section components.
- Modify: `routes.jsx`, which drops the legacy imports.

- [ ] **Step 1: Write the failing test** in `src/__tests__/routes.test.jsx`: `it("serves the new pages at /calendar, /settings/alerts and /trends")`, asserting each page's heading. Also `it("no source file imports from legacy/")`: read `src/**/*.{js,jsx}` (excluding tests) with `fs` and assert no `/legacy\//` import.
- [ ] **Step 2: Run.** Expected: the import test fails.
- [ ] **Step 3: Delete the files.**
- [ ] **Step 4: Run** the full frontend suite, `npx vite build` with `VITE_BUILD_TARGET=app VETRA_LOCAL_BUILD=1`, and eslint. Expected: all green, the build passes, 0 errors. Paste the vitest summary and `git diff --stat` into the report.
- [ ] **Step 5: Commit** `refactor(dashboard): remove the old Calendar, Settings and trends pages`.

### Gate A (after Task 6)

- **Suites:** run, one at a time:
  - frontend full;
  - backend full;
  - `tests/db/dashboardAppointments.test.js`, `tests/db/dashboardUsage.test.js` and `tests/db/dashboardHome.test.js`.
- **Checks:** `npm audit --omit=dev` in frontend and backend, and `impeccable detect` on the changed files.
- **Browser:** desktop 1280×800 and phone 390×844, covering:
  - Calendar: week, outside-hours list, detail, Email me bookings with the mailer unset locally, so the error path is visible;
  - Settings: all five items;
  - Trends.
  - This needs a local sign-in; ask the owner first (see Global Constraints).
- **Review:** one fresh reviewer (sonnet), using `review-package` on Task 1's BASE..HEAD. Fix every finding in one pass, each RED→GREEN.
- **Owner update:** done, hours vs 6–10 h, and anything needing them.

---

## Stage 6: Booking changes and email links, one voice deploy (≈ 4–6 h)

### Task 7: Record moves and cancellations against the call (2 h)

**Files:**
- Create: `database/062_appointment_changes.sql`. Also add the table to `database/schema.sql`.
- Modify:
  - `services/db.js`: add two functions next to `updateAppointment`;
  - `services/tools.js`: deps getters;
  - `lib/harness/fakeDeps.js`;
  - `lib/phiAudit.js`;
  - `adapters/scheduling/internal.js`: `cancel` and `reschedule`.
- Create: `tests/db/appointmentChanges.test.js`
- Modify:
  - `tests/schedulingAdapters.test.js`;
  - `tests/db/outboundExport.test.js`: classify the new table.

**Interfaces:**
- Produces, in `services/db.js`:
  - `rescheduleAppointmentRecorded(appointmentId, newScheduledAt, businessId, callId) → Promise<boolean>`;
  - `cancelAppointmentRecorded(appointmentId, businessId, callId) → Promise<boolean>`.
  - Each returns `true` when the booking row exists for that business and was updated, like the functions they replace.
  - Each refuses to run without `businessId` (logs `db_unscoped_query_refused`, returns `false`).
- Produces: the table `appointment_changes(id, business_id, appointment_id, call_id, kind, old_scheduled_at, new_scheduled_at, created_at)`. Task 9 reads it.
- Unchanged: `updateAppointment` and `updateAppointmentStatus` stay, because name and note edits and `scripts/close-stale-appointments.js` use them.

**Migration 062**, in the style of 061 (`SET LOCAL lock_timeout = '5s'`):
- **Columns:**
  - `id uuid PK default gen_random_uuid()`;
  - `business_id uuid NOT NULL → businesses ON DELETE CASCADE`;
  - `appointment_id uuid NOT NULL → appointments ON DELETE CASCADE`;
  - `call_id uuid → calls ON DELETE SET NULL`;
  - `kind text NOT NULL CHECK (kind IN ('moved','cancelled'))`;
  - `old_scheduled_at timestamptz NOT NULL`;
  - `new_scheduled_at timestamptz`;
  - `created_at timestamptz NOT NULL DEFAULT now()`;
  - `CHECK ((kind = 'moved') = (new_scheduled_at IS NOT NULL))`.
- **Indexes:** `(business_id, created_at)`, `(appointment_id)`, `(call_id)`.
- **Row-level security:** `ENABLE` + `FORCE`, and policy `tenant_isolation` with `USING` and `WITH CHECK` `business_id = app_current_business_id()`.
- **Grants:** `GRANT SELECT, INSERT ON appointment_changes TO vetra_app`. The table is append-only: no UPDATE or DELETE grant.

**The write is one statement,** so a change row exists only if the booking really changed:

```sql
-- reschedule ($1 id, $2 business, $3 new time, $4 call)
WITH old AS (
  SELECT id, scheduled_at FROM appointments WHERE id = $1 AND business_id = $2 FOR UPDATE
), upd AS (
  UPDATE appointments a SET scheduled_at = $3 FROM old WHERE a.id = old.id
  RETURNING a.id, old.scheduled_at AS old_at
)
INSERT INTO appointment_changes (business_id, appointment_id, call_id, kind, old_scheduled_at, new_scheduled_at)
SELECT $2, id, $4, 'moved', old_at, $3 FROM upd
RETURNING appointment_id;
```

- **Cancel:** the same shape, with `SET status = 'cancelled'`. Insert the change row only `WHERE old.status IS DISTINCT FROM 'cancelled'`, so cancelling twice records once. Return `true` when `old` found the row.
- **Internal adapter:**
  - `cancel` calls `ctx.deps.cancelAppointmentRecorded(appointmentId, ctx.businessId, ctx.callId || null)`;
  - `reschedule` calls `ctx.deps.rescheduleAppointmentRecorded(appointmentId, newScheduledAt, ctx.businessId, ctx.callId || null)`.
- **Out of scope:** other adapters (outside systems) record nothing. Their bookings aren't in VetraTD's calendar.

- [ ] **Step 1: Write the failing database tests.** Find the existing `tests/db` file that exercises `createAppointmentIfAvailable` under the app role (`tests/db/outboundBooking.test.js`) and copy its tenant setup.
  - `it("a move records the old and new time against the call")`.
  - `it("a cancel records the old time once; cancelling again records nothing")`.
  - `it("moved then cancelled on one call leaves two rows in order")`.
  - `it("another business's booking is neither changed nor recorded")`: `false`, the row is unchanged, 0 change rows.
  - `it("an unknown booking writes no change row")`.
  - `it("business B cannot read business A's changes")`: an RLS read as tenant B returns 0 rows.
  - `it("refuses to run unscoped")`: with no `businessId`, `false`, and no query.
- [ ] **Step 2: Add the adapter unit test** in `tests/schedulingAdapters.test.js`: `it("internal adapter passes the call id when it moves or cancels")`, asserting the fake deps received `ctx.callId`.
- [ ] **Step 3: Run both.** Expected: FAIL, because the table and functions are missing.
- [ ] **Step 4: Implement** the migration, the schema, the functions, the deps, `fakeDeps`, `phiAudit` (`{ action: "write", resources: ["appointments", "appointment_changes"] }`) and the adapter.
- [ ] **Step 5: Classify the table in the export guard.** Run `tests/db/outboundExport.test.js`. If the drift guard flags `appointment_changes`, export it with the caller's appointments, since it is booking history. Erasure needs nothing extra: it cascades with the appointment.
- [ ] **Step 6: Run** the two test files. Then run the full root suite in mintty and `npm run test:db` (re-seed local Brightwork after). Expected: green, and the prompt snapshots are unchanged.
- [ ] **Step 7: Commit** `feat(voice): record booking moves and cancellations against the call`.

### Task 8: Alert emails link to the call (1–1.5 h)

The live voice service has `DASHBOARD_URL=https://vetra-core-edc8ca.web.app/app`. Links are built from its **origin**; never append to the path, or the result is `/app/inbox/…`, which is a 404.

**Files:**
- Modify: `services/notifications.js`.
- Modify the callers:
  - `capabilities/appointments.js` (`notifyAppointmentBooked`, pass `call_id: ctx.callId`);
  - `capabilities/messages.js` (`callId: engine.call.callId`);
  - `capabilities/quotes.js`;
  - `lib/degradedVoicemail.js`;
  - `lib/voice/session.js` (`state.dbCallId`);
  - `lib/postCallVerify.js` (its `callId`).
  - `lib/ownerNotices.js` needs nothing: its rows carry `call_id`.
- Create: `tests/notifications.callLink.test.js`
- Modify: `tests/notifications.phi.test.js`

**Interfaces:**
- Produces: `export function dashboardLink(callId) → string | null`.
  - `null` when `DASHBOARD_URL` is unset.
  - `new URL("/inbox/" + callId, DASHBOARD_URL).href` when `callId` matches `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`.
  - Otherwise `DASHBOARD_URL` as today.
- Changes, with optional new last arguments: `dashboardLine(callId)`, `ownerEmailBody(businessName, sentence, callId)` and `ownerSmsBody(businessName, sentence, callId)`.
- Changes:
  - `notifyUnconfirmedClaim({ …, callId })` and `notifyCustomerRequest({ …, callId })`;
  - `notifyAppointmentBooked` reads `appointment.call_id`;
  - `renderCallRequestsEmail({ …, rows })` uses `rows[0].call_id`.
- Unchanged: `notifyCallMissed`. The status callback knows only the Twilio SID, so the missed-call email keeps the bare address, which opens Home.

- [ ] **Step 1: Write the failing tests.** Set `DASHBOARD_URL` before importing the module, as `notifications.phi.test.js` does.
  - `it("links to the call on the dashboard's origin")`: with `DASHBOARD_URL = "https://vetra-core-edc8ca.web.app/app"`, `dashboardLink("1c2021e1-f44f-4066-8d8d-86cd089d8e04")` returns `"https://vetra-core-edc8ca.web.app/inbox/1c2021e1-f44f-4066-8d8d-86cd089d8e04"`.
  - `it("keeps the bare address when the call is unknown")`: for `null`, `undefined`, `"undefined"` and `"CA0123456789abcdef"`, the result equals `DASHBOARD_URL`.
  - `it("each owner email carries its call's link")`: one case each for booked, customer request, unconfirmed claim and call requests. The `sendEmail` text contains `/inbox/<id>`.
  - `it("the link carries the call id and nothing else")`: the link line matches `/\/inbox\/[0-9a-f-]{36}$/`, with no phone or name.
  - For each caller listed under Files, add one assertion to its existing test file (find it with `grep -l "<function>(" tests`) that it passes the database call id.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** the notification test files, then the full root suite in mintty. Expected: green; prompt snapshots unchanged.
- [ ] **Step 5: Commit** `feat(voice): alert emails link to the call`.

### Task 9: Show booking changes in Inbox, Home and Calendar (1.5–2 h)

**Files:**
- Modify the backend:
  - `AI-phone-dashboard/backend/src/routes/calls.js` (`GET /api/calls/:id`);
  - `routes/appointments.js`;
  - `routes/home.js`;
  - `phiAudit.js`: add `appointment_changes` to those routes' resources.
- Modify the frontend:
  - `src/calls/callStatus.js`;
  - `src/pages/inbox/CallView.jsx`;
  - `src/pages/calendar/BookingDetail.jsx`;
  - `src/pages/Home.jsx`.
- Tests:
  - `tests/db/dashboardHome.test.js`, `tests/db/dashboardAppointments.test.js`, `tests/db/dashboardTenantScoping.test.js`;
  - the frontend `callStatus`, `CallView`, `Calendar` and `Home` tests.

**Interfaces:**
- Consumes: the `appointment_changes` table from Task 7.
- Produces:
  - `GET /api/calls/:id` gains `booking_changes: [{ id, appointment_id, kind, old_scheduled_at, new_scheduled_at, created_at, client_name }]`: this call's changes, oldest first, with the booking's `client_name`.
  - `GET /api/appointments` rows gain `booked_on` (the booking call's `started_at`, or null) and `last_change` (`{ kind, call_id, created_at }` for the newest change, or null).
  - `GET /api/home` gains `week.bookingsMoved` and `week.bookingsCancelled`: changes created since the start of the week, in business time.
  - `statusLine({ call, appointments, requests, changes = [] })`: any change counts like a booking for "Nothing for you to do".
  - `didList({ call, appointments, requests, changes = [], tz })` gains one line per change:
    - `Moved {name}'s booking from {formatDateTime(old)} to {formatDateTime(new)}`;
    - `Cancelled {name}'s booking, {formatDateTime(old)}`;
    - `{name}'s booking` becomes "a booking" when there is no name.
- Calendar detail:
  - `last_change.kind === "moved"`: "Moved here by VetraTD on a call on {date}";
  - `"cancelled"`: "Cancelled by VetraTD on a call on {date}";
  - each with "Open the call" → `/inbox/{call_id}`.
  - The "Booked by" line shows `booked_on`'s date.
- Home week sentence: after the bookings count, add ", {n} moved" and ", {n} cancelled", each only when non-zero.

- [ ] **Step 1: Write the failing tests.**
  - DB: `it("a call's detail lists the bookings it moved and cancelled, oldest first")`.
  - DB: `it("business B's call detail never shows A's changes")`.
  - DB: `it("each booking carries the call that last changed it")`.
  - DB: `it("the week counts moves and cancellations separately from bookings made")`.
  - Frontend:
    - `it("a call that only moved a booking says Nothing for you to do")`;
    - `it("lists a move then a cancel in order")`;
    - `it("the calendar says a booking was moved here, with a link to that call")`;
    - `it("Home's week sentence counts moves and cancellations")`;
    - `it("a change with no client name says a booking")`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run** the touched files, then the full frontend and backend suites and the touched `tests/db` files. Expected: PASS.
- [ ] **Step 5: Commit** `feat(dashboard): show booking moves and cancellations`.

### Gate B (after Task 9)

- **Suites:** the full root suite (mintty), backend, frontend and `npm run test:db`; re-seed local Brightwork after.
- **Prompt snapshots:** confirm they are unchanged.
- **Browser** (desktop and phone): seed a local call that moved one booking and cancelled another, and check the Inbox call view, the Calendar detail and Home.
- **Review:** one fresh reviewer on **opus**, with `review-package` from Task 7's BASE to HEAD. Focus:
  - the atomic write;
  - tenant isolation of the new table;
  - the link builder;
  - which call id each email gets.
  - Fix every finding in one pass.
- **Owner update:** hours vs 4–6 h.

---

## Stage 7: Review and ship (≈ 2–3 h, plus the owner's design notes)

### Task 10: The owner's design notes, the finish review and DESIGN.md

The owner said on 2026-11-23 that they would send their design notes at the very end.

- [ ] **Step 1: Ask the owner for their design notes.** Ask for the page, what looks wrong and what they expected, with screenshots if possible.
- [ ] **Step 2: Sort each note** into "fix now" (small, ships with this deploy), "next round" or "won't do" (with the reason). Ledger the list, and show the owner the hour estimate before starting the "fix now" items.
- [ ] **Step 3: Fix the agreed "fix now" items.** A behaviour change gets a test that fails first. A visual change is checked in the browser at both sizes. Commit each as `fix(dashboard): <what the owner saw>`.
- [ ] **Step 4: Finish review.** Run the Impeccable finish review (agent `impeccable:impeccable-finish-reviewer`) against the shipped pages and the spec §10 look. Fix its material items the same way.
- [ ] **Step 5: Write `AI-phone-dashboard/frontend/DESIGN.md`** from the shipped result (agent `impeccable:impeccable-documenter`). Review it for client data, then commit `docs(dashboard): DESIGN.md from the shipped dashboard`.

### Task 11: Security review of the whole change set (spec §10a)

- [ ] **Step 1: Run every suite:** root (mintty), backend, frontend and `npm run test:db`. Also `npm audit --omit=dev` in frontend and backend; fix high-severity findings.
- [ ] **Step 2: Review.** One fresh reviewer on **opus**, with `review-package` over the whole overhaul: `git merge-base feat/outbound-stage4 HEAD`..HEAD. Extra attention on:
  - sign-in;
  - tenant isolation of every new read and write;
  - the CSV export;
  - email links;
  - the new table's grants;
  - anything that renders caller text.
- [ ] **Step 3: Fix pass.** Fix every finding in one pass, each RED→GREEN, then the suites again. Ledger each fix as `Final: fixed …`.

### Task 12: Deploy, which stops and asks the owner first

- [ ] **Step 1: Gather what ships, read-only:**
  - migration 062;
  - the voice-service commits since the live revision. Find its image tag from the `voice-uk-prod` revision's image digest, then `git log <tag>..HEAD -- services lib capabilities adapters server.js`;
  - the dashboard backend and frontend;
  - whether to set `DASHBOARD_URL=https://app.vetratd.com` on `voice-uk-prod`. This is optional, because links work either way; it only changes which address the emails show.
- [ ] **Step 2: Stop and ask the owner.** Explain plainly:
  - **Calls:** this is the one deploy that changes calls. Booking moves and cancellations get recorded, and alert emails carry a link.
  - **Order:**
    1. migration 062;
    2. the voice service, at a quiet time;
    3. an immediate test call;
    4. the dashboard server;
    5. the website.
  - **Rollback:** move traffic back to the previous voice revision, which takes a minute or two. The table can stay.
  - **Cost:** a few cents of test calls and pennies of builds.
- [ ] **Step 3: After a yes, deploy as in part 1.**
  - Build the voice and migrate image from this checkout with a clean tree (`git status --porcelain --untracked-files=no` empty; migration checksums are CRLF).
  - `migrate.js --status` must show exactly `062_appointment_changes.sql` pending.
  - Then deploy `voice-uk-prod`, then `dashboard-api-uk-prod`, then hosting (`scripts/deploy-hosting.js`).
  - Record each rollback point in the ledger.
- [ ] **Step 4: Verify.** The owner calls the test line, books, moves the booking, then cancels it. Then check:
  - the alert email's link opens that call;
  - the Inbox lists "Moved…" and "Cancelled…";
  - the Calendar shows the booking struck through, with "Cancelled by VetraTD on a call";
  - Home's week sentence counts it.
- [ ] **Step 5: Record it.**
  - Add a readiness line for part 2 in `docs/readiness.md` and commit `docs: dashboard part 2 live`.
  - Update memory `dashboard-overhaul-2026-11`.
  - Delete the local test login if it was re-created.
