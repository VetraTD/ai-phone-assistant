require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");

// DB pool (make sure src/db/index.js exports the pool)
const pool = require("./db");
const mailer = require("./services/mailer");

const { sanitizeString, isValidEmail, rejectUnexpectedKeys } = require("./utils");
const { apiLimiter, contactLimiter } = require("./middleware/rateLimiters");

const app = express();

// Behind Vercel/other proxies, trust the proxy so rate-limits and IP logging work correctly
app.set("trust proxy", 1);

// Basic security headers
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

// CORS allow-list. Kept deliberately in step with the voice server's — see the
// long comment there for the reasoning behind each of these three changes.
//
// The short version: the Vercel preview domain is GONE, because D7 cancels the
// Vercel account and a released *.vercel.app subdomain can be claimed by
// anyone — which would hand a stranger a cross-origin foothold against an
// authenticated dashboard session at a moment nobody would connect to a
// hosting change. Localhost is dev-only. And the two servers now read the same
// variable name.
const isProduction = process.env.NODE_ENV === "production";

const devOrigins = ["http://localhost:5173", "http://localhost:4173"];
const prodOrigins = ["https://vetratd.com", "https://www.vetratd.com"];

const envOrigins = (process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins = [
  ...new Set([...(isProduction ? [] : devOrigins), ...prodOrigins, ...envOrigins]),
];

app.use(
  cors({
    origin: function (origin, callback) {
     //  Allow non-browser/health requests with no origin
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

console.log("Allowed CORS origins:", allowedOrigins);

app.use(express.json({ limit: "1mb" }));

// Apply global limiter to all API traffic except health/db-test
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/db-test") {
    return next();
  }
  return apiLimiter(req, res, next);
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "running",
    service: "dashboard-backend",
  });
});

// Contact form (public, rate-limited) - sends to CONTACT_EMAIL over SMTP.
app.post("/api/contact", contactLimiter, async (req, res) => {
  try {
    if (!mailer.isConfigured()) {
      return res.status(503).json({ error: "Contact form is not configured." });
    }
    const allowedKeys = ["name", "email", "message"];
    rejectUnexpectedKeys(req.body || {}, allowedKeys);

    const name = sanitizeString(req.body?.name, 120);
    const email = sanitizeString(req.body?.email, 254);
    const message = sanitizeString(req.body?.message, 4000);

    if (!name || !email || !message) {
      return res.status(400).json({ error: "Name, email, and message are required." });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }
    const toEmail = process.env.CONTACT_EMAIL || process.env.SMTP_FROM_EMAIL || "support@vetratd.com";
    const text = `Contact form submission from Vetra AI\n\nName: ${name}\nEmail: ${email}\n\nMessage:\n${message}`;
    // replyTo is the submitter, so hitting reply answers the prospect. The
    // From stays the authenticated SMTP identity - sending AS the submitter
    // would fail SPF at the receiver, which is how a contact form burns a
    // domain's reputation.
    await mailer.sendMail({
      to: toEmail,
      subject: `Vetra AI contact: ${name}`,
      text,
      replyTo: email,
      fromName: "Vetra AI",
    });
    res.json({ success: true });
  } catch (err) {
    // `err.message` only, never the error object. A transport error carries
    // its connection options - including auth.pass - as own enumerable
    // properties, so printing it wholesale dumps the SMTP password into the
    // logs. Same defect class that leaked BREVO_API_KEY, one vendor later.
    console.error("contact form failed:", err?.message);
    res.status(500).json({ error: "Failed to send message. Please try again or email us directly." });
  }
});

// DB connection test (disabled in production)
app.get("/db-test", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not found" });
  }
  try {
    const r = await pool.query("select now() as now");
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Route modules — see src/routes/*.js. Each module owns its own full paths
// (e.g. "/api/calls"), so these mount with no prefix.
app.use(require("./routes/calls"));
app.use(require("./routes/appointments"));
app.use(require("./routes/analytics"));
app.use(require("./routes/onboarding"));
app.use(require("./routes/settings"));
app.use(require("./routes/knowledge"));
app.use(require("./routes/capabilities"));

// Centralized error handler – avoid leaking stack traces in production
// Note: keep this AFTER all route declarations
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Log the message/stack, never the error object: an AxiosError that reaches
  // here carries the outbound request's headers and body on `err.config`
  // (own enumerable props), so printing it dumps API keys into the logs.
  console.error("Unhandled error:", err?.response?.data ?? err?.message, err?.stack);
  if (res.headersSent) {
    return;
  }
  const status = err.statusCode && Number.isInteger(err.statusCode) ? err.statusCode : 500;
  res.status(status).json({
    error: status === 500 ? "Internal server error" : err.message || "Request failed",
  });
});

// Only start listening when run directly (`node src/server.js` /
// `nodemon src/server.js`) — not when required by a test harness, so
// supertest can exercise `app` without binding a real port.
if (require.main === module) {
  const PORT = process.env.PORT || 3001;

  // THE DATABASE BEFORE THE PORT, not after.
  //
  // On Cloud SQL the pool cannot be built at module load — the connector
  // fetches ephemeral certificates first — so it is built here and awaited
  // before anything can be served. A service that is listening and cannot reach
  // its database is worse than one that has not started: it returns 500s that
  // look like application bugs, and a load balancer marks it healthy.
  //
  // A no-op on the DATABASE_URL path, where the pool already exists.
  require("./db")
    .init()
    .then(() => {
      app.listen(PORT, () => {
        console.log("Dashboard backend running on port " + PORT);
      });
    })
    .catch((err) => {
      console.error("Refusing to start: the database pool could not be built —", err?.message);
      process.exit(1);
    });
}

module.exports = app;
