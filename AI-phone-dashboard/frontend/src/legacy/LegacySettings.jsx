import { useEffect, useState } from "react";
import { api } from "../api";
import { signOut } from "../auth";
import { useBusiness } from "../shell/BusinessContext";
import SettingsPage from "../settings/SettingsPage";
import "../Dashboard.css";

// Hosts the existing settings page inside the new shell. The new navigation has
// no sign-out yet, so a plain button sits below it. Part 2 replaces this.
export default function LegacySettings() {
  const { business, businessId, setBusiness } = useBusiness();
  const [usage, setUsage] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState(null);

  useEffect(() => {
    if (!businessId) return;
    // Moved unchanged from App.jsx; part 2 rebuilds this page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUsageLoading(true); setUsageError(null);
    api.get("/api/usage")
      .then((res) => { setUsage(res.data); })
      .catch((err) => { setUsageError(err?.response?.data?.error || "Failed to load usage"); setUsage(null); })
      .finally(() => { setUsageLoading(false); });
  }, [businessId]);

  return (
    <>
      <SettingsPage
        business={business}
        businessId={businessId}
        onBusinessUpdate={(updated) => setBusiness((prev) => ({ ...(prev || {}), ...updated }))}
        onDirtyChange={() => {}}
        usage={usage}
        usageLoading={usageLoading}
        usageError={usageError}
      />
      <button type="button" className="vt-btn vt-btn-quiet" onClick={() => signOut()}>
        Sign out
      </button>
    </>
  );
}
