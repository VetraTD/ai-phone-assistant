import { usePageMeta } from "../usePageMeta.js";
import PageHero from "../components/PageHero.jsx";
import { ABOUT } from "../content/about.js";

// Phase C lays this page out; the owner fills content/about.js.
export default function AboutPage() {
  usePageMeta({ title: "About", description: "Who makes Vetra and how it is run.", path: "/about" });
  return (
    <PageHero title="About Vetra" lead={ABOUT.headline} />
  );
}
