import { useId } from "react";

/**
 * A labelled control.
 *
 * Every input on this page goes through here so the label/id/aria-describedby
 * wiring cannot be forgotten one field at a time. `children` is a function
 * receiving the props the control must spread, rather than a plain node, so
 * there is no way to render a Field whose label points at nothing.
 *
 *   <Field label="Business name" hint="Shown to callers.">
 *     {(p) => <input {...p} value={…} onChange={…} />}
 *   </Field>
 */
export default function Field({
  label,
  hint,
  error,
  optional = false,
  recommended = false,
  count,
  max,
  children,
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="set-field">
      <label className="set-label" htmlFor={id}>
        {label}
        {recommended ? <span className="set-recommended">Recommended</span> : null}
        {optional && !recommended ? <span className="set-optional">optional</span> : null}
      </label>

      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })}

      {error ? (
        <p className="set-field-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p className="set-hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {count != null && max != null ? (
        <span className="set-count">
          {count}/{max}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A checkbox with its label. Kept separate from Field because the label wraps
 * the control here rather than pointing at it, and because the whole row —
 * not just the 18px box — has to be the click target.
 */
export function CheckField({ checked, onChange, children, hint, disabled }) {
  return (
    <label className="set-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="set-check-text">
        {children}
        {hint ? <span className="set-check-hint">{hint}</span> : null}
      </span>
    </label>
  );
}
