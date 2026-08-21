import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A1.6 gate: `hipaa` mode cannot dispatch a webhook without a recorded BAA.
//
// executeWebhook posts the tool's arguments and the caller's phone number to a
// URL the tenant typed into a settings form. In a HIPAA deployment that is a
// disclosure of PHI to a third party — the thing a Business Associate Agreement
// exists to authorise — and nothing in the code could tell whether one existed,
// because there was nowhere to record it.
//
// Migration 027 adds the record. This is the refusal.
//
// The gate is deliberately BEFORE the DNS lookup and the fetch. A blocked
// request must not resolve the hostname either: a DNS query for a tenant's
// endpoint is itself a signal to that endpoint's operator that a call is
// happening, and the whole point is that nothing leaves.

const dnsLookup = vi.fn(async () => ({ address: "93.184.216.34" }));
vi.mock("dns", () => ({
  default: { promises: { lookup: (...a) => dnsLookup(...a) } },
  promises: { lookup: (...a) => dnsLookup(...a) },
}));

const INTEGRATION = {
  id: "int-1",
  provider: "webhook",
  name: "Practice CRM",
  enabled: true,
  config: { url: "https://crm.example.com/hook", method: "POST" },
};

const PAYLOAD = {
  tool: "book_appointment",
  arguments: { name: "Jane Q Patient", dob: "1970-01-01" },
  business_id: "biz-1",
  call_id: "call-1",
  caller_phone: "+15559998888",
};

let fetchSpy;

beforeEach(() => {
  dnsLookup.mockClear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DEPLOYMENT_MODE;
  vi.resetModules();
});

async function loadWebhook(mode) {
  if (mode === undefined) delete process.env.DEPLOYMENT_MODE;
  else process.env.DEPLOYMENT_MODE = mode;
  vi.resetModules();
  return import("../integrations/webhook.js");
}

describe("DEPLOYMENT_MODE=hipaa", () => {
  it("refuses a webhook with no recorded BAA, and says why in a field nothing speaks", async () => {
    const { executeWebhook } = await loadWebhook("hipaa");
    const res = await executeWebhook(INTEGRATION, PAYLOAD);

    expect(res.success).toBe(false);
    expect(res.reason).toBe("baa_not_recorded");
  });

  // `error` is what services/tools.js hands to the model. A receptionist that
  // paraphrases "no Business Associate Agreement is recorded" out loud to a
  // patient is a defect this codebase has already shipped once, in a different
  // costume, so the model-facing string carries no internal vocabulary.
  it.each(["BAA", "Business Associate", "HIPAA", "compliance", "webhook", "integration"])(
    "the model-facing error does not contain %s",
    async (word) => {
      const { executeWebhook } = await loadWebhook("hipaa");
      const res = await executeWebhook(INTEGRATION, PAYLOAD);
      expect(res.error.toLowerCase()).not.toContain(word.toLowerCase());
    }
  );

  it("sends nothing at all — no fetch, and not even a DNS lookup", async () => {
    const { executeWebhook } = await loadWebhook("hipaa");
    await executeWebhook(INTEGRATION, PAYLOAD);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it("the refusal message names no caller and no argument", async () => {
    const { executeWebhook } = await loadWebhook("hipaa");
    const res = await executeWebhook(INTEGRATION, PAYLOAD);

    expect(JSON.stringify(res)).not.toContain("Jane Q Patient");
    expect(JSON.stringify(res)).not.toContain("+15559998888");
  });

  it("dispatches when a BAA is recorded", async () => {
    const { executeWebhook } = await loadWebhook("hipaa");
    const res = await executeWebhook(
      { ...INTEGRATION, baa_recorded_at: "2026-08-01T00:00:00.000Z", baa_reference: "MSA-2026-014" },
      PAYLOAD
    );

    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty string", ""],
    ["whitespace", "   "],
    ["null", null],
  ])("treats a %s baa_recorded_at as no BAA", async (_label, value) => {
    const { executeWebhook } = await loadWebhook("hipaa");
    const res = await executeWebhook({ ...INTEGRATION, baa_recorded_at: value }, PAYLOAD);

    expect(res.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("standard mode is untouched", () => {
  it.each([
    ["unset", undefined],
    ["explicitly standard", "standard"],
  ])("dispatches with no recorded BAA when DEPLOYMENT_MODE is %s", async (_label, mode) => {
    const { executeWebhook } = await loadWebhook(mode);
    const res = await executeWebhook(INTEGRATION, PAYLOAD);

    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("an unrecognised DEPLOYMENT_MODE", () => {
  // `DEPLOYMENT_MODE=hippa` reads, at a glance, as though it enabled the
  // protections. Falling back to `standard` would disable every one of them
  // while looking correct, so the typo is refused at boot instead — see
  // lib/bootChecks.js. This asserts the module reports it rather than
  // swallowing it.
  it("is reported as unrecognised", async () => {
    process.env.DEPLOYMENT_MODE = "hippa";
    vi.resetModules();
    const mode = await import("../lib/deploymentMode.js");
    expect(mode.isRecognised).toBe(false);
    expect(mode.IS_HIPAA_MODE).toBe(false);
  });

  it("unset is recognised and standard", async () => {
    delete process.env.DEPLOYMENT_MODE;
    vi.resetModules();
    const mode = await import("../lib/deploymentMode.js");
    expect(mode.isRecognised).toBe(true);
    expect(mode.DEPLOYMENT_MODE).toBe("standard");
    expect(mode.IS_HIPAA_MODE).toBe(false);
  });
});
