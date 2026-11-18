# app.vetratd.com — the dashboard's own origin

Status: **waiting on DNS.** Everything on the GCP side is done and applied.

`vetratd.com` stays on Vercel. GCP serves only the dashboard, on its own
subdomain.

> **Correction, 2026-09-08 — read "One codebase, two sites" at the end of this
> file before acting on anything above.** `vetratd.com` is NOT a separate
> project: it is this same frontend, auto-deploying from this repository to
> Vercel. Earlier sections here said otherwise, on the strength of a comment in
> `terraform.tfvars`, and that was never checked.

## Why a subdomain and not a path

Origin isolation. Same-origin would put the marketing site's JavaScript in
reach of the dashboard's Identity Platform session — tokens live in
origin-scoped browser storage — and that site has known security issues
knowingly left live. A separate origin makes the browser enforce the boundary
instead of us remembering to.

## Done already (2026-09-08)

- `dashboard_domains` now carries `app.vetratd.com`, which feeds **both**
  `CORS_ORIGINS` on the dashboard API and `authorized_domains` on Identity
  Platform. Applied and confirmed live:
  `['localhost', 'vetra-core-edc8ca.firebaseapp.com', 'vetra-core-edc8ca.web.app', 'app.vetratd.com']`
- The Firebase Hosting custom domain resource has been created against site
  `vetra-core-edc8ca`.

`authorized_domains` is the half that bites if it is forgotten. Miss it and
everything looks healthy — the page loads, the styles load, the sign-in form
renders — right up to the moment Identity Platform refuses the request for an
unlisted origin and the frontend renders "Something went wrong signing in. Try
again." It is already done, and it was done *first* on purpose.

## What YOU have to do: two DNS records at the registrar

No DNS is managed in this repository, and Firebase Hosting is deliberately not
in Terraform (`infra/terraform/shared.tf:139-143`). These go in by hand,
wherever `vetratd.com`'s nameservers point.

| host | type | value |
|---|---|---|
| `app` | `CNAME` | `vetra-core-edc8ca.web.app` |
| `_acme-challenge.app` | `TXT` | `gyRUY17y2LH6vSnSURWN0Qr_LPz6mqWH4yyiU8vpU8k` |

The TXT record is the certificate challenge. Without it the domain resolves and
then serves a certificate error, which looks like a broken deploy rather than a
missing record.

Issued 2026-09-08. If the domain is deleted and recreated, the TXT value
changes — re-read it rather than reusing the one above:

```
CLOUDSDK_CONFIG=~/.gcloud-vetra2 curl -s \
  "https://firebasehosting.googleapis.com/v1beta1/projects/vetra-core-edc8ca/sites/vetra-core-edc8ca/customDomains/app.vetratd.com" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "x-goog-user-project: vetra-core-edc8ca"
```

Watch `hostState` (want `HOST_ACTIVE`), `ownershipState` (want
`OWNERSHIP_ACTIVE`) and `cert.state` (want `CERT_ACTIVE`). Certificate
provisioning can take up to 24 hours after the records resolve.

## Decided 2026-09-08: the dashboard moves to the ROOT, and `/app` goes away

`app.vetratd.com/app` says "app" twice. Once the dashboard has its own origin,
the origin IS the app, so `/` should be the dashboard.

**Bundled with the cutover deliberately, not shipped ahead of it.** Doing the
route change first would leave a window where `dashboard_url` — which is what
owner notification emails link to — points at a path that no longer exists.

### What changes

- `AI-phone-dashboard/frontend/src/main.jsx`: `/` becomes `<App />`.
- **`/app` redirects to `/`**, and this is not optional. Notification emails
  already sent link to `/app`, and the router's `*` route is a 404 page. A
  `<Route path="/app" element={<Navigate to="/" replace />} />` keeps every
  existing bookmark and email working.
- The in-repo **Landing page is retired FROM THE APP BUILD ONLY.** It was
  originally written here as "retired, because vetratd.com is a different
  codebase" — which is false, and acting on it would have taken the marketing
  site down on the next merge. The Landing still ships in the `marketing`
  build; see "One codebase, two sites" below.
- `/contact`, `/legal` and `/reset-password` **stay**. The contact form has a
  working SMTP backend, and the login page's "Request access" link points at
  `/contact` — closing self-serve signup depends on that link resolving.

### The Terraform validation has to move with it, and it will BLOCK the apply

`infra/terraform/variables.tf` currently refuses a bare origin:

```hcl
condition     = var.dashboard_url == "" || can(regex("^https://[^/]+/.+", var.dashboard_url))
error_message = "dashboard_url must be an https:// URL WITH a path — e.g. https://<host>/app. The bare origin serves the marketing page, not the dashboard."
```

That rule was right and stops being right here: the bare origin will no longer
serve the marketing page, it will serve the dashboard. Relax it to accept an
origin with or without a path, and rewrite the message rather than deleting it.

**And fix the second validation while you are there.** The CORS cross-check
extracts the host with `regex("^https://([^/]+)/", ...)`, which requires a
trailing slash. Against a bare origin it does not match, the `!can(...)` arm is
true, and the check passes **vacuously** — it silently stops verifying that the
host is in `dashboard_domains`. A guard that quietly stops guarding is worse
than one that never existed, and this one exists specifically because these two
settings are edited in different places.

### Not done here: deep-linkable sections

`app.vetratd.com/settings`, `/calls` and so on are a SEPARATE piece of work.
The dashboard's navigation is component state, not routes — there is no
`useNavigate` anywhere in `App.jsx`, and Settings sub-sections are a `?section=`
query parameter (`SettingsPage.jsx:117`). Making those real URLs means nested
routes and lifting tab state into the router inside a 1,755-line file that
already carries a conditional-hooks problem. Worth doing — it would let an
appointment notification link to the actual call rather than the dashboard root
— but it deserves its own session.

## The last step, AFTER the certificate is live

Sign in on `https://app.vetratd.com/app` and confirm it works **before**
changing anything. Then make the routing change above, and:

```hcl
# infra/terraform/terraform.tfvars
dashboard_url = "https://app.vetratd.com"
```

```
cd infra/terraform && CLOUDSDK_CONFIG=~/.gcloud-vetra2 TF_DISABLE_PLUGIN_TLS=1 \
  terraform apply -var="image_tag=<current>" -var="dashboard_image_tag=<current>" \
                  -var="live_debug_transcript=1"
```

**The `/app` path is dropped in the same change — see the section above.** The
old rule was "keep the path, because a bare origin sends a member of staff who
clicked 'you have a new appointment' to a marketing page". That was correct
while `/` was the Landing page. After this change `/` IS the dashboard on this
origin, so the bare origin is the right link and the path is the wrong one.

The old hazard does not disappear, it inverts: the danger is now a
`dashboard_url` still carrying `/app` after the route is gone. That is what the
`/app` → `/` redirect is for, and why it ships in the same commit rather than
being tidied up later.

**Keep `-var="live_debug_transcript=1"` on every apply** while that flag is
meant to be on. It is not in `terraform.tfvars` — it is declared in
`variables.tf` with `default = ""` and passed on the command line, so any apply
that omits it silently turns it off.

Then rebuild and republish the frontend, so the bundle's own `VITE_SITE_URL`
matches the origin it is served from:

```
cd AI-phone-dashboard/frontend
VITE_API_URL=<dashboard-api url> VITE_SITE_URL=https://app.vetratd.com npx vite build
node scripts/deploy-hosting.js --dir dist --site vetra-core-edc8ca --project vetra-core-edc8ca
```

## What does NOT change

`dashboard_url` stays on `https://vetra-core-edc8ca.web.app/app` until that
last step, so nothing breaks while DNS is pending. The `.web.app` origin is
never removed from `dashboard_domains` — it stays a working way in.

---

# One codebase, two sites

Discovered 2026-09-08, and it corrects an assumption this document previously
stated as fact.

**`vetratd.com` is not a different codebase.** It is this same React frontend,
deployed to Vercel, **auto-deploying from this repository**. Its bundle carries
our `landing-hero-cta` class and our page title. It was built from an older
commit with **empty `VITE_*` variables** — no Firebase project id, no API URL
anywhere in it — which is why `vetratd.com/app` loaded a dashboard that could
not initialise Firebase and died silently. That is the "Log in button does
nothing" report.

The earlier claim that the apex "belongs to the friend's rebuild" came from a
comment in `terraform.tfvars` and was repeated here without checking.

## Why this was about to get worse

The dashboard moved to `/` and the Landing page was retired from the router.
Because Vercel builds this repository on push, **merging that to `main` would
have rebuilt `vetratd.com` as a login screen** — the public marketing site
replaced, silently, with nothing in the repo mentioning Vercel to explain why.

## The split, made deliberate

`VITE_BUILD_TARGET` selects the route table (`src/siteUrl.js`,
`src/routes.jsx`):

| target | deployed to | `/` | `/app`, `/login`, `/signin` |
|---|---|---|---|
| `marketing` (**default**) | vetratd.com, Vercel | Landing | leave the origin → `app.vetratd.com` |
| `app` | app.vetratd.com, Firebase | dashboard | redirect to `/` |

**The default is `marketing`, and the asymmetry is the point.** Vercel builds
with whatever environment it happens to have and this repository cannot set it;
if the flag goes missing there, the public domain keeps serving marketing, which
is merely stale. Were the default `app`, a forgotten variable would replace
vetratd.com with a login screen on the next push. The Firebase build passes the
flag explicitly, and if THAT is ever forgotten the dashboard serves a marketing
page — wrong, but obvious within seconds. The loud failure is the one to choose.

Vite tree-shakes the unused half: the app build carries no Landing page
(234 kB against the marketing build's 267 kB).

Marketing's `/app` is an **external** redirect, not `<Navigate>` — which routes
inside the SPA and would 404 on an absolute URL. That rescues every stale
`vetratd.com/app` link already in nav bars, bookmarks and inboxes.

## What Vercel needs set

The build works without these; the SITE does not.

| variable | value | why |
|---|---|---|
| `VITE_API_URL` | the `dashboard-api-uk-prod` URL | **the contact form posts here.** Unset, it falls back to `http://localhost:3001` and fails silently — and "Get started" now leads to that form |
| `VITE_APP_URL` | `https://app.vetratd.com` | optional; this is already the default |
| `VITE_BUILD_TARGET` | **leave unset** | the default is `marketing`, which is what Vercel should build |

CORS needs no change: `https://vetratd.com` and `https://www.vetratd.com` are
permanent entries in the dashboard API's allow-list
(`AI-phone-dashboard/backend/src/server.js`), independent of `CORS_ORIGINS`.

## Building the app target

Never publish to Firebase Hosting without the flag:

```
cd AI-phone-dashboard/frontend
VITE_BUILD_TARGET=app VITE_API_URL=<dashboard-api url> \
VITE_FIREBASE_API_KEY=... VITE_FIREBASE_AUTH_DOMAIN=... VITE_FIREBASE_PROJECT_ID=... \
  npx vite build

# Two guards worth running before publishing:
grep -rl "landing-hero-cta" dist/assets/*.js && echo "ABORT: marketing build"
grep -rl "localhost:3001"   dist/assets/*.js && echo "ABORT: localhost baked in"

node scripts/deploy-hosting.js --dir dist --site vetra-core-edc8ca --project vetra-core-edc8ca
```
