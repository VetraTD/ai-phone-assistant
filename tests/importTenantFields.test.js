import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { importTenant } from "../scripts/import-tenant.js";

// ---------------------------------------------------------------------------
// The tenant importer names columns. The schema is 38 migration files. Nothing
// connected the two, and the drift cost Phase 5's Gate 3 its first run:
//
//   BUSINESS_FIELDS included `voice_style`; migration 002 added that column and
//   migration 012 DROPPED it. Every INSERT therefore named a column the table
//   does not have, and the whole import failed — not one field, all of it.
//
// This is the class of bug that only appears when somebody migrates a real
// tenant, which is the worst possible moment to find it. So the list is checked
// against the migration history here instead, for free, on every run.
//
// Deliberately derived from the .sql files rather than from a live database:
// it has to work with no DATABASE_URL, in CI, and on a laptop.
// ---------------------------------------------------------------------------

const DB_DIR = path.join(process.cwd(), "database");

/** Final add/drop state of every column the migrations touch. */
function columnHistory() {
  const state = {};
  for (const f of fs.readdirSync(DB_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(path.join(DB_DIR, f), "utf8");
    for (const m of sql.matchAll(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g)) state[m[1]] = { act: "add", file: f };
    for (const m of sql.matchAll(/DROP COLUMN IF EXISTS\s+(\w+)/g)) state[m[1]] = { act: "drop", file: f };
  }
  return state;
}

function importerFields() {
  const src = fs.readFileSync(path.join(process.cwd(), "scripts", "import-tenant.js"), "utf8");
  const block = src.match(/const BUSINESS_FIELDS = \[([\s\S]*?)\];/);
  if (!block) throw new Error("BUSINESS_FIELDS not found in scripts/import-tenant.js");
  return block[1]
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trim())          // strip comments
    .map((l) => l.replace(/[",]/g, "").trim())
    .filter(Boolean);
}

// A client that records every statement. `business_directory` finds nothing, so
// the payload is a NEW business unless a test says otherwise.
function fakeClient({ existing = false } = {}) {
  const sql = [];
  return {
    sql,
    async query(text) {
      sql.push(String(text));
      if (/FROM business_directory/.test(text)) {
        return { rows: existing ? [{ business_id: "11111111-1111-1111-1111-111111111111" }] : [], rowCount: existing ? 1 : 0 };
      }
      if (/gen_random_uuid/.test(text)) return { rows: [{ id: "22222222-2222-2222-2222-222222222222" }], rowCount: 1 };
      if (/FROM businesses WHERE id/.test(text)) {
        return { rows: [{ id: "x", name: "n", phone_number: "p", timezone: "Europe/London" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}
const payloadWith = (extra = {}) => ({
  business: { name: "Example Plumbing Co", timezone: "Europe/London", phone_number: "+15550100000", ...extra },
  ignored: [],
  capabilities: [],
});
const wrote = (c) => c.sql.some((s) => /^\s*(INSERT|UPDATE)\b/i.test(s));

describe("import-tenant compliance_tier", () => {
  it("compliance_tier is an imported field", () => {
    expect(importerFields()).toContain("compliance_tier");
  });

  it("a new business with no compliance_tier is refused", async () => {
    const c = fakeClient();
    await expect(importTenant(c, payloadWith())).rejects.toThrow(/is this a healthcare business/);
    expect(wrote(c)).toBe(false);
    expect(c.sql[c.sql.length - 1]).toMatch(/ROLLBACK/);
  });

  it("a new business with no phone number and no compliance_tier is refused too", async () => {
    const c = fakeClient();
    const p = payloadWith();
    delete p.business.phone_number;
    await expect(importTenant(c, p)).rejects.toThrow(/is this a healthcare business/);
    expect(wrote(c)).toBe(false);
  });

  it("a value other than standard or hipaa is refused", async () => {
    const c = fakeClient();
    await expect(importTenant(c, payloadWith({ compliance_tier: "maybe" }))).rejects.toThrow(/is this a healthcare business/);
    expect(wrote(c)).toBe(false);
  });

  it("a new business with standard or hipaa is created", async () => {
    for (const tier of ["standard", "hipaa"]) {
      const c = fakeClient();
      await importTenant(c, payloadWith({ compliance_tier: tier }));
      expect(c.sql.some((s) => /^\s*INSERT INTO businesses/i.test(s))).toBe(true);
    }
  });

  it("an update to an existing business does not need it", async () => {
    const c = fakeClient({ existing: true });
    await importTenant(c, payloadWith());
    expect(c.sql.some((s) => /^\s*UPDATE businesses/i.test(s))).toBe(true);
  });
});

describe("import-tenant BUSINESS_FIELDS vs the migration history", () => {
  it("names no column that a migration dropped", () => {
    const history = columnHistory();
    const stale = importerFields()
      .filter((c) => history[c]?.act === "drop")
      .map((c) => `${c} (dropped by ${history[c].file})`);

    expect(stale).toEqual([]);
  });

  it("can actually detect a dropped column — the detector is not vacuous", () => {
    // Proves the test above would fail if the bug came back. Without this, a
    // regex that silently stopped matching would leave the check green forever.
    const history = columnHistory();
    expect(history.voice_style).toBeDefined();
    expect(history.voice_style.act).toBe("drop");
    expect(importerFields()).not.toContain("voice_style");
  });

  it("parses a plausible field list, so a broken regex cannot pass by finding nothing", () => {
    const fields = importerFields();
    expect(fields.length).toBeGreaterThan(15);
    expect(fields).toContain("name");
    expect(fields).toContain("phone_number");
  });
});

describe("import-tenant transfer screening fields", () => {
  it("both fields are imported, and exist in the migration history", () => {
    const fields = importerFields();
    expect(fields).toContain("transfer_screening");
    expect(fields).toContain("transfer_whisper");
    const history = columnHistory();
    expect(history.transfer_screening?.act).toBe("add");
    expect(history.transfer_whisper?.act).toBe("add");
  });

  it("they are written on an update", async () => {
    const c = fakeClient({ existing: true });
    await importTenant(c, payloadWith({ transfer_screening: true, transfer_whisper: "Press 1." }));
    const upd = c.sql.find((s) => /^\s*UPDATE businesses/i.test(s));
    expect(upd).toMatch(/transfer_screening = /);
    expect(upd).toMatch(/transfer_whisper = /);
  });

  it("screening with transfer_no_answer own_voicemail is refused before any write", async () => {
    const c = fakeClient({ existing: true });
    await expect(
      importTenant(c, payloadWith({ transfer_screening: true, transfer_no_answer: "own_voicemail" }))
    ).rejects.toThrow(/own_voicemail/);
    expect(wrote(c)).toBe(false);
  });

  it("a non-boolean screening value, or a bad whisper, is refused", async () => {
    for (const extra of [{ transfer_screening: "true" }, { transfer_whisper: "x".repeat(201) }, { transfer_whisper: "a\nb" }]) {
      const c = fakeClient({ existing: true });
      await expect(importTenant(c, payloadWith(extra))).rejects.toThrow(/transfer_/);
      expect(wrote(c)).toBe(false);
    }
  });
});
