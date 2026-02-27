/** @type {Map<string, object>} */
const stateByCallSid = new Map();

/**
 * Call-flow steps (state machine).
 *   greeting → identify_intent → gather_details → confirm → ending
 * "ending" means say goodbye and hang up.
 */
export const STEPS = {
  GREETING: "greeting",
  IDENTIFY_INTENT: "identify_intent",
  GATHER_DETAILS: "gather_details",
  CONFIRM: "confirm",
  ENDING: "ending",
};

/**
 * Get or create conversation state for a call.
 * @param {string} callSid - Twilio Call SID
 * @returns {object} Mutable state object
 */
export function getState(callSid) {
  let state = stateByCallSid.get(callSid);
  if (!state) {
    state = {
      step: STEPS.GREETING,
      intent: null,
      config: null,
      history: [],
      silenceCount: 0,
      dbCallId: null,
      businessId: null,
      callerNumber: null,
      sequenceCounter: 1,
      startedAt: Date.now(),
    };
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
