import { useEffect, useRef } from "react";
import { useBlocker } from "react-router-dom";

/**
 * Spec §7: leaving a settings panel with unsaved changes asks first.
 *
 * Blocks navigation to another page (a different pathname; a change of query
 * string within the same page keeps the draft and is let through) and asks in a
 * dialog. Closing or reloading the tab gets the browser's own prompt.
 *
 * Needs a data router (createBrowserRouter / createMemoryRouter): useBlocker
 * throws under a plain <BrowserRouter>.
 *
 * @param {boolean} dirty  true while there are unsaved changes
 * @param {{ stayWithin?: string }} [options]  moves to addresses under this
 *   prefix keep the draft (a page whose items share one draft) and are let through
 * @returns {JSX.Element|null}  the dialog, to render wherever the page likes
 */
export function useUnsavedChangesGuard(dirty, { stayWithin } = {}) {
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      currentLocation.pathname !== nextLocation.pathname &&
      !(stayWithin && nextLocation.pathname.startsWith(stayWithin))
  );

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const keepRef = useRef(null);
  const open = blocker.state === "blocked";
  useEffect(() => {
    if (open) keepRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div className="vt-app vt-dialog-backdrop">
      <div
        className="vt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vt-unsaved-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") blocker.reset();
        }}
      >
        <p id="vt-unsaved-title" className="vt-dialog-text">
          You have unsaved changes. Leave without saving?
        </p>
        <div className="vt-dialog-actions">
          <button ref={keepRef} type="button" className="vt-btn vt-btn-primary" onClick={() => blocker.reset()}>
            Keep editing
          </button>
          <button type="button" className="vt-btn vt-btn-quiet" onClick={() => blocker.proceed()}>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
