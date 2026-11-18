/**
 * Did this socket end, or did it drop?
 *
 * A close with no event is CLEAN, deliberately. The vendor closes without a
 * code after a finished call, and counting that as a fault would put the
 * abnormal rate at 100% and make the number useless on its first reading.
 *
 * @param {{ code?: number, reason?: string }|undefined} e
 * @returns {"clean"|"abnormal"}
 */
export function classifyClose(e) {
  const code = e?.code;
  if (code === undefined || code === null) return "clean";
  return code === 1000 || code === 1005 ? "clean" : "abnormal";
}
