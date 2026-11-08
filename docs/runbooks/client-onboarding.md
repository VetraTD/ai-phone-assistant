# Client onboarding: one form for every client

Every client gets the same form and the same steps. The answers become settings;
nothing here is specific to one business. All examples use fictional names and
reserved numbers (`+15550100000`, `example.com`).

## 1. The form

Ask these in order. Each question names the setting its answer goes in.

| Question | Setting |
|---|---|
| Is this a healthcare business? | `compliance_tier`: `hipaa` for yes, `standard` for no. **Required** for a new business: the import refuses without it. |
| What should the assistant say when it answers? (It must say it is an AI.) | `greeting` |
| What do you sell? | `general_info` (kept to 2000 characters) |
| Who rings you, and how should each kind of caller be handled? | `custom_instructions` (2000 characters, shared with the next row) |
| What should it never say or promise? | `custom_instructions` |
| What should it ask a new enquiry? | `messages` capability, `notes` (2000 characters) |
| Who gets back to callers, and how soon? | `messages` capability, `callbackLine` |
| Where should call notes go? | `notification_email` |
| Your own mobile number | `notification_phone` |
| Does your phone ring first, or do calls come straight to us? | The number's fallback URL, with or without `n=` (see `docs/runbooks/twilio-fallback.md`, section 5) |
| Should it book? Length, days, times? | `appointments` capability, its `availability`, and `business_hours` |
| Should it ever transfer? To which number that does not forward to us? | `transfer_policy`, `transfer_phone_number` |
| What about after hours? | `after_hours_policy` |

Payload shape: `scripts/import-tenant.js` (header comment). The `business` keys
are database column names; `capabilities` entries are
`{ "capability_id": "...", "enabled": true, "config": { ... } }`.

## 2. Steps

1. Fill in the form with the client.
2. Build the payload JSON **outside the repo** (it holds the client's details).
3. Prompt check, offline, no keys needed:
   `node scripts/render-tenant-prompt.js <payload.json>`
   Read the prompt. It must end with `WARNINGS  none`. A warning means text the
   client wrote is cut off silently (2000-character limits) and must be shortened.
4. Back up before touching a live tenant: `scripts/set-business-config.js --to <number> --show`
   and `scripts/db-inspect.js --counts` (both run through the migrate job, as
   their headers describe).
5. Import with `scripts/import-tenant.js` through the migrate job. A new
   business is refused until `compliance_tier` is set.
6. Read back the result the importer prints (`EVIDENCE` lines), and
   `db-inspect.js --business <number>`.
7. In the Twilio console, confirm the number's `statusCallback` points at the
   voice service's `/twilio/status`, and paste the fallback URL as decided in the
   form (`docs/runbooks/twilio-fallback.md`). A UK number is handled by
   `scripts/uk-number.js` where that applies.
8. Make a test call from a phone that is not the transfer number.
9. Give the client a dashboard login with `scripts/onboard-tenant.js` (it uses
   `scripts/attach-tenant-user.js` for the database half). Import first, login
   second: never let the client sign up in the dashboard before the import.
