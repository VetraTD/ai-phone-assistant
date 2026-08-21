// Process A: the instance that held the call.
//
// Run as its own OS process by tests/callStateMultiProcess.test.js. It does
// what lib/voice/session.js does at a call boundary — resolves the tenant,
// creates the call row, latches sawCallerFinal — and writes only the shared
// slice. Nothing about the WebSocket, the audio queue or the Deepgram
// connection goes anywhere, because none of it means anything over here.
import { createFileStore } from "./fileCallStateStore.js";
import * as callState from "../../lib/callState.js";

const [, , storeFile, callSid, payloadJson] = process.argv;
const payload = JSON.parse(payloadJson);

callState.setStore(createFileStore(storeFile));

// Local state is populated exactly as the live session populates it, including
// the unserialisable fields, to prove they are neither needed nor written.
const state = callState.getState(callSid);
state.ws = { fake: "websocket" };
state.audioQueue = [Buffer.from([0xff, 0xfe])];
state.history = [{ role: "user", parts: [{ text: "a whole conversation" }] }];
state.dbCallId = payload.dbCallId;
state.businessId = payload.businessId;

callState.writeShared(callSid, state);

if (payload.sawCallerFinal) {
  state.sawCallerFinal = true;
  callState.writeShared(callSid, { sawCallerFinal: true });
}

// writeShared is fire-and-forget, so give its promise a tick to land before
// this process exits. In the real system nothing waits for it either — the
// difference is that a real process does not exit two milliseconds later.
await new Promise((r) => setImmediate(r));
