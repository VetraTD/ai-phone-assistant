import { useRef } from "react";
import { GROUPS } from "./groups";

/**
 * The group rail.
 *
 * A real tablist: one tab stop for the whole rail, arrow keys move between
 * groups, Home/End jump to the ends. Tabbing through six buttons to reach the
 * form is how a keyboard user gets tired of a settings page.
 *
 * Below 900px the same markup becomes a horizontally scrollable chip row (see
 * Settings.css) rather than a second component to keep in sync.
 *
 * `dirtyGroups` is a Set of group ids holding unsaved page-level edits. The dot
 * is paired with visually-hidden text so it is not colour-only.
 */
export default function SettingsNav({ active, onChange, dirtyGroups, captions }) {
  const railRef = useRef(null);

  const move = (delta, currentIndex) => {
    const next = (currentIndex + delta + GROUPS.length) % GROUPS.length;
    onChange(GROUPS[next].id);
    railRef.current?.querySelectorAll('[role="tab"]')[next]?.focus();
  };

  const onKeyDown = (e, index) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        move(1, index);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        move(-1, index);
        break;
      case "Home":
        e.preventDefault();
        move(-index, index);
        break;
      case "End":
        e.preventDefault();
        move(GROUPS.length - 1 - index, index);
        break;
      default:
        break;
    }
  };

  return (
    <div className="set-rail" role="tablist" aria-orientation="vertical" aria-label="Settings sections" ref={railRef}>
      {GROUPS.map((group, index) => {
        const isActive = group.id === active;
        const isDirty = dirtyGroups.has(group.id);
        const Icon = group.icon;
        return (
          <button
            key={group.id}
            type="button"
            role="tab"
            id={`set-tab-${group.id}`}
            aria-selected={isActive}
            aria-controls={`set-panel-${group.id}`}
            tabIndex={isActive ? 0 : -1}
            className={`set-rail-tab${isActive ? " is-active" : ""}`}
            onClick={() => onChange(group.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            <span className="set-rail-icon" aria-hidden="true">
              <Icon size={18} strokeWidth={1.9} />
            </span>
            <span className="set-rail-text">
              <span className="set-rail-label">{group.label}</span>
              <span className="set-rail-caption">{captions?.[group.id] ?? group.caption}</span>
            </span>
            {isDirty ? (
              <>
                <span className="set-rail-dot" aria-hidden="true" />
                <span className="set-sr-only">has unsaved changes</span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
