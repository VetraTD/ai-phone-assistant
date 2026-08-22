import { describe, it, expect, vi } from "vitest";
import {
  encodeBcryptHash,
  chunk,
  buildPlan,
  importBatch,
  verifyImport,
  MAX_BATCH,
} from "../scripts/import-users.js";

// ---------------------------------------------------------------------------
// The Supabase -> Identity Platform import, minus the network.
//
// Every rule this covers came out of a live probe on 2026-08-22, not the docs,
// and the two that matter are counter-intuitive enough to be worth restating:
//
//   * `accounts:batchCreate` returns HTTP 200 WITH a per-record `error[]` array
//     on partial failure. Checking the status code reports success while
//     dropping people.
//   * It IGNORES `allow_duplicate_emails` and will silently create a second
//     account on an address that already has one — after which sign-in returns
//     the LAST-imported id, repointing that person onto a different account.
//
// The bcrypt round trip itself is proven against the real service and recorded
// in the ledger; what is testable here is everything wrapped around it.
// ---------------------------------------------------------------------------

// A REAL bcrypt hash of the throwaway password "CorrectHorseBattery9", cost 10,
// taken from the live probe that proved this exact string imports into Identity
// Platform and signs in. A literal rather than a call to `bcrypt`: that package
// is native, lives only in the dashboard backend, and adding a compiled
// dependency to the root suite to generate a constant is a bad trade.
const REAL_HASH = "$2b$10$svNILS6ladTxgbWQKhv6puHnKGGPz93PLdU9r3Bd4k119cq.Cqtni";
const SUPABASE_SHAPE = "$2a$" + REAL_HASH.slice(4); // GoTrue is Go and emits $2a$

const uuid = (n) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`.slice(0, 36);

describe("encodeBcryptHash", () => {
  it("encodes a real bcrypt hash to base64url that decodes back unchanged", () => {
    const encoded = encodeBcryptHash(SUPABASE_SHAPE);
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(SUPABASE_SHAPE);
  });

  it("accepts BOTH $2a$ (Supabase/Go) and $2b$ (Node)", () => {
    // Both were confirmed to import and sign in against the live service. A
    // validator that rejected $2a$ would refuse every genuine Supabase row.
    expect(() => encodeBcryptHash(SUPABASE_SHAPE)).not.toThrow();
    expect(() => encodeBcryptHash(REAL_HASH)).not.toThrow();
  });

  it("REFUSES anything that is not a bcrypt hash", () => {
    // A Supabase export contains rows with no password (OAuth-only accounts)
    // and can contain other algorithms. Importing those produces an account
    // that exists and that nobody can ever sign in to — indistinguishable, from
    // the import's side, from success.
    for (const bad of ["", null, undefined, 42, "not-a-hash", "$2a$10$tooshort", "$1$md5$xxxx", `$2a$10$${"x".repeat(52)}`]) {
      expect(() => encodeBcryptHash(bad), String(bad)).toThrow(/not a bcrypt hash/);
    }
  });

  it("refuses a hash with a plausible but wrong cost field", () => {
    expect(() => encodeBcryptHash("$2a$XX$" + SUPABASE_SHAPE.slice(7))).toThrow();
  });
});

describe("chunk", () => {
  it("splits without losing or duplicating anything", () => {
    const items = Array.from({ length: 2500 }, (_, i) => i);
    const batches = chunk(items, MAX_BATCH);
    expect(batches.map((b) => b.length)).toEqual([1000, 1000, 500]);
    expect(batches.flat()).toEqual(items);
  });

  it("returns nothing for an empty list rather than one empty batch", () => {
    // An empty batch would be a pointless API call that returns 200 and makes
    // the run look like it did something.
    expect(chunk([], 100)).toEqual([]);
  });
});

describe("buildPlan", () => {
  const dbUsers = [
    { id: uuid(1), email: "a@clinic.test", auth_uid: null },
    { id: uuid(2), email: "b@clinic.test", auth_uid: null },
  ];

  it("plans an import that sets localId from the Supabase id", () => {
    // localId is REQUIRED and never left to the service: setting it is what
    // makes a second run upsert instead of creating a duplicate.
    const plan = buildPlan({
      exportRows: [{ id: "supa-uid-a", email: "a@clinic.test", encrypted_password: SUPABASE_SHAPE }],
      dbUsers,
      existingAccounts: new Set(),
    });
    expect(plan.toImport).toHaveLength(1);
    expect(plan.toImport[0]).toMatchObject({
      localId: "supa-uid-a",
      email: "a@clinic.test",
      emailVerified: false,
      dbUserId: uuid(1),
    });
  });

  it("SKIPS an address that already has an account", () => {
    // The duplicate-account failure mode, prevented at the only point it can
    // be: batchCreate will not refuse it and will not report it.
    const plan = buildPlan({
      exportRows: [{ id: "supa-uid-a", email: "a@clinic.test", encrypted_password: SUPABASE_SHAPE }],
      dbUsers,
      existingAccounts: new Set(["a@clinic.test"]),
    });
    expect(plan.toImport).toHaveLength(0);
    expect(plan.alreadyPresent).toEqual([{ email: "a@clinic.test" }]);
  });

  it("reports an auth account with NO staff row rather than importing it", () => {
    // It would create a login that resolves to no tenant — a 403 that reads as
    // an authorisation bug and is a missing row.
    const plan = buildPlan({
      exportRows: [{ id: "supa-uid-z", email: "stranger@clinic.test", encrypted_password: SUPABASE_SHAPE }],
      dbUsers,
      existingAccounts: new Set(),
    });
    expect(plan.toImport).toHaveLength(0);
    expect(plan.unmatched).toEqual([
      { email: "stranger@clinic.test", reason: "no users row for this address" },
    ]);
  });

  it("reports TWO export rows on one address instead of importing both", () => {
    // Same duplicate-account outcome, arriving from our own input rather than
    // from a second run.
    const plan = buildPlan({
      exportRows: [
        { id: "supa-uid-a1", email: "a@clinic.test", encrypted_password: SUPABASE_SHAPE },
        { id: "supa-uid-a2", email: "a@clinic.test", encrypted_password: SUPABASE_SHAPE },
      ],
      dbUsers,
      existingAccounts: new Set(),
    });
    expect(plan.toImport).toHaveLength(1);
    expect(plan.unusable).toHaveLength(1);
    expect(plan.unusable[0].reason).toMatch(/duplicate email/);
  });

  it("reports an unusable password instead of creating an unusable account", () => {
    const plan = buildPlan({
      exportRows: [{ id: "supa-uid-a", email: "a@clinic.test", encrypted_password: "" }],
      dbUsers,
      existingAccounts: new Set(),
    });
    expect(plan.toImport).toHaveLength(0);
    expect(plan.unusable[0].reason).toMatch(/not a bcrypt hash/);
  });

  it("accounts for EVERY export row in exactly one category", () => {
    // The property that makes the CLI's refusal meaningful: a row that fell out
    // of every bucket would be a person silently not imported.
    const exportRows = [
      { id: "1", email: "a@clinic.test", encrypted_password: SUPABASE_SHAPE },
      { id: "2", email: "b@clinic.test", encrypted_password: SUPABASE_SHAPE },
      { id: "3", email: "stranger@clinic.test", encrypted_password: SUPABASE_SHAPE },
      { id: "4", email: "", encrypted_password: SUPABASE_SHAPE },
      { id: "5", email: "a@clinic.test", encrypted_password: SUPABASE_SHAPE },
      { id: "6", email: "b@clinic.test", encrypted_password: "nope" },
    ];
    const plan = buildPlan({ exportRows, dbUsers, existingAccounts: new Set() });
    const total =
      plan.toImport.length + plan.alreadyPresent.length + plan.unmatched.length + plan.unusable.length;
    expect(total).toBe(exportRows.length);
  });
});

describe("importBatch", () => {
  const record = { localId: "u1", email: "a@clinic.test", passwordHash: "x", emailVerified: false };

  it("sends BCRYPT and the fields the API takes, and nothing else", () => {
    const post = vi.fn(async () => ({ status: 200, body: {} }));
    return importBatch({ post }, [{ ...record, dbUserId: uuid(1) }]).then(() => {
      expect(post).toHaveBeenCalledWith("/accounts:batchCreate", {
        hashAlgorithm: "BCRYPT",
        users: [record],
      });
      // dbUserId is ours, not Google's. Sending unknown fields to an API that
      // silently ignores them is how a typo becomes invisible.
      expect(post.mock.calls[0][1].users[0]).not.toHaveProperty("dbUserId");
    });
  });

  it("returns NO errors for a clean 200", async () => {
    const post = async () => ({ status: 200, body: { kind: "identitytoolkit#UploadAccountResponse" } });
    expect(await importBatch({ post }, [record])).toEqual([]);
  });

  it("SURFACES a 200 that carries a per-record error array", async () => {
    // The single most important assertion here. The live API really does return
    // 200 with `error: [{index, message}]` when some records fail, so a caller
    // that trusts the status code reports success and drops those people.
    const post = async () => ({
      status: 200,
      body: { kind: "identitytoolkit#UploadAccountResponse", error: [{ index: 0, message: "email is invalid" }] },
    });
    expect(await importBatch({ post }, [record])).toEqual([{ index: 0, message: "email is invalid" }]);
  });

  it("throws on a non-200 rather than treating it as an empty error list", async () => {
    const post = async () => ({ status: 403, body: { error: { message: "denied" } } });
    await expect(importBatch({ post }, [record])).rejects.toThrow(/batchCreate failed: 403/);
  });
});

describe("verifyImport", () => {
  const records = [
    { localId: "u1", email: "a@clinic.test" },
    { localId: "u2", email: "b@clinic.test" },
  ];

  it("is SILENT when the auth store is exactly as intended", async () => {
    // The acceptance case. Without it, every complaint below is equally
    // consistent with a verifier that complains about everything.
    const post = async () => ({
      status: 200,
      body: { users: [{ email: "a@clinic.test", localId: "u1" }, { email: "b@clinic.test", localId: "u2" }] },
    });
    expect(await verifyImport({ post }, records)).toEqual([]);
  });

  it("catches an account that was never created", async () => {
    const post = async () => ({ status: 200, body: { users: [{ email: "a@clinic.test", localId: "u1" }] } });
    expect(await verifyImport({ post }, records)).toEqual(["b@clinic.test: no account was created"]);
  });

  it("catches DUPLICATE accounts on one address", async () => {
    // batchCreate creates these silently and reports nothing. Reading the store
    // back is the only way to find out.
    const post = async () => ({
      status: 200,
      body: {
        users: [
          { email: "a@clinic.test", localId: "u1" },
          { email: "a@clinic.test", localId: "u1-duplicate" },
          { email: "b@clinic.test", localId: "u2" },
        ],
      },
    });
    const problems = await verifyImport({ post }, records);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/a@clinic\.test: 2 accounts/);
  });

  it("catches an account whose localId is NOT the one we asked for", async () => {
    // If this drifts, `users.auth_uid` points at an account that does not exist
    // and migration 036 locks that person out.
    const post = async () => ({
      status: 200,
      body: { users: [{ email: "a@clinic.test", localId: "someone-elses-id" }, { email: "b@clinic.test", localId: "u2" }] },
    });
    expect(await verifyImport({ post }, records)).toEqual([
      "a@clinic.test: localId is someone-elses-id, expected u1",
    ]);
  });

  it("throws rather than reporting clean when the lookup itself fails", async () => {
    const post = async () => ({ status: 500, body: {} });
    await expect(verifyImport({ post }, records)).rejects.toThrow(/lookup failed: 500/);
  });
});
