<script module>
  // SPA route under a static "/": served from its own copy of the SPA shell.
  export const head = { title: "Dashboard — site" };
</script>

<script>
  import { api } from "../../api";
  let n = $state(0);
  let rpc = $state("");
  const call = async () => { rpc = (await (await api.hello.$get()).json()).message; };
</script>

<main>
  <h1 data-testid="h">Dashboard (spa)</h1>
  <button data-testid="inc" onclick={() => n++}>clicked {n}</button>
  <button data-testid="rpc" onclick={call}>rpc</button><span data-testid="rpc-out">{rpc}</span>
</main>
