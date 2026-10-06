/**
 * Route config schema + build-time compiler (docs/route-config.md): `redirects`, `rewrites`, `headers` (+ a `security` hook) ->
 *   - `_redirects` / `_headers` text for the assets layer (static, placeholder and splat rules - free, no Worker invocation);
 *   - a runtime table for the Worker (conditional `has`/`missing` rules, rewrites, headers for Worker-served responses) and the
 *     `run_worker_first` globs that make ONLY those paths wake the Worker;
 *   - a limit report (assets-layer caps) that turns overflow into a clear build error.
 * Pure (no node APIs): usable from `vite.ts`, the dev middleware and tests.
 */
import { compileSource, type Condition, type RouteTable, type RuntimeRule } from "./modules/routeconf.js";

export type { Condition, RouteTable, RuntimeRule };

export interface RedirectRule {
  /** Path pattern: `/old`, `/blog/:slug`, `/docs/:rest*` (zero+ segments), `/x/:rest+`, `/files/*`. */
  source: string;
  /** Path (`/new/:slug`, `/n/:rest`) or absolute http(s) URL; placeholders allowed in the path only. */
  destination: string;
  /** 301 | 302 | 303 | 307 | 308 (default 308). */
  status?: 301 | 302 | 303 | 307 | 308;
  /** Only when every condition holds. Not expressible in `_redirects`: compiled to the Worker. */
  has?: Condition[];
  missing?: Condition[];
}

export interface RewriteRule {
  source: string;
  /** Internal path (served by the app/assets, URL unchanged) or another origin (proxied). Always handled by the Worker. */
  destination: string;
  has?: Condition[];
  missing?: Condition[];
}

export interface HeaderRule {
  source: string;
  headers: Record<string, string> | { key: string; value: string }[];
  has?: Condition[];
  missing?: Condition[];
}

export interface RouteConf {
  redirects?: RedirectRule[];
  rewrites?: RewriteRule[];
  /** Applied to static assets (`_headers`) and to every response the Worker produces. */
  headers?: HeaderRule[];
  /** Hook for WP-SECURITY presets: a header map applied to `/*` ahead of `headers`. */
  security?: Record<string, string> | false;
}

export const defineRouteConf = (c: RouteConf): RouteConf => c;

/** Assets-layer caps (verify against current Cloudflare docs before 1.0). */
export const LIMITS = { staticRedirects: 2000, dynamicRedirects: 100, headerRules: 100, lineLength: 1000 } as const;

export interface RouteConfReport {
  staticRedirects: number;
  dynamicRedirects: number;
  headerRules: number;
  workerRedirects: number;
  rewrites: number;
  workerHeaders: number;
}

export interface CompiledRouteConf {
  /** `_redirects` body ("" when none). */
  redirects: string;
  /** `_headers` body ("" when none). */
  headers: string;
  table: RouteTable;
  /** Worker-first globs for paths the assets layer cannot handle (conditional/rewrite rules only). */
  workerFirst: string[];
  report: RouteConfReport;
}

const ok = (v: unknown, w: string) => { if (!v) throw new Error(`cf-lite: route config: ${w}`); };
const has = (s: string) => /[:*]/.test(s);

/** Assets-layer pattern (`:name` one segment, trailing `*` splat) from a source, as 1-2 patterns (zero-or-more also matches the base). */
function assetsPatterns(source: string): { patterns: string[]; splat: string | undefined; unsupported: boolean } {
  const c = compileSource(source);
  if (c.kind === "static") return { patterns: [source], splat: undefined, unsupported: false };
  if (c.kind === "param") return { patterns: [source], splat: undefined, unsupported: false };
  if (c.kind === "splat1") return { patterns: [c.base === "/" ? "/*" : c.base + "/*"], splat: c.splat, unsupported: false };
  const star = c.base === "/" ? "/*" : c.base + "/*";
  return { patterns: c.base === "/" ? ["/*"] : [c.base, star], splat: c.splat, unsupported: false };
}

/** Worker-first glob(s) covering a source (over-approximates `:name` to `*`; the runtime regex is exact). */
export function sourceGlobs(source: string): string[] {
  const c = compileSource(source);
  const segs = source.split("/").slice(1).map((s) => (s === "" ? "" : /^:[A-Za-z_]\w*$/.test(s) ? "*" : /^(:\w+[*+]|\*)$/.test(s) ? "*" : s));
  const glob = segs.join("/") === "" ? "/" : "/" + segs.join("/");
  if (c.kind === "splat") return glob === "/*" ? ["/*"] : [glob.replace(/\/\*$/, ""), glob];
  return [glob];
}

function checkDestination(d: string, names: string[], what: string): void {
  ok(/^\/(?!\/)/.test(d) || /^https?:\/\/[^/:*]+(:\d+)?(\/|$|\?)/.test(d), `${what}: destination "${d}" must be a path starting with a single "/" or an absolute http(s) URL whose host has no placeholder`);
  ok(!/^\/(?::\w+[*+]|\*)/.test(d), `${what}: destination "${d}" must not begin with a wildcard placeholder (open-redirect risk)`);
  for (const m of d.matchAll(/:([A-Za-z_]\w*)/g)) ok(names.includes(m[1]), `${what}: destination uses :${m[1]} which source does not define`);
}

const toPairs = (h: HeaderRule["headers"]): [string, string][] => (Array.isArray(h) ? h.map((x) => [x.key, x.value] as [string, string]) : Object.entries(h));
const condKey = (r: { has?: unknown[]; missing?: unknown[] }) => !!(r.has?.length || r.missing?.length);

export function compileRouteConf(conf: RouteConf, opts: { reserved?: { staticRedirects?: number; dynamicRedirects?: number; headerRules?: number } } = {}): CompiledRouteConf {
  const table: RouteTable = { redirects: [], rewrites: [], headers: [] };
  const globs: string[] = [];
  const rLines: string[] = [], hBlocks = new Map<string, [string, string][]>();
  let staticN = 0, dynN = 0, hN = 0, workerR = 0, workerH = 0;

  for (const r of conf.redirects ?? []) {
    ok(r.source && r.destination, `redirect needs source and destination (${JSON.stringify(r)})`);
    const c = compileSource(r.source);
    const status = r.status ?? 308;
    ok([301, 302, 303, 307, 308].includes(status), `redirect ${r.source}: status ${status} is not a redirect status`);
    checkDestination(r.destination, c.names, `redirect ${r.source}`);
    table.redirects.push({ re: c.re, to: r.destination, status, has: r.has, missing: r.missing });
    if (condKey(r) || c.kind === "splat1") {
      // has/missing and `:name+` cannot be expressed in `_redirects`: the Worker handles them, only for their own glob.
      workerR++; globs.push(...sourceGlobs(r.source));
      continue;
    }
    const a = assetsPatterns(r.source);
    const dest = c.splat ? r.destination.replace(new RegExp(`:${c.splat}[*+]?`, "g"), ":splat") : r.destination.replace(/:([A-Za-z_]\w*)[*+]/g, ":$1");
    a.patterns.forEach((p, i) => {
      // the bare base of a zero-or-more rule has no splat value
      const d = i === 0 && a.patterns.length === 2 ? dest.replace(/\/?:splat/g, "") || "/" : dest;
      rLines.push(`${p} ${d} ${status}`);
      if (has(p)) dynN++; else staticN++;
    });
  }

  for (const r of conf.rewrites ?? []) {
    ok(r.source && r.destination, `rewrite needs source and destination (${JSON.stringify(r)})`);
    const c = compileSource(r.source);
    checkDestination(r.destination, c.names, `rewrite ${r.source}`);
    table.rewrites.push({ re: c.re, to: r.destination, has: r.has, missing: r.missing });
    globs.push(...sourceGlobs(r.source));
  }

  const rules: HeaderRule[] = [...(conf.security ? [{ source: "/*", headers: conf.security }] : []), ...(conf.headers ?? [])];
  for (const r of rules) {
    ok(r.source, `header rule needs a source (${JSON.stringify(r)})`);
    const c = compileSource(r.source);
    const pairs = toPairs(r.headers);
    ok(pairs.length, `header rule ${r.source} has no headers`);
    for (const [k, v] of pairs) ok(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k) && !/[\r\n]/.test(v), `header rule ${r.source}: invalid header "${k}"`);
    table.headers.push({ re: c.re, headers: pairs, has: r.has, missing: r.missing });
    if (condKey(r)) { workerH++; globs.push(...sourceGlobs(r.source)); continue; } // `_headers` has no conditions
    // `_headers` only styles assets-layer responses; Worker responses get the same table from the generated middleware.
    for (const p of assetsPatterns(r.source).patterns) {
      // rules with the same pattern share one block (the assets layer does not reliably merge duplicate blocks)
      hBlocks.set(p, [...(hBlocks.get(p) ?? []), ...pairs]);
    }
  }

  hN = hBlocks.size;
  const res = opts.reserved ?? {};
  const report: RouteConfReport = { staticRedirects: staticN, dynamicRedirects: dynN, headerRules: hN, workerRedirects: workerR, rewrites: table.rewrites.length, workerHeaders: workerH };
  const over: string[] = [];
  if (staticN + (res.staticRedirects ?? 0) > LIMITS.staticRedirects) over.push(`${staticN + (res.staticRedirects ?? 0)} static redirects (limit ${LIMITS.staticRedirects})`);
  if (dynN + (res.dynamicRedirects ?? 0) > LIMITS.dynamicRedirects) over.push(`${dynN + (res.dynamicRedirects ?? 0)} dynamic (placeholder/splat) redirects (limit ${LIMITS.dynamicRedirects})`);
  if (hN + (res.headerRules ?? 0) > LIMITS.headerRules) over.push(`${hN + (res.headerRules ?? 0)} header rules (limit ${LIMITS.headerRules})`);
  const long = rLines.find((l) => l.length > LIMITS.lineLength);
  if (long) over.push(`a _redirects line is ${long.length} characters (limit ${LIMITS.lineLength}): ${long.slice(0, 60)}...`);
  if (over.length) {
    throw new Error(`cf-lite: route config exceeds the Workers assets limits: ${over.join("; ")}. ` +
      `Move the long tail of redirects to account-level Bulk Redirects (Cloudflare zone feature: dashboard -> Rules -> Bulk Redirects; cf-lite makes no API calls), or collapse them into placeholder rules.`);
  }
  return {
    redirects: rLines.length ? rLines.join("\n") + "\n" : "",
    headers: [...hBlocks].map(([p, ps]) => `${p}\n${ps.map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n`).join("\n"),
    table,
    workerFirst: [...new Set(globs)],
    report,
  };
}

/** Count rules already in a hand-written `public/_redirects` / `_headers` so generated + user rules share the caps. */
export function countUserRules(redirects?: string, headers?: string): { staticRedirects: number; dynamicRedirects: number; headerRules: number } {
  const lines = (s?: string) => (s ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const rs = lines(redirects);
  const dyn = rs.filter((l) => has(l.split(/\s+/)[0] ?? "")).length;
  return { staticRedirects: rs.length - dyn, dynamicRedirects: dyn, headerRules: (headers ?? "").split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("#")).length };
}
