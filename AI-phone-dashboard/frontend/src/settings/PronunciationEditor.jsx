import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";

const MAX_NAMES = 10;

// The stored map is { written: "say" } or { written: { say, ipa } }. The ipa is
// set by an operator (it only drives recorded audio), so the editor carries it
// along untouched -- until the owner changes how the name is said, at which
// point it describes the OLD sound and is dropped.
function rowsFromMap(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map).map(([written, v]) => ({
    written,
    say: typeof v === "string" ? v : typeof v?.say === "string" ? v.say : "",
    ipa: v && typeof v === "object" && typeof v.ipa === "string" && v.ipa ? v.ipa : "",
  }));
}

function mapFromRows(rows) {
  const out = {};
  for (const r of rows) {
    const written = r.written.trim();
    const say = r.say.trim();
    if (!written || !say) continue;
    out[written] = r.ipa ? { say, ipa: r.ipa } : say;
  }
  return out;
}

export default function PronunciationEditor({ value, onChange }) {
  const nextId = useRef(0);
  const [rows, setRows] = useState(() => rowsFromMap(value).map((r) => ({ ...r, id: nextId.current++ })));

  const commit = (next) => {
    setRows(next);
    onChange(mapFromRows(next));
  };
  const edit = (id, patch) => commit(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="set-field" role="group" aria-labelledby="set-pron-label">
      <span className="set-label" id="set-pron-label">
        How to say names<span className="set-optional">optional</span>
      </span>

      {rows.map((r) => (
        <div className="set-pron-row" key={r.id}>
          <input
            type="text"
            aria-label="Written as"
            value={r.written}
            maxLength={40}
            placeholder="Digile"
            onChange={(e) => edit(r.id, { written: e.target.value })}
          />
          <span className="set-pron-arrow" aria-hidden="true">
            →
          </span>
          <input
            type="text"
            aria-label="Say it as"
            value={r.say}
            maxLength={60}
            placeholder="Dij-aisle"
            // Changing the sound invalidates the phonetic spelling.
            onChange={(e) => edit(r.id, { say: e.target.value, ipa: "" })}
          />
          <button
            type="button"
            className="set-btn-ghost set-btn-sm set-pron-remove"
            aria-label={r.written.trim() ? `Remove ${r.written.trim()}` : "Remove this name"}
            onClick={() => commit(rows.filter((x) => x.id !== r.id))}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ))}

      <div>
        <button
          type="button"
          className="set-btn set-btn-sm"
          disabled={rows.length >= MAX_NAMES}
          onClick={() => setRows([...rows, { id: nextId.current++, written: "", say: "", ipa: "" }])}
        >
          <Plus size={16} aria-hidden="true" />
          Add a name
        </button>
      </div>

      <p className="set-hint">
        If the receptionist says a name wrong, write it the way it sounds — e.g. Digile → Dij-aisle. Texts, emails
        and your dashboard keep the real spelling.
      </p>
    </div>
  );
}
