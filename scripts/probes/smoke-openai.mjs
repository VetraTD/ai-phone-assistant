import fs from "fs";
import WebSocket from "ws";

const key = fs.readFileSync(".env", "utf8")
  .split("\n").find(l => l.startsWith("OPENAI_API_KEY="))
  .slice("OPENAI_API_KEY=".length).trim().replace(/^["']|["']$/g, "");

const model = process.argv[2];
const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
  headers: { Authorization: `Bearer ${key}` },
});

const done = (msg, code) => { console.log(`${model}: ${msg}`); try { ws.close(); } catch {} process.exit(code); };
const timer = setTimeout(() => done("TIMEOUT after 15s", 1), 15000);

ws.on("open", () => console.log(`${model}: socket OPEN`));
ws.on("message", (raw) => {
  const evt = JSON.parse(raw.toString());
  if (evt.type === "session.created") { clearTimeout(timer); done(`OK — session.created, id=${evt.session?.id?.slice(0,12)}...`, 0); }
  if (evt.type === "error") { clearTimeout(timer); done(`ERROR — ${evt.error?.code}: ${evt.error?.message}`, 1); }
});
ws.on("unexpected-response", (_req, res) => {
  let body = ""; res.on("data", d => body += d);
  res.on("end", () => { clearTimeout(timer); done(`HTTP ${res.statusCode} — ${body.slice(0,300)}`, 1); });
});
ws.on("error", (e) => { clearTimeout(timer); done(`SOCKET ERR — ${e.message}`, 1); });
