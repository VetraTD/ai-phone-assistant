/**
 * Unit tests for lib/voice/historyTrim.js — turn-aware history trimming.
 *
 * The old blind `history.slice(-40)` on ENTRIES could (a) split a user/model
 * pair, leaving the window starting on an orphan model entry (Gemini requires
 * history to start with a user entry) and (b) silently evict the synthetic
 * `[system note …]` entries that record completed actions, so the model forgot
 * it had already booked/cancelled. trimHistory keeps whole turns from the end
 * and hoists any evicted notes into one leading synthetic entry.
 */

import { describe, it, expect } from "vitest";
import { trimHistory } from "../lib/voice/historyTrim.js";
import { systemNoteEntry, SYSTEM_NOTE_PREFIX } from "../lib/voice/replyState.js";

const userEntry = (text) => ({ role: "user", parts: [{ text }] });
const modelEntry = (text) => ({ role: "model", parts: [{ text }] });

/** Build `n` plain turns (user+model each), no notes. */
function plainTurns(n) {
  const h = [];
  for (let i = 1; i <= n; i++) {
    h.push(userEntry(`user ${i}`));
    h.push(modelEntry(`model ${i}`));
  }
  return h;
}

const isNote = (e) => e.role === "user" && e.parts[0].text.startsWith(SYSTEM_NOTE_PREFIX);
const realUserCount = (h) => h.filter((e) => e.role === "user" && !isNote(e)).length;

describe("trimHistory", () => {
  it("returns the same array reference when under the limit", () => {
    const h = plainTurns(5);
    expect(trimHistory(h, { maxTurns: 20 })).toBe(h);
  });

  it("returns the input unchanged at exactly maxTurns turns", () => {
    const h = plainTurns(20);
    const out = trimHistory(h, { maxTurns: 20 });
    expect(out).toBe(h);
    expect(out).toEqual(plainTurns(20));
  });

  it("over the limit: keeps exactly maxTurns turns and never splits a pair", () => {
    const h = plainTurns(25);
    const out = trimHistory(h, { maxTurns: 20 });

    // 20 whole turns kept, no notes -> 40 entries, no hoisted entry.
    expect(out).toHaveLength(40);
    expect(realUserCount(out)).toBe(20);

    // First entry is a user entry (Gemini requirement / turn boundary).
    expect(out[0].role).toBe("user");
    expect(isNote(out[0])).toBe(false);

    // Every user entry is immediately followed by a model entry.
    for (let i = 0; i < out.length; i += 2) {
      expect(out[i].role).toBe("user");
      expect(out[i + 1].role).toBe("model");
    }

    // The kept content is the tail of the conversation.
    expect(out[0].parts[0].text).toBe("user 6");
    expect(out.at(-1).parts[0].text).toBe("model 25");
  });

  it("keeps a system note that lives inside the retained window in place", () => {
    const h = plainTurns(3); // turns 1..3
    // Attach a note to turn 3 (pushed AFTER the user+model pair, as applyReplyState does).
    h.push(systemNoteEntry(["booked a checkup for Marcus"]));
    // ...then two more turns.
    h.push(userEntry("user 4"), modelEntry("model 4"));
    h.push(userEntry("user 5"), modelEntry("model 5"));

    const out = trimHistory(h, { maxTurns: 4 });
    // 5 turns -> keep last 4 (turns 2..5); the note is inside turn 3 which is kept.
    const noteIdx = out.findIndex(isNote);
    expect(noteIdx).toBeGreaterThan(-1);
    // No hoisted note at the front (nothing was evicted from the note region).
    expect(isNote(out[0])).toBe(false);
    // The note still sits right after turn 3's model entry.
    expect(out[noteIdx - 1].parts[0].text).toBe("model 3");
  });

  it("hoists notes from the evicted region into ONE leading entry, in order", () => {
    const h = [];
    h.push(userEntry("user 1"), modelEntry("model 1"));
    h.push(systemNoteEntry(["cancelled appt A"])); // note on turn 1 (evicted)
    h.push(userEntry("user 2"), modelEntry("model 2"));
    h.push(systemNoteEntry(["booked appt B"])); // note on turn 2 (evicted)
    // three more turns that will be kept
    for (let i = 3; i <= 5; i++) h.push(userEntry(`user ${i}`), modelEntry(`model ${i}`));

    const out = trimHistory(h, { maxTurns: 3 });

    // Leading hoisted entry present, is a system note, role user.
    expect(out[0].role).toBe("user");
    expect(isNote(out[0])).toBe(true);
    const text = out[0].parts[0].text;
    // Both inner texts survive, in original order, joined with "; ".
    expect(text).toContain("cancelled appt A");
    expect(text).toContain("booked appt B");
    expect(text.indexOf("cancelled appt A")).toBeLessThan(text.indexOf("booked appt B"));
    // It equals the canonical shape of a systemNoteEntry with both inner texts.
    expect(text).toBe(systemNoteEntry(["cancelled appt A", "booked appt B"]).parts[0].text);

    // Exactly one hoisted note; the kept region carries no evicted notes.
    expect(out.filter(isNote)).toHaveLength(1);
    // Kept content is turns 3..5.
    expect(out[1].parts[0].text).toBe("user 3");
    expect(out.at(-1).parts[0].text).toBe("model 5");
  });

  it("adds no hoisted entry when nothing with a note is evicted", () => {
    const h = plainTurns(25); // no notes anywhere
    const out = trimHistory(h, { maxTurns: 20 });
    expect(isNote(out[0])).toBe(false);
    expect(out.some(isNote)).toBe(false);
  });

  it("attaches a note to the turn it follows (adjacency), evicting with that turn", () => {
    // turn 1 (with note) then 3 plain turns; maxTurns 3 evicts only turn 1 + its note.
    const h = [];
    h.push(userEntry("user 1"), modelEntry("model 1"), systemNoteEntry(["did the thing"]));
    for (let i = 2; i <= 4; i++) h.push(userEntry(`user ${i}`), modelEntry(`model ${i}`));

    const out = trimHistory(h, { maxTurns: 3 });
    // Turn 1 evicted -> its note is hoisted, not left inline.
    expect(isNote(out[0])).toBe(true);
    expect(out[0].parts[0].text).toContain("did the thing");
    // Kept region is turns 2..4, no inline notes.
    expect(out.slice(1).some(isNote)).toBe(false);
    expect(out[1].parts[0].text).toBe("user 2");
  });

  it("never mutates the input array or its entries", () => {
    const h = [];
    h.push(userEntry("user 1"), modelEntry("model 1"), systemNoteEntry(["booked X"]));
    for (let i = 2; i <= 5; i++) h.push(userEntry(`user ${i}`), modelEntry(`model ${i}`));
    const snapshot = JSON.parse(JSON.stringify(h));

    trimHistory(h, { maxTurns: 2 });

    expect(h).toEqual(snapshot);
    expect(h).toHaveLength(snapshot.length);
  });

  it("defaults to maxTurns=20", () => {
    const h = plainTurns(25);
    const out = trimHistory(h);
    expect(realUserCount(out)).toBe(20);
  });
});
