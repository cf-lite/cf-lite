<script lang="ts">
export const render = "static";
export const head = { title: "Plain" };
</script>
<script setup lang="ts">
defineProps<{ params?: Record<string, string> }>();
</script>

<template><main><h1>Plain</h1><p>no islands here: zero JS</p></main></template>
