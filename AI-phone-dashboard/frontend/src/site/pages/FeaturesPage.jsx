import { usePageMeta } from "../usePageMeta.js";
import PageHero from "../components/PageHero.jsx";

// Phase C fills this page from content/features.js.
export default function FeaturesPage() {
  usePageMeta({
    title: "Features",
    description: "What Vetra does on a call, after a call, and how you control it.",
    path: "/features",
  });
  return (
    <PageHero
      title="What Vetra does"
      lead="On the call, after the call, and the controls you keep. Everything here is running today."
    />
  );
}
