/**
 * `cf-lite add patterns` (docs/preview.md, docs/coming-from-mvc.md): the starter conventions for a pattern library.
 * Same contract as every `add-*` file: idempotent, never overwrites a file you own, prints what it changed.
 *   app/patterns/{atoms,molecules,organisms}/   optional atomic folders (a component per folder: Name/Name.tsx + Name.states.ts)
 *   app/preview.setup.ts                        global CSS/fonts for /__preview frames
 *   mocks/api/hello.json                        a route-level mock served with MOCK=1
 *   tsconfig.json `paths` (@/*, @patterns/*): cfLite() mirrors them into Vite's resolve.alias, so there is one list
 *   package.json scripts: dev:mock, patterns:export
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PREVIEWABLE = ["react", "preact", "vue"] as const;
const README = `# Patterns

Atomic folders are optional - use \`atoms/\`, \`molecules/\`, \`organisms/\` or flat folders, whatever the team already speaks.
One component per folder:

    atoms/Button/Button.tsx          the component (default export, typed props)
    atoms/Button/Button.states.ts    named prop sets, shown at /__preview and exported by \`cfl export\`

Aliases: \`@patterns/atoms/Button/Button\`, \`@/islands/Counter.island\` (tsconfig \`paths\`, shared with Vite).
Dev: \`bun run dev\` then open /__preview. With mocks: \`bun run dev:mock\`. Hand the markup to a backend: \`bun run patterns:export\`.
`;
const files = (ui: string): Record<string, string> => {
  const vue = ui === "vue";
  return {
    "app/patterns/README.md": README,
    ...(vue
      ? { "app/patterns/atoms/Button/Button.vue": `<script setup lang="ts">\nwithDefaults(defineProps<{ label: string; variant?: "solid" | "ghost"; disabled?: boolean }>(), { variant: "solid", disabled: false });\n</script>\n<template>\n  <button type="button" :class="variant === 'ghost' ? 'btn btn--ghost' : 'btn'" :disabled="disabled">{{ label }}</button>\n</template>\n` }
      : { "app/patterns/atoms/Button/Button.tsx": `export interface ButtonProps { label: string; variant?: "solid" | "ghost"; disabled?: boolean }\n\nexport default function Button({ label, variant = "solid", disabled = false }: ButtonProps) {\n  return <button type="button" className={variant === "ghost" ? "btn btn--ghost" : "btn"} disabled={disabled}>{label}</button>;\n}\n` }),
    "app/patterns/atoms/Button/Button.states.ts": `import { defineStates } from "cf-lite/preview";\nimport Button from "./Button${vue ? ".vue" : ""}";\n\nexport default defineStates(Button, {\n  default: { label: "Save" },\n  ghost: { label: "Cancel", variant: "ghost" },\n  disabled: { label: "Save", disabled: true },\n});\n`,
    "app/preview.setup.ts": `// Loaded by every /__preview frame: import the global CSS / fonts your pages get from the client entry.\n// import "./styles.css";\n`,
    "mocks/api/hello.json": `{ "message": "hello from mocks/api/hello.json" }\n`,
  };
};

export function addPatterns(dir: string, log: (m: string) => void = () => {}): void {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) throw new Error("run it in your app directory (no package.json here)");
  const vc = ["vite.config.ts", "vite.config.mts", "vite.config.js"].find((f) => existsSync(join(dir, f)));
  const cfg = vc ? readFileSync(join(dir, vc), "utf8") : "";
  const ui = PREVIEWABLE.find((u) => cfg.includes(`@cf-lite/${u}`));
  if (!ui) throw new Error(`add patterns needs a UI adapter that can render components (${PREVIEWABLE.join(", ")}): run \`cf-lite add react\` first`);
  const write = (rel: string, body: string, keep = true) => {
    const p = join(dir, rel);
    if (existsSync(p)) { if (readFileSync(p, "utf8") === body) return; if (keep) { log(`  keep   ${rel} (exists)`); return; } }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    log(`  create ${rel}`);
  };
  for (const [rel, body] of Object.entries(files(ui))) write(rel, body);

  // package.json scripts (only the ones that are absent)
  const pkg = JSON.parse(readFileSync(pj, "utf8"));
  pkg.scripts ??= {};
  const want: Record<string, string> = { "dev:mock": "MOCK=1 cf-lite dev", "patterns:export": "cfl export" };
  let edited = false;
  for (const [k, v] of Object.entries(want)) if (!pkg.scripts[k]) { pkg.scripts[k] = v; edited = true; }
  if (edited) { writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n"); log("  edit   package.json (scripts: dev:mock, patterns:export)"); }

  // tsconfig paths (plain JSON only; a tsconfig with comments is left alone with the exact lines to add)
  const ts = join(dir, "tsconfig.json");
  if (existsSync(ts)) {
    try {
      const c = JSON.parse(readFileSync(ts, "utf8"));
      const paths = (c.compilerOptions ??= {}).paths ??= {};
      let changed = false;
      for (const [k, v] of Object.entries({ "@/*": ["./app/*"], "@patterns/*": ["./app/patterns/*"] })) if (!paths[k]) { paths[k] = v; changed = true; }
      if (changed) { writeFileSync(ts, JSON.stringify(c, null, 2) + "\n"); log("  edit   tsconfig.json (paths: @/*, @patterns/*)"); }
    } catch { log('  tsconfig.json has comments: add by hand  "paths": { "@/*": ["./app/*"], "@patterns/*": ["./app/patterns/*"] }'); }
  }
  log("next: bun run dev -> /__preview   |   bun run dev:mock -> /api/hello   |   bun run patterns:export");
}
