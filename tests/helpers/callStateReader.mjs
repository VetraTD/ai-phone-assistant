// Process B: the instance the status callback lands on.
//
// It has never seen this call. No WebSocket, no local state, no shared memory
// with process A — which on Cloud Run is the ordinary case, not the edge case,
// because /twilio/status is a plain HTTP POST and the load balancer picks
// whichever instance is free.
//
// It prints what it can recover, and the test asserts that is enough to run
// the three things the status handler does: the summary, the missed-call
// notification, and the spam tag.
//
// argv: <kind> <target> <callSid>
import * as callState from "../../lib/callState.js";
import { storeForKind } from "./callStateStoreForKind.mjs";

const [, , kind, target, callSid] = process.argv;

const { store, close } = await storeForKind(kind, target);
callState.setStore(store);

// Proof this really is a cold process: local state for this call is empty.
const local = callState.getState(callSid);

const shared = await callState.readShared(callSid);

process.stdout.write(
  JSON.stringify({
    localHadNothing: local.dbCallId === null && local.businessId === null && local.ws === null,
    shared,
  })
);

await close();
