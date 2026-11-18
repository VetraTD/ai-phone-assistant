import { isValidE164 } from "./validate.js";
import { MODES } from "./deploymentMode.js";
import { nonCoveredCredentialsPresent, NON_COVERED_VENDORS } from "./compliance.js";
import { liveSurface, LIVE_MODEL_DEFAULT } from "./voice/live/surface.js";

/**
 * Boot-time configuration checks.
 *
 * The standing rule these implement: a subsystem disabled by missing config
 * must announce itself loudly at boot. The reason it is a rule is that two
 * live features looked like they were working and were not — a notification
 * that is dropped because there is no mail transport is indistinguishable, from
 * the outside, from a notification that was never triggered.
 *
 * ---------------------------------------------------------------------------
 * Where the fatal line is drawn, and why it is not "anything unconfigured"
 * ---------------------------------------------------------------------------
 *
 * FATAL is reserved for configuration that CANNOT be what anyone intended:
 * half a credential pair, a from-number with no client behind it, a from-number
 * that no carrier will accept, an explicit request for notifications with
 * nothing to deliver them on. None of those has a reading in which the operator
 * got what they asked for.
 *
 * ANNOUNCE covers configuration that is merely absent. Absent is a choice, and
 * the check cannot tell a deliberate choice from an oversight.
 *
 * The case that forces the distinction is `TWILIO_ACCOUNT_SID` +
 * `TWILIO_AUTH_TOKEN` with no `TWILIO_SMS_FROM`. Those two are ALSO the voice
 * credentials, so a deployment that uses Twilio for calls and never for texts
 * is a perfectly ordinary configuration. Refusing to boot on it would take the
 * receptionist off the air in order to protect a notification, which inverts
 * the priority: a silently dropped owner email is a defect, and a phone that
 * does not answer is an outage.
 *
 * What still catches that case is the announcement. It is loud, it names the
 * subsystem, and it is emitted on every boot — which is the actual requirement.
 */

export const FATAL = "fatal";
export const ANNOUNCE = "announce";

/** Present and not the empty/whitespace string. */
function set(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Inspect notification configuration.
 *
 * Pure: takes an env-shaped object and returns findings. It deliberately does
 * NOT import services/notifications.js — that module computes its constants at
 * import time and importing it here would make the checker's answer depend on
 * import order. The cost is a second reader of the same env, which is how a
 * check drifts away from the thing it checks; tests/bootChecks.test.js pins the
 * two together across the env combinations that matter.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ findings: Array<{ code: string, severity: string, detail: string }>,
 *             email: boolean, sms: boolean, notificationsEnabled: boolean }}
 */
export function checkNotificationConfig(env = process.env) {
  const findings = [];
  const add = (severity, code, detail) => findings.push({ code, severity, detail });

  const smtpUser = set(env.SMTP_USER);
  const smtpPass = set(env.SMTP_PASS);
  const twilioSid = set(env.TWILIO_ACCOUNT_SID);
  const twilioToken = set(env.TWILIO_AUTH_TOKEN);
  const smsFrom = set(env.TWILIO_SMS_FROM);

  // Mirrors services/notifications.js exactly. Any change there is a change here.
  const email = smtpUser && smtpPass;
  const sms = twilioSid && twilioToken && smsFrom;
  const disabledByEnv = env.NOTIFICATIONS_ENABLED === "false";
  const notificationsEnabled = !disabledByEnv && (email || sms);

  if (smtpUser !== smtpPass) {
    add(
      FATAL,
      "smtp_half_configured",
      `SMTP_USER is ${smtpUser ? "set" : "unset"} and SMTP_PASS is ${smtpPass ? "set" : "unset"}. ` +
        "Nobody sets half a credential pair on purpose; email notifications would be dropped silently."
    );
  }

  if (smsFrom && !(twilioSid && twilioToken)) {
    add(
      FATAL,
      "sms_from_without_client",
      "TWILIO_SMS_FROM is set but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN are not. " +
        "There is no client to send from that number, so every SMS would be dropped silently."
    );
  }

  if (smsFrom && !isValidE164(env.TWILIO_SMS_FROM)) {
    add(
      FATAL,
      "sms_from_not_e164",
      `TWILIO_SMS_FROM=${JSON.stringify(env.TWILIO_SMS_FROM)} is not E.164 (+ and 1-15 digits). ` +
        "Twilio rejects every send, and the rejection is swallowed by the notification error handler."
    );
  }

  // Explicitly asked for, and undeliverable. Note the test for presence: an
  // UNSET variable is the default and means "on if a channel exists", which is
  // not a request and not an error.
  if (env.NOTIFICATIONS_ENABLED !== undefined && !disabledByEnv && !email && !sms) {
    add(
      FATAL,
      "notifications_forced_on_with_no_channel",
      `NOTIFICATIONS_ENABLED=${JSON.stringify(env.NOTIFICATIONS_ENABLED)} but neither SMTP nor Twilio SMS is ` +
        "configured. The setting evaluates to off, so the request silently did nothing."
    );
  }

  if (disabledByEnv) {
    // Turned off on purpose. The per-channel detail below would be noise: the
    // operator is not one variable away from working notifications, they asked
    // for none.
    add(ANNOUNCE, "notifications_disabled_by_env", "NOTIFICATIONS_ENABLED=false — no owner notifications will be sent.");
    return { findings, email, sms, notificationsEnabled };
  }

  // Per-channel first, and NOT as an else-branch of the summary below. The
  // whole value of the announcement is the specific fact — "Twilio is
  // configured and TWILIO_SMS_FROM is missing" tells an operator they are one
  // variable from working; "notifications are off" does not.
  if (!email) {
    add(
      ANNOUNCE,
      "email_channel_off",
      "SMTP is not configured — every business with notification_email set will silently receive no email."
    );
  }
  if (!sms) {
    add(
      ANNOUNCE,
      "sms_channel_off",
      "Twilio SMS is not configured" +
        (twilioSid && twilioToken && !smsFrom ? " (TWILIO_ACCOUNT_SID/TOKEN are set; TWILIO_SMS_FROM is not)" : "") +
        " — every business with notification_phone set will silently receive no text, " +
        "and caller SMS follow-ups will not send."
    );
  }
  if (!email && !sms) {
    add(
      ANNOUNCE,
      "notifications_off",
      "Neither channel is configured — owner notifications are off entirely."
    );
  }

  // A1.3 made every owner notification link-only, so the link is now the entire
  // payload. Without DASHBOARD_URL the message still sends and still says what
  // happened, but it cannot say where to look — which is most of its value.
  // Announced rather than fatal: there is no correct URL to guess, and a
  // notification that is merely less useful is not worth an outage.
  if ((email || sms) && !set(env.DASHBOARD_URL)) {
    add(
      ANNOUNCE,
      "dashboard_url_unset",
      "DASHBOARD_URL is not set — owner notifications will say to open the dashboard without linking to it. " +
        "Notification bodies carry no details by design (A1.3), so the link is the payload."
    );
  }

  return { findings, email, sms, notificationsEnabled };
}

/**
 * Inspect DEPLOYMENT_MODE.
 *
 * The only finding here is fatal, and the reason is the direction of the
 * mistake. `DEPLOYMENT_MODE=hippa` reads at a glance as if it turned the
 * protections on. Defaulting an unrecognised value to `standard` would turn
 * every one of them OFF while looking correct — the failure would be invisible
 * precisely to the person who was trying to be careful.
 *
 * An UNSET variable is not a typo. It defaults to `standard` and is announced,
 * because HIPAA obligations follow a signed BAA and a covered entity, not an
 * environment variable.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ findings: Array<{ code: string, severity: string, detail: string }>, mode: string }}
 */
export function checkDeploymentMode(env = process.env) {
  const findings = [];
  const raw = (env.DEPLOYMENT_MODE || "").trim().toLowerCase();
  const mode = raw === "" ? "standard" : raw;

  if (!MODES.includes(mode)) {
    findings.push({
      code: "deployment_mode_unrecognised",
      severity: FATAL,
      detail:
        `DEPLOYMENT_MODE=${JSON.stringify(env.DEPLOYMENT_MODE)} is not one of: ${MODES.join(", ")}. ` +
        "Refusing rather than defaulting: an unrecognised value would silently run as `standard` with " +
        "every HIPAA protection off, while reading as though they were on.",
    });
  } else if (mode === "hipaa") {
    findings.push({
      code: "deployment_mode_hipaa",
      severity: ANNOUNCE,
      detail: "DEPLOYMENT_MODE=hipaa — tenant webhooks without a recorded BAA will be refused.",
    });
  }

  return { findings, mode };
}

/**
 * Inspect database configuration.
 *
 * A3 replaced the Supabase client with `pg`, so the variable that decides
 * whether this process has a database changed from SUPABASE_URL /
 * SUPABASE_SERVICE_KEY to DATABASE_URL. A deployment that carries the old pair
 * forward and not the new one starts perfectly happily and answers every call
 * as "our office" with no business config, no knowledge base and no capability
 * rows — which is a working receptionist for the wrong company.
 *
 * ANNOUNCED, not fatal, and the reason is that the degraded path is deliberate:
 * the server is designed to keep answering when the database is unreachable
 * (see tests/degradedMode.test.js) because a call that gets a human-sounding
 * apology beats a call that rings out. Refusing to boot would convert an
 * outage of the database into an outage of the phone line.
 *
 * @param {Record<string, string|undefined>} env
 */
export function checkDatabaseConfig(env = process.env) {
  const findings = [];

  // Two ways to be configured, and this check knew about only one. On Cloud Run
  // the app connects through CLOUD_SQL_INSTANCE with IAM authentication and
  // there is no DATABASE_URL at all — so a correctly configured production
  // deployment would have announced "every call runs on default config" at
  // every boot. An alarm that fires when nothing is wrong is an alarm people
  // learn to scroll past, which costs the real one.
  if (set(env.CLOUD_SQL_INSTANCE)) {
    // Both set is not a fallback, it is ambiguity: two databases named, no way
    // to know which one the operator meant, and the wrong answer writes patient
    // data somewhere nobody is looking. services/db.js refuses to start on it;
    // this reports it at boot with the rest of the configuration problems.
    if (set(env.DATABASE_URL)) {
      findings.push({
        code: "database_double_configured",
        severity: FATAL,
        detail:
          "Both DATABASE_URL and CLOUD_SQL_INSTANCE are set. Nobody names two databases on purpose, " +
          "and choosing one silently would mean writing to whichever this code happened to prefer.",
      });
    }
    return { findings };
  }

  if (!set(env.DATABASE_URL)) {
    findings.push({
      code: "database_not_configured",
      severity: ANNOUNCE,
      detail:
        "DATABASE_URL is not set — every call runs on default config: no business name, no greeting, " +
        "no knowledge base, no capabilities. If SUPABASE_URL is set instead, this deployment predates " +
        "the move to Postgres and needs its connection string updated.",
    });
  }
  return { findings };
}

/**
 * Can this process verify a staff login at all?
 *
 * ANNOUNCE rather than FATAL, and the line is worth stating: the voice server's
 * job is answering the phone, and a call needs no staff token. Refusing to boot
 * would take the receptionist off the air over a dashboard-only setting.
 *
 * But it must not be SILENT. Without IDENTITY_PLATFORM_PROJECT_ID every
 * authenticated route returns 401 and the dashboard looks like everybody's
 * password stopped working — a whole-product outage whose only visible symptom
 * is at the wrong layer. This is the same class as B2's "two live features
 * looked working and were not", and the same remedy: say so at boot.
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function checkAuthConfig(env = process.env) {
  const findings = [];
  if (!set(env.IDENTITY_PLATFORM_PROJECT_ID)) {
    findings.push({
      code: "auth_not_configured",
      severity: ANNOUNCE,
      detail:
        "IDENTITY_PLATFORM_PROJECT_ID is not set — no access token can be verified, so every " +
        "authenticated API route returns 401 and the dashboard cannot load anything. Calls are " +
        "unaffected. Note this is the project that ISSUES the tokens (vetra-shared), not the one " +
        "this process runs in.",
    });
  }
  return { findings };
}

/**
 * In `hipaa` mode, a non-covered vendor credential must not exist.
 *
 * FATAL, and this is the one place in this file where fatal is not about the
 * operator having made an incoherent choice — it is about the stack not being
 * the stack it claims to be.
 *
 * The two-region design's core safety property is that `voice-us` HOLDS NO
 * ELEVENLABS KEY, so a misconfiguration yields voicemail rather than a
 * reportable disclosure. A key being present in a `hipaa` process means that
 * property has already failed: the credential reached a project it was never
 * supposed to be in. Booting anyway would leave a process that is one library
 * call away from sending PHI to a vendor with no BAA, and lib/compliance.js
 * refusing at the constructor is a second line of defence, not a reason to
 * ignore the first one having fallen over.
 *
 * Refusing here costs an outage on a stack that should never have started.
 * Not refusing costs a disclosure.
 *
 * @param {Record<string, string|undefined>} env
 */
export function checkCoveredVendors(env = process.env) {
  const findings = [];
  const mode = (env.DEPLOYMENT_MODE || "").trim().toLowerCase();
  if (mode !== "hipaa") return { findings };

  for (const { vendor, credential } of nonCoveredCredentialsPresent(env)) {
    findings.push({
      code: "non_covered_credential_present",
      severity: FATAL,
      detail:
        `${credential} is set in a DEPLOYMENT_MODE=hipaa process. ` +
        `${NON_COVERED_VENDORS[vendor].label} has no BAA. Its presence means this credential reached a ` +
        "project it was never meant to be in, which is the isolation the two-region design rests on. " +
        `Covered alternative: ${NON_COVERED_VENDORS[vendor].covered}.`,
    });
  }
  return { findings };
}

/**
 * Every deployment needs a speech-to-text provider it is ALLOWED to use.
 *
 * ---------------------------------------------------------------------------
 * The contradiction this replaces
 * ---------------------------------------------------------------------------
 *
 * `server.js` exited without `DEEPGRAM_API_KEY` — "there is no fallback mode"
 * — while `checkCoveredVendors` above exits WITH one in `hipaa` mode, because
 * no BAA covers Deepgram. Those are not two bugs. They are one requirement
 * written twice by people who did not know about each other, and NO value of
 * the environment satisfied both: the US production stack could not answer a
 * call in either direction. It was found by deploying, as
 * `FATAL non_covered_credential_present`, and it is why staging runs
 * `standard`.
 *
 * The requirement is mode-shaped, so the check is too. Which provider a
 * deployment needs follows the compliance tier, exactly as
 * lib/voice/sttStream.js routes it:
 *
 *   standard -> DEEPGRAM_API_KEY        (UK lane, local dev)
 *   hipaa    -> GOOGLE_CLOUD_PROJECT    (Google STT v2, BAA-covered)
 *
 * FATAL in both directions, and this is the rare case where an outage is
 * clearly right: a receptionist that cannot hear does not degrade gracefully,
 * it answers the phone and says nothing.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ findings: Array<{ code: string, severity: string, detail: string }>, provider: string }}
 */
export function checkSttConfig(env = process.env) {
  const findings = [];
  const mode = (env.DEPLOYMENT_MODE || "").trim().toLowerCase();
  const provider = mode === "hipaa" ? "google" : "deepgram";

  if (provider === "google") {
    if (!set(env.GOOGLE_CLOUD_PROJECT)) {
      findings.push({
        code: "stt_not_configured",
        severity: FATAL,
        detail:
          "DEPLOYMENT_MODE=hipaa needs GOOGLE_CLOUD_PROJECT: the covered lane transcribes with " +
          "Google Speech-to-Text v2, which addresses its recognizer by project and location. " +
          "Deepgram is NOT the fallback here — it has no BAA and checkCoveredVendors refuses to " +
          "boot with its credential present.",
      });
    }
    // Refused at boot rather than on the first call, because the first call is
    // a caller. A `global` endpoint may process audio in any region on earth,
    // which voids the HIPAA data-location control outright.
    const location = (env.STT_LOCATION || "").trim().toLowerCase();
    if (location === "global") {
      findings.push({
        code: "stt_location_global",
        severity: FATAL,
        detail:
          "STT_LOCATION=global sends caller audio to whichever region has capacity, anywhere in " +
          "the world. Set a single region. This is the same trap VERTEX_LOCATION carries.",
      });
    }
  } else if (!set(env.DEEPGRAM_API_KEY)) {
    findings.push({
      code: "stt_not_configured",
      severity: FATAL,
      detail:
        "DEEPGRAM_API_KEY is not set and this is not a `hipaa` deployment. The Media Streams voice " +
        "pipeline has no other speech-to-text in `standard` mode, so every call would be answered " +
        "by a receptionist that cannot hear.",
    });
  }

  // Announced on every boot in both modes. Which vendor hears the caller is
  // the single most consequential fact about a covered deployment, and it is
  // derived rather than configured — so it must be visible without reading the
  // routing code.
  findings.push({
    code: "stt_provider",
    severity: ANNOUNCE,
    detail:
      `Speech-to-text provider: ${provider === "google" ? "Google Speech-to-Text v2" : "Deepgram nova-3"}` +
      ` (DEPLOYMENT_MODE=${mode || "standard"})` +
      (provider === "google" ? ` in ${env.STT_LOCATION || "us-central1"}` : ""),
  });

  return { findings, provider };
}

/**
 * The Live front-end must be able to reach a model, or not answer at all.
 *
 * ---------------------------------------------------------------------------
 * Why this is FATAL and not a notice
 * ---------------------------------------------------------------------------
 *
 * `createLiveClient` THROWS when the credential for the selected surface is
 * missing, but nothing in `/twilio/live-voice`'s try block ever calls it or
 * contacts a model — that route only allowlists the caller, looks up the
 * business, mints a stream token and returns TwiML, bumping
 * `live_connect_ok` before any model is touched. `createLiveClient` runs
 * later, inside `connectLive`, in the WebSocket handler Twilio opens next.
 * So a missing credential is not caught here at all: the call is answered,
 * the counter looks healthy, the socket opens, `connectLive` throws, and the
 * handler closes it with no verb behind `<Connect>` for Twilio to fall back
 * to. The caller hears pickup, dead air, and a hangup — never the cascade.
 *
 * So this boot check is not a second line of defence. It is the only one.
 *
 * ---------------------------------------------------------------------------
 * The hipaa case, and why checkCoveredVendors cannot cover it
 * ---------------------------------------------------------------------------
 *
 * NON_COVERED_VENDORS["gemini-developer-api"] carries `credentials: []` — there
 * is no credential name for a scan to find, so the covered-vendor check reads
 * clean while the Developer API is exactly what the process would call.
 * `assertVendorAllowed` does refuse at construction, but that refusal is a
 * throw, and tier 2 swallows throws. Same silence, different door.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ findings: Array<{ code: string, severity: string, detail: string }>, surface: string }}
 */
export function checkLiveSurface(env = process.env) {
  const findings = [];
  const surface = liveSurface(env);
  const mode = (env.DEPLOYMENT_MODE || "").trim().toLowerCase();

  if (surface === "vertex") {
    if (!set(env.GOOGLE_CLOUD_PROJECT)) {
      findings.push({
        code: "live_surface_not_configured",
        severity: FATAL,
        detail:
          "LIVE_SURFACE=vertex needs GOOGLE_CLOUD_PROJECT. createLiveClient refuses to fall back " +
          "to the Gemini Developer API here, and /twilio/live-voice never calls it or catches this " +
          "refusal — the call would be answered, live_connect_ok would bump, and the WebSocket " +
          "handler would throw and hang up on the caller with silence, not the cascade.",
      });
    }
  } else {
    if (!set(env.GEMINI_API_KEY)) {
      findings.push({
        code: "live_surface_not_configured",
        severity: FATAL,
        detail:
          "GEMINI_API_KEY is not set and LIVE_SURFACE is not vertex, so the Live front-end cannot " +
          "open a session. /twilio/live-voice never calls createLiveClient and would not catch this " +
          "on EVERY call: it answers, bumps live_connect_ok, and only THEN opens the WebSocket that " +
          "fails — the caller gets pickup, silence and a hangup, not the cascade. The key belongs " +
          "in Secret Manager, via `gcloud secrets versions add gemini-api-key` — " +
          "scripts/push-secrets.js deliberately excludes this credential — not .env.",
      });
    }
    if (mode === "hipaa") {
      findings.push({
        code: "live_surface_not_covered",
        severity: FATAL,
        detail:
          "LIVE_SURFACE=aistudio in a DEPLOYMENT_MODE=hipaa process. The Gemini Developer API is " +
          "not a Google Cloud service and the Cloud BAA does not reach it, while a Live session " +
          "carries the caller's entire utterance. checkCoveredVendors cannot see this — " +
          "gemini-developer-api has no credential name to scan for. Covered alternative: " +
          "LIVE_SURFACE=vertex with GOOGLE_CLOUD_PROJECT.",
      });
    }
  }

  // Announced every boot. Which company processes caller speech, and on which
  // model, is the most consequential fact about this deployment and it is
  // selected by two variables that are easy to leave unset.
  findings.push({
    code: "live_surface",
    severity: ANNOUNCE,
    detail:
      `Live front-end surface: ${surface === "vertex" ? "Vertex AI" : "Gemini Developer API (AI Studio)"}` +
      `, model ${env.LIVE_MODEL || LIVE_MODEL_DEFAULT}` +
      (surface === "vertex" ? ` in ${env.VERTEX_LOCATION || "europe-west1"}` : ""),
  });

  return { findings, surface };
}

/**
 * Run every boot check, announce the results, and throw if any are fatal.
 *
 * Announces BEFORE throwing: a process that dies without saying why is the
 * silent failure this file exists to remove, one level up.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {{ log?: (...args: unknown[]) => void }} [opts]
 */
export function assertBootConfig(env = process.env, opts = {}) {
  const emit = opts.log || console.error;
  const findings = [
    ...checkDeploymentMode(env).findings,
    ...checkCoveredVendors(env).findings,
    ...checkSttConfig(env).findings,
    ...checkLiveSurface(env).findings,
    ...checkDatabaseConfig(env).findings,
    ...checkAuthConfig(env).findings,
    ...checkNotificationConfig(env).findings,
  ];

  for (const f of findings) {
    emit(`[boot] ${f.severity === FATAL ? "FATAL" : "notice"} ${f.code}: ${f.detail}`);
  }

  const fatal = findings.filter((f) => f.severity === FATAL);
  if (fatal.length) {
    throw new Error(
      `Refusing to boot: ${fatal.length} fatal configuration problem(s) — ` +
        fatal.map((f) => f.code).join(", ") +
        ". Each one would have failed silently at runtime."
    );
  }
}
