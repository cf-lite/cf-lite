<script lang="ts">
export const head = { title: "Settings — site", meta: [{ name: "description", content: "settings" }] };
</script>
<script setup lang="ts">
defineProps<{ params?: Record<string, string> }>();
</script>

<template><main><h1 data-testid="h">Settings (spa)</h1></main></template>
