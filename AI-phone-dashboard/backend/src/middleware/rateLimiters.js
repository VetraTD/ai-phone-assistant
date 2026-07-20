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

module.exports = {
  createRateLimitHandler,
  apiLimiter,
  sensitiveLimiter,
  authSensitiveLimiter,
  contactLimiter,
};
