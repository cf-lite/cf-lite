<script>
  import { handleLinkClick } from "cf-lite/client";
  let { to, children, onclick, ...rest } = $props();
  function click(e) {
    onclick?.(e);
    handleLinkClick(e, to, rest.target);
  }
</script>

<a {...rest} href={to} onclick={click}>{@render children?.()}</a>
