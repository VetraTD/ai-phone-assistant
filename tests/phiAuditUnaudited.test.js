import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// What happens when a PHI access has nowhere to be recorded.
//
// The gate is on DEPLOYMENT_MODE, and it is a compliance line rather than a
// volume control — see the long comment in services/db.js recordPhiAccess. Both
// directions are tested here because a gate only ever verified in the quiet
// direction is indistinguishable from a feature that does not work.
//
// Deliberately in the root suite, not the database suite: an access with no
// accumulator never reaches a connection, so a real Postgres would prove
// nothing that this does not.

let stdout;
let restore;

function captureStdout() {
  stdout = [];
  const original = process.stdout.write;
  restore = () => {
    process.stdout.write = original;
  };
  process.stdout.write = (chunk, ...rest) => {
    stdout.push(String(chunk));
    return original.call(process.stdout, chunk, ...rest);
  };
}

/** Import a fresh services/db.js with DEPLOYMENT_MODE fixed, since it is read at import. */
async function loadDb(mode) {
  vi.resetModules();
  if (mode) process.env.DEPLOYMENT_MODE = mode;
  else delete process.env.DEPLOYMENT_MODE;
  return import("../services/db.js");
}

const ACCESS = Object.freeze({
  operation: "fetchCallTranscript",
  action: "read",
  resources: ["call_transcripts"],
});

beforeEach(() => {
  captureStdout();
});

afterEach(() => {
  restore();
  delete process.env.DEPLOYMENT_MODE;
});

describe("an unaudited PHI access", () => {
  it("is announced in hipaa mode", async () => {
    const db = await loadDb("hipaa");
    db.recordPhiAccess({ ...ACCESS });
    const out = stdout.join("");
    expect(out).toContain("phi_access_unaudited");
    // The operation is named, because a function name is not PHI and it is what
    // makes the finding actionable — somebody has to know which path to wrap.
    expect(out).toContain("fetchCallTranscript");
  });

  it("carries no PHI-typed field when it announces", async () => {
    const db = await loadDb("hipaa");
    db.recordPhiAccess({ ...ACCESS });

    // Checked as KEYS against lib/phiFields.js, not as substrings of the line.
    // A first attempt asserted the output did not contain "transcript" and
    // failed on the table name `call_transcripts` — which is a schema
    // identifier, not a patient's words. Substring matching cannot tell those
    // apart; the field list can, and it is the same list the logger and the
    // lint already share.
    const { isPhiField } = await import("../lib/phiFields.js");
    const line = stdout.map((l) => l.trim()).find((l) => l.includes("phi_access_unaudited"));
    expect(line).toBeTruthy();
    const parsed = JSON.parse(line);
    expect(Object.keys(parsed).filter(isPhiField)).toEqual([]);
  });

  it("is silent in standard mode", async () => {
    // Not a compliance defect outside the covered lane, and some PHI writes
    // happen per turn by design — an ungated line would fire on every turn of
    // every call forever.
    const db = await loadDb("standard");
    db.recordPhiAccess({ ...ACCESS });
    expect(stdout.join("")).not.toContain("phi_access_unaudited");
  });

  it("is silent when DEPLOYMENT_MODE is unset, which defaults to standard", async () => {
    const db = await loadDb(null);
    db.recordPhiAccess({ ...ACCESS });
    expect(stdout.join("")).not.toContain("phi_access_unaudited");
  });

  it("still refuses a PHI-typed field, in either mode", async () => {
    // The refusal is not a compliance-tier decision. A PHI-typed key must never
    // reach the audit path, covered lane or not.
    for (const mode of ["standard", "hipaa"]) {
      const db = await loadDb(mode);
      expect(() => db.recordPhiAccess({ ...ACCESS, clientName: "Someone" })).toThrow(/clientName/);
    }
  });
});
