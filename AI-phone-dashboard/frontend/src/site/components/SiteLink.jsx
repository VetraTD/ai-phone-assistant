import { Link } from "react-router-dom";
import { isLocalPath, siteHref } from "../siteLinks.js";

/**
 * A link to a public-site page that does the right thing on both builds:
 * a router <Link> when the page is served here, a plain <a> when it is not.
 */
export default function SiteLink({ to, children, ...rest }) {
  if (isLocalPath(to)) {
    return (
      <Link to={to} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={siteHref(to)} {...rest}>
      {children}
    </a>
  );
}
