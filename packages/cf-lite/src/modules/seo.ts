/**
 * OPTIONAL module. Head sugar for SEO: `seo({...})` expands `openGraph` / `twitter` / `jsonLd` / `canonical` into plain `head` tags
 * (meta/link/script), so it works in static prerender, SSR and SPA navigation with zero extra machinery. Docs: docs/metadata.md.
 *
 *   export const head = ({ params, data }) => seo({ title: data.title, description: data.summary, path: `/posts/${params.slug}`,
 *     image: `/posts/${params.slug}/opengraph-image.png`, openGraph: { type: "article" }, jsonLd: { "@type": "BlogPosting", headline: data.title } });
 */
import type { Attrs, Head, ScriptEntry } from "../head.js";

let site: string | undefined;
/** Set the canonical origin once (`https://example.com`). Falls back to `process.env.SITE_URL` (build) - set it as a Worker var for SSR. */
export function configureSite(siteUrl: string | undefined): void { site = siteUrl?.replace(/\/+$/, ""); }
export function siteUrl(explicit?: string): string | undefined {
  const fromEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.SITE_URL;
  return (explicit ?? site ?? fromEnv)?.replace(/\/+$/, "") || undefined;
}

/** `/a/b` -> `https://example.com/a/b`. Absolute inputs pass through. With no known site origin the path is returned unchanged (and relative). */
export function absoluteUrl(pathOrUrl: string, base?: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const origin = siteUrl(base);
  return origin ? origin + (pathOrUrl.startsWith("/") ? "" : "/") + pathOrUrl : pathOrUrl;
}

/** An inline `application/ld+json` script. `<` is escaped so the content can never close the element. `@context` defaults to schema.org. */
export function jsonLdScript(data: Record<string, unknown> | Record<string, unknown>[]): ScriptEntry {
  const withCtx = (o: Record<string, unknown>) => ("@context" in o ? o : { "@context": "https://schema.org", ...o });
  const json = JSON.stringify(Array.isArray(data) ? data.map(withCtx) : withCtx(data)).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return { type: "application/ld+json", content: json };
}

export interface OpenGraph { type?: string; siteName?: string; locale?: string; title?: string; description?: string; image?: string | { url: string; width?: number; height?: number; alt?: string }; publishedTime?: string; modifiedTime?: string; authors?: string[] }
export interface Twitter { card?: "summary" | "summary_large_image" | "app" | "player"; site?: string; creator?: string; title?: string; description?: string; image?: string }
export interface SeoInput {
  title?: string;
  description?: string;
  /** Path (`/posts/x`) or URL of this page: drives `<link rel=canonical>` and `og:url`. */
  path?: string;
  /** Page image (path or URL): og:image + twitter:image (card defaults to summary_large_image). */
  image?: string | { url: string; width?: number; height?: number; alt?: string };
  openGraph?: OpenGraph | false;
  twitter?: Twitter | false;
  /** One or several schema.org objects. */
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];
  /** `noindex, nofollow` (and `follow`/`index` toggles via a string such as "noindex, follow"). */
  noindex?: boolean | string;
  /** Origin override (default: configureSite() / SITE_URL). */
  siteUrl?: string;
  /** Extra head merged on top. */
  extra?: Head;
}

const og = (property: string, content?: string | number): Attrs[] => (content === undefined || content === "" ? [] : [{ property, content: String(content) }]);
const nm = (name: string, content?: string): Attrs[] => (content ? [{ name, content }] : []);

/** Expand SEO inputs into a `Head` (merge it like any other head: it is returned from `export const head`). */
export function seo(i: SeoInput): Head {
  const abs = (p: string) => absoluteUrl(p, i.siteUrl);
  const url = i.path ? abs(i.path) : undefined;
  const img = i.image === undefined ? undefined : typeof i.image === "string" ? { url: i.image } : i.image;
  const meta: Attrs[] = [...nm("description", i.description)];
  const link: Attrs[] = url ? [{ rel: "canonical", href: url }] : [];
  if (i.noindex) meta.push({ name: "robots", content: typeof i.noindex === "string" ? i.noindex : "noindex, nofollow" });
  if (i.openGraph !== false) {
    const o = i.openGraph ?? {};
    const oi = o.image === undefined ? img : typeof o.image === "string" ? { url: o.image } : o.image;
    meta.push(
      ...og("og:title", o.title ?? i.title), ...og("og:description", o.description ?? i.description), ...og("og:url", url),
      ...og("og:type", o.type ?? "website"), ...og("og:site_name", o.siteName), ...og("og:locale", o.locale),
      ...(oi ? [...og("og:image", abs(oi.url)), ...og("og:image:width", oi.width), ...og("og:image:height", oi.height), ...og("og:image:alt", oi.alt)] : []),
      ...og("article:published_time", o.publishedTime), ...og("article:modified_time", o.modifiedTime),
      ...(o.authors ?? []).flatMap((a) => og("article:author", a)),
    );
  }
  if (i.twitter !== false) {
    const t = i.twitter ?? {};
    const ti = t.image ?? img?.url;
    meta.push(
      ...nm("twitter:card", t.card ?? (ti ? "summary_large_image" : "summary")), ...nm("twitter:site", t.site), ...nm("twitter:creator", t.creator),
      ...nm("twitter:title", t.title ?? i.title), ...nm("twitter:description", t.description ?? i.description), ...nm("twitter:image", ti ? abs(ti) : undefined),
    );
  }
  const head: Head = { title: i.title, meta, link, script: i.jsonLd ? [jsonLdScript(i.jsonLd)] : [] };
  if (i.title === undefined) delete head.title;
  if (!head.script!.length) delete head.script;
  if (!head.link!.length) delete head.link;
  if (!i.extra) return head;
  return { ...head, ...i.extra, title: i.extra.title ?? head.title, meta: [...meta, ...(i.extra.meta ?? [])], link: [...(head.link ?? []), ...(i.extra.link ?? [])], script: [...(head.script ?? []), ...(i.extra.script ?? [])] };
}
