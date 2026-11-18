import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { SHARED_FIELDS } from "../../lib/callStateStore.js";

// A4's gate, written once and run against every store that claims to implement
// it.
//
// Two real OS processes, one shared backend between them. Process A does what
// the live session does at a call boundary; process B is a cold instance that
// has never seen the call, which on Cloud Run is the ordinary case — /twilio/status
// is a plain HTTP POST and the load balancer sends it wherever there is capacity.
//
// Two processes rather than two store handles in one, because the failure this
// guards against is precisely the one a single-process test cannot see: state
// that looks shared while it is really just the same Map.
//
// The assertions live here rather than in one of the two test files so that the
// Postgres store is held to the SAME contract as the file stand-in, verbatim,
// rather than to a second contract written to match whatever it happens to do.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRITER = path.join(HERE, "callStateWriter.mjs");
const READER = path.join(HERE, "callStateReader.mjs");

/**
 * @param {object} opts
 * @param {string} opts.label                 name for the describe block
 * @param {"file"|"pg"} opts.kind
 * @param {() => string} opts.target          connection string / file path, read per test
 * @param {(callSid: string) => Promise<{keys: string[], text: string}>} opts.readRaw
 *        What the backend ACTUALLY holds for this call: the stored field names,
 *        and a serialisation of the whole record for the leak check.
 */
export function crossProcessCallStateSuite({ label, kind, target, readRaw }) {
  function runWriter(callSid, payload, ...flags) {
    execFileSync(process.execPath, [WRITER, kind, target(), callSid, JSON.stringify(payload), ...flags], {
      stdio: "pipe",
    });
  }

  function runReader(callSid) {
    const out = execFileSync(process.execPath, [READER, kind, target(), callSid], { stdio: "pipe" }).toString();
    return JSON.parse(out);
  }

  describe(`call state across two processes (${label})`, () => {
    it("a cold process recovers the call row and the tenant", () => {
      runWriter("CA_cross_1", { dbCallId: "call-db-1", businessId: "biz-1", sawCallerFinal: true });

      const { localHadNothing, shared } = runReader("CA_cross_1");

      // Without this the rest proves nothing: it confirms process B genuinely
      // has no local state for the call and is reading the store.
      expect(localHadNothing).toBe(true);
      expect(shared).toEqual({ dbCallId: "call-db-1", businessId: "biz-1", sawCallerFinal: true });
    });

    // The three things /twilio/status does with what it recovers.
    it("dbCallId survives — so the summary can be generated", () => {
      runWriter("CA_cross_summary", { dbCallId: "call-db-2", businessId: "biz-2", sawCallerFinal: true });
      expect(runReader("CA_cross_summary").shared.dbCallId).toBe("call-db-2");
    });

    it("businessId survives — so the missed-call notification can be sent", () => {
      runWriter("CA_cross_missed", { dbCallId: "call-db-3", businessId: "biz-3", sawCallerFinal: false });
      expect(runReader("CA_cross_missed").shared.businessId).toBe("biz-3");
    });

    // The one that actually broke. sawCallerFinal is set live, in memory, the
    // moment STT delivers a caller final — and the whole reason it exists is to
    // beat the fire-and-forget transcript insert. If it does not cross the
    // process boundary, a short real call reads as zero caller turns AND
    // sawCallerFinal=false, and gets tagged spam.
    it("sawCallerFinal survives — so a short real call is not tagged as spam", () => {
      runWriter("CA_cross_spam", { dbCallId: "call-db-4", businessId: "biz-4", sawCallerFinal: true });
      expect(runReader("CA_cross_spam").shared.sawCallerFinal).toBe(true);
    });

    it("a genuinely silent call still reads false, so spam detection still fires", () => {
      runWriter("CA_cross_silent", { dbCallId: "call-db-5", businessId: "biz-5", sawCallerFinal: false });
      expect(runReader("CA_cross_silent").shared.sawCallerFinal).toBe(false);
    });

    it("a call the writer never saw comes back empty rather than throwing", () => {
      runWriter("CA_other", { dbCallId: "x", businessId: "y", sawCallerFinal: true });
      expect(runReader("CA_never_happened").shared).toEqual({});
    });

    // The negative half, and the more important one: nothing unserialisable
    // leaks into the store. The writer deliberately puts a fake WebSocket, an
    // audio queue and a full conversation history on local state before writing.
    it("writes nothing but the three shared fields — no socket, no audio, no history", async () => {
      runWriter("CA_cross_slice", { dbCallId: "call-db-6", businessId: "biz-6", sawCallerFinal: true });

      const { keys, text } = await readRaw("CA_cross_slice");
      expect(text).not.toContain("websocket");
      expect(text).not.toContain("a whole conversation");
      expect(keys.sort()).toEqual([...SHARED_FIELDS].sort());
    });

    // SABOTAGE. The suite's own falsifiability check, and it is not decoration:
    // every assertion above passes against a store that shares nothing, IF the
    // reader is the same process as the writer. This is the run that proves it
    // is not — remove the boundary write and the status handler loses exactly
    // what it needs, with no error anywhere.
    it("SABOTAGE: with the boundary write removed, the cold process loses businessId", () => {
      runWriter("CA_sabotage", { dbCallId: "call-db-7", businessId: "biz-7", sawCallerFinal: true }, "--sabotage");

      const { shared } = runReader("CA_sabotage");

      expect(shared.businessId).toBeUndefined();
      expect(shared.dbCallId).toBeUndefined();
      // What that costs at the call boundary, spelled out: server.js reads
      // `shared.sawCallerFinal` through `!!`, so a lost write is not "unknown",
      // it is the affirmative claim that the caller never spoke.
      expect(!!shared.sawCallerFinal).toBe(false);
    });
  });
}
