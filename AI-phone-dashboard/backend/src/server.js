require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");

// DB pool (make sure src/db/index.js exports the pool)
const pool = require("./db");

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

// CORS: allow localhost for dev, Vercel preview, and production domain(s)
const defaultOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "https://ai-phone-dashboard-lemon.vercel.app",
  "https://vetratd.com",
  "https://www.vetratd.com",
];

const envOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
  : [];

const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

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

// Contact form (public, rate-limited) – sends to CONTACT_EMAIL via Brevo
app.post("/api/contact", contactLimiter, async (req, res) => {
  try {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_FROM_EMAIL) {
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
    const toEmail = process.env.CONTACT_EMAIL || process.env.BREVO_FROM_EMAIL || "support@vetratd.com";
    const text = `Contact form submission from Vetra AI\n\nName: ${name}\nEmail: ${email}\n\nMessage:\n${message}`;
    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: {
          email: process.env.BREVO_FROM_EMAIL,
          name: process.env.BREVO_FROM_NAME || "Vetra AI",
        },
        to: [{ email: toEmail }],
        replyTo: { email, name },
        subject: `Vetra AI contact: ${name}`,
        textContent: text,
      },
      {
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json",
          accept: "application/json",
        },
      }
    );
    res.json({ success: true });
  } catch (err) {
    console.error("contact form failed:", err.response?.data ?? err.message);
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
app.use(require("./routes/calendar"));
app.use(require("./routes/onboarding"));
app.use(require("./routes/settings"));
app.use(require("./routes/knowledge"));

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
  app.listen(PORT, () => {
    console.log("Dashboard backend running on port " + PORT);
  });
}

module.exports = app;
