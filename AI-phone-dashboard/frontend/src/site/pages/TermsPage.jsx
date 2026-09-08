import { usePageMeta } from "../usePageMeta.js";
import PageHero from "../components/PageHero.jsx";

// Phase D renders the full document via LegalDocument.
export default function TermsPage() {
  usePageMeta({ title: "Terms of Service", description: "The terms on which Vetra is provided.", path: "/terms" });
  return <PageHero title="Terms of Service" />;
}
