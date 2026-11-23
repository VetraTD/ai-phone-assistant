import { createContext, useContext } from "react";

/**
 * The signed-in business and what it has switched on, loaded once by
 * SessionGate after /api/me and shared by every page in the shell.
 *
 *   business, businessId, setBusiness   the /api/me business row
 *   definitions                         GET /api/capabilities/definitions (null until loaded or if it failed)
 *   capabilityRows                      GET /api/business/:id/capabilities, the `capabilities` array
 *   capabilitiesStatus                  "loading" | "ready" | "error" for the two above
 *   reloadCapabilities()                fetch both again
 *   openCount, setOpenCount             calls that need the owner, shown on Home in the navigation
 */
export const BusinessContext = createContext(null);

export function useBusiness() {
  const value = useContext(BusinessContext);
  if (!value) throw new Error("useBusiness() must be used inside <SessionGate>");
  return value;
}
