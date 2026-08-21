import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createMemoryStore, sharedSlice, SHARED_FIELDS } from "../lib/callStateStore.js";

// A4's gate: the status handler works on a DIFFERENT PROCESS.
//
// Two real OS processes, one file between them. Process A does what the live
// session does at a call boundary; process B is a cold instance that has never
// seen the call, which on Cloud Run is the ordinary case — /twilio/status is a
// plain HTTP POST and the load balancer sends it wherever there is capacity.
//
// Two processes rather than two store handles in one, because the failure this
// guards against is precisely the one a single-process test cannot see: state
// that looks shared while it is really just the same Map.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRITER = path.join(HERE, "helpers", "callStateWriter.mjs");
const READER = path.join(HERE, "helpers", "callStateReader.mjs");

let storeFile;

beforeEach(() => {
  storeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vetra-callstate-")), "store.json");
});

afterEach(() => {
  fs.rmSync(path.dirname(storeFile), { recursive: true, force: true });
});

function runWriter(callSid, payload) {
  execFileSync(process.execPath, [WRITER, storeFile, callSid, JSON.stringify(payload)], { stdio: "pipe" });
}

function runReader(callSid) {
  const out = execFileSync(process.execPath, [READER, storeFile, callSid], { stdio: "pipe" }).toString();
  return JSON.parse(out);
}

describe("call state across two processes", () => {
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
  it("writes nothing but the three shared fields — no socket, no audio, no history", () => {
    runWriter("CA_cross_slice", { dbCallId: "call-db-6", businessId: "biz-6", sawCallerFinal: true });

    const raw = fs.readFileSync(storeFile, "utf8");
    expect(raw).not.toContain("websocket");
    expect(raw).not.toContain("a whole conversation");
    expect(Object.keys(JSON.parse(raw).CA_cross_slice).sort()).toEqual([...SHARED_FIELDS].sort());
  });
});

describe("sharedSlice", () => {
  it("keeps only the shared fields", () => {
    expect(sharedSlice({ dbCallId: "c", businessId: "b", sawCallerFinal: true, ws: {}, history: [1] })).toEqual({
      dbCallId: "c",
      businessId: "b",
      sawCallerFinal: true,
    });
  });

  // A merge that wrote `undefined` would clobber a value another writer had
  // already set. The two writers are genuinely concurrent — the tenant is
  // resolved at pickup, the latch fires whenever the caller first speaks — and
  // there is no ordering guarantee between them.
  it("drops undefined rather than writing it over an existing value", () => {
    expect(sharedSlice({ dbCallId: undefined, businessId: "b" })).toEqual({ businessId: "b" });
  });
});

describe("createMemoryStore", () => {
  it("merges rather than replaces", async () => {
    const store = createMemoryStore();
    await store.merge("CA1", { businessId: "b" });
    await store.merge("CA1", { sawCallerFinal: true });
    expect(await store.get("CA1")).toEqual({ businessId: "b", sawCallerFinal: true });
  });

  it("expires an abandoned call rather than holding it forever", async () => {
    const store = createMemoryStore({ ttlMs: -1 });
    await store.merge("CA1", { businessId: "b" });
    expect(await store.get("CA1")).toBeNull();
  });

  it("delete removes the record", async () => {
    const store = createMemoryStore();
    await store.merge("CA1", { businessId: "b" });
    await store.delete("CA1");
    expect(await store.get("CA1")).toBeNull();
  });
});
