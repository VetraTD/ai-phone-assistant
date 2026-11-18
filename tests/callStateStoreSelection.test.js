import { describe, it, expect, afterEach } from "vitest";
import * as callState from "../lib/callState.js";
import { createMemoryStore } from "../lib/callStateStore.js";

// CALL_STATE_STORE decides whether this process shares call state or only
// believes it does, and the wrong answer is invisible: the service boots, calls
// are answered normally, and /twilio/status silently loses the summary, the
// missed-call notification and the spam decision on every call whose callback
// lands on another instance.
//
// So every wrong input is a refusal, not a fallback. These are the refusals.

const fakePool = { query: async () => ({ rows: [] }) };

afterEach(() => {
  callState.setStore(createMemoryStore());
});

describe("initCallStateStore", () => {
  it("defaults to the in-process store when nothing is set", () => {
    expect(callState.initCallStateStore({ pool: fakePool, env: {} })).toBe("memory");
  });

  it("selects the Postgres store on `pg`", () => {
    expect(callState.initCallStateStore({ pool: fakePool, env: { CALL_STATE_STORE: "pg" } })).toBe("pg");
  });

  // The Terraform variable's vocabulary, not the plan's. `var.call_state_store`
  // is already "postgres" in tfvars, and that variable is what will render this
  // environment variable onto the service — so a value that reads correct to
  // whoever wrote the tfvars must not boot the wrong store.
  it("accepts `postgres`, because that is the word infra/terraform/ uses", () => {
    expect(callState.initCallStateStore({ pool: fakePool, env: { CALL_STATE_STORE: "postgres" } })).toBe("pg");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(callState.initCallStateStore({ pool: fakePool, env: { CALL_STATE_STORE: "  PG " } })).toBe("pg");
  });

  it("refuses an unrecognised value rather than defaulting to memory", () => {
    expect(() => callState.initCallStateStore({ pool: fakePool, env: { CALL_STATE_STORE: "redis" } })).toThrow(
      /is not a store/
    );
  });

  it("refuses `pg` with no pool rather than falling back", () => {
    expect(() => callState.initCallStateStore({ pool: null, env: { CALL_STATE_STORE: "pg" } })).toThrow(
      /no database pool exists/
    );
  });

  // `memorystore` is the other value var.call_state_store accepts. There is no
  // adapter for it, and the costing says not to buy one until a measurement
  // asks. It maps to the Map — which is NOT shared — so it must be loud rather
  // than convenient.
  it("maps `memorystore` to the in-process store, which is not shared", () => {
    expect(callState.initCallStateStore({ pool: fakePool, env: { CALL_STATE_STORE: "memorystore" } })).toBe("memory");
  });
});
