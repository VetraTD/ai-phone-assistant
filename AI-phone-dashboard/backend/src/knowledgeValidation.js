// Validation for business_knowledge CRUD (routes: GET/POST /api/knowledge,
// PUT/DELETE /api/knowledge/:id). Mirrors the settingsValidation.js pattern:
// each validator returns { value } or { error }.

const { sanitizeString } = require("./utils");

function validateQuestion(value) {
  if (typeof value !== "string") return { error: "must be a string" };
  const s = value.trim();
  if (!s || s.length > 500) return { error: "must be 1-500 characters" };
  return { value: s };
}

function validateAnswer(value) {
  if (typeof value !== "string") return { error: "must be a string" };
  const s = value.trim();
  if (!s || s.length > 2000) return { error: "must be 1-2000 characters" };
  return { value: s };
}

function validateCategory(value) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string") return { error: "must be a string" };
  return { value: sanitizeString(value, 120) };
}

function validatePriority(value) {
  if (value === undefined || value === null) return { value: 0 };
  if (!Number.isInteger(value) || value < 0 || value > 100) return { error: "must be an integer 0-100" };
  return { value };
}

function validateEnabled(value) {
  if (typeof value !== "boolean") return { error: "must be a boolean" };
  return { value };
}

// Used by the PUT (partial update) route via buildUpdateFromWhitelist —
// every key here is optional at that layer; POST (create) separately
// enforces question/answer as required before validating.
const KNOWLEDGE_FIELD_VALIDATORS = {
  question: validateQuestion,
  answer: validateAnswer,
  category: validateCategory,
  priority: validatePriority,
  enabled: validateEnabled,
};

module.exports = {
  KNOWLEDGE_FIELD_VALIDATORS,
  validateQuestion,
  validateAnswer,
  validateCategory,
  validatePriority,
};
