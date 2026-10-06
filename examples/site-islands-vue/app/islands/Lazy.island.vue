<script lang="ts">
export const client = "visible";
</script>
<script setup lang="ts">
import { ref } from "vue";
defineProps<{ id: string }>();
const n = ref(0);
</script>

<template><button :data-testid="'visible-' + id" @click="n++">visible {{ id }}: {{ n }}</button></template>
