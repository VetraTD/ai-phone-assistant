/**
 * Athenahealth connector: OAuth token helper and EHR tool implementations.
 * Handles get_caller_appointments, get_available_slots, book_appointment_in_ehr.
 * Supports ECC app (ECC_ATHENA_*) vs platform app (ATHENA_*) via config.use_ecc_app.
 * No PHI in logs; HTTPS only.
 */

import { log } from "../lib/logger.js";

const ATHENA_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/** @type {Record<string, { access_token: string, expiresAt: number, api_base: string }>} */
let tokenCache = {};

/** Clear token cache (for tests). */
export function clearAthenaTokenCache() {
  tokenCache = {};
}

/**
 * Resolve env vars for ECC app vs platform app.
 * @param {{ use_ecc_app?: boolean }} [config]
 * @returns {{ clientId: string, clientSecret: string, tokenUrl: string, apiBase: string } | null}
 */
function getAthenaEnv(config = {}) {
  const useEcc = config.use_ecc_app === true;
  const clientId = useEcc ? process.env.ECC_ATHENA_CLIENT_ID : process.env.ATHENA_CLIENT_ID;
  const clientSecret = useEcc ? process.env.ECC_ATHENA_CLIENT_SECRET : process.env.ATHENA_CLIENT_SECRET;
  const tokenUrl = useEcc ? process.env.ECC_ATHENA_TOKEN_URL : process.env.ATHENA_TOKEN_URL;
  const apiBase = (useEcc ? process.env.ECC_ATHENA_API_BASE : process.env.ATHENA_API_BASE) || "";
  if (!clientId || !clientSecret || !tokenUrl) return null;
  return { clientId, clientSecret, tokenUrl, apiBase: apiBase.replace(/\/$/, "") };
}

/**
 * Get access token (cached). Uses ECC_ATHENA_* when config.use_ecc_app is true, else ATHENA_*.
 * @param {{ use_ecc_app?: boolean }} [config] - integration.config
 * @returns {Promise<{ access_token: string, api_base: string } | null>}
 */
export async function getAthenaAccessToken(config = {}) {
  const env = getAthenaEnv(config);
  if (!env) {
    log("athena_token", { error: "missing_config" });
    return null;
  }

  const cacheKey = config.use_ecc_app === true ? "ecc" : "platform";
  const now = Date.now();
  const cached = tokenCache[cacheKey];
  if (cached && cached.expiresAt > now + TOKEN_REFRESH_BUFFER_MS) {
    return { access_token: cached.access_token, api_base: cached.api_base };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ATHENA_TIMEOUT_MS);

  try {
    const auth = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString("base64");
    const res = await fetch(env.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${auth}`,
      },
      body: "grant_type=client_credentials&scope=athena/service/Athenanet.MDP.*",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log("athena_token", { error: "token_failed", status: res.status });
      return null;
    }

    const access_token = data.access_token;
    const expires_in = typeof data.expires_in === "number" ? data.expires_in : 3600;
    tokenCache[cacheKey] = {
      access_token,
      expiresAt: now + expires_in * 1000,
      api_base: env.apiBase,
    };
    log("athena_token", { refreshed: true });
    return { access_token, api_base: env.apiBase };
  } catch (e) {
    clearTimeout(timeoutId);
    const isTimeout = e?.name === "AbortError";
    log("athena_token", { error: isTimeout ? "timeout" : "request_failed" });
    return null;
  }
}

/**
 * GET request to athena API. No PHI in logs.
 * @param {string} apiBase
 * @param {string} practiceId
 * @param {string} accessToken
 * @param {string} path
 * @param {Record<string, string>} [params]
 * @returns {Promise<{ ok: boolean, data?: unknown, status: number }>}
 */
async function athenaGet(apiBase, practiceId, accessToken, path, params = {}) {
  if (!apiBase) return { ok: false, status: 0 };
  const url = new URL(`${apiBase}/v1/${practiceId}/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ATHENA_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, data, status: res.status };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, status: 0 };
  }
}

/**
 * POST request to athena API.
 */
async function athenaPost(apiBase, practiceId, accessToken, path, body = {}) {
  if (!apiBase) return { ok: false, status: 0 };
  const url = `${apiBase}/v1/${practiceId}/${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ATHENA_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, data, status: res.status };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, status: 0 };
  }
}

/**
 * Get caller's upcoming appointments.
 */
export async function getCallerAppointments(apiBase, practiceId, accessToken, args) {
  const start = Date.now();
  const name = String(args?.caller_name || "").trim();
  const dob = args?.caller_dob ? String(args.caller_dob).trim() : "";
  const phone = args?.caller_phone ? String(args.caller_phone).trim() : "";

  if (!name) {
    return { success: false, message: "I need your name to look up appointments." };
  }

  const nameParts = name.split(/\s+/).filter(Boolean);
  const firstname = nameParts[0] || "";
  const lastname = nameParts.slice(1).join(" ") || nameParts[0] || "";
  const patientParams = { firstname, lastname };
  if (dob) patientParams.dob = dob;
  if (phone) patientParams.phone = phone;

  const patientsRes = await athenaGet(apiBase, practiceId, accessToken, "patients", patientParams);
  if (!patientsRes.ok) {
    log("athena_tool", { tool: "get_caller_appointments", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: patientsRes.status });
    return { success: false, message: "I couldn't look up appointments right now. Please try again or call the office." };
  }

  const patients = patientsRes.data?.patients ?? patientsRes.data ?? [];
  const list = Array.isArray(patients) ? patients : [patients];
  const patientId = list[0]?.patientid ?? list[0]?.id ?? null;
  if (!patientId) {
    log("athena_tool", { tool: "get_caller_appointments", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
    return { success: true, message: "I didn't find any upcoming appointments for you." };
  }

  const now = new Date();
  const startDate = now.toISOString().slice(0, 10);
  const endDate = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const apptRes = await athenaGet(apiBase, practiceId, accessToken, `patients/${patientId}/appointments`, { start_date: startDate, end_date: endDate });
  if (!apptRes.ok) {
    log("athena_tool", { tool: "get_caller_appointments", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: apptRes.status });
    return { success: false, message: "I couldn't retrieve your appointments. Please try again or call the office." };
  }

  const appts = apptRes.data?.appointments ?? apptRes.data ?? [];
  const apptList = Array.isArray(appts) ? appts : [appts];
  const upcoming = apptList.filter((a) => {
    const d = a.appointmentdate ?? a.date ?? a.starttime;
    if (!d) return false;
    return new Date(d).getTime() >= Date.now();
  }).slice(0, 3);

  if (upcoming.length === 0) {
    log("athena_tool", { tool: "get_caller_appointments", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
    return { success: true, message: "You don't have any upcoming appointments on the schedule." };
  }

  const parts = upcoming.map((a) => {
    const d = a.appointmentdate ?? a.date ?? a.starttime;
    const time = a.starttime ?? a.time ?? "";
    const provider = a.providername ?? a.provider ?? "";
    const when = [d, time].filter(Boolean).join(" ");
    return when && provider ? `${when} with ${provider}` : when || "scheduled";
  });
  const message = parts.length === 1
    ? `Your next appointment is ${parts[0]}.`
    : `Your next appointments are: ${parts.join("; ")}.`;
  log("athena_tool", { tool: "get_caller_appointments", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
  return { success: true, message };
}

/**
 * Get available appointment slots.
 */
export async function getAvailableSlots(apiBase, practiceId, accessToken, args) {
  const start = Date.now();
  const date = args?.date ? String(args.date).trim() : "";
  if (!date) {
    return { success: false, message: "I need a date to check availability. What day works for you?" };
  }

  const params = { startdate: date, enddate: date };
  if (args?.service_type) params.appointmenttypeid = String(args.service_type);

  const res = await athenaGet(apiBase, practiceId, accessToken, "appointments/bookable", params);
  if (!res.ok) {
    log("athena_tool", { tool: "get_available_slots", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: res.status });
    return { success: false, message: "I couldn't load available times right now. Please try again or call the office." };
  }

  const slots = res.data?.slots ?? res.data?.appointments ?? res.data ?? [];
  const list = Array.isArray(slots) ? slots : [slots];
  const times = list.map((s) => s.starttime ?? s.time ?? s.slotstart ?? s).filter(Boolean).slice(0, 10);

  if (times.length === 0) {
    log("athena_tool", { tool: "get_available_slots", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
    return { success: true, message: `There are no available slots on ${date}. Would you like a different date?` };
  }

  log("athena_tool", { tool: "get_available_slots", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
  return { success: true, message: `Available times on ${date}: ${times.join(", ")}.` };
}

/**
 * Book an appointment.
 */
export async function bookAppointment(apiBase, practiceId, accessToken, args) {
  const start = Date.now();
  const scheduledAt = args?.scheduled_at ? String(args.scheduled_at).trim() : "";
  const serviceType = args?.service_type ? String(args.service_type).trim() : "";
  const name = String(args?.caller_name || "").trim();
  const phone = String(args?.caller_phone || "").trim();
  const dob = args?.caller_dob ? String(args.caller_dob).trim() : "";
  const notes = args?.notes ? String(args.notes).trim() : "";

  if (!scheduledAt || !name) {
    return { success: false, message: "I need your name and the date and time you want to book." };
  }

  const nameParts = name.split(/\s+/).filter(Boolean);
  const firstname = nameParts[0] || "";
  const lastname = nameParts.slice(1).join(" ") || nameParts[0] || "";
  const patientParams = { firstname, lastname };
  if (dob) patientParams.dob = dob;
  if (phone) patientParams.phone = phone;

  const patientsRes = await athenaGet(apiBase, practiceId, accessToken, "patients", patientParams);
  if (!patientsRes.ok) {
    log("athena_tool", { tool: "book_appointment_in_ehr", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: patientsRes.status });
    return { success: false, message: "I couldn't complete the booking right now. Please try again or call the office." };
  }

  const patients = patientsRes.data?.patients ?? patientsRes.data ?? [];
  const list = Array.isArray(patients) ? patients : [patients];
  const patientId = list[0]?.patientid ?? list[0]?.id ?? null;
  if (!patientId) {
    return { success: false, message: "I couldn't find your record. Please call the office to book." };
  }

  const slotRes = await athenaGet(apiBase, practiceId, accessToken, "appointments/bookable", {
    startdate: scheduledAt.slice(0, 10),
    enddate: scheduledAt.slice(0, 10),
  });
  if (!slotRes.ok) {
    log("athena_tool", { tool: "book_appointment_in_ehr", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: slotRes.status });
    return { success: false, message: "I couldn't check availability. Please try again or call the office." };
  }

  const slots = slotRes.data?.slots ?? slotRes.data?.appointments ?? slotRes.data ?? [];
  const slotList = Array.isArray(slots) ? slots : [slots];
  const targetSlot = slotList.find((s) => {
    const t = s.starttime ?? s.time ?? s.slotstart ?? "";
    const d = s.appointmentdate ?? s.date ?? "";
    return String(d).slice(0, 10) === scheduledAt.slice(0, 10) && String(t).includes(scheduledAt.slice(11, 16));
  }) || slotList[0];
  const appointmentId = targetSlot?.appointmentid ?? targetSlot?.id ?? null;

  if (!appointmentId) {
    return { success: false, message: "That time is no longer available. Would you like to choose another?" };
  }

  const bookBody = { patientid: patientId, appointmentid: appointmentId };
  if (notes) bookBody.notes = notes;
  if (serviceType) bookBody.appointmenttypeid = serviceType;

  const bookRes = await athenaPost(apiBase, practiceId, accessToken, `appointments/${appointmentId}/book`, bookBody);
  if (!bookRes.ok) {
    log("athena_tool", { tool: "book_appointment_in_ehr", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: bookRes.status });
    return { success: false, message: "Booking didn't go through. Please try again or call the office." };
  }

  const friendlyDate = new Date(scheduledAt).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  log("athena_tool", { tool: "book_appointment_in_ehr", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
  return { success: true, message: `You're all set! Your appointment is confirmed for ${friendlyDate}.` };
}

/**
 * Execute athena integration: route payload.tool to the right function.
 * Uses integration.config.use_ecc_app to select ECC_ATHENA_* vs ATHENA_* env.
 */
export async function executeAthenahealth(integration, payload) {
  const config = integration?.config || {};
  const practiceId = config.practice_id ? String(config.practice_id).trim() : "";
  if (!practiceId) {
    return { success: false, error: "Missing practice_id in integration config." };
  }

  const tokenResult = await getAthenaAccessToken(config);
  if (!tokenResult?.access_token) {
    return { success: false, error: "Could not get athena access token.", message: "The scheduling system is temporarily unavailable. Please call the office." };
  }

  const { access_token, api_base } = tokenResult;
  const tool = payload?.tool || "";
  const args = payload?.arguments || {};

  switch (tool) {
    case "get_caller_appointments": {
      const result = await getCallerAppointments(api_base, practiceId, access_token, args);
      return { success: result.success, message: result.message };
    }
    case "get_available_slots": {
      const result = await getAvailableSlots(api_base, practiceId, access_token, args);
      return { success: result.success, message: result.message };
    }
    case "book_appointment_in_ehr": {
      const result = await bookAppointment(api_base, practiceId, access_token, args);
      return { success: result.success, message: result.message };
    }
    default:
      return { success: false, error: `Unknown athena tool: ${tool}`, message: "That action isn't available right now." };
  }
}
