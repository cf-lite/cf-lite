/**
 * Build-time half of the `security` option: after prerender, hash every inline script/style in the built HTML and append the
 * static `_headers` block (CSP + base headers). Node-only; the pure logic lives in `modules/csp.ts`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { staticHeaders, type SecurityOptions } from "./modules/csp.js";

const MARK = "# --- cf-lite security ---";

function htmlFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) htmlFiles(p, out);
    else if (e.name.endsWith(".html")) out.push(p); // `_shell.tpl` is not HTML-served; SSR pages get a nonce policy from the Worker instead
  }
  return out;
}

/** Idempotent: replaces a previous security block in `<outDir>/_headers`. Returns the block written. */
export async function applySecurityHeaders(outDir: string, o: SecurityOptions): Promise<string> {
  const block = await staticHeaders(htmlFiles(outDir).map((f) => readFileSync(f, "utf8")), o);
  const file = join(outDir, "_headers");
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  const base = prev.split(MARK)[0]!.trimEnd();
  writeFileSync(file, `${base ? base + "\n\n" : ""}${MARK}\n${block}`);
  return block;
}
