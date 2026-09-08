import { Link } from "react-router-dom";

/**
 * The site's one button family. Renders a router <Link> for `to`, a plain
 * <a> for `href` (off-origin destinations), otherwise a <button>.
 */
export default function SiteButton({
  to,
  href,
  onClick,
  variant = "primary",
  className = "",
  children,
  ...rest
}) {
  const cls = `site-btn site-btn--${variant} ${className}`.trim();
  if (to) {
    return (
      <Link to={to} className={cls} onClick={onClick} {...rest}>
        {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={cls} onClick={onClick} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick} {...rest}>
      {children}
    </button>
  );
}
