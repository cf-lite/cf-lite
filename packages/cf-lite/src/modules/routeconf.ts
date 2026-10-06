/**
 * Runtime half of the route config (`redirects` / `rewrites` / `headers`; docs/route-config.md). Pure (no node APIs), so it runs in the
 * Worker (generated `.cf-lite/routeconf.ts` calls `routeconfMiddleware`) and in `vite dev` (connect middleware) with the same semantics.
 * The build-time half (`_redirects` / `_headers` text, limits) is `../config.ts`.
 */

/** A request condition: `has` must all match, `missing` must all not match. `value` is an exact string (or a `/regex/` source with `regex: true`). */
export interface Condition {
  type: "header" | "cookie" | "host" | "query";
  /** Header / cookie / query-parameter name (ignored for `host`). */
  key?: string;
  /** Exact value; absent = "present with any value" (for `host`, required). */
  value?: string;
  /** Treat `value` as a regular expression source (anchored). */
  regex?: boolean;
}

/** One compiled rule as shipped to the Worker: source regex (named groups = placeholders) + destination template. */
export interface RuntimeRule {
  re: string;
  has?: Condition[];
  missing?: Condition[];
  /** redirects / rewrites: destination template (`:name` placeholders). */
  to?: string;
  /** redirects: status code. */
  status?: number;
  /** headers: [name, value][]. */
  headers?: [string, string][];
}

export interface RouteTable { redirects: RuntimeRule[]; rewrites: RuntimeRule[]; headers: RuntimeRule[] }

const esc = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Next-style source pattern -> anchored regex source with named groups, plus the `:name` placeholders it defines.
 * Supported: literal segments, `:name` (one segment), `:name*` (zero or more trailing segments), `:name+` (one or more), `*` (= `:splat*`),
 * all multi-segment forms only as the last segment. Anything else throws (build error, not a guess).
 */
export function compileSource(p: string): { re: string; names: string[]; kind: "static" | "param" | "splat" | "splat1"; base: string; splat?: string } {
  if (!p.startsWith("/")) throw new Error(`cf-lite: route-config source "${p}" must start with "/"`);
  const segs = p.split("/").slice(1);
  const names: string[] = [];
  let re = "", base = "", kind: "static" | "param" | "splat" | "splat1" = "static", splat: string | undefined;
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s === "" && last) { re += i === 0 ? "" : "/?"; base += i === 0 ? "" : "/"; return; }
    const m = /^:([A-Za-z_]\w*)([*+]?)$/.exec(s);
    const star = s === "*";
    if (star || (m && m[2])) {
      if (!last) throw new Error(`cf-lite: route-config source "${p}": "${s}" is only supported as the last segment`);
      const name = star ? "splat" : m![1];
      const zero = star || m![2] === "*";
      names.push(name); splat = name;
      re += zero ? `(?:/(?<${name}>.*))?` : `/(?<${name}>.+)`;
      kind = zero ? "splat" : "splat1";
      return;
    }
    if (m) { re += `/(?<${m[1]}>[^/]+)`; names.push(m[1]); base += "/" + s; if (kind === "static") kind = "param"; return; }
    if (/[:*()]/.test(s)) throw new Error(`cf-lite: route-config source "${p}": unsupported segment "${s}" (use literals, :name, :name*, :name+ or *)`);
    re += "/" + esc(s); base += "/" + s;
  });
  return { re: "^" + (re || "/") + "$", names, kind, base: base || "/", splat };
}

/** `/x/:id/:rest*` + params -> `/x/7/a/b`. Unknown / unmatched placeholders expand to "". */
export function expand(tpl: string, params: Record<string, string | undefined>): string {
  // an empty trailing splat drops its slash too: `/guide/:rest*` with no rest -> `/guide`
  return tpl.replace(/(\/?):([A-Za-z_]\w*)([*+]?)/g, (_m, sl: string, n: string, k: string) => (k && !params[n] ? "" : sl + (params[n] ?? "")));
}

function cond(c: Condition, req: Request, url: URL): boolean {
  let v: string | null | undefined;
  if (c.type === "header") v = req.headers.get(c.key ?? "");
  else if (c.type === "host") v = url.host;
  else if (c.type === "query") v = url.searchParams.get(c.key ?? "");
  else v = (req.headers.get("cookie") ?? "").split(/;\s*/).map((x) => x.split("=")).find(([k]) => k === c.key)?.slice(1).join("=");
  if (v === null || v === undefined) return false;
  if (c.value === undefined) return true;
  return c.regex ? new RegExp("^(?:" + c.value + ")$").test(v) : v === c.value;
}

/** Params when the rule matches this request (path + has/missing), else null. */
export function matchRule(r: RuntimeRule, req: Request, url: URL): Record<string, string> | null {
  const m = new RegExp(r.re).exec(url.pathname);
  if (!m) return null;
  if (r.has && !r.has.every((c) => cond(c, req, url))) return null;
  if (r.missing && r.missing.some((c) => cond(c, req, url))) return null;
  return { ...m.groups } as Record<string, string>;
}

/** Collapse a leading `//` (protocol-relative) so a captured splat can never turn a path target into another origin. */
const safePath = (p: string) => p.replace(/^[/\\]{2,}/, "/");

function target(tpl: string, params: Record<string, string>, url: URL): string {
  const t = expand(tpl, params);
  const [path, query] = t.split("?");
  if (/^https?:\/\//i.test(t)) return path + (query !== undefined ? "?" + query : url.search);
  return safePath(path) + (query !== undefined ? "?" + query : url.search);
}

export function redirectFor(t: RouteTable, req: Request): Response | null {
  const url = new URL(req.url);
  for (const r of t.redirects) {
    const p = matchRule(r, req, url);
    if (!p) continue;
    const to = target(r.to!, p, url);
    return new Response(null, { status: r.status ?? 308, headers: { location: /^https?:/i.test(to) ? to : new URL(to, url).toString() } });
  }
  return null;
}

export function rewriteFor(t: RouteTable, req: Request): { url: string; external: boolean } | null {
  const url = new URL(req.url);
  for (const r of t.rewrites) {
    const p = matchRule(r, req, url);
    if (!p) continue;
    const to = target(r.to!, p, url);
    return { url: new URL(to, url).toString(), external: /^https?:\/\//i.test(to) && new URL(to).origin !== url.origin };
  }
  return null;
}

/** Headers to add for this request (later matching rules append, like the assets layer's `_headers`). */
export function headersFor(t: RouteTable, req: Request): [string, string][] {
  const url = new URL(req.url);
  return t.headers.filter((r) => matchRule(r, req, url)).flatMap((r) => r.headers ?? []);
}

export function applyHeaders(h: Headers, add: [string, string][]): void {
  const seen = new Set<string>();
  for (const [k, v] of add) { const l = k.toLowerCase(); if (seen.has(l)) h.append(k, v); else { h.set(k, v); seen.add(l); } }
}

/** Marker on a request re-dispatched by an internal rewrite, so a rewrite can never loop. */
export const REWRITTEN = "x-cf-lite-rewritten";

/**
 * Hono middleware factory used by the generated app: redirects -> rewrites -> (next) -> headers on the way out.
 * `self` re-dispatches an internally-rewritten request through the whole app (falling back to the ASSETS binding on a 404).
 */
export function routeconfMiddleware(table: RouteTable, self: { app?: { fetch(r: Request, e: unknown, x: unknown): Response | Promise<Response> } }) {
  return async (c: { req: { raw: Request }; env: unknown; executionCtx: unknown; res: Response }, next: () => Promise<void>): Promise<Response | void> => {
    const req = c.req.raw;
    const done = (res: Response) => {
      const add = headersFor(table, req);
      if (!add.length) return res;
      const out = new Response(res.body, res);
      applyHeaders(out.headers, add);
      return out;
    };
    const redir = redirectFor(table, req);
    if (redir) return done(redir);
    if (!req.headers.has(REWRITTEN)) {
      const rw = rewriteFor(table, req);
      if (rw) {
        const init = new Request(rw.url, req);
        if (rw.external) return done(await fetch(init));
        init.headers.set(REWRITTEN, "1");
        let res = await self.app!.fetch(init, c.env, c.executionCtx);
        const assets = (c.env as { ASSETS?: { fetch(r: Request): Promise<Response> } } | undefined)?.ASSETS;
        if (res.status === 404 && assets) res = await assets.fetch(new Request(rw.url, req));
        return done(res);
      }
    }
    await next();
    const add = headersFor(table, req);
    if (add.length) { c.res = new Response(c.res.body, c.res); applyHeaders(c.res.headers, add); }
  };
}
