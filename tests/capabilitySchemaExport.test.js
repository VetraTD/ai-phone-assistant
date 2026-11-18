/**
 * The dashboard's generated capability schemas must match the live registry.
 *
 * The dashboard is a separate CommonJS app that cannot import the ESM registry,
 * so its settings screen renders from a generated JSON file. That is a
 * duplicate, and the reserved-tool-name list already showed what happens to
 * duplicates here: it silently went stale while packs grew past it, so a
 * business could create a webhook that shadowed a real tool.
 *
 * A stale export fails quieter than that but is still wrong: a capability the
 * engine enforces would have no settings section, so an operator would
 * configure something that does nothing, or fail to configure something that
 * does. This test turns "someone forgot to run the export script" into a red
 * build rather than a support ticket.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { buildSchemaExport, EXPORT_PATH } from "../scripts/export-capability-schemas.js";
import { listPacks } from "../capabilities/index.js";

const committed = () => JSON.parse(readFileSync(EXPORT_PATH, "utf8"));

describe("generated capability schemas", () => {
  it("the committed export exists", () => {
    expect(existsSync(EXPORT_PATH), "run: node scripts/export-capability-schemas.js").toBe(true);
  });

  it("matches the live registry exactly", () => {
    expect(committed(), "stale — run: node scripts/export-capability-schemas.js").toEqual(
      buildSchemaExport()
    );
  });

  it("covers every registered capability", () => {
    const exported = committed().capabilities.map((c) => c.id).sort();
    expect(exported).toEqual(listPacks().map((p) => p.id).sort());
  });

  it("every capability carries a human label", () => {
    // The id is a code identifier. A settings screen showing "general_question"
    // as a heading is a screen nobody proof-read.
    for (const cap of committed().capabilities) {
      expect(cap.label, cap.id).toBeTruthy();
      expect(cap.label, cap.id).not.toBe(cap.id);
    }
  });

  it("marks core capabilities so the UI cannot offer to disable them", () => {
    const byId = Object.fromEntries(committed().capabilities.map((c) => [c.id, c]));
    expect(byId.messages.core).toBe(true);
    expect(byId.transfer.core).toBe(true);
    expect(byId.appointments.core).toBe(false);
  });

  it("carries what each scheduling backend can verify", () => {
    // The UI needs this to avoid offering a guarantee the backend cannot keep.
    const adapters = Object.fromEntries(
      committed().adapters.scheduling.map((a) => [a.id, a.verifiableFields])
    );
    expect(adapters.athenahealth).toContain("dob");
    expect(adapters.webhook).toEqual([]);
    expect(adapters.internal).not.toContain("name");
  });

  it("does not leak engine internals into a browser bundle", () => {
    // The dashboard has no business knowing how a pack executes, and prompt
    // text and tool declarations should not ship to a client.
    const raw = readFileSync(EXPORT_PATH, "utf8");
    for (const leak of ["toolNames", "actionTools", "stepGuidance", "MESSAGE PROTOCOL"]) {
      expect(raw, `export contains ${leak}`).not.toContain(leak);
    }
  });
});
