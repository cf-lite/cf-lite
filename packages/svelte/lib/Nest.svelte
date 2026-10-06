<!-- Recursive layout composition: <L0><L1><Page/></L1></L0>. A dynamic component keeps its instance while its constructor is unchanged. -->
<script>
  import Nest from "./Nest.svelte";
  let { layouts, Page, params, data } = $props();
  const L = $derived(layouts[0]);
  const rest = $derived(layouts.slice(1));
</script>

{#if L}
  <L {params}><Nest layouts={rest} {Page} {params} {data} /></L>
{:else}
  <Page {params} {data} />
{/if}
