<script lang="ts">
export const render = "static";
export const head = { title: "About — site" };
</script>
<script setup lang="ts">
defineProps<{ params?: Record<string, string> }>();
</script>

<template><main><h1 data-testid="h">About (static)</h1></main></template>
