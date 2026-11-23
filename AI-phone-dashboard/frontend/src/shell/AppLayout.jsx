import SessionGate from "./SessionGate";
import AppShell from "./AppShell";

// The layout route for every signed-in page: sign in first, then the shell
// with the page in its <Outlet/>. One lazy chunk, so the marketing build never
// loads the dashboard.
export default function AppLayout() {
  return (
    <SessionGate>
      <AppShell />
    </SessionGate>
  );
}
