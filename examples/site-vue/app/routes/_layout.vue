<script lang="ts">
export const head = { meta: [{ name: "description", content: "site default" }] };
</script>
<script setup lang="ts">
import { Link } from "@cf-lite/vue/client";
defineProps<{ params?: Record<string, string> }>();
</script>

<template>
  <div data-testid="l-root">
    <nav>
      <Link to="/">home</Link> · <Link to="/about">about</Link> · <Link to="/app/dashboard">dashboard</Link> · <Link to="/app/settings">settings</Link> · <Link to="/blog/hello">blog</Link>
    </nav>
    <slot />
  </div>
</template>
