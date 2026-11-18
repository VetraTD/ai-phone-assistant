import { Building2, Mic, ListChecks, BookOpen, Bell, CreditCard } from "lucide-react";

/**
 * The six settings groups.
 *
 * Layout data only — which panels sit together and what the rail calls them.
 * Deliberately NOT capability data: the Capabilities group knows it renders
 * <CapabilitiesSection>, and nothing here knows a capability exists, let alone
 * which ones. Adding a capability to the engine must still change nothing in
 * the frontend.
 *
 * Rail labels use the conventional settings vocabulary people recognise from
 * other tools. Everything inside a group — captions, descriptions, hints —
 * stays plain language, because that is where an owner is actually deciding
 * something.
 */
export const GROUPS = [
  {
    id: "general",
    label: "General",
    icon: Building2,
    caption: "Name, hours, timezone",
    title: "General",
    description: "Who you are and when you're open. Your receptionist uses this on every call.",
  },
  {
    id: "voice",
    label: "Voice & Language",
    icon: Mic,
    caption: "How it sounds",
    title: "Voice & Language",
    description: "The voice callers hear, what it says first, and which languages it speaks.",
  },
  {
    id: "capabilities",
    label: "Capabilities",
    icon: ListChecks,
    caption: "What it can handle",
    title: "Capabilities",
    description:
      "What your receptionist is allowed to do on a call, and what it must ask for before doing it.",
  },
  {
    id: "knowledge",
    label: "Knowledge Base",
    icon: BookOpen,
    caption: "Answers to questions",
    title: "Knowledge Base",
    description: "Answers your receptionist can give when a caller asks something.",
  },
  {
    id: "notifications",
    label: "Notifications",
    icon: Bell,
    caption: "Email and text alerts",
    title: "Notifications",
    description: "How you hear about calls, and what callers get texted afterwards.",
  },
  {
    id: "billing",
    label: "Billing & Integrations",
    icon: CreditCard,
    caption: "Plan, usage, calendar",
    title: "Billing & Integrations",
    description: "Your plan, how much you've used this month, and connected apps.",
  },
];

export const GROUP_IDS = GROUPS.map((g) => g.id);

export const DEFAULT_GROUP = GROUPS[0].id;
