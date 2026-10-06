<script lang="ts">
export const client = "interaction";
</script>
<script setup lang="ts">
import { ref } from "vue";
const open = ref(false);
</script>

<template>
  <div>
    <button data-testid="menu-btn" @click="open = !open">menu</button>
    <ul v-if="open" data-testid="menu-list"><li>one</li><li>two</li></ul>
  </div>
</template>
