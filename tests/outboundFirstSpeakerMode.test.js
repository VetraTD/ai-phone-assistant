import { describe, it, expect } from "vitest";
import { resolveFirstSpeaker } from "../lib/outbound/firstSpeakerMode.js";

function fakeLog() {
  const errors = [];
  return { errors, error: (event, fields) => errors.push({ event, fields }) };
}

describe("resolveFirstSpeaker (2026-10-01: live is the default, clip is the rollback)", () => {
  it.each([[undefined], [null], [""], ["   "], ["live"], [" LIVE "], ["Live"]])("%j -> live, no log", (raw) => {
    const log = fakeLog();
    expect(resolveFirstSpeaker(raw, log)).toBe("live");
    expect(log.errors).toEqual([]);
  });

  it.each([["clip"], [" CLIP "]])("%j -> clip, no log", (raw) => {
    const log = fakeLog();
    expect(resolveFirstSpeaker(raw, log)).toBe("clip");
    expect(log.errors).toEqual([]);
  });

  it("a typo ('lvie') fails to clip -- never to the new path -- with one warn log", () => {
    const log = fakeLog();
    expect(resolveFirstSpeaker("lvie", log, { callSid: "CA1" })).toBe("clip");
    expect(log.errors).toEqual([
      { event: "outbound_first_speaker_invalid", fields: { callSid: "CA1", value: "lvie", severity: "warn" } },
    ]);
  });

  it("works without a logger", () => {
    expect(resolveFirstSpeaker("nonsense")).toBe("clip");
  });
});
