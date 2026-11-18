import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The number API must never default to a host we do not own.
//
// numberAPI.js attaches a live Identity Platform bearer token to every request.
// Its base URL used to default to
// `https://ai-phone-assistant-production-3e90.up.railway.app` — a Railway
// service that no longer exists and whose subdomain is therefore RELEASED. The
// combination is "send a valid dashboard token to a third party who claims that
// name", which is the hazard the migration ledger's A9 recorded when it dropped
// the Vercel preview domain from the CORS allow-list.
//
// Nothing calls this today: self-serve onboarding is closed, and Onboarding.jsx
// is the only consumer. That is exactly why it needs a test — a dormant path
// with a token in it is the kind of thing that gets switched back on by someone
// who never reads this file.
// ---------------------------------------------------------------------------

vi.mock("../auth", () => ({ getAccessToken: vi.fn(async () => "a-token") }));
vi.mock("../authRetry", () => ({ attachAuthRetry: vi.fn() }));

describe("numberApi base URL", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("is relative when VITE_NUMBER_API_URL is unset, never a remote host", async () => {
    vi.stubEnv("VITE_NUMBER_API_URL", "");
    const { numberApi } = await import("../numberAPI");
    expect(numberApi.defaults.baseURL).toBe("");
  });

  it("never falls back to a railway.app host", async () => {
    vi.stubEnv("VITE_NUMBER_API_URL", "");
    const { numberApi } = await import("../numberAPI");
    expect(numberApi.defaults.baseURL).not.toMatch(/railway\.app/);
    expect(numberApi.defaults.baseURL).not.toMatch(/^https?:\/\//);
  });

  it("uses the configured host when one is given", async () => {
    vi.stubEnv("VITE_NUMBER_API_URL", "https://voice.example.com");
    const { numberApi } = await import("../numberAPI");
    expect(numberApi.defaults.baseURL).toBe("https://voice.example.com");
  });

  it("still attaches the bearer token, which is why the base URL matters", async () => {
    vi.stubEnv("VITE_NUMBER_API_URL", "");
    const { numberApi } = await import("../numberAPI");
    const handler = numberApi.interceptors.request.handlers[0].fulfilled;
    const cfg = await handler({ headers: {} });
    expect(cfg.headers.Authorization).toBe("Bearer a-token");
  });
});
