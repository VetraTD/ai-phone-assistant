import { describe, it, expect } from "vitest";
import { createDispatchEnqueuer } from "../lib/outbound/tasks.js";

function fakeClient() {
  const made = [];
  return {
    made,
    createTask: async ({ parent, task }) => {
      if (made.some((t) => t.task.name === task.name)) { const e = new Error("exists"); e.code = 6; throw e; }
      made.push({ parent, task }); return [task];
    },
  };
}
const Q = "projects/vetra-uk-edc8ca/locations/europe-west2/queues/outbound-dispatch";
const mk = (client) => createDispatchEnqueuer({ client, queuePath: Q, serviceUrl: "https://svc.example", serviceAccountEmail: "outbound-tasks@x.iam.gserviceaccount.com" });

describe("createDispatchEnqueuer", () => {
  it("creates an OIDC-authenticated POST to /internal/outbound/dispatch scheduled at `at`", async () => {
    const c = fakeClient();
    await mk(c).enqueue({ businessId: "b1", outreachId: "o1", at: new Date("2026-09-28T13:00:00Z"), source: "dispatch" });
    const t = c.made[0].task;
    expect(c.made[0].parent).toBe(Q);
    expect(t.httpRequest.url).toBe("https://svc.example/internal/outbound/dispatch");
    expect(t.httpRequest.oidcToken).toEqual({ serviceAccountEmail: "outbound-tasks@x.iam.gserviceaccount.com", audience: "https://svc.example" });
    expect(JSON.parse(Buffer.from(t.httpRequest.body, "base64").toString())).toEqual({ business_id: "b1", outreach_id: "o1" });
    expect(Number(t.scheduleTime.seconds)).toBe(Date.parse("2026-09-28T13:00:00Z") / 1000);
  });
  it("the same outreach + time enqueued twice is one task (dedupe by name), and says so", async () => {
    const c = fakeClient(); const q = mk(c);
    const at = new Date("2026-09-28T13:00:00Z");
    expect(await q.enqueue({ businessId: "b1", outreachId: "o1", at, source: "dispatch" })).toEqual({ created: true });
    expect(await q.enqueue({ businessId: "b1", outreachId: "o1", at, source: "dispatch" })).toEqual({ created: false });
    expect(c.made).toHaveLength(1);
  });
  it("a sweep re-enqueue gets its own name, so a tombstoned dispatch name cannot block the rescue (C14)", async () => {
    const c = fakeClient(); const q = mk(c);
    const at = new Date("2026-09-28T13:00:00Z");
    await q.enqueue({ businessId: "b1", outreachId: "o1", at, source: "dispatch" });
    expect(await q.enqueue({ businessId: "b1", outreachId: "o1", at, source: "sweep", now: new Date("2026-09-28T13:07:00Z") })).toEqual({ created: true });
  });
  // Checkpoint 2a, M4. Cloud Tasks takes whole seconds. Flooring a due time
  // with a fraction fires the task up to 999 ms BEFORE it is due; the
  // re-deferral then enqueues the same outreach at the same due ms -- the
  // same task NAME, which ALREADY_EXISTS swallows. Round up instead.
  it("a due time with a 500 ms fraction is scheduled at the NEXT whole second, never before it", async () => {
    const c = fakeClient();
    await mk(c).enqueue({ businessId: "b1", outreachId: "o1", at: new Date("2026-09-28T13:00:00.500Z"), source: "dispatch" });
    expect(Number(c.made[0].task.scheduleTime.seconds)).toBe(Date.parse("2026-09-28T13:00:01Z") / 1000);
  });
  it("any other error propagates", async () => {
    const client = { createTask: async () => { const e = new Error("perm"); e.code = 7; throw e; } };
    await expect(mk(client).enqueue({ businessId: "b1", outreachId: "o1", at: new Date(), source: "dispatch" })).rejects.toThrow("perm");
  });
});
