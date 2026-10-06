import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineAdapter } from "cf-lite/adapter";

/** `cfLite({ renderer: svelte() })` - Svelte 5 routes (`.svelte`). Route config (`render`, `head`, `loader`) goes in `<script module>`. */
export default function svelteAdapter() {
  return defineAdapter({
    id: "@cf-lite/svelte",
    extensions: [".svelte"],
    client: "@cf-lite/svelte/client",
    server: "@cf-lite/svelte/server",
    vite: () => ({ plugins: [svelte()], config: { resolve: { dedupe: ["svelte"] } } }),
  });
}
export { svelteAdapter as svelte };
