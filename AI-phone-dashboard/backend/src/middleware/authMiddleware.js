const { createClient } = require("@supabase/supabase-js");

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

  req.authUser = data.user;
  next();
};