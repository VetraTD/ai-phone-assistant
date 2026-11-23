/** "+1 (555) 019-9001" for a North American number, "+44 7700 900123" for a UK one, else as stored. */
export function formatPhone(e164) {
  const v = typeof e164 === "string" ? e164.trim() : "";
  let m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(v);
  if (m) return `+1 (${m[1]}) ${m[2]}-${m[3]}`;
  m = /^\+44(\d{4})(\d{6})$/.exec(v);
  if (m) return `+44 ${m[1]} ${m[2]}`;
  return v;
}
