// Shared inline style objects for the settings section components. Textareas
// aren't covered by Dashboard.css's .filter-field input/select rules, so the
// pre-existing settings block in App.jsx styled them inline — this mirrors
// that exact style rather than introducing a new textarea class.
export const textareaStyle = {
  width: "100%",
  padding: 14,
  borderRadius: 12,
  border: "1px solid var(--vetra-border-strong)",
  background: "var(--vetra-bg)",
  color: "var(--vetra-text)",
  outline: "none",
  fontSize: 14,
  resize: "vertical",
  minHeight: 80,
};

export const errorBoxStyle = {
  padding: "12px 14px",
  borderRadius: 12,
  border: "1px solid rgba(220,80,80,0.3)",
  background: "rgba(220,80,80,0.06)",
  color: "#b91c1c",
  fontSize: 13,
};
