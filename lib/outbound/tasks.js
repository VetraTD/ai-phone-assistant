/**
 * Cloud Tasks is the alarm clock (spec §5, §10.2). One queue,
 * `outbound-dispatch`, europe-west2. Dedupe by task NAME: the same outreach at
 * the same due time is one task. Sweep re-enqueues get a 5-minute bucket
 * suffix instead (C14) -- a completed task's name stays reserved for up to an
 * hour, so reusing it would block exactly the rescue the sweep exists for.
 * ALREADY_EXISTS (gRPC 6) is success, reported as {created:false}.
 */
export function createDispatchEnqueuer({ client, queuePath, serviceUrl, serviceAccountEmail }) {
  const url = `${serviceUrl.replace(/\/$/, "")}/internal/outbound/dispatch`;
  return {
    async enqueue({ businessId, outreachId, at, source = "dispatch", now = new Date() }) {
      const due = at instanceof Date ? at : new Date(at);
      const suffix = source === "sweep" ? `-s${Math.floor(now.getTime() / 300_000)}` : "";
      const name = `${queuePath}/tasks/d-${outreachId}-${due.getTime()}${suffix}`;
      const task = {
        name,
        // Rounded UP (Checkpoint 2a, M4): a floored second fires up to 999 ms
        // before the due time, and the re-deferral collides with this name.
        scheduleTime: { seconds: Math.ceil(due.getTime() / 1000) },
        httpRequest: {
          httpMethod: "POST",
          url,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify({ business_id: businessId, outreach_id: outreachId })).toString("base64"),
          oidcToken: { serviceAccountEmail, audience: serviceUrl.replace(/\/$/, "") },
        },
      };
      try {
        await client.createTask({ parent: queuePath, task });
        return { created: true };
      } catch (err) {
        if (err?.code === 6) return { created: false };
        throw err;
      }
    },
  };
}

/**
 * S3-8: the results-channel delivery task, one per outbox row. Same queue,
 * same dedupe-by-name idea as the dispatch enqueuer above, but keyed on the
 * outbox row's own id + its `next_attempt_at` (rounded to the second) rather
 * than on an outreach id -- a retried delivery at a LATER backoff slot is
 * a different task name, never a collision with (and never cancelling) the
 * one still in flight for an earlier slot. `ALREADY_EXISTS` (gRPC 6) is
 * success here too: the delivery task handler itself is what re-enqueues the
 * NEXT attempt after a failure (lib/outbound/internalRoutes.js), so a
 * duplicate for the SAME slot is the sweep's per-tenant backstop finding a
 * task that was, in fact, already there.
 */
export function createWebhookDeliveryEnqueuer({ client, queuePath, serviceUrl, serviceAccountEmail }) {
  const url = `${serviceUrl.replace(/\/$/, "")}/internal/outbound/webhook-deliver`;
  return {
    async enqueue({ businessId, outboxId, at }) {
      const due = at instanceof Date ? at : new Date(at);
      const name = `${queuePath}/tasks/w-${outboxId}-${Math.ceil(due.getTime() / 1000)}`;
      const task = {
        name,
        scheduleTime: { seconds: Math.ceil(due.getTime() / 1000) },
        httpRequest: {
          httpMethod: "POST",
          url,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify({ business_id: businessId, outbox_id: outboxId })).toString("base64"),
          oidcToken: { serviceAccountEmail, audience: serviceUrl.replace(/\/$/, "") },
        },
      };
      try {
        await client.createTask({ parent: queuePath, task });
        return { created: true };
      } catch (err) {
        if (err?.code === 6) return { created: false };
        throw err;
      }
    },
  };
}
