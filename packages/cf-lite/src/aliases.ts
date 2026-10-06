/**
 * Path aliases from `tsconfig.json` `compilerOptions.paths` -> Vite `resolve.alias`, so the editor and the bundler read one list
 * (docs/coming-from-mvc.md). Only the project's own tsconfig (no `extends` chasing); Used by the app build (cfLite) and by the prerender server, which runs outside the user's Vite config.
 *   "@/*": ["./app/*"]        -> import "@/islands/Counter" resolves to <root>/app/islands/Counter
 *   "~env": ["./server/env"]  -> exact alias
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Alias } from "vite";
import { parseJsonc } from "./wrangler-edit.js";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Aliases for `paths` (pure; exported for tests). `base` = absolute dir the targets are relative to. */
export function pathsToAliases(paths: Record<string, string[]>, base: string): Alias[] {
  const out: Alias[] = [];
  for (const [key, targets] of Object.entries(paths)) {
    const t = targets?.[0];
    if (typeof t !== "string") continue;
    if (key.endsWith("/*")) {
      if (t !== "*" && !t.endsWith("/*")) continue; // `"@/*": ["*"]` (with baseUrl) = the base dir itself
      out.push({ find: key.slice(0, -2), replacement: resolve(base, t === "*" ? "." : t.slice(0, -2)) });
    } else if (!key.includes("*")) out.push({ find: new RegExp(`^${escape(key)}$`), replacement: resolve(base, t) });
  }
  return out;
}

/** Aliases declared by `<root>/tsconfig.json` (empty when absent, unparsable or without `paths`). */
export function tsconfigAliases(root: string): Alias[] {
  const f = join(root, "tsconfig.json");
  if (!existsSync(f)) return [];
  try {
    const co = parseJsonc<{ compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } }>(readFileSync(f, "utf8")).compilerOptions;
    return co?.paths ? pathsToAliases(co.paths, resolve(root, co.baseUrl ?? ".")) : [];
  } catch { return []; }
}
