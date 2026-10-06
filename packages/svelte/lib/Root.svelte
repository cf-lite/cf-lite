<!-- Server: `view` is static. Client: `router` is subscribed and `view` follows it. -->
<script>
  import { onMount } from "svelte";
  import Nest from "./Nest.svelte";
  let { router = null, view: initial = null } = $props();
  // svelte-ignore state_referenced_locally
  let view = $state.raw(initial ?? router.current);
  onMount(() => router?.subscribe((v) => (view = v)));
</script>

{#if view.Page}
  <Nest layouts={view.layouts} Page={view.Page} params={view.params} data={view.data} />
{:else}
  <h1>404</h1>
{/if}
