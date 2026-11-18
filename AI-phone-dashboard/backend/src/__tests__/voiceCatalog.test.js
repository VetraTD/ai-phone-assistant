import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp } from "./harness.js";
import { ELEVENLABS_VOICE_IDS } from "../constants.js";

// The ElevenLabs voice ID list is triplicated by hand across three files
// (root repo config/voices.js, this backend's constants.js, and this
// backend's routes/settings.js) because the dashboard backend can't import
// across the apps/ package boundary. That triplication is exactly the kind
// of thing that silently drifts — if constants.js (the save-time whitelist
// settingsValidation.js validates against) and routes/settings.js (the
// catalog GET /api/voices actually serves to the picker UI) disagree, a
// business could pick a voice from the UI that then 400s on save. This test
// guards against that drift.
describe("voice catalog cross-file consistency", () => {
  let app;

  beforeEach(() => {
    ({ app } = createTestApp());
  });

  it("GET /api/voices ids exactly match constants.js's ELEVENLABS_VOICE_IDS", async () => {
    const res = await request(app).get("/api/voices");
    expect(res.status).toBe(200);

    const servedIds = res.body.map((v) => v.voiceId);
    expect(servedIds).toEqual(ELEVENLABS_VOICE_IDS);
  });

  it("every served voice entry has a unique id and voiceId", async () => {
    const res = await request(app).get("/api/voices");
    const catalogIds = res.body.map((v) => v.id);
    const voiceIds = res.body.map((v) => v.voiceId);
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    expect(new Set(voiceIds).size).toBe(voiceIds.length);
  });
});
