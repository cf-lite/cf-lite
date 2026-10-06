/**
 * Head management: `export const head = {...}` (or `(ctx) => ({...})`) from a page and any of its layouts,
 * merged outer layout -> page (inner wins). Same merge for static/ssr (string injection into the HTML shell at
 * build/request time) and SPA navigation (DOM update). Managed tags carry `data-cf-head` so they can be replaced.
 */
export type Attrs = Record<string, string>;
/**
 * Script entry. `strategy`: "blocking" (plain `<script>`), "defer" (default for `src`), "async", or "idle" (inserted from an inline
 * loader after `requestIdleCallback`, `setTimeout` fallback). Inline `content` ignores the strategy and is emitted as-is.
 * Every emitted script (and the idle loader) carries the request nonce when `injectHead(html, h, { nonce })` is given one.
 */
export interface ScriptEntry { src?: string; content?: string; strategy?: "blocking" | "defer" | "async" | "idle"; type?: string; attrs?: Attrs }
/** `htmlAttrs`: attributes of the `<html>` element (`lang`, `dir`) - set by `cf-lite/modules/i18n`. Merged key by key, inner wins. */
export interface Head { title?: string; meta?: Attrs[]; link?: Attrs[]; script?: ScriptEntry[]; htmlAttrs?: Attrs }
/** `url`: the request pathname (prerender: the filled path; SSR: the request; SPA: the location) when known. */
export interface HeadCtx { params: Record<string, string>; data: unknown; url?: string }
export type HeadExport = Head | ((ctx: HeadCtx) => Head);
export interface HeadSource { head?: HeadExport; title?: string }

const metaKey = (m: Attrs) => m.charset !== undefined ? "charset" : m.name ? "name:" + m.name : m.property ? "property:" + m.property : m["http-equiv"] ? "http-equiv:" + m["http-equiv"] : m.itemprop ? "itemprop:" + m.itemprop : JSON.stringify(m);
const scriptKey = (s: ScriptEntry) => s.src ? "src:" + s.src : "inline:" + s.content;
const linkKey = (l: Attrs) => (l.rel === "canonical" || l.rel === "icon" || l.rel === "manifest" ? l.rel : `${l.rel}|${l.href}|${l.hreflang ?? ""}|${l.media ?? ""}`);

/** Resolve one module's head (function or object; legacy `title` export is shorthand for head.title). */
export function resolveHead(mod: HeadSource, ctx: HeadCtx): Head {
  const h = typeof mod.head === "function" ? mod.head(ctx) : mod.head;
  return h?.title === undefined && mod.title ? { ...h, title: mod.title } : { ...h };
}

/** Merge heads in order; later entries win (title: last defined; meta/link: by key). */
export function mergeHead(list: (Head | undefined)[]): Head {
  const out: Head = {};
  const meta = new Map<string, Attrs>(), link = new Map<string, Attrs>(), script = new Map<string, ScriptEntry>();
  for (const h of list) {
    if (!h) continue;
    if (h.title !== undefined) out.title = h.title;
    if (h.htmlAttrs) out.htmlAttrs = { ...out.htmlAttrs, ...h.htmlAttrs };
    for (const m of h.meta ?? []) { meta.delete(metaKey(m)); meta.set(metaKey(m), m); }
    for (const l of h.link ?? []) { link.delete(linkKey(l)); link.set(linkKey(l), l); }
    for (const sc of h.script ?? []) { script.delete(scriptKey(sc)); script.set(scriptKey(sc), sc); }
  }
  if (meta.size) out.meta = [...meta.values()];
  if (link.size) out.link = [...link.values()];
  if (script.size) out.script = [...script.values()];
  return out;
}

/** Head for a page + its layouts (outer first). */
export function headFor(mods: HeadSource[], ctx: HeadCtx): Head {
  return mergeHead(mods.map((m) => resolveHead(m, ctx)));
}

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const tag = (name: string, a: Attrs) =>
  `<${name} ${Object.entries(a).map(([k, v]) => `${k.replace(/[^\w:-]/g, "")}="${escapeHtml(String(v))}"`).join(" ")} data-cf-head>`;

const strategyOf = (s: ScriptEntry) => s.strategy ?? "defer";
/** `</script` inside inline content would end the element early. */
const inlineSafe = (c: string) => c.replace(/<\/(script)/gi, "<\\/$1");
const IDLE_LOADER = (srcs: { src: string; type?: string; attrs?: Attrs }[]) =>
  `(function(l){var r=function(){l.forEach(function(e){var s=document.createElement("script");s.src=e.src;if(e.type)s.type=e.type;if(e.attrs)for(var k in e.attrs)s.setAttribute(k,e.attrs[k]);document.head.appendChild(s)})};` +
  `"requestIdleCallback"in window?requestIdleCallback(r):setTimeout(r,200)})(${JSON.stringify(srcs).replace(/</g, "\\u003c")})`;

/** Script markup for a head (used by injectHead; exported for renderers that build shells themselves). */
export function scriptTags(list: ScriptEntry[], nonce?: string): string {
  const n = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";
  const extra = (s: ScriptEntry) => Object.entries({ ...s.attrs }).map(([k, v]) => ` ${k.replace(/[^\w:-]/g, "")}="${escapeHtml(String(v))}"`).join("");
  const ty = (s: ScriptEntry) => (s.type ? ` type="${escapeHtml(s.type)}"` : "");
  let out = "";
  const idle: { src: string; type?: string; attrs?: Attrs }[] = [];
  for (const s of list) {
    if (s.src === undefined) { out += `<script${ty(s)}${n}${extra(s)}>${inlineSafe(s.content ?? "")}</script>`; continue; }
    const st = strategyOf(s);
    if (st === "idle") { idle.push({ src: s.src, type: s.type, attrs: s.attrs }); continue; }
    const flag = st === "defer" ? (s.type === "module" ? "" : " defer") : st === "async" ? " async" : "";
    out += `<script src="${escapeHtml(s.src)}"${ty(s)}${flag}${n}${extra(s)}></script>`;
  }
  if (idle.length) out += `<script${n}>${IDLE_LOADER(idle)}</script>`;
  return out;
}

/** Inject a merged head into an HTML shell (string). Managed `<title>` remembers the shell's title for SPA fallback. */
export function injectHead(html: string, h: Head, opts: { nonce?: string } = {}): string {
  if (h.htmlAttrs) html = html.replace(/<html(\s[^>]*)?>/i, (_m, attrs: string | undefined) => {
    let a = attrs ?? "";
    for (const [k, v] of Object.entries(h.htmlAttrs!)) {
      const key = k.replace(/[^\w:-]/g, ""), val = ` ${key}="${escapeHtml(String(v))}"`;
      const re = new RegExp(`\\s${key}(=("[^"]*"|'[^']*'|[^\\s>]+))?`, "i");
      a = re.test(a) ? a.replace(re, val) : a + val;
    }
    return `<html${a}>`;
  });
  if (h.title !== undefined)
    html = html.replace(/<title>(.*?)<\/title>/, (_m, base: string) => `<title data-cf-base="${base.replace(/"/g, "&quot;")}">${escapeHtml(h.title!)}</title>`);
  // a route's tag replaces an unmanaged default from index.html with the same key (no duplicate description/canonical)
  for (const m of h.meta ?? []) html = html.replace(/<meta\s[^>]*?>/g, (t) => (!t.includes("data-cf-head") && metaKey(parseAttrs(t)) === metaKey(m) ? "" : t));
  for (const l of h.link ?? []) html = html.replace(/<link\s[^>]*?>/g, (t) => (!t.includes("data-cf-head") && linkKey(parseAttrs(t)) === linkKey(l) && /canonical|icon|manifest/.test(l.rel ?? "") ? "" : t));
  const tags = [...(h.meta ?? []).map((m) => tag("meta", m)), ...(h.link ?? []).map((l) => tag("link", l))].join("");
  const all = tags + (h.script?.length ? scriptTags(h.script, opts.nonce) : "");
  return all ? html.replace("</head>", () => all + "</head>") : html;
}
function parseAttrs(t: string): Attrs {
  const a: Attrs = {};
  for (const m of t.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) if (m[1] !== "meta" && m[1] !== "link") a[m[1]] = m[2] ?? "";
  return a;
}

// ---- browser side -------------------------------------------------------------------------------------------
let shadowed: Element[] = [];
const ranInline = new Set<string>();

/** Apply a merged head to `document` (SPA navigation and initial client mount). Idempotent. */
export function applyHead(h: Head, doc: Document = document) {
  const head = doc.head;
  head.querySelectorAll("[data-cf-head]").forEach((e) => e.remove());
  shadowed.forEach((e) => head.appendChild(e)); // restore defaults hidden by the previous route
  shadowed = [];
  const titleEl = doc.querySelector("title");
  const base = titleEl?.getAttribute("data-cf-base") ?? doc.title;
  if (titleEl && !titleEl.hasAttribute("data-cf-base")) titleEl.setAttribute("data-cf-base", base);
  doc.title = h.title ?? base;
  for (const [k, v] of Object.entries(h.htmlAttrs ?? {})) doc.documentElement.setAttribute(k, v);
  const add = (name: string, a: Attrs, same: (o: Element) => boolean) => {
    head.querySelectorAll(name).forEach((o) => { if (same(o)) { shadowed.push(o); o.remove(); } });
    const el = doc.createElement(name);
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
    el.setAttribute("data-cf-head", "");
    head.appendChild(el);
  };
  const attrsOf = (o: Element) => Object.fromEntries([...o.attributes].map((x) => [x.name, x.value]));
  for (const m of h.meta ?? []) add("meta", m, (o) => metaKey(attrsOf(o)) === metaKey(m));
  for (const l of h.link ?? []) add("link", l, (o) => /canonical|icon|manifest/.test(l.rel ?? "") && linkKey(attrsOf(o)) === linkKey(l));
  // Scripts are never removed on navigation (that would not unload them): a src already on the page is not loaded again.
  for (const sc of h.script ?? []) {
    if (sc.src !== undefined && [...doc.scripts].some((o) => o.getAttribute("src") === sc.src)) continue;
    if (sc.src === undefined) { if (ranInline.has(sc.content ?? "") || [...doc.scripts].some((o) => !o.src && o.textContent === sc.content)) continue; ranInline.add(sc.content ?? ""); }
    const el = doc.createElement("script");
    if (sc.src !== undefined) { el.src = sc.src; el.async = strategyOf(sc) === "async" || strategyOf(sc) === "idle" || strategyOf(sc) === "defer"; } else el.textContent = sc.content ?? "";
    if (sc.type) el.type = sc.type;
    for (const [k, v] of Object.entries(sc.attrs ?? {})) el.setAttribute(k, v);
    const go = () => doc.head.appendChild(el);
    if (strategyOf(sc) === "idle" && sc.src !== undefined) ("requestIdleCallback" in window ? requestIdleCallback(go) : setTimeout(go, 200)); else go();
  }
}
