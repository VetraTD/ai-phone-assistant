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

export function evaluateGate(f, { rand = Math.random } = {}) {
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
