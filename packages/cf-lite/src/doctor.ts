/**
 * `cf-lite doctor`: static checks of an app directory. Pure (reads files, returns findings) so every code is unit-tested
 * against a fixture; the CLI only prints. Every code `CFL###` has a section in docs/doctor.md (a test enforces it).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseJsonc } from "./wrangler-edit.js";
import { WARN_PROPS_BYTES } from "./islands.js";

export type Level = "error" | "warn" | "info";
export interface Finding { code: string; level: Level; message: string; fix?: string }
export interface DoctorOptions {
  now?: Date;
  /** Gzipped Worker size (KiB) that raises CFL010. Default 1024 (warn); Cloudflare's hard limit is 3 MiB free / 10 MiB paid. */
  budgetKiB?: number;
}

/** Every code doctor can emit - docs/doctor.md must have a `## CFLxxx` heading for each. */
export const DOCTOR_CODES = ["CFL001", "CFL002", "CFL003", "CFL004", "CFL005", "CFL006", "CFL007", "CFL008", "CFL009", "CFL010", "CFL011", "CFL012", "CFL013", "CFL014", "CFL015", "CFL016", "CFL017", "CFL018"] as const;

const DAY = 86_400_000;
const BINDING_KEYS: Array<[key: string, field: string]> = [
  ["d1_databases", "binding"], ["kv_namespaces", "binding"], ["r2_buckets", "binding"], ["hyperdrive", "binding"],
  ["queues.producers", "binding"], ["durable_objects.bindings", "name"], ["services", "binding"], ["workflows", "binding"],
  ["analytics_engine_datasets", "binding"], ["unsafe.bindings", "name"], ["ratelimits", "name"], ["vectorize", "binding"],
];
const SINGLE_BINDINGS = ["ai", "browser", "images", "send_email", "version_metadata"];

const get = (o: any, path: string) => path.split(".").reduce((x, k) => x?.[k], o);

/** Names of all bindings and vars a wrangler config (top level) declares. */
export function declaredBindings(cfg: any): Set<string> {
  const out = new Set<string>();
  for (const [p, f] of BINDING_KEYS) for (const e of (get(cfg, p) as any[]) ?? []) if (e?.[f]) out.add(e[f]);
  for (const k of SINGLE_BINDINGS) { const v = cfg[k]; if (v?.binding) out.add(v.binding); else if (Array.isArray(v)) v.forEach((e) => e?.name && out.add(e.name)); }
  if (cfg.assets?.binding) out.add(cfg.assets.binding);
  for (const k of Object.keys(cfg.vars ?? {})) out.add(k);
  return out;
}

/** Property names of every `interface Env { ... }` in the app's .d.ts/.ts type files. */
export function envTypeKeys(dir: string): { keys: Set<string>; files: string[] } {
  const keys = new Set<string>(); const files: string[] = [];
  const candidates = ["worker-configuration.d.ts", "server/env.d.ts", "env.d.ts", "src/env.d.ts", ".cf-lite/env.d.ts"];
  for (const c of candidates) {
    const p = join(dir, c);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    let found = false;
    for (const m of src.matchAll(/interface\s+(?:Env|Cloudflare\.Env)\s*(?:extends[^{]*)?\{/g)) {
      found = true;
      let depth = 1, i = m.index! + m[0].length; const start = i;
      for (; i < src.length && depth; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; }
      const body = src.slice(start, i - 1);
      // top-level property names only (depth 0 inside the body)
      let d = 0, line = "";
      for (const ch of body) { if (ch === "{" || ch === "(" || ch === "<" || ch === "[") d++; if (ch === "}" || ch === ")" || ch === ">" || ch === "]") d--; if (d === 0 && (ch === "\n" || ch === ";")) { const k = /^\s*(?:readonly\s+)?["']?([A-Za-z_$][\w$]*)["']?\??\s*:/.exec(line); if (k) keys.add(k[1]); line = ""; } else line += ch; }
      const k = /^\s*(?:readonly\s+)?["']?([A-Za-z_$][\w$]*)["']?\??\s*:/.exec(line); if (k) keys.add(k[1]);
    }
    if (found) files.push(c);
  }
  return { keys, files };
}

const listTs = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => /\.(ts|js|mts|mjs)$/.test(f) && !f.endsWith(".d.ts")).map((f) => f.replace(/\.[^.]+$/, "")) : []);
const extraVarNames = (dir: string) => {
  const s = new Set<string>();
  for (const f of [".dev.vars", ".dev.vars.example", ".env.example"]) {
    const p = join(dir, f);
    if (existsSync(p)) for (const l of readFileSync(p, "utf8").split("\n")) { const m = /^\s*([A-Za-z_][\w]*)\s*=/.exec(l); if (m) s.add(m[1]); }
  }
  return s;
};

const RSC_PKGS = ["@vitejs/plugin-rsc", "react", "react-dom", "react-server-dom-webpack", "rsc-html-stream"] as const;
const rscPage = /export\s+const\s+render\s*=\s*["']rsc["']/;
const walkSrc = (d: string, out: string[] = []): string[] => {
  if (!existsSync(d)) return out;
  for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walkSrc(p, out); else if (/\.(tsx|jsx|ts|js)$/.test(e.name)) out.push(p); }
  return out;
};
/** Pages under app/routes that opt into `render = "rsc"` (relative to dir). */
export function rscPages(dir: string): string[] {
  return walkSrc(join(dir, "app/routes")).filter((f) => { try { return rscPage.test(readFileSync(f, "utf8")); } catch { return false; } }).map((f) => f.slice(dir.length + 1));
}
const semver = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number) as [number, number, number] | undefined;
const semverGte = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Built pages whose `<cfl-island data-p="...">` props exceed the warn size (props travel in the HTML; docs/islands.md). */
export function oversizedIslandProps(dir: string): Array<{ file: string; id: string; bytes: number }> {
  const out: Array<{ file: string; id: string; bytes: number }> = [];
  const root = ["dist/client", ".cloudflare/output/v0/workers/default/assets"].map((d) => join(dir, d)).find(existsSync);
  if (!root) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== "assets") walk(p); } else if (e.name.endsWith(".html")) {
        const html = readFileSync(p, "utf8");
        for (const m of html.matchAll(/<cfl-island\b[^>]*?\bdata-i="([^"]*)"[^>]*?\bdata-p="([^"]*)"/g)) {
          const bytes = m[2]!.replace(/&quot;/g, '"').length;
          if (bytes > WARN_PROPS_BYTES) out.push({ file: p.slice(root.length + 1), id: m[1]!, bytes });
        }
      }
    }
  };
  walk(root);
  return out;
}

export function workerSizeGzip(dir: string): { kib: number; file: string } | null {
  try {
    const redirect = JSON.parse(readFileSync(join(dir, ".wrangler/deploy/config.json"), "utf8")).configPath as string;
    const cfgPath = join(dir, ".wrangler/deploy", redirect);
    const cfg = parseJsonc<any>(readFileSync(cfgPath, "utf8"));
    const main = join(cfgPath, "..", cfg.main);
    const base = join(main, "..");
    let total = 0;
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(m?js|wasm)$/.test(n)) total += gzipSync(readFileSync(p), { level: 9 }).length; } };
    walk(base);
    return { kib: Math.round((total / 1024) * 10) / 10, file: main };
  } catch { return null; }
}

/** Dev-only code that must never reach a deployed Worker: the `/__preview` runtime and the mock layer (docs/preview.md, docs/mocks.md). Reads the built Worker directory; empty without a build. */
export function devToolsInBuild(dir: string): string[] {
  try {
    const redirect = JSON.parse(readFileSync(join(dir, ".wrangler/deploy/config.json"), "utf8")).configPath as string;
    const cfgPath = join(dir, ".wrangler/deploy", redirect);
    const base = join(cfgPath, "..", parseJsonc<any>(readFileSync(cfgPath, "utf8")).main, "..");
    const found = new Set<string>();
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.m?js$/.test(n)) { const t = readFileSync(p, "utf8"); if (t.includes("preview render error")) found.add("/__preview"); if (t.includes("cf-lite.mock-fetch")) found.add("mocks"); } } };
    walk(base);
    return [...found].sort();
  } catch { return []; }
}

export function doctor(dir: string, opts: DoctorOptions = {}): Finding[] {
  const out: Finding[] = [];
  const add = (code: string, level: Level, message: string, fix?: string) => out.push({ code, level, message, fix });
  const now = opts.now ?? new Date();

  const file = ["wrangler.jsonc", "wrangler.json"].map((f) => join(dir, f)).find(existsSync);
  if (!file) {
    if (existsSync(join(dir, "wrangler.toml"))) add("CFL002", "warn", "wrangler.toml found: cf-lite db/add/doctor only read wrangler.jsonc/wrangler.json", "convert with `wrangler` (or by hand) to wrangler.jsonc");
    else add("CFL001", "error", "no wrangler.jsonc / wrangler.json in this directory", "run doctor in your app directory, or create one (`bun create cf-lite`)");
    return out;
  }
  let cfg: any;
  try { cfg = parseJsonc(readFileSync(file, "utf8")); } catch (e) { add("CFL001", "error", `${file.slice(dir.length + 1)} does not parse: ${(e as Error).message}`); return out; }

  // compatibility date
  const cd = cfg.compatibility_date as string | undefined;
  if (!cd) add("CFL003", "error", "compatibility_date is missing", 'add "compatibility_date": "<today>"');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(cd) || Number.isNaN(Date.parse(cd))) add("CFL003", "error", `compatibility_date "${cd}" is not YYYY-MM-DD`);
  else {
    const age = Math.floor((now.getTime() - Date.parse(cd)) / DAY);
    if (age > 180) add("CFL004", "warn", `compatibility_date ${cd} is ${age} days old (policy: doctor warns beyond 180)`, "bump it, run your e2e suite, and read the compat-date changelog for behaviour changes");
    else if (age < -1) add("CFL003", "warn", `compatibility_date ${cd} is in the future; wrangler rejects dates newer than the installed workerd`);
  }

  // bindings vs Env types
  const declared = declaredBindings(cfg);
  const env = envTypeKeys(dir);
  if (env.files.length) {
    const missing = [...declared].filter((b) => !env.keys.has(b));
    if (missing.length) add("CFL005", "warn", `bindings in wrangler but not in \`interface Env\` (${env.files.join(", ")}): ${missing.join(", ")}`, "add them to Env, or generate the types with `wrangler types`");
    const extra = [...env.keys].filter((k) => !declared.has(k) && !extraVarNames(dir).has(k) && !/^[a-z]/.test(k));
    if (extra.length) add("CFL006", "info", `\`interface Env\` members with no wrangler binding, var, or .dev.vars entry: ${extra.join(", ")} (fine for secrets set with \`cf-lite secrets push\`)`, "declare the binding/var, or list the secret in .dev.vars.example");
  } else if (declared.size) add("CFL005", "warn", "no `interface Env` found (server/env.d.ts or worker-configuration.d.ts)", "run `wrangler types` or declare `interface Env` so bindings are typed");

  // assets / run_worker_first
  const a = cfg.assets;
  if (a) {
    const rwf = a.run_worker_first;
    if (rwf === true || (Array.isArray(rwf) && rwf.includes("/*") && !rwf.some((x: string) => x.startsWith("!")))) add("CFL007", "warn", "assets.run_worker_first runs the Worker for every request, including static files (billed, slower)", 'scope it: ["/api/*"] (cf-lite adds SSR routes) or negate assets: ["/*", "!/assets/*"]');
    if (Array.isArray(rwf) && rwf.length && !a.binding && !cfg.main) add("CFL007", "error", "assets.run_worker_first is set but there is no Worker (`main`) to run", "add `main` or remove run_worker_first");
  }

  // cron / queues / DO consistency with conventions
  const crons = (cfg.triggers?.crons as string[] | undefined) ?? [];
  const cronFiles = listTs(join(dir, "server/cron"));
  if (cronFiles.length && !crons.length) add("CFL008", "warn", `server/cron has ${cronFiles.length} handler(s) but wrangler has no triggers.crons - they will never fire`, "`cf-lite add cron <name>` or add triggers.crons");
  else if (crons.length && !cronFiles.length && !existsSync(join(dir, "server/worker.ts"))) add("CFL008", "warn", "triggers.crons set but no server/cron handlers or worker.ts `scheduled()`");
  const qFiles = listTs(join(dir, "server/queues"));
  const producers = new Set((cfg.queues?.producers ?? []).map((p: any) => p.queue));
  const consumers = new Set((cfg.queues?.consumers ?? []).map((p: any) => p.queue));
  const unbound = qFiles.filter((q) => !consumers.has(q) && !producers.has(q));
  if (unbound.length) add("CFL008", "warn", `server/queues handler(s) with no wrangler queue entry: ${unbound.join(", ")}`, "`cf-lite add queue <name>`");
  const doBind = (cfg.durable_objects?.bindings ?? []) as Array<{ class_name: string }>;
  const migrated = new Set<string>((cfg.migrations ?? []).flatMap((m: any) => [...(m.new_classes ?? []), ...(m.new_sqlite_classes ?? [])]));
  const noMig = doBind.filter((b) => !b.class_name || (!migrated.has(b.class_name) && !(b as any).script_name)).map((b) => b.class_name);
  if (noMig.length) add("CFL009", "error", `Durable Object class(es) without a migration: ${noMig.join(", ")} - deploy will fail`, 'add { "tag": "vN", "new_sqlite_classes": ["Class"] } to migrations');
  const d1NoMig = (cfg.d1_databases ?? []).filter((d: any) => !existsSync(join(dir, d.migrations_dir ?? "migrations")));
  if (d1NoMig.length) add("CFL011", "info", `D1 binding(s) without a migrations directory: ${d1NoMig.map((d: any) => d.binding).join(", ")}`, "`cf-lite db new init` creates migrations/0001_init.sql");

  // draft mode: the enable endpoint fails closed (503) without DRAFT_SECRET
  try {
    if (JSON.parse(readFileSync(join(dir, ".cf-lite/meta.json"), "utf8")).draft && !declared.has("DRAFT_SECRET") && !extraVarNames(dir).has("DRAFT_SECRET"))
      add("CFL012", "warn", "`cfLite({ draft })` is on but DRAFT_SECRET is not declared (vars, .dev.vars or .dev.vars.example): /api/draft/enable answers 503", "set it: `openssl rand -base64 32` -> `cf-lite secrets push` / .dev.vars; list it in .dev.vars.example");
  } catch { /* no generated meta */ }

  // sso: the audience is required (verify fails closed with a 500 without it)
  const hasVar = (k: string) => declared.has(k) || extraVarNames(dir).has(k);
  if (hasVar("SSO_PUBLIC_KEYS") && !hasVar("SSO_AUDIENCE"))
    add("CFL013", "error", "SSO_PUBLIC_KEYS is set but SSO_AUDIENCE is not: modules/sso fails closed (500) without an expected `aud`", 'add "SSO_AUDIENCE": "<aud your issuer mints>" to vars (a plain var, not a secret)');

  // rsc (docs/rsc.md): only for apps that opt in
  const rsc = rscPages(dir);
  if (rsc.length) {
    const flags = (cfg.compatibility_flags as string[] | undefined) ?? [];
    if (!flags.includes("nodejs_compat") && !flags.includes("nodejs_als")) add("CFL014", "error", `${rsc.length} render="rsc" route(s) (${rsc[0]}${rsc.length > 1 ? ", ..." : ""}) but compatibility_flags has no "nodejs_compat": getRequest()/getEnv() use AsyncLocalStorage and fail at request time`, 'add "compatibility_flags": ["nodejs_compat"] (or "nodejs_als")');
    let pkg: any = {};
    try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { /* no package.json */ }
    const deps = { ...pkg.devDependencies, ...pkg.dependencies } as Record<string, string>;
    const missing = RSC_PKGS.filter((k) => !deps[k]);
    const ranged = RSC_PKGS.filter((k) => deps[k] && !semver(deps[k]));
    const probs: string[] = [];
    if (missing.length) probs.push(`missing: ${missing.join(", ")}`);
    if (ranged.length) probs.push(`not an exact version (RSC pins follow vinext, docs/design/rsc.md): ${ranged.map((k) => `${k}@${deps[k]}`).join(", ")}`);
    const pv = semver(deps["@vitejs/plugin-rsc"] ?? "");
    if (pv && semverGte(pv, [0, 5, 26]) < 0) probs.push(`@vitejs/plugin-rsc ${deps["@vitejs/plugin-rsc"]} is below the patched floor 0.5.26 (GHSA-w94c-4vhp-22gx and earlier RCE/file-read advisories)`);
    const r = semver(deps.react ?? ""), rd = deps["react-dom"], rs = deps["react-server-dom-webpack"];
    if (r && ((rd && rd !== deps.react) || (rs && rs !== deps.react))) probs.push("react, react-dom and react-server-dom-webpack must be the same version");
    if (r && !(r[0] === 19 && (r[1] >= 3 || semverGte(r, [19, 2, 8]) >= 0))) probs.push(`react ${deps.react} is below the patched floor 19.2.8 (Flight advisories, e.g. CVE-2026-44907)`);
    if (probs.length) add("CFL015", "error", `render="rsc" pages need pinned RSC dependencies - ${probs.join("; ")}`, "copy the exact versions from examples/site-rsc/package.json (bun add -E)");
    const csp = [join(dir, "public/_headers"), join(dir, "_headers")].filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
    const strictCsp = /content-security-policy[^\n]*script-src(?![^;\n]*'unsafe-inline')/i.test(csp);
    let nonceFlow = false;
    try { nonceFlow = /\bsecurity\s*\(/.test(readFileSync(join(dir, "server/middleware.ts"), "utf8") + (existsSync(join(dir, "server/worker.ts")) ? readFileSync(join(dir, "server/worker.ts"), "utf8") : "")); } catch { /* none */ }
    if (strictCsp && !nonceFlow) add("CFL016", "warn", "a script-src CSP without 'unsafe-inline' is set in _headers, but nothing stamps a nonce: the inline Flight payload and bootstrap script of render=\"rsc\" pages will be blocked (blank hydration, client islands dead)", "use security() in server/middleware.ts (per-request nonce; rsc routes then skip cache/isr), or set `hydrate = false` on pages that need no client JS");
  }

  // islands (docs/islands.md): props ship in the HTML, so a big one defeats the point. Only looks at a built dist/.
  for (const o of oversizedIslandProps(dir).slice(0, 5)) add("CFL017", "warn", `island "${o.id}" in ${o.file} carries ${o.bytes} bytes of props (warn above ${WARN_PROPS_BYTES}); they are inlined in the HTML and parsed before hydration`, "pass an id and fetch the data from the island (useEffect / client fetch), or trim the props to what the first paint needs");

  // dev tools (docs/preview.md, docs/mocks.md): generated behind import.meta.env.DEV, so a build must not contain them. Only looks at a built dist/.
  const dev = devToolsInBuild(dir);
  if (dev.length) add("CFL018", "error", `the built Worker contains dev-only code (${dev.join(", ")}): /__preview and mocks must never be deployed`, "build with `cf-lite build` (NODE_ENV=production) and remove a hand-written import of cf-lite/modules/preview or cf-lite/modules/mock from server/ code");

  // size budget (only when a build exists)
  const size = workerSizeGzip(dir);
  if (size) {
    const budget = opts.budgetKiB ?? 1024;
    if (size.kib > 3072) add("CFL010", "error", `Worker is ${size.kib} KiB gzipped: over the 3 MiB free-plan limit`, "move heavy deps (wasm, image tooling) to a service-bound Worker; `cf-lite analyze` shows what is big");
    else if (size.kib > budget) add("CFL010", "warn", `Worker is ${size.kib} KiB gzipped (budget ${budget} KiB)`, "run `cf-lite analyze`; check for accidental Node-heavy imports");
  }
  return out;
}

export const formatFindings = (f: Finding[]) => f.length
  ? f.map((x) => `${x.level.toUpperCase().padEnd(5)} ${x.code}  ${x.message}${x.fix ? `\n        fix: ${x.fix}` : ""}`).join("\n")
  : "no problems found";
