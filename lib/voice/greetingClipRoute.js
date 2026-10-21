// ---------------------------------------------------------------------------
// POST /internal/greeting-clip (pronunciation build, Step 3, 2026-10-20).
//
// The dashboard's "Hear greeting" button and its remake-after-save both come
// through here. The dashboard is a separate service that cannot import this
// repository's lib/, and a second copy of greetingTextFor + the renderer would
// be a second place for "what the caller hears" to drift. So the voice service
// stays the ONE place a greeting is composed and rendered, and the preview is
// byte-for-byte the clip a call would play.
//
// Auth: a Google-signed OIDC token from the dashboard's own service account
// (GREETING_CLIP_CALLER_SA), audience = this service's BASE_URL -- the same
// verifier the outbound Cloud Tasks routes use. Unset = route not mounted.
//
// Body: { business_id }. 200 audio/wav (the clip for the business's current
// variant, rendered first if stale), 400 bad id, 404 unknown business,
// 502 render failed.
// ---------------------------------------------------------------------------
import { createGoogleOidcVerifier } from "../auth/googleOidc.js";
import { mulawToWav } from "../audio/wav.js";
import { ensureGreetingClips, greetingClipSpec, greetingVariant } from "./greetingClip.js";

export const GREETING_CLIP_PATH = "/internal/greeting-clip";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = { actor: { type: "system", id: "greeting-clip-route" } };

/**
 * @returns {{verifier: object}|null} null (and the route stays unmounted) when
 *   either half of the auth config is missing -- fail closed, loudly.
 */
export function buildGreetingClipRouteAuth(env, log) {
  const caller = String(env?.GREETING_CLIP_CALLER_SA || "").trim();
  const audience = String(env?.BASE_URL || "").trim();
  if (!caller || !audience) {
    log?.info?.("greeting_clip_route_disabled", { caller_set: !!caller, base_url_set: !!audience });
    return null;
  }
  return { verifier: createGoogleOidcVerifier({ audience, allowedEmails: [caller] }) };
}

export function registerGreetingClipRoute(app, { db, verifier, synthesize, env = process.env, log, now = () => new Date() }) {
  app.post(GREETING_CLIP_PATH, async (req, res) => {
    const auth = await verifier.verify(req.headers.authorization);
    if (!auth.ok) {
      log?.info?.("greeting_clip_auth_refused", { reason: auth.reason });
      return res.status(auth.reason === "missing" ? 401 : 403).json({ error: "unauthorized" });
    }
    const businessId = req.body?.business_id;
    if (typeof businessId !== "string" || !UUID.test(businessId)) return res.status(400).json({ error: "bad business_id" });

    try {
      const business = await db.withTenant(
        businessId,
        async () => {
          const b = await db.fetchBusinessById(businessId);
          if (!b) return null;
          return { ...b, business_capabilities: await db.fetchBusinessCapabilities(businessId) };
        },
        ACTOR
      );
      if (!business) return res.status(404).json({ error: "no such business" });
      const config = db.loadConfig(business);

      // Resolved the way the call itself resolves them (the business's own
      // number, the same env), so the preview is in the call's voice.
      const { resolveLiveLanguage, resolveLiveVoice } = await import("./live/index.js");
      const language = resolveLiveLanguage(config, business.phone_number, env);
      const voice = resolveLiveVoice(config, language.code, env);

      await ensureGreetingClips({ database: db, businessId, config, languageCode: language.code, liveVoice: voice.name, synthesize, log });

      const variant = greetingVariant(config, now());
      const spec = greetingClipSpec(config, { languageCode: language.code, liveVoice: voice.name, variant });
      const row = await db.withTenant(businessId, () => db.fetchGreetingClip(businessId, variant, language.code), ACTOR);
      if (!row?.audio?.length || row.input_hash !== spec.hash) return res.status(502).json({ error: "render failed" });
      res.type("audio/wav").set("Cache-Control", "no-store").send(mulawToWav(Buffer.from(row.audio)));
    } catch (err) {
      log?.error?.("greeting_clip_route_failed", { businessId, reason: err?.message });
      res.status(502).json({ error: "render failed" });
    }
  });
}
