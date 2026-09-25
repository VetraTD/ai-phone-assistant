// tests/outboundLazyTasksImport.test.js
/**
 * Checkpoint 2a, M9. lib/outbound/internalRoutes.js imported
 * `@google-cloud/tasks` (gRPC) at the top, and server.js imports that module
 * whether or not outbound is configured -- so every INBOUND boot paid for it
 * (measured at review: +52 ms, +17 MB). It is now loaded on first enqueue,
 * the lib/voice/sttGoogle.js pattern.
 *
 * How this can tell: the package is mocked with a factory that COUNTS its own
 * evaluations. vitest runs a mock factory when something first imports the
 * specifier -- a static import anywhere in server.js's graph runs it at
 * import time; a lazy `await import()` runs it only when that line executes.
 * Both ends are real: the real server.js graph, and the real buildOutboundDeps
 * enqueue path resolving the real specifier (to this mock).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const state = vi.hoisted(() => ({ loads: 0, created: [] }));

vi.mock("@google-cloud/tasks", () => {
  state.loads++;
  return {
    CloudTasksClient: class {
      async createTask(req) { state.created.push(req); return [req.task]; }
    },
  };
});

const ENV_KEYS = ["OUTBOUND_TASKS_QUEUE", "OUTBOUND_TASKS_SA", "OUTBOUND_TEST_ALLOWLIST"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(() => {
  // Outbound UNCONFIGURED: today's production posture for the inbound service.
  for (const k of ENV_KEYS) delete process.env[k];
  vi.resetModules();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  vi.resetModules();
});

describe("@google-cloud/tasks is loaded on first use, not at boot (M9)", () => {
  it("importing server.js with outbound unconfigured does not load it", async () => {
    const { app } = await import("../server.js");
    expect(app).toBeTruthy(); // the import really happened
    expect(state.loads).toBe(0);
  }, 40000);

  it("building the deps does not load it either; the first enqueue does, once, and uses its client", async () => {
    const { buildOutboundDeps } = await import("../lib/outbound/internalRoutes.js");
    const deps = buildOutboundDeps({
      BASE_URL: "https://svc.example",
      OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q",
      OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com",
    });
    expect(state.loads).toBe(0);

    const at = new Date("2026-09-28T13:00:00Z");
    expect(await deps.enqueue({ businessId: "b1", outreachId: "o1", at, source: "dispatch" })).toEqual({ created: true });
    expect(state.loads).toBe(1);
    expect(state.created).toHaveLength(1);
    expect(state.created[0].parent).toBe("projects/p/locations/l/queues/q");
    expect(state.created[0].task.httpRequest.url).toBe("https://svc.example/internal/outbound/dispatch");

    await deps.enqueue({ businessId: "b1", outreachId: "o2", at, source: "dispatch" });
    expect(state.loads).toBe(1); // one client, reused
    expect(state.created).toHaveLength(2);
  });
});
