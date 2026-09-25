/**
 * Does this contact's evidence satisfy the campaign's compliance class? Spec
 * §13.1. Pure. The ORDER of reasons is deliberate: "missing" beats "not
 * automated" beats "expired", because the most fundamental gap is the one an
 * operator needs to fix first.
 */
const DAY = 86_400_000;

export function consentSatisfies({ complianceClass, purpose, consents = [], consentWindowDays = 30, hasRelationship = false, now }) {
  if (complianceClass === "service") return hasRelationship ? { ok: true } : { ok: false, reason: "consent_missing" };
  if (complianceClass !== "solicited") return { ok: false, reason: "consent_missing" }; // marketing_consented: Part 3
  const relevant = consents.filter((c) => c.purpose === purpose && (c.channels || []).includes("call") && !c.revoked_at);
  if (!relevant.length) return { ok: false, reason: "consent_missing" };
  const automated = relevant.filter((c) => c.covers_automated === true);
  if (!automated.length) return { ok: false, reason: "consent_not_automated" };
  const windowMs = Math.min(Math.max(consentWindowDays, 1), 90) * DAY;
  const live = automated.filter((c) =>
    now.getTime() - new Date(c.captured_at).getTime() <= windowMs &&
    (!c.expires_at || new Date(c.expires_at).getTime() > now.getTime()));
  return live.length ? { ok: true } : { ok: false, reason: "consent_expired" };
}
