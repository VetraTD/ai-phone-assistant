// ---------------------------------------------------------------------------
// historyTrim.js — turn-aware conversation-history trimming.
//
// The engine used to bound the history it sends Gemini with a blind
// `history.slice(-40)` on ENTRIES. But a turn is 2+ entries — a caller (user)
// entry, the model's reply, and occasionally a synthetic
// `[system note — not the caller speaking: …]` user-entry that records a
// completed action (booked, cancelled). Slicing on raw entries could:
//   (a) start the window on an orphan model entry — Gemini requires history to
//       begin with a user entry — or split a user/model pair, and
//   (b) silently drop those system notes, so the model forgot it had already
//       done something and would redo or contradict it.
//
// trimHistory keeps whole turns from the end and, crucially, hoists any system
// notes that fall in the evicted region into ONE compact synthetic entry at the
// front of the result — completed-action memory is never lost, only compacted.
// It is pure: the input array and its entries are never mutated.
// ---------------------------------------------------------------------------

import { systemNoteEntry, SYSTEM_NOTE_PREFIX, SYSTEM_NOTE_SUFFIX } from "./replyState.js";

/** A history entry is a system note iff it's a `user` entry with the note prefix. */
function isSystemNote(entry) {
  const text = entry?.parts?.[0]?.text;
  return entry?.role === "user" && typeof text === "string" && text.startsWith(SYSTEM_NOTE_PREFIX);
}

/** Strip a note entry's framing back down to its inner joined text. */
function innerNoteText(entry) {
  let inner = entry.parts[0].text.slice(SYSTEM_NOTE_PREFIX.length);
  if (inner.endsWith(SYSTEM_NOTE_SUFFIX)) inner = inner.slice(0, -SYSTEM_NOTE_SUFFIX.length);
  return inner;
}

/**
 * Group history into turns. A turn opens on a real caller (non-note `user`)
 * entry; the model reply and any following note entries attach to it — mirroring
 * the push order in applyReplyState (user, model, then note). This is what makes
 * a note "belong to" the turn it followed, so it's evicted (and hoisted) with
 * that turn rather than orphaned onto the next one.
 */
function groupIntoTurns(history) {
  const groups = [];
  for (const entry of history) {
    if (entry?.role === "user" && !isSystemNote(entry)) {
      groups.push([entry]);
    } else if (groups.length > 0) {
      groups[groups.length - 1].push(entry);
    } else {
      // Defensive: history that doesn't open on a real user entry (shouldn't
      // happen in production). Keep it as its own leading group so nothing is
      // dropped and downstream never sees an undefined group.
      groups.push([entry]);
    }
  }
  return groups;
}

/**
 * Trim conversation history to the last `maxTurns` turns without ever splitting
 * a user/model pair and without ever losing a system-note entry.
 *
 * A "turn" = one caller (user) entry + the following model entry + any adjacent
 * system-note entries. System notes evicted with their turns are hoisted into
 * one compact synthetic entry at the FRONT of the result (their inner texts
 * joined, in order), so completed-action memory survives compaction.
 *
 * Contract:
 *  - At/under the limit → returns the input array unchanged (same reference).
 *  - Over the limit → a NEW array; the input and its entries are never mutated.
 *  - The result always starts with a `user`-role entry (the hoisted note is
 *    role user; otherwise the first kept turn opens on a user entry).
 *
 * @param {Array<{role:string, parts:Array<{text:string}>}>} history
 * @param {{maxTurns?: number}} [opts]
 * @returns {Array} trimmed history (or the input reference when under the limit)
 */
export function trimHistory(history, { maxTurns = 20 } = {}) {
  if (!Array.isArray(history)) return history;

  const groups = groupIntoTurns(history);
  if (groups.length <= maxTurns) return history;

  const splitAt = groups.length - maxTurns;
  const evictedGroups = groups.slice(0, splitAt);
  const keptGroups = groups.slice(splitAt);

  const evictedNotes = [];
  for (const group of evictedGroups) {
    for (const entry of group) {
      if (isSystemNote(entry)) evictedNotes.push(innerNoteText(entry));
    }
  }

  const result = [];
  if (evictedNotes.length > 0) result.push(systemNoteEntry(evictedNotes));
  for (const group of keptGroups) result.push(...group);
  return result;
}
