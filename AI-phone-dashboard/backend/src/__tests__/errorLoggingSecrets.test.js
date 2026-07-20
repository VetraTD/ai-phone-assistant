// Regression tests: axios errors must never be serialized wholesale to logs.
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
const GOOGLE_SECRET = "GOCSPX-SECRET-GOOGLE-CLIENT-SECRET";

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
  let app, poolQueryMock, restoreAxios, axiosPost, errorSpy;

  beforeEach(() => {
    axiosPost = vi.fn();
    restoreAxios = injectFakeAxios({ post: axiosPost });
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    ({ app, poolQueryMock } = createTestApp());
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

  it("keeps GOOGLE_CLIENT_SECRET and the auth code out of the calendar callback error log", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = GOOGLE_SECRET;
    process.env.CALENDAR_FRONTEND_REDIRECT = "https://frontend.example/app";
    axiosPost.mockRejectedValue(
      networkAxiosError(
        { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${GOOGLE_SECRET}` },
        `code=auth-code-abc&client_secret=${GOOGLE_SECRET}`
      )
    );
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("UPDATE oauth_states")) {
        return Promise.resolve({
          rows: [{ business_id: "22222222-2222-2222-2222-222222222222" }],
          rowCount: 1,
        });
      }
      return Promise.reject(new Error("unexpected query: " + sql));
    });

    const res = await request(app).get("/api/calendar/callback?code=auth-code-abc&state=nonce");

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("calendar=error");
    const output = loggedOutput();
    expect(output).toContain("calendar callback error");
    expect(output).not.toContain(GOOGLE_SECRET);
  });
});
