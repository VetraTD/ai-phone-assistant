import axios from "axios";
import { supabase } from "./supabaseClient";

export const numberApi = axios.create({
  baseURL: "https://ai-phone-assistant-production-3e90.up.railway.app",
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