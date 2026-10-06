/**
 * Client route chunks must not carry server code: `loader`, `actions` (and the server-only `cache` / `isr` / `paths` configs) of a page
 * module are removed from the *client* environment's copy of `app/routes/**`. The Worker keeps the full module. Imports only they used
 * then become unused and Rollup/Rolldown tree-shakes them away (a server-only import with top-level side effects would stay: keep those in `server/`).
 */
import { parseAst, type Plugin } from "vite";

export const SERVER_ONLY_EXPORTS = ["loader", "actions", "cache", "isr", "paths"] as const;
const ROUTE_FILE = /[\\/]app[\\/]routes[\\/].*\.(tsx|ts|jsx|js|vue|svelte)$/;
/** `<script ...>body</script>` blocks of a single-file component (attributes may not contain `>`; good enough for route files). */
const SCRIPT_BLOCK = /(<script\b([^>]*)>)([\s\S]*?)(<\/script>)/g;

/** Returns the module with server-only top-level exports replaced by an unexported `undefined` stub, or null when nothing changed. */
export function stripServerExports(code: string, id: string, lang?: "ts" | "js" | "tsx" | "jsx"): string | null {
  if (/\.(vue|svelte)$/.test(id)) return stripSfc(code, id);
  if (!SERVER_ONLY_EXPORTS.some((n) => code.includes(n))) return null;
  let ast;
  try { ast = parseAst(code, { lang: lang ?? (/\.[jt]sx$/.test(id) ? (id.endsWith(".tsx") ? "tsx" : "jsx") : id.endsWith(".ts") ? "ts" : "js") }); } catch { return null; }
  const edits: [number, number, string][] = [];
  const isServer = (n: string) => (SERVER_ONLY_EXPORTS as readonly string[]).includes(n);
  for (const node of ast.body as any[]) {
    if (node.type !== "ExportNamedDeclaration") continue;
    const d = node.declaration;
    if (d?.type === "FunctionDeclaration" && d.id && isServer(d.id.name)) edits.push([node.start, node.end, `var ${d.id.name} = undefined;`]);
    else if (d?.type === "VariableDeclaration") {
      const names = d.declarations.map((x: any) => (x.id.type === "Identifier" ? x.id.name : null));
      if (names.length && names.every((n: string | null) => n && isServer(n))) edits.push([node.start, node.end, `var ${names.join(" = undefined, ")} = undefined;`]);
    } else if (!d && node.specifiers?.length && !node.source) {
      // `export { loader, default }`: drop only the server-only specifiers (the local binding stays for in-file use).
      const keep = node.specifiers.filter((s: any) => !isServer(s.exported.name ?? s.exported.value));
      if (keep.length !== node.specifiers.length)
        edits.push([node.start, node.end, keep.length ? `export { ${keep.map((s: any) => (s.local.name === (s.exported.name ?? s.exported.value) ? s.local.name : `${s.local.name} as ${s.exported.name ?? s.exported.value}`)).join(", ")} };` : ""]);
    }
  }
  if (!edits.length) return null;
  let out = code;
  for (const [s, e, r] of edits.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + r + out.slice(e);
  return out;
}

/**
 * `.vue` / `.svelte`: route config lives in a module-level script (Vue: a plain `<script>` next to `<script setup>`, which cannot export; Svelte:
 * `<script module>` / `context="module"`). Only those blocks are rewritten; instance scripts (`<script setup>`, plain Svelte `<script>`) are left alone.
 */
function stripSfc(code: string, id: string): string | null {
  const svelte = id.endsWith(".svelte");
  let changed = false;
  const out = code.replace(SCRIPT_BLOCK, (m, open: string, attrs: string, body: string, close: string) => {
    const moduleLevel = svelte ? /\bmodule\b|context\s*=\s*["']module["']/.test(attrs) : !/\bsetup\b/.test(attrs);
    if (!moduleLevel) return m;
    const ts = /\blang\s*=\s*["']ts["']/.test(attrs);
    const res = stripServerExports(body, `x.${ts ? "ts" : "js"}`);
    if (res === null) return m;
    changed = true;
    return open + res + close;
  });
  return changed ? out : null;
}

/** Vite plugin: applies to the `client` environment only (dev and build). */
export function stripServerCode(): Plugin {
  return {
    name: "cf-lite:strip-server",
    enforce: "pre",
    applyToEnvironment: (env) => env.name === "client",
    transform(code, id) {
      const clean = id.split("?")[0];
      if (!ROUTE_FILE.test(clean)) return null;
      const out = stripServerExports(code, clean);
      return out === null ? null : { code: out, map: null };
    },
  };
}
