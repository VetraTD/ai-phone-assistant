import { useState } from "react";
import { Link } from "react-router-dom";
// Aliased. The form handler below is also called `signIn`, and an unaliased
// import is SHADOWED by it — the handler then calls itself with the submit
// event as the email argument. Vite built it, the tests passed, and the only
// symptom was a button stuck on "Signing in...".
import { signIn as signInWithPassword, sendPasswordReset } from "./auth";
import VetraLogo from "./components/VetraLogo";
import "./site/styles/tokens.css";
import "./site/styles/base.css";
import "./Login.css";
import { MARKETING_URL } from "./siteUrl";

export default function Login() {
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

    const { error } = await signInWithPassword(email, password);

    setLoading(false);

    if (error) {
      setError(error);
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

    // Where the person lands AFTER the reset, not where the reset happens —
    // Identity Platform issues a one-shot code rather than a recovery session,
    // so the link goes to the action handler and only then here. The domain must
    // be in Identity Platform's authorized_domains or the link is refused.
    const continueUrl =
      typeof window !== "undefined"
        ? `${window.location.origin}/reset-password`
        : "http://localhost:5173/reset-password";

    const { error } = await sendPasswordReset(email, { continueUrl });

    setResetLoading(false);

    if (error) {
      setError(error);
    } else {
      // The same sentence whether or not that address has an account. Saying
      // "no such user" would turn this form into a way to enumerate staff.
      setMessage("If that email has an account, a reset link is on its way.");
      setPassword("");
    }
  };

  return (
    <div className="login-page site-root">
      <div className="login-shell">
        <div className="login-top-row">
          {/* External. This origin is the app now; its root is the dashboard. */}
          <VetraLogo href={MARKETING_URL} />
          <a href={MARKETING_URL} className="login-back-home">
            Back to vetratd.com
          </a>
        </div>

        <div className="login-brand">
          <h1>Your calls, in writing.</h1>
          <p>
            Sign in to read the summary and transcript of every call, and the appointments the
            receptionist has booked into your diary.
          </p>
          <ul className="login-features site-page site-page--lined">
            <li className="login-feature">Every call summarised and transcribed</li>
            <li className="login-feature">Bookings written into your diary</li>
            <li className="login-feature">Messages and callbacks to return</li>
          </ul>
        </div>

        <div className="login-card-wrap">
          <form className="login-card" onSubmit={signIn}>
            <div className="login-card-header">
              <h2>Sign in</h2>
              <p>Your dashboard: calls, bookings and messages.</p>
            </div>

            <div className="login-form">
              <div className="login-field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  required
                />
              </div>

              <div className="login-field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete="current-password"
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

              {error ? <div className="login-error" role="alert">{error}</div> : null}
              {message ? <div className="login-success" role="status">{message}</div> : null}

              <button className="login-button" disabled={loading}>
                {loading ? "Signing in..." : "Sign in"}
              </button>

              <p className="login-security-note">
                You are signed out automatically after a period of inactivity.
              </p>

              {/*
                NO SELF-SERVE SIGN-UP, and this is a safety gate rather than a
                missing feature.

                Creating an account calls app_create_business_for_user, which
                makes a NEW EMPTY business and binds the account to it. There is
                no join-an-existing-business path: app_attach_user_to_business is
                granted to nobody and is operator-only, because taking a business
                id as an argument would make it a tenant-hopping primitive on a
                request path.

                So a customer who signs up before their configuration is imported
                binds themselves to an empty business, and attaching them to the
                real one then fails with "already belongs to a business". The only
                recovery is deleting their account. Onboarding is done with them,
                by hand, and the front door should say so.

                Signup.jsx and Onboarding.jsx are intact and still tested — this
                is the route being closed, not the code being deleted. It reopens
                the day there is an invite or claim token to attach against.
              */}
              <div className="login-footer">
                <span>Don&apos;t have an account yet?</span>
                <Link to="/contact" className="login-link">
                  Request access
                </Link>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
