/**
 * `cf-lite add auth`: copies the auth template (sessions + OAuth routes + D1 migration) into an app.
 * Idempotent and non-destructive: existing files are never overwritten; the wrangler.jsonc edit is a text-level insert
 * (comments preserved) that only happens when the `AUTH_DB` binding is absent.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const templateDir = () => join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "auth");

function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) yield* walk(p); else yield p; }
}

/** Insert `"d1_databases": [...]` (or add the binding to an existing array) without touching the rest of the file. */
export function patchWrangler(src: string, name: string): string | null {
  if (/["']?AUTH_DB["']?/.test(src)) return src;
  const entry = `{ "binding": "AUTH_DB", "database_name": "${name}-auth" }`;
  const arr = /("d1_databases"\s*:\s*\[)/.exec(src);
  if (arr) return src.replace(arr[1], `${arr[1]} ${entry},`);
  const open = src.indexOf("{");
  if (open < 0) return null;
  return src.slice(0, open + 1) + `\n  // cf-lite add auth: accounts (+ optional D1 sessions). Apply migrations/0001_auth.sql: wrangler d1 migrations apply AUTH_DB --local\n  "d1_databases": [${entry}],` + src.slice(open + 1);
}

export interface AuthOptions { /** Rate-limit the auth routes (default true; `--no-ratelimit`). */ rateLimit?: boolean; /** Turnstile on the login form (default true; `--no-turnstile`). */ turnstile?: boolean }

/**
 * Template feature blocks: `// @cfl:<feature>` ... `// @cfl:end` is kept when the feature is on, `// @cfl:no-<feature>` ... `// @cfl:end`
 * when it is off. The marker lines themselves are always removed. Only `.ts` files are processed.
 */
export function applyFeatures(src: string, on: Record<string, boolean>): string {
  const out: string[] = [];
  let keep: boolean | null = null;
  for (const line of src.split("\n")) {
    const m = /^\s*\/\/ @cfl:(\S+)\s*$/.exec(line);
    if (m) {
      if (m[1] === "end") keep = null;
      else { const neg = m[1].startsWith("no-"); const f = neg ? m[1].slice(3) : m[1]; keep = neg ? !on[f] : !!on[f]; }
      continue;
    }
    if (keep !== false) out.push(line);
  }
  return out.join("\n");
}

export function addAuth(dir: string, log: (m: string) => void = () => {}, opts: AuthOptions = {}): { changed: string[] } {
  const on = { ratelimit: opts.rateLimit !== false, turnstile: opts.turnstile !== false };
  const changed: string[] = [];
  const root = templateDir();
  for (const f of walk(root)) {
    const rel = relative(root, f);
    const dest = join(dir, rel);
    if (existsSync(dest)) { log(`  keep   ${rel} (exists)`); continue; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, rel.endsWith(".ts") ? applyFeatures(readFileSync(f, "utf8"), on) : readFileSync(f));
    changed.push(rel); log(`  write  ${rel}`);
  }
  const wr = join(dir, "wrangler.jsonc");
  if (existsSync(wr)) {
    const src = readFileSync(wr, "utf8");
    const name = /"name"\s*:\s*"([^"]+)"/.exec(src)?.[1] ?? "app";
    const out = patchWrangler(src, name);
    if (out === null) log("  add the AUTH_DB D1 binding to wrangler.jsonc by hand");
    else if (out !== src) { writeFileSync(wr, out); changed.push("wrangler.jsonc"); log("  edit   wrangler.jsonc (+ AUTH_DB D1 binding)"); }
  }
  if (changed.length) log(`\nNext: cp .dev.vars.example .dev.vars && set SESSION_SECRETS;${on.turnstile ? " set TURNSTILE_SITE_KEY (var) + TURNSTILE_SECRET (secret) for production;" : ""} wrangler d1 migrations apply AUTH_DB --local; register your OAuth app with redirect URI <origin>/api/auth/callback.`);
  return { changed };
}
