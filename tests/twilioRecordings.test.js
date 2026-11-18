import { describe, it, expect, vi, beforeEach } from "vitest";

// O28 — the vendor half of an Art. 17 erasure.
//
// server.js's degraded voicemail path takes a RecordingUrl and files it into a
// customer_requests message. The AUDIO lives at Twilio, and eraseCallerData
// deletes rows in our database only — so an erasure reported success while
// leaving the data subject's recorded voice with a third party indefinitely.

const create = vi.fn();
const remove = vi.fn();

vi.mock("twilio", () => ({
  default: vi.fn(() => ({
    recordings: (sid) => ({ remove: () => remove(sid) }),
  })),
}));

let mod;
beforeEach(async () => {
  vi.resetModules();
  create.mockReset();
  remove.mockReset();
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "token";
  mod = await import("../services/twilioRecordings.js");
});

describe("finding the recording behind a stored URL", () => {
  it("reads the SID out of the URL the voicemail path stores", () => {
    expect(
      mod.recordingSidFromUrl(
        "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/RE1234567890abcdef1234567890abcdef"
      )
    ).toBe("RE1234567890abcdef1234567890abcdef");
  });

  it("reads it out of the message text the request row actually holds", () => {
    // server.js stores `Voicemail recording: <url>`, not a bare URL. Parsing the
    // stored FORM rather than an idealised one is the point — the erasure has
    // to work against what is in the column.
    const sids = mod.recordingSidsInText(
      "Voicemail recording: https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/REaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    expect(sids).toEqual(["REaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("tolerates the media extension Twilio appends", () => {
    expect(
      mod.recordingSidFromUrl(
        "https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings/REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp3"
      )
    ).toBe("REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("returns null for anything that is not a recording URL", () => {
    // A message column is free text a caller's words can land in. It must not
    // be possible for a transcript to name something deletable.
    for (const junk of ["", null, "hello", "https://example.com/RE123", "RE123"]) {
      expect(mod.recordingSidFromUrl(junk)).toBeNull();
    }
  });

  it("finds every recording in a multi-line body, without duplicates", () => {
    const sids = mod.recordingSidsInText(
      `Voicemail recording: https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/REcccccccccccccccccccccccccccccccc
       Voicemail recording: https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/REdddddddddddddddddddddddddddddddd
       Voicemail recording: https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/REcccccccccccccccccccccccccccccccc`
    );
    expect(sids).toEqual([
      "REcccccccccccccccccccccccccccccccc",
      "REdddddddddddddddddddddddddddddddd",
    ]);
  });
});

describe("deleting recordings", () => {
  const SID_A = "REaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SID_B = "REbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("deletes each one and reports them deleted", async () => {
    remove.mockResolvedValue(true);
    const result = await mod.deleteRecordings([SID_A, SID_B]);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(result.deleted).toEqual([SID_A, SID_B]);
    expect(result.failed).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("treats an already-deleted recording as success, so a retry converges", async () => {
    // Erasure must be safely re-runnable: an operator whose first attempt half
    // failed will run it again, and a 404 on the half that worked must not make
    // the second attempt report a failure forever.
    const gone = Object.assign(new Error("not found"), { status: 404 });
    remove.mockRejectedValue(gone);
    const result = await mod.deleteRecordings([SID_A]);
    expect(result.alreadyGone).toEqual([SID_A]);
    expect(result.failed).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports a real failure without throwing", async () => {
    remove.mockRejectedValue(Object.assign(new Error("service unavailable"), { status: 503 }));
    const result = await mod.deleteRecordings([SID_A]);
    expect(result.failed).toEqual([SID_A]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/503|unavailable/i);
  });

  it("keeps going after one failure rather than abandoning the rest", async () => {
    // Stopping at the first error would leave recordings at Twilio that could
    // have been deleted, and the operator has no way to know which.
    remove.mockImplementation((sid) =>
      sid === SID_A
        ? Promise.reject(Object.assign(new Error("boom"), { status: 500 }))
        : Promise.resolve(true)
    );
    const result = await mod.deleteRecordings([SID_A, SID_B]);
    expect(result.failed).toEqual([SID_A]);
    expect(result.deleted).toEqual([SID_B]);
    expect(result.ok).toBe(false);
  });

  it("is a no-op success when there is nothing to delete", async () => {
    const result = await mod.deleteRecordings([]);
    expect(remove).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("names no PHI in what it reports", async () => {
    // The result is logged and returned in an HTTP body. A recording SID is a
    // Twilio identifier; the audio behind it is not, and neither is the number
    // that left it.
    remove.mockRejectedValue(new Error("boom"));
    const result = await mod.deleteRecordings([SID_A]);
    expect(JSON.stringify(result)).not.toMatch(/\+?1?555/);
  });
});

describe("when Twilio is not configured", () => {
  it("fails rather than silently reporting nothing to do", async () => {
    // The dangerous shape is "no client, so no recordings, so complete". An
    // unconfigured vendor cannot prove the audio is gone, and an erasure that
    // cannot prove it must not claim it.
    vi.resetModules();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    const unconfigured = await import("../services/twilioRecordings.js");

    expect(unconfigured.isConfigured()).toBe(false);
    const result = await unconfigured.deleteRecordings(["REaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not_configured/i);
  });

  it("is still a no-op success when there is nothing to delete", async () => {
    vi.resetModules();
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    const unconfigured = await import("../services/twilioRecordings.js");
    const result = await unconfigured.deleteRecordings([]);
    expect(result.ok).toBe(true);
  });
});
