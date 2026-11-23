// Minting a password-reset code with Identity Platform's admin API.
//
// Identity Platform's own reset email goes out from
// noreply@vetra-core-edc8ca.firebaseapp.com with a garbled template. The
// dashboard now asks Identity Platform for the one-shot code only
// (returnOobLink) and sends the email itself, from notifications@vetratd.com.
import { describe, it, expect, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { createResetCodeMinter, metadataTokenSource } = require("../services/identityPlatform.js");

const LINK =
  "https://vetra-core-edc8ca.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=CODE-123&apiKey=k&lang=en";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function minterWith(fetchImpl, getAccessToken = async () => "sa-token") {
  return createResetCodeMinter({ projectId: "vetra-core-edc8ca", getAccessToken, fetchImpl });
}

describe("createResetCodeMinter", () => {
  it("asks for a reset LINK (not an email) for the project, and returns only the code", async () => {
    const fetchImpl = vi.fn(async () => json(200, { email: "a@example.com", oobLink: LINK }));
    const result = await minterWith(fetchImpl).mint("a@example.com");
    expect(result).toEqual({ code: "CODE-123" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://identitytoolkit.googleapis.com/v1/projects/vetra-core-edc8ca/accounts:sendOobCode");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sa-token");
    expect(init.headers["x-goog-user-project"]).toBe("vetra-core-edc8ca");
    expect(JSON.parse(init.body)).toEqual({
      requestType: "PASSWORD_RESET",
      email: "a@example.com",
      returnOobLink: true,
    });
  });

  it.each(["EMAIL_NOT_FOUND", "USER_DISABLED", "RESET_PASSWORD_EXCEED_LIMIT"])(
    "%s is a refusal about THIS address: skipped, with the reason named",
    async (code) => {
      const fetchImpl = vi.fn(async () => json(400, { error: { message: `${code} : detail about a@example.com` } }));
      expect(await minterWith(fetchImpl).mint("a@example.com")).toEqual({ skip: true, reason: code });
    }
  );

  it("any OTHER 400 is flagged as unexpected, never passed off as 'no account'", async () => {
    // OPERATION_NOT_ALLOWED (password sign-in off), CONFIGURATION_NOT_FOUND, or
    // a body the API stopped accepting would refuse EVERY address. Treated as
    // "no account", reset would silently send nothing, forever (LVX85).
    const fetchImpl = vi.fn(async () => json(400, { error: { message: "OPERATION_NOT_ALLOWED" } }));
    expect(await minterWith(fetchImpl).mint("a@example.com")).toEqual({
      skip: true,
      reason: "unexpected",
      refusal: "OPERATION_NOT_ALLOWED",
    });
  });

  it("an unreadable 400 is unexpected too, with no code", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>bad request for a@example.com</html>", { status: 400 }));
    expect(await minterWith(fetchImpl).mint("a@example.com")).toEqual({ skip: true, reason: "unexpected", refusal: null });
  });

  it("a permission failure throws a closed reason, because it is the same for every address", async () => {
    const fetchImpl = vi.fn(async () => json(403, { error: { message: "PERMISSION_DENIED for a@example.com" } }));
    await expect(minterWith(fetchImpl).mint("a@example.com")).rejects.toThrow(/^idp_refused$/);
  });

  it("a server error throws a closed reason", async () => {
    const fetchImpl = vi.fn(async () => json(503, {}));
    await expect(minterWith(fetchImpl).mint("a@example.com")).rejects.toThrow(/^idp_refused$/);
  });

  it("no token throws idp_token_failed and never calls Identity Platform", async () => {
    const fetchImpl = vi.fn();
    const minter = minterWith(fetchImpl, async () => {
      throw new Error("metadata server unreachable");
    });
    await expect(minter.mint("a@example.com")).rejects.toThrow(/^idp_token_failed$/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a 200 without a usable link is a flagged skip, not a throw", async () => {
    // Only real accounts get a 200, so answering this one differently (503)
    // would tell real accounts apart.
    const fetchImpl = vi.fn(async () => json(200, { email: "a@example.com" }));
    expect(await minterWith(fetchImpl).mint("a@example.com")).toEqual({ skip: true, reason: "no_link", refusal: null });
  });
});

describe("metadataTokenSource", () => {
  it("reads the service account token from the metadata server and caches it", async () => {
    const fetchImpl = vi.fn(async () => json(200, { access_token: "meta-tok", expires_in: 3599 }));
    const getToken = metadataTokenSource({ fetchImpl });
    expect(await getToken()).toBe("meta-tok");
    expect(await getToken()).toBe("meta-tok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    expect(init.headers["Metadata-Flavor"]).toBe("Google");
  });

  it("throws when the metadata server answers with an error", async () => {
    const getToken = metadataTokenSource({ fetchImpl: vi.fn(async () => json(404, {})) });
    await expect(getToken()).rejects.toThrow();
  });
});
