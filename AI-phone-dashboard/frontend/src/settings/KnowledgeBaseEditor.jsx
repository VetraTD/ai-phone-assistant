import { useEffect, useState } from "react";
import { api } from "../api";
import SectionCard from "./SectionCard";
import { textareaStyle, errorBoxStyle } from "./styles";

const EMPTY_FORM = { question: "", answer: "", category: "", priority: 0 };

// /api/knowledge CRUD (routes/knowledge.js). Independent of the main
// settings save flow — add/edit/delete/toggle each hit the API immediately,
// same pattern as the dashboard's calendar connect/disconnect actions.
export default function KnowledgeBaseEditor({ businessId }) {
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
    <SectionCard
      title="Knowledge base"
      description="Question-and-answer pairs your receptionist can draw on during calls (hours, pricing, policies, etc.)."
      action={
        !editingId ? (
          <button type="button" className="reset-button" onClick={startAdd}>
            + Add Q&amp;A
          </button>
        ) : null
      }
      fullWidth
    >
      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {editingId ? (
        <div className="sub-card" style={{ display: "grid", gap: 12 }}>
          <div className="filter-field">
            <label>Question</label>
            <input
              value={form.question}
              maxLength={500}
              onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
              placeholder="e.g. Do you offer free estimates?"
            />
          </div>
          <div className="filter-field">
            <label>Answer</label>
            <textarea
              value={form.answer}
              maxLength={2000}
              rows={3}
              style={textareaStyle}
              onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))}
              placeholder="e.g. Yes, estimates are free for all first-time customers."
            />
          </div>
          <div className="filter-row-2">
            <div className="filter-field">
              <label>Category (optional)</label>
              <input
                value={form.category}
                maxLength={120}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                placeholder="e.g. Pricing"
              />
            </div>
            <div className="filter-field">
              <label>Priority</label>
              <input
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
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              className="dashboard-logout"
              disabled={saving || !form.question.trim() || !form.answer.trim()}
              onClick={submitForm}
            >
              {saving ? "Saving…" : editingId === "new" ? "Add entry" : "Save entry"}
            </button>
            <button type="button" className="reset-button" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="sub-card-stack">
        {loading ? (
          <div className="empty-note">Loading…</div>
        ) : !rows.length ? (
          <div className="empty-note">No knowledge base entries yet.</div>
        ) : (
          rows.map((row) => (
            <div key={row.id} className="sub-card" style={{ opacity: row.enabled ? 1 : 0.55 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div className="sub-card-title">{row.question}</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {row.category ? <span className="call-pill">{row.category}</span> : null}
                  <span className="call-pill">Priority {row.priority}</span>
                </div>
              </div>
              <div className="detail-block-text">{row.answer}</div>
              <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                <label className="checkbox-item" style={{ fontSize: 13 }}>
                  <input type="checkbox" checked={!!row.enabled} onChange={() => toggleEnabled(row)} />
                  <span>Enabled</span>
                </label>
                <button type="button" className="reset-button" onClick={() => startEdit(row)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="reset-button"
                  style={{ borderColor: "rgba(220,80,80,0.4)", color: "#b91c1c" }}
                  onClick={() => remove(row)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </SectionCard>
  );
}
