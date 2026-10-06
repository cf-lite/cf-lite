<script setup lang="ts">
defineProps<{ params?: Record<string, string> }>();
</script>

<template><article data-testid="l-blog"><slot /></article></template>
