import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// jsdom does not implement these. The public site's components read them at
// mount (menu focus trap, transcript auto-follow, audio player), and the
// routing test renders the real layout, so they need to exist. All are inert
// stand-ins; nothing in the dashboard tests depends on their behaviour.

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    });
  }

  if (!window.IntersectionObserver) {
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  }

  if (!window.scrollTo) window.scrollTo = () => {};

  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }

  if (typeof HTMLMediaElement !== "undefined") {
    // jsdom throws "Not implemented" for these.
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
    HTMLMediaElement.prototype.pause = vi.fn();
    HTMLMediaElement.prototype.load = vi.fn();
  }
}
