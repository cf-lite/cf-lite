<script lang="ts">
export const client = "idle";
</script>
<script setup lang="ts">
import { ref } from "vue";
const on = ref(false);
</script>

<template><button data-testid="idle" @click="on = !on">idle {{ on ? "on" : "off" }}</button></template>
