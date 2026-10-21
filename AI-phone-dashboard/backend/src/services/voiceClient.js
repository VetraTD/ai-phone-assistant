// Client for the voice server's internal endpoints.
//
// The voice server only accepts a Google-signed OIDC ID token whose audience
// is its own base URL, so each call first asks the GCP metadata server for
// one (this runs on Cloud Run; there is no metadata server on a laptop, which
// surfaces as a 502 here -- the preview simply isn't available locally).

const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/**
 * Ask the voice server for the business's recorded greeting.
 * Never throws: every failure is a status.
 *
 * @param {string} businessId
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{status: number, audio: Buffer|null}>}
 *   503 = VOICE_INTERNAL_URL not set, 502 = network/metadata failure, otherwise
 *   the voice server's own status (audio only on 200).
 */
async function postGreetingClip(businessId, { timeoutMs = 15000 } = {}) {
  const base = (process.env.VOICE_INTERNAL_URL || "").trim().replace(/\/+$/, "");
  if (!base) return { status: 503, audio: null };

  try {
    const tokenRes = await fetch(`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(base)}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!tokenRes.ok) return { status: 502, audio: null };
    const token = (await tokenRes.text()).trim();

    const res = await fetch(`${base}/internal/greeting-clip`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ business_id: businessId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 200) return { status: res.status, audio: null };
    return { status: 200, audio: Buffer.from(await res.arrayBuffer()) };
  } catch {
    return { status: 502, audio: null };
  }
}

module.exports = { postGreetingClip };
