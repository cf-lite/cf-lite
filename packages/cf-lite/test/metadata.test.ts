import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { builtinConventions } from "../src/conventions/index.js";
import { staticSitemap } from "../src/conventions/metadata.js";
import { runConventions } from "../src/generate.js";
import { scanPages } from "../src/scan.js";
import { absoluteUrl, configureSite, jsonLdScript, seo } from "../src/modules/seo.js";
import { buildSitemapFiles, isPreviewHost, previewNoindex, renderUrlset, robotsHandler, robotsTxt, sitemapHandler, manifestHandler } from "../src/modules/sitemap.js";
import { h, ogHandler, serializeOg } from "../src/modules/og.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const tmp = (files: Record<string, string>) => {
  const root = mkdtempSync(join(here, ".tmp-meta-"));
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), s); }
  return root;
};

describe("seo()", () => {
  it("expands openGraph/twitter/canonical/jsonLd into plain head tags with absolute urls", () => {
    const hd = seo({ title: "T", description: "D", path: "/posts/a", image: "/og.png", siteUrl: "https://ex.com/", jsonLd: { "@type": "BlogPosting", headline: "</script>" } });
    expect(hd.link).toEqual([{ rel: "canonical", href: "https://ex.com/posts/a" }]);
    const m = hd.meta!;
    expect(m).toContainEqual({ property: "og:url", content: "https://ex.com/posts/a" });
    expect(m).toContainEqual({ property: "og:image", content: "https://ex.com/og.png" });
    expect(m).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(m).toContainEqual({ name: "description", content: "D" });
    const ld = hd.script![0];
    expect(ld.type).toBe("application/ld+json");
    expect(ld.content).not.toContain("<");
    expect(JSON.parse(ld.content!)["@context"]).toBe("https://schema.org");
  });
  it("noindex, opt-outs and card default", () => {
    const hd = seo({ title: "T", noindex: true, openGraph: false });
    expect(hd.meta).toContainEqual({ name: "robots", content: "noindex, nofollow" });
    expect(hd.meta!.some((x) => x.property)).toBe(false);
    expect(hd.meta).toContainEqual({ name: "twitter:card", content: "summary" });
  });
  it("absoluteUrl uses configureSite and passes absolutes through", () => {
    configureSite("https://site.dev/");
    expect(absoluteUrl("/x")).toBe("https://site.dev/x");
    expect(absoluteUrl("https://o.com/y")).toBe("https://o.com/y");
    configureSite(undefined);
    expect(absoluteUrl("/x")).toBe("/x");
  });
  it("jsonLd keeps an explicit @context and supports arrays", () => {
    expect(JSON.parse(jsonLdScript([{ "@type": "A" }, { "@context": "x", "@type": "B" }]).content!).map((o: any) => o["@context"])).toEqual(["https://schema.org", "x"]);
  });
});

describe("sitemap", () => {
  const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `/p/${i}`, lastmod: "2026-01-01" }));
  it("single urlset is well-formed and escapes", () => {
    const f = buildSitemapFiles([{ url: "/a?x=1&y=2", lastmod: new Date("2026-02-03T00:00:00Z"), changefreq: "daily", priority: 0.8 }], { siteUrl: "https://ex.com" });
    expect(Object.keys(f)).toEqual(["sitemap.xml"]);
    expect(f["sitemap.xml"]).toContain(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`);
    expect(f["sitemap.xml"]).toContain("<loc>https://ex.com/a?x=1&amp;y=2</loc>");
    expect(f["sitemap.xml"]).toContain("<lastmod>2026-02-03T00:00:00.000Z</lastmod>");
    expect(f["sitemap.xml"]).toContain("<priority>0.8</priority>");
  });
  it("splits into an index at the url limit, every file <= limit, urls de-duplicated", () => {
    const f = buildSitemapFiles([...entries(120_001), { url: "/p/0" }], { siteUrl: "https://ex.com" });
    expect(Object.keys(f).sort()).toEqual(["sitemap-1.xml", "sitemap-2.xml", "sitemap-3.xml", "sitemap.xml"]);
    expect(f["sitemap.xml"]).toContain("<sitemapindex");
    expect(f["sitemap.xml"]).toContain("<loc>https://ex.com/sitemap-2.xml</loc>");
    expect(f["sitemap.xml"]).toContain("<lastmod>2026-01-01</lastmod>");
    const count = (x: string) => (x.match(/<url>/g) ?? []).length;
    expect(count(f["sitemap-1.xml"])).toBe(50_000);
    expect(count(f["sitemap-3.xml"])).toBe(20_001);
  });
  it("splits on byte budget too", () => {
    const f = buildSitemapFiles(entries(100), { siteUrl: "https://ex.com", maxBytes: 1000 });
    expect(Object.keys(f).length).toBeGreaterThan(3);
    for (const [k, v] of Object.entries(f)) if (k !== "sitemap.xml") expect(v.length).toBeLessThan(1400);
  });
  it("hreflang alternates add the xhtml namespace", () => {
    const x = renderUrlset([{ url: "/a", alternates: [{ hreflang: "fr", href: "/fr/a" }] }], "https://ex.com");
    expect(x).toContain(`xmlns:xhtml="http://www.w3.org/1999/xhtml"`);
    expect(x).toContain(`<xhtml:link rel="alternate" hreflang="fr" href="https://ex.com/fr/a"/>`);
  });
  it("handler: loader runs on miss, Cache API serves the second request (HIT), Last-Modified set", async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal("caches", { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } });
    const load = vi.fn(async () => entries(3));
    const app = new Hono().get("/sitemap.xml", sitemapHandler(load));
    const a = await app.request("https://ex.com/sitemap.xml", {}, undefined, { waitUntil: (p: Promise<unknown>) => p, passThroughOnException() {} } as never);
    expect(a.headers.get("x-cf-lite-sitemap")).toBe("MISS");
    expect(a.headers.get("last-modified")).toBe("Thu, 01 Jan 2026 00:00:00 GMT");
    await new Promise((r) => setTimeout(r, 10));
    const b = await app.request("https://ex.com/sitemap.xml");
    expect(b.headers.get("x-cf-lite-sitemap")).toBe("HIT");
    expect(await b.text()).toContain("https://ex.com/p/2");
    expect(load).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("robots / preview noindex / manifest", () => {
  it("robotsTxt", () => {
    expect(robotsTxt({ rules: [{ userAgent: "*", allow: "/", disallow: ["/admin"] }] }, "https://ex.com")).toBe("User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: https://ex.com/sitemap.xml\n");
  });
  it("preview hosts", () => {
    expect(isPreviewHost("app.acct.workers.dev")).toBe(true);
    expect(isPreviewHost("example.com")).toBe(false);
    expect(isPreviewHost("pr-1.example.com", ["pr-*.example.com"])).toBe(false);
  });
  it("robots.txt is Disallow: / on a workers.dev preview, configured on production", async () => {
    const app = new Hono().get("/robots.txt", robotsHandler({ rules: [{ allow: "/" }] })).use("*", previewNoindex()).get("/", (c) => c.text("hi"));
    const prev = await app.request("https://x.acct.workers.dev/robots.txt");
    expect(await prev.text()).toBe("User-agent: *\nDisallow: /\n");
    expect(prev.headers.get("x-robots-tag")).toContain("noindex");
    const prod = await app.request("https://example.com/robots.txt");
    expect(await prod.text()).toContain("Allow: /");
    expect(prod.headers.get("x-robots-tag")).toBeNull();
  });
  it("previewNoindex tags every response on previews only", async () => {
    const app = new Hono().use("*", previewNoindex()).get("/", (c) => c.text("hi"));
    expect((await app.request("https://x.workers.dev/")).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await app.request("https://example.com/")).headers.get("x-robots-tag")).toBeNull();
  });
  it("manifest", async () => {
    const r = await new Hono().get("/m", manifestHandler({ name: "A" })).request("/m");
    expect(r.headers.get("content-type")).toContain("application/manifest+json");
    expect(await r.json()).toEqual({ name: "A" });
  });
});

describe("og", () => {
  it("serializeOg calls components, flattens fragments, drops functions/null", () => {
    const Card = (p: any) => h("div", { style: { display: "flex" }, onClick() {} }, p.title, null, false);
    expect(serializeOg(h("section", null, h(Card as never, { title: "Hi" })))).toEqual({
      type: "section", props: { children: { type: "div", props: { style: { display: "flex" }, children: "Hi" } } },
    });
    expect(serializeOg({ type: "p", props: { children: ["a", { type: Symbol.for("react.fragment"), props: { children: ["b", "c"] } }] } })).toEqual({ type: "p", props: { children: ["a", "b", "c"] } });
  });
  const ctx = { waitUntil: (p: Promise<unknown>) => p, passThroughOnException() {} } as never;
  it("handler posts once to the OG binding, then serves from the Cache API; hash is stable", async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal("caches", { default: { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } } });
    const fetchSvc = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } }));
    const app = new Hono().get("/posts/:slug/opengraph-image.png", ogHandler(({ params }) => h("div", null, params.slug), { fonts: [{ name: "F", url: "/f.ttf" }] }));
    const env = { OG: { fetch: fetchSvc } };
    const a = await app.request("https://ex.com/posts/a/opengraph-image.png", {}, env, ctx);
    expect(a.headers.get("x-cf-lite-og")).toBe("MISS");
    const ha = a.headers.get("x-cf-lite-og-hash");
    await new Promise((r) => setTimeout(r, 10));
    const b = await app.request("https://ex.com/posts/a/opengraph-image.png", {}, env, ctx);
    expect(b.headers.get("x-cf-lite-og")).toBe("HIT");
    expect(fetchSvc).toHaveBeenCalledTimes(1);
    const c = await app.request("https://ex.com/posts/b/opengraph-image.png", {}, env, ctx);
    expect(c.headers.get("x-cf-lite-og-hash")).not.toBe(ha);
    const body = JSON.parse((fetchSvc.mock.calls[0] as any)[1].body);
    expect(body).toMatchObject({ width: 1200, height: 630, fonts: [{ url: "https://ex.com/f.ttf" }] });
    vi.unstubAllGlobals();
  });
  it("missing binding -> 501 with guidance", async () => {
    const app = new Hono().get("/o.png", ogHandler(() => h("div", null, "x"), { fonts: [{ name: "F", url: "/f.ttf" }] }));
    const r = await app.request("https://ex.com/o.png", {}, {}, ctx);
    expect(r.status).toBe(501);
  });
});

describe("metadata convention", () => {
  it("inert when unused", () => {
    const g = runConventions(tmp({ "server/api/hello.ts": "" }), undefined, builtinConventions);
    expect(g.files["app.ts"]).not.toMatch(/sitemap|opengraph|previewNoindex/);
  });
  it("wires sitemap/robots/manifest/_og and worker_first globs; _og.tsx is not a page", () => {
    const root = tmp({
      "server/sitemap.ts": "export default () => [];", "server/robots.ts": "export default {};", "server/manifest.ts": "export default { name: 'x' };",
      "app/routes/posts/[slug]/_og.tsx": "export const og = { fonts: [] }; export default () => null",
    });
    const g = runConventions(root, undefined, builtinConventions);
    const app = g.files["app.ts"];
    expect(app).toContain(`.get("/sitemap.xml"`);
    expect(app).toContain(`.get("/sitemap-:n{[0-9]+}.xml"`);
    expect(app).toContain(`.get("/robots.txt"`);
    expect(app).toContain(`.get("/manifest.webmanifest"`);
    expect(app).toContain(`.get("/posts/:slug/opengraph-image.png"`);
    expect(app).toContain("previewNoindex()");
    expect(g.workerFirst).toEqual(expect.arrayContaining(["/sitemap.xml", "/robots.txt", "/manifest.webmanifest", "/posts/*/opengraph-image.png"]));
    expect(scanPages(root)).toEqual([]);
    const warn = g.checks.flatMap((c) => c({} as never));
    expect(warn[0]).toMatch(/binding.*OG/);
    expect(g.checks.flatMap((c) => c({ services: [{ binding: "OG", service: "cf-lite-og" }] } as never))).toEqual([]);
  });
  it("staticSitemap from the route table: prerendered urls + fixed ssr pages, opt-out, skipped with server/sitemap", () => {
    const root = tmp({
      "app/routes/index.tsx": "export default () => null", "app/routes/secret.tsx": "export const sitemap = false;\nexport default () => null",
      "app/routes/live.tsx": "export const render = 'ssr';\nexport default () => null",
    });
    const pages = scanPages(root);
    const out = join(root, "dist"); mkdirSync(out);
    const files = staticSitemap({ root, outDir: out, pages, urls: ["/", "/secret", "/blog/a"], siteUrl: "https://ex.com" });
    expect(files).toHaveLength(1);
    const xml = readFileSync(files[0], "utf8");
    expect(xml).toContain("<loc>https://ex.com/blog/a</loc>");
    expect(xml).toContain("<loc>https://ex.com/</loc>");
    expect(xml).not.toContain("secret");
    expect(staticSitemap({ root, outDir: out, pages, urls: ["/"] })).toEqual([]); // no SITE_URL
    const root2 = tmp({ "app/routes/index.tsx": "export default () => null", "server/sitemap.ts": "export default () => []" });
    expect(staticSitemap({ root: root2, outDir: out, pages: scanPages(root2), urls: ["/"], siteUrl: "https://ex.com" })).toEqual([]);
    expect(existsSync(join(out, "sitemap.xml"))).toBe(true);
  });
});
