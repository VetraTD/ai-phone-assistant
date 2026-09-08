import { useEffect } from "react";
import { MARKETING_URL } from "../siteUrl";
import { isAppBuild } from "./siteLinks.js";

function upsertMeta(name, content) {
  let el = document.head.querySelector(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertCanonical(href) {
  let el = document.head.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

/**
 * Per-page <title>, description and canonical URL. index.html is shared by
 * both builds, so the static tags there stay neutral and each page sets its
 * own here. The canonical is only written on the marketing build; the app
 * origin should never claim to be the canonical home of a public page.
 */
export function usePageMeta({ title, description, path }) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = title ? `${title} — Vetra` : "Vetra";
    if (description) upsertMeta("description", description);
    if (!isAppBuild && path) {
      const base = MARKETING_URL.replace(/\/$/, "");
      upsertCanonical(`${base}${path === "/" ? "/" : path}`);
    }
  }, [title, description, path]);
}
