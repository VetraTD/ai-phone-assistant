/** @type {Map<string, { history: Array<{ role: string, parts: Array<{ text: string }> }>, hasGreeted: boolean, silenceCount: number, lastProcessed?: { speechHash: string, timestamp: number, cachedTwiml?: string } }>} */
const stateByCallSid = new Map();

/**
 * Get or create conversation state for a call.
 * @param {string} callSid - Twilio Call SID
 * @returns {{ history: Array, hasGreeted: boolean, silenceCount: number, lastProcessed?: object }} Mutable state object
 */
export function getState(callSid) {
  let state = stateByCallSid.get(callSid);
  if (!state) {
    state = { history: [], hasGreeted: false, silenceCount: 0, dbCallId: null, sequenceCounter: 1 };
    stateByCallSid.set(callSid, state);
  }
  return state;
}

/**
 * Remove call state (e.g. when call ends). Call from status callback.
 * @param {string} callSid - Twilio Call SID
 */
export function remove(callSid) {
  stateByCallSid.delete(callSid);
}
