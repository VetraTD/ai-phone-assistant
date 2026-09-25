// tests/outboundRenderWiring.test.js
/**
 * Task 14: buildOutboundDeps wires dispatch's `renderAudio` to the Gemini
 * Live renderer (lib/outbound/liveRender.js createLiveRenderAudio) instead of
 * 2a's `async () => null`. Both modules are mocked: this asserts the WIRE --
 * the dispatcher is handed the adapter the renderer module built, from the
 * real services/db.js and the env buildOutboundDeps was given. What the
 * adapter itself does is tests/outboundLiveRender.test.js.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ ADAPTER: async () => ({ opener: null, voicemail: null }) }));

// Fix round 1 (M8): no database_not_configured line from importing services/db.js.
vi.mock("../lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal()),
  log: { debug: () => {}, info: () => {}, error: () => {} },
}));
vi.mock("../lib/outbound/liveRender.js", () => ({
  createLiveRenderAudio: vi.fn(() => h.ADAPTER),
}));
vi.mock("../lib/outbound/dispatch.js", () => ({
  createDispatcher: vi.fn(() => async () => ({ status: "skipped" })),
}));

describe("buildOutboundDeps -> renderAudio", () => {
  it("hands the dispatcher the Live renderer's adapter, built with the real db and the given env", async () => {
    const { buildOutboundDeps } = await import("../lib/outbound/internalRoutes.js");
    const { createLiveRenderAudio } = await import("../lib/outbound/liveRender.js");
    const { createDispatcher } = await import("../lib/outbound/dispatch.js");
    const realDb = await import("../services/db.js");

    const env = {
      BASE_URL: "https://x.example",
      OUTBOUND_TASKS_QUEUE: "projects/p/locations/l/queues/q",
      OUTBOUND_TASKS_SA: "sa@x.iam.gserviceaccount.com",
    };
    const log = { info: vi.fn(), error: vi.fn() };
    const deps = buildOutboundDeps(env, { log, twilioClientFor: vi.fn(() => ({})) });
    await deps.dispatch({ businessId: "b", outreachId: "o" });

    expect(createDispatcher).toHaveBeenCalledTimes(1);
    expect(createDispatcher.mock.calls[0][0].renderAudio).toBe(h.ADAPTER);
    expect(createLiveRenderAudio).toHaveBeenCalledTimes(1);
    const args = createLiveRenderAudio.mock.calls[0][0];
    expect(args.db).toBe(realDb);
    expect(args.env).toBe(env);
    expect(args.log).toBe(log);
  });
});
