<script setup lang="ts">
defineProps<{ params?: Record<string, string> }>();
</script>

<template><section data-testid="l-app"><aside>app shell</aside><slot /></section></template>
