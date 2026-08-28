// Process A: the instance that held the call.
//
// Run as its own OS process by tests/callStateMultiProcess.test.js (file store)
// and tests/db/callStatePgStore.test.js (Postgres, its own pool). It does what
// lib/voice/session.js does at a call boundary — resolves the tenant, creates
// the call row, latches sawCallerFinal — and writes only the shared slice.
// Nothing about the WebSocket, the audio queue or the Deepgram connection goes
// anywhere, because none of it means anything over here.
//
// argv: <kind> <target> <callSid> <payloadJson> [--sabotage]
//
// `--sabotage` populates local state and SKIPS the write. It is not a spare
// flag: it is how the suite proves its own assertions can fail. A test that
// cannot fail is not evidence.
import * as callState from "../../lib/callState.js";
import { storeForKind } from "./callStateStoreForKind.mjs";

const [, , kind, target, callSid, payloadJson, ...flags] = process.argv;
const payload = JSON.parse(payloadJson);
const sabotage = flags.includes("--sabotage");

const { store, close } = await storeForKind(kind, target);
callState.setStore(store);

// Local state is populated exactly as the live session populates it, including
// the unserialisable fields, to prove they are neither needed nor written.
const state = callState.getState(callSid);
state.ws = { fake: "websocket" };
state.audioQueue = [Buffer.from([0xff, 0xfe])];
state.history = [{ role: "user", parts: [{ text: "a whole conversation" }] }];
state.dbCallId = payload.dbCallId;
state.businessId = payload.businessId;

if (!sabotage) {
  callState.writeShared(callSid, state);

  if (payload.sawCallerFinal) {
    state.sawCallerFinal = true;
    callState.writeShared(callSid, { sawCallerFinal: true });
  }
}

// writeShared is fire-and-forget, so this process has to wait for it before
// exiting. In the real system nothing waits for it either — the difference is
// that a real process does not exit two milliseconds later.
//
// `flushShared` and not a sleep: a Postgres write is a real network round trip,
// and a sleep long enough to be reliable is a sleep long enough to make the
// suite slow. It waits for the ORDERED chain, so it also covers the second
// write rather than returning once the first has landed.
await callState.flushShared(callSid);

await close();
