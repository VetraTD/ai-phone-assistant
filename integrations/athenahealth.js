/**
 * Athenahealth connector: OAuth token helper and EHR tool implementations.
 * Handles get_caller_appointments, get_available_slots, book_appointment_in_ehr,
 * cancel_appointment, reschedule_appointment.
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

// ---------------------------------------------------------------------------
// Low-level HTTP helpers (GET / POST / PUT)
// ---------------------------------------------------------------------------

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

  const maxRetries = 1;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      if (res.status === 429 && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return { ok: res.ok, data, status: res.status };
    } catch (e) {
      clearTimeout(timeoutId);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return { ok: false, status: 0 };
    }
  }
}

/**
 * POST request to athena API.
 */
async function athenaPost(apiBase, practiceId, accessToken, path, body = {}) {
  if (!apiBase) return { ok: false, status: 0 };
  const url = `${apiBase}/v1/${practiceId}/${path}`;

  const maxRetries = 1;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      if (res.status === 429 && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return { ok: res.ok, data, status: res.status };
    } catch (e) {
      clearTimeout(timeoutId);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return { ok: false, status: 0 };
    }
  }
}

/**
 * PUT request to athena API (form-encoded, as Athena expects).
 */
async function athenaPut(apiBase, practiceId, accessToken, path, body = {}) {
  if (!apiBase) return { ok: false, status: 0 };
  const url = `${apiBase}/v1/${practiceId}/${path}`;
  const formBody = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v != null && v !== "") formBody.set(k, String(v));
  }
  const maxRetries = 1;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ATHENA_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formBody.toString(),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const data = await res.json().catch(() => null);
      if (res.status === 429 && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return { ok: res.ok, data, status: res.status };
    } catch (e) {
      clearTimeout(timeoutId);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return { ok: false, status: 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// Date format helpers — Athena uses MM/DD/YYYY everywhere
// ---------------------------------------------------------------------------

/**
 * Convert a date to Athena's MM/DD/YYYY format.
 * Accepts ISO (YYYY-MM-DD), MM/DD/YYYY, or Date objects.
 */
function toAthenaDate(input) {
  if (!input) return "";
  const s = String(input).trim();
  // Already MM/DD/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  // ISO YYYY-MM-DD (with optional time)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`;
  // Try Date parsing as last resort
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getFullYear()}`;
  }
  return s; // pass through as-is
}

/**
 * Convert Athena MM/DD/YYYY to ISO YYYY-MM-DD for comparisons.
 */
function athenaDateToISO(input) {
  if (!input) return "";
  const s = String(input).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return s; // already ISO or unknown
}

/**
 * Normalize a date string (any format) to ISO YYYY-MM-DD for comparison.
 */
function normalizeToISO(input) {
  if (!input) return "";
  const s = String(input).trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Athena MM/DD/YYYY
  return athenaDateToISO(s);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Parse a full name into first/last parts.
 * @param {string} name
 * @returns {{ firstname: string, lastname: string }}
 */
function parseName(name) {
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    firstname: parts[0] || "",
    lastname: parts.slice(1).join(" ") || parts[0] || "",
  };
}

/**
 * Normalize a DOB string to ISO YYYY-MM-DD, accepting common formats.
 */
function normalizeDobToISO(input) {
  if (!input) return "";
  const s = String(input).trim();
  // Try ISO first
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Try MM/DD/YYYY
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  // Fallback to Date parsing
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  return "";
}

/**
 * Search for a patient by name + DOB (required). Phone used to disambiguate.
 * Returns { patientId, message } — if patientId is null, message explains why.
 * Semantics are aligned with the Python AthenaSandboxConnector.lookup_patient.
 */
async function resolvePatient(apiBase, practiceId, accessToken, { name, dob, phone }) {
  if (!name || !dob) {
    return { patientId: null, message: "I need your full name and date of birth to look you up." };
  }

  const { firstname, lastname } = parseName(name);
  const targetDobISO = normalizeDobToISO(dob);
  const lastLower = lastname.trim().toLowerCase();
  const firstLower = firstname.trim().toLowerCase();

  // Match Python behavior: always search by last name, optionally first name; limit results.
  const params = {
    lastname: lastLower,
    limit: "100",
  };
  if (firstname) params.firstname = firstname;

  const res = await athenaGet(apiBase, practiceId, accessToken, "patients", params);
  if (!res.ok) {
    return { patientId: null, message: "I'm having trouble reaching the system right now. Please try again or call the office." };
  }

  const rawPatients = res.data?.patients ?? res.data ?? [];
  const allPatients = Array.isArray(rawPatients) ? rawPatients : rawPatients ? [rawPatients] : [];

  if (!targetDobISO) {
    return { patientId: null, message: "I couldn't understand that date of birth. Please say it as month, day, and year." };
  }

  // Collect candidates matching name + DOB
  const candidates = [];
  for (const p of allPatients) {
    const pDobISO = normalizeDobToISO(p.dob);
    if (pDobISO && pDobISO !== targetDobISO) continue;
    const pFirst = String(p.firstname || "").trim().toLowerCase();
    const pLast = String(p.lastname || "").trim().toLowerCase();
    if (firstLower && pFirst !== firstLower) continue;
    if (lastLower && pLast !== lastLower) continue;
    const pid = p.patientid ?? p.id;
    if (!pid) continue;
    candidates.push(p);
  }

  if (candidates.length === 0) {
    return {
      patientId: null,
      message: "I wasn't able to find a patient record with that name and date of birth. Could you double-check your information?",
    };
  }

  const pickId = (p) => p.patientid ?? p.id ?? null;

  if (candidates.length === 1) {
    const id = pickId(candidates[0]);
    return id
      ? { patientId: String(id), message: null }
      : { patientId: null, message: "I found your record but couldn't read the patient ID. Please call the office for help." };
  }

  // Multiple matches — use phone to disambiguate when available.
  if (phone) {
    const normalizedCaller = phone.replace(/\D/g, "").slice(-10);
    const match = candidates.find((p) => {
      const pPhone = String(p.mobilephone ?? p.homephone ?? p.phone ?? "").replace(/\D/g, "").slice(-10);
      return pPhone && normalizedCaller && pPhone === normalizedCaller;
    });
    if (match) {
      const id = pickId(match);
      return id
        ? { patientId: String(id), message: null }
        : { patientId: null, message: "I found your record but couldn't read the patient ID. Please call the office for help." };
    }
  }

  // Still ambiguous — ask for phone or offer transfer, mirroring Python semantics.
  return {
    patientId: null,
    message: phone
      ? "I found more than one patient with that name and date of birth, and I wasn't able to narrow it down with your phone number. Let me transfer you to someone who can help."
      : "I found more than one patient with that name and date of birth. Can you give me your phone number so I can verify your identity?",
  };
}

/**
 * Look up a patient's upcoming appointments and find one matching a date (and optionally time).
 * Used by cancel and reschedule to resolve appointment without requiring an ID from the caller.
 */
async function findPatientAppointment(apiBase, practiceId, accessToken, patientId, { appointmentDate, appointmentTime }) {
  const now = new Date();
  const startDate = toAthenaDate(now.toISOString().slice(0, 10));
  const endDate = toAthenaDate(new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));

  const res = await athenaGet(apiBase, practiceId, accessToken, `patients/${patientId}/appointments`, {
    startdate: startDate,
    enddate: endDate,
  });
  if (!res.ok) {
    return { appointment: null, appointments: [], message: "I couldn't retrieve your appointments right now. Please try again or call the office." };
  }

  const raw = res.data?.appointments ?? res.data ?? [];
  const all = (Array.isArray(raw) ? raw : [raw]).filter((a) => {
    const d = a.appointmentdate ?? a.date ?? "";
    if (!d) return false;
    const iso = normalizeToISO(d);
    return iso >= now.toISOString().slice(0, 10);
  });

  if (all.length === 0) {
    return { appointment: null, appointments: [], message: "You don't have any upcoming appointments on the schedule." };
  }

  // If caller provided a date, match on it
  const targetDateISO = appointmentDate ? normalizeToISO(appointmentDate) : "";
  if (targetDateISO) {
    const dateMatches = all.filter((a) => {
      const d = normalizeToISO(a.appointmentdate ?? a.date ?? "");
      return d === targetDateISO;
    });

    if (dateMatches.length === 0) {
      const summaries = all.slice(0, 5).map((a) => formatAppointmentBrief(a));
      return {
        appointment: null,
        appointments: all,
        message: `I don't see an appointment on that date. Your upcoming appointments are: ${summaries.join("; ")}. Which one would you like?`,
      };
    }

    // If time was also provided, narrow further
    if (appointmentTime && dateMatches.length > 1) {
      const timeMatch = dateMatches.find((a) => {
        const t = String(a.starttime ?? a.time ?? "");
        return t.includes(appointmentTime);
      });
      if (timeMatch) return { appointment: timeMatch, appointments: all, message: null };
    }

    if (dateMatches.length === 1) {
      return { appointment: dateMatches[0], appointments: all, message: null };
    }

    // Multiple on same date, no time to disambiguate
    const summaries = dateMatches.map((a) => formatAppointmentBrief(a));
    return {
      appointment: null,
      appointments: all,
      message: `I see ${dateMatches.length} appointments on that date: ${summaries.join("; ")}. Which one are you referring to?`,
    };
  }

  // No date given and only one upcoming — assume that's it
  if (all.length === 1) {
    return { appointment: all[0], appointments: all, message: null };
  }

  // Multiple upcoming, no date specified — ask
  const summaries = all.slice(0, 5).map((a) => formatAppointmentBrief(a));
  return {
    appointment: null,
    appointments: all,
    message: `You have ${all.length} upcoming appointment${all.length > 1 ? "s" : ""}: ${summaries.join("; ")}. Which one would you like to change?`,
  };
}

/**
 * Format an appointment object into a short human-friendly string.
 */
function formatAppointmentBrief(appt) {
  const d = appt.appointmentdate ?? appt.date ?? "";
  const t = appt.starttime ?? appt.time ?? "";
  const provider = appt.providername ?? appt.provider ?? "";
  const type = appt.appointmenttypename ?? appt.appointmenttype ?? "";
  const parts = [d, t].filter(Boolean).join(" at ");
  const extra = [provider, type].filter(Boolean).join(", ");
  return extra ? `${parts} (${extra})` : parts || "scheduled";
}

/**
 * Normalize an appointment into a consistent structure for the data payload.
 */
function normalizeAppointment(appt) {
  return {
    appointmentId: String(appt.appointmentid ?? appt.id ?? ""),
    date: appt.appointmentdate ?? appt.date ?? "",
    time: appt.starttime ?? appt.time ?? "",
    provider: appt.providername ?? appt.provider ?? "",
    type: appt.appointmenttypename ?? appt.appointmenttype ?? "",
    status: appt.appointmentstatus ?? appt.status ?? "",
    department: appt.departmentid ?? "",
  };
}

/**
 * Normalize a slot from /appointments/open into a consistent structure.
 */
function normalizeSlot(slot, fallbackDate) {
  const rawDate = slot.date ?? slot.appointmentdate ?? fallbackDate ?? "";
  const rawTime = slot.starttime ?? slot.start ?? "";
  const dateISO = normalizeToISO(rawDate);
  const time = String(rawTime || "").slice(0, 5);
  const start = dateISO && time ? `${dateISO}T${time}` : dateISO || "";
  const endRaw = slot.endtime ?? slot.end ?? start;
  const end = endRaw && typeof endRaw === "string" && endRaw.includes("T") ? endRaw : start;

  const providerIdRaw = slot.providerid ?? slot.provider_id ?? 0;
  const departmentIdRaw = slot.departmentid ?? slot.department_id ?? null;
  const aptTypeRaw = slot.appointmenttypeid ?? slot.appointment_type_id ?? null;
  const newApptId = slot.appointmentid ?? slot.appointment_id ?? slot.id ?? null;

  return {
    start,
    end,
    providerId: typeof providerIdRaw === "number" ? providerIdRaw : parseInt(String(providerIdRaw || "0"), 10) || 0,
    providerName: slot.providername ?? slot.provider_name ?? `Provider ${providerIdRaw || ""}`,
    departmentId: departmentIdRaw != null ? String(departmentIdRaw) : null,
    departmentName: slot.department_name ?? null,
    appointmentTypeId: aptTypeRaw != null ? String(aptTypeRaw) : null,
    newAppointmentId: newApptId != null ? String(newApptId) : null,
  };
}

/**
 * Build query parameters for /appointments/open, mirroring the Python connector.
 * Optionally accepts extra filters (e.g. providerId) via the fourth argument.
 */
function buildOpenSlotParams(date, departmentId, serviceType, options = {}) {
  const athenaDate = toAthenaDate(date);
  const params = {
    startdate: athenaDate,
    enddate: athenaDate,
    departmentid: departmentId,
    limit: "20",
    offset: "0",
    ignoreschedulablepermission: "true",
    bypassscheduletimechecks: "true",
  };

  const envAny15 = process.env.ATHENA_APPOINTMENT_TYPE_ANY15_ID;
  const envType = process.env.ATHENA_APPOINTMENT_TYPE_ID;
  if (serviceType) {
    params.appointmenttypeid = String(serviceType);
  } else if (envAny15 && String(envAny15).trim()) {
    params.appointmenttypeid = String(envAny15).trim();
  } else if (envType && String(envType).trim()) {
    params.appointmenttypeid = String(envType).trim();
  } else {
    params.reasonid = "-1";
  }

  if (options.providerId) {
    params.providerid = String(options.providerId);
  }

  return params;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/**
 * Get caller's upcoming appointments.
 */
export async function getCallerAppointments(apiBase, practiceId, accessToken, args) {
  const start = Date.now();
  const name = String(args?.caller_name || "").trim();
  const dob = args?.caller_dob ? String(args.caller_dob).trim() : "";
  const phone = args?.caller_phone ? String(args.caller_phone).trim() : "";

  if (!name || !dob) {
    return { success: false, message: "I need your full name and date of birth to look up your appointments." };
  }

  const patient = await resolvePatient(apiBase, practiceId, accessToken, { name, dob, phone });
  if (!patient.patientId) {
    log("athena_tool", { tool: "get_caller_appointments", practice_id: practiceId, duration_ms: Date.now() - start, success: false });
    return { success: false, message: patient.message };
  }

  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const startDate = toAthenaDate(todayISO);
  const endDate = toAthenaDate(new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const apptRes = await athenaGet(apiBase, practiceId, accessToken, `patients/${patient.patientId}/appointments`, { startdate: startDate, enddate: endDate });
  if (!apptRes.ok) {
    log("athena_tool", { tool: "get_caller_appointments", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: apptRes.status });
    return { success: false, message: "I couldn't retrieve your appointments. Please try again or call the office." };
  }

  const appts = apptRes.data?.appointments ?? apptRes.data ?? [];
  const apptList = Array.isArray(appts) ? appts : [appts];
  const upcoming = apptList.filter((a) => {
    const status = String(a.appointmentstatus ?? a.status ?? "").toLowerCase();
    if (["5", "6", "cancelled", "canceled", "deleted"].includes(status)) return false;
    const d = a.appointmentdate ?? a.date ?? "";
    if (!d) return false;
    return normalizeToISO(d) >= todayISO;
  }).slice(0, 5);

  if (upcoming.length === 0) {
    log("athena_tool", { tool: "get_caller_appointments", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
    return { success: true, message: "You don't have any upcoming appointments on the schedule.", data: { appointments: [] } };
  }

  const parts = upcoming.map((a) => formatAppointmentBrief(a));
  const message = parts.length === 1
    ? `Your next appointment is ${parts[0]}.`
    : `Your upcoming appointments are: ${parts.join("; ")}.`;
  log("athena_tool", { tool: "get_caller_appointments", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
  return { success: true, message, data: { appointments: upcoming.map(normalizeAppointment) } };
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

  const departmentId = args?.department_id ? String(args.department_id) : "";
  if (!departmentId) {
    return { success: false, message: "I need a department to check availability. Please call the office." };
  }

  const params = buildOpenSlotParams(date, departmentId, args?.service_type);

  const res = await athenaGet(apiBase, practiceId, accessToken, "appointments/open", params);
  if (!res.ok) {
    log("athena_tool", { tool: "get_available_slots", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: res.status });
    return { success: false, message: "I couldn't load available times right now. Please try again or call the office." };
  }

  const slots = res.data?.appointments ?? res.data?.slots ?? res.data ?? [];
  const list = Array.isArray(slots) ? slots : [slots];
  const available = list.filter(Boolean).slice(0, 10);

  if (available.length === 0) {
    log("athena_tool", { tool: "get_available_slots", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
    return { success: true, message: `There are no available slots on ${date}. Would you like to try a different date?`, data: { slots: [] } };
  }

  const times = available.map((s) => s.starttime ?? s.time ?? s.slotstart ?? "").filter(Boolean);
  log("athena_tool", { tool: "get_available_slots", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
  return {
    success: true,
    message: `Available times on ${date}: ${times.join(", ")}.`,
    data: { slots: available.map((s) => normalizeSlot(s, date)) },
  };
}

/**
 * Book an appointment.
 */
export async function bookAppointment(apiBase, practiceId, accessToken, args) {
  const start = Date.now();
  const scheduledAt = args?.scheduled_at ? String(args.scheduled_at).trim() : "";
  const serviceType = args?.service_type ? String(args.service_type).trim() : "";
  const name = String(args?.caller_name || "").trim();
  const dob = args?.caller_dob ? String(args.caller_dob).trim() : "";
  const phone = String(args?.caller_phone || "").trim();
  const notes = args?.notes ? String(args.notes).trim() : "";

  if (!scheduledAt || !name || !dob) {
    return { success: false, message: "I need your full name, date of birth, and the date and time you'd like to book." };
  }

  const patient = await resolvePatient(apiBase, practiceId, accessToken, { name, dob, phone });
  if (!patient.patientId) {
    log("athena_tool", { tool: "book_appointment_in_ehr", practice_id: practiceId, duration_ms: Date.now() - start, success: false });
    return { success: false, message: patient.message };
  }

  const departmentId = args?.department_id ? String(args.department_id) : "";
  if (!departmentId) {
    return { success: false, message: "I'm missing the department information needed to book. Please call the office." };
  }

  const bookDateISO = scheduledAt.slice(0, 10);
  const athenaBookDate = toAthenaDate(bookDateISO);
  const slotParams = { startdate: athenaBookDate, enddate: athenaBookDate, departmentid: departmentId };

  const slotRes = await athenaGet(apiBase, practiceId, accessToken, "appointments/open", slotParams);
  if (!slotRes.ok) {
    log("athena_tool", { tool: "book_appointment_in_ehr", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: slotRes.status });
    return { success: false, message: "I couldn't check availability. Please try again or call the office." };
  }

  const slots = slotRes.data?.appointments ?? slotRes.data?.slots ?? slotRes.data ?? [];
  const slotList = Array.isArray(slots) ? slots : [slots];

  // Try to match the requested time; fall back to first available slot
  const requestedTime = scheduledAt.length > 10 ? scheduledAt.slice(11, 16) : "";
  const targetSlot = requestedTime
    ? slotList.find((s) => {
        const t = String(s.starttime ?? s.time ?? s.slotstart ?? "");
        return t.includes(requestedTime);
      }) || slotList[0]
    : slotList[0];

  const appointmentId = targetSlot?.appointmentid ?? targetSlot?.id ?? null;
  if (!appointmentId) {
    return { success: false, message: "That time isn't available. Would you like to choose a different time?" };
  }

  const slotTypeId = targetSlot.appointmenttypeid ?? "";
  const bookBody = {
    patientid: patient.patientId,
    departmentid: departmentId,
    appointmenttypeid: serviceType || slotTypeId,
  };
  if (notes) bookBody.bookingnote = notes;

  const bookRes = await athenaPut(apiBase, practiceId, accessToken, `appointments/${appointmentId}`, bookBody);
  if (!bookRes.ok) {
    log("athena_tool", { tool: "book_appointment_in_ehr", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: bookRes.status });
    return { success: false, message: "Booking didn't go through. Please try again or call the office." };
  }

  const bookedDate = targetSlot.date ?? targetSlot.appointmentdate ?? scheduledAt.slice(0, 10);
  const bookedTime = targetSlot.starttime ?? targetSlot.time ?? requestedTime;
  const friendlyDate = formatFriendlyDateTime(bookedDate, bookedTime);
  log("athena_tool", { tool: "book_appointment_in_ehr", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
  return {
    success: true,
    message: `You're all set! Your appointment is confirmed for ${friendlyDate}.`,
    data: { bookedAppointment: normalizeAppointment({ ...targetSlot, appointmentstatus: "booked" }) },
  };
}

/**
 * Cancel an existing appointment.
 */
export async function cancelAppointment(apiBase, practiceId, accessToken, args) {
  const start = Date.now();
  const name = String(args?.caller_name || "").trim();
  const dob = args?.caller_dob ? String(args.caller_dob).trim() : "";
  const phone = args?.caller_phone ? String(args.caller_phone).trim() : "";
  const appointmentDate = args?.appointment_date ? String(args.appointment_date).trim() : "";
  const appointmentTime = args?.appointment_time ? String(args.appointment_time).trim() : "";
  const cancelReason = args?.reason ? String(args.reason).trim() : "";

  if (!name || !dob) {
    return { success: false, message: "I need your full name and date of birth to find your appointment." };
  }

  const patient = await resolvePatient(apiBase, practiceId, accessToken, { name, dob, phone });
  if (!patient.patientId) {
    log("athena_tool", { tool: "cancel_appointment", practice_id: practiceId, duration_ms: Date.now() - start, success: false });
    return { success: false, message: patient.message };
  }

  const found = await findPatientAppointment(apiBase, practiceId, accessToken, patient.patientId, {
    appointmentDate,
    appointmentTime,
  });
  if (!found.appointment) {
    log("athena_tool", { tool: "cancel_appointment", practice_id: practiceId, duration_ms: Date.now() - start, success: false });
    return { success: false, message: found.message };
  }

  const apptId = found.appointment.appointmentid ?? found.appointment.id;
  const apptDeptId = found.appointment.departmentid ?? args?.department_id ?? "";
  const cancelBody = { patientid: patient.patientId };
  if (apptDeptId) cancelBody.departmentid = String(apptDeptId);
  if (cancelReason) cancelBody.cancellationreason = cancelReason;

  const cancelRes = await athenaPut(apiBase, practiceId, accessToken, `appointments/${apptId}/cancel`, cancelBody);
  if (!cancelRes.ok) {
    log("athena_tool", { tool: "cancel_appointment", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: cancelRes.status });
    let message = "I wasn't able to cancel that appointment. Please try again or call the office.";
    if (cancelRes.status === 404) {
      message = "I couldn't find that appointment in the schedule. It may have already been cancelled.";
    }
    return { success: false, message };
  }

  const brief = formatAppointmentBrief(found.appointment);
  log("athena_tool", { tool: "cancel_appointment", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
  return {
    success: true,
    message: `Your appointment on ${brief} has been cancelled.`,
    data: { cancelledAppointmentId: String(apptId) },
  };
}

/**
 * Reschedule an existing appointment: book a new slot, then cancel the old one.
 */
export async function rescheduleAppointment(apiBase, practiceId, accessToken, args) {
  const start = Date.now();
  const name = String(args?.caller_name || "").trim();
  const dob = args?.caller_dob ? String(args.caller_dob).trim() : "";
  const phone = args?.caller_phone ? String(args.caller_phone).trim() : "";
  const currentDate = args?.current_appointment_date ? String(args.current_appointment_date).trim() : "";
  const currentTime = args?.current_appointment_time ? String(args.current_appointment_time).trim() : "";
  const newDate = args?.new_date ? String(args.new_date).trim() : "";
  const newTime = args?.new_time ? String(args.new_time).trim() : "";
  const serviceType = args?.service_type ? String(args.service_type).trim() : "";

  if (!name || !dob) {
    return { success: false, message: "I need your full name and date of birth to reschedule." };
  }
  if (!newDate) {
    return { success: false, message: "What date would you like to move your appointment to?" };
  }

  // 1. Resolve patient
  const patient = await resolvePatient(apiBase, practiceId, accessToken, { name, dob, phone });
  if (!patient.patientId) {
    log("athena_tool", { tool: "reschedule_appointment", practice_id: practiceId, duration_ms: Date.now() - start, success: false });
    return { success: false, message: patient.message };
  }

  // 2. Find the existing appointment
  const found = await findPatientAppointment(apiBase, practiceId, accessToken, patient.patientId, {
    appointmentDate: currentDate,
    appointmentTime: currentTime,
  });
  if (!found.appointment) {
    log("athena_tool", { tool: "reschedule_appointment", practice_id: practiceId, duration_ms: Date.now() - start, success: false });
    return { success: false, message: found.message };
  }

  const oldApptId = found.appointment.appointmentid ?? found.appointment.id;

  // Derive context from the existing appointment so we can prefer matching
  // department, provider, and appointment type when searching for new slots.
  const existingDeptIdRaw = found.appointment.departmentid ?? found.appointment.department_id ?? "";
  const existingDeptId = existingDeptIdRaw ? String(existingDeptIdRaw) : "";
  const existingProviderIdRaw = found.appointment.providerid ?? found.appointment.provider_id ?? null;
  const existingProviderId = existingProviderIdRaw != null ? String(existingProviderIdRaw) : null;
  const existingApptTypeIdRaw =
    found.appointment.appointmenttypeid ??
    found.appointment.appointment_type_id ??
    null;
  const existingApptTypeId = existingApptTypeIdRaw != null ? String(existingApptTypeIdRaw) : null;

  const departmentId = args?.department_id ? String(args.department_id) : existingDeptId || "";
  if (!departmentId) {
    return { success: false, message: "I'm missing the department information needed to reschedule. Please call the office." };
  }

  // 3. Find an open slot on the requested date
  // Prefer the existing appointment's type when searching for slots; fall back
  // to serviceType or config-driven defaults only when necessary.
  const typeForSlots = existingApptTypeId || serviceType || undefined;
  const slotParams = buildOpenSlotParams(newDate, departmentId, typeForSlots, {
    providerId: existingProviderId || undefined,
  });
  const slotRes = await athenaGet(apiBase, practiceId, accessToken, "appointments/open", slotParams);
  if (!slotRes.ok) {
    log("athena_tool", { tool: "reschedule_appointment", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: slotRes.status });
    return { success: false, message: "I couldn't check availability for the new date. Please try again or call the office." };
  }

  const slots = slotRes.data?.appointments ?? slotRes.data?.slots ?? slotRes.data ?? [];
  const slotList = Array.isArray(slots) ? slots : [slots];

  // Light safety net: prefer slots that match the existing appointment's
  // type and provider, falling back to department-only if needed.
  let filteredSlots = slotList.filter(Boolean);

  if (existingApptTypeId) {
    const typeStr = String(existingApptTypeId);
    const byType = filteredSlots.filter((s) => {
      const raw =
        s.appointmenttypeid ??
        s.appointment_type_id ??
        s.appointmentTypeId ??
        null;
      return raw != null && String(raw) === typeStr;
    });
    if (byType.length > 0) {
      filteredSlots = byType;
    }
  }

  if (existingProviderId) {
    const providerStr = String(existingProviderId);
    const byProvider = filteredSlots.filter((s) => {
      const raw =
        s.providerid ??
        s.provider_id ??
        s.providerId ??
        null;
      return raw != null && String(raw) === providerStr;
    });
    if (byProvider.length > 0) {
      filteredSlots = byProvider;
    }
  }

  if (filteredSlots.length === 0) {
    filteredSlots = slotList.filter(Boolean);
  }

  const searchPool = filteredSlots;
  const targetSlot = newTime
    ? searchPool.find((s) => {
        const t = String(s.starttime ?? s.time ?? s.slotstart ?? "");
        return t.includes(newTime);
      }) || searchPool[0]
    : searchPool[0];

  const newApptId = targetSlot?.appointmentid ?? targetSlot?.id ?? null;
  if (!newApptId) {
    return { success: false, message: `There are no available slots on ${newDate}. Would you like to try a different date?` };
  }

  // 4. Use the dedicated reschedule endpoint (atomic — books new slot and cancels old in one call)
  const rescheduleBody = {
    newappointmentid: newApptId,
    patientid: patient.patientId,
    departmentid: departmentId,
  };
  // Determine appointment type and provider for the reschedule, preferring
  // slot → existing appointment → config/serviceType, so we never send a
  // combination Athena wouldn't have shown in /appointments/open.
  const slotTypeRaw =
    targetSlot?.appointmenttypeid ??
    targetSlot?.appointment_type_id ??
    targetSlot?.appointmentTypeId ??
    null;
  const slotTypeId = slotTypeRaw != null ? String(slotTypeRaw) : null;
  const normalizedExistingTypeId = existingApptTypeId;

  let rescheduleTypeId = slotTypeId || normalizedExistingTypeId || null;
  if (!rescheduleTypeId && serviceType) {
    if (!normalizedExistingTypeId || String(serviceType) === String(normalizedExistingTypeId)) {
      rescheduleTypeId = String(serviceType);
    }
  }
  if (rescheduleTypeId) {
    rescheduleBody.appointmenttypeid = rescheduleTypeId;
  }

  const slotProviderRaw =
    targetSlot?.providerid ??
    targetSlot?.provider_id ??
    targetSlot?.providerId ??
    null;
  const slotProviderId = slotProviderRaw != null ? String(slotProviderRaw) : null;
  const rescheduleProviderId = slotProviderId || existingProviderId || null;
  if (rescheduleProviderId) {
    rescheduleBody.providerid = rescheduleProviderId;
  }

  // Keep schedule rule overrides aligned with how /appointments/open is queried
  // and what staff can do in the Athena UI.
  rescheduleBody.ignoreschedulablepermission = "true";
  rescheduleBody.bypassscheduletimechecks = "true";

  const rescheduleRes = await athenaPut(
    apiBase,
    practiceId,
    accessToken,
    `appointments/${oldApptId}/reschedule`,
    rescheduleBody
  );

  if (!rescheduleRes.ok) {
    log("athena_tool", { tool: "reschedule_appointment", practice_id: practiceId, duration_ms: Date.now() - start, success: false, status: rescheduleRes.status });
    let message = "I wasn't able to reschedule the appointment. Please try again or call the office.";
    if (rescheduleRes.status === 400) {
      message = "The scheduling system rejected that change. Please call the office so they can help reschedule.";
    } else if (rescheduleRes.status === 404) {
      message = "I couldn't find that appointment in the schedule. It may have already been changed or cancelled.";
    } else if (rescheduleRes.status === 409) {
      message = "That time slot is no longer available. Would you like me to look for other openings?";
    }
    return { success: false, message };
  }

  const newBrief = formatAppointmentBrief(targetSlot);
  log("athena_tool", { tool: "reschedule_appointment", practice_id: practiceId, duration_ms: Date.now() - start, success: true });
  return {
    success: true,
    message: `Done! Your appointment has been rescheduled to ${newBrief}.`,
    data: {
      bookedAppointment: normalizeAppointment({ ...targetSlot, appointmentstatus: "f" }),
      cancelledAppointmentId: String(oldApptId),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a date + time into a human-friendly string for reading aloud.
 */
function formatFriendlyDateTime(date, time) {
  try {
    const isoDate = normalizeToISO(date);
    const iso = time ? `${isoDate}T${time}` : isoDate;
    return new Date(iso).toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return [date, time].filter(Boolean).join(" at ");
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

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
  // Inject department_id from integration config so slot searches include it
  const args = { ...payload?.arguments, department_id: config.department_id || "" };

  switch (tool) {
    case "get_caller_appointments": {
      const result = await getCallerAppointments(api_base, practiceId, access_token, args);
      return { success: result.success, message: result.message, data: result.data };
    }
    case "get_available_slots": {
      const result = await getAvailableSlots(api_base, practiceId, access_token, args);
      return { success: result.success, message: result.message, data: result.data };
    }
    case "book_appointment_in_ehr": {
      const result = await bookAppointment(api_base, practiceId, access_token, args);
      return { success: result.success, message: result.message, data: result.data };
    }
    case "cancel_appointment": {
      const result = await cancelAppointment(api_base, practiceId, access_token, args);
      return { success: result.success, message: result.message, data: result.data };
    }
    case "reschedule_appointment": {
      const result = await rescheduleAppointment(api_base, practiceId, access_token, args);
      return { success: result.success, message: result.message, data: result.data };
    }
    default:
      return { success: false, error: `Unknown athena tool: ${tool}`, message: "That action isn't available right now." };
  }
}
