import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestApp } from "./harness.js";
import { LOCALES, LIVE_VOICES } from "../constants.js";

const BUSINESS_ID = "22222222-2222-2222-2222-222222222222";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

// ---------------------------------------------------------------------------
// LVX84. The voice picker wrote two columns the Live front-end never reads.
//
// Settings wrote voice_provider and voice_id, which only the cascade consults.
// Every production call is served by the Live front-end, which reads
// businesses.live_voice and businesses.locale — and the dashboard had zero
// references to either. live_voice was NULL on every row and every session
// logged voice_source: default, so a business could change its voice, see the
// change saved, and hear nothing different. A setting that appears to work is
// worse than one that is missing.
//
// The language half was already wired end to end and simply never exposed:
// businesses.locale has existed since migration 025, loadConfig has carried it
// as config.locale all along, and resolveLiveLanguage reads it.
// ---------------------------------------------------------------------------

describe("LVX84 - Live voice and language settings", () => {
  let app, poolQueryMock;

  beforeEach(() => {
    ({ app, poolQueryMock } = createTestApp());
  });

  function stubSave() {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid"))
        return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
      if (sql.startsWith("UPDATE businesses"))
        return Promise.resolve({ rows: [{ id: BUSINESS_ID }] });
      return Promise.resolve({ rows: [] });
    });
  }

  describe("saving", () => {
    it("accepts a locale the schema allows and writes it", async () => {
      stubSave();
      const res = await request(app)
        .put(`/api/business/${BUSINESS_ID}/settings`)
        .set("Authorization", "Bearer t")
        .send({ locale: "en-GB" });

      expect(res.status).toBe(200);
      const update = poolQueryMock.mock.calls.find(([sql]) => sql.startsWith("UPDATE businesses"));
      expect(update[0]).toContain("locale");
      expect(update[1]).toContain("en-GB");
    });

    it("refuses a locale the schema would reject, before the database sees it", async () => {
      // The column has a CHECK constraint. Letting a bad value through would
      // surface as a 500 with a Postgres message rather than a field error.
      stubSave();
      const res = await request(app)
        .put(`/api/business/${BUSINESS_ID}/settings`)
        .set("Authorization", "Bearer t")
        .send({ locale: "fr-FR" });

      expect(res.status).toBe(400);
      expect(poolQueryMock.mock.calls.some(([sql]) => sql.startsWith("UPDATE businesses"))).toBe(false);
    });

    it("accepts a Live voice from the catalogue and writes it", async () => {
      stubSave();
      const res = await request(app)
        .put(`/api/business/${BUSINESS_ID}/settings`)
        .set("Authorization", "Bearer t")
        .send({ live_voice: "Puck" });

      expect(res.status).toBe(200);
      const update = poolQueryMock.mock.calls.find(([sql]) => sql.startsWith("UPDATE businesses"));
      expect(update[0]).toContain("live_voice");
      expect(update[1]).toContain("Puck");
    });

    it("refuses a voice name that is not in the catalogue", async () => {
      stubSave();
      const res = await request(app)
        .put(`/api/business/${BUSINESS_ID}/settings`)
        .set("Authorization", "Bearer t")
        .send({ live_voice: "Gandalf" });

      expect(res.status).toBe(400);
    });

    it("treats an empty locale as 'derive it', not as an error", async () => {
      // NULL is what migration 025 means by "work it out from the phone
      // number", and it is the right setting for most tenants. A business that
      // once picked an accent has to be able to get back to it.
      stubSave();
      const res = await request(app)
        .put(`/api/business/${BUSINESS_ID}/settings`)
        .set("Authorization", "Bearer t")
        .send({ locale: "" });

      expect(res.status).toBe(200);
      const update = poolQueryMock.mock.calls.find(([sql]) => sql.startsWith("UPDATE businesses"));
      expect(update[0]).toContain("locale");
      expect(update[1]).toContain(null);
    });

    it("treats an empty voice as 'use the default', not as an error", async () => {
      // NULL is the documented meaning of "per-language default" in migration
      // 041, and clearing the picker has to be able to get back there.
      stubSave();
      const res = await request(app)
        .put(`/api/business/${BUSINESS_ID}/settings`)
        .set("Authorization", "Bearer t")
        .send({ live_voice: "" });

      expect(res.status).toBe(200);
      const update = poolQueryMock.mock.calls.find(([sql]) => sql.startsWith("UPDATE businesses"));
      expect(update[1]).toContain(null);
    });
  });

  describe("the catalogue the picker reads", () => {
    it("serves the voices and locales the save path will accept", async () => {
      const res = await request(app).get("/api/live-voices");

      expect(res.status).toBe(200);
      expect(res.body.voices.map((v) => v.name)).toEqual(LIVE_VOICES);
      // A SET, not a sequence. What must hold is that the picker offers
      // exactly what the save path accepts; the order it offers them in is a
      // display choice — the catalogue leads with en-GB because this estate is
      // UK-first, while LOCALES follows the schema's declaration order.
      expect([...res.body.locales.map((l) => l.id)].sort()).toEqual([...LOCALES].sort());
    });

    it("says which front-end is actually serving calls", async () => {
      // The dashboard cannot derive this: Live vs cascade is decided by the
      // Twilio number's voiceUrl, which lives at Twilio. It is a deployment
      // fact, declared by the deployment.
      const res = await request(app).get("/api/live-voices");
      expect(["live", "cascade"]).toContain(res.body.frontend);
    });

    it("carries what is actually known about each voice, including the bad news", async () => {
      // Two of these have been heard on a real phone call and found wanting.
      // A picker that hides its own evidence is how an unmeasured preference
      // gets locked in as a decision.
      const res = await request(app).get("/api/live-voices");
      const byName = Object.fromEntries(res.body.voices.map((v) => [v.name, v]));

      expect(byName.Kore.evidence).toMatch(/phone/i);
      expect(byName.Aoede.evidence).toMatch(/rejected/i);
      for (const v of res.body.voices) {
        expect(typeof v.evidence).toBe("string");
        expect(v.evidence.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cross-package parity. The dashboard backend cannot import across the
  // package boundary, so these lists are copies — and a copy that drifts from
  // its source is how a picker starts offering a value the database refuses.
  // Same reasoning as voiceCatalog.test.js, one boundary further out.
  // -------------------------------------------------------------------------
  describe("parity with the root repository", () => {
    it("LOCALES matches the CHECK constraint on businesses.locale", async () => {
      const schema = fs.readFileSync(path.join(REPO_ROOT, "database/schema.sql"), "utf8");
      const match = schema.match(/locale\s+text\s+CHECK\s*\([^)]*IN\s*\(([^)]*)\)/i);
      expect(match).toBeTruthy();
      const fromSchema = match[1]
        .split(",")
        .map((s) => s.trim().replace(/^'|'$/g, ""))
        .filter(Boolean);
      expect(LOCALES).toEqual(fromSchema);
    });

    it("LIVE_VOICES matches the candidate list voice-compare renders", async () => {
      // scripts/voice-compare.js is the only place in the repository that has
      // ever named candidates, and it is explicit that the list is a starting
      // point to be disproved rather than an authority. The picker and the
      // probe must at least be disproving the same list.
      const probe = fs.readFileSync(path.join(REPO_ROOT, "scripts/voice-compare.js"), "utf8");
      const match = probe.match(/VOICE_COMPARE_VOICES\s*\|\|\s*"([^"]+)"/);
      expect(match).toBeTruthy();
      expect(LIVE_VOICES).toEqual(match[1].split(",").map((s) => s.trim()));
    });
  });
});
