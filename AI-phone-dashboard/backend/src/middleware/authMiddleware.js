const { createClient } = require("@supabase/supabase-js");
const { checkSessionAge, SESSION_MAX_AGE_CODE } = require("./sessionAge");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

module.exports = async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No authorization header" });

  const token = authHeader.split(" ")[1];

  const { data, error } = await supabase.auth.getUser(token);

  if (error) {
    return res.status(401).json({
      error: "Invalid token",
      details: error.message
    });
  }

  // §164.312(a)(2)(iii) automatic logoff.
  //
  // AFTER getUser, never before. checkSessionAge reads the `iat` claim WITHOUT
  // verifying the signature, which is only safe once the auth backend has
  // already verified it — the ordering here is the safety property, not a
  // stylistic choice.
  //
  // A distinct `code` rather than a bare 401, because the dashboard refreshes
  // once and retries on exactly this (frontend src/authRetry.js). Without that
  // distinction the ceiling would be indistinguishable from a real sign-out and
  // would log a working clinic out mid-sentence, since Supabase refreshes its
  // token on a timer near expiry rather than when somebody acts.
  const age = checkSessionAge(token);
  if (age.expired) {
    return res.status(401).json({
      error: "Session expired",
      code: SESSION_MAX_AGE_CODE,
    });
  }

  req.authUser = data.user;
  next();
};
