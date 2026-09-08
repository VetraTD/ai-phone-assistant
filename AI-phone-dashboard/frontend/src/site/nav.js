import { NAV_ITEMS } from "./content/siteConfig.js";
import { isAboutReady } from "./content/about.js";

/** Header and menu destinations; About joins once its content is filled in. */
export function visibleNavItems() {
  const aboutReady = isAboutReady();
  return NAV_ITEMS.filter((item) => !item.needsAbout || aboutReady);
}
