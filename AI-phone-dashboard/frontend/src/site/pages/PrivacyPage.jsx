import { usePageMeta } from "../usePageMeta.js";
import PageHero from "../components/PageHero.jsx";

// Phase D renders the full document via LegalDocument.
export default function PrivacyPage() {
  usePageMeta({ title: "Privacy Policy", description: "How Vetra handles data.", path: "/privacy" });
  return <PageHero title="Privacy Policy" />;
}
