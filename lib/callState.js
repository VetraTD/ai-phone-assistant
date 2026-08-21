import { createMemoryStore, sharedSlice } from "./callStateStore.js";
import { log } from "./logger.js";

/**
 * LOCAL state, this process only. Holds the WebSocket, the Deepgram
 * connection, the audio queue — things that are meaningless anywhere else.
 *
 * The three fields another process needs live in the store below. See
 * lib/callStateStore.js for why the split exists and why it is three fields.
 */
/** @type {Map<string, object>} */
const stateByCallSid = new Map();

/** @type {import("./callStateStore.js").CallStateStore} */
let store = createMemoryStore();

/**
 * Swap the shared store. B2 passes a Memorystore-backed one; tests pass
 * whatever they need to prove a second process can read what the first wrote.
 * @param {import("./callStateStore.js").CallStateStore} next
 */
export function setStore(next) {
  store = next;
}

/**
 * Read the shared slice — the call-boundary read, done by a process that did
 * NOT handle the call.
 *
 * Returns `{}` rather than null when nothing is stored, so every caller can
 * destructure without a guard. An absent record and a record with no fields
 * set mean the same thing here: we know nothing about this call.
 *
 * @param {string} callSid
 * @returns {Promise<{dbCallId?: string|null, businessId?: string|null, sawCallerFinal?: boolean}>}
 */
export async function readShared(callSid) {
  if (!callSid) return {};
  try {
    return (await store.get(callSid)) ?? {};
  } catch (err) {
    // A store that is down must not take the status handler with it. The
    // handler degrades — no summary, no spam tag — which is worse than working
    // and much better than a 500 that makes Twilio retry the callback.
    log.error("call_state_store_read_failed", { callSid, message: err?.message, severity: "warn" });
    return {};
  }
}

/**
 * Write the shared slice. Call at call BOUNDARIES — never per turn.
 *
 * Fire-and-forget by design: the caller is on a latency path and the write is
 * not something the turn depends on. A failure is logged, not awaited.
 *
 * @param {string} callSid
 * @param {object} patch - any subset of SHARED_FIELDS
 */
export function writeShared(callSid, patch) {
  if (!callSid) return;
  const slice = sharedSlice(patch);
  if (Object.keys(slice).length === 0) return;
  store.merge(callSid, slice).catch((err) => {
    log.error("call_state_store_write_failed", { callSid, message: err?.message, severity: "warn" });
  });
}

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
      // Per-capability scratchpad, keyed by pack id. Replaced the named
      // appointment fields that used to live directly on call state — a
      // capability remembers what it established with this caller without the
      // engine holding a field for it.
      capabilityState: {},
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
      // turnId of the most recent turn cut short by a barge-in. Its metrics
      // were already closed as barged, so its -done mark (which Twilio still
      // echoes back, since barge-in leaves queued audio playing) must not
      // close them a second time. See session.js's "mark" handler.
      bargedTurnId: null,
      mediaStream: false,     // True when this call uses Media Streams path
      processingTurn: false,  // True while a Gemini turn is in flight (prevents concurrent calls)
      speakEpoch: 0,          // Incremented on barge-in; TTS checks this to cancel stale synthesis
      // Set true the moment STT delivers ANY non-empty caller final (both
      // pipelines) — read synchronously in-memory by /twilio/status's spam
      // heuristic (server.js) to avoid a race against the fire-and-forget
      // call_transcripts DB insert: the transcript row for a short, real
      // call may not have landed yet by the time the status callback fires,
      // but this flag is set live during the call, well before it ends.
      sawCallerFinal: false,
      // How many caller utterances have been handed to the LLM on this call,
      // and whether any action tool has ever succeeded on it.
      //
      // Both gate end_call (services/tools.js). The gate used to accept only
      // step confirm/ending or an action completed in the SAME turn, which no
      // message-taking or informational call could ever satisfy — so the
      // assistant said goodbye and then could not hang up. These are the
      // call-scoped signals that make wrapping up reachable.
      callerTurnCount: 0,
      completedActionThisCall: false,
    };
    stateByCallSid.set(callSid, state);
  }
  return state;
}

/**
 * Remove call state (e.g. when call ends). Call from status callback.
 *
 * Clears BOTH halves. The local map is this process's, and dropping it on a
 * process that never held the call is a no-op — which is the normal case once
 * the status callback lands on a different instance.
 *
 * @param {string} callSid - Twilio Call SID
 */
export function remove(callSid) {
  stateByCallSid.delete(callSid);
  store.delete(callSid).catch((err) => {
    log.error("call_state_store_delete_failed", { callSid, message: err?.message, severity: "warn" });
  });
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
