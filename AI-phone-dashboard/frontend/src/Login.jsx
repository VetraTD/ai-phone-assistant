import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "./supabaseClient";
import VetraMark from "./components/VetraMark";
import "./Login.css";

export default function Login({ onSwitchToSignup }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const signIn = async (e) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setError(error.message);
    }
  };

  const handleForgotPassword = async () => {
    setError("");
    setMessage("");

    if (!email) {
      setError("Enter your email first.");
      return;
    }

    setResetLoading(true);

    const redirectTo =
      typeof window !== "undefined"
        ? `${window.location.origin}/reset-password`
        : "http://localhost:5173/reset-password";

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    setResetLoading(false);

    if (error) {
      setError(error.message);
    } else {
      setMessage("Check your email for a password reset link.");
      setPassword("");
    }
  };

  return (
    <div className="login-page">
      <div className="login-shell">
        <div className="login-top-row">
          <Link to="/" className="login-back-home">
            ← Back to website
          </Link>
        </div>
        <div className="login-brand">
          <div className="login-badge">
            <VetraMark size={18} className="login-badge-mark" />
            Welcome back
          </div>

          <h1>Your calls, handled — even when you&apos;re not there.</h1>

          <p>
            Sign in to see every call, booking, and follow-up in one simple dashboard.
            We keep things organised so you can focus on running your business.
          </p>

          <div className="login-features">
            <div className="login-feature">
              <span className="login-feature-dot" />
              <span>Written summary of every call</span>
            </div>

            <div className="login-feature">
              <span className="login-feature-dot" />
              <span>Bookings and messages in one place</span>
            </div>

            <div className="login-feature">
              <span className="login-feature-dot" />
              <span>Follow-ups flagged so nothing gets missed</span>
            </div>
          </div>
        </div>

        <div className="login-card-wrap">
          <form className="login-card" onSubmit={signIn}>
            <div className="login-card-header">
              <h2>Sign in</h2>
              <p>Access your dashboard and manage your business calls.</p>
            </div>

            <div className="login-form">
              <div className="login-field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  type="email"
                  required
                />
              </div>

              <div className="login-field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  type="password"
                  required
                />
              </div>

              <div className="login-forgot-row">
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  className="login-link"
                  disabled={resetLoading}
                >
                  {resetLoading ? "Sending..." : "Forgot password?"}
                </button>
              </div>

              {error ? <div className="login-error">{error}</div> : null}
              {message ? <div className="login-success">{message}</div> : null}

              <button className="login-button" disabled={loading}>
                {loading ? "Signing in..." : "Sign in"}
              </button>

              <p className="login-security-note">
                Your account is protected with secure sign-in and encrypted storage.
              </p>

              <div className="login-footer">
                <span>Need an account?</span>
                <button
                  type="button"
                  onClick={onSwitchToSignup}
                  className="login-link"
                >
                  Sign up
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
