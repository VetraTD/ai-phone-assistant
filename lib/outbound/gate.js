/**
 * The eligibility gate, spec §10.3. Pure: every input is a fact the
 * dispatcher gathered inside the tenant transaction. Evaluated in the spec's
 * order; the FIRST failure decides. This is enforcement in CODE -- the prompt
 * never decides whether a call may happen.
 */
import { consentSatisfies } from "./consent.js";
import { isInsideWindow, nextWindowOpening, applyWindow } from "./schedule.js";
import { PURPOSE_BY_TEMPLATE } from "./templates.js";

const DAY = 86_400_000;
const never = (reason) => ({ verdict: "never", reason });
const later = (reason, at) => ({ verdict: "later", reason, at });

/**
 * Fail CLOSED on a wiring bug, by THROWING rather than returning a verdict.
 * Task 9 builds `facts` from DB helpers; a wrong alias or an unguarded `?.`
 * there must not silently switch off a check (do-not-call, the daily cap,
 * capacity, ...) by handing it `undefined`. A thrown TypeError makes dispatch
 * return 500 -- no dial, and no permanent "never" close of the outreach row
 * either, which a fail-open verdict could cause. `Number.isFinite` (not the
 * coercing global `isFinite`) is what rejects a numeric STRING here: Task 9's
 * DB helpers must cast (`::int`), and a string reaching this gate means a
 * missing cast.
 */
function assertGateFacts(f) {
  const fail = (name, msg) => { throw new TypeError(`gate fact ${name}: ${msg}`); };
  const isDate = (d) => d instanceof Date && !Number.isNaN(d.getTime());
  const parses = (v) => !Number.isNaN(new Date(v).getTime());

  if (!isDate(f.now)) fail("now", "must be a valid Date");
  if (typeof f.env?.enabled !== "boolean") fail("env.enabled", "must be a boolean");
  if (!(f.env?.allowlist instanceof Set)) fail("env.allowlist", "must be a Set");
  if (!Number.isFinite(f.env?.maxConcurrent)) fail("env.maxConcurrent", "must be a finite number");
  if (!Number.isFinite(f.env?.inboundReserve)) fail("env.inboundReserve", "must be a finite number");
  if (typeof f.business?.outbound_enabled !== "boolean") fail("business.outbound_enabled", "must be a boolean");
  if (!Number.isFinite(f.business?.outbound_max_concurrent)) fail("business.outbound_max_concurrent", "must be a finite number");
  const cfg = f.campaign?.config;
  if (typeof cfg !== "object" || cfg === null) fail("campaign.config", "must be an object");
  if (!Array.isArray(cfg?.retries?.schedule)) fail("campaign.config.retries.schedule", "must be an array");
  if (typeof cfg?.calling_window !== "object" || cfg.calling_window === null) fail("campaign.config.calling_window", "must be an object");
  if (typeof f.contact?.phone_e164 !== "string" || f.contact.phone_e164 === "") fail("contact.phone_e164", "must be a non-empty string");
  if (typeof f.contact?.timezone !== "string" || f.contact.timezone === "") fail("contact.timezone", "must be a non-empty string");
  if (!Number.isFinite(f.outreach?.attempts_made)) fail("outreach.attempts_made", "must be a finite number");
  if (!parses(f.outreach?.created_at)) fail("outreach.created_at", "must parse to a valid date");
  if (f.outreach?.hold_until != null && !parses(f.outreach.hold_until)) fail("outreach.hold_until", "must be null or parse to a valid date");
  if (typeof f.suppressed !== "boolean") fail("suppressed", "must be a boolean");
  if (typeof f.hasRelationship !== "boolean") fail("hasRelationship", "must be a boolean");
  if (typeof f.callerIdValid !== "boolean") fail("callerIdValid", "must be a boolean");
  if (!Array.isArray(f.consents)) fail("consents", "must be an array");
  if (!Number.isFinite(f.dialsToday)) fail("dialsToday", "must be a finite number");
  if (!Number.isFinite(f.active?.globalOutbound)) fail("active.globalOutbound", "must be a finite number");
  if (!Number.isFinite(f.active?.businessOutbound)) fail("active.businessOutbound", "must be a finite number");
}

export function evaluateGate(f, { rand = Math.random } = {}) {
  assertGateFacts(f);
  const cfg = f.campaign.config;
  const tz = f.contact.timezone;
  // 1. kill switch, or the test allow-list
  if (!f.env.enabled && !f.env.allowlist.has(f.contact.phone_e164)) return never("global_disabled");
  // 2. per-business switch
  if (!f.business.outbound_enabled) return never("business_disabled");
  // 3. campaign active (paused holds, never closes)
  if (f.campaign.status !== "active") return later("campaign_paused", null);
  // 4. do-not-call
  if (f.suppressed) return never("suppressed");
  // 5. consent for the compliance class
  const consent = consentSatisfies({
    complianceClass: f.campaign.compliance_class,
    purpose: PURPOSE_BY_TEMPLATE[f.campaign.template_key],
    consents: f.consents,
    consentWindowDays: cfg.consent_window_days ?? 30,
    hasRelationship: f.hasRelationship,
    now: f.now,
  });
  if (!consent.ok) return never(consent.reason);
  // 6. silent-call hold
  if (f.outreach.hold_until && new Date(f.outreach.hold_until) > f.now) {
    return later("silent_hold", applyWindow(new Date(f.outreach.hold_until), cfg.calling_window, tz, rand));
  }
  // 7. calling window, contact's clock
  if (!isInsideWindow(f.now, cfg.calling_window, tz)) {
    return later("outside_window", applyWindow(f.now, cfg.calling_window, tz, rand));
  }
  // 8. attempt budget and give-up window
  if (f.outreach.attempts_made >= cfg.retries.schedule.length) return never("attempts_exhausted");
  if (f.now.getTime() - new Date(f.outreach.created_at).getTime() > cfg.retries.give_up_after_days * DAY) return never("give_up_window");
  // 9. per-contact daily cap, across campaigns
  if (f.dialsToday >= 3) {
    const tomorrow = nextWindowOpening(new Date(f.now.getTime() + 60_000), cfg.calling_window, tz);
    const opening = tomorrow && isSameLocalDay(tomorrow, f.now, tz)
      ? nextWindowOpening(new Date(tomorrow.getTime() + 60_000), cfg.calling_window, tz)
      : tomorrow;
    return later("daily_contact_cap", opening ? new Date(opening.getTime() + Math.floor(rand() * 600_000)) : null);
  }
  // 10. capacity: global outbound < max - reserve, and business outbound < its cap
  if (f.active.globalOutbound >= f.env.maxConcurrent - f.env.inboundReserve ||
      f.active.businessOutbound >= f.business.outbound_max_concurrent) {
    return later("capacity", new Date(f.now.getTime() + 30_000));
  }
  // 11. the caller ID is still ours
  if (!f.callerIdValid) return never("caller_id_invalid");
  return { verdict: "allow" };
}

function isSameLocalDay(a, b, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(a) === fmt.format(b);
}
