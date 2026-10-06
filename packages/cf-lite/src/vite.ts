/**
 * The whole "framework": one Vite plugin array.
 *   adapter.vite() - the UI framework's own Vite plugin(s) (react/preact/vue/svelte; none by default)
 *   cloudflare()   - workerd in dev, Worker + assets build (run_worker_first scoped to /api/* + ssr routes)
 *   cf-lite:gen    - (re)writes .cf-lite/{app,routes,handlers}.ts from the file conventions (src/conventions/). Build-time only.
 * Nothing here ships to the Worker at runtime.
 */
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import type { Alias, AliasOptions, Plugin, PluginOption } from "vite";
import { assetsRouting, toWorkerGlob, type ApiRoute, type PageRoute } from "./scan.js";
import { runConventions, type Generated } from "./generate.js";
import { iconsPlugin } from "./conventions/metadata.js";
import { builtinConventions, fitWorkerFirst, type Convention } from "./conventions/index.js";
import type { UiAdapter } from "./adapter.js";
import type { SecurityOptions } from "./modules/csp.js";
import { assetsHeaders, type AssetsHeadersOptions } from "./vite-fonts.js";
import { routeconfConvention, ROUTECONF_NAME } from "./conventions/routeconf.js";
import { routeconfAssets } from "./vite-routeconf.js";
import { stripServerCode } from "./vite-strip.js";
import type { CompiledRouteConf, RouteConf } from "./config.js";
import { i18nConvention } from "./conventions/i18n.js";
import type { I18nConfig } from "./modules/i18n.js";
import { draftConvention, type DraftConfig } from "./conventions/draft.js";
import type { IslandsAuto } from "./islands.js";
import { discoverIslands, islandTransform, islandVueTransform, islandsBuild } from "./vite-islands.js";
import { tsconfigAliases } from "./aliases.js";
import { viewTransitions, type ViewTransitionsOption } from "./vite-view-transitions.js";

export interface CfLiteOptions {
  root?: string;
  /** Extra wrangler config merged in (same shape as @cloudflare/vite-plugin `config`). */
  wrangler?: Record<string, unknown>;
  /** UI adapter, e.g. `react()` from @cf-lite/react. Default "none": no pages, no UI framework - API + your own index.html. */
  renderer?: UiAdapter | "none";
  /** Minify the Worker bundle (default true; Vite leaves server environments unminified otherwise). */
  minifyWorker?: boolean;
  /** Extra convention contributors, run after the built-in ones (docs/conventions.md). */
  conventions?: Convention<any>[];
  /** Default `_headers` (immutable hashed assets), merged with `public/_headers`. `false` disables it (WP-ASSETS). */
  headers?: false | AssetsHeadersOptions;
  /** Redirects / rewrites / headers compiled to `_redirects` + `_headers` + a Worker fallback (docs/route-config.md). */
  routeConf?: RouteConf;
  /** Security headers + CSP: static pages get a hash-based policy in `_headers` at build; pair with `security()` in `server/middleware.ts` for SSR nonces (WP-SECURITY, docs/security.md). */
  security?: SecurityOptions;
  /** Path-prefix locales for `app/routes/[locale]/**`: detection on `/`, catalogs, hreflang, sitemap alternates (WP-I18N, docs/i18n.md). */
  i18n?: I18nConfig;
  /** Draft mode wiring: installs `draft()`, mounts `/api/draft/*`, and serves prerendered pages on demand at `/__preview/*` (Worker-first) for previewers (docs/draft-mode.md). `true` = defaults. */
  draft?: true | DraftConfig;
  /** SSR islands (docs/islands.md): active when the adapter supports them and `*.island.tsx` files exist. `runtime: "preact"` runs the browser side on preact/compat (needs `preact` installed; ~3x smaller than react-dom). */
  islands?: { runtime?: "react" | "preact"; /** Auto-islands: interactive components become islands without a `*.island.tsx` name (the adapter's `detect` decides; React only today). `true` = defaults. */ auto?: true | IslandsAuto };
  /** View Transitions (docs/view-transitions.md): `true` adds the cross-document `@view-transition` rule to the HTML shell (static / prerendered / SSR / SPA pages; skipped under `prefers-reduced-motion`); `{ router: true }` also wraps the client router's SPA navigations in `document.startViewTransition`. Off by default. */
  viewTransitions?: ViewTransitionsOption;
}

const warnedIslands = new Set<string>(); // the config is evaluated more than once per command: say each auto-island note once

export interface GenerateResult extends Generated {
  pages: PageRoute[];
  api: ApiRoute[];
}

export function generate(root: string, ui?: UiAdapter | "none", extra: Convention<any>[] = [], routeConf?: RouteConf, security?: SecurityOptions, i18n?: I18nConfig, draft?: true | DraftConfig): GenerateResult {
  const adapter = ui && ui !== "none" ? ui : undefined;
  const g = runConventions(root, adapter, [...(routeConf ? [routeconfConvention(routeConf)] : []), ...(i18n ? [i18nConvention(i18n)] : []), ...builtinConventions, ...(draft ? [draftConvention(draft === true ? {} : draft)] : []), ...extra]);
  const out = join(root, ".cf-lite");
  mkdirSync(out, { recursive: true });
  const write = (name: string, body: string) => {
    const p = join(out, name);
    if (!existsSync(p) || readFileSync(p, "utf8") !== body) writeFileSync(p, body);
  };
  for (const [name, body] of Object.entries(g.files)) write(name, body);
  for (const stale of ["handlers.ts", "queues.ts", "workflows.ts", "workflow-classes.ts", "routeconf.ts", "do-classes.ts", "do.ts", "typed-routes.d.ts", "i18n.ts"]) if (!(stale in g.files)) rmSync(join(out, stale), { force: true });
  write("meta.json", JSON.stringify({ adapter: adapter?.id ?? null, options: adapter?.options, ...(security ? { security } : {}), ...(i18n ? { i18n } : {}), ...(draft ? { draft: true } : {}), ...(adapter?.islands && discoverIslands(root, adapter).length ? { islands: true } : {}), ...(adapter?.islands?.auto ? { islandsAuto: adapter.islands.auto } : {}) }) + "\n"); // read by prerender (which runs outside the user's vite config)
  return { ...g, pages: g.entries.pages as PageRoute[], api: g.entries.api as ApiRoute[] };
}

/** Best-effort read of the project's wrangler.jsonc/json (comments and trailing commas tolerated); null when absent/unparseable. */
function readWrangler(root: string): Record<string, unknown> | null {
  for (const f of ["wrangler.jsonc", "wrangler.json"]) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    try {
      const txt = readFileSync(p, "utf8").replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1");
      return JSON.parse(txt) as Record<string, unknown>;
    } catch { return null; }
  }
  return null;
}

/** Major version of the installed @cloudflare/vite-plugin (1 = stable, wrangler.jsonc; 2 = beta, cloudflare.config.ts + camelCase). */
function pluginMajor(): number {
  try {
    // package.json isn't in the plugin's `exports`: resolve its entry and walk up to the package root.
    let dir = dirname(fileURLToPath(import.meta.resolve("@cloudflare/vite-plugin")));
    while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
    return Number(/^\d+/.exec(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version)?.[0] ?? 1);
  } catch { return 1; }
}

/**
 * A root catch-all page (`[...all]`, `[[...all]]`) makes the generated `run_worker_first` `["/*"]`: every static asset would wake (and bill) the Worker.
 * Build the negations that keep static files in the assets layer: the hashed `/assets/*`, every top-level entry of `public/`, and the
 * prerendered pages (`/about` + `/about/`, or a `/blog/*` prefix for `paths()` pages unless an SSR page shares that prefix).
 * The list is known at config time (before the build output exists) because prerendered paths come from the route table.
 */
export function staticNegations(root: string, pages: PageRoute[], gated: string[] = []): string[] {
  const out = new Set<string>(["!/assets/*"]);
  const pub = join(root, "public");
  if (existsSync(pub)) for (const e of readdirSync(pub, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "_headers" || e.name === "_redirects") continue;
    out.add(e.isDirectory() ? `!/${e.name}/*` : `!/${e.name}`);
  }
  const dyn = pages.filter((p) => p.render === "ssr" || p.render === "rsc" || p.ssrFallback).map((p) => p.path);
  for (const p of pages.filter((q) => q.render === "static" && !q.ssrFallback)) {
    if (!/[:*]/.test(p.path)) { out.add("!" + p.path); if (p.path !== "/") out.add("!" + p.path + "/"); continue; }
    const g = toWorkerGlob(p.path);
    if (g !== "/*" && !dyn.some((d) => d.startsWith(g.slice(0, -1)) && !/^\/(:|\*)/.test(d))) out.add("!" + g);
  }
  // Cloudflare gives a negation precedence over a positive rule: a static file under a middleware-gated (or draft) path must stay Worker-first.
  const covers = (p: string, q: string) => (p.endsWith("*") ? q.startsWith(p.slice(0, -1)) : p === q);
  const gates = gated.filter((g) => !g.startsWith("!") && g !== "/*");
  return [...out].filter((n) => !gates.some((g) => covers(g, n.slice(1)) || covers(n.slice(1), g))).sort();
}

/** plugin-rsc wants the three environments by name; the Worker modules (ssr + rsc) must live under one dir for wrangler to upload them. */
function rscEnvironments(root: string) {
  return {
    rsc: { build: { outDir: "dist/ssr/rsc", rollupOptions: { input: { index: join(root, ".cf-lite/rsc-entry.tsx") } } } },
    ssr: { build: { outDir: "dist/ssr" } },
    client: { build: { rollupOptions: { input: { spa: join(root, "index.html"), index: join(root, ".cf-lite/rsc-browser.tsx") } /* plugin-rsc hardcodes the client entry name "index" */ } } },
  };
}

/** Where `"use server"` files may live in an rsc app: `app/actions/**` or `*.actions.(ts|tsx|js|jsx)`. This is the build-time half of the action allowlist (docs/design/rsc.md section 11). */
export const RSC_ACTION_FILE = /(?:^|\/)app\/actions\/|\.actions\.[cm]?[jt]sx?$/;
export function rscActions(root: string): Plugin {
  return {
    name: "cf-lite:rsc-actions",
    transform(code, id) {
      const f = id.split("?")[0]!;
      if (!/\.[cm]?[jt]sx?$/.test(f) || f.includes("/node_modules/") || !f.startsWith(root + "/")) return;
      if (!/^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(code)) return;
      const rel = f.slice(root.length + 1);
      if (!RSC_ACTION_FILE.test("/" + rel)) this.error(`cf-lite: "use server" is only allowed in app/actions/** or *.actions.ts (the server-action allowlist, docs/design/rsc.md). File: ${rel}`);
    },
  };
}

/** tsconfig aliases first; an adapter's own aliases (object or array form) keep working after them. */
const mergeAlias = (own: Alias[], other: AliasOptions | undefined): Alias[] => [...own, ...(Array.isArray(other) ? other : Object.entries(other ?? {}).map(([find, replacement]) => ({ find, replacement })))];

export function cfLite(opts: CfLiteOptions = {}): PluginOption[] {
  const root = resolve(opts.root ?? process.cwd());
  const given = opts.renderer ?? "none";
  const renderer = given !== "none" && given.islands && opts.islands?.auto ? { ...given, islands: { ...given.islands, auto: opts.islands.auto === true ? {} : opts.islands.auto } } : given; // islands.auto rides on the adapter object so conventions and the build see one source of truth
  const adapter = renderer === "none" ? undefined : renderer;
  const extra = opts.conventions ?? [];
  let gen0 = generate(root, renderer, extra, opts.routeConf, opts.security, opts.i18n, opts.draft);
  const { pages } = gen0;
  let dev = false; // set in the config hook below, before the Cloudflare plugin asks for its config
  const v2 = pluginMajor() >= 2;
  /** Opt-in RSC (docs/design/rsc.md): only when a page exports `render = "rsc"`; every other app builds exactly as before. */
  const rscOn = pages.some((p) => p.render === "rsc");
  /** Route-table-derived wrangler `assets` bits, plus the extra Worker-first globs contributors asked for. */
  const withExtra = (pg: PageRoute[], g: Generated, d: boolean) => {
    const r = assetsRouting(pg, d, opts.i18n?.locales);
    const w = readWrangler(root)?.assets as { run_worker_first?: unknown } | undefined;
    const existing = Array.isArray(w?.run_worker_first) ? (w.run_worker_first as string[]) : [];
    const merged = [...new Set([...r.ssrGlobs, ...g.workerFirst, ...(d ? g.devWorkerFirst : [])])].sort(); // devWorkerFirst: /__preview, dev only
    // root catch-all: "/*" without negations would run the Worker for every static file
    if (!d && merged.includes("/*") && !merged.some((x) => x.startsWith("!"))) merged.push(...staticNegations(root, pg, g.workerFirst));
    const f = fitWorkerFirst(merged, existing);
    if (f.conflicts.length) throw new Error(`cf-lite: the middleware matcher's run_worker_first globs ${JSON.stringify(f.globs)} make ${JSON.stringify(f.conflicts)} in wrangler's assets.run_worker_first redundant (Cloudflare rejects that) - delete those entries; cf-lite generates the list.`);
    if (f.fellBack) console.warn("[cf-lite] more than 100 run_worker_first entries; using [\"/*\", \"!/assets/*\"]");
    return { ssrGlobs: f.globs, notFound: r.notFound, sig: JSON.stringify([f.globs, r.notFound]) };
  };
  const routing = () => withExtra(pages, gen0, dev);
  const initial = () => routing().sig;

  const gen: Plugin = {
    name: "cf-lite:gen",
    configResolved(c) {
      const w = gen0.checks.length ? readWrangler(root) : null;
      if (w) for (const chk of gen0.checks) for (const msg of chk(w)) c.logger.warn(`[cf-lite] ${msg}`);
    },
    configureServer(server) {
      // Regenerate .cf-lite/* on route file add/unlink/change. `run_worker_first` / `not_found_handling` live in the
      // Cloudflare plugin's resolved config and cannot be hot-swapped, so when the route table changes them
      // (an SSR route appeared/disappeared, a route flipped to/from ssr, static "/" toggled) restart the dev server
      // programmatically - no manual restart.
      const startSig = initial();
      const regen = (f: string, structural = false) => {
        // routes/api/jobs/mocks/states: any event; other files under app/ (components for /__preview): only add/unlink (`structural`)
        if (!/[\\/](app[\\/]routes[\\/]|server[\\/]api[\\/]|server[\\/]routes[\\/]|server[\\/](?:cron|queues|workflows|email|do)[\\/]|server[\\/]middleware\.|mocks[\\/]|app[\\/].*\.states\.[cm]?[jt]sx?$|app[\\/]preview\.setup\.)/.test(f) && !(structural && /[\\/]app[\\/]/.test(f) && !f.includes("node_modules"))) return;
        try {
          gen0 = generate(root, renderer, extra, opts.routeConf, opts.security, opts.i18n, opts.draft);
          const next = withExtra(gen0.pages, gen0, true);
          if (next.sig !== startSig) {
            server.config.logger.info(`[cf-lite] routing changed (run_worker_first=${JSON.stringify(next.ssrGlobs)}) - restarting dev server`, { timestamp: true });
            void server.restart();
          }
        } catch (e) {
          server.config.logger.error(`[cf-lite] ${(e as Error).message}`, { timestamp: true });
        }
      };
      server.watcher.on("add", (f) => regen(f, true)).on("unlink", (f) => regen(f, true)).on("change", (f) => regen(f)); // render/hydrate exports may have changed
    },
  };
  const uiVite = adapter?.vite();
  const tsAliases = tsconfigAliases(root); // tsconfig `paths` -> resolve.alias (docs/coming-from-mvc.md); prerender does the same
  const islandFiles = adapter?.islands && !rscOn ? discoverIslands(root, adapter, (m) => { if (!warnedIslands.has(m)) { warnedIslands.add(m); console.warn(`[cf-lite] ${m}`); } }) : [];
  const islandPlugins = adapter?.islands && islandFiles.length ? [islandTransform(root, adapter, islandFiles), ...(islandFiles.some((f) => f.file.endsWith(".vue")) ? [islandVueTransform(root, adapter)] : []), islandsBuild(root, adapter, islandFiles, opts.islands?.runtime ?? "react")] : [];
  const rend: Plugin = {
    name: "cf-lite:renderer",
    // `__CFL_MOCK__`: MOCK=1 under `vite dev` only (docs/mocks.md); a build always compiles it to false
    config: (_c, env) => { dev = env.command === "serve"; return { ...uiVite?.config, ...(tsAliases.length ? { resolve: { ...uiVite?.config?.resolve, alias: mergeAlias(tsAliases, uiVite?.config?.resolve?.alias) } } : {}), define: { ...uiVite?.config?.define, __CFL_MOCK__: JSON.stringify(dev && /^(1|true)$/i.test(process.env.MOCK ?? "")) }, ...(rscOn ? { environments: rscEnvironments(root) } : {}), ssr: { ...uiVite?.config?.ssr, noExternal: [...(Array.isArray(uiVite?.config?.ssr?.noExternal) ? uiVite.config.ssr.noExternal : []), "cf-lite", ...(adapter ? [adapter.id] : [])] } } as never; },
    // Vite leaves server (Worker) environments unminified; a free gzip win for hono + app + UI runtime. Every non-client
    // environment here is a Worker one (the plugin names it after the Worker), and the consumer is not known yet at this hook.
    configEnvironment: (name, cfg) => (opts.minifyWorker === false || name === "client" || cfg.build?.minify !== undefined ? undefined : { build: { minify: true } }),
  };

  return [
    rend,
    ...(rscOn ? [import("@vitejs/plugin-rsc").then((m) => m.default({ serverHandler: false }), () => { throw new Error('cf-lite: a route exports render = "rsc" but @vitejs/plugin-rsc is not installed. Install the pinned set (docs/design/rsc.md): @vitejs/plugin-rsc@0.5.35 react@19.3.0 react-dom@19.3.0 react-server-dom-webpack@19.3.0 rsc-html-stream@0.0.8'); })] : []),
    ...(rscOn ? [rscActions(root)] : []),
    ...(uiVite?.plugins ?? []),
    ...islandPlugins,
    ...(opts.viewTransitions ? [viewTransitions(opts.viewTransitions)] : []),
    cloudflare({
      // The Worker (Hono app, react-dom/server) stays the `ssr` environment; `rsc` is a child bundled into the same Worker directory.
      ...(rscOn ? { viteEnvironment: { name: "ssr", childEnvironments: ["rsc"] } } : {}),
      // The customizer's return value is merged into wrangler.jsonc (arrays concatenate), so only add SSR globs.
      config: () => {
        const r = routing();
        return {
          ...(opts.wrangler as object),
          ...(r.ssrGlobs.length || r.notFound
            ? { assets: v2
                ? { ...(r.ssrGlobs.length ? { runWorkerFirst: r.ssrGlobs } : {}), ...(r.notFound ? { notFoundHandling: r.notFound } : {}) }
                : { ...(r.ssrGlobs.length ? { binding: "ASSETS", run_worker_first: r.ssrGlobs } : {}), ...(r.notFound ? { not_found_handling: r.notFound } : {}) } }
            : {}),
        } as never;
      },
    }),
    gen,
    stripServerCode(),
    iconsPlugin(root),
    ...(opts.headers === false ? [] : [assetsHeaders(opts.headers)]),
    routeconfAssets(() => gen0.entries[ROUTECONF_NAME] as CompiledRouteConf | undefined), // after assetsHeaders: appends to its _headers
  ];
}
export default cfLite;
