import axios from "axios";
import { getAccessToken } from "./auth";
import { attachAuthRetry } from "./authRetry";

// NO REMOTE FALLBACK, and that is the point.
//
// This defaulted to `https://ai-phone-assistant-production-3e90.up.railway.app`
// — a Railway service that no longer exists; the host now answers
// "Application not found". A dead default would be merely broken, except for
// what the interceptor below does: it attaches a live Identity Platform bearer
// token to every request. So the default was "send a valid dashboard token to a
// RELEASED third-party subdomain".
//
// That is the same hazard the migration ledger recorded at A9 when it removed
// the Vercel preview domain from the CORS allow-list: a released subdomain can
// be claimed by somebody else, and a stranger who claims it collects
// authenticated requests from our own bundle.
//
// Empty means axios uses a RELATIVE base, so an unset variable produces a 404
// on our own origin — loud, local, and harmless. The number-purchase endpoints
// live on the VOICE service (root server.js), not the dashboard API, so this
// cannot simply default to VITE_API_URL either. Set VITE_NUMBER_API_URL when
// the onboarding flow is reopened.
const NUMBER_API_BASE = import.meta.env.VITE_NUMBER_API_URL || "";

export const numberApi = axios.create({
  baseURL: NUMBER_API_BASE,
});

numberApi.interceptors.request.use(async (config) => {
  const token = await getAccessToken();

  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

// Refresh once and retry when a server reports the token is past the
// session-age ceiling. See src/authRetry.js.
attachAuthRetry(numberApi);
