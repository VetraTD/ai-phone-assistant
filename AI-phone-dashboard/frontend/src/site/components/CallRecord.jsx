import { CALL_RECORD } from "../content/callRecord.js";
import RuledList from "./RuledList.jsx";

/** The dashboard's record of the call above, as a ruled page. */
export default function CallRecord() {
  return <RuledList rows={CALL_RECORD} labelWidth="6.75rem" />;
}
