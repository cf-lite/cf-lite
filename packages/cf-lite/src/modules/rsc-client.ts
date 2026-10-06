/**
 * Browser runtime of `render = "rsc"` pages (docs/design/rsc.md section 11): hydrates the document from the inline Flight stream, then acts as a
 * client router for RSC-to-RSC links - soft navigation by fetching `<url>?__rsc`, hover/viewport prefetch, scroll restoration - and carries the
 * form-based server-action callback. Anything that is not an RSC route (SPA/SSR/static pages, other origins, modified clicks, `target`,
 * `download`, `data-no-soft`) is left to the browser: a normal full-page load. Every failure of a soft navigation falls back to a full load.
 *
 * Imported only by the generated `.cf-lite/rsc-browser.tsx`; the plugin-rsc browser functions are injected so this file never imports
 * `@vitejs/plugin-rsc` (resolvable only in apps that opt in).
 */
// @ts-ignore optional peers (only resolvable in apps that opt in to RSC)
import { createElement, startTransition, use, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
// @ts-ignore optional peer
import { hydrateRoot } from "react-dom/client";
import { matchPath } from "../match.js";

type Payload = Promise<{ root: ReactNode }>;
export interface RscClientDeps {
  createFromReadableStream(s: ReadableStream<Uint8Array>): Payload;
  createFromFetch(r: Promise<Response>): Payload;
  setServerCallback(cb: (id: string, args: unknown[]) => Promise<unknown>): void;
  rscStream: ReadableStream<Uint8Array>;
  /** URL patterns of every render="rsc" route (soft navigation targets). */
  paths: string[];
  /** Dev only: subscribe to "a server module changed" (plugin-rsc `rsc:update`); the router then re-fetches the current page in place. */
  onUpdate?(cb: () => void): void;
}

const PREFETCH_TTL = 30_000, PREFETCH_MAX = 24, HOVER_DELAY = 65;
const flightUrl = (u: URL) => { const x = new URL(u); x.hash = ""; x.searchParams.set("__rsc", "1"); return x.href; };
const keyOf = (u: URL) => u.pathname + u.search;

export function startRsc(d: RscClientDeps): void {
  const isRsc = (u: URL) => u.origin === location.origin && d.paths.some((p) => matchPath(p, u.pathname));
  const hard = (u: URL | string) => { location.assign(typeof u === "string" ? u : u.href); };

  // ---- root component: swaps the payload inside a transition so the old page stays until the new one is ready
  type St = { p: Payload; after?: () => void };
  let setSt: ((s: St) => void) | undefined;
  function Root({ initial }: { initial: Payload }) {
    const [st, set] = useState<St>({ p: initial });
    setSt = set;
    useLayoutEffect(() => { st.after?.(); }, [st]);
    useEffect(() => { observeLinks(); }, [st]);
    return (use(st.p) as { root: ReactNode }).root as never;
  }
  const commit = (p: Payload, after: () => void) => new Promise<void>((done) => startTransition(() => { setSt!({ p, after: () => { after(); done(); } }); }));

  // ---- scroll + history bookkeeping (history.state = { k, y }: restore position on back/forward)
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  let seq = Date.now();
  const stamp = () => history.replaceState({ ...(history.state ?? {}), k: history.state?.k ?? ++seq, y: scrollY }, "");
  stamp();
  let cur = keyOf(new URL(location.href));

  // ---- prefetch cache: url -> in-flight Response, consumed once (a Response body is single-use)
  const cache = new Map<string, { t: number; r: Promise<Response> }>();
  const fetchFlight = (u: URL): Promise<Response> => fetch(flightUrl(u), { headers: { accept: "text/x-component" }, credentials: "same-origin" });
  const prefetch = (u: URL) => {
    if (!isRsc(u) || keyOf(u) === cur) return;
    const k = keyOf(u), hit = cache.get(k);
    if (hit && Date.now() - hit.t < PREFETCH_TTL) return;
    if ((navigator as { connection?: { saveData?: boolean } }).connection?.saveData) return;
    if (cache.size >= PREFETCH_MAX) cache.delete(cache.keys().next().value as string);
    const r = fetchFlight(u); r.catch(() => cache.delete(k));
    cache.set(k, { t: Date.now(), r });
  };
  const take = (u: URL) => {
    const k = keyOf(u), hit = cache.get(k);
    cache.delete(k);
    return hit && Date.now() - hit.t < PREFETCH_TTL ? hit.r : fetchFlight(u);
  };

  let navId = 0;
  async function navigate(u: URL, kind: "push" | "pop", y?: number): Promise<void> {
    const id = ++navId;
    try {
      const res = await take(u);
      if (id !== navId) return;
      const final = new URL(res.url); final.searchParams.delete("__rsc");
      if (!(res.headers.get("content-type") ?? "").startsWith("text/x-component") || !isRsc(final)) return hard(final); // redirected away from RSC / not a payload
      const payload = d.createFromFetch(Promise.resolve(res));
      await payload; // surface a malformed payload now, while a full load is still a clean fallback
      if (id !== navId) return;
      stamp();
      await commit(payload, () => {
        if (kind === "push") { history.pushState({ k: ++seq, y: 0 }, "", final.pathname + final.search + (final.href === u.href || final.pathname === u.pathname ? u.hash : "")); cur = keyOf(final); scrollTarget(u.hash); }
        else { cur = keyOf(final); scrollTo(0, y ?? 0); }
        history.replaceState({ ...(history.state ?? {}), y: scrollY }, "");
      });
    } catch { if (id === navId) hard(u); }
  }
  const scrollTarget = (hash: string) => {
    const el = hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (el) el.scrollIntoView(); else scrollTo(0, 0);
  };

  // ---- link interception + prefetch triggers (one delegated listener each)
  const linkOf = (e: Event): HTMLAnchorElement | null => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download") || a.hasAttribute("data-no-soft") || /\bexternal\b/.test(a.rel)) return null;
    return a;
  };
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = linkOf(e); if (!a) return;
    const u = new URL(a.href);
    if (!isRsc(u)) return; // full-page fallback: SPA/SSR/static route, other origin, mailto:, ...
    if (keyOf(u) === cur && u.hash) return; // same-page anchor: browser default
    e.preventDefault();
    void navigate(u, "push");
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hover = (e: Event) => {
    const a = linkOf(e); if (!a) return;
    const u = new URL(a.href); if (!isRsc(u)) return;
    clearTimeout(timer); timer = setTimeout(() => prefetch(u), HOVER_DELAY);
  };
  document.addEventListener("mouseover", hover); document.addEventListener("focusin", hover); document.addEventListener("touchstart", hover, { passive: true });
  document.addEventListener("mouseout", () => clearTimeout(timer));
  const io = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver((es) => {
    for (const en of es) if (en.isIntersecting) { io!.unobserve(en.target); prefetch(new URL((en.target as HTMLAnchorElement).href)); }
  });
  function observeLinks() { if (io) document.querySelectorAll<HTMLAnchorElement>('a[data-prefetch="viewport"]').forEach((a) => io.observe(a)); }

  addEventListener("popstate", () => {
    const u = new URL(location.href);
    if (keyOf(u) === cur) return; // hash-only change
    if (!isRsc(u)) return hard(u);
    void navigate(u, "pop", history.state?.y);
  });
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  addEventListener("scroll", () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => history.replaceState({ ...(history.state ?? {}), y: scrollY }, ""), 120); }, { passive: true });

  // ---- server actions (form-based only): POST the form to the current URL, apply the re-rendered payload in place
  d.setServerCallback(async (id, args) => {
    const fd = args[0];
    if (args.length !== 1 || !(fd instanceof FormData)) throw new Error("cf-lite: only form-based server actions are supported (docs/design/rsc.md)");
    const body = new FormData();
    for (const [k, v] of fd) body.append(k, v);
    if (![...body.keys()].some((k) => k.startsWith("$ACTION_ID_"))) body.append("$ACTION_ID_" + id, "");
    const res = await fetch(location.pathname + location.search, { method: "POST", body, headers: { accept: "text/x-component" }, credentials: "same-origin" });
    const to = res.headers.get("x-cf-lite-redirect");
    if (to) { const u = new URL(to, location.href); if (isRsc(u)) void navigate(u, "push"); else hard(u); return; }
    if (!res.ok && !(res.headers.get("content-type") ?? "").startsWith("text/x-component")) throw new Error(`cf-lite: server action failed (${res.status})`);
    cache.clear(); // an action usually changes data: drop prefetched payloads
    const payload = d.createFromFetch(Promise.resolve(res));
    await payload;
    startTransition(() => { setSt!({ p: payload }); }); // NOT awaited: the form action's transition holds every update until this callback returns
  });

  const reload = () => {
    const u = new URL(location.href);
    cache.clear();
    fetchFlight(u).then(async (res) => {
      if (!(res.headers.get("content-type") ?? "").startsWith("text/x-component")) return;
      const payload = d.createFromFetch(Promise.resolve(res));
      await payload;
      startTransition(() => { setSt!({ p: payload }); });
    }).catch(() => {});
  };
  d.onUpdate?.(() => { if (isRsc(new URL(location.href))) reload(); });
  // `refresh()` from cf-lite/client: re-fetch the current page's payload in place (client state survives)
  addEventListener("cf-lite:refresh", (e) => { if (isRsc(new URL(location.href))) { e.preventDefault(); reload(); } });

  hydrateRoot(document, createElement(Root, { initial: d.createFromReadableStream(d.rscStream) }) as never);
}
