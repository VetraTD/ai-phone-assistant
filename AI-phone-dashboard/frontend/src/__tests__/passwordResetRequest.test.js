// The "Forgot password?" request goes to our own API now, which emails the
// link from notifications@vetratd.com. It used to call Identity Platform
// directly, which emailed from noreply@vetra-core-edc8ca.firebaseapp.com.
import { describe, it, expect, vi } from "vitest";
import { requestPasswordReset } from "../passwordResetRequest";

function respond(status, body = {}) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

describe("requestPasswordReset", () => {
  it("posts only the email to the API's reset endpoint, with no credentials", async () => {
    const fetchImpl = respond(200, { success: true });
    const result = await requestPasswordReset("owner@example.com", { apiBase: "https://api.example", fetchImpl });
    expect(result).toEqual({});
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.example/api/auth/password-reset");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "owner@example.com" });
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.credentials).toBe("omit");
  });

  it("shows the server's own wording for a malformed address", async () => {
    const fetchImpl = respond(400, { error: "Please enter a valid email address." });
    expect(await requestPasswordReset("x", { apiBase: "", fetchImpl })).toEqual({
      error: "Please enter a valid email address.",
    });
  });

  it("asks the person to wait when rate limited", async () => {
    const result = await requestPasswordReset("a@example.com", { apiBase: "", fetchImpl: respond(429, {}) });
    expect(result.error).toMatch(/too many/i);
  });

  it.each([
    ["the service is unavailable", respond(503, { error: "x" })],
    ["the network fails", vi.fn(async () => { throw new TypeError("Failed to fetch"); })],
  ])("gives a try-again message when %s", async (_label, fetchImpl) => {
    const result = await requestPasswordReset("a@example.com", { apiBase: "", fetchImpl });
    expect(result.error).toMatch(/try again/i);
  });
});
