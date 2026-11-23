const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

function createRateLimitHandler() {
  return (req, res, next, options) => {
    if (res.headersSent) return;
    res.status(options.statusCode).json({
      error: "Too many requests. Please slow down and try again shortly.",
    });
  };
}

// Global rate limiter (per IP) – conservative defaults for now
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 600, // 600 requests per 15 minutes per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler(),
});

// Stricter limiter for expensive / sensitive endpoints
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler(),
});

// Authenticated sensitive limiter – keyed by user id when available
const authSensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req /* , res */) => req.authUser?.id || ipKeyGenerator(req.ip),
  handler: createRateLimitHandler(),
});

// Contact form: strict limit (no auth)
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler(),
});

// Password reset: unauthenticated and sends email, so the strictest per-IP
// limit. routes/passwordReset.js adds a per-address limit behind it.
//
// Keyed on req.ip, which is right only while server.js's `trust proxy 1`
// matches the hops in front of the service (Cloud Run's front end today). Put
// the Terraform load balancer in front and req.ip becomes the balancer, so
// every visitor shares ONE bucket and one abuser blocks reset for everyone:
// raise `trust proxy` in the same change.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler(),
});

module.exports = {
  createRateLimitHandler,
  apiLimiter,
  sensitiveLimiter,
  authSensitiveLimiter,
  contactLimiter,
  passwordResetLimiter,
};
