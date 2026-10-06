import { useState } from "preact/hooks";
import { api } from "../../api";

// SPA route under a static "/": served from its own copy of the SPA shell (dist/client/app/dashboard/index.html).
export const head = { title: "Dashboard — site" };

export default function Dashboard() {
  const [n, setN] = useState(0);
  const [rpc, setRpc] = useState("");
  const call = async () => setRpc((await (await api.hello.$get()).json()).message);
  return (
    <main>
      <h1 data-testid="h">Dashboard (spa)</h1>
      <button data-testid="inc" onClick={() => setN(n + 1)}>clicked {n}</button>
      <button data-testid="rpc" onClick={call}>rpc</button><span data-testid="rpc-out">{rpc}</span>
    </main>
  );
}
