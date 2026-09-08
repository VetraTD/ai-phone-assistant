import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import PrivacyPage from "../site/pages/PrivacyPage.jsx";
import TermsPage from "../site/pages/TermsPage.jsx";
import { PRIVACY } from "../site/content/legal/privacy.jsx";
import { TERMS } from "../site/content/legal/terms.jsx";

// The old /legal page was ~600 words of boilerplate with "Last updated"
// computed at render time, so it always claimed to have been reviewed today.
// These tests pin the facts the new documents must state.

function textOf(page) {
  const Page = page;
  const { container } = render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>
  );
  return container.textContent.replace(/\s+/g, " ");
}

describe("the Privacy Policy", () => {
  const text = textOf(PrivacyPage);

  it("carries a fixed date, not today's", () => {
    expect(PRIVACY.updated).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
    expect(text).toContain(`Last updated ${PRIVACY.updated}`);
    const today = new Date();
    // If this ever fails on the day the policy is genuinely updated, that is fine; bump the date.
    expect(PRIVACY.updated).not.toBe(today.toISOString().slice(0, 10));
  });

  it("names the entity and covers both UK and US law", () => {
    expect(text).toContain("VetraTD LLC");
    expect(text).toMatch(/UK GDPR/);
    expect(text).toMatch(/Texas/);
  });

  it("states how calls are handled", () => {
    expect(text).toMatch(/Calls are not recorded/);
    expect(text).toMatch(/transcript/i);
    expect(text).toMatch(/virtual assistant/);
  });

  it("names every provider that touches data", () => {
    for (const p of ["Google Cloud", "Gemini", "Twilio", "Deepgram", "ElevenLabs", "Microsoft 365", "Sentry"]) {
      expect(text).toContain(p);
    }
    expect(text).not.toMatch(/Brevo|Supabase|Vercel|Railway/);
  });

  it("is honest about retention and backups", () => {
    expect(text).toMatch(/no automatic expiry/i);
    expect(text).toMatch(/35 days/);
  });

  it("covers rights, cookies, children, security, changes and contact", () => {
    for (const h of [
      "Your rights",
      "Cookies and tracking",
      "Children",
      "Security",
      "Changes to this policy",
      "Contact",
    ]) {
      expect(text).toContain(h);
    }
    expect(text).toContain("support@vetratd.com");
    expect(text).toMatch(/sets no cookies/i);
    expect(text).toMatch(/ico\.org\.uk/);
  });

  it("makes no claim the system cannot keep", () => {
    expect(text).not.toMatch(/HIPAA/);
    expect(text).not.toMatch(/end-to-end/i);
    expect(text).not.toMatch(/[$£]\s?\d/);
  });
});

describe("the Terms of Service", () => {
  const text = textOf(TermsPage);

  it("carries a fixed date and the entity", () => {
    expect(text).toContain(`Last updated ${TERMS.updated}`);
    expect(text).toContain("VetraTD LLC");
  });

  it("is governed by Texas law", () => {
    expect(text).toMatch(/laws of the State of Texas/);
  });

  it("describes the service truthfully", () => {
    expect(text).toMatch(/no self-serve sign-up/i);
    expect(text).toMatch(/Calls are not recorded/);
    expect(text).toMatch(/not an emergency line/);
    expect(text).toMatch(/do not offer a service-level commitment/);
  });

  it("prints no price and links to the Privacy Policy", () => {
    expect(text).not.toMatch(/[$£]\s?\d/);
    expect(text).toContain("Privacy Policy");
    expect(text).toContain("support@vetratd.com");
  });

  it("has the sections a customer expects", () => {
    for (const h of [
      "Fees and payment",
      "Intellectual property",
      "Limitation of liability",
      "Ending the agreement",
      "Governing law",
    ]) {
      expect(text).toContain(h);
    }
  });
});

describe("both documents", () => {
  it("have unique section ids for the contents links", () => {
    for (const doc of [PRIVACY, TERMS]) {
      const ids = doc.sections.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
