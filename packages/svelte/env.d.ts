declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<any>;
  export default component;
}
declare module "@cf-lite/svelte/Link.svelte" {
  import type { Component } from "svelte";
  import type { LinkTo } from "cf-lite/href";
  /** `to` is typed from the generated route table (`string` until a table exists); `prefetch` is not supported by the Svelte Link. */
  const Link: Component<{ to: LinkTo; [k: string]: any }>;
  export default Link;
}
