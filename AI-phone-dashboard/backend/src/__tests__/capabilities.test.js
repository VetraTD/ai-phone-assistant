import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

const BUSINESS_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_BUSINESS_ID = "33333333-3333-3333-3333-333333333333";

/**
 * Capability settings API.
 *
 * These endpoints let an operator configure things the engine ENFORCES — an
 * identity check the receptionist will refuse to book without. So the tests
 * lean on two properties: a business can only ever reach its own rows, and a
 * setting that would not actually work is rejected rather than saved. Storing a
 * requirement that silently does nothing is how someone ends up believing they
 * have a guarantee they do not have.
 */
describe("capability settings", () => {
  let app, poolQueryMock, authState;

  beforeEach(() => {
    ({ app, poolQueryMock, authState } = createTestApp());
  });

  function mockOwnership(businessId = BUSINESS_ID, rows = []) {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) {
        return Promise.resolve({ rows: [{ business_id: businessId }] });
      }
      if (sql.includes("from business_capabilities")) {
        return Promise.resolve({ rows });
      }
      if (sql.includes("insert into business_capabilities")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.reject(new Error("unexpected query: " + sql));
    });
  }

  const put = (capabilityId, body) =>
    request(app)
      .put(`/api/business/${BUSINESS_ID}/capabilities/${capabilityId}`)
      .set("Authorization", "Bearer test-token")
      .send(body);

  describe("GET /api/capabilities/definitions", () => {
    it("is public — the UI needs it before a business is even selected", async () => {
      const res = await request(app).get("/api/capabilities/definitions");
      expect(res.status).toBe(200);
      expect(res.body.capabilities.length).toBeGreaterThan(0);
    });

    it("carries the labels and schemas the settings screen renders from", async () => {
      const res = await request(app).get("/api/capabilities/definitions");
      const appointments = res.body.capabilities.find((c) => c.id === "appointments");
      expect(appointments.label).toBe("Appointments");
      expect(appointments.configSchema.require.identity.allowCustom).toBe(true);
      expect(res.body.adapters.scheduling.map((a) => a.id)).toContain("athenahealth");
    });

    it("says what each backend can verify, so the UI cannot promise more", async () => {
      const res = await request(app).get("/api/capabilities/definitions");
      const byId = Object.fromEntries(res.body.adapters.scheduling.map((a) => [a.id, a]));
      expect(byId.webhook.verifiableFields).toEqual([]);
      expect(byId.athenahealth.verifiableFields).toContain("dob");
    });
  });

  describe("GET /api/business/:id/capabilities", () => {
    it("401s when unauthenticated", async () => {
      authState.user = null;
      const res = await request(app).get(`/api/business/${BUSINESS_ID}/capabilities`);
      expect(res.status).toBe(401);
    });

    it("403s for a business the user does not own", async () => {
      mockOwnership(OTHER_BUSINESS_ID);
      const res = await request(app)
        .get(`/api/business/${BUSINESS_ID}/capabilities`)
        .set("Authorization", "Bearer test-token");
      expect(res.status).toBe(403);
    });

    it("returns a row per known capability, configured or not", async () => {
      // So the screen is complete on first visit rather than showing only the
      // parts someone has touched before.
      mockOwnership(BUSINESS_ID, []);
      const res = await request(app)
        .get(`/api/business/${BUSINESS_ID}/capabilities`)
        .set("Authorization", "Bearer test-token");

      expect(res.status).toBe(200);
      // appointments, messages, quotes, transfer (the info-only packs were removed).
      expect(res.body.capabilities.length).toBe(4);
      expect(res.body.capabilities.every((c) => c.configured === false)).toBe(true);
    });

    it("distinguishes a stored row from a default", async () => {
      // Without this the UI cannot tell "explicitly off" from "never set up",
      // which is the exact ambiguity migration 020 existed to remove.
      mockOwnership(BUSINESS_ID, [
        { capability_id: "appointments", enabled: false, adapter: null, adapter_config: {}, config: {} },
      ]);
      const res = await request(app)
        .get(`/api/business/${BUSINESS_ID}/capabilities`)
        .set("Authorization", "Bearer test-token");

      const appointments = res.body.capabilities.find((c) => c.capability_id === "appointments");
      expect(appointments.enabled).toBe(false);
      expect(appointments.configured).toBe(true);
    });

    it("reports core capabilities as on regardless of any stored row", async () => {
      mockOwnership(BUSINESS_ID, [
        { capability_id: "messages", enabled: false, adapter: null, adapter_config: {}, config: {} },
      ]);
      const res = await request(app)
        .get(`/api/business/${BUSINESS_ID}/capabilities`)
        .set("Authorization", "Bearer test-token");

      // A row claiming otherwise describes something the engine will not honor.
      expect(res.body.capabilities.find((c) => c.capability_id === "messages").enabled).toBe(true);
    });
  });

  describe("PUT /api/business/:id/capabilities/:capabilityId", () => {
    it("403s for a business the user does not own", async () => {
      mockOwnership(OTHER_BUSINESS_ID);
      const res = await put("appointments", { enabled: true });
      expect(res.status).toBe(403);
    });

    it("404s for a capability that does not exist", async () => {
      mockOwnership();
      const res = await put("teleportation", { enabled: true });
      expect(res.status).toBe(404);
    });

    it("refuses to disable a core capability", async () => {
      // Message-taking is the floor every other capability falls back to.
      mockOwnership();
      const res = await put("messages", { enabled: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/always on/i);
    });

    it("rejects an adapter the capability does not offer", async () => {
      // Routing at a backend that does not exist fails mid-call, after the
      // caller has already given their details.
      mockOwnership();
      const res = await put("appointments", { enabled: true, adapter: "carrier_pigeon" });
      expect(res.status).toBe(400);
    });

    it("saves a custom identity field", async () => {
      mockOwnership();
      const res = await put("appointments", {
        enabled: true,
        adapter: "internal",
        config: {
          notes: "Ask morning or afternoon first.",
          require: {
            identity: {
              custom: [
                {
                  key: "dental_number",
                  label: "Dental number",
                  ask: "And your dental number — the six digits on your card?",
                  pattern: "^[0-9]{6}$",
                },
              ],
            },
          },
        },
      });

      expect(res.status).toBe(200);
      const insert = poolQueryMock.mock.calls.find(([sql]) =>
        sql.includes("insert into business_capabilities")
      );
      expect(insert).toBeTruthy();
      const stored = JSON.parse(insert[1][5]);
      expect(stored.require.identity.custom[0]).toMatchObject({
        key: "dental_number",
        pattern: "^[0-9]{6}$",
        verify: "collect_only",
      });
    });

    it("rejects a custom field with no wording for how to ask", async () => {
      // The receptionist would have to invent the question, and the point of
      // the field is that the business chose how it is asked.
      mockOwnership();
      const res = await put("appointments", {
        enabled: true,
        config: { require: { identity: { custom: [{ key: "member_id", label: "Member ID" }] } } },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/how to ask/i);
    });

    it("rejects a key that cannot become a tool parameter name", async () => {
      mockOwnership();
      const res = await put("appointments", {
        enabled: true,
        config: {
          require: { identity: { custom: [{ key: "bad key!", ask: "What is it?" }] } },
        },
      });
      expect(res.status).toBe(400);
    });

    it("rejects an unusable format expression instead of saving a dead check", async () => {
      mockOwnership();
      const res = await put("appointments", {
        enabled: true,
        config: {
          require: {
            identity: { custom: [{ key: "member_id", ask: "Member ID?", pattern: "([" }] },
          },
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not a valid expression/i);
    });

    it("rejects duplicate custom keys", async () => {
      mockOwnership();
      const res = await put("appointments", {
        enabled: true,
        config: {
          require: {
            identity: {
              custom: [
                { key: "x", ask: "First?" },
                { key: "x", ask: "Second?" },
              ],
            },
          },
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/duplicate/i);
    });

    it("bounds notes so prose cannot crowd out the conversation", async () => {
      mockOwnership();
      const res = await put("appointments", { enabled: true, config: { notes: "x".repeat(5000) } });
      expect(res.status).toBe(400);
    });

    it("saves well-formed availability numbers (no on/off flag)", async () => {
      mockOwnership();
      const res = await put("appointments", {
        enabled: true,
        adapter: "internal",
        config: { availability: { length: 45, capacity: 2 } },
      });
      expect(res.status).toBe(200);
      const insert = poolQueryMock.mock.calls.find(([sql]) =>
        sql.includes("insert into business_capabilities")
      );
      const stored = JSON.parse(insert[1][5]);
      expect(stored.availability).toEqual({ length: 45, capacity: 2 });
    });

    it("rejects an availability length that is out of range, naming it", async () => {
      mockOwnership();
      const res = await put("appointments", {
        enabled: true,
        config: { availability: { enabled: true, length: 4 } },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/length/i);
    });

    it("rejects a non-integer slot capacity", async () => {
      mockOwnership();
      const res = await put("appointments", {
        enabled: true,
        config: { availability: { enabled: true, capacity: 2.5 } },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/capacity/i);
    });

    it("turning a capability off stores the row rather than deleting it", async () => {
      // "Explicitly off" has to survive as a fact; deleting the row would make
      // it indistinguishable from never having been configured.
      mockOwnership();
      const res = await put("appointments", { enabled: false });
      expect(res.status).toBe(200);

      const insert = poolQueryMock.mock.calls.find(([sql]) =>
        sql.includes("insert into business_capabilities")
      );
      expect(insert[1][2]).toBe(false);
    });
  });
});
