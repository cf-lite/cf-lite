/**
 * Server half of SSR islands: the generated Worker app wraps SSR page handlers with `islandsRoute`; the prerender uses `islandTail`.
 * (The adapters' browser-side wrapper imports only `cf-lite/islands`, never this file.)
 */
import type { Context } from "hono";
import { ISLAND_TAG } from "./islands.js";
import type { IslandsManifest } from "./vite-islands.js";

const isDev = () => !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
let manifest: IslandsManifest | null | undefined;
async function runtime(c: Context): Promise<IslandsManifest | null> {
  if (manifest !== undefined) return manifest;
  let m: IslandsManifest | null = null;
  try {
    const res = await (c.env as { ASSETS: Fetcher }).ASSETS.fetch(new URL("/_islands.json", c.req.url));
    if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) m = (await res.json()) as IslandsManifest;
  } catch { /* no manifest */ }
  manifest = m;
  return m;
}

/** `modulepreload` files for a page: the runtime's static closure plus the chunks of the `load` islands it rendered (`ids`). Empty for manifests from older builds. */
export function islandPreloads(m: IslandsManifest | null | undefined, ids: Iterable<string>): string[] {
  if (!m?.preload) return [];
  const out = new Set(m.preload);
  for (const id of ids) { const i = m.islands?.[id]; if (i && i.w === "load") for (const d of i.deps) out.add(d); }
  return [...out];
}

/** Marker + HTML tail the generated app and the prerender add to a page that rendered at least one island. */
export const islandTail = (rt: string | null, nonce?: string, preload: string[] = []) => {
  const n = nonce ? ` nonce="${nonce}"` : "";
  const hints = rt ? preload.map((h) => `<link rel="modulepreload" href="${h}"${n}>`).join("") : "";
  return `<style${n}>${ISLAND_TAG}{display:contents}</style>${hints}${rt ? `<script type="module" src="${rt}"${n}></script>` : ""}`;
};

/** The island id of an opening tag (`data-i` is among the first attributes); `carry` keeps a tag split across stream chunks. */
const ID_RE = new RegExp(`<${ISLAND_TAG}\\b[^>]{0,64}?\\sdata-i="([^"]*)"`, "g");
const CARRY = 128;
/** Island ids in a complete HTML string (prerender). */
export const islandIds = (html: string) => [...html.matchAll(ID_RE)].map((x) => x[1]!);
type Handler = (c: Context, next?: () => Promise<void>) => Promise<Response>;
/**
 * Wraps an SSR page handler: when the streamed HTML contains `<cfl-island`, inserts the island runtime `<script>` (and the `display:contents` rule)
 * before `</body>`. Pages without islands pass through untouched; `hydrate = true` pages hydrate themselves, so they only get the style.
 */
export function islandsRoute<H extends Handler>(h: H, o: { hydrate: boolean; /** tests: override the dev detection */ dev?: boolean }): H {
  return (async (c, next) => {
    const res = await h(c, next);
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/html")) return res;
    const m = o.hydrate || (o.dev ?? isDev()) ? null : await runtime(c);
    const nonce = (c as unknown as { get(k: string): string | undefined }).get("cspNonce");
    const dec = new TextDecoder(), enc = new TextEncoder();
    const mark = "<" + ISLAND_TAG;
    const ids = new Set<string>(); // islands rendered so far (for the modulepreload set)
    const tail = () => islandTail(m?.runtime ?? null, nonce, islandPreloads(m, ids));
    let seen = false, done = false, carry = "";
    const ts = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        let s = dec.decode(chunk, { stream: true });
        const win = carry + s;
        if (!seen && win.includes(mark)) seen = true;
        if (seen && m) for (const x of win.matchAll(ID_RE)) ids.add(x[1]!);
        carry = win.slice(-CARRY);
        if (seen && !done && s.includes("</body>")) { s = s.replace("</body>", () => tail() + "</body>"); done = true; }
        ctl.enqueue(enc.encode(s));
      },
      flush(ctl) { if (seen && !done) ctl.enqueue(enc.encode(tail())); },
    });
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    return new Response(res.body.pipeThrough(ts), { status: res.status, statusText: res.statusText, headers });
  }) as H;
}
