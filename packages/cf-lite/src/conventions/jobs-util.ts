/** Shared scanning helpers for the background-work conventions (cron / queues / workflows / email). */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { imp } from "./util.js";

export interface JobFile { file: string; name: string; src: string }

/** `server/<dir>/*.{ts,js,...}` (flat; `_x`, `*.d.ts`, `*.test.*` ignored), sorted by name. */
export function scanJobDir(root: string, dir: string): JobFile[] {
  const abs = join(root, "server", dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(tsx?|jsx?|mjs)$/.test(d.name) && !/\.d\.ts$|\.test\.|\.spec\./.test(d.name) && !d.name.startsWith("_"))
    .map((d) => ({ file: `server/${dir}/${d.name}`, name: d.name.replace(/\.[^.]+$/, ""), src: readFileSync(join(abs, d.name), "utf8") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `export const <id> = "literal"` (string literal only; static read, no evaluation). */
export function readString(src: string, id: string): string | undefined {
  const m = new RegExp(`export\\s+const\\s+${id}\\s*(?::[^=]+)?=\\s*(?:"([^"]*)"|'([^']*)'|\`([^\`$]*)\`)`).exec(src);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}
/** `export const <id> = "a" | ["a", "b"]` -> strings. */
export function readStrings(src: string, id: string): string[] | undefined {
  const m = new RegExp(`export\\s+const\\s+${id}\\s*(?::[^=]+)?=\\s*(\\[[^\\]]*\\]|"[^"]*"|'[^']*'|\`[^\`$]*\`)`).exec(src);
  if (!m) return undefined;
  return [...m[1].matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((x) => x[1] ?? x[2] ?? x[3]);
}
export const hasExport = (src: string, re: string) => new RegExp(`export\\s+(?:${re})\\b`).test(src);
export const hasDefault = (src: string) => /export\s+default\b|export\s*\{[^}]*\bas\s+default\b/.test(src);

export const upperSnake = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
export const pascal = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
export const ident = (prefix: string, i: number) => `${prefix}${i}`;
export { imp };

/** Wrangler-config helpers used by the convention `checks`. */
export const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);
