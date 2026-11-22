# Dashboard overhaul, part 1 (stages 0–3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the owner dashboard safe and honest. Build the new shell, the Home, Inbox and Voice agent tabs, and ship the first deploy of the new dashboard.

**Architecture:** This is approach B: a new route-based shell inside the existing React/Vite app (`AI-phone-dashboard/frontend`).
- **Pages:** Pages not rebuilt yet (Calendar, Settings, Call trends) render inside the shell until part 2 replaces them.
- **Backend:** The dashboard backend (Express, CommonJS) gains a "handled" state on calls, a Home summary endpoint and Inbox search. Every new route goes through `withTenantHandler`.
- **Voice engine:** Gets label and listing changes only. Nothing changes how a call behaves.

**Tech Stack:**
- **Frontend:** React 19, react-router-dom 7, Vite 7, vitest 4 with @testing-library (jsdom).
- **Backend:** Express 5, `pg`, vitest with supertest.
- **Database:** Postgres 16 with FORCE row-level security. Real-database tests run through `npm run test:db` at the repo root.

**Spec:** `docs/superpowers/specs/2026-11-22-dashboard-overhaul-design.md` (read it first). Product context: `PRODUCT.md`.

**Scope:** This is part 1 of 2, covering stages 0–3 of spec §6 (about 26–34 h).

Part 2 covers stages 4–7: Calendar, Settings, the voice-service change, and the final review and deploy. Part 2 is written after this part ships, against the shell's real interfaces.

**Visual reference:** `.superpowers/brainstorm/28460-1795364952/content/prototype-v1.html`.
- It is a local file, gitignored, and must never be committed.
- Port its CSS custom properties, layouts and glyph sprite.
- Where it disagrees with the spec, the spec wins.

## Global Constraints

**Interface and look**
- UK English in the interface. WCAG 2.2 AA: keyboard operable, visible focus, 44 px touch targets, 16 px minimum body text on phones, and `prefers-reduced-motion` respected.
- **Palette:**
  - navy `#010b29` for the side navigation;
  - ink blue `#0038fd` for primary buttons and the active state;
  - cyan `#00eafe` only for the active navigation icon and the Home count;
  - page `#f2f6ff`.
  - Amber marks "needs you", green marks done. Colour is never the only signal.
- Fraunces only for the Home greeting. Plus Jakarta Sans everywhere else, with tabular figures for times. Both are already self-hosted in `frontend/src/fonts.css`. Never load fonts from a third party.
- Flat surfaces with hairline borders and one radius per element type. No decorative gradients. Shadows only on popovers and dialogs. No icons in coloured circles.
- **Phone layout** at container width ≤ 760 px. The Inbox caller column drops below 1180 px.
- **Words:**
  - The interface never says "capabilities", "webhook", "intake", "says/knows/does" or "receptionist" (it is "Voice agent").
  - Errors say what happened and what to do.

**Code**
- No capability-id literals in the dashboard. Packs are listed or hidden by the pack property `dashboardListing`. Calendar visibility comes from the adapter property `storesBookingsLocally`.
- Generic code, configuration for specifics. No per-client branches.

**Security and data**
- Every new endpoint must:
  - use `authenticate` and `withTenantHandler`;
  - appear in `backend/src/phiAudit.js`, either in `PHI_ROUTES` or in `NON_PHI_ROUTES`;
  - have a test proving business A cannot read or change business B's rows.
- Write endpoints use `authSensitiveLimiter`.
- Caller speech and AI-written text are rendered as text. `dangerouslySetInnerHTML` is never used. `tel:` links come only from `telHref()` (Task 12).
- **No client data anywhere:**
  - No client data, transcripts or call logs in code, fixtures or docs.
  - Fixtures use the synthetic "Brightwork Family Dental" and `+1555…` numbers.
  - Never commit `.superpowers/`.
- Unscoped writes fail closed under RLS. Every write test asserts the row actually changed.

**Process**
- Work on branch `feat/dashboard-overhaul`, cut from `feat/outbound-stage4`.
- Commit per task. **Never push, and never deploy, without asking the owner.**
- Ask before spending API money. Nothing in this plan should.

## Review Focus

These are inputs the spec implies but no feature test would naturally hit. Each has a test in the owning task.

1. **Business timezone vs browser timezone around midnight.** A call at 23:59 business time yesterday must not count as "today", whatever the viewer's clock says. Covered in Task 10 (database test) and Task 12 (formatters take `tz`).
2. **Withheld or missing caller number.** No Call back button, and the name reads "Withheld number". Covered in Tasks 12 and 13.
3. **Two people press Done on the same item.** The first one wins, a repeat is harmless, and Reopen clears it. Covered in Task 9.
4. **Caller speech that looks like HTML or a formula, and very long text.**
   - HTML-looking speech is shown literally on screen.
   - Formula-looking text becomes plain text in the CSV.
   - Long text wraps.
   - Covered in Tasks 1 and 14.
5. **A save that fails (expired session, network).** The draft is kept, the message says what happened, and nothing is lost. Covered in Tasks 16 and 17.

---

## Stage 0: Security and honesty (≈ 5.5–7 h)

### Task 1: Branch, and make the CSV export safe to open in Excel (1 h)

**Files:**
- Modify: `AI-phone-dashboard/frontend/src/callsCsv.js`
- Create: `AI-phone-dashboard/frontend/src/__tests__/callsCsv.test.js`

**Interfaces:**
- Produces: `buildCallsCsv(calls) → string|null` keeps its signature. Every text cell now passes through `neutraliseFormula(str: string) → string`, exported for tests.

- [ ] **Step 0: Branch and commit the design**

```bash
git switch -c feat/dashboard-overhaul feat/outbound-stage4
git add PRODUCT.md docs/superpowers/specs/2026-11-22-dashboard-overhaul-design.md docs/superpowers/plans/2026-11-22-dashboard-overhaul-part-1.md
git commit -m "docs: dashboard overhaul design, product context and part 1 plan"
```

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from "vitest";
import { buildCallsCsv, neutraliseFormula } from "../callsCsv";

const row = (over) => ({ started_at: "2026-11-20T10:00:00Z", caller_number: "+15550100", status: "completed", summary: "", ...over });
const dataLine = (csv) => csv.split("\r\n")[1];

describe("CSV formula guard", () => {
  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
    it(`makes a text cell starting with ${JSON.stringify(lead)} plain text`, () => {
      expect(neutraliseFormula(`${lead}HYPERLINK("http://x")`)).toBe(`'${lead}HYPERLINK("http://x")`);
    });
  }
  it("leaves phone numbers and plain numbers alone", () => {
    for (const v of ["+1 (555) 010-0199", "+15550100", "-3", "42"]) expect(neutraliseFormula(v)).toBe(v);
  });
  it("guards the summary and the caller name in the export", () => {
    const csv = buildCallsCsv([row({ caller_name_guess: "=cmd|' /C calc'!A0", summary: "@SUM(A1)" })]);
    expect(dataLine(csv)).toContain("'=cmd|");
    expect(dataLine(csv)).toContain("'@SUM(A1)");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd AI-phone-dashboard/frontend && npx vitest run src/__tests__/callsCsv.test.js`. Expected: FAIL, because `neutraliseFormula` is not exported.
- [ ] **Step 3: Implement `neutraliseFormula`.**
  - If the cell matches `/^[=+\-@\t\r]/` and does NOT match `/^[+-]?[\d\s().-]+$/`, prefix it with `'`.
  - Call it inside `escapeCsvCell` before quoting.
- [ ] **Step 4: Run it and confirm it passes.** Same command. Expected: PASS.
- [ ] **Step 5: Commit** with message `fix(dashboard): CSV export cannot carry a spreadsheet formula`.

### Task 2: Remove demo mode, the language switcher and the fake billing panel (1.5 h)

**Files:**
- Modify:
  - `AI-phone-dashboard/frontend/src/App.jsx`. Delete `DemoDashboard`, `isDemo`, the `lang` state, `handleLangChange`, `<LanguageSwitcher>`, `settingsPlanName`/`settingsBillingStatus`, and the `ui_lang` localStorage key.
  - `AI-phone-dashboard/frontend/src/LanguageSwitcher.jsx`. Delete the `LanguageSwitcher` component and every non-English dictionary. Keep `useTranslations()` returning the English strings, until `App.jsx` is deleted in Task 14.
  - `AI-phone-dashboard/frontend/src/Landing.jsx:983`. Delete the "Try the guided dashboard demo" link.
  - `AI-phone-dashboard/frontend/src/settings/SettingsPage.jsx:132-133,377-378` and `AI-phone-dashboard/frontend/src/settings/AccountSection.jsx:15-16,50-54`. Remove the `planName`/`billingStatus` props and their rows.
- Create: `AI-phone-dashboard/frontend/src/__tests__/honesty.test.jsx`

- [ ] **Step 1: Write the failing tests**

```jsx
// Mocks: ../auth → onAuthChange(cb) { cb(null); return () => {} }, signOut: vi.fn()
//        ../Login → () => <div>login screen</div>
//        ../api   → { api: { get: vi.fn().mockResolvedValue({ data: { capabilities: [] } }), put: vi.fn() } }
it("?demo=1 shows the sign-in screen, never demo data", async () => {
  window.history.replaceState({}, "", "/?demo=1");
  render(<App />);
  expect(await screen.findByText("login screen")).toBeInTheDocument();
  expect(screen.queryByText(/demo/i)).toBeNull();
});
it("the dashboard has no language picker", async () => {
  const mod = await import("../LanguageSwitcher");
  expect(mod.LanguageSwitcher).toBeUndefined();
});
it("Account shows no plan or billing status", () => {
  render(<AccountSection business={{ name: "Brightwork Family Dental" }} usage={null} />);
  expect(screen.queryByText("Starter")).toBeNull();
  expect(screen.queryByText(/billing status/i)).toBeNull();
});
it("the marketing page no longer links to a demo", () => {
  const src = readFileSync(new URL("../Landing.jsx", import.meta.url), "utf8");
  expect(src).not.toContain("demo=1");
});
```

- [ ] **Step 2: Run and confirm FAIL.** Run `npx vitest run src/__tests__/honesty.test.jsx`.
- [ ] **Step 3: Make the deletions listed under Files.** In `App.jsx`, set `const t = useTranslations();`.
- [ ] **Step 4: Run the whole frontend suite.** Run `npx vitest run`. Expected: all PASS. Update existing tests that referenced the removed props by deleting those assertions, never by re-adding the props.
- [ ] **Step 5: Commit** with message `fix(dashboard): remove open demo mode, language switcher and fake billing`.

### Task 3: Security headers on the dashboard site, and proof that sign-in can't be claimed by email (1.5 h)

**Files:**
- Modify: `AI-phone-dashboard/frontend/firebase.json`. Add a header set on `"source": "**"`.
- Create:
  - `AI-phone-dashboard/frontend/src/__tests__/hostingHeaders.test.js`
  - `AI-phone-dashboard/backend/src/__tests__/emailCannotClaimTenant.test.js`

**Values.** `<API_ORIGIN>` and `<AUTH_DOMAIN>` must be literal origins, never `*`.
- `<API_ORIGIN>` is the origin of the production `VITE_API_URL`.
- `<AUTH_DOMAIN>` is `https://` plus the production `VITE_FIREBASE_AUTH_DOMAIN`.
- Both come from the environment used for the production build. If you can't find them, ask the owner; don't guess.

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' <API_ORIGIN> https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; frame-src <AUTH_DOMAIN>; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

- [ ] **Step 1: Write the failing tests**

```js
// hostingHeaders.test.js: reads ../../firebase.json
it("every page gets the security headers", () => {
  const all = hosting.headers.find((h) => h.source === "**").headers;
  const get = (k) => all.find((h) => h.key === k)?.value;
  const csp = get("Content-Security-Policy");
  for (const d of ["default-src 'self'", "script-src 'self';", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"]) expect(csp).toContain(d);
  expect(csp).not.toMatch(/\*|unsafe-eval/);
  expect(get("X-Frame-Options")).toBe("DENY");
  expect(get("X-Content-Type-Options")).toBe("nosniff");
  expect(get("Strict-Transport-Security")).toMatch(/max-age=31536000/);
});
```

```js
// emailCannotClaimTenant.test.js (mocked harness, createTestApp)
it("a fresh account using a client's email address gets no business", async () => {
  authState.user = { id: "fresh-account-uid", email: "owner@brightwork.example" };
  poolQueryMock.mockImplementation((sql, params) =>
    sql.includes("app_lookup_user_by_auth_uid") ? Promise.resolve({ rows: [] }) : Promise.reject(new Error("unexpected " + sql)));
  const res = await request(app).get("/api/calls").set("Authorization", "Bearer t");
  expect(res.status).toBe(403);
  const lookups = poolQueryMock.mock.calls.filter(([sql]) => sql.includes("app_lookup_user_by_auth_uid"));
  expect(lookups[0][1]).toEqual(["fresh-account-uid"]);
  expect(poolQueryMock.mock.calls.flatMap(([, p]) => p || [])).not.toContain("owner@brightwork.example");
});
```

- [ ] **Step 2: Run both and confirm.** The headers test FAILS. The email test is expected to PASS already, because migration 036 closed the gap; it pins that closure.
- [ ] **Step 3: Add the headers to `firebase.json`.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Check in a real browser.** Build and serve locally with the hosting emulator:
  - Run `npm run build && npx firebase emulators:start --only hosting`.
  - Sign in with the local test account (see memory `dashboard-local-dev`).
  - Open Settings.
  - The browser console must show **no** CSP violations.
  - `curl -sI http://localhost:5000/ | grep -i content-security-policy` must print the header.
- [ ] **Step 6: Commit** with message `fix(dashboard): security headers on the dashboard site; pin account-id sign-in`.

### Task 4: Tripwire: every dashboard setting reaches a call or is hidden (2–3 h)

**Files:**
- Create: `tests/dashboardSettingsEffects.test.js` (repo root, voice-engine suite)
- Modify:
  - `AI-phone-dashboard/frontend/src/settings/NotificationsSection.jsx`. Hide the "Notification phone" field and the "What callers get afterwards" panel while texts are off.
  - `AI-phone-dashboard/frontend/src/settings/__tests__/NotificationsSection.test.jsx`

**Interfaces:**
- Consumes:
  - `SETTINGS_FIELD_VALIDATORS` from `AI-phone-dashboard/backend/src/settingsValidation.js`, loaded via `createRequire`. Its keys are every column the dashboard can write.
  - `loadConfig` from `services/db.js`.
  - `buildSystemInstruction`, `buildCallTools` from `services/gemini.js`.
- Model: `tests/capabilityConfigEffects.test.js`, which does the same job for capability settings.

**Registers.** Every writable key goes in exactly one register.
- `ON_A_CALL`: key → an effect assertion. Set the key on a business row to a sentinel, run `loadConfig`, then build the system instruction or tools. The sentinel, or its observable effect, appears.
- `AFTER_A_CALL`: key → the test file that proves the owner email reads it. Expected: `notification_email`, `notifications_enabled` → `tests/db/ownerNotifications.test.js`.
- `NOT_SHOWN`: key → reason. Expected:
  - `notification_phone`, `sms_followup_enabled`, `sms_templates`: "texts are off in production";
  - `allowed_tasks`: "legacy; business_capabilities replaced it";
  - `voice_provider`, `voice_id`, only if the Live call path ignores them (decide by reading `VoicePickerSection.jsx:192` and the Live session setup).

Starting map for `ON_A_CALL`. Verify each one by reading its consumer:

```
name, timezone, greeting, custom_instructions, general_info, main_phone, business_hours,
after_hours_policy, transfer_policy, transfer_phone_number, languages_spoken,
recording_disclosure_enabled, recording_disclosure_text, live_voice, locale
```

**Rule:** a setting shown on screen with no consumer on a call is a defect.
- Do NOT wire it in this task.
- Put it in a `KNOWN_UNWIRED` list with a one-line reason.
- Make the test name it.
- Report it to the owner at the stage gate (memory: record and park, do not fix).

- [ ] **Step 1: Write the tripwire.** The test name is `every writable dashboard setting is registered exactly once`. It asserts that the sorted keys of `SETTINGS_FIELD_VALIDATORS` equal the sorted union of the four registers, with no key in two registers.
- [ ] **Step 2: Write one effect test per `ON_A_CALL` key**, named `${key} changes what the call gets`.
- [ ] **Step 3: Write the hidden-fields test.** In `NotificationsSection.test.jsx`, rendering with `sms_followup_enabled: false` shows no input labelled "Notification phone" and no "What callers get afterwards" heading.
- [ ] **Step 4: Run and confirm FAIL** until the registers and the hiding are in. Run:
  - `npx vitest run tests/dashboardSettingsEffects.test.js` from the repo root;
  - `npx vitest run src/settings/__tests__/NotificationsSection.test.jsx` in the frontend.
- [ ] **Step 5: Fill the registers and hide the two text fields** (render nothing for them). Run both again. Expected: PASS.
- [ ] **Step 6: Commit** with message `test: every dashboard setting reaches a call or is hidden`.

### Stage 0 gate

- [ ] **Run every suite:**
  - `cd AI-phone-dashboard/frontend && npx vitest run`
  - `cd AI-phone-dashboard/backend && npx vitest run`
  - from the repo root: `npx vitest run tests/dashboardSettingsEffects.test.js tests/capabilitySchemaExport.test.js`
  - Expected: all PASS.
- [ ] **Check dependencies.** Run `npm audit --omit=dev` in `frontend` and in `backend`. Fix high and critical issues, or list them for the owner.
- [ ] **One fresh reviewer** (superpowers:requesting-code-review) on `git diff feat/outbound-stage4...HEAD`. Focus: the CSP, the CSV guard, and anything still reachable by `?demo`.
- [ ] **Tell the owner** about any `KNOWN_UNWIRED` setting. No deploy at this stage.

---

## Stage 1: Shell and brand (≈ 5–8 h)

### Task 5: Brand tokens, navigation glyphs, and the session gate (2–3 h)

**Files:**
- Create:
  - `AI-phone-dashboard/frontend/src/shell/tokens.css`. Port the prototype's `:root` custom properties and base type: palette, radii, hairline border, focus ring, `font-variant-numeric: tabular-nums` utility.
  - `AI-phone-dashboard/frontend/src/shell/icons.jsx`. Draw the five glyphs from the prototype sprite symbols `g-home`, `g-inbox`, `g-cal`, `g-agent`, `g-set`.
  - `AI-phone-dashboard/frontend/src/shell/BusinessContext.jsx`
  - `AI-phone-dashboard/frontend/src/shell/SessionGate.jsx`. Moved out of `App.jsx`: the `onAuthChange` session, the `/api/me` load, Onboarding, Login, and idle logout with its warning.
  - `AI-phone-dashboard/frontend/src/shell/__tests__/SessionGate.test.jsx`

**Interfaces (produces):**
- `HomeIcon`, `InboxIcon`, `CalendarIcon`, `AgentIcon`, `SettingsIcon`: `({ size = 22 }) → <svg aria-hidden="true" focusable="false">`.
- `useBusiness() → { business, businessId, setBusiness, definitions, capabilityRows, reloadCapabilities, openCount, setOpenCount }`.
  - `definitions` is the body of `GET /api/capabilities/definitions`.
  - `capabilityRows` is the array from `GET /api/business/:id/capabilities`.
  - Both are loaded once by `SessionGate` after `/api/me`.
- `<SessionGate>{children}</SessionGate>` renders children only for a signed-in user with an onboarded business.

- [ ] **Step 1: Write the failing tests.** Mock `../../auth` and `../../api`:
  - signed out → renders `Login`;
  - `/api/me` returns a business without `phone_number` → renders `Onboarding`;
  - `/api/me` returns `{ business: { id: "b1", name: "Brightwork Family Dental", phone_number: "+15550100" } }` → a child calling `useBusiness()` shows "Brightwork Family Dental";
  - `/api/me` rejects → shows "We couldn't load your account. Check your connection, then refresh the page." and a "Try again" button that calls `/api/me` again.
- [ ] **Step 2: Run and confirm FAIL.** Run `npx vitest run src/shell`.
- [ ] **Step 3: Implement.** Move the code out of `App.jsx`; don't copy it. `App.jsx` keeps working by wrapping its own body in `SessionGate` until Task 14 deletes it.
- [ ] **Step 4: Run.** Expected: PASS, and the whole frontend suite still passes.
- [ ] **Step 5: Commit** with message `feat(dashboard): brand tokens, glyphs, session gate`.

### Task 6: App shell, navigation and real URLs (2–3 h)

**Files:**
- Create:
  - `AI-phone-dashboard/frontend/src/shell/AppShell.jsx`
  - `AI-phone-dashboard/frontend/src/shell/nav.js`
  - `AI-phone-dashboard/frontend/src/shell/shell.css`
  - `AI-phone-dashboard/frontend/src/shell/__tests__/nav.test.js`
  - Stub pages, each rendering only its `<h1>` until its task: `AI-phone-dashboard/frontend/src/pages/{Home,Inbox,VoiceAgent}.jsx`
- Modify:
  - `AI-phone-dashboard/frontend/src/routes.jsx` (app build only; the marketing branch is untouched)
  - `AI-phone-dashboard/frontend/src/__tests__/routing.test.jsx`
  - Adapter property: `adapters/scheduling/internal.js`, `adapters/scheduling/webhook.js`, `adapters/scheduling/athenahealth.js`
  - `scripts/export-capability-schemas.js`
  - `AI-phone-dashboard/backend/src/generated/capabilitySchemas.json` (regenerated)
  - `tests/capabilitySchemaExport.test.js`

**Interfaces (produces):**
- Adapter property `storesBookingsLocally: boolean`, exported as `adapters.scheduling[].storesBookingsLocally`. It is true where bookings are rows in VetraTD's `appointments` table:
  - `internal`: true;
  - `athenahealth`: false;
  - `webhook`: read `adapters/scheduling/webhook.js` and set it to what it does.
- `calendarAvailable(definitions, capabilityRows) → boolean`. True when the pack with `adapterKind === "scheduling"` has an enabled row whose `adapter` names an adapter with `storesBookingsLocally`.
- `navItems({ calendarAvailable }) → Array<{ to, label, short, Icon }>`, in this order:
  - Home `/home`;
  - Inbox `/inbox`;
  - Calendar `/calendar` (only if available);
  - Voice agent `/voice-agent`, with short label "Agent";
  - Settings `/settings`.
- **Routes (app build):**
  - A layout route `<SessionGate><AppShell/></SessionGate>` with an `<Outlet/>` serves `/home`, `/inbox`, `/inbox/:callId`, `/calendar`, `/voice-agent`, `/voice-agent/:section`, `/voice-agent/:section/:item`, `/settings`, `/settings/:item` and `/trends`.
  - Redirects to `/home`: `/`, `/app`, `/login`, `/signin`. Alert emails already sent link to these.
  - `/reset-password` is unchanged.
- **AppShell:**
  - Desktop above 760 px: a navy side navigation with the mark, the business name, and the items, with Settings pinned at the bottom.
  - Phone at 760 px and below: a fixed bottom bar using the `short` labels. Use CSS media queries, not JS.
  - Active item via `NavLink`, so it gets `aria-current="page"`.
  - Home shows the `openCount` badge when it is above 0.
  - A "Skip to content" link targets `<main id="main" tabIndex={-1}>`.

- [ ] **Step 1: Write the failing tests.**
  - `nav.test.js`:
    - `calendarAvailable` is true for an enabled `internal` adapter;
    - false for `athenahealth`;
    - false when the pack is disabled;
    - `navItems({calendarAvailable:false})` has 4 items with no `/calendar`.
  - `routing.test.jsx` (app build):
    - `/` and `/app` land on the Home heading;
    - `/inbox/abc` renders Inbox;
    - an unknown path renders 404.
  - `capabilitySchemaExport.test.js`: every scheduling adapter has a boolean `storesBookingsLocally`.
- [ ] **Step 2: Run and confirm FAIL.**
- [ ] **Step 3: Implement.** Then run `node scripts/export-capability-schemas.js` to regenerate the JSON.
- [ ] **Step 4: Run the frontend suite and the root schema test.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(dashboard): app shell with real URLs and five-tab navigation`.

### Task 7: Host the pages not rebuilt yet inside the shell (1–2 h; a mechanical move, a cheaper model is fine)

**Files:**
- Create:
  - `AI-phone-dashboard/frontend/src/legacy/LegacyAppointments.jsx`, moved from `App.jsx` (the `activePage === "appointments"` block with its state, effects and the "Email me bookings" handler);
  - `AI-phone-dashboard/frontend/src/legacy/LegacyTrends.jsx`, moved from the `activePage === "analytics"` block;
  - `AI-phone-dashboard/frontend/src/legacy/__tests__/LegacyAppointments.test.jsx`
- Modify: `AI-phone-dashboard/frontend/src/routes.jsx`. Route `/calendar` → `LegacyAppointments`, `/trends` → `LegacyTrends`, and `/settings/*` → `SettingsPage` with props from `useBusiness()`.

Both legacy components read the business from `useBusiness()` and keep their current markup and CSS (`Dashboard.css`). Part 2 replaces them.

- [ ] **Step 1: Write the failing test.** With `api` mocked, `LegacyAppointments` renders the bookings list from `GET /api/appointments`. Pressing the email-bookings button posts to `/api/appointments/email` with the selected range.
- [ ] **Step 2: Run and confirm FAIL. Step 3: Move the code. Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with message `refactor(dashboard): host bookings, trends and settings pages in the new shell`.

### Stage 1 gate

- [ ] **Run the frontend suite.** Expected: all PASS.
- [ ] **Run the design detector.** Run `impeccable detect` on `src/shell/**`. Fix findings, or record a justified ignore.
- [ ] **One browser pass with Playwright**, at desktop 1280×800 and phone 390×844:
  - the navigation works;
  - focus is visible;
  - the bottom bar doesn't cover content;
  - `/app` redirects;
  - there are no console errors.
- [ ] **One fresh reviewer** on the stage diff.

---

## Stage 2: Home and Inbox (≈ 9–11 h)

### Task 8: Migration 061, a call's open item can be marked done (1.5 h)

**Files:**
- Create:
  - `database/061_call_handled.sql`
  - `tests/db/callHandled.test.js`
- Modify: `database/schema.sql`. Fold in the columns and index; `tests/db/schemaParity.test.js` enforces this.

**Interfaces (produces):**
- `calls.handled_at timestamptz NULL` and `calls.handled_by text NULL`. `handled_by` holds the Identity Platform uid, or `'launch'` for the backfill.
- Index `idx_calls_open_items ON calls (business_id, started_at) WHERE handled_at IS NULL`.

**Migration body:**
- Additive and idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`.
- Then the launch backfill (owner, 2026-11-22). Calls with a `customer_requests` row and `started_at < now() - interval '7 days'` get `handled_at = now()` and `handled_by = 'launch'`.
- The backfill runs between `ALTER TABLE calls NO FORCE ROW LEVEL SECURITY` / `customer_requests NO FORCE …` and the matching `FORCE` statements. Under FORCE RLS the owner's UPDATE matches nothing; see migration 036 for the same trap.
- **Timing:** run this migration only as part of the stage 3 deploy, so the 7-day window is measured at launch.

- [ ] **Step 1: Write the failing test.** Copy the role and FORCE-trap set-up from `tests/db/userDirectoryAuthUid.test.js:347` and `tests/db/customerRequestDetails.test.js`. Seed one tenant with:
  - a call 8 days old with a request;
  - a call 6 days old with a request;
  - a call 8 days old with no request.

  Then re-run the migration file's SQL as the migrating role. Assert:
  - the 8-day call with a request has `handled_by = 'launch'`;
  - the other two have `handled_at IS NULL`;
  - FORCE RLS is still on for `calls` and for `customer_requests`.
- [ ] **Step 2: Run and confirm FAIL.** Run `npm run test:db -- tests/db/callHandled.test.js` (needs local Postgres; see memory `dashboard-local-dev`).
- [ ] **Step 3: Write the migration and fold it into `schema.sql`.**
- [ ] **Step 4: Run** `npm run test:db -- tests/db/callHandled.test.js tests/db/schemaParity.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(db): 061 calls can be marked handled; launch backfill keeps the last 7 days open`.

### Task 9: Mark done and reopen endpoints (1 h)

**Files:**
- Modify:
  - `AI-phone-dashboard/backend/src/routes/calls.js`
  - `AI-phone-dashboard/backend/src/phiAudit.js`. Add both routes to `NON_PHI_ROUTES`: they change state and return no call content.
  - `tests/db/dashboardTenantScoping.test.js`
- Create: `AI-phone-dashboard/backend/src/__tests__/callHandled.test.js`

**Interfaces (produces):**
- `PUT /api/calls/:id/handled`, chained as `authSensitiveLimiter, authenticate, withTenantHandler`.
  - Runs `UPDATE calls SET handled_at = COALESCE(handled_at, now()), handled_by = COALESCE(handled_by, $3) WHERE id = $1 AND business_id = $2 RETURNING id, handled_at, handled_by`, with params `[id, req.businessId, req.authUser.id]`.
  - Returns `200 { id, handled_at, handled_by }`, or `404 { error: "Call not found" }`.
- `DELETE /api/calls/:id/handled` clears both columns, with the same scoping. Returns `200 { id, handled_at: null, handled_by: null }` or 404.
- A malformed `:id` (not `/^[0-9a-f-]{36}$/i`) returns 404 without querying `calls`.

- [ ] **Step 1: Write the failing tests** (mocked harness):
  - PUT sends the SQL with `business_id = $2` and `COALESCE(handled_at`, and params `[id, "b1", DEFAULT_TEST_USER.id]`;
  - PUT returns 404 when no row comes back;
  - DELETE nulls both columns;
  - `/api/calls/not-a-uuid/handled` returns 404 with no `calls` query;
  - no auth returns 401;
  - `phiAuditRoutes.test.js` stays green.

  Real database (`dashboardTenantScoping.test.js`):
  - tenant A's PUT on tenant B's call returns 404, and B's `handled_at` is still NULL when read back by the admin client;
  - a second PUT by another user keeps the first `handled_by` (Review Focus 3).
- [ ] **Step 2: Run and confirm FAIL. Step 3: Implement. Step 4: Run** the backend suite and `npm run test:db -- tests/db/dashboardTenantScoping.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(dashboard-api): mark a call's item done and reopen it`.

### Task 10: Home summary endpoint (2 h)

**Files:**
- Create:
  - `AI-phone-dashboard/backend/src/routes/home.js`
  - `AI-phone-dashboard/backend/src/__tests__/home.test.js`
  - `tests/db/dashboardHome.test.js`
- Modify:
  - `AI-phone-dashboard/backend/src/server.js`. Mount it next to the other routers.
  - `AI-phone-dashboard/backend/src/phiAudit.js`. Add `"GET /api/home": { action: "read", resources: ["calls", "customer_requests", "appointments"] }`.

**Interface (produces):** `GET /api/home`, chained as `authenticate, withTenantHandler`. Response:

```
{ timezone,
  openItems:   [{ callId, startedAt, callerNumber, callerName, summary,
                  request: { type, callerName, callbackNumber, preferredTime, message } }],
  doneToday:   [{ callId, startedAt, callerNumber, callerName, summary, status,
                  handledAt, handledBy, hadRequest }],
  today:       { answered, bookingsMade },
  todaysBookings: [{ id, scheduledAt, clientName, status, callId }],
  week:        { calls, bookingsMade } }
```

**Rules (spec §8 Home and §9):**
- **`openItems`:** calls with `handled_at IS NULL` that have a `customer_requests` row.
  - Use the latest request per call (a `LATERAL` join).
  - `ORDER BY started_at ASC`, `LIMIT 200`.
  - `callerName` comes from the request's `caller_name`, then the latest appointment's `client_name`, then null.
- **`doneToday`:** either of these, `ORDER BY` most recent first, `LIMIT 200`:
  - calls started today with no request;
  - calls whose `handled_at` is today and whose `handled_by <> 'launch'`.
- **`today.answered`:** inbound calls started today.
- **`today.bookingsMade`:** appointments whose `call_id` is a call started today. Moves don't count.
- **`todaysBookings`:** appointments with `scheduled_at` today, ordered by time.
- **`week`:** from Monday 00:00 to now.
- **Every bound is in the business timezone,** computed in SQL with the tz from `loadBusinessTimezone` (`backend/src/callDateBounds.js`):
  - day start: `date_trunc('day', now() AT TIME ZONE $tz) AT TIME ZONE $tz`, and +1 day for the end;
  - week start: `date_trunc('week', …)`, which starts on Monday.
- Every query filters on `business_id = $1` explicitly, in addition to RLS.

- [ ] **Step 1: Write the failing tests.**
  - Mocked:
    - every SQL statement has `business_id = $1` and params start with `"b1"`;
    - the open-items SQL orders `started_at ASC`;
    - the response has exactly the keys above;
    - no auth returns 401.
  - Real database (`dashboardHome.test.js`), as `vetra_app` with business tz `America/Chicago`:
    - a call at local midnight minus 1 second is not in `today.answered`, and one at local midnight plus 1 second is (Review Focus 1);
    - tenant B's open items never appear for tenant A;
    - an item marked done with `handled_by = 'launch'` is not in `doneToday`.
- [ ] **Step 2: Run and confirm FAIL. Step 3: Implement. Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(dashboard-api): home summary in the business's timezone`.

### Task 11: Inbox search, the "needs you" view, and the caller's history (1.5 h)

**Files:**
- Modify: `AI-phone-dashboard/backend/src/routes/calls.js`
- Create: `AI-phone-dashboard/backend/src/__tests__/callsInbox.test.js`

**Interfaces (produces):**
- `GET /api/calls` gains:
  - **`view=open`** adds `handled_at IS NULL AND EXISTS (customer_requests for the call)`. Any other value means all calls.
  - **`q`**, run through `sanitizeString(q, 64)`. Escape `\`, `%` and `_` with a backslash, then match `ILIKE $n ESCAPE '\'` against:
    - `calls.caller_number`;
    - `calls.summary`;
    - any request `caller_name`;
    - any appointment `client_name`.
  - **Row fields** `has_request` (boolean), `handled_at`, `handled_by`, and `request_type` (latest). `caller_name_guess` becomes `COALESCE(latest request caller_name, latest appointment client_name)`.
- `GET /api/calls/:id` adds `caller_history: { calls: [{ id, started_at, summary, status }], bookings: [{ id, scheduled_at, status, client_name }] }`.
  - `calls`: the same `caller_number`, excluding this call, newest first, `LIMIT 10`.
  - `bookings`: `client_phone = caller_number` with `scheduled_at` between now − 1 day and now + 7 days.
  - Both are empty, with no history query, when `caller_number` is null or blank.

- [ ] **Step 1: Write the failing tests:**
  - `q=50%_off` produces the param `%50\%\_off%`;
  - `view=open` adds the clause after `business_id = $1`;
  - a call with a null `caller_number` returns empty `caller_history` and runs no history query;
  - every new query is tenant-filtered.
- [ ] **Step 2: Run and confirm FAIL. Step 3: Implement. Step 4: Run** the backend suite. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(dashboard-api): inbox search, needs-you view, caller history`.

### Task 12: Call wording and formatting helpers (1 h)

**Files:**
- Create:
  - `AI-phone-dashboard/frontend/src/calls/callStatus.js`
  - `AI-phone-dashboard/frontend/src/calls/format.js`
  - `AI-phone-dashboard/frontend/src/calls/__tests__/callStatus.test.js`
  - `AI-phone-dashboard/frontend/src/calls/__tests__/format.test.js`

**Interfaces (produces):**
- `formatTime(iso, tz) → "9:05 am"`.
- `formatDateTime(iso, tz) → "Tuesday 24 November, 9:00 am"`.
- `dayHeading(iso, tz, now = new Date()) → "Today" | "Yesterday" | "Friday 20 November"`.
- The formatters use `Intl.DateTimeFormat("en-GB", { timeZone: tz })` with a lower-case am/pm.
- `telHref(number) → "tel:+15550100199" | null`. Strip spaces, `()`, `-` and `.`, then require `/^\+?\d{7,15}$/`.
- `callerLabel({ callerName, callerNumber }) → name | number | "Withheld number"`.
- `statusLine` and `didList` take the raw `GET /api/calls/:id` shapes (snake_case `call.handled_at`, `customer_requests` rows with `request_type` / `preferred_time`) and map them to `needText`'s shape internally.
- `needText({ type, preferredTime }) → string` (camelCase, the `/api/home` request shape):
  - a callback with `preferredTime` gives `"Call back " + preferredTime`, for example "Call back after 3 pm";
  - a callback without one gives "Call back";
  - a message gives "Read their message".
- `statusLine({ call, appointments, requests }) → { tone: "needs" | "done" | "quiet", text }`. Spec §8 Inbox, exact copy:
  - requests present and not handled → `needs`, `needText(requests[0])`;
  - requests present and handled → `done`, "Marked done", or "Marked done when the new dashboard launched" for `'launch'`;
  - an appointment, or `status === "transferred"` → `done`, "Nothing for you to do";
  - otherwise → `quiet`, "No message was left."
- `didList({ call, appointments, requests, tz }) → string[]`:
  - "Booked an appointment for " + `formatDateTime`;
  - "Took a call-back request" or "Took a message";
  - "Put the call through to your team".

- [ ] **Step 1: Write the failing tests.** Assert each exact string above, plus:
  - `formatTime("2026-11-23T05:59:00Z", "America/Chicago")` is `"11:59 pm"`;
  - its `dayHeading` with `now = 2026-11-23T12:00Z` is "Yesterday";
  - `telHref("+1 (555) 010-0199")` is `"tel:+15550100199"`;
  - `telHref("javascript:alert(1)")` is null;
  - `callerLabel({})` is "Withheld number".
- [ ] **Step 2: Run and confirm FAIL. Step 3: Implement. Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(dashboard): call wording and timezone-safe formatting`.

### Task 13: Home page (2 h)

**Files:**
- Create:
  - `AI-phone-dashboard/frontend/src/pages/Home.jsx` (replaces the stub)
  - `AI-phone-dashboard/frontend/src/pages/home.css`
  - `AI-phone-dashboard/frontend/src/pages/__tests__/Home.test.jsx`

**Behaviour (spec §8 Home; layout from the prototype's `homePage()`):**
- **Greeting** in Fraunces: "Good morning", "Good afternoon" or "Good evening", by the hour in the business timezone.
- **One sentence** below it: "{n} callers need you. VetraTD answered {x} calls today and made {y} bookings." Use singular forms where n, x or y is 1.
- **"Needs you"** rows:
  - Each row shows `formatTime`, `needText`, `callerLabel`, and one line (the request message, else the first sentence of the summary).
  - The text is a `<Link to=/inbox/:callId>`.
  - **Call back** is an `<a href={telHref(...)}>`, shown only when `telHref` returns a value; prefer the request's `callbackNumber`.
  - **Done** is a separate button; no interactive element sits inside another.
- **Done** marks the item optimistically: it calls `PUT /api/calls/:id/handled` and moves the row to "Done today" with **Reopen**, which calls `DELETE`.
  - On failure, put the row back and show a toast: "Couldn't mark that as done. Check your connection, then try again."
  - Update `setOpenCount`.
- **"Done today"** lists `doneToday`. Rows with `handledBy` get Reopen.
- **Right rail** (below the list at 760 px and less):
  - today's bookings, with a "now" line;
  - "This week so far: {calls} calls, {bookingsMade} bookings made.", with the link "See call trends" → `/trends`.
- **Empty "Needs you"** says exactly: "Nothing needs you right now. New calls that need you will show up here, and you'll get an email."
- **Load error** says "Couldn't load your calls. Check your connection, then try again." with a Try again button.

- [ ] **Step 1: Write the failing tests** (mock `api`):
  - open items render oldest first;
  - Done moves a row to Done today and calls PUT with the call id;
  - Reopen calls DELETE and moves it back;
  - a failed PUT restores the row and shows the toast;
  - the empty-state text is exact;
  - an item with no number and no callback number shows "Withheld number" and no Call back link (Review Focus 2);
  - the sentence uses the singular "1 caller needs you".
- [ ] **Step 2: Run and confirm FAIL. Step 3: Implement. Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(dashboard): Home, with what needs you and Done`.

### Task 14: Inbox, then delete the old dashboard page (3 h)

**Files:**
- Create:
  - `AI-phone-dashboard/frontend/src/pages/Inbox.jsx` (replaces the stub)
  - `AI-phone-dashboard/frontend/src/pages/inbox/CallList.jsx`
  - `AI-phone-dashboard/frontend/src/pages/inbox/CallView.jsx`
  - `AI-phone-dashboard/frontend/src/pages/inbox/CallerPanel.jsx`
  - `AI-phone-dashboard/frontend/src/pages/inbox.css`
  - `AI-phone-dashboard/frontend/src/pages/__tests__/Inbox.test.jsx`
- Delete:
  - `AI-phone-dashboard/frontend/src/App.jsx`
  - `LanguageSwitcher.jsx`
  - `callsQueryParams.js` and its test
  - any CSS that only `App.jsx` used. Check that `legacy/*` doesn't use it before deleting.
- Modify: `AI-phone-dashboard/frontend/src/__tests__/honesty.test.jsx`. The demo test now renders `AppRoutes` (app build) at `/?demo=1` and expects the sign-in screen; the language test asserts `LanguageSwitcher.jsx` no longer exists.
- Reuse: `components/CallOutcomeAnswers.jsx` for `customer_requests.details` answers, and `callsCsv.js`.
- List rows map to the helpers' shape: `{ callerName: row.caller_name_guess, callerNumber: row.caller_number }`.

**Behaviour (spec §8 Inbox; prototype `inboxPage()` / `detail()` / `callerCtx()`):**
- **URL state:**
  - `/inbox/:callId` selects a call;
  - `?view=all` switches from the default "Needs you (n)";
  - `?q=` is the search, debounced 300 ms.
  - The back button walks through the selections.
- **List** grouped by `dayHeading`. **"Download calls (CSV)"** at the top on desktop exports the current list as `vetratd-calls-YYYY-MM-DD.csv`.
- **Call view** shows, in order:
  1. caller label, number as text, time and length;
  2. the status line from `statusLine`, with an icon and text, not colour alone;
  3. Summary;
  4. "What VetraTD did", a ticked list from `didList`;
  5. the booking made on the call, with "See it in the calendar" → `/calendar?date=YYYY-MM-DD` in business tz;
  6. Conversation: the first 4 lines, then a "Show the whole conversation" button with `aria-expanded`. Speakers are "Caller" and "VetraTD".
  - Done and Reopen sit in the header.
- **Caller panel:** `caller_history.calls` and `caller_history.bookings`. Desktop ≥ 1180 px shows it as a third column; narrower screens show it below the call.
- **Phone (≤ 760 px):** the list, or the call on its own screen with a back link. Call back and Done are fixed at the bottom.

- [ ] **Step 1: Write the failing tests** (mock `api`):
  - rows are grouped under "Today" and "Yesterday";
  - clicking a row navigates to `/inbox/:id`;
  - the switch sets `?view=all`;
  - typing in search calls `/api/calls` with `q` once after debounce;
  - a transcript line `<img src=x onerror=alert(1)>` renders as literal text, with no `img` element in the DOM (Review Focus 4);
  - a 2,000-character summary renders;
  - "Show the whole conversation" reveals line 5;
  - the CSV button builds the file from the visible rows (spy on `buildCallsCsv`).
- [ ] **Step 2: Run and confirm FAIL. Step 3: Implement, then delete the old files.**
- [ ] **Step 4: Run** the full frontend suite and `npm run build`. Expected: PASS, and the build has no import of a deleted file.
- [ ] **Step 5: Commit** with message `feat(dashboard): Inbox with the whole call in one place; remove the old calls page`.

### Stage 2 gate

- [ ] **Run every suite:** frontend, backend, and `npm run test:db -- tests/db/callHandled.test.js tests/db/dashboardHome.test.js tests/db/dashboardTenantScoping.test.js tests/db/schemaParity.test.js`. Expected: all PASS.
- [ ] **Design detector** (`impeccable detect`) on `src/pages/**` and `src/calls/**`.
- [ ] **One browser pass, desktop and phone,** against the local backend and the Brightwork test business:
  - Home → Done → Reopen;
  - Inbox search;
  - an email-style deep link `/inbox/<id>` while signed out → sign in → lands on the call.
- [ ] **One fresh reviewer** on the stage diff. Focus: tenant scoping of the new SQL, the ILIKE escaping, and text rendering.

---

## Stage 3: Voice agent tab and first deploy (≈ 6–8 h)

### Task 15: Plain action names, and the listing property (1 h)

**Files:**
- Modify:
  - `capabilities/appointments.js`, `capabilities/messages.js`, `capabilities/transfer.js`, `capabilities/quotes.js`, the `sms_consent` pack file, `capabilities/qualification.js`, `capabilities/outcome.js`, `capabilities/callback.js`, `capabilities/optOut.js`
  - `scripts/export-capability-schemas.js`, which exports `dashboardListing: pack.dashboardListing || "listed"`
  - `AI-phone-dashboard/backend/src/generated/capabilitySchemas.json` (regenerated)
  - `tests/capabilitySchemaExport.test.js`

**Values (spec §8 Voice agent):**
- **Pack labels:**
  - Appointments → "Bookings";
  - "Messages & callbacks" → "Messages";
  - "Transfer to a person" → "Transfers";
  - "Quote requests" → "Quotes".
- **Field labels in `appointments.js` `configSchema`:**
  - "What must the caller provide before we look up or change an appointment?" → "Information callers must give";
  - "Read details back and require a clear yes before booking" → "Read the details back and wait for a clear yes";
  - "Anything specific about how you book?" → "Your booking rules".
- **`dashboardListing`:**
  - `"hidden"` for `qualification`, `outcome`, `callback`, `opt_out`, `sms_consent`;
  - `"optIn"` for `quotes`, so it is listed only where the business has it enabled;
  - `"listed"` (the default) for the rest.
- Labels are dashboard-only. Checked while planning: `pack.label` is not read by any prompt code. Do not touch the identity labels in `lib/capabilities/requirements.js`, which ARE spoken.

- [ ] **Step 1: Write the failing tests** in `capabilitySchemaExport.test.js`:
  - the four new pack labels;
  - the `dashboardListing` value for every pack;
  - every value is in `["listed", "optIn", "hidden"]`.
- [ ] **Step 2: Run and confirm FAIL. Step 3: Change the packs and run the export script.**
- [ ] **Step 4: Run the whole root suite** with `npx vitest run`. Expected: PASS, with **no snapshot changes**. A changed prompt snapshot means a label reached the prompt: stop, revert that label, and tell the owner.
- [ ] **Step 5: Commit** with message `feat(capabilities): plain action names; dashboardListing hides outbound and text packs`.

### Task 16: One draft-and-save hook for settings (1 h)

**Files:**
- Create:
  - `AI-phone-dashboard/frontend/src/settings/useBusinessDraft.js`
  - `AI-phone-dashboard/frontend/src/settings/__tests__/useBusinessDraft.test.jsx`
- Modify: `AI-phone-dashboard/frontend/src/settings/SettingsPage.jsx`. Move `snapshotFromBusiness`, `valuesEqual`, `diffSnapshots` and the save logic out into the hook; behaviour is unchanged.

**Interface (produces):** `useBusinessDraft({ business, businessId, onBusinessUpdate }) → { draft, changed, changedKeys, dirty, patch(fields), discard(), save(): Promise<boolean>, saving, error, savedMessage }`.
- `save()` sends `PUT /api/business/:id/settings` with only the changed keys.
- On failure it returns false, keeps the draft and sets `error` to the server's message. If the server sent none, `error` is "Couldn't save. Check your connection, then try again."
- Also exports `snapshotFromBusiness`.

- [ ] **Step 1: Write the failing tests** with `renderHook`:
  - patching `greeting` makes `dirty` true and `changed` equal `{ greeting }`;
  - `discard()` makes it clean;
  - `save()` PUTs only `{ greeting }`, then is clean;
  - a rejected PUT leaves `dirty` true, the draft intact and `error` set (Review Focus 5).
- [ ] **Step 2: Run and confirm FAIL. Step 3: Extract it. Step 4: Run** the full frontend suite; the existing settings tests must pass unchanged.
- [ ] **Step 5: Commit** with message `refactor(dashboard): one draft-and-save hook for settings`.

### Task 17: Voice agent tab (3–4 h)

**Files:**
- Create:
  - `AI-phone-dashboard/frontend/src/pages/VoiceAgent.jsx` (replaces the stub)
  - `AI-phone-dashboard/frontend/src/pages/voiceAgent/items.js`
  - `AI-phone-dashboard/frontend/src/pages/voiceAgent/voice-agent.css`
  - `AI-phone-dashboard/frontend/src/pages/__tests__/VoiceAgent.test.jsx`
- Modify:
  - `AI-phone-dashboard/frontend/src/settings/CapabilitiesSection.jsx`. Export `CapabilityCard` as `CapabilityPanel`, and add `listedCapabilities(definitions, capabilityRows)`.
  - `AIBehaviorSection.jsx`: add the prop `only: "greeting" | "tone" | "rules"`, rendering one field.
  - `LanguagesSection.jsx`: add the prop `only: "languages" | "notice"`.
  - `SettingsPage.jsx`: add the prop `groups`. The `/settings` route passes `["notifications", "billing"]` until part 2.
- Delete: `AI-phone-dashboard/frontend/src/settings/TasksSection.jsx` and its test. Nothing renders it today, and `business_capabilities` replaced `allowed_tasks`.

**Interfaces (produces):**
- `listedCapabilities(definitions, rows) → def[]`.
  - Drops `dashboardListing === "hidden"`.
  - Keeps `"optIn"` only when that pack's row is enabled.
  - Orders core packs first.
- `SECTIONS` in `items.js` follows spec §8:
  - `voice`: greeting, tone, rules (all via AIBehaviorSection `only`), voice (VoicePickerSection), languages, notice (LanguagesSection `only`).
  - `info`: details (BusinessInfoSection), hours (BusinessHoursEditor), closed (AfterHoursSection), answers (KnowledgeBaseEditor, which saves per answer and gets no Save bar).
  - `actions`: built from `listedCapabilities`. Use the item id `def.id` and the label `def.label`. Transfers renders `CapabilityPanel` plus `TransferRulesSection`.

**Behaviour:**
- **Header:** "To try a change, call {formatted business number}. Saved changes apply from the next call." with a "Copy number" button.
- **Desktop:** the list on the left, the panel on the right. **Phone:** the list, then the item on its own screen.
- **List rows** show:
  - a switch for packs that can be turned off; switching applies at once via the existing capability PUT;
  - "Always on" for `core` packs;
  - the transfer policy for Transfers.
- **Draft items** use `useBusinessDraft` with a Save bar (Save, Discard).
- **Formats as choices, never a regular expression** (spec §8 Bookings panel). `CustomIdentityField` (`CapabilitiesSection.jsx:484`) today shows a raw "Expected format" text box. Replace it with a choice from `FORMAT_CHOICES` in a new `AI-phone-dashboard/frontend/src/settings/identityFormats.js`:
  - "Anything" (no pattern);
  - "Numbers only" → `^\d+$`;
  - "Exactly N digits", N from 1 to 20 → `^\d{N}$`;
  - "Letters and numbers" → `^[A-Za-z0-9]+$`.
  - `formatFromPattern(pattern) → { choice, digits? }` maps a saved pattern back. A saved pattern that matches no choice shows read-only as "A custom format set by VetraTD" and is kept unchanged on save. Keep "Try a value".
- **Leaving with unsaved changes** uses react-router `useBlocker` with a dialog: "You have unsaved changes. Leave without saving?" with the buttons "Keep editing" and "Leave".
- **URL:** `/voice-agent/:section/:item`. `/voice-agent` opens `voice/greeting`.
- **"Your custom actions":** not rendered this round (spec §8).

- [ ] **Step 1: Write the failing tests:**
  - with definitions that include all nine packs, the list shows only Bookings, Messages and Transfers;
  - Quotes appears when its row is enabled;
  - `/voice-agent/actions/appointments` opens the Bookings panel;
  - editing the greeting then clicking Home shows the leave dialog, and "Keep editing" stays put;
  - a failed save keeps the text and shows the error (Review Focus 5);
  - "Always on" shows for Messages, with no switch;
  - in `settings/__tests__/identityFormats.test.js`: "Exactly 8 digits" gives `^\d{8}$`; `formatFromPattern("^\\d{8}$")` gives `{ choice: "digits", digits: 8 }`; an unknown pattern gives `{ choice: "custom" }` and survives a save untouched; no rendered input accepts a regular expression.
- [ ] **Step 2: Run and confirm FAIL. Step 3: Implement. Step 4: Run** the full frontend suite and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(dashboard): Voice agent tab`.

### Task 18: Stage 3 gate and the first deploy (1–2 h, plus waiting on the owner)

- [ ] **Run every suite:** frontend, backend, the root `npx vitest run`, and the `test:db` files from the stage 2 gate. Run `npm audit --omit=dev` in both packages; high and critical issues are fixed or listed.
- [ ] **Design detector** (`impeccable detect`) on `src/pages/**`, `src/shell/**`, `src/calls/**`.
- [ ] **One browser pass, desktop and phone,** through every tab. Change the greeting, save and reload: the change is kept.
- [ ] **One fresh reviewer on the whole part-1 diff**, against spec §10a. Focus: sign-in, tenant isolation, the export, and headers.
- [ ] **ASK THE OWNER before deploying.** Show:
  - what ships;
  - migration 061 and its launch backfill;
  - the deploy order: migration, then the backend, then the frontend.
- [ ] **Deploy, after a yes,** in this order:
  1. Migration 061 via the migrate job. Build it from the main checkout; see memory `prod-migration-checksums-crlf`.
  2. The dashboard backend, Cloud Run `dashboard-api-uk`, via gcloud; see memory `terraform-broken-deploy-route`.
  3. The frontend: `npm run build && npx firebase deploy --only hosting`, with the production env.
- [ ] **Verify in production:**
  - `curl -sI https://<app origin>/` shows the CSP header;
  - sign in;
  - Home loads;
  - Done and Reopen work on the test business;
  - `/inbox/<id>` deep link works;
  - the Voice agent shows only Bookings, Messages and Transfers.
- [ ] **One real test call** (spec §11). Change the greeting on the test business, call, and confirm the new greeting is heard and the call appears in the Inbox.
- [ ] **Record it.** Tick "Deploy the current dashboard" in `docs/readiness.md` with the revision and commit. Commit with message `docs: dashboard part 1 live`.
- [ ] **Write part 2** (stages 4–7) with superpowers:writing-plans, against the code as shipped.
