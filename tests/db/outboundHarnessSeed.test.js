// tests/db/outboundHarnessSeed.test.js
/**
 * Task 15: the DATABASE half of scripts/live-call-harness.js --outbound
 * (lib/probe/outboundSeed.js), against the real local Postgres, FREE:
 *
 *   - the seed lands every row through the existing writers and resolves by
 *     CallSid the way the door and the session will;
 *   - the render step runs through the REAL renderAudio adapter
 *     (createLiveRenderAudio -> loadConfig -> resolveLiveLanguage/Voice ->
 *     renderLines -> storeAttemptAudio) with a FAKE Live connect, and the
 *     session's own context read then finds the stored clip;
 *   - --call-sid reads the same attempt back without writing;
 *   - the read-back sees the attempt, and the cleanup leaves nothing behind;
 *   - the seed refuses a non-local DATABASE_URL before it writes anything.
 *
 * Runs as the local `vetra` role, as the harness does.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";

vi.mock("../../lib/logger.js", async (importOriginal) => ({
  ...(await importOriginal()),
  log: { debug: () => {}, info: () => {}, error: () => {} },
}));

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

let admin, db, seedMod, harness, callContext;
let seed = null;

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  db = await import("../../services/db.js");
  seedMod = await import("../../lib/probe/outboundSeed.js");
  harness = await import("../../lib/probe/outboundHarness.js");
  callContext = await import("../../lib/outbound/callContext.js");
});

afterAll(async () => {
  if (!admin) return;
  if (seed) await admin.query("DELETE FROM businesses WHERE id = $1", [seed.businessId]).catch(() => {});
  await admin.end();
});

/** 24 kHz PCM16, as Live sends it. */
function pcm24k(ms) {
  const samples = Math.round((24000 * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 6000 : -6000, i * 2);
  return buf.toString("base64");
}

/** A fake connectLive: says the line verbatim, reports usage, completes. */
const fakeConnect = vi.fn(async ({ config, callbacks }) => ({
  session: {
    config,
    sendClientContent(msg) {
      const line = msg.turns[0].parts[0].text.replace(/^Say exactly: "/, "").replace(/"$/, "");
      setImmediate(() => {
        callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm24k(600) } }] } } });
        callbacks.onmessage({ serverContent: { outputTranscription: { text: line } } });
        callbacks.onmessage({ usageMetadata: { promptTokensDetails: [{ modality: "TEXT", tokenCount: 30 }], responseTokensDetails: [{ modality: "AUDIO", tokenCount: 80 }] } });
        callbacks.onmessage({ serverContent: { turnComplete: true } });
      });
    },
    close() {},
  },
  languagePinned: true,
  surface: "aistudio",
  model: "gemini-3.1-flash-live-preview",
}));

d("the outbound harness's seed, render, read-back and cleanup", () => {
  it("refuses a non-local DATABASE_URL before writing anything", async () => {
    const before = (await admin.query("SELECT count(*)::int AS n FROM businesses")).rows[0].n;
    await expect(
      seedMod.seedOutboundAttempt({
        admin,
        db,
        databaseUrl: "postgresql://vetra:x@127.0.0.1:5432/vetra",
        callSid: harness.harnessCallSid(),
        ...harness.pickHarnessNumbers(),
      })
    ).rejects.toThrow(/55432/);
    expect((await admin.query("SELECT count(*)::int AS n FROM businesses")).rows[0].n).toBe(before);
  });

  it("seeds a business, campaign, contact, outreach and attempt that resolve by CallSid", async () => {
    const { callerId, contact } = harness.pickHarnessNumbers();
    const callSid = harness.harnessCallSid();
    seed = await seedMod.seedOutboundAttempt({ admin, db, databaseUrl: url, callSid, callerId, contact });

    expect(seed).toMatchObject({ seeded: true, attemptNo: 1, callSid, callerId, contact, firstName: "Sam", businessName: "Harness Test Clinic", complianceClass: "solicited", personaName: "Ava" });
    expect(await db.outboundAttemptByCallSid(callSid)).toEqual({
      businessId: seed.businessId,
      attemptId: seed.attemptId,
      outreachId: seed.outreachId,
      campaignId: seed.campaignId,
      campaignVersion: 1,
    });
    const b = (await admin.query("SELECT name, phone_number, outbound_enabled FROM businesses WHERE id = $1", [seed.businessId])).rows[0];
    expect(b).toEqual({ name: "Harness Test Clinic", phone_number: callerId, outbound_enabled: true });
    const v = (await admin.query("SELECT config FROM campaign_versions WHERE campaign_id = $1 AND version = 1", [seed.campaignId])).rows[0];
    expect(v.config.caller_id).toBe(callerId);
    const o = (await admin.query("SELECT state, attempts_made FROM outreach WHERE id = $1", [seed.outreachId])).rows[0];
    expect(o).toEqual({ state: "dialing", attempts_made: 1 });
    // No clip yet: the verdict would judge the prompt path.
    expect(await seedMod.openerClipBytes({ admin, callSid })).toBe(0);
  });

  it("renders through the real renderAudio adapter (fake Live) and stores the clips the session then reads", async () => {
    const render = await seedMod.renderAttemptClips({ db, seed, env: { GEMINI_API_KEY: "test" }, connect: fakeConnect, settleMs: 0 });
    expect(Object.keys(render.lines).sort()).toEqual(["opener", "voicemail"]);
    expect(render.failed).toBeNull();
    expect(render.stored.opener).toBeGreaterThan(0);
    expect(render.stored.voicemail).toBeGreaterThan(0);
    // The clip was rendered in the BUSINESS's voice and language (+44 -> en-GB).
    expect(fakeConnect.mock.calls[0][0].config.speechConfig.languageCode).toBe("en-GB");
    const byKind = Object.fromEntries(render.sessions.map((s) => [s.kind, s]));
    expect(byKind.opener).toMatchObject({ outcome: "accepted", overlap: 1, word_ratio: 1, usage_before_turn_complete: true, model: "gemini-3.1-flash-live-preview" });
    expect(byKind.voicemail).toMatchObject({ outcome: "accepted" });
    expect(await seedMod.openerClipBytes({ admin, callSid: seed.callSid })).toBe(render.stored.opener);

    // What the Live session will read at pickup: the stored clip and its text.
    const ctx = await callContext.resolveOutboundContext(seed.callSid, { db });
    expect(ctx.openerAudio?.length).toBe(render.stored.opener);
    expect(ctx.openerText).toBe(render.lines.opener);
    expect(ctx.openerRefused).toBe(false);
  });

  it("--call-sid reads the same attempt back without writing", async () => {
    const loaded = await seedMod.loadOutboundAttempt({ db, callSid: seed.callSid });
    expect(loaded).toMatchObject({
      seeded: false,
      businessId: seed.businessId,
      attemptId: seed.attemptId,
      outreachId: seed.outreachId,
      attemptNo: 1,
      callerId: seed.callerId,
      contact: seed.contact,
      firstName: "Sam",
      businessName: "Harness Test Clinic",
    });
    expect(harness.dispatchLines({ row: seedMod.dispatchRowFor(loaded), attemptNo: 1 })).toEqual(
      harness.dispatchLines({ row: seedMod.dispatchRowFor(seed), attemptNo: 1 })
    );
  });

  it("reads the attempt back, and the cleanup leaves nothing behind", async () => {
    const back = await seedMod.readBackOutbound({ admin, callSid: seed.callSid });
    expect(back.calls).toBeNull(); // no call ran
    expect(back.attempt).toMatchObject({ id: seed.attemptId, attempt_no: 1, answered_at: null, result: null });
    expect(back.attempt.opener_audio_bytes).toBeGreaterThan(0);

    const cleanup = await seedMod.cleanupOutboundSeed({ admin, seed });
    expect(cleanup.clean).toBe(true);
    expect(Object.values(cleanup.remaining).every((n) => n === 0)).toBe(true);
    expect(await db.outboundAttemptByCallSid(seed.callSid)).toBeNull();
    seed = null;
  });
});
