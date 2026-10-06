<script lang="ts">
// SSR page (streamed by Vue's renderToWebStream): island props come from the loader.
export const render = "ssr";
export const loader = async (c: { req: { query(k: string): string | undefined } }) => ({ name: c.req.query("name") ?? "world", start: 5 });
</script>
<script setup lang="ts">
import Counter from "../islands/Counter.island.vue";
import Echo from "../islands/Echo.island.vue";
defineProps<{ params?: Record<string, string>; data: { name: string; start: number } }>();
</script>

<template>
  <main>
    <h1>Live {{ data.name }}</h1>
    <Counter :start="data.start" />
    <Echo :msg="data.name" :items="[]" />
  </main>
</template>
