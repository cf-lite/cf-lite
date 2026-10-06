/**
 * Vite side of the route config: writes the compiled `_redirects` / `_headers` into the client build output (after the default
 * `_headers` plugin and merged with `public/_redirects` / `public/_headers`), and applies the same table in `vite dev`
 * (redirects + headers on every request, before Vite's own middleware; rewrites reach the Worker through the generated middleware).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import type { CompiledRouteConf } from "./config.js";
import { applyHeaders, headersFor, redirectFor } from "./modules/routeconf.js";

export function routeconfAssets(get: () => CompiledRouteConf | undefined): Plugin {
  let root = "", publicDir = "";
  return {
    name: "cf-lite:routeconf",
    configResolved(c) { root = c.root; publicDir = c.publicDir; },
    writeBundle: {
      order: "post",
      handler(opts) {
        const c = get();
        if (!c || (this.environment && this.environment.name !== "client")) return;
        const out = opts.dir ?? resolve(root, this.environment?.config.build.outDir ?? "dist");
        mkdirSync(out, { recursive: true });
        const user = (f: string) => (publicDir && existsSync(join(publicDir, f)) ? readFileSync(join(publicDir, f), "utf8").trim() : "");
        if (c.redirects) {
          const u = user("_redirects");
          writeFileSync(join(out, "_redirects"), c.redirects + (u ? `\n# --- public/_redirects ---\n${u}\n` : "")); // generated first: first match wins
        }
        if (c.headers) {
          const cur = existsSync(join(out, "_headers")) ? readFileSync(join(out, "_headers"), "utf8") : "";
          if (!cur.includes("# --- cf-lite route config ---")) writeFileSync(join(out, "_headers"), `${cur.trimEnd()}${cur ? "\n\n" : ""}# --- cf-lite route config ---\n${c.headers}`);
        }
      },
    },
    configureServer(server) {
      server.middlewares.use((nreq, nres, next) => {
        const c = get();
        if (!c || !nreq.url) return next();
        try {
          const h = new Headers();
          for (const [k, v] of Object.entries(nreq.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
          const req = new Request(new URL(nreq.url, `http://${nreq.headers.host ?? "localhost"}`), { headers: h });
          const redir = redirectFor(c.table, req);
          if (redir) {
            nres.statusCode = redir.status;
            nres.setHeader("location", redir.headers.get("location")!);
            for (const [k, v] of headersFor(c.table, req)) nres.setHeader(k, v);
            return void nres.end();
          }
          const add = headersFor(c.table, req);
          if (add.length) { const out = new Headers(); applyHeaders(out, add); out.forEach((v, k) => nres.setHeader(k, v)); }
        } catch (e) { server.config.logger.error(`[cf-lite] routeConf: ${(e as Error).message}`); }
        next();
      });
    },
  };
}
