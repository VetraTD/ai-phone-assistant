import { Link } from "react-router-dom";
import VetraMark from "./VetraMark";
import "./VetraLogo.css";

/**
 * @param {object}  props
 * @param {string}  [props.to]    in-app route. Ignored when `href` is given.
 * @param {string}  [props.href]  EXTERNAL destination, rendered as a plain <a>.
 *                                Needed since the dashboard took the root:
 *                                the public pages' logo points at the marketing
 *                                site, which is a different codebase on a
 *                                different host, and <Link> would try to route
 *                                to it inside this SPA.
 */
export default function VetraLogo({ to = "/", href = null, size = 28, className = "" }) {
  const inner = (
    <>
      <VetraMark size={size} className="vetra-logo-mark" />
      <span className="vetra-logo-word">Vetra</span>
    </>
  );

  if (href) {
    return (
      <a href={href} className={`vetra-logo ${className}`.trim()}>
        {inner}
      </a>
    );
  }

  if (to) {
    return (
      <Link to={to} className={`vetra-logo ${className}`.trim()}>
        {inner}
      </Link>
    );
  }

  return <span className={`vetra-logo ${className}`.trim()}>{inner}</span>;
}
