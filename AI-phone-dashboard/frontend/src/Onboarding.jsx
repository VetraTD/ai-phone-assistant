import { useState } from "react";
import {api} from "./api";
import "./Onboarding.css";

export default function Onboarding({ onComplete }) {
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("America/Chicago");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const createBusiness = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await api.post("/api/onboarding/create-business", {
        name,
        timezone,
      });

      if (onComplete) onComplete();
    } catch (err) {
      setError(err?.response?.data?.error || "Failed to create business");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="onboarding-page">
      <div className="onboarding-shell">
        <form className="onboarding-card" onSubmit={createBusiness}>
          <div className="onboarding-badge">Business setup</div>

          <div className="onboarding-header">
            <h1>Create your business</h1>
            <p>
              Set up your workspace so you can start tracking calls,
              appointments, and follow-ups from your dashboard.
            </p>
          </div>

          <div className="onboarding-form">
            <div className="onboarding-field">
              <label htmlFor="business-name">Business name</label>
              <input
                id="business-name"
                type="text"
                placeholder="e.g. Excel Cardiac Care"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="onboarding-field">
              <label htmlFor="timezone">Timezone</label>
              <select
                id="timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                <option value="America/Chicago">America/Chicago</option>
                <option value="America/New_York">America/New_York</option>
                <option value="America/Los_Angeles">America/Los_Angeles</option>
                <option value="Europe/London">Europe/London</option>
              </select>
            </div>

            {error ? <div className="onboarding-error">{error}</div> : null}

            <button className="onboarding-button" disabled={loading}>
              {loading ? "Creating business..." : "Create Business"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}