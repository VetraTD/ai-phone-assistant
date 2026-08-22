import { getAccessToken, signOut } from "./auth";

// ---------------------------------------------------------------------------
// What makes a short server-side token-age ceiling usable.
//
// Both servers reject an access token older than SESSION_MAX_AGE_MINUTES, which
// bounds how long a LEAKED token keeps working. Without this, that bound would
// also log a working clinic out mid-sentence: Identity Platform refreshes its
// token near expiry rather than when the person acts, so a perfectly valid
// session routinely carries a token well over half an hour old.
//
// So: when a server says the token is too old, mint a fresh one and retry once.
// The person sees nothing. An IDLE browser makes no requests, refreshes
// nothing, and its token ages out — which is the property that makes the
// ceiling worth having rather than an inconvenience.
//
// Exactly once. A refresh that fails means the session is genuinely over, and
// retrying a second time turns an expired login into a request loop against the
// auth backend.
// ---------------------------------------------------------------------------

/** The code both servers send when a token is past the ceiling. */
export const SESSION_MAX_AGE_CODE = "session_max_age";

/**
 * Attach the refresh-and-retry response interceptor to an axios instance.
 * @param {import('axios').AxiosInstance} instance
 */
export function attachAuthRetry(instance) {
  instance.interceptors.response.use(
    (response) => response,
    async (error) => {
      const status = error?.response?.status;
      const code = error?.response?.data?.code;
      const config = error?.config;

      if (status !== 401 || code !== SESSION_MAX_AGE_CODE || !config || config.__authRetried) {
        return Promise.reject(error);
      }

      config.__authRetried = true;

      // forceRefresh, not a plain read: the point is a token with a NEW `iat`,
      // and the cached one is what the server just refused.
      const fresh = await getAccessToken({ forceRefresh: true });
      if (!fresh) {
        // The session really is over. Sign out so the app shows the login
        // screen rather than an endless row of failed requests.
        await signOut();
        return Promise.reject(error);
      }

      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${fresh}`;
      return instance.request(config);
    }
  );
}
