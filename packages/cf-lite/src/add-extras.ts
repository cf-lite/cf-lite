/**
 * `cf-lite add tailwind|ai|images|turnstile` and the generic `--dry-run` wrapper for every `add` target.
 * Same contract as the other `add-*` files: idempotent (second run = no diff), never overwrites a user file, comment-preserving
 * wrangler edits, prints what changed. Dry-run runs the real code on a scratch copy and diffs, so it can never drift from the real run.
 */
import { detectPm } from "./pm.js";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { parseJsonc } from "./wrangler-edit.js";

export const EXTRA_KINDS = ["tailwind", "ai", "images", "turnstile", "rsc"] as const;
export type ExtraKind = (typeof EXTRA_KINDS)[number];
export const isExtraKind = (s: string): s is ExtraKind => (EXTRA_KINDS as readonly string[]).includes(s);

export interface ExtraOptions { install?: boolean; log?: (m: string) => void }
const TAILWIND_VERSION = "^4.1.0";

/** `{ "a": 1 }` (spaced like hand-written wrangler config) for a flat object. */
const flat = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(", ")} }` : JSON.stringify(v));

class Ctx {
  changed: string[] = [];
  constructor(readonly dir: string, readonly log: (m: string) => void) {}
  read(rel: string) { const p = join(this.dir, rel); return existsSync(p) ? readFileSync(p, "utf8") : null; }
  write(rel: string, body: string) {
    const cur = this.read(rel);
    if (cur === body) return;
    mkdirSync(dirname(join(this.dir, rel)), { recursive: true });
    writeFileSync(join(this.dir, rel), body);
    if (!this.changed.includes(rel)) this.changed.push(rel);
    this.log(`  ${cur === null ? "create" : "edit  "} ${rel}`);
  }
  create(rel: string, body: string) { if (this.read(rel) !== null) this.log(`  keep   ${rel} (exists)`); else this.write(rel, body); }
  deps(kind: "dependencies" | "devDependencies", add: Record<string, string>) {
    const src = this.read("package.json"); if (src === null) throw new Error("cf-lite add: run it in your app directory (no package.json here)");
    const pj = JSON.parse(src);
    for (const [k, v] of Object.entries(add)) if (!pj.dependencies?.[k] && !pj.devDependencies?.[k]) (pj[kind] ??= {})[k] = v;
    if (pj[kind]) pj[kind] = Object.fromEntries(Object.entries(pj[kind]).sort(([a], [b]) => a.localeCompare(b)));
    this.write("package.json", JSON.stringify(pj, null, 2) + "\n");
  }
  /** Top-level wrangler key `"<key>": <json>` inserted after the opening brace when absent. */
  wranglerTop(key: string, value: unknown, comment?: string) {
    const rel = ["wrangler.jsonc", "wrangler.json"].find((f) => existsSync(join(this.dir, f)));
    if (!rel) { this.log(`  no wrangler.jsonc - add by hand: "${key}": ${JSON.stringify(value)}`); return; }
    const src = this.read(rel)!;
    if (parseJsonc<any>(src)[key] !== undefined) return;
    const o = src.indexOf("{");
    this.write(rel, src.slice(0, o + 1) + `\n  ${comment && rel.endsWith("c") ? `// ${comment}\n  ` : ""}${JSON.stringify(key)}: ${flat(value)},` + src.slice(o + 1));
  }
  /** `NAME: type;` into `interface Env { ... }` of server/env.d.ts (when that file exists and has one). */
  envType(name: string, type: string) {
    const rel = ["server/env.d.ts", "worker-configuration.d.ts"].find((f) => existsSync(join(this.dir, f)));
    if (!rel) { this.log(`  add to your Env type by hand: ${name}: ${type};`); return; }
    const src = this.read(rel)!;
    if (new RegExp(`\\b${name}\\??\\s*:`).test(src)) return;
    const m = /interface\s+Env\s*\{/.exec(src);
    if (!m) { this.log(`  add to your Env type by hand: ${name}: ${type};`); return; }
    const at = m.index + m[0].length;
    const inline = /^\s*\}/.test(src.slice(at)); // `interface Env {}`
    this.write(rel, inline ? src.slice(0, at) + `\n  ${name}: ${type};\n` + src.slice(at).replace(/^\s*/, "") : src.slice(0, at) + `\n  ${name}: ${type};` + src.slice(at));
  }
}

function addTailwind(c: Ctx) {
  c.deps("dependencies", { tailwindcss: TAILWIND_VERSION });
  c.deps("devDependencies", { "@tailwindcss/vite": TAILWIND_VERSION });
  const vc = ["vite.config.ts", "vite.config.mts", "vite.config.js"].find((f) => existsSync(join(c.dir, f)));
  if (!vc) throw new Error("cf-lite add tailwind: no vite.config.ts found");
  let src = c.read(vc)!;
  if (!/@tailwindcss\/vite/.test(src)) {
    if (!/plugins:\s*\[/.test(src)) throw new Error(`cf-lite add tailwind: could not patch ${vc}. Add by hand:\n  import tailwindcss from "@tailwindcss/vite";\n  plugins: [tailwindcss(), ...]`);
    src = src.replace(/plugins:\s*\[/, "plugins: [tailwindcss(), ");
    const lines = src.split("\n"); let last = -1; lines.forEach((l, i) => { if (/^import\s/.test(l)) last = i; });
    lines.splice(last + 1, 0, 'import tailwindcss from "@tailwindcss/vite";');
    c.write(vc, lines.join("\n"));
  }
  c.create("app/styles.css", '@import "tailwindcss";\n');
  const html = c.read("index.html");
  if (html !== null && !/app\/styles\.css/.test(html)) {
    c.write("index.html", /<\/head>/.test(html) ? html.replace("</head>", '  <link rel="stylesheet" href="/app/styles.css" />\n</head>') : html);
    if (!/app\/styles\.css/.test(c.read("index.html")!)) c.log('  add  <link rel="stylesheet" href="/app/styles.css"> to your page head by hand');
  }
}

/** Exact RSC pins (docs/design/rsc.md; `cf-lite doctor` CFL015 enforces exactness). Keep equal to examples/site-rsc/package.json (test/dx.test.ts checks). */
export const RSC_PINS = { "@vitejs/plugin-rsc": "0.5.35", react: "19.3.0", "react-dom": "19.3.0", "react-server-dom-webpack": "19.3.0", "rsc-html-stream": "0.0.8" } as const;

const RSC_PAGE = `// render = "rsc": a React Server Component page (docs/rsc.md). Runs only on the server; "use client" files are the only JS shipped.
import { Suspense } from "react";
import { getRequest } from "cf-lite/rsc";
import { Counter } from "../islands/counter";

export const render = "rsc";
export const head = { title: "Server components" };

async function Greeting() {
  const { url } = getRequest(); // request context from any server component: env, params, url, ...
  return <p>Rendered on the server for {url.pathname}</p>;
}

export default function Page() {
  return (
    <main>
      <h1>Server components on Cloudflare</h1>
      <Suspense fallback={<p>loading...</p>}><Greeting /></Suspense>
      <Counter />
    </main>
  );
}
`;
const RSC_LAYOUT = `// Server layout of every render = "rsc" page (the client-style _layout.tsx does not apply to them). No hooks, no client Link.
import type { ReactNode } from "react";

export default function RscLayout({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}
`;
const RSC_COUNTER = `"use client";
import { useState } from "react";

export function Counter() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>clicks: {n}</button>;
}
`;

/** `cf-lite add rsc`: opt a React app into render="rsc" - pinned deps, nodejs_compat, a starter page + layout + client component. */
function addRsc(c: Ctx) {
  const vc = ["vite.config.ts", "vite.config.mts", "vite.config.js"].find((f) => existsSync(join(c.dir, f)));
  if (!vc || !/@cf-lite\/react/.test(c.read(vc)!)) throw new Error("cf-lite add rsc: RSC is React-only - run `cf-lite add react` first (no @cf-lite/react renderer in vite.config)");
  c.deps("dependencies", RSC_PINS as unknown as Record<string, string>);
  const rel = ["wrangler.jsonc", "wrangler.json"].find((f) => existsSync(join(c.dir, f)));
  if (!rel) c.log('  no wrangler.jsonc - add by hand: "compatibility_flags": ["nodejs_compat"]');
  else {
    const src = c.read(rel)!, cfg = parseJsonc<any>(src);
    const flags: string[] | undefined = cfg.compatibility_flags;
    if (!flags) c.wranglerTop("compatibility_flags", ["nodejs_compat"], "cf-lite add rsc: getRequest() uses AsyncLocalStorage");
    else if (!flags.includes("nodejs_compat") && !flags.includes("nodejs_als")) {
      const next = src.replace(/("compatibility_flags"\s*:\s*\[)/, '$1"nodejs_compat", ');
      if (next === src) c.log('  add "nodejs_compat" to compatibility_flags by hand'); else c.write(rel, next);
    }
  }
  c.create("app/routes/rsc.tsx", RSC_PAGE);
  c.create("app/routes/_layout.rsc.tsx", RSC_LAYOUT);
  c.create("app/islands/counter.tsx", RSC_COUNTER);
}

const AI_ROUTE = `import { Hono } from "hono";

/** POST /api/ai { prompt } -> Workers AI. Swap the model id for any in https://developers.cloudflare.com/workers-ai/models/ (Workers AI is billed per use). */
export default new Hono<{ Bindings: Env }>().post("/", async (c) => {
  const { prompt } = await c.req.json<{ prompt?: string }>().catch(() => ({ prompt: undefined }));
  if (!prompt || prompt.length > 2000) return c.json({ error: "prompt required (max 2000 chars)" }, 400);
  const out = await c.env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt });
  return c.json(out);
});
`;
const TURNSTILE_ROUTE = `import { Hono } from "hono";
import { turnstile } from "cf-lite/modules/turnstile";

/** Example: a form endpoint that rejects requests without a valid Turnstile token (fails closed when TURNSTILE_SECRET is missing). */
export default new Hono<{ Bindings: Env }>().post("/", turnstile(), (c) => c.json({ ok: true }));
`;

export function addExtra(dir: string, kind: ExtraKind, o: ExtraOptions = {}): { changed: string[] } {
  const c = new Ctx(dir, o.log ?? (() => {}));
  if (kind === "tailwind") addTailwind(c);
  else if (kind === "rsc") addRsc(c);
  else if (kind === "ai") {
    c.wranglerTop("ai", { binding: "AI" }, "cf-lite add ai: Workers AI binding (usage is billed; remote even in local dev)");
    c.envType("AI", "Ai");
    c.create("server/api/ai.ts", AI_ROUTE);
  } else if (kind === "images") {
    c.wranglerTop("images", { binding: "IMAGES" }, "cf-lite add images: Images binding (transform/optimise at request time)");
    c.envType("IMAGES", "ImagesBinding");
  } else {
    c.create("server/api/signup.ts", TURNSTILE_ROUTE);
    const ex = c.read(".dev.vars.example") ?? "";
    if (!/^TURNSTILE_SECRET=/m.test(ex)) c.write(".dev.vars.example", ex + `${ex && !ex.endsWith("\n") ? "\n" : ""}# Cloudflare dashboard -> Turnstile. Dev: 1x0000000000000000000000000000000AA always passes, 2x0000000000000000000000000000000AA always fails\nTURNSTILE_SECRET=1x0000000000000000000000000000000AA\n`);
    c.envType("TURNSTILE_SECRET", "string");
  }
  if (o.install !== false && c.changed.includes("package.json")) {
    const pm = detectPm(dir);
    c.log(`${pm} install`);
    if (spawnSync(pm, ["install"], { cwd: dir, stdio: "inherit" }).status !== 0) throw new Error(`${pm} install failed`);
  }
  c.log(c.changed.length ? `added ${kind}: ${c.changed.join(", ")}` : `${kind} already set up - nothing to change`);
  return { changed: c.changed };
}

// ---------- generic --dry-run ----------

const SKIP = /(^|[\\/])(node_modules|dist|\.cf-lite|\.wrangler|\.git)([\\/]|$)/;
function* walk(d: string): Generator<string> { for (const n of readdirSync(d)) { const p = join(d, n); if (SKIP.test(p)) continue; if (statSync(p).isDirectory()) yield* walk(p); else yield p; } }

/**
 * Run `fn` against a scratch copy of `dir` and return a deterministic report of what it would change:
 * `+ path` for new files, `~ path` for edited ones (followed by `+line` / `-line` for each differing line), sorted by path.
 */
export async function dryRun(dir: string, fn: (scratch: string) => void | Promise<void>): Promise<string[]> {
  const tmp = mkdtempSync(join(tmpdir(), "cf-lite-dry-"));
  try {
    cpSync(dir, tmp, { recursive: true, filter: (p) => !SKIP.test(p) });
    await fn(tmp);
    const before = new Map([...walk(dir)].map((p) => [relative(dir, p), readFileSync(p, "utf8")]));
    const lines: string[] = [];
    for (const p of [...walk(tmp)].sort((a, b) => relative(tmp, a).localeCompare(relative(tmp, b)))) {
      const rel = relative(tmp, p); const now = readFileSync(p, "utf8"); const was = before.get(rel);
      if (was === now) continue;
      if (was === undefined) { lines.push(`+ ${rel}`); continue; }
      lines.push(`~ ${rel}`);
      const a = new Set(was.split("\n")), b = new Set(now.split("\n"));
      for (const l of now.split("\n")) if (!a.has(l) && l.trim()) lines.push(`    +${l}`);
      for (const l of was.split("\n")) if (!b.has(l) && l.trim()) lines.push(`    -${l}`);
    }
    return lines.length ? lines : ["(no changes)"];
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
