// Regression test: axios errors must never be serialized wholesale to logs.
//
// A1.1 removed this file's second case with the Google Calendar OAuth callback
// it exercised. The defect class is unchanged and still guarded here — the
// contact form is now the one outbound axios call in this service that can fail
// at the network level with a credential on `err.config`.
//
// On a network-level failure (DNS, TLS, timeout) an AxiosError has no
// `.response`, so `err.response?.data || err` falls through to the error
// object itself — whose `config.headers` / `config.data` are own enumerable
// properties that console.error happily prints, dumping the outbound API key
// or bearer token into stdout and any log retention behind it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createTestApp, injectFakeAxios } from "./harness.js";

const BREVO_KEY = "xkeysib-SECRET-BREVO-KEY-must-not-be-logged";

/** An AxiosError as it looks with no HTTP response: credentials on `config`. */
function networkAxiosError(headers, data) {
  const err = new Error("getaddrinfo ENOTFOUND api.example.com");
  err.name = "AxiosError";
  err.code = "ENOTFOUND";
  err.isAxiosError = true;
  err.config = { url: "https://api.example.com/v3/send", headers, data };
  err.response = undefined;
  return err;
}

describe("network-level axios failures do not leak credentials to logs", () => {
  let app, restoreAxios, axiosPost, errorSpy;

  beforeEach(() => {
    axiosPost = vi.fn();
    restoreAxios = injectFakeAxios({ post: axiosPost });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    ({ app } = createTestApp());
  });

  afterEach(() => {
    restoreAxios();
    vi.restoreAllMocks();
  });

  /** Everything handed to console.error, rendered the way a log sink would. */
  function loggedOutput() {
    return errorSpy.mock.calls
      .map((args) =>
        args
          .map((a) => {
            if (typeof a === "string") return a;
            try {
              return JSON.stringify(a) ?? String(a);
            } catch {
              return String(a);
            }
          })
          .join(" ")
      )
      .join("\n");
  }

  it("keeps BREVO_API_KEY out of the contact-form error log", async () => {
    process.env.BREVO_API_KEY = BREVO_KEY;
    process.env.BREVO_FROM_EMAIL = "noreply@example.com";
    axiosPost.mockRejectedValue(
      networkAxiosError({ "api-key": BREVO_KEY, "Content-Type": "application/json" })
    );

    const res = await request(app)
      .post("/api/contact")
      .send({ name: "Ada", email: "ada@example.com", message: "hello" });

    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalled();
    const output = loggedOutput();
    expect(output).toContain("contact form failed");
    expect(output).not.toContain(BREVO_KEY);
  });
});
