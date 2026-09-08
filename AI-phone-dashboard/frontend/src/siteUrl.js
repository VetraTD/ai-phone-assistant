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
