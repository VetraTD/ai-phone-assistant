import { useEffect, useState } from "react";
import { Pencil, Plus, TriangleAlert, Trash2 } from "lucide-react";
import { api } from "../api";
import Panel from "./Panel";
import Field from "./Field";

const EMPTY_FORM = { question: "", answer: "", category: "", priority: 0 };

// /api/knowledge CRUD (routes/knowledge.js). Independent of the main
// settings save flow — add/edit/delete/toggle each hit the API immediately,
// same pattern as the dashboard's calendar connect/disconnect actions.
export default function KnowledgeBaseEditor({ businessId, onCountChange }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // null = no form open; "new" = add form; otherwise the id of the row being edited.
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = () => {
    if (!businessId) return;
    setLoading(true);
    setError("");
    api
      .get("/api/knowledge", { params: { businessId } })
      .then((res) => setRows(Array.isArray(res.data) ? res.data : []))
      .catch((err) => setError(err?.response?.data?.error || "Failed to load knowledge base"))
      .finally(() => setLoading(false));
  };

  useEffect(load, [businessId]);

  // Feeds the rail's "8 answers saved" caption.
  useEffect(() => {
    onCountChange?.(rows.length);
  }, [rows.length, onCountChange]);

  const startAdd = () => {
    setEditingId("new");
    setForm(EMPTY_FORM);
    setError("");
  };

  const startEdit = (row) => {
    setEditingId(row.id);
    setForm({
      question: row.question,
      answer: row.answer,
      category: row.category || "",
      priority: row.priority ?? 0,
    });
    setError("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const submitForm = async () => {
    const question = form.question.trim();
    const answer = form.answer.trim();
    if (!question || !answer) return;
    setSaving(true);
    setError("");
    try {
      const payload = {
        question,
        answer,
        category: form.category.trim() || null,
        priority: Number(form.priority) || 0,
      };
      if (editingId === "new") {
        await api.post("/api/knowledge", { businessId, ...payload });
      } else {
        await api.put(`/api/knowledge/${editingId}`, payload);
      }
      cancelEdit();
      load();
    } catch (err) {
      setError(err?.response?.data?.error || "Failed to save entry");
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (row) => {
    const next = !row.enabled;
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled: next } : r)));
    try {
      await api.put(`/api/knowledge/${row.id}`, { enabled: next });
    } catch (err) {
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, enabled: row.enabled } : r)));
      setError(err?.response?.data?.error || "Failed to update entry");
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete "${row.question}"? This can't be undone.`)) return;
    setError("");
    try {
      await api.delete(`/api/knowledge/${row.id}`);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
    } catch (err) {
      setError(err?.response?.data?.error || "Failed to delete entry");
    }
  };

  return (
    <Panel
      title="Answers"
      description="Questions callers ask, and what your receptionist should say back. Each one is saved on its own."
      badge={rows.length ? <span className="set-pill">{rows.length} saved</span> : null}
      actions={
        !editingId ? (
          <button type="button" className="set-btn set-btn-sm" onClick={startAdd}>
            <Plus size={15} aria-hidden="true" />
            Add Q&amp;A
          </button>
        ) : null
      }
    >
      {error ? (
        <p className="set-alert set-alert-error" role="alert">
          <TriangleAlert className="set-alert-icon" size={16} aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}

      {editingId ? (
        <div className="set-subcard">
          <Field label="Question a caller might ask">
            {(p) => (
              <input
                {...p}
                value={form.question}
                maxLength={500}
                onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
                placeholder="e.g. Do you offer free estimates?"
              />
            )}
          </Field>

          <Field label="What we should say">
            {(p) => (
              <textarea
                {...p}
                value={form.answer}
                maxLength={2000}
                rows={3}
                onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))}
                placeholder="e.g. Yes, estimates are free for all first-time customers."
              />
            )}
          </Field>

          <Field label="Group it under" optional hint="Only for your own sorting — callers never hear this.">
            {(p) => (
              <input
                {...p}
                value={form.category}
                maxLength={120}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                placeholder="e.g. Pricing"
              />
            )}
          </Field>

          <Field label="Priority" hint="Higher numbers are offered first when two answers could both fit.">
            {(p) => (
              <input
                {...p}
                type="number"
                min={0}
                max={100}
                step="1"
                value={form.priority}
                onChange={(e) => {
                  const raw = e.target.value;
                  const priority = raw === "" ? "" : Math.trunc(Number(raw));
                  setForm((f) => ({ ...f, priority }));
                }}
              />
            )}
          </Field>

          <div className="set-row">
            <button
              type="button"
              className="set-btn-primary set-btn-sm"
              disabled={saving || !form.question.trim() || !form.answer.trim()}
              onClick={submitForm}
            >
              {saving ? "Saving…" : editingId === "new" ? "Add entry" : "Save entry"}
            </button>
            <button type="button" className="set-btn set-btn-sm" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="set-stack">
        {loading ? (
          <p className="set-hint">Loading…</p>
        ) : !rows.length ? (
          <p className="set-empty">
            Nothing here yet. Add the questions you get asked most — opening times, prices, parking.
          </p>
        ) : (
          rows.map((row) => (
            <div key={row.id} className="set-subcard" style={{ opacity: row.enabled ? 1 : 0.6 }}>
              <div className="set-row-between">
                <strong style={{ fontSize: 14 }}>{row.question}</strong>
                <span className="set-row" style={{ gap: 6 }}>
                  {row.category ? <span className="set-tag">{row.category}</span> : null}
                  <span className="set-tag">Priority {row.priority}</span>
                </span>
              </div>

              <p className="set-hint" style={{ maxWidth: "none" }}>
                {row.answer}
              </p>

              <div className="set-row">
                <label className="set-check" style={{ minHeight: 0, padding: 0 }}>
                  <input type="checkbox" checked={!!row.enabled} onChange={() => toggleEnabled(row)} />
                  <span className="set-check-text">Enabled</span>
                </label>
                <button type="button" className="set-btn set-btn-sm" onClick={() => startEdit(row)}>
                  <Pencil size={14} aria-hidden="true" />
                  Edit
                </button>
                <button type="button" className="set-btn-danger set-btn-sm" onClick={() => remove(row)}>
                  <Trash2 size={14} aria-hidden="true" />
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
