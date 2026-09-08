import { ChevronDown } from "lucide-react";
import { FAQ } from "../content/faq.js";
import "./FaqList.css";

/** Six questions on a ruled page. Native <details>, so it works without JS. */
export default function FaqList() {
  return (
    <div className="faq site-page site-page--lined">
      {FAQ.map((item) => (
        <details key={item.id} className="faq__item" id={`q-${item.id}`}>
          <summary className="faq__q">
            <span className="faq__qtext">{item.q}</span>
            <ChevronDown className="faq__icon" size={20} strokeWidth={2} aria-hidden="true" />
          </summary>
          <div className="faq__a">
            <p className="faq__atext">{item.a}</p>
          </div>
        </details>
      ))}
    </div>
  );
}
