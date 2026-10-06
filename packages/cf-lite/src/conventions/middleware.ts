/**
 * `server/middleware.ts` -> one Hono middleware in front of `/api` and every page route, scoped by `export const config = { matcher }`.
 *
 * The matcher does two jobs from one source:
 *   - build time: compiled to `assets.run_worker_first` globs (negative `!` patterns for exclusions), so a path the matcher
 *     does not cover never wakes the Worker - static files and redirects stay free;
 *   - runtime: the same patterns compiled to regexes guard the middleware for paths that reach the Worker anyway (an `/api/*` call,
 *     an SSR page), so `matcher: ["/admin/:path*"]` does not run on `/api/hello`.
 * No `matcher` = every path (broad "gated site" mode): `run_worker_first: ["/*", "!/assets/*"]`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConvention } from "./types.js";

/** Cloudflare caps `assets.run_worker_first` at 100 entries (duplicates count). */
export const RUN_WORKER_FIRST_LIMIT = 100;
/** Vite's hashed build output; never wake the Worker for it, even in broad mode. */
const STATIC_PREFIXES = ["/assets/*"];

/**
 * Path normaliser the generated guard applies before testing the matcher regexes (emitted into the app via `.toString()`, so it must
 * stay self-contained). The SSR router ignores empty segments and percent-decodes each one (`/admin/`, `//admin`, `/%61dmin` all reach
 * the `/admin` route), so a regex tested against the raw `c.req.path` would let those variants skip the middleware. An encoded slash
 * (`%2F`) stays encoded: it is one segment to the router, not a path separator.
 */
export const normalizeGatePath = (p: string): string => {
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (!s) continue;
    let d = s;
    try { d = decodeURIComponent(s); } catch { /* keep raw */ }
    out.push(d.includes("/") ? s : d);
  }
  return "/" + out.join("/");
};

export interface MiddlewareEntry {
  file: string;
  /** Matcher patterns as written (`!`-prefixed = exclusion); empty = no `config.matcher`. */
  matcher: string[];
  hasDefault: boolean;
}

export interface CompiledMatcher {
  /** `run_worker_first` entries (positives, then `!` negatives). */
  globs: string[];
  /** Regex sources (anchored) for the in-Worker guard. */
  include: string[];
  exclude: string[];
}

const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * One Next-style path pattern -> { globs, regex sources }. Supported: literal segments, `:name` (one segment), `:name*` (zero or more
 * trailing segments), `:name+` (one or more), and `*` (anything, as in a wrangler glob). Anything else is a build error, not a guess.
 */
export function compilePattern(p: string): { globs: string[]; re: string } {
  if (!p.startsWith("/")) throw new Error(`cf-lite: middleware matcher "${p}" must start with "/"`);
  const segs = p.split("/").slice(1);
  let re = "", glob = "";
  const extra: string[] = [];
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    const m = /^:[A-Za-z_]\w*([*+]?)$/.exec(s);
    if (s === "" && last) { re += i === 0 ? "" : "/?"; glob += "/"; return; } // "/" or trailing slash
    if (s === "*" || (m && m[1] === "*") || (m && m[1] === "+")) {
      if (!last) throw new Error(`cf-lite: middleware matcher "${p}": "${s}" is only supported as the last segment`);
      const zero = s !== "*" && m![1] === "*";
      if (zero) extra.push((glob || "/").replace(/^$/, "/")); // `/a/:p*` also matches `/a`
      re += zero ? "(?:/.*)?" : "/.+";
      glob += "/*";
      return;
    }
    if (m) { re += "/[^/]+"; glob += "/*"; return; } // `:name` - over-approximated by the glob, exact in the regex
    if (/[:*()]/.test(s)) throw new Error(`cf-lite: middleware matcher "${p}": unsupported segment "${s}" (use literals, :name, :name*, :name+ or *)`);
    re += "/" + esc(s); glob += "/" + s;
  });
  const globs = [...new Set([...extra.map((g) => (g === "" ? "/" : g)), glob === "" ? "/" : glob])];
  // `/a/:p*` -> glob `/a/*` plus `/a`; the root `/:p*` collapses to `/*`
  return { globs: globs.filter((g) => !(g === "/" && glob === "/*")), re: "^" + (re || "/") + "$" };
}

export function compileMatcher(matcher: string[]): CompiledMatcher {
  const pos = matcher.filter((m) => !m.startsWith("!")).map((m) => compilePattern(m));
  const neg = matcher.filter((m) => m.startsWith("!")).map((m) => compilePattern(m.slice(1)));
  const includes = pos.length ? pos : [compilePattern("/:path*")];
  const uniq = (xs: string[]) => [...new Set(xs)];
  const globs = uniq(includes.flatMap((x) => x.globs));
  return {
    globs: [...globs, ...uniq(neg.flatMap((x) => x.globs)).map((g) => "!" + g)],
    include: uniq(includes.map((x) => x.re)),
    exclude: uniq(neg.map((x) => x.re)),
  };
}

/**
 * Make the merged globs acceptable to Cloudflare: it rejects a rule that a `...*` rule of the same polarity already covers
 * ("makes it redundant"), and more than 100 entries. `existing` = the array already in the project's wrangler config (the Cloudflare
 * plugin concatenates ours onto it, so we cannot edit those): ours are pruned against them; an existing rule that one of ours would
 * swallow is reported in `conflicts`. Over the limit: fall back to "everything except static prefixes".
 */
export function fitWorkerFirst(globs: string[], existing: string[] = []): { globs: string[]; fellBack: boolean; conflicts: string[] } {
  const neg = (g: string) => g.startsWith("!");
  const covers = (o: string, g: string) => o !== g && neg(o) === neg(g) && o.endsWith("*") && g.startsWith(o.slice(0, -1));
  const uniq = [...new Set(globs)].filter((g) => !existing.includes(g));
  const prune = (xs: string[]) => xs.filter((g) => !xs.some((o) => covers(o, g)) && !existing.some((o) => covers(o, g)));
  let kept = prune(uniq);
  let conflicts = existing.filter((e) => kept.some((g) => covers(g, e)));
  let fellBack = false;
  if (kept.length + existing.length > RUN_WORKER_FIRST_LIMIT) {
    fellBack = true;
    kept = ["/*", ...STATIC_PREFIXES.map((g) => "!" + g)].filter((g) => !existing.includes(g));
    conflicts = existing.filter((e) => kept.some((g) => covers(g, e)));
  }
  return { globs: kept, fellBack, conflicts };
}

/** Regex-simple static read of `export const config = { matcher: "/x" | ["/x", "!/y"] }`. */
export function readMatcher(src: string): string[] {
  const m = /matcher\s*:\s*(\[[^\]]*\]|"[^"]*"|'[^']*'|`[^`]*`)/.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((x) => x[1] ?? x[2] ?? x[3]);
}

export function scanMiddleware(root: string): MiddlewareEntry | null {
  for (const ext of ["ts", "tsx", "js", "mjs"]) {
    const file = `server/middleware.${ext}`;
    if (!existsSync(join(root, file))) continue;
    const src = readFileSync(join(root, file), "utf8");
    return { file, matcher: readMatcher(src), hasDefault: /export\s+default\b|export\s*\{[^}]*\bas\s+default\b/.test(src) };
  }
  return null;
}

export const middlewareConvention = defineConvention<MiddlewareEntry | null>({
  name: "middleware",
  scan: ({ root }) => scanMiddleware(root),
  emit: (mw) => {
    if (!mw) return {};
    const c = compileMatcher(mw.matcher);
    const broad = c.globs.includes("/*");
    const worker = broad ? ["/*", ...STATIC_PREFIXES.map((g) => "!" + g), ...c.globs.filter((g) => g.startsWith("!"))] : c.globs;
    const re = (xs: string[]) => "[" + xs.map((x) => `new RegExp(${JSON.stringify(x)})`).join(", ") + "]";
    return {
      imports: [`import mw from ${JSON.stringify("../" + mw.file.replace(/\.(tsx|ts|js|mjs)$/, ""))};`],
      declarations: [
        `const mwInclude: RegExp[] = ${re(c.include)};`,
        `const mwExclude: RegExp[] = ${re(c.exclude)};`,
        `const mwNorm = ${normalizeGatePath.toString().replace(/\s*\n\s*/g, " ").replace(/^\(?\s*p\s*\)?\s*=>/, "(p: string): string =>")};`,
        `const mwOn = (raw: string) => { const p = mwNorm(raw); return mwInclude.some((r) => r.test(p)) && !mwExclude.some((r) => r.test(p)); };`,
      ],
      appPre: [`  .use("*", (c, next) => (mwOn(c.req.path) ? mw(c, next) : next()))`],
      workerFirst: [...new Set(worker)],
      checks: [
        () => (mw.hasDefault ? [] : [`${mw.file} has no default export (a Hono middleware: \`export default async (c, next) => { ...; await next(); }\`)`]),
        (w) => {
          const a = (w.assets ?? {}) as Record<string, unknown>;
          const rwf = a.run_worker_first;
          return rwf === false ? [`${mw.file}: assets.run_worker_first is false in wrangler config; matched static paths would skip the middleware`] : [];
        },
        () => (c.globs.length > RUN_WORKER_FIRST_LIMIT ? [`${mw.file}: matcher compiles to ${c.globs.length} run_worker_first entries (limit ${RUN_WORKER_FIRST_LIMIT}); falling back to "/*" with static exclusions`] : []),
      ],
    };
  },
});
