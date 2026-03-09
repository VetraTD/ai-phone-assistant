import { useState } from "react";
import { supabase } from "./supabaseClient";

export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const handleUpdatePassword = async (e) => {
    e.preventDefault();
    setError("");
    setMessage("");

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setLoading(true);

    const { error } = await supabase.auth.updateUser({
      password,
    });

    setLoading(false);

    if (error) {
      setError(error.message);
    } else {
      setMessage("Password updated successfully. You can now sign in.");
      setPassword("");
      setConfirmPassword("");
    }
  };

  return (
    <div className="login-page">
      <div className="login-shell">
        <div className="login-card-wrap">
          <form className="login-card" onSubmit={handleUpdatePassword}>
            <div className="login-card-header">
              <h2>Reset password</h2>
              <p>Enter your new password below.</p>
            </div>

            <div className="login-form">
              <div className="login-field">
                <label htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter new password"
                  required
                />
              </div>

              <div className="login-field">
                <label htmlFor="confirm-password">Confirm password</label>
                <input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm new password"
                  required
                />
              </div>

              {error ? <div className="login-error">{error}</div> : null}
              {message ? <div className="login-success">{message}</div> : null}

              <button className="login-button" disabled={loading}>
                {loading ? "Updating..." : "Update password"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}