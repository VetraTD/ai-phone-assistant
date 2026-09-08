import { useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isVisible(el) {
  // The sheet is full-screen, so anything not explicitly hidden is reachable.
  // (offsetParent is unusable here: jsdom reports null for everything.)
  if (el.hidden) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el.closest("[hidden]")) return false;
  return true;
}

/**
 * Keep keyboard focus inside `containerRef` while `active`.
 *
 * On activation the first focusable child receives focus; Tab and Shift+Tab
 * wrap at the ends; Escape calls `onEscape`. On deactivation focus returns to
 * whatever had it before, so closing a menu puts the reader back on the
 * button that opened it.
 */
export function useFocusTrap(containerRef, active, { onEscape } = {}) {
  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    const previouslyFocused =
      typeof document !== "undefined" ? document.activeElement : null;

    const focusables = () => Array.from(container.querySelectorAll(FOCUSABLE)).filter(isVisible);

    const first = focusables()[0];
    if (first) first.focus();
    else container.focus();

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (onEscape) onEscape();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === firstEl || !container.contains(current))) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (current === lastEl || !container.contains(current))) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [containerRef, active, onEscape]);
}
