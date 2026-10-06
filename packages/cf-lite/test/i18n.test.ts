import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { builtinConventions } from "../src/conventions/index.js";
import { i18nConvention } from "../src/conventions/i18n.js";
import { runConventions } from "../src/generate.js";
import { assetsRouting, scanPages } from "../src/scan.js";
import { headFor, injectHead, mergeHead } from "../src/head.js";
import { staticSitemap } from "../src/conventions/metadata.js";
import {
  alternatesFor, cookieValue, defineI18n, detectLocale, i18nHead, i18nMiddleware, loadMessages, localeCookie, localeParams,
  localizedEntries, localizePath, negotiate, parseAcceptLanguage, splitLocale, translator, withAlternates, type I18nConfig,
} from "../src/modules/i18n.js";

const cfg: I18nConfig = { locales: ["en", "vi", "pt-BR"], default: "en", countries: { VN: "vi", BR: "pt-BR" } };
const here = fileURLToPath(new URL(".", import.meta.url));
const tmp = (files: Record<string, string>) => {
  const root = mkdtempSync(join(here, ".tmp-i18n-"));
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), s); }
  return root;
};

describe("config", () => {
  it("accepts a valid config and rejects mistakes", () => {
    expect(defineI18n(cfg)).toBe(cfg);
    expect(() => defineI18n({ locales: [], default: "en" })).toThrow(/at least one/);
    expect(() => defineI18n({ locales: ["en"], default: "vi" })).toThrow(/default "vi"/);
    expect(() => defineI18n({ locales: ["en", "EN"], default: "en" })).toThrow(/duplicates/);
    expect(() => defineI18n({ locales: ["en", "a/b"], default: "en" })).toThrow(/language tag/);
    expect(() => defineI18n({ locales: ["en"], default: "en", countries: { VN: "vi" } })).toThrow(/countries\.VN/);
  });
});

describe("detection", () => {
  it("parses Accept-Language by q, dropping q=0 and *", () => {
    expect(parseAcceptLanguage("en;q=0.5, vi-VN, fr;q=0, *;q=0.1, de;q=0.9")).toEqual(["vi-VN", "de", "en"]);
    expect(parseAcceptLanguage(null)).toEqual([]);
  });
  it("negotiates exact, then primary language, in q order", () => {
    expect(negotiate("vi-VN,vi;q=0.9,en;q=0.8", cfg)).toBe("vi");
    expect(negotiate("pt-PT", cfg)).toBe("pt-BR");
    expect(negotiate("PT-br", cfg)).toBe("pt-BR");
    expect(negotiate("fr,en;q=0.5", cfg)).toBe("en");
    expect(negotiate("fr", cfg)).toBeUndefined();
  });
  it("cookie > Accept-Language > country > default", () => {
    expect(detectLocale({ cookie: "a=1; locale=vi", acceptLanguage: "en" }, cfg)).toBe("vi");
    expect(detectLocale({ cookie: "locale=xx", acceptLanguage: "pt" }, cfg)).toBe("pt-BR");
    expect(detectLocale({ acceptLanguage: "fr", country: "vn" }, cfg)).toBe("vi");
    expect(detectLocale({ acceptLanguage: "en", country: "VN" }, cfg)).toBe("en");
    expect(detectLocale({ acceptLanguage: "fr", country: "US" }, cfg)).toBe("en");
    expect(detectLocale({}, cfg)).toBe("en");
  });
  it("cookie helpers", () => {
    expect(cookieValue("x=1; locale=pt-BR", "locale")).toBe("pt-BR");
    expect(cookieValue("%", "locale")).toBeUndefined();
    expect(localeCookie(cfg, "vi")).toBe("locale=vi; Path=/; Max-Age=31536000; SameSite=Lax");
    expect(localeCookie({ ...cfg, cookie: "lang" }, "vi", { secure: true })).toMatch(/^lang=vi;.*; Secure$/);
  });
});

describe("paths", () => {
  it("splits and localizes", () => {
    expect(splitLocale("/vi/about/", cfg)).toEqual({ locale: "vi", rest: "/about" });
    expect(splitLocale("/vi", cfg)).toEqual({ locale: "vi", rest: "/" });
    expect(splitLocale("/about", cfg)).toEqual({ locale: undefined, rest: "/about" });
    expect(splitLocale("/xx/about", cfg).locale).toBeUndefined();
    expect(localizePath("/about", "vi")).toBe("/vi/about");
    expect(localizePath("/", "vi")).toBe("/vi");
    expect(localizePath("/en/about?x=1#h", "vi", cfg)).toBe("/vi/about?x=1#h");
    expect(localeParams(cfg, [{ slug: "a" }])).toEqual([{ slug: "a", locale: "en" }, { slug: "a", locale: "vi" }, { slug: "a", locale: "pt-BR" }]);
  });
});

describe("head / hreflang", () => {
  it("alternates include x-default and use langTags", () => {
    const a = alternatesFor({ ...cfg, langTags: { vi: "vi-VN" } }, "/a", "https://ex.com");
    expect(a).toEqual([
      { hreflang: "en", href: "https://ex.com/en/a" }, { hreflang: "vi-VN", href: "https://ex.com/vi/a" },
      { hreflang: "pt-BR", href: "https://ex.com/pt-BR/a" }, { hreflang: "x-default", href: "https://ex.com/en/a" },
    ]);
  });
  it("i18nHead sets lang + alternates from params and url; inert for an unknown locale", () => {
    const h = i18nHead(cfg, { siteUrl: "https://ex.com" });
    const hd = h({ params: { locale: "vi" }, url: "/vi/posts/x/" });
    expect(hd.htmlAttrs).toEqual({ lang: "vi" });
    expect(hd.link).toContainEqual({ rel: "alternate", hreflang: "en", href: "https://ex.com/en/posts/x" });
    expect(h({ params: { locale: "zz" }, url: "/zz/x" })).toEqual({});
    expect(h({ params: { locale: "en" } }).link).toBeUndefined();
  });
  it("htmlAttrs merge (inner wins) and inject into <html>", () => {
    const m = mergeHead([{ htmlAttrs: { lang: "en", dir: "ltr" } }, { htmlAttrs: { lang: "vi" } }]);
    expect(m.htmlAttrs).toEqual({ lang: "vi", dir: "ltr" });
    expect(injectHead(`<html lang="en"><head></head>`, m)).toBe(`<html lang="vi" dir="ltr"><head></head>`);
    expect(injectHead(`<html><head></head>`, { htmlAttrs: { lang: "a&b" } })).toContain(`<html lang="a&amp;b">`);
    expect(injectHead(`<HTML class=x lang=en data-a="1"><head></head>`, { htmlAttrs: { lang: "vi" } })).toBe(`<html class=x lang="vi" data-a="1"><head></head>`);
  });
  it("HeadCtx.url reaches the head function", () => {
    const mod = { head: ({ url }: { url?: string }) => ({ title: url }) };
    expect(headFor([mod], { params: {}, data: undefined, url: "/x" }).title).toBe("/x");
  });
});

describe("sitemap alternates", () => {
  it("groups `/<locale>/path` entries with alternates and x-default; others pass through", () => {
    const out = withAlternates([{ url: "/en/a" }, { url: "/vi/a" }, { url: "/en/only" }, { url: "/about" }], cfg, "https://ex.com");
    expect(out[0].alternates).toEqual([{ hreflang: "en", href: "https://ex.com/en/a" }, { hreflang: "vi", href: "https://ex.com/vi/a" }, { hreflang: "x-default", href: "https://ex.com/en/a" }]);
    expect(out[1].alternates).toHaveLength(3);
    expect(out[2].alternates).toBeUndefined();
    expect(out[3]).toEqual({ url: "/about" });
  });
  it("localizedEntries expands every path per locale", () => {
    const out = localizedEntries(["/", { url: "/a", lastmod: "2026-01-01" }], cfg, "https://ex.com");
    expect(out.map((e) => e.url)).toEqual(["/en", "/vi", "/pt-BR", "/en/a", "/vi/a", "/pt-BR/a"]);
    expect(out[4].lastmod).toBe("2026-01-01");
    expect(out[4].alternates).toHaveLength(4);
  });
  it("staticSitemap writes alternates for prerendered locale pages", () => {
    const root = tmp({});
    const files = staticSitemap({ root, outDir: root, pages: [], urls: ["/en/a", "/vi/a", "/en", "/vi"], siteUrl: "https://ex.com", i18n: cfg });
    const xml = readFileSync(files[0], "utf8");
    expect(xml).toContain("xmlns:xhtml");
    expect(xml).toContain(`<xhtml:link rel="alternate" hreflang="vi" href="https://ex.com/vi/a"/>`);
    expect(xml).toContain(`hreflang="x-default" href="https://ex.com/en"`);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("catalogs", () => {
  const en = { hi: "Hello {name}", nav: { home: "Home", about: "About" }, n: { one: "{count} item", other: "{count} items" }, only: "en only" };
  const vi = { hi: "Xin chào {name}", nav: { home: "Trang chủ" }, n: { other: "{count} mục" } };
  const cats = { en: async () => en, vi: async () => ({ default: vi }) };
  it("loads with the default locale as fallback (deep merge; unknown locale = default)", async () => {
    const m = await loadMessages(cfg, cats, "vi");
    expect(m).toEqual({ hi: "Xin chào {name}", nav: { home: "Trang chủ", about: "About" }, n: { other: "{count} mục" }, only: "en only" });
    expect(await loadMessages(cfg, cats, "en")).toEqual(en);
    expect(await loadMessages(cfg, cats, "pt-BR")).toEqual(en);
  });
  it("t(): interpolation, dotted keys, plurals, missing keys", async () => {
    const miss: string[] = [];
    const tr = translator(await loadMessages(cfg, cats, "en"), "en", { onMissing: (k) => miss.push(k) });
    expect(tr.t("hi", { name: "A" })).toBe("Hello A");
    expect(tr.t("hi")).toBe("Hello {name}");
    expect(tr.t("nav.about")).toBe("About");
    expect(tr.t("n", { count: 1 })).toBe("1 item");
    expect(tr.t("n", { count: 5 })).toBe("5 items");
    expect(tr.t("nope.x")).toBe("nope.x");
    expect(tr.t("nav")).toBe("nav"); // a branch is not a message
    expect(miss).toEqual(["nope.x", "nav"]);
    expect(tr.has("nav.home")).toBe(true);
    expect(tr.number(1234.5)).toBe("1,234.5");
    expect(translator({}, "vi").number(1234.5)).toBe("1.234,5");
    expect(translator({ z: { zero: "none", other: "{count} x" } }, "en").t("z", { count: 0 })).toBe("none");
  });
});

describe("middleware", () => {
  const routes = ["/:locale", "/:locale/about", "/:locale/posts/:slug"];
  const app = new Hono().use("*", i18nMiddleware(cfg, { routes, rootSlash: true }))
    .get("/:locale/about", (c) => c.html("<p>about</p>"))
    .get("/sitemap.xml", (c) => c.text("sm"))
    .get("/:locale", (c) => c.text("home"))
    .get("/api/x", (c) => c.json({ ok: 1 }));
  const go = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) => app.request(path, { headers, redirect: "manual", ...init });

  it("redirects `/` and unprefixed localized paths by detection (307, Vary, query kept)", async () => {
    let r = await go("/", { "accept-language": "vi" });
    expect([r.status, r.headers.get("location"), r.headers.get("vary")]).toEqual([307, "/vi/", "Accept-Language, Cookie"]);
    r = await go("/about?a=1", { cookie: "locale=pt-BR" });
    expect(r.headers.get("location")).toBe("/pt-BR/about?a=1");
    expect((await go("/posts/hello")).headers.get("location")).toBe("/en/posts/hello");
  });
  it("passes prefixed paths through and adds Content-Language to HTML", async () => {
    const r = await go("/vi/about");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-language")).toBe("vi");
    expect((await go("/vi")).headers.get("content-language")).toBeNull(); // text/plain
  });
  it("404s an unknown prefix on a localized route, but not other Worker routes", async () => {
    expect((await go("/xx/about")).status).toBe(404);
    expect((await go("/sitemap.xml")).status).toBe(200);
    expect((await go("/api/x")).status).toBe(200);
  });
  it("only redirects GET/HEAD", async () => {
    expect((await go("/about", {}, { method: "POST" })).status).toBe(404);
    expect((await go("/about", {}, { method: "HEAD" })).status).toBe(307);
  });
});

describe("convention", () => {
  const adapter = { id: "x", extensions: [".tsx"], server: "x/server" } as never;
  const page = (extra = "") => `export const render = "static"; export const paths = () => []; export default () => null; ${extra}`;
  it("emits config file, middleware, and the narrow Worker-first set; detection wiring only for localized pages", () => {
    const root = tmp({
      "app/routes/[locale]/index.tsx": page(), "app/routes/[locale]/about.tsx": page(),
      "app/routes/[locale]/posts/[slug].tsx": `export const render = "ssr"; export default () => null;`, "app/routes/plain.tsx": `export default () => null;`,
    });
    const g = runConventions(root, adapter, [i18nConvention(cfg), ...builtinConventions]);
    expect(g.files["i18n.ts"]).toContain(`export const i18n = {`);
    expect(g.files["i18n.ts"]).toContain(`"/:locale/posts/:slug"`);
    expect(g.files["app.ts"]).toMatch(/\.use\("\*", i18nMiddleware\(i18n, \{ routes: \["\/:locale","\/:locale\/about","\/:locale\/posts\/:slug"\], rootSlash: true \}\)/);
    expect(g.workerFirst).toEqual(expect.arrayContaining(["/", "/about", "/posts/*"]));
    expect(g.workerFirst).not.toContain("/*");
    const pages = scanPages(root, "app/routes", [".tsx"]);
    // SSR under [locale] is one glob per locale, never `/*`
    expect(assetsRouting(pages, false, cfg.locales).ssrGlobs).toEqual(["/en/posts/*", "/pt-BR/posts/*", "/vi/posts/*"]);
    expect(assetsRouting(pages, false).ssrGlobs).toEqual(["/*"]);
    rmSync(root, { recursive: true, force: true });
  });
  it("a static [locale] page without paths() is a clear error; no localized page warns", () => {
    const bad = tmp({ "app/routes/[locale]/a.tsx": `export const render = "static"; export default () => null;` });
    expect(() => runConventions(bad, adapter, [i18nConvention(cfg), ...builtinConventions])).toThrow(/paths\(\)/);
    const none = tmp({ "app/routes/a.tsx": `export default () => null;` });
    const g = runConventions(none, adapter, [i18nConvention(cfg), ...builtinConventions]);
    expect(g.checks.flatMap((c) => c({}))).toEqual([expect.stringMatching(/no page under app\/routes\/\[locale\]/)]);
    for (const r of [bad, none]) rmSync(r, { recursive: true, force: true });
  });
  it("rejects an invalid config at scan time", () => {
    expect(() => runConventions(tmp({}), adapter, [i18nConvention({ locales: ["en"], default: "fr" }), ...builtinConventions])).toThrow(/default "fr"/);
  });
});
