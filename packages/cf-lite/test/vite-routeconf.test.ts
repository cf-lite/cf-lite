import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileRouteConf } from "../src/config.js";
import { routeconfAssets } from "../src/vite-routeconf.js";

const conf = compileRouteConf({
  redirects: [{ source: "/old", destination: "/new", status: 301 }],
  headers: [{ source: "/:p*", headers: [{ key: "x-frame", value: "deny" }] }],
} as any);

const plugin = (get: () => any, root: string, publicDir = "") => {
  const p = routeconfAssets(get) as any;
  p.configResolved({ root, publicDir });
  return p;
};

describe("routeconfAssets (vite plugin)", () => {
  it("writeBundle: generated _redirects first, user's public/_redirects appended; _headers merged once (idempotent)", () => {
    const d = mkdtempSync(join(tmpdir(), "rc-")); const pub = join(d, "public"); mkdirSync(pub); mkdirSync(join(d, "dist"));
    writeFileSync(join(pub, "_redirects"), "/legacy /l 302");
    writeFileSync(join(d, "dist", "_headers"), "/*\n  X-A: 1\n");
    const p = plugin(() => conf, d, pub);
    const run = () => p.writeBundle.handler.call({ environment: { name: "client", config: { build: { outDir: "dist" } } } }, { dir: join(d, "dist") });
    run(); run();
    const red = readFileSync(join(d, "dist", "_redirects"), "utf8");
    expect(red.indexOf("/old")).toBeLessThan(red.indexOf("/legacy"));
    const hdr = readFileSync(join(d, "dist", "_headers"), "utf8");
    expect(hdr.startsWith("/*\n  X-A: 1")).toBe(true);
    expect(hdr.match(/# --- cf-lite route config ---/g)).toHaveLength(1);
  });
  it("no config or a non-client environment writes nothing", () => {
    const d = mkdtempSync(join(tmpdir(), "rc-"));
    plugin(() => undefined, d).writeBundle.handler.call({}, { dir: d });
    plugin(() => conf, d).writeBundle.handler.call({ environment: { name: "ssr" } }, { dir: d });
    expect(existsSync(join(d, "_redirects"))).toBe(false);
  });
  it("falls back to <root>/dist when no dir is given and creates it", () => {
    const d = mkdtempSync(join(tmpdir(), "rc-"));
    plugin(() => conf, d).writeBundle.handler.call({}, {});
    expect(existsSync(join(d, "dist", "_redirects"))).toBe(true);
  });
  describe("dev middleware", () => {
    const setup = (get = () => conf as any) => {
      let mw!: (...a: any[]) => void;
      const errors: string[] = [];
      plugin(get, "/x").configureServer({ middlewares: { use: (f: any) => (mw = f) }, config: { logger: { error: (m: string) => errors.push(m) } } });
      const call = (url: string | undefined, headers: Record<string, any> = {}) => {
        const res: any = { statusCode: 200, h: {} as Record<string, string>, ended: false, setHeader(k: string, v: string) { this.h[k.toLowerCase()] = v; }, end() { this.ended = true; } };
        const next = vi.fn();
        mw({ url, headers: { host: "localhost:5173", ...headers } }, res, next);
        return { res, next };
      };
      return { call, errors };
    };
    it("redirects before vite, with status + location + matching headers", () => {
      const { res, next } = setup().call("/old?q=1");
      expect(res.statusCode).toBe(301); expect(res.h.location).toBe("http://localhost:5173/new?q=1"); expect(res.h["x-frame"]).toBe("deny");
      expect(res.ended).toBe(true); expect(next).not.toHaveBeenCalled();
    });
    it("non-redirect requests get headers and continue", () => {
      const { res, next } = setup().call("/page", { "x-multi": ["a", "b"] });
      expect(res.h["x-frame"]).toBe("deny"); expect(next).toHaveBeenCalledOnce(); expect(res.ended).toBe(false);
    });
    it("no config / no url passes straight through; a rule error is logged and never breaks the request", () => {
      expect(setup(() => undefined as any).call("/old").next).toHaveBeenCalledOnce();
      expect(setup().call(undefined).next).toHaveBeenCalledOnce();
      const bad = { table: { redirects: [{ re: "(", to: "/x" }], rewrites: [], headers: [] } } as any;
      const s = setup(() => bad); const { next } = s.call("/a");
      expect(next).toHaveBeenCalledOnce(); expect(s.errors[0]).toMatch(/routeConf/);
    });
  });
});
