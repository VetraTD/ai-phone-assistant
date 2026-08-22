import axios from "axios";
import { supabase } from "./supabaseClient";
import { attachAuthRetry } from "./authRetry";

const NUMBER_API_BASE =
  import.meta.env.VITE_NUMBER_API_URL ||
  "https://ai-phone-assistant-production-3e90.up.railway.app";

export const numberApi = axios.create({
  baseURL: NUMBER_API_BASE,
});

numberApi.interceptors.request.use(async (config) => {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`;
  }

  return config;
});

// Refresh once and retry when a server reports the token is past the
// session-age ceiling. See src/authRetry.js.
attachAuthRetry(numberApi);
