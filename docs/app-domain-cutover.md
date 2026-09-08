# app.vetratd.com — the dashboard's own origin

Status: **waiting on DNS.** Everything on the GCP side is done and applied.

`vetratd.com` stays on Vercel and belongs to the site rebuild. GCP serves only
the dashboard, on its own subdomain.

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

## The last step, AFTER the certificate is live

Sign in on `https://app.vetratd.com/app` and confirm it works **before**
flipping anything. Then, and only then:

```hcl
# infra/terraform/terraform.tfvars
dashboard_url = "https://app.vetratd.com/app"
```

```
cd infra/terraform && CLOUDSDK_CONFIG=~/.gcloud-vetra2 TF_DISABLE_PLUGIN_TLS=1 \
  terraform apply -var="image_tag=<current>" -var="dashboard_image_tag=<current>" \
                  -var="live_debug_transcript=1"
```

**Keep the `/app` path.** Firebase rewrites `**` to `index.html` and the SPA
routes client-side: `/` is the marketing landing page, `/app` is the dashboard.
A bare origin sends a member of staff who clicked "you have a new appointment"
to a marketing page.

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
