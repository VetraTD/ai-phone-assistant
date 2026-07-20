import SectionCard from "./SectionCard";
import { CORE_TASKS, MODULE_TASKS } from "./constants";

// CORE tasks are always available and are never stored in allowed_tasks —
// rendered as plain badges, not toggleable. MODULE tasks are the opt-in set
// that IS allowed_tasks (see backend constants.js's CORE_TASKS/MODULE_TASKS
// split, and validateAllowedTasks in settingsValidation.js).
export default function TasksSection({ value, onChange }) {
  const allowed = value.allowed_tasks;

  const toggle = (key) => {
    const next = allowed.includes(key) ? allowed.filter((k) => k !== key) : [...allowed, key];
    onChange({ allowed_tasks: next });
  };

  return (
    <SectionCard title="Tasks">
      <div className="filter-field">
        <label>Always on</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {CORE_TASKS.map((task) => (
            <span key={task.key} className="call-pill">
              {task.label} · always on
            </span>
          ))}
        </div>
      </div>

      <div className="filter-field">
        <label>Optional tasks</label>
        <div className="checkbox-list">
          {MODULE_TASKS.map((task) => (
            <label key={task.key} className="checkbox-item">
              <input
                type="checkbox"
                checked={allowed.includes(task.key)}
                onChange={() => toggle(task.key)}
              />
              <span>{task.label}</span>
            </label>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
