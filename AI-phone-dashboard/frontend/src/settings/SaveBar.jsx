import { useEffect, useRef, useState } from "react";
import { ChevronDown, CircleCheck, TriangleAlert } from "lucide-react";
import { describeChanges } from "./fieldLabels";
import { GROUPS } from "./groups";

const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.id, g.label]));

/**
 * Sticky header for the whole settings page: what state the page is in, and
 * the one button that commits it.
 *
 * It answers three questions that the old bottom-of-page save panel could not:
 * whether anything is unsaved, *what* is unsaved, and where that setting lives.
 * Clicking a row jumps to its group, so the answer is also the way back to it.
 *
 * Only page-level draft state lives here. Capability cards and the knowledge
 * base save themselves and report inline — see Panel's `saveOwner`.
 */
export default function SaveBar({ dirtyKeys, saving, error, saved, onSave, onJump }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const changes = describeChanges(dirtyKeys);
  const count = changes.length;

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  // Nothing left to disclose once a save lands.
  useEffect(() => {
    if (!count) setOpen(false);
  }, [count]);

  let status;
  if (error) {
    status = (
      <span className="set-status set-status-error">
        <TriangleAlert size={15} aria-hidden="true" />
        {error}
      </span>
    );
  } else if (saving) {
    status = <span className="set-status">Saving…</span>;
  } else if (count) {
    status = null; // the disclosure button below already says it, and louder
  } else if (saved) {
    status = (
      <span className="set-status set-status-saved">
        <CircleCheck size={15} aria-hidden="true" />
        All changes saved
      </span>
    );
  } else {
    status = (
      <span className="set-status">
        <span className="set-status-dot" aria-hidden="true" />
        Everything is saved
      </span>
    );
  }

  return (
    <div className="set-savebar">
      <div className="set-savebar-left">
        <h2 className="set-savebar-title">Settings</h2>
      </div>

      <div className="set-savebar-right">
        {/* Screen readers get the state as prose regardless of which branch of
            the visual treatment above is showing. */}
        <span className="set-sr-only" role="status" aria-live="polite">
          {error
            ? `Could not save: ${error}`
            : saving
              ? "Saving"
              : count
                ? `${count} unsaved ${count === 1 ? "change" : "changes"}`
                : "All changes saved"}
        </span>

        {status}

        {count ? (
          <div className="set-changes" ref={wrapRef}>
            <button
              type="button"
              className="set-changes-toggle"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              <span className="set-status-dot" aria-hidden="true" />
              {count} unsaved {count === 1 ? "change" : "changes"}
              <ChevronDown className="set-changes-chevron" size={15} aria-hidden="true" />
            </button>

            {open ? (
              <div className="set-changes-menu">
                <div className="set-changes-menu-title">Not saved yet</div>
                {changes.map((change) => (
                  <button
                    key={change.key}
                    type="button"
                    className="set-changes-item"
                    onClick={() => {
                      if (change.group) onJump(change.group);
                      setOpen(false);
                    }}
                  >
                    <span>{change.label}</span>
                    <span className="set-changes-item-group">{GROUP_LABEL[change.group] || ""}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <button type="button" className="set-btn-primary" onClick={onSave} disabled={saving || !count}>
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>
    </div>
  );
}
