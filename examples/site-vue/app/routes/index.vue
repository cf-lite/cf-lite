<script lang="ts">
// Static "/" beside SPA routes: prerendered, zero JS.
export const render = "static";
export const head = { title: "Home — site", meta: [{ name: "description", content: "static home" }] };
</script>
<script setup lang="ts">
defineProps<{ params?: Record<string, string> }>();
</script>

<template><main><h1 data-testid="h">Home (static)</h1></main></template>
