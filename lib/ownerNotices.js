/**
 * The owner's email for a call's saved messages, sent when Twilio's status
 * callback reports the call completed.
 *
 * Why here and not at the end of the Live session: Cloud Run runs with
 * cpu_idle = true, so CPU is throttled once a response ends, and the Live
 * `finish` path is fire-and-forget. A claim followed by a throttled send would
 * lose the email. The status handler is awaited, runs on whichever instance
 * took the callback, and already logs for Live calls.
 *
 * The flush waits `settleMs` for a write still in flight, claims this call's
 * pending rows (and any older than the claim's own 15-minute window), groups
 * them by call and sends one email per call, concurrently. A group whose send
 * failed is released so the business's next completed call retries it. Never
 * rejects: the handler must still answer 200 or Twilio retries the callback.
 *
 * The claim is a lease (migration 060): rows stay pending until this flush
 * completes them. A group that was sent, or whose business takes no notice
 * ("off"), is completed; one that failed is released. If this instance dies
 * before either, the lease runs out and the next call sends the email late
 * rather than never. A complete that fails is logged and left to the lease:
 * one duplicate email at worst, never a lost one.
 *
 * Logs and reports carry counts and ids only (LVX24).
 */
import { bumpCounter } from "./voice/metrics.js";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @returns {Promise<{ sent: number, failed: number, off: number }>} call groups
 */
export async function flushOwnerNotices({
  db,
  notifications,
  log,
  captureException,
  businessId,
  callSid,
  settleMs = 2000,
  sleep = defaultSleep,
  bump = bumpCounter,
}) {
  const totals = { sent: 0, failed: 0, off: 0 };
  if (!businessId) return totals;
  try {
    await sleep(settleMs);

    const rows = await db.withTenantSafe(
      businessId,
      () => db.claimOwnerNotices({ businessId, callSid }),
      { operation: "claimOwnerNotices", callSid, fallback: [] }
    );
    bump("owner_notice_checked");
    if (!Array.isArray(rows) || rows.length === 0) return totals;

    // Oldest first inside each group: the claim returns them in that order and
    // a Map keeps first-seen order of both groups and members. `reclaimed` is
    // the lease's own flag; it is counted here and kept out of the email's rows.
    const groups = new Map();
    let reclaimed = 0;
    for (const { reclaimed: fromExpiredLease, ...r } of rows) {
      if (fromExpiredLease === true) reclaimed += 1;
      const key = r.call_id ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    if (reclaimed > 0) {
      bump("owner_notice_reclaimed");
      log.error("owner_notice_reclaimed", { callSid, businessId, rows: reclaimed, severity: "warn" });
    }

    await Promise.all(
      [...groups.values()].map(async (group) => {
        const ids = group.map((r) => r.id);
        let outcome = "failed";
        try {
          outcome = await notifications.notifyCallRequests({ businessId, rows: group });
        } catch (err) {
          captureException?.(err, { callSid, businessId });
        }
        if (outcome === "sent") {
          totals.sent += 1;
          bump("owner_notice_sent");
        } else if (outcome === "off") {
          // Counted (final review I-3): "off" completes the rows, so without a
          // count a fleet-wide off reads the same as nothing pending.
          totals.off += 1;
          bump("owner_notice_off");
        } else {
          totals.failed += 1;
          let released = 0;
          try {
            released =
              (await db.withTenantSafe(
                businessId,
                () => db.releaseOwnerNotices({ businessId, ids }),
                { operation: "releaseOwnerNotices", callSid, fallback: 0 }
              )) || 0;
          } catch (err) {
            captureException?.(err, { callSid, businessId });
          }
          bump("owner_notice_unsent");
          log.error("owner_notice_unsent", { callSid, businessId, calls: 1, rows: ids.length, released });
        }
        // Settled for good: clear pending and the lease, or the rows are
        // claimed again once the lease runs out ("sent" would be sent twice,
        // "off" re-claimed on every call). A failed complete is left to the
        // lease: one duplicate email at worst.
        if (outcome === "sent" || outcome === "off") {
          let completed = 0;
          try {
            completed =
              (await db.withTenantSafe(
                businessId,
                () => db.completeOwnerNotices({ businessId, ids }),
                { operation: "completeOwnerNotices", callSid, fallback: 0 }
              )) || 0;
          } catch (err) {
            captureException?.(err, { callSid, businessId });
          }
          if (completed < ids.length) {
            log.error("owner_notice_uncompleted", { callSid, businessId, calls: 1, rows: ids.length, completed });
          }
        }
      })
    );
  } catch (err) {
    try {
      captureException?.(err, { callSid, businessId });
    } catch {
      // Reporting must not break the callback either.
    }
  }
  return totals;
}
