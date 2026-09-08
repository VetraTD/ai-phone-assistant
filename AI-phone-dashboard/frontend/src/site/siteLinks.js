import { APP_URL, BUILD_TARGET, MARKETING_URL } from "../siteUrl";

// One codebase, two sites. On the marketing build every public page is a
// local route. On the app build only Contact, Privacy and Terms are served
// locally (footers link to them); Home, Features and About live on the
// marketing origin, so links to them must leave this origin.
//
// Pure helpers only; the <SiteLink> component lives in components/SiteLink.jsx.

export const isAppBuild = BUILD_TARGET === "app";

export const appLoginHref = `${APP_URL}/login`;

const LOCAL_ON_APP = new Set(["/contact", "/privacy", "/terms"]);

/** Whether `path` is served by this build (so it can be a router <Link>). */
export function isLocalPath(path) {
  return !isAppBuild || LOCAL_ON_APP.has(path);
}

/** Resolve a public-site path for the current build. */
export function siteHref(path) {
  if (isLocalPath(path)) return path;
  return `${MARKETING_URL}${path === "/" ? "" : path}`;
}
