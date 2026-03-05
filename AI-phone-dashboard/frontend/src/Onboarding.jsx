import { useState } from "react";
import { api } from "./api";

export default function Onboarding({ onComplete }) {
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("America/Chicago");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await api.post("/api/onboarding/create-business", { name, timezone });
      onComplete(res.data.business);
    } catch (err) {
      setError(err?.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <form onSubmit={submit} style={{ width: 360, border: "1px solid #333", padding: 20, borderRadius: 12 }}>
        <h2>Create your business</h2>

        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Business name" required />
        <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Timezone" required />

        <button disabled={loading} type="submit">
          {loading ? "Creating..." : "Create Business"}
        </button>

        {error ? <div style={{ color: "tomato", marginTop: 10 }}>{error}</div> : null}
      </form>
    </div>
  );
}