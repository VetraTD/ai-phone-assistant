import { usePageMeta } from "../usePageMeta.js";
import LegalDocument from "../components/LegalDocument.jsx";
import { TERMS } from "../content/legal/terms.jsx";

export default function TermsPage() {
  usePageMeta({
    title: "Terms of Service",
    description: "The terms on which Vetra provides its receptionist service to businesses.",
    path: "/terms",
  });
  return <LegalDocument doc={TERMS} />;
}
