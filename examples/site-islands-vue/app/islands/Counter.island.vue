<script setup lang="ts">
import { ref } from "vue";
// default strategy: "load" - hydrate as soon as the island runtime has loaded
const props = withDefaults(defineProps<{ start?: number; label?: string }>(), { start: 0, label: "count" });
const n = ref(props.start);
</script>

<template><button data-testid="counter" @click="n++">{{ label }}: {{ n }}</button></template>
