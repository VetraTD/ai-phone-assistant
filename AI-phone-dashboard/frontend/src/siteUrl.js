// Where "back to the website" goes, now that this origin is the app.
//
// The dashboard used to live at /app on an origin whose `/` was a marketing
// Landing page, so every "← Back to home" link could be an in-app <Link to="/">.
// That stopped being true when the dashboard took the root: those links would
// send a signed-out visitor to the dashboard, which bounces them straight back
// to the sign-in screen they were trying to leave.
//
// The marketing site is a DIFFERENT CODEBASE on a different host — vetratd.com,
// on Vercel — so these are external links, not routes. Deliberately not derived
// from VITE_SITE_URL: that variable means "the canonical URL of the site this
// bundle is served from", which is now the app origin, and reusing it here
// would recreate the loop this exists to prevent.
export const MARKETING_URL = (
  import.meta.env.VITE_MARKETING_URL || "https://www.vetratd.com"
).replace(/\/$/, "");

/** Where the dashboard lives, for the marketing build to link at. */
export const APP_URL = (import.meta.env.VITE_APP_URL || "https://app.vetratd.com").replace(
  /\/$/,
  ""
);

/**
 * Which of the two sites this bundle is.
 *
 * ONE CODEBASE, TWO DEPLOYMENTS, and until 2026-09-08 that was true by accident
 * rather than by design. `vetratd.com` is this same React app on Vercel,
 * auto-deployed from this repository, built from an older commit with empty
 * VITE_* variables — which is why its "Log in" button pointed at
 * `vetratd.com/app` and loaded a dashboard that could not reach Firebase or the
 * API and simply died.
 *
 * DEFAULTS TO "marketing" ON PURPOSE, and the asymmetry is the whole point.
 * Vercel builds with whatever environment it happens to have; this repository
 * cannot set it. If the flag goes missing there, the public domain keeps
 * serving the marketing site — which is merely stale. Were the default "app",
 * a forgotten variable would replace vetratd.com with a login screen, silently,
 * on the next push to main.
 *
 * The Firebase build passes VITE_BUILD_TARGET=app explicitly. If THAT is ever
 * forgotten the dashboard serves a marketing page, which is wrong but obvious
 * within seconds — the failure this way round is loud.
 */
export const BUILD_TARGET =
  import.meta.env.VITE_BUILD_TARGET === "app" ? "app" : "marketing";
