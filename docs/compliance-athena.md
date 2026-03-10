# Athenahealth connector — compliance and security

This document records how the athenahealth connector implementation addresses the compliance and security requirements in the connector plan (section 9).

## Implemented in code

- **No PHI in logs.** The athenahealth module ([services/athenahealth.js](../services/athenahealth.js)) logs only: `tool`, `practice_id`, `duration_ms`, `success`, and generic `status` or `error` (e.g. "token_failed", "missing_config"). No patient names, DOB, phone, or appointment details are logged.
- **HTTPS only.** All athena API calls use `process.env.ATHENA_API_BASE` and `ATHENA_TOKEN_URL`; the implementation uses `fetch` with these URLs. Env must be set to `https://` endpoints (preview or production). No HTTP fallback.
- **Timeouts.** All athena HTTP requests use a 10-second timeout (`ATHENA_TIMEOUT_MS`) so the AI turn does not hang.
- **Unit tests** use generic test data only; no real PHI in tests.

## Operational / ongoing

- **BAA with LLM provider.** The AI (Gemini) may receive and speak PHI during calls. Maintain a Business Associate Agreement (BAA) with the LLM provider (e.g. Google for Gemini) and use a BAA-eligible API tier where required. Document the BAA as part of your compliance posture.
- **Access control.** Restrict access to `ATHENA_*` env vars and to the `integrations` table (practice_id, config) to systems and people who need them. Use secure secret management in production.
- **Customer contracts and regulations.** Align with any security or privacy commitments in customer contracts (e.g. ECC) and with state or other regulations that apply.
