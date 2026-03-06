import { useState } from "react";
import { supabase } from "./supabaseClient";
import "./Signup.css";

export default function Signup({ onSwitchToLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const signUp = async (e) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    const { error } = await supabase.auth.signUp({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    setMessage("Account created. You can now continue with setup.");
  };

  return (
    <div className="signup-page">
      <div className="signup-shell">
        <div className="signup-brand">
          <div className="signup-badge">AI Call Dashboard</div>

          <h1>Get your business calls organised from day one.</h1>

          <p>
            Create your account, connect your business, and start turning calls
            into appointments, follow-ups, and clear customer insights.
          </p>

          <div className="signup-features">
            <div className="signup-feature">
              <span className="signup-feature-dot" />
              <span>Capture appointments automatically</span>
            </div>

            <div className="signup-feature">
              <span className="signup-feature-dot" />
              <span>Track transcripts and customer requests</span>
            </div>

            <div className="signup-feature">
              <span className="signup-feature-dot" />
              <span>Manage everything from one dashboard</span>
            </div>
          </div>
        </div>

        <div className="signup-card-wrap">
          <form className="signup-card" onSubmit={signUp}>
            <div className="signup-card-header">
              <h2>Create account</h2>
              <p>Set up your dashboard and start managing business calls.</p>
            </div>

            <div className="signup-form">
              <div className="signup-field">
                <label htmlFor="signup-email">Email</label>
                <input
                  id="signup-email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="signup-field">
                <label htmlFor="signup-password">Password</label>
                <input
                  id="signup-password"
                  type="password"
                  placeholder="Create a secure password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>

              {error ? <div className="signup-error">{error}</div> : null}
              {message ? <div className="signup-success">{message}</div> : null}

              <button className="signup-button" disabled={loading}>
                {loading ? "Creating account..." : "Create account"}
              </button>

              <div className="signup-footer">
                <span>Already have an account?</span>
                <button
                  type="button"
                  onClick={onSwitchToLogin}
                  className="signup-link"
                >
                  Sign in
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}