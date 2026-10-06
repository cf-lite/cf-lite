<script lang="ts">
// SPA route under a static "/": served from its own copy of the SPA shell.
export const head = { title: "Dashboard — site" };
</script>
<script setup lang="ts">
import { ref } from "vue";
import { api } from "../../api";
defineProps<{ params?: Record<string, string> }>();
const n = ref(0);
const rpc = ref("");
const call = async () => { rpc.value = (await (await api.hello.$get()).json()).message; };
</script>

<template>
  <main>
    <h1 data-testid="h">Dashboard (spa)</h1>
    <button data-testid="inc" @click="n++">clicked {{ n }}</button>
    <button data-testid="rpc" @click="call">rpc</button><span data-testid="rpc-out">{{ rpc }}</span>
  </main>
</template>
