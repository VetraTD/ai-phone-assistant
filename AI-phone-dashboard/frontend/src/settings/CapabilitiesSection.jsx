import { useEffect, useMemo, useState } from "react";
import { CircleCheck, Plus, TriangleAlert, Trash2 } from "lucide-react";
import { api } from "../api";
import Panel from "./Panel";
import Field, { CheckField } from "./Field";
import ChoiceCards from "./ChoiceCards";

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
 * The redesign kept that strictly. Every branch below reads the SHAPE of a
 * schema — does it declare an adapter, how many options does that adapter have,
 * is the pack core, does it declare identity requirements — and never a
 * capability's id. There is no id→icon map, no id→copy map, no id ordering
 * array, because each of those would silently become a file you have to edit
 * every time the engine grows.
 *
 * Saves are per capability rather than one bulk submit, so a validation error
 * in one card cannot discard edits made in another.
 *
 * `extras` is the one place the page may inject markup into a specific card
 * (transfer policy lives with the transfer capability — see SettingsPage). The
 * lookup here stays generic; the coupling lives in the caller, where deciding
 * what sits next to what is already the job.
 */
export default function CapabilitiesSection({ businessId, onCountsChange, onEnabledChange, extras }) {
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

  // Feeds the rail's "5 of 7 turned on" caption, and keeps the page's
  // enabled-map live so other groups (After-hours, Notifications) react the
  // moment a capability is toggled here. Derived, never stored.
  useEffect(() => {
    if (!defs) return;
    const total = defs.capabilities.length;
    const enabledMap = {};
    for (const def of defs.capabilities) enabledMap[def.id] = def.core || !!rows[def.id]?.enabled;
    const on = defs.capabilities.filter((def) => enabledMap[def.id]).length;
    onCountsChange?.({ on, total });
    onEnabledChange?.(enabledMap);
  }, [defs, rows, onCountsChange, onEnabledChange]);

  // Always-on capabilities first, then the rest in the order the engine
  // declared them. Deliberately NOT re-sorted by enabled state: a card that
  // jumps up the page the moment you switch it on is a card you lose.
  const ordered = useMemo(() => {
    if (!defs) return [];
    return [...defs.capabilities].sort((a, b) => Number(!!b.core) - Number(!!a.core));
  }, [defs]);

  if (loadError) {
    return (
      <Panel title="Capabilities">
        <p className="set-alert set-alert-error" role="alert">
          <TriangleAlert className="set-alert-icon" size={16} aria-hidden="true" />
          <span>{loadError}</span>
        </p>
      </Panel>
    );
  }

  if (!defs) {
    return (
      <Panel title="Capabilities">
        <p className="set-hint">Loading…</p>
      </Panel>
    );
  }

  return (
    <>
      {ordered.map((def) => (
        <CapabilityCard
          key={def.id}
          def={def}
          adapters={defs.adapters}
          row={rows[def.id]}
          businessId={businessId}
          extra={extras?.[def.id]}
          onSaved={(saved) =>
            setRows((prev) => ({ ...prev, [def.id]: { ...prev[def.id], ...saved, configured: true } }))
          }
        />
      ))}
    </>
  );
}

function draftFromRow(row, def) {
  return {
    enabled: row?.enabled ?? def.core,
    adapter: row?.adapter ?? def.configSchema?.adapter?.default ?? null,
    config: row?.config ?? {},
  };
}

function CapabilityCard({ def, adapters, row, businessId, extra, onSaved }) {
  const [draft, setDraft] = useState(() => draftFromRow(row, def));
  // What is currently on the server, so the Save button can be honest about
  // whether there is anything to send. Previously every card's Save was
  // enabled at all times, which made "did I save this one?" unanswerable.
  const [baseline, setBaseline] = useState(() => JSON.stringify(draftFromRow(row, def)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!row) return;
    const next = draftFromRow(row, def);
    setDraft(next);
    setBaseline(JSON.stringify(next));
  }, [row, def]);

  // A saved confirmation that never goes away stops meaning anything.
  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), 4000);
    return () => clearTimeout(timer);
  }, [saved]);

  const patchConfig = (patch) => {
    setSaved(false);
    setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
  };
  const patchRequire = (patch) => {
    setSaved(false);
    setDraft((d) => ({ ...d, config: { ...d.config, require: { ...(d.config.require || {}), ...patch } } }));
  };
  const patchAvailability = (patch) => {
    setSaved(false);
    setDraft((d) => ({
      ...d,
      config: { ...d.config, availability: { ...(d.config.availability || {}), ...patch } },
    }));
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
      setBaseline(JSON.stringify(draft));
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
  const dirty = JSON.stringify(draft) !== baseline;

  // What this business's chosen backend can actually prove a caller against.
  // Used below to explain, honestly, why a custom field can only be collected.
  const adapterList = def.adapterKind ? adapters[def.adapterKind] || [] : [];
  const chosenAdapter = adapterList.find((a) => a.id === draft.adapter);
  const canVerify = (chosenAdapter?.verifiableFields || []).length > 0;

  // Which adapters the dashboard is allowed to OFFER, as opposed to which the
  // engine will accept. An adapter with selfServe:false (athenahealth, the
  // webhook stub) stays a valid saved value but is never a picker option —
  // shape-driven on the adapter's own flag, never on which capability this is.
  const selfServeOptions = (schema.adapter?.options || []).filter(
    (id) => (adapterList.find((a) => a.id === id)?.selfServe) !== false
  );
  // A caller already on an owner-managed adapter (e.g. a clinic on athena)
  // gets an honest read-only note instead of a picker that omits their choice.
  const onHiddenAdapter = draft.adapter && !selfServeOptions.includes(draft.adapter) ? chosenAdapter : null;

  // Is there anything on this card the owner can change? A core capability
  // with no configSchema — always on, nothing to configure — has nothing to
  // save, and a Save button that PUTs an unchanged row is a button that
  // teaches people their clicks do not matter.
  const hasOwnControls = !def.core || Boolean(def.configSchema);

  return (
    <Panel
      title={def.label}
      description={def.description || undefined}
      muted={off}
      badge={
        // A caller-supplied badge (e.g. transfer, whose real state is a page
        // setting, not the row's enabled flag) wins. The renderer only asks
        // "is there an override for this id?" — it never reads which id it is.
        extra?.badge ? (
          extra.badge
        ) : def.core ? (
          <span className="set-pill set-pill-locked">Always on</span>
        ) : draft.enabled ? (
          <span className="set-pill set-pill-on">On</span>
        ) : (
          <span className="set-pill">Off</span>
        )
      }
      footer={
        hasOwnControls ? (
          <>
            <button type="button" className="set-btn-primary set-btn-sm" disabled={saving || !dirty} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
            {dirty && !saving ? <span className="set-status set-status-dirty">Not saved yet</span> : null}
            {saved ? (
              <span className="set-saved-flag" role="status">
                <CircleCheck size={15} aria-hidden="true" />
                Saved
              </span>
            ) : null}
          </>
        ) : null
      }
    >
      {!def.core && (
        <CheckField
          checked={draft.enabled}
          onChange={(enabled) => {
            setSaved(false);
            setDraft((d) => ({ ...d, enabled }));
          }}
        >
          Turn this on for my business
        </CheckField>
      )}

      {!off && (
        <>
          {/* A picker only when there is a real self-serve choice. With one
              (or zero) offerable adapters the choice is implicit — showing a
              lone radio card is noise. Shape-driven, never keyed on capability. */}
          {schema.adapter && selfServeOptions.length > 1 && (
            <AdapterPicker
              schema={schema.adapter}
              options={selfServeOptions}
              adapterList={adapterList}
              value={draft.adapter}
              onChange={(adapter) => {
                setSaved(false);
                setDraft((d) => ({ ...d, adapter }));
              }}
              chosenAdapter={chosenAdapter}
              canVerify={canVerify}
            />
          )}

          {onHiddenAdapter && (
            <p className="set-hint">
              Appointments route to <strong>{onHiddenAdapter.label}</strong>, set up outside the dashboard.
            </p>
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
            <CheckField
              checked={!!require.confirmBeforeWrite}
              onChange={(v) => patchRequire({ confirmBeforeWrite: v })}
            >
              {requireSchema.confirmBeforeWrite.label}
            </CheckField>
          )}

          {requireSchema.businessHoursOnly && (
            <CheckField checked={!!require.businessHoursOnly} onChange={(v) => patchRequire({ businessHoursOnly: v })}>
              {requireSchema.businessHoursOnly.label}
            </CheckField>
          )}

          {/* Availability only applies to the built-in calendar; an external
              backend (athena) owns its own free/busy, so hide it there. */}
          {schema.availability && (draft.adapter === "internal" || !draft.adapter) && (
            <AvailabilityEditor
              schema={schema.availability}
              value={draft.config.availability || {}}
              onChange={patchAvailability}
            />
          )}

          {schema.notes && (
            <Field
              label={schema.notes.label}
              optional
              hint="Guidance, not a rule — your receptionist follows this closely but it isn't enforced. Anything that must always happen belongs in the checkboxes above."
            >
              {(p) => (
                <textarea
                  {...p}
                  rows={3}
                  value={draft.config.notes || ""}
                  placeholder={schema.notes.placeholder}
                  onChange={(e) => patchConfig({ notes: e.target.value })}
                />
              )}
            </Field>
          )}

          {extra?.node}
        </>
      )}

      {error ? (
        <p className="set-alert set-alert-error" role="alert">
          <TriangleAlert className="set-alert-icon" size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * Where a capability's work actually happens.
 *
 * Cards when the schema declares a handful of options, a plain select beyond
 * that — a rule about the schema's shape, not about which capability this is.
 * Each option needs a sentence to be choosable at all ("Send to my own system"
 * means nothing without "we can't read it back"), and a <select> has nowhere
 * to put one.
 */
function AdapterPicker({ schema, options, adapterList, value, onChange, chosenAdapter, canVerify }) {
  // `options` is the dashboard-offerable subset (self-serve only); fall back to
  // the schema's full list if a caller didn't pre-filter.
  const offered = options || schema.options;
  const verifiable = (chosenAdapter?.verifiableFields || []).filter((f) => !f.includes("*"));
  const honesty = canVerify
    ? `We can check a caller against: ${verifiable.join(", ")}.`
    : "We can't read this system, so anything you ask for below is written down but never checked against a record.";

  if (offered.length > 3) {
    return (
      <Field label={schema.label} hint={honesty}>
        {(p) => (
          <select {...p} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
            {offered.map((id) => (
              <option key={id} value={id}>
                {adapterList.find((a) => a.id === id)?.label || id}
              </option>
            ))}
          </select>
        )}
      </Field>
    );
  }

  return (
    <div className="set-field">
      <ChoiceCards
        legend={schema.label}
        options={offered.map((id) => {
          const adapter = adapterList.find((a) => a.id === id);
          const fields = (adapter?.verifiableFields || []).filter((f) => !f.includes("*"));
          return {
            value: id,
            title: adapter?.label || id,
            desc: fields.length ? `We can check ${fields.join(", ")}.` : "We can't read this one back.",
          };
        })}
        value={value ?? ""}
        onChange={(next) => onChange(next || null)}
      />
      <p className="set-hint">{honesty}</p>
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
 *
 * Every input here used to be placeholder-only — four unlabelled boxes whose
 * only explanation vanished the moment you started typing. They are labelled
 * now, with the old placeholder text kept as the example it always was.
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
    <div className="set-field">
      <fieldset className="set-fieldset">
        <legend className="set-legend">{schema.label}</legend>
        <div className="set-checklist">
          {(schema.builtinOptions || []).map((key) => (
            <label key={key} className="set-check">
              <input type="checkbox" checked={builtin.includes(key)} onChange={() => toggleBuiltin(key)} />
              <span className="set-check-text">{BUILTIN_LABELS[key] || key}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {schema.allowCustom && (
        <div className="set-stack" style={{ marginTop: 12 }}>
          {custom.map((field, i) => (
            <CustomIdentityField
              key={i}
              field={field}
              canVerify={canVerify}
              onPatch={(patch) => patchCustom(i, patch)}
              onRemove={() => removeCustom(i)}
            />
          ))}
          <button type="button" className="set-btn-ghost" style={{ justifySelf: "start" }} onClick={addCustom}>
            <Plus size={16} aria-hidden="true" />
            Add something else we must ask for
          </button>
        </div>
      )}
    </div>
  );
}

function CustomIdentityField({ field, canVerify, onPatch, onRemove }) {
  // Purely local: a place to check that a format actually matches the sort of
  // thing callers will say, before it becomes a rule the receptionist enforces
  // on a real call. Nothing here is saved or validated against.
  const [sample, setSample] = useState("");

  const pattern = field.pattern || "";
  let patternError = "";
  let sampleMatches = null;
  if (pattern) {
    try {
      const re = new RegExp(pattern);
      if (sample) sampleMatches = re.test(sample);
    } catch {
      patternError = "This isn't a valid format. Check the brackets and slashes.";
    }
  }

  return (
    <div className="set-subcard">
      <Field label="What you call it" hint="Shown to you, not read out to callers.">
        {(p) => (
          <input
            {...p}
            value={field.label || ""}
            placeholder="e.g. Dental number"
            onChange={(e) => {
              const label = e.target.value;
              // Derive the key from the label until someone edits it by
              // hand; asking an operator to invent a snake_case
              // identifier is asking them to get it wrong.
              const autoKey = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
              onPatch({ label, key: field.keyTouched ? field.key : autoKey });
            }}
          />
        )}
      </Field>

      <Field label="How we ask for it" hint="Your own words. This is spoken to the caller exactly as written.">
        {(p) => (
          <input
            {...p}
            value={field.ask || ""}
            placeholder='e.g. "And your dental number, the six digits on your card?"'
            onChange={(e) => onPatch({ ask: e.target.value })}
          />
        )}
      </Field>

      <Field
        label="Expected format"
        optional
        error={patternError}
        hint="Leave blank to accept anything. ^[0-9]{6}$ means exactly six digits."
      >
        {(p) => (
          <input
            {...p}
            value={pattern}
            placeholder="^[0-9]{6}$"
            onChange={(e) => onPatch({ pattern: e.target.value })}
          />
        )}
      </Field>

      {pattern && !patternError ? (
        <Field label="Try a value" hint="Just to check the format does what you expect. Nothing is saved.">
          {(p) => (
            <>
              <input {...p} value={sample} placeholder="Type an example" onChange={(e) => setSample(e.target.value)} />
              {sample ? (
                <p className={sampleMatches ? "set-saved-flag" : "set-field-error"} style={{ marginTop: 6 }}>
                  {sampleMatches ? "✓ That would be accepted" : "✕ That would be rejected"}
                </p>
              ) : null}
            </>
          )}
        </Field>
      ) : null}

      <p className="set-hint">
        {canVerify
          ? "Collected before any change is made. We don't yet check it against your system — that's coming."
          : "Collected before any change is made. We can't read your system, so we can't check it's correct."}
      </p>

      <button type="button" className="set-btn-danger set-btn-sm" style={{ justifySelf: "start" }} onClick={onRemove}>
        <Trash2 size={15} aria-hidden="true" />
        Remove
      </button>
    </div>
  );
}

/**
 * Availability: the two numbers that define a slot on the built-in calendar —
 * appointment length and how many bookings can share a time. There is no on/off
 * switch: the receptionist always checks the calendar before booking. These just
 * say what "free" means.
 */
function AvailabilityEditor({ schema, value, onChange }) {
  const numberField = (key) => {
    const f = schema[key] || {};
    return (
      <Field key={key} label={f.label}>
        {(p) => (
          <input
            {...p}
            type="number"
            min={f.min}
            max={f.max}
            step={f.step || 1}
            value={value[key] ?? f.default ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              onChange({ [key]: raw === "" ? undefined : Number(raw) });
            }}
          />
        )}
      </Field>
    );
  };

  return (
    <div className="set-field">
      <p className="set-hint">
        Your receptionist checks the calendar before booking and never double-books. These set how
        long an appointment is and how many can share the same time.
      </p>
      {numberField("length")}
      {numberField("capacity")}
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
