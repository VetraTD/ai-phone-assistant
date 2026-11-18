import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import * as callState from "../lib/callState.js";
import { createMemoryStore, sharedSlice } from "../lib/callStateStore.js";
import { crossProcessCallStateSuite } from "./helpers/callStateCrossProcessSuite.js";

// The cross-process contract itself lives in helpers/callStateCrossProcessSuite.js
// and is run twice: here against the file stand-in, and in
// tests/db/callStatePgStore.test.js against two genuine Postgres pools. One
// contract, two backends — a second copy written to match whatever the Postgres
// store happens to do would prove nothing about the two being interchangeable,
// which is the entire claim `CALL_STATE_STORE` makes.
//
// This half stays in the ROOT suite deliberately. It needs no container, and a
// correctness gate that only runs when Docker is up is a gate that stops
// running.

let storeFile;

beforeEach(() => {
  storeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vetra-callstate-")), "store.json");
});

afterEach(() => {
  fs.rmSync(path.dirname(storeFile), { recursive: true, force: true });
});

crossProcessCallStateSuite({
  label: "file store",
  kind: "file",
  target: () => storeFile,
  readRaw: async (callSid) => {
    const text = fs.readFileSync(storeFile, "utf8");
    return { keys: Object.keys(JSON.parse(text)[callSid] ?? {}), text };
  },
});

// ---------------------------------------------------------------------------
// Write ordering, which only became a question once the store went async.
//
// Two boundary writers, neither aware of the other: the pickup write publishes
// the whole slice (sawCallerFinal:false at that moment), and the latch
// publishes sawCallerFinal:true on the caller's first utterance. Against a Map
// they complete in issue order because they complete immediately. Against a
// connection pool they do not, and pickup-lands-last puts the latch back to
// false — which tags a short REAL call as spam, the exact failure the shared
// store exists to prevent.
// ---------------------------------------------------------------------------
describe("writeShared ordering", () => {
  /**
   * A store that resolves its FIRST merge slowly and its second immediately —
   * the reordering a pool produces, made deterministic.
   */
  function createReorderingStore() {
    const values = new Map();
    let n = 0;
    return {
      async get(sid) {
        return values.get(sid) ?? null;
      },
      async merge(sid, patch) {
        await new Promise((r) => setTimeout(r, n++ === 0 ? 40 : 0));
        values.set(sid, { ...(values.get(sid) ?? {}), ...patch });
      },
      async delete(sid) {
        values.delete(sid);
      },
    };
  }

  it("the latch survives a store that resolves writes out of order", async () => {
    const store = createReorderingStore();
    callState.setStore(store);

    // Exactly what session.js does, in exactly that order.
    callState.writeShared("CA_order", { dbCallId: "d", businessId: "b", sawCallerFinal: false });
    callState.writeShared("CA_order", { sawCallerFinal: true });

    await callState.flushShared("CA_order");
    expect(await store.get("CA_order")).toEqual({ dbCallId: "d", businessId: "b", sawCallerFinal: true });
  });

  // SABOTAGE. The same two writes with the queue bypassed — proof the assertion
  // above is testing the queue and not the store. If this ever goes green, the
  // test above has stopped meaning anything.
  it("SABOTAGE: without the queue those same two writes lose the latch", async () => {
    const store = createReorderingStore();

    await Promise.all([
      store.merge("CA_order_raw", { dbCallId: "d", businessId: "b", sawCallerFinal: false }),
      store.merge("CA_order_raw", { sawCallerFinal: true }),
    ]);

    expect((await store.get("CA_order_raw")).sawCallerFinal).toBe(false);
  });

  afterEach(() => {
    // Every other test in this file runs child processes and is unaffected, but
    // leaving a fake store installed in this one would be a trap for the next.
    callState.setStore(createMemoryStore());
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
