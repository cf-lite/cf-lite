import type { AdapterScaffold } from "cf-lite/adapter";

export const scaffold: AdapterScaffold = {
  deps: { svelte: "^5.57.1" },
  tsconfig: { compilerOptions: { verbatimModuleSyntax: true } },
  entry: {
    file: "app/main.ts",
    content: `import { mount } from "@cf-lite/svelte/client";\nimport { routes } from "../.cf-lite/routes";\n\nmount(routes);\n`,
  },
  starter: {
    "app/env.d.ts": `/// <reference types="@cf-lite/svelte/env" />\n`,
    "app/routes/_layout.svelte": `<script module>\n  export const head = { meta: [{ name: "description", content: "cf-lite app" }] };\n</script>\n\n<script>\n  import Link from "@cf-lite/svelte/Link.svelte";\n  let { children } = $props();\n</script>\n\n<div>\n  <nav><Link to="/">home</Link></nav>\n  {@render children?.()}\n</div>\n`,
    "app/routes/index.svelte": `<script module>\n  export const head = { title: "Home" };\n</script>\n\n<script>\n  let n = $state(0);\n</script>\n\n<main><h1>Hello from cf-lite + Svelte</h1><button onclick={() => n++}>clicked {n}</button></main>\n`,
  },
};
export default scaffold;
