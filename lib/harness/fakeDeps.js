/**
 * In-memory fakes for the two dependency surfaces a call turn reaches, so the
 * text-session harness (lib/harness/textSession.js) and the eval suite can drive
 * the REAL brain — prompt assembly, tool dispatch, the reply-state reducer, the
 * capability packs — without Supabase, notifications, or any network.
 *
 * There are two surfaces because production splits them:
 *
 *   - CAPABILITY_DEPS (services/tools.js) — the data surface a pack's `execute`
 *     reads through `ctx.deps`, injectable via `extras.capabilityDeps`
 *     (→ ctx.depsOverride). `makeFakeDeps` mirrors it: appointment reads/writes
 *     plus executeIntegration and captureException.
 *
 *   - the effect-dispatch deps (lib/voice/session.js hands `{ notifications, db,
 *     log, captureException }` to dispatchCapabilityEffects) — the surface a
 *     pack's `onEffect` reaches AFTER the turn. `makeFakeEffectsDeps` mirrors it:
 *     notifications and db calls are recorded, never sent.
 *
 * Both record every call so an eval can assert "booked once, notified once".
 * Shapes mirror the real implementations in services/supabase.js,
 * services/integrations.js and services/notifications.js — verified against them
 * — because the packs branch on those return contracts (e.g. a booking checks
 * `res.full` vs `res.id`).
 */

let idSeq = 0;
function nextId(prefix) {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

/** Digits-only, last 10, mirroring supabase.js's phone match. */
function phoneKey(v) {
  return typeof v === "string" ? v.replace(/\D/g, "").trim().slice(-10) : "";
}

/**
 * Equal-length slots overlap iff their starts are strictly less than the slot
 * length apart (services/supabase.js countScheduledOverlapping / the internal
 * adapter both use the exclusive window). A non-positive length means the
 * "exact timestamp" single-booking guard (availability-off booking), so overlap
 * collapses to an identical start instant.
 */
function overlaps(aMs, bMs, lengthMinutes) {
  if (!(lengthMinutes > 0)) return aMs === bMs;
  return Math.abs(aMs - bMs) < lengthMinutes * 60_000;
}

/** Normalize a seed row into the column shape the real `appointments` table returns. */
function normalizeSeed(row) {
  return {
    id: row.id || nextId("appt"),
    business_id: row.business_id ?? row.businessId ?? null,
    call_id: row.call_id ?? row.callId ?? null,
    service_id: row.service_id ?? row.serviceId ?? null,
    client_name: row.client_name ?? row.clientName ?? null,
    client_phone: row.client_phone ?? row.clientPhone ?? null,
    scheduled_at: row.scheduled_at ?? row.scheduledAt ?? null,
    status: row.status ?? "scheduled",
    notes: row.notes ?? null,
  };
}

/** The public shape every appointment read returns (real select column list). */
function publicRow(r) {
  return {
    id: r.id,
    client_name: r.client_name,
    client_phone: r.client_phone,
    scheduled_at: r.scheduled_at,
    status: r.status,
    notes: r.notes,
  };
}

/**
 * Fake of the CAPABILITY_DEPS surface (services/tools.js:48-79).
 *
 * @param {object} [opts]
 * @param {Array} [opts.seedAppointments] - rows to pre-load (snake or camel keys accepted)
 * @param {number} [opts.slotCapacity=1] - default capacity when a booking call omits one
 * @param {number|Date} [opts.now] - reference instant, exposed on the store for eval use
 * @param {object|(integration, payload)=>object} [opts.integrationResponse] - canned
 *   executeIntegration result (or a function of the call); default success/empty
 * @returns {{ deps: object, store: object }}
 */
export function makeFakeDeps({
  seedAppointments = [],
  slotCapacity = 1,
  now,
  integrationResponse,
} = {}) {
  const appointments = seedAppointments.map(normalizeSeed);
  const calls = [];
  const store = {
    appointments,
    calls,
    now: now == null ? null : now instanceof Date ? now.getTime() : now,
    /** Convenience: only rows still scheduled. */
    scheduled() {
      return appointments.filter((r) => r.status === "scheduled");
    },
  };

  const record = (name, args) => calls.push({ name, args });

  const deps = {
    async createAppointment({ businessId, callId, serviceId, clientName, clientPhone, scheduledAt, notes }) {
      record("createAppointment", { businessId, callId, serviceId, clientName, clientPhone, scheduledAt, notes });
      const row = normalizeSeed({
        business_id: businessId,
        call_id: callId,
        service_id: serviceId,
        client_name: clientName,
        client_phone: clientPhone,
        scheduled_at: scheduledAt,
        notes,
        status: "scheduled",
      });
      appointments.push(row);
      return row.id;
    },

    async createAppointmentIfAvailable(params) {
      record("createAppointmentIfAvailable", params);
      const { businessId, callId, clientName, clientPhone, scheduledAt, notes, lengthMinutes, capacity } = params;
      const cap = Number.isFinite(capacity) ? capacity : slotCapacity;
      const startMs = Date.parse(scheduledAt);
      const taken = appointments.filter(
        (r) =>
          r.business_id === businessId &&
          r.status === "scheduled" &&
          overlaps(Date.parse(r.scheduled_at), startMs, lengthMinutes)
      ).length;
      if (taken >= cap) return { full: true };
      const row = normalizeSeed({
        business_id: businessId,
        call_id: callId,
        client_name: clientName,
        client_phone: clientPhone,
        scheduled_at: scheduledAt,
        notes,
        status: "scheduled",
      });
      appointments.push(row);
      return { id: row.id };
    },

    async countScheduledOverlapping(businessId, startISO, lengthMinutes) {
      record("countScheduledOverlapping", { businessId, startISO, lengthMinutes });
      if (!businessId) return 0;
      const startMs = Date.parse(startISO);
      if (!Number.isFinite(startMs)) return 0;
      const L = Number.isFinite(lengthMinutes) ? lengthMinutes : 30;
      return appointments.filter(
        (r) =>
          r.business_id === businessId &&
          r.status === "scheduled" &&
          overlaps(Date.parse(r.scheduled_at), startMs, L)
      ).length;
    },

    async listScheduledBetween(businessId, startISO, endISO) {
      record("listScheduledBetween", { businessId, startISO, endISO });
      if (!businessId) return [];
      const lo = Date.parse(startISO);
      const hi = Date.parse(endISO);
      return appointments
        .filter((r) => r.business_id === businessId && r.status === "scheduled")
        .filter((r) => {
          const t = Date.parse(r.scheduled_at);
          return t >= lo && t < hi;
        })
        .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
        .map((r) => ({ scheduled_at: r.scheduled_at }));
    },

    async listAppointmentsByCaller(businessId, opts = {}) {
      record("listAppointmentsByCaller", { businessId, opts });
      if (!businessId) return [];
      const name = typeof opts.clientName === "string" ? opts.clientName.trim().toLowerCase() : "";
      const phone = phoneKey(opts.clientPhone);
      return appointments
        .filter((r) => r.business_id === businessId && r.status === "scheduled")
        .filter((r) => (name ? (r.client_name || "").toLowerCase().includes(name) : true))
        .filter((r) => (phone ? phoneKey(r.client_phone) === phone : true))
        .sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at))
        .map(publicRow);
    },

    async getAppointmentById(appointmentId, businessId) {
      record("getAppointmentById", { appointmentId, businessId });
      if (!appointmentId || !businessId) return null;
      const r = appointments.find((a) => a.id === appointmentId && a.business_id === businessId);
      return r ? publicRow(r) : null;
    },

    async updateAppointmentStatus(appointmentId, status, businessId) {
      record("updateAppointmentStatus", { appointmentId, status, businessId });
      if (!appointmentId || !businessId) return false;
      const r = appointments.find((a) => a.id === appointmentId && a.business_id === businessId);
      if (!r) return false;
      r.status = status;
      return true;
    },

    async updateAppointment(appointmentId, updates, businessId) {
      record("updateAppointment", { appointmentId, updates, businessId });
      if (!appointmentId || !businessId || !updates || typeof updates !== "object") return false;
      const r = appointments.find((a) => a.id === appointmentId && a.business_id === businessId);
      if (!r) return false;
      Object.assign(r, updates);
      return true;
    },

    async executeIntegration(integration, payload) {
      record("executeIntegration", { integration, payload });
      if (typeof integrationResponse === "function") return integrationResponse(integration, payload);
      if (integrationResponse) return integrationResponse;
      return { success: true, message: "", data: {} };
    },

    captureException(err, ctx) {
      record("captureException", { message: err?.message ?? String(err), ctx });
    },
  };

  return { deps, store };
}

/**
 * Fake of the effect-dispatch deps (`{ notifications, db, log, captureException }`)
 * lib/voice/session.js:1480 hands to dispatchCapabilityEffects. Notifications and
 * db writes are recorded instead of performed; db.createCustomerRequest returns a
 * synthetic id so the pack's post-write notification branch runs.
 *
 * @returns {{ deps: object, captured: object }}
 */
export function makeFakeEffectsDeps() {
  const captured = {
    notifications: [],
    db: [],
    logs: [],
    exceptions: [],
  };
  const recordNotify = (name, args) => captured.notifications.push({ name, args });

  const notifications = {
    // Mirrors services/notifications.js — the SLA phrase packs inline into SMS.
    MESSAGE_SLA_TEXT: "as soon as possible",
    async notifyAppointmentBooked(args) {
      recordNotify("notifyAppointmentBooked", args);
    },
    async notifyCustomerRequest(args) {
      recordNotify("notifyCustomerRequest", args);
    },
    async sendCallerSms(config, callerNumber, template, data) {
      recordNotify("sendCallerSms", { businessName: config?.businessName ?? null, callerNumber, template, data });
    },
  };

  const db = {
    async createCustomerRequest(args) {
      const id = nextId("req");
      captured.db.push({ name: "createCustomerRequest", args, id });
      return id;
    },
  };

  const log = {
    error(event, meta) {
      captured.logs.push({ level: "error", event, meta });
    },
    info(event, meta) {
      captured.logs.push({ level: "info", event, meta });
    },
    debug(event, meta) {
      captured.logs.push({ level: "debug", event, meta });
    },
    warn(event, meta) {
      captured.logs.push({ level: "warn", event, meta });
    },
  };

  const captureException = (err, ctx) => {
    captured.exceptions.push({ message: err?.message ?? String(err), ctx });
  };

  return { deps: { notifications, db, log, captureException }, captured };
}
