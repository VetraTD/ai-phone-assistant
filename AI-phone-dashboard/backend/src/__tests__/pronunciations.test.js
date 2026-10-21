import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createRequire } from "module";
import { createTestApp } from "./harness.js";

const require = createRequire(import.meta.url);
const { SETTINGS_FIELD_VALIDATORS } = require("../settingsValidation.js");

const BUSINESS_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_ID = "33333333-3333-3333-3333-333333333333";
const validate = SETTINGS_FIELD_VALIDATORS.pronunciations;

describe("validatePronunciations", () => {
  it("is on the write whitelist", () => {
    expect(typeof validate).toBe("function");
  });

  const accepted = [
    ["a plain string", { Digile: "Dij-aisle" }, { Digile: "Dij-aisle" }],
    ["say + ipa", { Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" } }, { Digile: { say: "Dij-aisle", ipa: "ˈdɪdʒaɪl" } }],
    ["trimming", { " Digile ": "  Dij-aisle " }, { Digile: "Dij-aisle" }],
    ["an object with no ipa", { Digile: { say: "Dij-aisle" } }, { Digile: "Dij-aisle" }],
    ["an empty ipa", { Digile: { say: "Dij-aisle", ipa: "  " } }, { Digile: "Dij-aisle" }],
    ["null", null, {}],
    ["an empty map", {}, {}],
    ["accents and apostrophes", { "O’Brien & Sons": "Oh-Bry-en and Sons" }, { "O’Brien & Sons": "Oh-Bry-en and Sons" }],
  ];
  it.each(accepted)("accepts %s", (_n, input, expected) => {
    expect(validate(input)).toEqual({ value: expected });
  });

  const rejected = [
    ["a quote in say", { Digile: 'Dij"aisle' }],
    ["a quote in written", { 'Dig"ile': "Dijaisle" }],
    ["a brace", { Digile: "Dij{aisle}" }],
    ["a 61-char say", { Digile: "a".repeat(61) }],
    ["a 41-char written", { ["a".repeat(41)]: "ok" }],
    ["11 entries", Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Name${i}`, "ok"]))],
    ["an array", ["Digile"]],
    ["a string", "Digile"],
    ["a number", 5],
    ["an empty say", { Digile: "" }],
    ["a whitespace say", { Digile: "   " }],
    ["an object with no say", { Digile: { ipa: "ˈdɪdʒaɪl" } }],
    ["a bad ipa", { Digile: { say: "Dij-aisle", ipa: "<x>" } }],
    ["a long ipa", { Digile: { say: "Dij-aisle", ipa: "a".repeat(61) } }],
    ["a non-string value", { Digile: 5 }],
    ["a newline", { Digile: "Dij\naisle" }],
  ];
  it.each(rejected)("rejects %s", (_n, input) => {
    const r = validate(input);
    expect(r.error).toBeTruthy();
    expect(r.value).toBeUndefined();
  });

  it("accepts exactly 10 entries", () => {
    const ten = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Name${i}`, "ok"]));
    expect(validate(ten).value).toEqual(ten);
  });
});

describe("settings route: pronunciations and the greeting clip", () => {
  let app, poolQueryMock, authState, voiceClient;

  beforeEach(() => {
    voiceClient = { postGreetingClip: vi.fn().mockResolvedValue({ status: 200, audio: Buffer.from("RIFFwav") }) };
    ({ app, poolQueryMock, authState } = createTestApp({ voiceClient }));
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
      if (sql.startsWith("UPDATE businesses")) return Promise.resolve({ rows: [{ id: BUSINESS_ID }] });
      return Promise.resolve({ rows: [] });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const put = (body, id = BUSINESS_ID) =>
    request(app).put(`/api/business/${id}/settings`).set("Authorization", "Bearer t").send(body);

  it("PUT {pronunciations} writes the normalized map", async () => {
    const res = await put({ pronunciations: { " Digile ": " Dij-aisle " } });
    expect(res.status).toBe(200);
    const update = poolQueryMock.mock.calls.find(([sql]) => sql.startsWith("UPDATE businesses"));
    expect(update[0]).toContain("pronunciations = $1");
    expect(update[1][0]).toEqual({ Digile: "Dij-aisle" });
  });

  it("PUT with a bad pronunciations map is a 400 and writes nothing", async () => {
    const res = await put({ pronunciations: { Digile: 'a"b' } });
    expect(res.status).toBe(400);
    expect(poolQueryMock.mock.calls.some(([sql]) => sql.startsWith("UPDATE businesses"))).toBe(false);
    expect(voiceClient.postGreetingClip).not.toHaveBeenCalled();
  });

  it("PUT {greeting} asks the voice server to re-render", async () => {
    const res = await put({ greeting: "Hello" });
    expect(res.status).toBe(200);
    expect(voiceClient.postGreetingClip).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it("PUT {pronunciations} also re-renders", async () => {
    await put({ pronunciations: { Digile: "Dij-aisle" } });
    expect(voiceClient.postGreetingClip).toHaveBeenCalledWith(BUSINESS_ID);
  });

  it("PUT {notification_email} does not", async () => {
    const res = await put({ notification_email: "a@b.com" });
    expect(res.status).toBe(200);
    expect(voiceClient.postGreetingClip).not.toHaveBeenCalled();
  });

  it("a rejecting postGreetingClip still returns 200", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    voiceClient.postGreetingClip.mockRejectedValue(new Error("boom"));
    const res = await put({ greeting: "Hello" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: BUSINESS_ID });
  });

  it("a throwing postGreetingClip still returns 200", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    voiceClient.postGreetingClip.mockImplementation(() => {
      throw new Error("sync boom");
    });
    const res = await put({ greeting: "Hello" });
    expect(res.status).toBe(200);
  });

  describe("GET greeting-clip", () => {
    const get = (id = BUSINESS_ID) =>
      request(app)
        .get(`/api/business/${id}/greeting-clip`)
        .set("Authorization", "Bearer t")
        .buffer(true)
        .parse((r, cb) => {
          const chunks = [];
          r.on("data", (c) => chunks.push(c));
          r.on("end", () => cb(null, Buffer.concat(chunks)));
        });

    it("is 403 for another business and never calls the voice server", async () => {
      const res = await get(OTHER_ID);
      expect(res.status).toBe(403);
      expect(voiceClient.postGreetingClip).not.toHaveBeenCalled();
    });

    it("is 401 without a user", async () => {
      authState.user = null;
      const res = await get();
      expect(res.status).toBe(401);
    });

    it("passes the WAV bytes and content type through, uncached", async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/audio\/wav/);
      expect(res.headers["cache-control"]).toMatch(/no-store/);
      expect(res.body.toString()).toBe("RIFFwav");
      expect(voiceClient.postGreetingClip).toHaveBeenCalledWith(BUSINESS_ID);
    });

    it("maps 503 to 'isn't available yet'", async () => {
      voiceClient.postGreetingClip.mockResolvedValue({ status: 503, audio: null });
      const res = await get();
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body.toString()).error).toBe("Greeting preview isn't available yet.");
    });

    it.each([400, 404, 502, 500])("maps %i to a 502 retry message", async (status) => {
      voiceClient.postGreetingClip.mockResolvedValue({ status, audio: null });
      const res = await get();
      expect(res.status).toBe(502);
      expect(JSON.parse(res.body.toString()).error).toBe("Couldn't make the greeting recording. Try again in a minute.");
    });

    it("maps a thrown error to 502 too", async () => {
      voiceClient.postGreetingClip.mockRejectedValue(new Error("x"));
      const res = await get();
      expect(res.status).toBe(502);
    });
  });
});

describe("greeting re-render waits for COMMIT", () => {
  const events = [];
  let voiceClient;

  function build(withTenant) {
    events.length = 0;
    voiceClient = {
      postGreetingClip: vi.fn(async () => {
        events.push("rerender");
        return { status: 200, audio: Buffer.from("x") };
      }),
    };
    const built = createTestApp({ voiceClient, withTenant });
    built.poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
      if (sql.startsWith("UPDATE businesses")) {
        events.push("update");
        return Promise.resolve({ rows: [{ id: BUSINESS_ID }] });
      }
      return Promise.resolve({ rows: [] });
    });
    return built;
  }
  const put = (app, body) =>
    request(app).put(`/api/business/${BUSINESS_ID}/settings`).set("Authorization", "Bearer t").send(body);

  it("calls postGreetingClip only after the transaction has committed", async () => {
    const { app } = build(async (_id, fn) => {
      const out = await fn();
      events.push("committed");
      return out;
    });
    const res = await put(app, { greeting: "Hello" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(voiceClient.postGreetingClip).toHaveBeenCalledWith(BUSINESS_ID));
    expect(events).toEqual(["update", "committed", "rerender"]);
  });

  it("never calls it when the transaction fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = build(async (_id, fn) => {
      await fn();
      throw new Error("commit failed");
    });
    await put(app, { greeting: "Hello" });
    await new Promise((r) => setTimeout(r, 20));
    expect(voiceClient.postGreetingClip).not.toHaveBeenCalled();
  });

  it("never calls it when the UPDATE itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, poolQueryMock } = build();
    poolQueryMock.mockImplementation((sql) => {
      if (sql.includes("app_lookup_user_by_auth_uid")) return Promise.resolve({ rows: [{ business_id: BUSINESS_ID }] });
      if (sql.startsWith("UPDATE businesses")) return Promise.reject(new Error("db down"));
      return Promise.resolve({ rows: [] });
    });
    const res = await put(app, { greeting: "Hello" });
    expect(res.status).toBe(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(voiceClient.postGreetingClip).not.toHaveBeenCalled();
  });
});

describe("voiceClient.postGreetingClip", () => {
  const ENV = process.env.VOICE_INTERNAL_URL;
  let postGreetingClip;
  beforeEach(() => {
    delete require.cache[require.resolve("../services/voiceClient.js")];
    ({ postGreetingClip } = require("../services/voiceClient.js"));
  });
  afterEach(() => {
    if (ENV === undefined) delete process.env.VOICE_INTERNAL_URL;
    else process.env.VOICE_INTERNAL_URL = ENV;
    vi.unstubAllGlobals();
  });

  it("is 503 with no network call when VOICE_INTERNAL_URL is unset", async () => {
    delete process.env.VOICE_INTERNAL_URL;
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await postGreetingClip("b1")).toEqual({ status: 503, audio: null });
    expect(f).not.toHaveBeenCalled();
  });

  it("gets an ID token for the base URL then posts with it", async () => {
    process.env.VOICE_INTERNAL_URL = "https://voice.example.com/";
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "tok123" })
      .mockResolvedValueOnce({ status: 200, arrayBuffer: async () => new TextEncoder().encode("WAV").buffer });
    vi.stubGlobal("fetch", f);
    const r = await postGreetingClip("b1");
    expect(r.status).toBe(200);
    expect(Buffer.from(r.audio).toString()).toBe("WAV");
    const [metaUrl, metaInit] = f.mock.calls[0];
    expect(metaUrl).toBe(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=" +
        encodeURIComponent("https://voice.example.com")
    );
    expect(metaInit.headers["Metadata-Flavor"]).toBe("Google");
    const [url, init] = f.mock.calls[1];
    expect(url).toBe("https://voice.example.com/internal/greeting-clip");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok123");
    expect(JSON.parse(init.body)).toEqual({ business_id: "b1" });
    expect(init.signal).toBeDefined();
  });

  it("passes a non-200 status through without audio", async () => {
    process.env.VOICE_INTERNAL_URL = "https://voice.example.com";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "t" })
        .mockResolvedValueOnce({ status: 404, arrayBuffer: async () => new ArrayBuffer(0) })
    );
    expect(await postGreetingClip("b1")).toEqual({ status: 404, audio: null });
  });

  it("is 502 when the metadata server fails", async () => {
    process.env.VOICE_INTERNAL_URL = "https://voice.example.com";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no metadata")));
    expect(await postGreetingClip("b1")).toEqual({ status: 502, audio: null });
  });

  it("is 502 when the metadata server answers non-OK", async () => {
    process.env.VOICE_INTERNAL_URL = "https://voice.example.com";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "" }));
    expect(await postGreetingClip("b1")).toEqual({ status: 502, audio: null });
  });

  it("is 502 when the voice server is unreachable", async () => {
    process.env.VOICE_INTERNAL_URL = "https://voice.example.com";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: true, status: 200, text: async () => "t" }).mockRejectedValueOnce(new Error("timeout"))
    );
    expect(await postGreetingClip("b1")).toEqual({ status: 502, audio: null });
  });
});
