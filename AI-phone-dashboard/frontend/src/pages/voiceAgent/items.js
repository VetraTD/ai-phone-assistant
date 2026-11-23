// The Voice agent tab's list (spec §8): what the agent says, what it knows,
// and what it can do. The first two are fixed; Actions comes from the voice
// engine's pack definitions, so a new action appears here with no code.

export const VOICE_ITEMS = [
  { id: "greeting", label: "Greeting" },
  { id: "tone", label: "Tone of voice" },
  { id: "rules", label: "House rules" },
  { id: "voice", label: "Voice" },
  { id: "languages", label: "Languages" },
  { id: "notice", label: "Call notice" },
];

export const INFO_ITEMS = [
  { id: "details", label: "Business details" },
  { id: "hours", label: "Opening hours" },
  { id: "closed", label: "When you're closed" },
  { id: "answers", label: "Questions and answers" },
];

/**
 * The actions an inbound business is shown: never a pack marked "hidden"
 * (outbound calling, texts), an "optIn" pack only where the business has it
 * switched on, always-on packs first. Read from pack properties, never ids.
 */
export function listedCapabilities(definitions, capabilityRows) {
  const rows = new Map((capabilityRows || []).map((r) => [r.capability_id, r]));
  return (definitions?.capabilities || [])
    .filter((def) => {
      const listing = def.dashboardListing || "listed";
      if (listing === "hidden") return false;
      // On, or set up once (so switching it off does not make it vanish
      // with no way to switch it back on).
      if (listing === "optIn") return rows.get(def.id)?.enabled === true || rows.get(def.id)?.configured === true;
      return true;
    })
    .sort((a, b) => Number(!!b.core) - Number(!!a.core));
}

/** The three sections, with Actions built from the business's packs. */
export function buildSections(definitions, capabilityRows) {
  return [
    { id: "voice", label: "Voice & greeting", items: VOICE_ITEMS },
    { id: "info", label: "Business info", items: INFO_ITEMS },
    {
      id: "actions",
      label: "Actions",
      items: listedCapabilities(definitions, capabilityRows).map((def) => ({ id: def.id, label: def.label, def })),
    },
  ];
}

export const DEFAULT_SECTION = "voice";
export const DEFAULT_ITEM = "greeting";
