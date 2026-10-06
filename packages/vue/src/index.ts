import vue from "@vitejs/plugin-vue";
import { defineAdapter } from "cf-lite/adapter";

/** `cfLite({ renderer: vue() })` - Vue 3.5 single-file-component routes. Route config (`render`, `head`, `loader`) goes in a plain `<script lang="ts">` block. */
export default function vueAdapter() {
  return defineAdapter({
    id: "@cf-lite/vue",
    extensions: [".vue"],
    client: "@cf-lite/vue/client",
    server: "@cf-lite/vue/server",
    islands: { wrap: "@cf-lite/vue/islands", mount: "@cf-lite/vue/islands-client" },
    vite: () => ({ plugins: [vue()] }),
  });
}
export { vueAdapter as vue };
