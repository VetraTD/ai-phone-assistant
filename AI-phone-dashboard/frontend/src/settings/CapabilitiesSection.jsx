import { useEffect, useState } from "react";
import { api } from "../api";
import SectionCard from "./SectionCard";
import { errorBoxStyle } from "./styles";

/**
 * Capability settings, rendered from the schema each capability pack declares.
 *
 * Nothing here is written per capability. The cards, the adapter picker and the
 * identity-field editor are all driven by /api/capabilities/definitions, which
 * is generated from the packs themselves — so adding a capability to the engine
 * makes its settings appear here with no frontend change. That is the whole
 * reason the schemas exist; hand-writing a section per capability is the tax
 * this replaces.
 *
 * Saves are per capability rather than one bulk submit, so a validation error
 * in one card cannot discard edits made in another.
 */
export default function CapabilitiesSection({ businessId }) {
  const [defs, setDefs] = useState(null);
  const [rows, setRows] = useState({});
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;

    (async () => {
      try {
        const [definitions, current] = await Promise.all([
          api.get("/api/capabilities/definitions"),
          api.get(`/api/business/${businessId}/capabilities`),
        ]);
        if (cancelled) return;
        setDefs(definitions.data);
        setRows(Object.fromEntries(current.data.capabilities.map((c) => [c.capability_id, c])));
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.response?.data?.error || err.message || "Could not load capabilities");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [businessId]);

  if (loadError) {
    return (
      <SectionCard title="Capabilities">
        <div style={errorBoxStyle}>{loadError}</div>
      </SectionCard>
    );
  }
  if (!defs) {
    return (
      <SectionCard title="Capabilities">
        <p className="muted">Loading…</p>
      </SectionCard>
    );
  }

  return (
    <>
      {defs.capabilities.map((def) => (
        <CapabilityCard
          key={def.id}
          def={def}
          adapters={defs.adapters}
          row={rows[def.id]}
          businessId={businessId}
          onSaved={(saved) =>
            setRows((prev) => ({ ...prev, [def.id]: { ...prev[def.id], ...saved, configured: true } }))
          }
        />
      ))}
    </>
  );
}

function CapabilityCard({ def, adapters, row, businessId, onSaved }) {
  const [draft, setDraft] = useState(() => ({
    enabled: row?.enabled ?? def.core,
    adapter: row?.adapter ?? def.configSchema?.adapter?.default ?? null,
    config: row?.config ?? {},
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!row) return;
    setDraft({
      enabled: row.enabled,
      adapter: row.adapter ?? def.configSchema?.adapter?.default ?? null,
      config: row.config ?? {},
    });
  }, [row, def]);

  const patchConfig = (patch) => {
    setSaved(false);
    setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
  };
  const patchRequire = (patch) => {
    setSaved(false);
    setDraft((d) => ({ ...d, config: { ...d.config, require: { ...(d.config.require || {}), ...patch } } }));
  };

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await api.put(`/api/business/${businessId}/capabilities/${def.id}`, {
        enabled: draft.enabled,
        adapter: draft.adapter,
        config: draft.config,
      });
      onSaved({ enabled: draft.enabled, adapter: draft.adapter, config: draft.config });
      setSaved(true);
    } catch (err) {
      // The backend rejects a bad setting outright and names it, rather than
      // saving something that would silently do nothing. Surface that reason.
      setError(err.response?.data?.error || err.message || "Could not save");
    } finally {
      setSaving(false);
    }
  }

  const schema = def.configSchema || {};
  const requireSchema = schema.require || {};
  const require = draft.config.require || {};
  const off = !def.core && !draft.enabled;

  // What this business's chosen backend can actually prove a caller against.
  // Used below to explain, honestly, why a custom field can only be collected.
  const adapterList = def.adapterKind ? adapters[def.adapterKind] || [] : [];
  const chosenAdapter = adapterList.find((a) => a.id === draft.adapter);
  const canVerify = (chosenAdapter?.verifiableFields || []).length > 0;

  return (
    <SectionCard
      title={
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {def.label}
          {def.core ? <span className="call-pill">always on</span> : null}
        </span>
      }
    >
      {def.description ? <p className="muted" style={{ marginTop: 0 }}>{def.description}</p> : null}

      {!def.core && (
        <div className="filter-field">
          <label className="checkbox-item" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => {
                setSaved(false);
                setDraft((d) => ({ ...d, enabled: e.target.checked }));
              }}
            />
            <span>Turn this on for my business</span>
          </label>
        </div>
      )}

      {!off && (
        <>
          {schema.adapter && adapterList.length > 0 && (
            <div className="filter-field">
              <label>{schema.adapter.label}</label>
              <select
                value={draft.adapter ?? ""}
                onChange={(e) => {
                  setSaved(false);
                  setDraft((d) => ({ ...d, adapter: e.target.value || null }));
                }}
              >
                {schema.adapter.options.map((id) => {
                  const a = adapterList.find((x) => x.id === id);
                  return (
                    <option key={id} value={id}>
                      {a?.label || id}
                    </option>
                  );
                })}
              </select>
              <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                {canVerify
                  ? `Can confirm a caller against: ${chosenAdapter.verifiableFields
                      .filter((f) => !f.includes("*"))
                      .join(", ")}.`
                  : "We can't read this system, so anything you ask for below is collected but not checked against a record."}
              </p>
            </div>
          )}

          {requireSchema.identity && (
            <IdentityEditor
              schema={requireSchema.identity}
              value={require.identity || {}}
              canVerify={canVerify}
              onChange={(identity) => patchRequire({ identity })}
            />
          )}

          {requireSchema.confirmBeforeWrite && (
            <ToggleField
              schema={requireSchema.confirmBeforeWrite}
              checked={!!require.confirmBeforeWrite}
              onChange={(v) => patchRequire({ confirmBeforeWrite: v })}
            />
          )}

          {requireSchema.businessHoursOnly && (
            <ToggleField
              schema={requireSchema.businessHoursOnly}
              checked={!!require.businessHoursOnly}
              onChange={(v) => patchRequire({ businessHoursOnly: v })}
            />
          )}

          {schema.notes && (
            <div className="filter-field">
              <label>{schema.notes.label}</label>
              <textarea
                rows={3}
                value={draft.config.notes || ""}
                placeholder={schema.notes.placeholder}
                onChange={(e) => patchConfig({ notes: e.target.value })}
              />
              <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                Guidance, not a rule — the receptionist follows this closely but it isn't enforced.
                Anything that must always happen belongs in the checkboxes above.
              </p>
            </div>
          )}
        </>
      )}

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <button type="button" className="btn" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved ? <span className="muted">Saved</span> : null}
      </div>
    </SectionCard>
  );
}

function ToggleField({ schema, checked, onChange }) {
  return (
    <div className="filter-field">
      <label className="checkbox-item" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{schema.label}</span>
      </label>
    </div>
  );
}

/**
 * Built-in identity checks plus any the business invents.
 *
 * The custom half is the point: a clinic that asks for a "dental number" adds
 * it here and the receptionist starts requiring it, with no code written. The
 * wording it will use is the business's own, because a field the receptionist
 * has to improvise a question for is a field the caller will not understand.
 */
function IdentityEditor({ schema, value, canVerify, onChange }) {
  const builtin = value.builtin || [];
  const custom = value.custom || [];

  const toggleBuiltin = (key) =>
    onChange({
      ...value,
      builtin: builtin.includes(key) ? builtin.filter((k) => k !== key) : [...builtin, key],
    });

  const patchCustom = (i, patch) =>
    onChange({ ...value, custom: custom.map((f, idx) => (idx === i ? { ...f, ...patch } : f)) });

  const addCustom = () =>
    onChange({
      ...value,
      custom: [...custom, { key: "", label: "", ask: "", pattern: "", verify: "collect_only" }],
    });

  const removeCustom = (i) => onChange({ ...value, custom: custom.filter((_, idx) => idx !== i) });

  return (
    <div className="filter-field">
      <label>{schema.label}</label>

      <div className="checkbox-list">
        {(schema.builtinOptions || []).map((key) => (
          <label key={key} className="checkbox-item">
            <input type="checkbox" checked={builtin.includes(key)} onChange={() => toggleBuiltin(key)} />
            <span>{BUILTIN_LABELS[key] || key}</span>
          </label>
        ))}
      </div>

      {schema.allowCustom && (
        <div style={{ marginTop: 12 }}>
          {custom.map((field, i) => (
            <div
              key={i}
              style={{
                border: "1px solid var(--border, #ddd)",
                borderRadius: 8,
                padding: 12,
                marginBottom: 10,
              }}
            >
              <div style={{ display: "grid", gap: 8 }}>
                <input
                  placeholder="Name shown to you — e.g. Dental number"
                  value={field.label || ""}
                  onChange={(e) => {
                    const label = e.target.value;
                    // Derive the key from the label until someone edits it by
                    // hand; asking an operator to invent a snake_case
                    // identifier is asking them to get it wrong.
                    const autoKey = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
                    patchCustom(i, { label, key: field.keyTouched ? field.key : autoKey });
                  }}
                />
                <input
                  placeholder='How should we ask? — e.g. "And your dental number, the six digits on your card?"'
                  value={field.ask || ""}
                  onChange={(e) => patchCustom(i, { ask: e.target.value })}
                />
                <input
                  placeholder="Expected format (optional) — e.g. ^[0-9]{6}$ for six digits"
                  value={field.pattern || ""}
                  onChange={(e) => patchCustom(i, { pattern: e.target.value })}
                />
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  {canVerify
                    ? "Collected before any change is made. We don't yet check it against your system — that's coming."
                    : "Collected before any change is made. We can't read your system, so we can't check it's correct."}
                </p>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ justifySelf: "start" }}
                  onClick={() => removeCustom(i)}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={addCustom}>
            + Add something else we must ask for
          </button>
        </div>
      )}
    </div>
  );
}

const BUILTIN_LABELS = {
  name: "Full name",
  dob: "Date of birth",
  phone_on_file: "Calling from the number on file",
  phone_last4: "Last 4 digits of the number on file",
  callback_number: "A callback number",
};
