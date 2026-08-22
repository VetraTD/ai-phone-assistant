import axios from "axios";
import { getAccessToken } from "./auth";
import { attachAuthRetry } from "./authRetry";

const NUMBER_API_BASE =
  import.meta.env.VITE_NUMBER_API_URL ||
  "https://ai-phone-assistant-production-3e90.up.railway.app";

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
