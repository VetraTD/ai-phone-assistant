ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS custom_instructions text;

COMMENT ON COLUMN businesses.custom_instructions IS
  'Optional operator-supplied rules for the AI receptionist (max 2000 chars). '
  'Injected into the system prompt under CUSTOM BUSINESS RULES at call time.';
