# ai-phone-assistant
An intelligent AI-powered phone assistant designed to handle calls, take messages, and more using natural language processing.

## Testing

Run the test suite (mocked by default; no real Twilio or Supabase required):

```bash
npm test
```

Watch mode:

```bash
npm run test:watch
```

**What’s tested**

- **twilioNumbers** (search/purchase with mocked Twilio), **updateBusinessPhoneNumber** (mocked Supabase), and **phone-numbers API** routes (GET available, POST buy) with mocked dependencies.
- **Real Twilio search:** If `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set (e.g. in `.env`), the integration tests in `tests/twilioNumbers.integration.test.js` run and call the real Twilio API for **search only** (no numbers are purchased). If either env var is missing, those tests are skipped. Buy is always mocked everywhere; no test ever purchases a real number.
