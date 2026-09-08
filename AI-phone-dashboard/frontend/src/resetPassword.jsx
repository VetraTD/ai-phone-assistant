import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { checkPasswordResetCode, completePasswordReset } from "./auth";
import "./site/styles/tokens.css";
import "./site/styles/base.css";
import "./Login.css";
import { MARKETING_URL } from "./siteUrl";

// ---------------------------------------------------------------------------
// Setting a new password from a reset link.
//
// THE FLOW CHANGED SHAPE AT B3, and this file is where that shows. Supabase's
// reset link SIGNED THE PERSON IN with a recovery session, and this page then
// called `updateUser({ password })` on the strength of being logged in.
// Identity Platform issues a one-shot `oobCode` instead: it is exchanged for a
// password change and never becomes a session.
//
// That is the better shape, not merely a different one — a reset link that logs
// you in is a full session handed to anyone who can read the mailbox, and it
// stays a session whether or not a password is ever set. Here the code is spent
// or it expires.
//
// WHERE THE LINK GOES TODAY: Identity Platform's own hosted action handler,
// which collects the new password and then sends the person to the
// `continueUrl` Login.jsx passed — this page, with no code in the URL. So the
// no-code branch below is the ORDINARY path right now, not an error case, and
// it says "your password is set, sign in" rather than showing a dead form.
//
// The code branch is live the moment somebody points Identity Platform's email
// template at this route instead, which is a console/API setting Terraform's
// `google_identity_platform_config` does not carry. Built now because the page
// exists either way and a half-working reset is discovered by a locked-out
// receptionist.
// ---------------------------------------------------------------------------

/** Identity Platform puts the one-shot code in the query string as `oobCode`. */
function readResetCode() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("mode") && params.get("mode") !== "resetPassword") return null;
  return params.get("oobCode");
}

export default function ResetPassword() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [code] = useState(readResetCode);
  // null = still checking, true/false = answered. Three states, because
  // rendering the form while the code is unverified is how somebody types a
  // password twice into a link that expired yesterday.
  //
  // Seeded from `code` rather than set inside the effect: with no code there is
  // nothing to check, and answering that in the effect body is a second render
  // for a fact already known at mount.
  const [codeValid, setCodeValid] = useState(() => (readResetCode() ? null : false));
  const [codeEmail, setCodeEmail] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (!code) return undefined;
    checkPasswordResetCode(code).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setCodeValid(false);
        setError(result.error);
      } else {
        setCodeValid(true);
        setCodeEmail(result.email || "");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

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

    const result = await completePasswordReset(code, password);

    if (result.error) {
      setLoading(false);
      setError(result.error);
      return;
    }

    setMessage("Password updated successfully. Redirecting to sign in...");
    setPassword("");
    setConfirmPassword("");
    setLoading(false);

    // No sign-in here. Identity Platform invalidates existing sessions on a
    // password change, and using the new password once is the confirmation that
    // it took.
    setTimeout(() => {
      window.location.href = "/";
    }, 1200);
  };

  const shell = (children) => (
    <div className="login-page site-root">
      <div className="login-shell">
        <div className="login-top-row">
          <a href={MARKETING_URL} className="login-back-home">
            ← Back to website
          </a>
        </div>
        <div className="login-card-wrap">{children}</div>
      </div>
    </div>
  );

  if (codeValid === null) {
    return shell(
      <div className="login-card">
        <div className="login-card-header">
          <h2>Reset password</h2>
          <p>Checking your reset link…</p>
        </div>
      </div>
    );
  }

  if (codeValid === false) {
    return shell(
      <div className="login-card">
        <div className="login-card-header">
          <h2>Reset password</h2>
          <p>
            {code
              ? "This reset link cannot be used."
              : "If you have just set a new password, you can sign in with it now."}
          </p>
        </div>
        <div className="login-form">
          {error ? <div className="login-error">{error}</div> : null}
          <Link to="/" className="login-button" style={{ textAlign: "center", display: "block" }}>
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return shell(
    <form className="login-card" onSubmit={handleUpdatePassword}>
      <div className="login-card-header">
        <h2>Reset password</h2>
        <p>{codeEmail ? `Choose a new password for ${codeEmail}.` : "Enter your new password below."}</p>
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
  );
}
