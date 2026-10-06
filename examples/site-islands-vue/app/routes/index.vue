<script lang="ts">
// Static page, no whole-page hydration: the only JS is the island runtime, and only because islands are on the page.
export const render = "static";
export const head = { title: "Islands (vue)" };
</script>
<script setup lang="ts">
import Counter from "../islands/Counter.island.vue";
import Idle from "../islands/Idle.island.vue";
import Lazy from "../islands/Lazy.island.vue";
import Menu from "../islands/Menu.island.vue";
import Echo from "../islands/Echo.island.vue";
defineProps<{ params?: Record<string, string> }>();
const hostile = '<\/script><img src=x onerror="window.__xss=1">&"<'; // (an SFC cannot contain a literal closing script tag)
</script>

<template>
  <main>
    <h1>Islands (vue)</h1>
    <Counter :start="2" label="clicks" />
    <Idle />
    <Menu />
    <Echo :msg="hostile" :items="['a', 'b']" />
    <div style="height: 3000px" data-testid="spacer">scroll</div>
    <Lazy id="low" />
  </main>
</template>
