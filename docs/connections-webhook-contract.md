# Results Webhook Contract (Outbound Calling)

This document describes the results your webhook endpoint receives about **outbound calling** activity — a campaign call was attempted, or an outreach closed. It is a different channel from [`integrations-webhook-contract.md`](./integrations-webhook-contract.md), which is the synchronous tool-call webhook the AI invokes *during* a live call. This one is asynchronous: your endpoint is notified *after the fact*, from a queue, with retries.

The channel's shape is direction-neutral (every payload below carries `"direction": "outbound"`), but as shipped it only ever fires for outbound campaign calling. Inbound calls do not use this channel.

## Setting up an endpoint

There is no dashboard for this yet. An operator sets it up with `scripts/outbound-admin.js`:

```
node scripts/outbound-admin.js webhook-set --phone +1... --url https://your-endpoint.example.com/hook \
  --secret <a random string, at least 16 characters> \
  [--events call.completed,outreach.closed] \
  [--active true|false] [--endpoint-id <uuid>] [--confirm]
```

- `--url` must be `https://`.
- `--secret` is your signing secret. It is encrypted at rest (AES-256-GCM) and is **never** printed back by this script, in a dry run or a confirmed write.
- `--events` is a comma-separated subset of the event names below. Omit it (or pass nothing) to subscribe to every event.
- Test a stored endpoint with a real, signed delivery: `node scripts/outbound-admin.js webhook-test --phone +1... --endpoint-id <uuid> --confirm`.

## Events

| Event | Fires |
|---|---|
| `call.completed` | Every dial attempt, including one that was never answered. |
| `outreach.closed` | The outreach itself closed (a terminal outcome, or the retry schedule was exhausted) — in addition to `call.completed`, on the attempt that closed it. |

## Payload

```jsonc
{
  "event": "call.completed",
  "delivery_id": "…",                  // uuid; also the X-Vetra-Delivery header
  "occurred_at": "2026-09-28T10:00:00.000Z",
  "campaign": { "id": "…", "name": "Speed to lead", "version": 3 },
  "outreach": { "id": "…", "attempt": 2, "state": "closed", "close_reason": "terminal_outcome" },
  "call": { "result": "connected", "answered_by": "human", "duration_seconds": 312 },
  "outcome": "booked",
  "contact": { "id": "…", "phone": "+447700900202", "first_name": "Sam", "external_ids": {} },
  "answers": { "clinic_name": "Digile" },
  "booking": { "start": "2026-09-29T09:00:00.000Z", "length_min": null, "appointment_id": "…" },
  "summary": "Booked a consult for Monday.",
  "next_attempt_at": null,
  "direction": "outbound"
}
```

Notes:
- `outreach.state`/`close_reason`/`next_attempt_at` describe the outreach **after** this attempt's own post-call write — `state` is `"closed"` only on the attempt that actually closed it.
- `booking` is `null` unless `outcome` is `"booked"`. `length_min` is always `null` today — the schema carries no per-appointment duration yet.
- `summary` is `null` when the outcome was decided without ever calling the summarizer (a door/tool outcome, a booking/opt-out effect, or the opt-out detector all skip it).
- `contact.phone`/`contact.first_name`/`answers` can carry personal data about the person who was called. Treat this endpoint's contents accordingly.

## Headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Vetra-Event` | The event name (`call.completed` or `outreach.closed`) |
| `X-Vetra-Delivery` | The delivery id (uuid) — also `payload.delivery_id` |
| `X-Vetra-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` |

### Verifying the signature

```
v1 = hex( HMAC-SHA256( your_secret, `${t}.${raw_request_body}` ) )
```

Compute this over the **exact bytes you received** — not a re-parsed/re-serialised copy of the JSON, which is not guaranteed to produce identical bytes. Compare with a constant-time comparison. A reference implementation (Node):

```js
const crypto = require("crypto");

function verify(header, secret, rawBody) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/i.exec(header || "");
  if (!m) return false;
  const [, t, sig] = m;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Reject a request whose `t` is far from your own clock (a reasonable window, e.g. 5 minutes) to limit replay of an old, legitimately-signed delivery.

## Delivery, retries and idempotency

- HTTPS only. The connection is made to a DNS-resolved and vetted IP address (every private/reserved range refused, including loopback, link-local, CGNAT, and IPv4-mapped IPv6 forms) — a webhook pointed at an internal address will never be reached.
- Redirects are not followed. A `3xx` response is treated as a delivery failure.
- Timeout: 6 seconds.
- Retries on a failure (a non-2xx status, a timeout, or a connection error), with backoff `1m, 5m, 30m, 2h, 12h`. After the fifth retry also fails, the delivery is marked `dead` and no further attempt is made.
- `X-Vetra-Delivery` is stable across retries of the SAME delivery — use it to de-duplicate on your side even though the signature and timestamp change per attempt.
- A duplicate event for the same (endpoint, event, attempt/outreach) is never enqueued twice on our side — treat a second delivery with the same `X-Vetra-Delivery` you have already processed as a no-op, not an error.

## Security

- Respond quickly (under 6 seconds) with any 2xx status — we do not read your response body.
- Verify the signature before trusting the payload.
- This endpoint receives personal data about the people your campaigns called. Handle it like the rest of your customer data.
