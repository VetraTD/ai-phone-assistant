import { HomeIcon, InboxIcon, CalendarIcon, AgentIcon, SettingsIcon } from "./icons";

/**
 * Whether this business gets a Calendar tab: bookings are on, and they land in
 * VetraTD's own calendar rather than an outside system such as athenahealth.
 * Read from the pack and adapter properties, never from an id.
 *
 * @param {{ capabilities?: Array, adapters?: Record<string, Array> } | null} definitions
 * @param {Array<{ capability_id: string, enabled: boolean, adapter: string|null }>} capabilityRows
 */
export function calendarAvailable(definitions, capabilityRows) {
  const pack = definitions?.capabilities?.find((d) => d.adapterKind === "scheduling");
  if (!pack) return false;
  const row = (capabilityRows || []).find((r) => r.capability_id === pack.id);
  if (!row?.enabled) return false;
  // No backend chosen: the pack's own declared default (its configSchema).
  const adapterId = row.adapter || pack.configSchema?.adapter?.default;
  const adapter = (definitions.adapters?.[pack.adapterKind] || []).find((a) => a.id === adapterId);
  return adapter?.storesBookingsLocally === true;
}

/**
 * The navigation, in order. `short` is the label on the phone's bottom bar,
 * where five items must fit across.
 */
export function navItems({ calendarAvailable: withCalendar }) {
  return [
    { to: "/home", label: "Home", short: "Home", Icon: HomeIcon },
    { to: "/inbox", label: "Inbox", short: "Inbox", Icon: InboxIcon },
    ...(withCalendar ? [{ to: "/calendar", label: "Calendar", short: "Calendar", Icon: CalendarIcon }] : []),
    { to: "/voice-agent", label: "Voice agent", short: "Agent", Icon: AgentIcon },
    { to: "/settings", label: "Settings", short: "Settings", Icon: SettingsIcon },
  ];
}
