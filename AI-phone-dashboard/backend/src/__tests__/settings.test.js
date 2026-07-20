import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";

const BUSINESS_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_BUSINESS_ID = "33333333-3333-3333-3333-333333333333";

describe("PUT /api/business/:id/settings", () => {
  let app, poolQueryMock, authState;

  beforeEach(() => {
    ({ app, poolQueryMock, authState } = createTestApp());
  });

  function mockOwnership(businessId = BUSINESS_ID) {
    poolQueryMock.mockImplementation((sql, params) => {
      if (sql.includes("from users")) {
        return Promise.resolve({ rows: [{ business_id: businessId }] });
      }
      if (sql.startsWith("UPDATE businesses")) {
        return Promise.resolve({ rows: [{ id: businessId, updated: true, _params: params }] });
      }
      if (sql.startsWith("SELECT * FROM businesses")) {
        return Promise.resolve({ rows: [{ id: businessId, name: "Existing Biz" }] });
      }
      return Promise.reject(new Error("unexpected query: " + sql));
    });
  }

  it("valid full payload persists via a parameterized dynamic UPDATE (no phantom columns)", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({
        name: "Acme Dental",
        timezone: "America/Chicago",
        greeting: "Thanks for calling Acme!",
        allowed_tasks: ["book_appointment", "check_appointment"],
        languages_spoken: ["en", "es"],
        voice_provider: "elevenlabs",
        voice_id: "21m00Tcm4TlvDq8ikWAM",
        notifications_enabled: true,
      });

    expect(res.status).toBe(200);

    const updateCall = poolQueryMock.mock.calls.find(([sql]) => sql.startsWith("UPDATE businesses"));
    expect(updateCall).toBeTruthy();
    const [sql, params] = updateCall;

    // Column list comes only from the fixed validator whitelist, values are
    // parameterized placeholders ($1, $2, ...) — never string-interpolated.
    expect(sql).toContain("name = $1");
    expect(sql).not.toMatch(/default_language/);
    expect(sql).not.toMatch(/address_line1|address_line2|city|state_region|postal_code/);
    expect(sql).not.toContain("Acme Dental"); // value must be a param, not inlined in SQL
    expect(params).toContain("Acme Dental");
    expect(params[params.length - 1]).toBe(BUSINESS_ID); // id is always the last param
  });

  it("unknown legacy keys (default_language, address fields) are ignored, not a 500", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ default_language: "en", address_line1: "123 Main St", name: "Acme" });

    expect(res.status).toBe(200);
    const updateCall = poolQueryMock.mock.calls.find(([sql]) => sql.startsWith("UPDATE businesses"));
    expect(updateCall[0]).not.toMatch(/default_language|address_line1/);
  });

  it("a request with ONLY unknown keys returns 200 without issuing an UPDATE", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ default_language: "en" });

    expect(res.status).toBe(200);
    const updateCall = poolQueryMock.mock.calls.find(([sql]) => sql.startsWith("UPDATE businesses"));
    expect(updateCall).toBeUndefined();
  });

  it("allowed_tasks containing a CORE task (not a module) -> 400", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ allowed_tasks: ["book_appointment", "general_question"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/allowed_tasks/);
    expect(res.body.error).toMatch(/general_question/);
  });

  it("allowed_tasks made only of valid module tasks -> 200", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ allowed_tasks: ["book_appointment", "quote_request"] });

    expect(res.status).toBe(200);
  });

  it("weekly business_hours: valid shape persists as jsonb", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({
        business_hours: {
          mon: { open: "09:00", close: "17:00", closed: false },
          sat: { closed: true },
          sun: { closed: true },
        },
      });

    expect(res.status).toBe(200);
    const updateCall = poolQueryMock.mock.calls.find(([sql]) => sql.startsWith("UPDATE businesses"));
    expect(updateCall[0]).toContain("business_hours = $1");
  });

  it("weekly business_hours: bad time format -> 400", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ business_hours: { mon: { open: "9am", close: "5pm", closed: false } } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/business_hours/);
  });

  it("weekly business_hours: unknown day key -> 400", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ business_hours: { funday: { open: "09:00", close: "17:00", closed: false } } });

    expect(res.status).toBe(400);
  });

  it("weekly business_hours: a day not marked closed but missing open/close -> 400 (not silently open-all-day)", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ business_hours: { mon: { closed: false } } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/business_hours/);
    expect(res.body.error).toMatch(/open and close/);
  });

  it("weekly business_hours: a day not marked closed with only open (no close) -> 400", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ business_hours: { tue: { open: "09:00" } } });

    expect(res.status).toBe(400);
  });

  it("weekly business_hours: closed:true day does not require open/close -> 200", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ business_hours: { sun: { closed: true } } });

    expect(res.status).toBe(200);
  });

  it("voice_id not in the ElevenLabs catalog -> 400", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ voice_id: "not-a-real-voice-id" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/voice_id/);
  });

  it("voice_id set to null clears the override -> 200", async () => {
    mockOwnership();

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ voice_id: null });

    expect(res.status).toBe(200);
  });

  it("forbids updating a business the authenticated user doesn't own", async () => {
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("from users")) {
        return Promise.resolve({ rows: [{ business_id: OTHER_BUSINESS_ID }] });
      }
      return Promise.reject(new Error("should not query past ownership check"));
    });

    const res = await request(app)
      .put(`/api/business/${BUSINESS_ID}/settings`)
      .set("Authorization", "Bearer test-token")
      .send({ name: "Hacked" });

    expect(res.status).toBe(403);
  });

  it("401s when unauthenticated", async () => {
    authState.user = null;
    const res = await request(app).put(`/api/business/${BUSINESS_ID}/settings`).send({ name: "X" });
    expect(res.status).toBe(401);
  });
});
