// lib/voice/afterSaveNote.js
//
// LVX192 fix 2. A caller saved a message and then kept talking: the owner's
// email carried the first save and none of the rest. At the end of the call
// this builds ONE extra detail from what the caller said after the last save,
// straight from the call's own transcript. Code only, no model call, and the
// label says what it is: unchecked transcript.
//
// Pure: facts in, an answer out. The caller's words stay in the return value
// and never reach a log.
import { isInformativeCallerTurn } from "./unsavedAnswers.js";

export const AFTER_SAVE_LABEL = "Said after the last save (unchecked transcript)";

const QUESTION_CHARS = 80;
const ANSWER_CAP = 500;

/** The last sentence of the receptionist's reply that asks something, or "". */
function lastQuestion(prevReply) {
  if (typeof prevReply !== "string") return "";
  const sentences = prevReply.match(/[^.!?]*\?/g);
  if (!sentences) return "";
  let q = sentences[sentences.length - 1].replace(/\s+/g, " ").trim().replace(/^["“”']+/, "").trim();
  if (q.length > QUESTION_CHARS) {
    q = q.slice(q.length - QUESTION_CHARS).replace(/^\S*\s+/, "").trim();
  }
  return q;
}

/**
 * @param {{ turnLog: {index:number, caller:string, prevReply:string, voiced?:boolean}[],
 *           savedThroughTurn: number,
 *           inFlight?: {caller:string, prevReply:string, voiced?:boolean}|null }} facts
 * @returns {{label:string, answer:string}|null}
 */
export function afterSaveNote({ turnLog, savedThroughTurn, inFlight } = {}) {
  const through = Number.isFinite(savedThroughTurn) ? savedThroughTurn : 0;
  const log = Array.isArray(turnLog) ? turnLog : [];
  const turns = log.filter((t) => t && t.index > through);
  // The turn in flight takes the next index. A save made during it has already
  // stamped that index as covered (savedThroughTurn past the last logged one).
  const lastIndex = log.reduce((m, t) => (t && t.index > m ? t.index : m), 0);
  if (inFlight && !(through > lastIndex)) turns.push(inFlight);

  const parts = [];
  for (const turn of turns) {
    const words = typeof turn.caller === "string" ? turn.caller.trim() : "";
    // A voiced turn with no text is informative but has nothing to write.
    if (!words || !isInformativeCallerTurn(words, turn.prevReply)) continue;
    const q = lastQuestion(turn.prevReply);
    parts.push(q ? `"${q}" — ${words}` : words);
  }
  if (!parts.length) return null;

  let answer = parts.join(" / ");
  if (answer.length > ANSWER_CAP) {
    const cut = answer.slice(0, ANSWER_CAP);
    const atWord = answer[ANSWER_CAP] === " " ? cut : cut.replace(/\s+\S*$/, "");
    answer = `${atWord.trimEnd()}…`;
  }
  return { label: AFTER_SAVE_LABEL, answer };
}
