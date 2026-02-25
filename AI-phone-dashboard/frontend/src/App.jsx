import { useEffect, useState } from "react";
import axios from "axios";

function App() {

  const [calls, setCalls] = useState([]);

  useEffect(() => {

    axios.get(
      `${import.meta.env.VITE_API_URL}/api/calls?business_id=99f5862f-8e88-4336-93e4-3f5f85fec7da`
    )
    .then(res => {
      setCalls(res.data);
    })
    .catch(err => {
      console.error(err);
    });

  }, []);

  return (
    <div style={{ padding: 20 }}>

      <h1>AI Phone Dashboard</h1>

      {calls.map(call => (

        <div key={call.id}
        style={{
          border:"1px solid gray",
          padding:10,
          marginBottom:10
        }}
        >

          <div><b>Caller:</b> {call.caller_number}</div>

          <div><b>Status:</b> {call.status}</div>

          <div><b>Duration:</b> {call.duration_seconds}</div>

        </div>

      ))}

    </div>
  );
}

export default App;