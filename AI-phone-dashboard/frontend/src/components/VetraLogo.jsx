import { Link } from "react-router-dom";
import VetraMark from "./VetraMark";
import "./VetraLogo.css";

export default function VetraLogo({ to = "/", size = 28, className = "" }) {
  const inner = (
    <>
      <VetraMark size={size} className="vetra-logo-mark" />
      <span className="vetra-logo-word">Vetra</span>
    </>
  );

  if (to) {
    return (
      <Link to={to} className={`vetra-logo ${className}`.trim()}>
        {inner}
      </Link>
    );
  }

  return <span className={`vetra-logo ${className}`.trim()}>{inner}</span>;
}
