<script module>
  export const head = { meta: [{ name: "description", content: "site default" }] };
</script>

<script>
  import Link from "@cf-lite/svelte/Link.svelte";
  let { children } = $props();
</script>

<div data-testid="l-root">
  <nav>
    <Link to="/">home</Link> · <Link to="/about">about</Link> · <Link to="/app/dashboard">dashboard</Link> · <Link to="/app/settings">settings</Link> · <Link to="/blog/hello">blog</Link>
  </nav>
  {@render children?.()}
</div>
