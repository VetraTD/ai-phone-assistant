// Calls-list date bounds, in the BUSINESS timezone.
//
// The list used to compare `started_at >= $from::date`. That cast happens in
// the database session timezone (UTC on Cloud SQL), so "to = today" ended at
// 00:00 UTC — 7 PM CDT — and every later call was hidden until the next day.
//
// Here the date is turned into a local midnight (`::date::timestamp`) and then
// into an instant with `AT TIME ZONE <tz>`. The functions sit on the bound,
// never on `started_at`, so an index on started_at still applies. The timezone
// is a bound parameter, never interpolated: it comes from a database row.

// The timezone a business gets when its row does not name one. Same value the
// schema column defaults to and analytics.js falls back to.
const DEFAULT_TIMEZONE = "America/Chicago";

// Reads the business timezone with the caller's query function.
async function loadBusinessTimezone(query, businessId) {
  const r = await query(`SELECT timezone FROM businesses WHERE id = $1 LIMIT 1`, [businessId]);
  return r.rows[0]?.timezone || DEFAULT_TIMEZONE;
}

// Returns the WHERE fragments for ?from / ?to. `addParam(value)` pushes a bound
// parameter and returns its `$n`. The timezone is pushed once, only when a date
// bound is present.
function callDateClauses({ from, to, tz, addParam }) {
  const clauses = [];
  if (!from && !to) return clauses;
  const tzParam = addParam(tz);
  if (from) {
    clauses.push(`started_at >= (${addParam(from)}::date::timestamp AT TIME ZONE ${tzParam})`);
  }
  if (to) {
    // include the whole "to" day: strictly before local midnight of the next day
    clauses.push(`started_at < ((${addParam(to)}::date + 1)::timestamp AT TIME ZONE ${tzParam})`);
  }
  return clauses;
}

module.exports = { DEFAULT_TIMEZONE, loadBusinessTimezone, callDateClauses };
