import { useState } from "react";
import { supabase } from "./supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const signIn = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    setLoading(false);

    if (error) setError(error.message);
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <form
        onSubmit={signIn}
        style={{
          width: 360,
          border: "1px solid #333",
          padding: 20,
          borderRadius: 12,
          background: "#0f0f0f",
        }}
      >
        <h2 style={{ marginTop: 0 }}>Sign in</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            type="email"
            required
            style={{ padding: 10, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white" }}
          />

          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            type="password"
            required
            style={{ padding: 10, borderRadius: 8, border: "1px solid #444", background: "#111", color: "white" }}
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
            {loading ? "Signing in..." : "Sign in"}
          </button>

          {error ? <div style={{ color: "tomato", fontSize: 13 }}>{error}</div> : null}
        </div>
      </form>
    </div>
  );
}