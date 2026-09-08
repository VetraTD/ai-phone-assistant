import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HomePage from "../site/pages/HomePage.jsx";
import FeaturesPage from "../site/pages/FeaturesPage.jsx";
import { CALL_MOMENTS } from "../site/content/callMoments.js";
import { DEMO_CALL } from "../site/content/demoCall.js";

// The old site said $149/mo, "8 languages", "port your number", "sign up in
// minutes", "unlimited calls" and "every call encrypted". None of it was true.
// These tests read the rendered pages and refuse the claims the product
// cannot keep. The transcript region is excluded: it is a real call, and the
// receptionist quoting the clinic's own fee is not Vetra quoting a price.

function renderAt(page) {
  const Page = page;
  const { container } = render(
    <MemoryRouter>
      <Page />
    </MemoryRouter>
  );
  return container;
}

function copyWithoutTranscript(container) {
  const clone = container.cloneNode(true);
  clone.querySelectorAll(".tx__region").forEach((n) => n.remove());
  return clone.textContent.replace(/\s+/g, " ");
}

const PRICE = /[$£]\s?\d|\/mo\b|per month|a month\b/i;
const OLD_NUMBER = /817/;
const FORBIDDEN = [
  /HIPAA/i,
  /end-to-end/i,
  /encrypt/i,
  /port(ing)? your (existing )?number/i,
  /Google Calendar/i,
  /8 languages/i,
  /unlimited/i,
  /in minutes/i,
  /uptime/i,
  /\bSLA\b/,
  /guarantee/i,
  /calls? (are|is|get|will be) recorded/i,
  /customers? (love|trust)/i,
];

describe("the home page", () => {
  it("shows no price and none of the old demo number", () => {
    const text = copyWithoutTranscript(renderAt(HomePage));
    expect(text).not.toMatch(PRICE);
    expect(text).not.toMatch(OLD_NUMBER);
  });

  it("makes no claim the product cannot keep", () => {
    const text = copyWithoutTranscript(renderAt(HomePage));
    for (const re of FORBIDDEN) expect(text).not.toMatch(re);
  });

  it("asks exactly six questions", () => {
    const container = renderAt(HomePage);
    expect(container.querySelectorAll("details").length).toBe(6);
  });

  it("has no phone link while the demo number is off", () => {
    const container = renderAt(HomePage);
    expect(container.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it("keeps one primary action above the fold", () => {
    const container = renderAt(HomePage);
    const hero = container.querySelector(".hero");
    expect(hero.querySelectorAll(".site-btn--primary").length).toBe(1);
  });

  it("states the sanctioned onboarding claim and no faster one", () => {
    const text = copyWithoutTranscript(renderAt(HomePage));
    expect(text).toMatch(/3 business days|three business days/i);
    expect(text).not.toMatch(/same day|instant|seconds/i);
  });
});

describe("the features page", () => {
  it("shows no price and makes no forbidden claim", () => {
    const text = copyWithoutTranscript(renderAt(FeaturesPage));
    expect(text).not.toMatch(PRICE);
    for (const re of FORBIDDEN) expect(text).not.toMatch(re);
  });
});

describe("the call moments", () => {
  const spoken = DEMO_CALL.transcript.words.map((w) => w.w).join(" ").replace(/\s+/g, " ");

  it("quote the receptionist verbatim", () => {
    for (const m of CALL_MOMENTS) {
      const fragments = m.excerpt
        .split("…")
        .map((f) => f.trim())
        .filter(Boolean);
      expect(fragments.length).toBeGreaterThan(0);
      for (const f of fragments) expect(spoken).toContain(f);
    }
  });

  it("point at the receptionist's turn, not the caller's", () => {
    const { words, speakers } = DEMO_CALL.transcript;
    for (const m of CALL_MOMENTS) {
      const word = words.find((w) => w.start >= m.at);
      expect(speakers[String(word.speaker)]).toBe("Vetra");
    }
  });
});
