<script setup lang="ts">
// shows what arrived as props (the page passes hostile text on purpose: it travels in an attribute, never as markup)
defineProps<{ msg: string; items: string[] }>();
</script>

<template><p data-testid="echo">{{ msg }} | {{ items.join(",") }}</p></template>
