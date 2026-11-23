import { Navigate } from "react-router-dom";
import { useBusiness } from "./BusinessContext";
import { calendarAvailable } from "./nav";

/**
 * The Calendar tab is hidden for a business whose bookings are not in
 * VetraTD's own calendar (spec §8). This makes the address agree: a bookmark or
 * typed /calendar goes to Home instead of an empty page. While the business's
 * actions are still loading it waits rather than guess.
 */
export default function CalendarRoute({ children }) {
  const { definitions, capabilityRows, capabilitiesStatus } = useBusiness();
  if (capabilitiesStatus === "loading") {
    return (
      <p className="vt-page" role="status">
        Loading your calendar…
      </p>
    );
  }
  if (!calendarAvailable(definitions, capabilityRows)) return <Navigate to="/home" replace />;
  return children;
}
