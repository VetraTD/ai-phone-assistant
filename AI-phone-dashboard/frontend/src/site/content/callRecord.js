// What the dashboard keeps for the demo call above. Outcome, caller,
// appointment, transcript and the alert are exactly what the product stores
// and sends; the summary line is an example of the kind of summary the
// receptionist writes, and the page says so.

export const CALL_RECORD = [
  { label: "Outcome", value: "Booked" },
  { label: "Caller", value: "Nathan Smith, on the number they called from." },
  { label: "Booked", value: "Friday 5 June, 14:00. General GP consultation, 30 minutes." },
  {
    label: "Summary",
    value:
      "Asked what the general consultation covers and what it costs, then booked the first afternoon slot. Told the cancellation terms and what to bring.",
  },
  { label: "Transcript", value: "Kept in full. The call itself is not recorded." },
  { label: "Alert", value: "Emailed to you with a link to this record. No caller details in the email." },
];
