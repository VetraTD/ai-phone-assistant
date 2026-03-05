import { useState } from "react";
import { supabase } from "./supabaseClient";

export default function Signup({ onSwitchToLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const handleSignup = async (e) => {
    e.preventDefault();
    setError("");
    setSuccessMsg("");
    setLoading(true);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    // If email confirmations are ON, Supabase will return no session
    const hasSession = !!data?.session;

    if (hasSession) {
      // ✅ user is signed in immediately → App.jsx will take over (onboarding/dashboard)
      setSuccessMsg("Account created — signing you in…");
    } else {
      // ✅ user must confirm email first
      setSuccessMsg("Account created — check your email to confirm, then sign in.");
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <form
        onSubmit={handleSignup}
        style={{
          width: 360,
          border: "1px solid #333",
          padding: 20,
          borderRadius: 12,
          background: "#0f0f0f",
          color: "white",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Sign up</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            type="email"
            required
            style={{
              padding: 10,
              borderRadius: 8,
              border: "1px solid #444",
              background: "#111",
              color: "white",
            }}
          />

          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            type="password"
            required
            style={{
              padding: 10,
              borderRadius: 8,
              border: "1px solid #444",
              background: "#111",
              color: "white",
            }}
          />

          <button
            disabled={loading}
            style={{
              padding: 10,
              borderRadius: 8,
              border: "1px solid #444",
              background: "#111",
              color: "white",
              cursor: "pointer",
            }}
          >
            {loading ? "Creating..." : "Create account"}
          </button>

          {error ? <div style={{ color: "tomato", fontSize: 13 }}>{error}</div> : null}
          {successMsg ? <div style={{ color: "#9be59b", fontSize: 13 }}>{successMsg}</div> : null}

          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 8 }}>
            Already have an account?{" "}
            <button
              type="button"
              onClick={onSwitchToLogin}
              style={{
                background: "transparent",
                border: "none",
                color: "white",
                textDecoration: "underline",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Sign in
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}