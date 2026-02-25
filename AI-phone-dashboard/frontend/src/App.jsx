import { useEffect, useState } from "react";
import axios from "axios";

function App() {
  const [calls, setCalls] = useState([]);
  const [selectedCallId, setSelectedCallId] = useState(null);
  const [callDetails, setCallDetails] = useState(null);

  // Load calls list
  useEffect(() => {
    axios
      .get(
        `${import.meta.env.VITE_API_URL}/api/calls?business_id=33ac8c19-a73b-4d5e-9b92-d6f949d5e4ab`
      )
      .then((res) => setCalls(res.data))
      .catch((err) => console.error(err));
  }, []);

  // Load one call + transcript + appointments
  const loadCallDetails = (id) => {
    setSelectedCallId(id);

    axios
      .get(`${import.meta.env.VITE_API_URL}/api/calls/${id}`)
      .then((res) => setCallDetails(res.data))
      .catch((err) => console.error(err));
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Top bar */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid #333",
          fontSize: 28,
          fontWeight: 800,
        }}
      >
        AI Call Dashboard
      </div>

      {/* Main split layout */}
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "420px 1fr",
          gap: 16,
          padding: 16,
          overflow: "hidden",
        }}
      >
        {/* LEFT: Calls list */}
        <div
          style={{
            border: "1px solid #333",
            borderRadius: 10,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div
            style={{
              padding: 12,
              borderBottom: "1px solid #333",
              fontWeight: 700,
            }}
          >
            Calls
          </div>

          <div style={{ padding: 12, overflowY: "auto", minHeight: 0 }}>
            {calls.map((call) => (
              <div
                key={call.id}
                onClick={() => loadCallDetails(call.id)}
                style={{
                  border:
                    selectedCallId === call.id
                      ? "2px solid white"
                      : "1px solid #444",
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 10,
                  cursor: "pointer",
                  background:
                    selectedCallId === call.id ? "#151515" : "transparent",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 6 }}>
                  {call.caller_number}
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: 12,
                    fontSize: 13,
                    opacity: 0.9,
                  }}
                >
                  <span>
                    <b>Status:</b> {call.status}
                  </span>
                  <span>
                    <b>Dur:</b> {call.duration_seconds ?? "-"}s
                  </span>
                </div>

                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                  {call.started_at ? new Date(call.started_at).toLocaleString() : ""}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT: Details */}
        <div
          style={{
            border: "1px solid #333",
            borderRadius: 10,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div
            style={{
              padding: 12,
              borderBottom: "1px solid #333",
              fontWeight: 700,
            }}
          >
            Call Details
          </div>

          {/* IMPORTANT: no overflow here; transcript will be the scroll area */}
          <div
            style={{
              padding: 16,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              overflow: "hidden",
            }}
          >
            {!callDetails ? (
              <div style={{ opacity: 0.7 }}>
                Select a call on the left to view transcript + appointments.
              </div>
            ) : (
              <>
                {/* Call Info (fixed) */}
                <div
                  style={{
                    border: "1px solid #444",
                    borderRadius: 10,
                    padding: 14,
                    flex: "0 0 auto",
                  }}
                >
                  <div style={{ fontWeight: 800, marginBottom: 10 }}>Call Info</div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "140px 1fr",
                      rowGap: 6,
                    }}
                  >
                    <div style={{ opacity: 0.7 }}>Status</div>
                    <div>{callDetails.call.status}</div>

                    <div style={{ opacity: 0.7 }}>Duration</div>
                    <div>{callDetails.call.duration_seconds ?? "-"} sec</div>

                    <div style={{ opacity: 0.7 }}>Started</div>
                    <div>
                      {callDetails.call.started_at
                        ? new Date(callDetails.call.started_at).toLocaleString()
                        : "-"}
                    </div>

                    <div style={{ opacity: 0.7 }}>Summary</div>
                    <div>{callDetails.call.summary ?? "No summary yet"}</div>

                    <div style={{ opacity: 0.7 }}>Sentiment</div>
                    <div>{callDetails.call.sentiment ?? "Unknown"}</div>
                  </div>
                </div>

                {/* Transcript header */}
                <div style={{ fontWeight: 800, flex: "0 0 auto" }}>Transcript</div>

                {/* Transcript (scrollable area that takes remaining space) */}
                <div
                  style={{
                    border: "1px solid #444",
                    borderRadius: 10,
                    padding: 12,
                    minHeight: 0,
                    flex: "1 1 auto",
                    overflowY: "auto",
                  }}
                >
                  {callDetails.transcript?.length ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {callDetails.transcript.map((line) => (
                        <div
                          key={line.id}
                          style={{
                            display: "flex",
                            justifyContent:
                              line.speaker === "ai" ? "flex-start" : "flex-end",
                          }}
                        >
                          <div
                            style={{
                              maxWidth: "70%",
                              padding: 10,
                              borderRadius: 12,
                              border: "1px solid #444",
                              background: line.speaker === "ai" ? "#141414" : "#1b2a3a",
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            <div
                              style={{
                                fontSize: 12,
                                opacity: 0.7,
                                marginBottom: 4,
                              }}
                            >
                              {line.speaker}
                            </div>
                            {line.message}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ opacity: 0.7 }}>No transcript found.</div>
                  )}
                </div>

                {/* Appointments (fixed at bottom, no scroll) */}
                <div style={{ fontWeight: 800, flex: "0 0 auto" }}>Appointments</div>

                <div style={{ flex: "0 0 auto" }}>
                  {callDetails.appointments?.length ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {callDetails.appointments.map((appt) => (
                        <div
                          key={appt.id}
                          style={{
                            border: "1px solid #444",
                            borderRadius: 10,
                            padding: 12,
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: 6 }}>
                            {appt.client_name} — {appt.client_phone}
                          </div>

                          <div style={{ fontSize: 13, opacity: 0.85 }}>
                            <b>Scheduled:</b>{" "}
                            {appt.scheduled_at
                              ? new Date(appt.scheduled_at).toLocaleString()
                              : "-"}
                          </div>

                          <div style={{ fontSize: 13, opacity: 0.85 }}>
                            <b>Status:</b> {appt.status}
                          </div>

                          {appt.notes ? (
                            <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                              <b>Notes:</b> {appt.notes}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ opacity: 0.7 }}>
                      No appointments linked to this call.
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;