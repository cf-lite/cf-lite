/**
 * OPTIONAL module. Path-prefix i18n (`/en/...`, `/vi/...`): locale detection on `/` and unprefixed paths only, message catalogs (plain JSON,
 * loaded per locale with the default locale as fallback), a tiny `t()` (interpolation, plurals via Intl.PluralRules), `<html lang>` + `hreflang`
 * alternates through `head`, and sitemap alternates. Docs: docs/i18n.md. Pure (no node APIs): usable in the Worker, at prerender and in the browser.
 *
 * The config is given to `cfLite({ i18n })`; the plugin writes it to `.cf-lite/i18n.ts` (`export const i18n`) so pages can import it.
 */
import type { MiddlewareHandler } from "hono";
import type { Head } from "../head.js";
import { matchPath } from "../match.js";
import { absoluteUrl } from "./seo.js";
import type { SitemapEntry } from "./sitemap.js";

export interface I18nConfig {
  /** Locale tags as they appear in URLs (`["en", "vi"]`, `pt-BR` is fine). */
  locales: readonly string[];
  /** Served for `/` when nothing else matches; also the catalog fallback and the `x-default` alternate. */
  default: string;
  /** Cookie that remembers an explicit choice (default `locale`). It wins over `Accept-Language`. */
  cookie?: string;
  /** Optional `request.cf.country` (ISO 3166-1 alpha-2) -> locale, consulted after `Accept-Language` finds nothing. */
  countries?: Record<string, string>;
  /** `<html lang>` / hreflang value per locale when it differs from the URL tag (default: the tag itself). */
  langTags?: Record<string, string>;
}

const TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const DEFAULT_COOKIE = "locale";

/** Validates and returns the config (throws on a mistake that would only surface as a confusing 404 later). */
export function defineI18n<const C extends I18nConfig>(c: C): C {
  const err = (m: string) => { throw new Error(`cf-lite: i18n: ${m}`); };
  if (!c.locales?.length) err("`locales` must list at least one locale");
  for (const l of c.locales) if (!TAG.test(l)) err(`locale "${l}" is not a language tag like "en" or "pt-BR"`);
  if (new Set(c.locales.map((l) => l.toLowerCase())).size !== c.locales.length) err("`locales` has duplicates (comparison is case-insensitive)");
  if (!c.locales.includes(c.default)) err(`default "${c.default}" is not in locales ${JSON.stringify(c.locales)}`);
  for (const [country, l] of Object.entries(c.countries ?? {})) if (!c.locales.includes(l)) err(`countries.${country} -> "${l}" is not in locales`);
  return c;
}

// ---- detection -----------------------------------------------------------------------------------------------------------

/** `vi-VN,vi;q=0.9,en;q=0.8` -> tags by descending q (stable; `q=0` and `*` dropped). */
export function parseAcceptLanguage(h: string | null | undefined): string[] {
  if (!h) return [];
  return h.split(",").map((p, i) => {
    const [tag, ...params] = p.trim().split(";");
    const q = params.map((x) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(x)?.[1]).find((x) => x !== undefined);
    return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), i };
  }).filter((x) => x.tag && x.tag !== "*" && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i).map((x) => x.tag);
}

const find = (cfg: I18nConfig, tag: string) => cfg.locales.find((l) => l.toLowerCase() === tag.toLowerCase());

/** Best locale for an `Accept-Language` header: exact tag, then same primary language (`vi-VN` -> `vi`, `pt-PT` -> `pt-BR`). */
export function negotiate(header: string | null | undefined, cfg: I18nConfig): string | undefined {
  for (const tag of parseAcceptLanguage(header)) {
    const exact = find(cfg, tag);
    if (exact) return exact;
    const primary = tag.split("-")[0].toLowerCase();
    const loose = find(cfg, primary) ?? cfg.locales.find((l) => l.split("-")[0].toLowerCase() === primary);
    if (loose) return loose;
  }
  return undefined;
}

export function cookieValue(cookieHeader: string | null | undefined, name: string): string | undefined {
  for (const part of (cookieHeader ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; } }
  }
  return undefined;
}

/** cookie (explicit choice) > Accept-Language > country > default. */
export function detectLocale(req: { cookie?: string | null; acceptLanguage?: string | null; country?: string | null }, cfg: I18nConfig): string {
  const fromCookie = cookieValue(req.cookie, cfg.cookie ?? DEFAULT_COOKIE);
  const c = fromCookie ? find(cfg, fromCookie) : undefined;
  if (c) return c;
  const a = negotiate(req.acceptLanguage, cfg);
  if (a) return a;
  const country = req.country ? cfg.countries?.[req.country.toUpperCase()] : undefined;
  return country && find(cfg, country) ? find(cfg, country)! : cfg.default;
}

/** `Set-Cookie` value remembering an explicit locale choice (one year, `SameSite=Lax`). Also usable as `document.cookie = ...` in a switcher. */
export function localeCookie(cfg: I18nConfig, locale: string, o: { secure?: boolean } = {}): string {
  return `${cfg.cookie ?? DEFAULT_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax${o.secure ? "; Secure" : ""}`;
}

// ---- paths -------------------------------------------------------------------------------------------------------------------

/** `/vi/about` -> `{ locale: "vi", rest: "/about" }`; `/about` -> `{ rest: "/about" }`. `rest` keeps no trailing slash (except `/`). */
export function splitLocale(pathname: string, cfg: I18nConfig): { locale?: string; rest: string } {
  const segs = pathname.split("/").filter(Boolean);
  const locale = segs[0] ? cfg.locales.find((l) => l === segs[0]) : undefined;
  return { locale, rest: "/" + (locale ? segs.slice(1) : segs).join("/") };
}
export const stripLocale = (pathname: string, cfg: I18nConfig): string => splitLocale(pathname, cfg).rest;

/** `localizePath("/about", "vi")` -> `/vi/about`; `/` -> `/vi`. An already-prefixed path is re-prefixed (locale switcher). */
export function localizePath(path: string, locale: string, cfg?: I18nConfig): string {
  const m = /^([^?#]*)(.*)$/.exec(path)!;
  const rest = cfg ? stripLocale(m[1], cfg) : m[1];
  return "/" + locale + (rest === "/" || rest === "" ? "" : rest.startsWith("/") ? rest : "/" + rest) + m[2];
}

/** `lang` value for a locale (`langTags` override or the tag itself). */
export const langOf = (cfg: I18nConfig, locale: string): string => cfg.langTags?.[locale] ?? locale;

/** `paths()` for `app/routes/[locale]/...` static pages: one entry per locale (merge your own params with `extra`). */
export function localeParams<E extends Record<string, string>>(cfg: I18nConfig, extra: E[] = [{} as E]): (E & { locale: string })[] {
  return cfg.locales.flatMap((locale) => extra.map((e) => ({ ...e, locale })));
}

// ---- hreflang / head -----------------------------------------------------------------------------------------------------------

export interface Alternate { hreflang: string; href: string }
/** Every locale's URL for an unprefixed path, plus `x-default` (the default locale). `base` = origin override (default: SITE_URL). */
export function alternatesFor(cfg: I18nConfig, path: string, base?: string): Alternate[] {
  const href = (l: string) => absoluteUrl(localizePath(path, l), base);
  return [...cfg.locales.map((l) => ({ hreflang: langOf(cfg, l), href: href(l) })), { hreflang: "x-default", href: href(cfg.default) }];
}

/**
 * Head for a page under `app/routes/[locale]/`: `<html lang>` and `<link rel="alternate" hreflang>` for every locale, derived from
 * `params.locale` and the request path. Export it from `app/routes/[locale]/_layout.tsx` and every page below inherits it:
 *
 *     export const head = i18nHead(i18n);
 */
export function i18nHead(cfg: I18nConfig, o: { siteUrl?: string } = {}) {
  return (ctx: { params: Record<string, string>; url?: string }): Head => {
    const locale = ctx.params.locale && cfg.locales.find((l) => l === ctx.params.locale);
    if (!locale) return {};
    const head: Head = { htmlAttrs: { lang: langOf(cfg, locale) } };
    if (ctx.url !== undefined) head.link = alternatesFor(cfg, stripLocale(ctx.url, cfg), o.siteUrl).map((a) => ({ rel: "alternate", hreflang: a.hreflang, href: a.href }));
    return head;
  };
}

// ---- sitemap -------------------------------------------------------------------------------------------------------------------

/**
 * Attach hreflang alternates (and `x-default`) to sitemap entries whose URL is `/<locale>/...`: entries that are the same page in another
 * locale are grouped by the unprefixed path. Entries outside the locale prefix pass through. Used by the static sitemap at build.
 */
export function withAlternates(entries: SitemapEntry[], cfg: I18nConfig, base?: string): SitemapEntry[] {
  const groups = new Map<string, Map<string, SitemapEntry>>();
  const split = (e: SitemapEntry) => { const p = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(e.url)?.[1] ?? e.url; return splitLocale(p.split(/[?#]/)[0], cfg); };
  for (const e of entries) {
    const { locale, rest } = split(e);
    if (locale) { if (!groups.has(rest)) groups.set(rest, new Map()); groups.get(rest)!.set(locale, e); }
  }
  return entries.map((e) => {
    const { locale, rest } = split(e);
    const g = locale ? groups.get(rest) : undefined;
    if (!g || g.size < 2) return e;
    const alternates = [...g].map(([l, x]) => ({ hreflang: langOf(cfg, l), href: absoluteUrl(x.url, base) }));
    const def = g.get(cfg.default);
    if (def) alternates.push({ hreflang: "x-default", href: absoluteUrl(def.url, base) });
    return { ...e, alternates: [...(e.alternates ?? []), ...alternates] };
  });
}

/** Entries for a dynamic `server/sitemap.ts`: each unprefixed path (or entry) expanded to every locale, with alternates. */
export function localizedEntries(items: (string | SitemapEntry)[], cfg: I18nConfig, base?: string): SitemapEntry[] {
  const all = items.map((i): SitemapEntry => (typeof i === "string" ? { url: i } : i))
    .flatMap((e) => cfg.locales.map((l) => ({ ...e, url: localizePath(e.url, l) })));
  return withAlternates(all, cfg, base);
}

// ---- catalogs ------------------------------------------------------------------------------------------------------------------

export interface PluralForms { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string }
export interface Messages { [key: string]: string | PluralForms | Messages }
export type CatalogLoader = () => Promise<Messages | { default: Messages }>;
export type Catalogs = Record<string, CatalogLoader>;

const isPlural = (v: unknown): v is PluralForms => !!v && typeof v === "object" && typeof (v as PluralForms).other === "string";
function merge(base: Messages, over: Messages): Messages {
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = typeof v === "object" && !isPlural(v) && b && typeof b === "object" && !isPlural(b) ? merge(b as Messages, v as Messages) : v;
  }
  return out;
}

/**
 * Load one locale's catalog. Loaders are `() => import("./messages/vi.json")`, so every locale (and every namespace file you split
 * into) is its own chunk - a route only bundles the catalogs it imports. The default locale is merged underneath: a key missing in
 * `vi` falls back to the default locale's text. Unknown locales also get the default catalog.
 */
export async function loadMessages(cfg: I18nConfig, catalogs: Catalogs, locale: string): Promise<Messages> {
  const get = async (l: string): Promise<Messages> => { const m = await catalogs[l]?.(); return (m && "default" in m && typeof m.default === "object" ? m.default : m ?? {}) as Messages; };
  const base = await get(cfg.default);
  return locale === cfg.default ? base : merge(base, await get(locale));
}

export interface Translator {
  locale: string;
  /** `t("home.greeting", { name })`; plural entries pick by `vars.count`. A missing key returns the key itself (and calls `onMissing`). */
  t(key: string, vars?: Record<string, string | number>): string;
  has(key: string): boolean;
  number(n: number, o?: Intl.NumberFormatOptions): string;
  date(d: Date | number | string, o?: Intl.DateTimeFormatOptions): string;
}

const lookup = (messages: Messages, key: string): string | PluralForms | undefined => {
  let cur: unknown = messages;
  for (const k of key.split(".")) { if (!cur || typeof cur !== "object" || isPlural(cur)) return undefined; cur = (cur as Messages)[k]; }
  return typeof cur === "string" || isPlural(cur) ? cur : undefined;
};

export function translator(messages: Messages, locale: string, o: { onMissing?: (key: string, locale: string) => void; langTag?: string } = {}): Translator {
  const tag = o.langTag ?? locale;
  const rules = new Intl.PluralRules(tag);
  const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);
  return {
    locale,
    has: (key) => lookup(messages, key) !== undefined,
    t(key, vars) {
      const v = lookup(messages, key);
      if (v === undefined) { o.onMissing?.(key, locale); return key; }
      if (typeof v === "string") return fill(v, vars);
      const n = Number(vars?.count ?? 0);
      return fill(v[`${n}` === "0" && v.zero !== undefined ? "zero" : rules.select(n)] ?? v.other, vars);
    },
    number: (n, opt) => new Intl.NumberFormat(tag, opt).format(n),
    date: (d, opt) => new Intl.DateTimeFormat(tag, opt).format(typeof d === "string" || typeof d === "number" ? new Date(d) : d),
  };
}

// ---- Worker middleware -------------------------------------------------------------------------------------------------------

export interface I18nMiddlewareOptions {
  /** Localized route patterns as generated (`/:locale`, `/:locale/about`, `/:locale/posts/:slug`). */
  routes: string[];
  /** Redirect `/` to `/<locale>/` (static home page: skips the assets layer's own trailing-slash redirect). */
  rootSlash?: boolean;
}

/**
 * Detection, only for `/` and unprefixed paths that are a known localized page (generated `run_worker_first` globs make exactly those
 * wake the Worker; prefixed pages are static assets or SSR as usual): 307 to `/<locale><path>` with `Vary: Accept-Language, Cookie`.
 * A path under an unknown prefix that would match a localized route is a 404 (not rendered with `locale = "xx"`).
 * Prefixed responses from the Worker get `Content-Language`.
 */
export function i18nMiddleware(cfg: I18nConfig, o: I18nMiddlewareOptions): MiddlewareHandler {
  const unprefixed = o.routes.map((r) => "/" + r.split("/").filter(Boolean).slice(1).join("/"));
  return async (c, next) => {
    const url = new URL(c.req.url);
    const { locale, rest } = splitLocale(url.pathname, cfg);
    if (locale) {
      await next();
      if (c.res.headers.get("content-type")?.startsWith("text/html") && !c.res.headers.has("content-language")) c.res.headers.set("content-language", langOf(cfg, locale));
      return;
    }
    const read = c.req.method === "GET" || c.req.method === "HEAD";
    if (read && unprefixed.some((p) => matchPath(p, rest))) {
      const target = detectLocale({ cookie: c.req.header("cookie"), acceptLanguage: c.req.header("accept-language"), country: (c.req.raw as { cf?: { country?: string } }).cf?.country }, cfg);
      const path = rest === "/" ? (o.rootSlash ? `/${target}/` : `/${target}`) : `/${target}${rest}`;
      return new Response(null, { status: 307, headers: { location: path + url.search, vary: "Accept-Language, Cookie", "cache-control": "no-store" } });
    }
    // Not `/sitemap.xml`, `/robots.txt` or `/api/...`: other Worker routes that a `/:locale` pattern would otherwise swallow.
    const first = rest.split("/")[1] ?? "";
    if (read && first !== "api" && !first.includes(".") && o.routes.some((r) => matchPath(r, url.pathname))) return c.notFound();
    return next();
  };
}
