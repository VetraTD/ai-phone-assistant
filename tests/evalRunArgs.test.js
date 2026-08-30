/**
 * The eval runner's flag surface.
 *
 * Cheap on purpose: everything else in eval/ costs real Gemini tokens to
 * exercise, so the argument parsing — which is pure, and which silently
 * changes what a whole run does — is worth covering here for free.
 */
import { describe, it, expect } from "vitest";
import { parseArgs } from "../eval/run.js";

describe("parseArgs", () => {
  it("defaults to running the judge", () => {
    // The advisory judge has always run. --no-judge is opt-OUT, so a bare
    // `npm run eval` keeps the quality read it has always had.
    expect(parseArgs([]).noJudge).toBe(false);
  });

  it("--no-judge turns it off", () => {
    expect(parseArgs(["--no-judge"]).noJudge).toBe(true);
  });

  it("composes with the flags people actually pair it with", () => {
    const o = parseArgs(["--filter", "date-without-time", "--no-judge", "--json", "out.json"]);
    expect(o.filter).toBe("date-without-time");
    expect(o.noJudge).toBe(true);
    expect(o.json).toBe("out.json");
  });

  it("keeps the other defaults intact", () => {
    const o = parseArgs([]);
    expect(o.concurrency).toBe(2);
    expect(o.matrix).toBe(false);
    expect(o.filter).toBeNull();
  });

  it("still rejects an unknown flag rather than ignoring it", () => {
    const prev = process.exitCode;
    try {
      parseArgs(["--no-judgee"]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prev;
    }
  });
});
