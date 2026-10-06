import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../src/vite.js";
import type { UiAdapter } from "../src/adapter.js";

// Golden output of the generator for every shipped example: the contributor refactor (WP-SEAMS) must stay byte-identical.
// Regenerate deliberately with UPDATE_GOLDEN=1.
const here = fileURLToPath(new URL(".", import.meta.url));
const examples = join(here, "../../../examples");
const stub = (id: string, ext: string[]): UiAdapter => ({ id, extensions: ext, client: `${id}/client`, server: `${id}/server`, vite: () => ({ plugins: [] }) });
const CASES: [string, UiAdapter | "none"][] = [
  ["demo", stub("@cf-lite/react", [".tsx", ".jsx", ".ts", ".js"])],
  ["site", stub("@cf-lite/react", [".tsx", ".jsx", ".ts", ".js"])],
  ["site-htmx", "none"],
  ["site-preact", stub("@cf-lite/preact", [".tsx", ".jsx", ".ts", ".js"])],
  ["site-solid", stub("@cf-lite/solid", [".tsx", ".jsx", ".ts", ".js"])],
  ["site-svelte", stub("@cf-lite/svelte", [".svelte"])],
  ["site-vue", stub("@cf-lite/vue", [".vue"])],
];

describe("generated .cf-lite output is stable across the 7 examples", () => {
  for (const [name, ui] of CASES) {
    it(name, () => {
      const root = join(examples, name);
      generate(root, ui);
      for (const f of ["app.ts", "routes.ts"]) {
        const g = join(here, "golden", `${name}.${f}`);
        const got = readFileSync(join(root, ".cf-lite", f), "utf8");
        if (process.env.UPDATE_GOLDEN || !existsSync(g)) { mkdirSync(join(g, ".."), { recursive: true }); writeFileSync(g, got); }
        expect(got).toBe(readFileSync(g, "utf8"));
      }
      expect(existsSync(join(root, ".cf-lite", "handlers.ts"))).toBe(false);
    });
  }
});
