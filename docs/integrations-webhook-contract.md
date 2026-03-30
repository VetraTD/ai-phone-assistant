# Custom Webhook Integration Contract

This document describes the request and response format for custom webhook integrations. Use this when building an endpoint (e.g. n8n, Zapier, or your own server) that the AI phone assistant will call during live calls.

## Overview

When a business adds a custom webhook integration, the AI can invoke it as a tool during a call. Your endpoint receives an HTTP POST (or PUT) with a JSON body and must return a JSON response that the AI can use to respond to the caller.

## Request Format

Your endpoint receives a POST (or PUT, if configured) with:

```json
{
  "tool": "get_caller_appointments",
  "arguments": {
    "caller_name": "Jane Doe",
    "caller_dob": "1990-05-15"
  },
  "business_id": "uuid-of-the-business",
  "call_id": "uuid-of-the-call",
  "caller_phone": "+12125550123",
  "metadata": {}
}
```

| Field | Type | Description |
|-------|------|-------------|
| `tool` | string | The tool name (e.g. `get_caller_appointments`) |
| `arguments` | object | Parameters the AI collected from the caller |
| `business_id` | string \| null | UUID of the business (if resolved) |
| `call_id` | string \| null | UUID of the call record (if created) |
| `caller_phone` | string \| null | Caller's phone number (From) |
| `metadata` | object | Reserved for future use |

## Response Format

Return JSON with at least:

```json
{
  "success": true,
  "message": "Your next appointment is March 20, 2025 at 2:30 PM with Dr. Patel."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `success` | boolean | Recommended | `true` if the operation succeeded; `false` otherwise |
| `message` | string | Yes | Short, caller-friendly text the AI will speak. Keep it brief (1–2 sentences). |
| `error` | string | If success=false | Optional error description (for logging; avoid PHI) |
| `data` | object | No | Optional structured data for future use |

**On failure:**

```json
{
  "success": false,
  "message": "I couldn't find an upcoming appointment.",
  "error": "Patient not found"
}
```

## EHR-Style Tool Contracts (Appointments-First)

These are suggested tool names and argument shapes for EHR integrations (e.g. athenahealth). Your webhook can implement any of these; the AI will use the tool when the caller asks for the corresponding action.

### get_caller_appointments

**Purpose:** Return the caller's upcoming appointments.

**Arguments (typical):**
- `caller_name` (string): Full name
- `caller_dob` (string): Date of birth (YYYY-MM-DD)
- `caller_phone` (string, optional): Phone number (may be in request root)

**Example response:**
```json
{
  "success": true,
  "message": "Your next appointment is March 20, 2025 at 2:30 PM with Dr. Patel."
}
```

### get_available_slots

**Purpose:** Return available appointment slots for a given date/service.

**Arguments (typical):**
- `date` (string): Date (YYYY-MM-DD)
- `service_type` (string, optional): Type of appointment

**Example response:**
```json
{
  "success": true,
  "message": "Available times on March 20: 9:00 AM, 11:00 AM, and 2:30 PM."
}
```

### book_appointment_in_ehr

**Purpose:** Book an appointment in the external system.

**Arguments (typical):**
- `caller_name` (string)
- `caller_phone` (string)
- `caller_dob` (string, optional)
- `scheduled_at` (string): ISO 8601 datetime
- `service_type` (string)
- `notes` (string, optional)

**Example response:**
```json
{
  "success": true,
  "message": "You're all set! Your appointment is confirmed for March 20 at 2:30 PM."
}
```

## Security

- Use HTTPS only.
- Validate requests (e.g. require an `Authorization` header or shared secret you configure in the integration).
- Do not log full request/response bodies if they contain PHI.
- Keep responses short; avoid returning raw PHI beyond what the caller needs to hear.

## Timeout

The platform will wait up to 10 seconds for your response. If you exceed this, the AI will receive a timeout error and will tell the caller that the request could not be completed.
