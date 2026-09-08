import { useEffect } from "react";

/**
 * Stop the page behind an open sheet from scrolling. Restores whatever
 * `overflow` value the body had before, so nothing else on the page is left
 * with a stuck style when the sheet closes or unmounts.
 */
export function useLockBodyScroll(active) {
  useEffect(() => {
    if (!active || typeof document === "undefined") return undefined;
    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previous;
    };
  }, [active]);
}
