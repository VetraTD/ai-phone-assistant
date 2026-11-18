import axios from "axios";
import { getAccessToken } from "./auth";
import { attachAuthRetry } from "./authRetry";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

export const api = axios.create({
  baseURL: API,
});

api.interceptors.request.use(async (config) => {
  const token = await getAccessToken();

  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

// Refresh once and retry when a server reports the token is past the
// session-age ceiling. See src/authRetry.js.
attachAuthRetry(api);
