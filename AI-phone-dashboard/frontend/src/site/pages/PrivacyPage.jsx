import { usePageMeta } from "../usePageMeta.js";
import LegalDocument from "../components/LegalDocument.jsx";
import { PRIVACY } from "../content/legal/privacy.jsx";

export default function PrivacyPage() {
  usePageMeta({
    title: "Privacy Policy",
    description: "What Vetra collects, why, where it is kept and how long, and your rights.",
    path: "/privacy",
  });
  return <LegalDocument doc={PRIVACY} />;
}
