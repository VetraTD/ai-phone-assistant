/**
 * The bar under a page whose settings share one draft (Voice agent, Settings):
 * how many changes are unsaved, or that they were saved, with Discard and Save.
 * It sits outside the item panel so it also shows on a phone's list screen.
 */
export default function DraftSaveBar({ message, dirty, saving, onSave, onDiscard }) {
  return (
    <div className={`vt-va-save${message ? "" : " vt-va-save-empty"}`}>
      <span role="status" aria-live="polite">
        {message}
      </span>
      {dirty ? (
        <span className="vt-va-save-actions">
          <button type="button" className="vt-btn vt-btn-quiet" onClick={onDiscard} aria-disabled={saving || undefined}>
            Discard
          </button>
          <button type="button" className="vt-btn vt-btn-primary" onClick={onSave} aria-disabled={saving || undefined}>
            {saving ? "Saving…" : "Save"}
          </button>
        </span>
      ) : null}
    </div>
  );
}
