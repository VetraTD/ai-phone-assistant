import { DEMO_NUMBER } from "../content/siteConfig.js";

/**
 * The demo line, when there is one. DEMO_NUMBER is null today, so this renders
 * nothing anywhere it is placed; setting the constant brings every call link
 * back at once.
 */
export default function DemoNumberLink({ className = "", children }) {
  if (!DEMO_NUMBER) return null;
  const tel = DEMO_NUMBER.replace(/[^\d+]/g, "");
  return (
    <a className={className} href={`tel:${tel}`}>
      {children || DEMO_NUMBER}
    </a>
  );
}
