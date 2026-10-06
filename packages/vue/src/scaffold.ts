import type { AdapterScaffold } from "cf-lite/adapter";

export const scaffold: AdapterScaffold = {
  deps: { vue: "^3.5.43" },
  entry: {
    file: "app/main.ts",
    content: `import { mount } from "@cf-lite/vue/client";\nimport { routes } from "../.cf-lite/routes";\n\nmount(routes);\n`,
  },
  starter: {
    "app/env.d.ts": `/// <reference types="@cf-lite/vue/env" />\n`,
    "app/routes/_layout.vue": `<script lang="ts">\nexport const head = { meta: [{ name: "description", content: "cf-lite app" }] };\n</script>\n<script setup lang="ts">\nimport { Link } from "@cf-lite/vue/client";\ndefineProps<{ params?: Record<string, string> }>();\n</script>\n\n<template>\n  <div>\n    <nav><Link to="/">home</Link></nav>\n    <slot />\n  </div>\n</template>\n`,
    "app/routes/index.vue": `<script lang="ts">\nexport const head = { title: "Home" };\n</script>\n<script setup lang="ts">\nimport { ref } from "vue";\ndefineProps<{ params?: Record<string, string>; data?: unknown }>();\nconst n = ref(0);\n</script>\n\n<template>\n  <main><h1>Hello from cf-lite + Vue</h1><button @click="n++">clicked {{ n }}</button></main>\n</template>\n`,
  },
};
export default scaffold;
