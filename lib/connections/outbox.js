// lib/connections/outbox.js
/**
 * The shared results channel's pure/network half (S3-8, spec §12.5, amended
 * §19 S3-D3): the payload shape, the idempotency key, the backoff schedule,
 * and one signed, SSRF-guarded delivery attempt. The database half (the
 * `outbox`/`webhook_endpoints` reads and writes) lives in services/db.js;
 * the orchestration (insert on post-call, deliver on a Cloud Task, retry
 * from the sweep) lives in lib/outbound/postCall.js and
 * lib/outbound/internalRoutes.js. Kept separate from both so the payload
 * shape, the backoff arithmetic and the delivery attempt can each be unit
 * tested with no database and no real network.
 */
import { signPayload } from "./signer.js";
import { fetchVetted, SsrfRefusedError } from "../net/ssrfGuard.js";

/** spec §12.5: every attempt fires call.completed; a terminal outreach also fires outreach.closed. */
export const RESULTS_EVENTS = Object.freeze(["call.completed", "outreach.closed"]);

export const DELIVERY_TIMEOUT_MS = 6000;

/**
 * spec §12.5 / S3-D3: "Backoff of 1m, 5m, 30m, 2h and 12h, then dead."
 *
 * Ruling (S3-8, backoff boundary): attempts 1-5 each use one of these five
 * delays in order -- every listed number is spent on a real retry -- and a
 * SIXTH failed attempt (the schedule exhausted) marks the row dead. The
 * brief's failing-test checklist line "5 failures -> dead" is read here as
 * "the five-step schedule exhausting", which is what five delays ending in
 * "then dead" describes; `tests/connectionsOutbox.test.js` drives the
 * boundary explicitly and names this reading in a comment.
 */
export const BACKOFF_SCHEDULE_MS = Object.freeze([60_000, 300_000, 1_800_000, 7_200_000, 43_200_000]);

/**
 * The idempotency key that makes re-inserting the SAME (endpoint, event,
 * subject) row a no-op, via outbox's UNIQUE(business_id, idempotency_key).
 * `subjectId` is the attempt id for `call.completed`, the outreach id for
 * `outreach.closed` -- whichever identifies "this one occurrence" of the
 * event, so a retried post-call claim (LVX-style exactly-once elsewhere in
 * this codebase already relies on retries being possible) never produces a
 * second delivery of the same event to the same endpoint.
 * @param {{ endpointId: string, eventType: string, subjectId: string }} o
 */
export function outboxIdempotencyKey({ endpointId, eventType, subjectId }) {
  if (!endpointId || !eventType || !subjectId) {
    throw new Error("outboxIdempotencyKey: endpointId, eventType and subjectId are all required");
  }
  return `${eventType}:${subjectId}:${endpointId}`;
}

/**
 * The spec §12.5 payload shape, plus "direction":"outbound" (S3-D3: the
 * channel is direction-neutral in shape, but this task only ever produces
 * outbound events -- inbound is not wired, S3-8 brief).
 */
export function buildResultsPayload({
  event,
  deliveryId,
  occurredAt,
  campaign,
  outreach,
  call,
  outcome = null,
  contact,
  answers = {},
  booking = null,
  summary = null,
  nextAttemptAt = null,
}) {
  return {
    event,
    delivery_id: deliveryId,
    occurred_at: occurredAt,
    campaign,
    outreach,
    call,
    outcome,
    contact,
    answers,
    booking,
    summary,
    next_attempt_at: nextAttemptAt,
    direction: "outbound",
  };
}

/**
 * The next state for an outbox row that just failed delivery.
 * @param {number} attempts - total failed attempts, INCLUDING this one
 * @param {Date} [now]
 * @returns {{ status: "pending"|"dead", nextAttemptAt: Date|null }}
 */
export function nextBackoff(attempts, now = new Date()) {
  const idx = attempts - 1;
  if (idx < 0 || idx >= BACKOFF_SCHEDULE_MS.length) {
    return { status: "dead", nextAttemptAt: null };
  }
  return { status: "pending", nextAttemptAt: new Date(now.getTime() + BACKOFF_SCHEDULE_MS[idx]) };
}

/**
 * `last_error` "holds a status code or error class only" (brief) -- never a
 * vendor message. An exception's free-text `.message` can embed the
 * hostname, the IP, or the endpoint operator's own response text; a status
 * code or a short class name (timeout, ECONNREFUSED, ssrf_redirect, ...)
 * cannot.
 */
function classifyError(err) {
  if (err instanceof SsrfRefusedError) return `ssrf_${err.reason}`;
  if (err?.message === "timeout") return "timeout";
  if (typeof err?.code === "string") return err.code;
  return "error";
}

/**
 * Sign and deliver ONE outbox row to ONE endpoint. Never throws: every
 * failure mode (an SSRF refusal, a timeout, a network error, a non-2xx or
 * redirect status) comes back as `{ok:false,...}`, because the caller (the
 * delivery task handler) must turn this into an `attempts`/backoff write,
 * never an uncaught exception that leaves the row's counters stale for
 * Cloud Tasks to retry blind.
 *
 * @param {{ url: string, secret: string, eventType: string, deliveryId: string,
 *   payload: object, timeoutMs?: number, now?: () => Date,
 *   fetchImpl?: typeof fetchVetted }} o
 * @returns {Promise<{ok: boolean, status: number|null, lastError: string|null}>}
 */
export async function attemptDelivery({
  url,
  secret,
  eventType,
  deliveryId,
  payload,
  timeoutMs = DELIVERY_TIMEOUT_MS,
  now = () => new Date(),
  fetchImpl = fetchVetted,
}) {
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(now().getTime() / 1000);
  const { header } = signPayload({ secret, rawBody, timestamp });

  const headers = {
    "Content-Type": "application/json",
    "X-Vetra-Event": eventType,
    "X-Vetra-Delivery": deliveryId,
    "X-Vetra-Signature": header,
  };

  try {
    const res = await fetchImpl(url, { method: "POST", headers, body: rawBody, timeoutMs });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, lastError: null };
    return { ok: false, status: res.status, lastError: String(res.status) };
  } catch (err) {
    return { ok: false, status: null, lastError: classifyError(err) };
  }
}
