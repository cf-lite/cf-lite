import { useEffect, useState } from "react";
import { Link } from "@cf-lite/react/client";
import { api } from "../api";

// SPA page (default): shipped as client JS, served by static assets, Worker never runs for it.
export default function Home() {
  const [msg, setMsg] = useState("…");
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    api.hello.$get({ query: { name: "cf-lite" } }).then((r) => r.json()).then((j) => setMsg(j.message));
  }, []);
  const join = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/room/lobby`);
    ws.onmessage = (e) => setLog((l) => [...l, e.data]);
    ws.onopen = () => ws.send("hello from the browser");
  };
  return (
    <main>
      <h1>cf-lite demo</h1>
      <p data-testid="api-msg">{msg}</p>
      <nav>
        <Link to="/about">about (static)</Link> · <Link to="/posts/42">post 42 (ssr)</Link> · <Link to="/counter">counter (spa)</Link> · <a href="/go/example">/go/example (static redirect)</a>
      </nav>
      <button onClick={join}>join room (Durable Object WebSocket)</button>
      <pre data-testid="ws-log">{log.join("\n")}</pre>
    </main>
  );
}
