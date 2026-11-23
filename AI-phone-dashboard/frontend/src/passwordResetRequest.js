// ---------------------------------------------------------------------------
// "Forgot password?" — asks OUR API to email the reset link.
//
// The API mints the one-shot code with Identity Platform and sends the email
// from notifications@vetratd.com (AI-phone-dashboard/backend/src/routes/
// passwordReset.js). It used to be Identity Platform's own email, from
// noreply@vetra-core-edc8ca.firebaseapp.com.
//
// The server answers the same for every address, so this can only report what
// the person typed (400), the rate limit (429), or that the service is down.
// It never learns, and so can never show or log, whether an account exists.
// ---------------------------------------------------------------------------

const DEFAULT_API = import.meta.env.VITE_API_URL || "http://localhost:3001";

const TRY_AGAIN = "We couldn't send a reset link right now. Please try again in a few minutes.";

/**
 * @param {string} email
 * @param {{ apiBase?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ error?: string }>}
 */
export async function requestPasswordReset(email, { apiBase = DEFAULT_API, fetchImpl = (...a) => fetch(...a) } = {}) {
  let response;
  try {
    response = await fetchImpl(`${apiBase}/api/auth/password-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // No cookies and no token: the person is signed out, and the endpoint
      // must not behave differently for someone who happens to be signed in.
      credentials: "omit",
      body: JSON.stringify({ email }),
    });
  } catch {
    return { error: TRY_AGAIN };
  }

  if (response.ok) return {};
  if (response.status === 429) {
    return { error: "Too many attempts. Please wait a few minutes and try again." };
  }
  if (response.status === 400) {
    const body = await response.json().catch(() => ({}));
    return { error: typeof body?.error === "string" && body.error ? body.error : "Please enter a valid email address." };
  }
  return { error: TRY_AGAIN };
}
