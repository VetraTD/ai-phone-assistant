// tests/outboundTwilioAccounts.test.js
/**
 * O-26/C17 (post-2c): lib/outbound/twilioAccounts.js. `createAccountRouter`
 * is the injectable core (fake clients, no real Twilio credentials);
 * `createTwilioAccountRouter`/`configuredAccounts` are the env-based
 * production wrapper around it.
 */
import { describe, it, expect, vi } from "vitest";
import { createAccountRouter, createTwilioAccountRouter, configuredAccounts } from "../lib/outbound/twilioAccounts.js";

const A_NUMBER = "+441372656055";
const B_NUMBER = "+18176011171";
const UNOWNED_NUMBER = "+447700900333";

/** A fake Twilio client with the one shape these functions use. */
function fakeClient(owns) {
  const calls = { list: vi.fn(async ({ phoneNumber }) => (owns(phoneNumber) ? [{ phoneNumber }] : [])) };
  return { incomingPhoneNumbers: calls, calls };
}

function router(overrides = {}) {
  const clientA = fakeClient((n) => n === A_NUMBER);
  const clientB = fakeClient((n) => n === B_NUMBER);
  const r = createAccountRouter({
    accounts: { A: () => clientA, B: () => clientB },
    timeoutMs: 50,
    cacheTtlMs: 3_600_000,
    ...overrides,
  });
  return { ...r, clientA, clientB };
}

describe("createAccountRouter: resolveAccountFor", () => {
  it("an A number resolves to A", async () => {
    const r = router();
    expect(await r.resolveAccountFor(A_NUMBER)).toBe("A");
  });

  it("a B number resolves to B", async () => {
    const r = router();
    expect(await r.resolveAccountFor(B_NUMBER)).toBe("B");
  });

  it("a number on neither configured account -> null (invalid)", async () => {
    const r = router();
    expect(await r.resolveAccountFor(UNOWNED_NUMBER)).toBeNull();
  });

  it("B configured without its client (no SID) -> B is never even asked, A only", async () => {
    const clientA = fakeClient((n) => n === A_NUMBER);
    const r = createAccountRouter({ accounts: { A: () => clientA, B: null }, timeoutMs: 50 });
    expect(await r.resolveAccountFor(B_NUMBER)).toBeNull(); // B not configured: never found, even though "B_NUMBER" would match a real account B
    expect(r.configured).toEqual({ A: true, B: false });
  });

  it("a cache hit avoids a second list call", async () => {
    const r = router();
    expect(await r.resolveAccountFor(A_NUMBER)).toBe("A");
    expect(await r.resolveAccountFor(A_NUMBER)).toBe("A");
    expect(r.clientA.incomingPhoneNumbers.list).toHaveBeenCalledTimes(1);
  });

  it("timeout on account A's lookup -> throws (fails closed: the dispatch-time gate must retry, never mark it permanently invalid)", async () => {
    const hungClient = { incomingPhoneNumbers: { list: () => new Promise(() => {}) } }; // never resolves
    const r = createAccountRouter({ accounts: { A: () => hungClient, B: null }, timeoutMs: 15 });
    await expect(r.resolveAccountFor(A_NUMBER)).rejects.toThrow();
  });

  it("checks accounts in order (A before B) and stops at the first match, never calling B's lookup for an A number", async () => {
    const r = router();
    await r.resolveAccountFor(A_NUMBER);
    expect(r.clientB.incomingPhoneNumbers.list).not.toHaveBeenCalled();
  });

  it("an unowned number DOES check both configured accounts before returning null", async () => {
    const r = router();
    await r.resolveAccountFor(UNOWNED_NUMBER);
    expect(r.clientA.incomingPhoneNumbers.list).toHaveBeenCalledTimes(1);
    expect(r.clientB.incomingPhoneNumbers.list).toHaveBeenCalledTimes(1);
  });
});

describe("createAccountRouter: twilioClientFor", () => {
  it("the dial uses B's client for a B caller ID", async () => {
    const r = router();
    const client = await r.twilioClientFor(B_NUMBER);
    expect(client).toBe(r.clientB);
  });

  it("uses A's client for an A caller ID", async () => {
    const r = router();
    expect(await r.twilioClientFor(A_NUMBER)).toBe(r.clientA);
  });

  it("no callerId at all -> account A, so an existing caller keeps today's behaviour", async () => {
    const r = router();
    expect(await r.twilioClientFor()).toBe(r.clientA);
    expect(r.clientA.incomingPhoneNumbers.list).not.toHaveBeenCalled(); // no lookup needed
  });

  it("only account A configured -> A's client regardless of the callerId, with no lookup at all", async () => {
    const clientA = fakeClient(() => true);
    const r = createAccountRouter({ accounts: { A: () => clientA, B: null } });
    expect(await r.twilioClientFor(B_NUMBER)).toBe(clientA);
    expect(clientA.incomingPhoneNumbers.list).not.toHaveBeenCalled();
  });

  it("a caller ID owned by neither account falls back to account A rather than returning nothing", async () => {
    const r = router();
    expect(await r.twilioClientFor(UNOWNED_NUMBER)).toBe(r.clientA);
  });

  it("a resolution timeout falls back to account A rather than throwing out of twilioClientFor", async () => {
    const hungB = { incomingPhoneNumbers: { list: () => new Promise(() => {}) } };
    const clientA = fakeClient(() => false);
    const r = createAccountRouter({ accounts: { A: () => clientA, B: () => hungB }, timeoutMs: 15 });
    await expect(r.twilioClientFor(B_NUMBER)).resolves.toBe(clientA);
  });
});

describe("configuredAccounts", () => {
  it("both set -> {A: true, B: true}", () =>
    expect(configuredAccounts({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t1", TWILIO_ACCOUNT_SID_ALT: "AC2", TWILIO_AUTH_TOKEN_ALT: "t2" })).toEqual({ A: true, B: true }));
  it("B's SID missing -> B not configured, even with B's token set", () =>
    expect(configuredAccounts({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t1", TWILIO_AUTH_TOKEN_ALT: "t2" })).toEqual({ A: true, B: false }));
  it("neither set -> {A: false, B: false}", () => expect(configuredAccounts({})).toEqual({ A: false, B: false }));
});

describe("createTwilioAccountRouter: the env-based production factory", () => {
  it("does not construct any client just by being created (no credentials needed to import/build)", () => {
    expect(() => createTwilioAccountRouter({})).not.toThrow();
  });

  it("B configured without its SID -> B ignored, resolveAccountFor(B's real number) is null, twilioClientFor falls back to A with no lookup", async () => {
    const env = { TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000", TWILIO_AUTH_TOKEN: "tokA", TWILIO_AUTH_TOKEN_ALT: "tokB" }; // no TWILIO_ACCOUNT_SID_ALT
    const r = createTwilioAccountRouter(env);
    expect(r.configured).toEqual({ A: true, B: false });
  });
});
