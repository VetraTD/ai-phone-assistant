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
      knowledge: [],
      integrations: [],
      callerContext: null,
      sequenceCounter: 1,
      startedAt: Date.now(),
      selectedAppointmentId: null,
      // Hold-and-redirect state (set when Gemini is processing in background)
      pendingReply: null,
      pendingSpeech: null,
      pendingSpeechHash: null,
      pendingGeminiStart: null,
      pendingRequestId: null,
      // Media Streams state (set when using WebSocket-based real-time audio)
      ws: null,               // WebSocket connection to Twilio
      streamSid: null,        // Twilio media stream SID
      deepgramConn: null,     // Active Deepgram STT connection
      aiSpeaking: false,      // True while AI audio is being sent to caller
      bargedIn: false,        // Set true when barge-in detected; resets each turn
      audioQueue: [],         // Pending mulaw Buffers awaiting send
      turnId: 0,              // Monotonic counter — used for mark events
      mediaStream: false,     // True when this call uses Media Streams path
      processingTurn: false,  // True while a Gemini turn is in flight (prevents concurrent calls)
      speakEpoch: 0,          // Incremented on barge-in; TTS checks this to cancel stale synthesis
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

// ---------------------------------------------------------------------------
// TTL cleanup — evict abandoned call states older than 60 minutes
// ---------------------------------------------------------------------------

const CALL_STATE_TTL_MS = 60 * 60 * 1000; // 60 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - CALL_STATE_TTL_MS;
  for (const [sid, state] of stateByCallSid) {
    if (state.startedAt < cutoff) {
      stateByCallSid.delete(sid);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Don't block process exit
cleanupTimer.unref();
