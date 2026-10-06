// @vitest-environment happy-dom
// modules/rsc-client.ts (browser router for render="rsc" pages) under a DOM: the plugin-rsc browser functions are injected fakes, the
// network is a fetch stub, hydrateRoot is replaced by createRoot (the fake payload is a plain element tree).
const { roots } = vi.hoisted(() => ({ roots: [] as { unmount(): void }[] }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

vi.mock("react-dom/client", async (orig) => { const o = await orig<typeof import("react-dom/client")>(); return { ...o, hydrateRoot: (el: Element, node: unknown) => { const r = o.createRoot(el.firstElementChild as Element); roots.push(r); r.render(node as never); return r; } }; });
import { startRsc, type RscClientDeps } from "../src/modules/rsc-client.js";
void createRoot;

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 20) => { await act(async () => { await tick(ms); }); };
const flightRes = (text: string, ct = "text/x-component;charset=utf-8", url?: string) => { const r = new Response(text, { headers: { "content-type": ct } }); if (url) Object.defineProperty(r, "url", { value: url }); return r; };
const asStream = (t: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(t)); c.close(); } });

let fetchMock: ReturnType<typeof vi.fn>, assign: ReturnType<typeof vi.fn>, deps: RscClientDeps & { cb?: (id: string, args: unknown[]) => Promise<unknown>; upd?: () => void };
const pages: Record<string, string> = { "/a": "page A", "/b": "page B" };
function boot(opts: Partial<RscClientDeps> = {}) {
  deps = {
    createFromReadableStream: (s) => new Response(s).text().then((t) => ({ root: createElement("main", { id: "m" }, t) })),
    createFromFetch: (p) => p.then((r) => r.text()).then((t) => ({ root: createElement("main", { id: "m" }, t) })),
    setServerCallback: (cb) => { deps.cb = cb; },
    rscStream: asStream("initial"), paths: ["/a", "/b", "/p/:id"],
    onUpdate: (cb) => { deps.upd = cb; },
    ...opts,
  };
  return act(async () => { startRsc(deps); await tick(5); });
}
const text = () => document.getElementById("m")?.textContent;
const link = (href: string, attrs: Record<string, string> = {}) => { const a = document.createElement("a"); a.href = href; for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v); a.textContent = href; document.getElementById("m")!.after(a); return a; };

const listeners: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
beforeEach(() => {
  for (const t of [document, window] as EventTarget[]) { const add = t.addEventListener.bind(t); vi.spyOn(t, "addEventListener").mockImplementation(((ty: string, fn: EventListenerOrEventListenerObject, o?: unknown) => { listeners.push([t, ty, fn]); add(ty, fn, o as never); }) as never); }
  (window as any).happyDOM?.settings && Object.assign((window as any).happyDOM.settings.navigation, { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true });
  document.body.innerHTML = '<div id="slot"></div>';
  // hydrateRoot(document, ...) in the real thing: here the shim mounts into document.firstElementChild (<html>) -> use a root div instead
  Object.defineProperty(document, "firstElementChild", { configurable: true, get: () => document.getElementById("slot") });
  history.replaceState(null, "", "/a");
  fetchMock = vi.fn(async (u: string) => { const p = new URL(u, location.href); return flightRes(pages[p.pathname] ?? "other", undefined, p.href); });
  vi.stubGlobal("fetch", fetchMock);
  assign = vi.fn(); vi.spyOn(location, "assign").mockImplementation(assign as never);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(async () => { await act(async () => { for (const r of roots.splice(0)) r.unmount(); }); for (const [t, ty, fn] of listeners.splice(0)) t.removeEventListener(ty, fn); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("startRsc", () => {
  it("hydrates the document from the inline stream", async () => { await boot(); expect(text()).toBe("initial"); });

  it("soft-navigates between rsc routes: fetches ?__rsc, swaps the page, pushes the URL", async () => {
    await boot(); const a = link("/b");
    await act(async () => { a.click(); await tick(20); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [u, init] = fetchMock.mock.calls[0]; expect(String(u)).toMatch(/\/b\?__rsc=1$/); expect(init.headers.accept).toBe("text/x-component");
    expect(text()).toBe("page B"); expect(location.pathname).toBe("/b"); expect(assign).not.toHaveBeenCalled();
  });

  it("leaves non-rsc links, other origins, modified clicks, target/download/data-no-soft links to the browser", async () => {
    await boot();
    for (const a of [link("/zzz"), link("https://other.example/a"), link("/b", { target: "_blank" }), link("/b", { download: "" }), link("/b", { "data-no-soft": "" }), link("/b", { rel: "external" })]) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }); a.dispatchEvent(ev); expect(ev.defaultPrevented).toBe(false);
    }
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...mod }); link("/b").dispatchEvent(ev); expect(ev.defaultPrevented).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a same-page hash link is the browser's", async () => {
    await boot(); const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }); link("/a#x").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it("hover prefetch: one request, consumed by the click; mouseout cancels", async () => {
    await boot(); const a = link("/b"), c = link("/p/9");
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); a.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })); await tick(90);
    expect(fetchMock).not.toHaveBeenCalled(); // left before the hover delay
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await tick(90);
    a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await tick(90); // already cached: no second request
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { a.click(); await tick(20); });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(text()).toBe("page B");
    c.dispatchEvent(new Event("focusin", { bubbles: true })); await tick(90); expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a full load when the fetch fails, the response is not a payload, or it redirected away", async () => {
    await boot();
    fetchMock.mockRejectedValueOnce(new Error("net"));
    await act(async () => { link("/b").click(); await tick(20); }); expect(assign).toHaveBeenLastCalledWith(expect.stringContaining("/b"));
    fetchMock.mockResolvedValueOnce(flightRes("<html>", "text/html", "http://localhost/b?__rsc=1"));
    await act(async () => { link("/b").click(); await tick(20); }); expect(assign).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(flightRes("x", "text/x-component", "http://localhost/elsewhere?__rsc=1"));
    await act(async () => { link("/b").click(); await tick(20); }); expect(assign).toHaveBeenCalledTimes(3);
  });

  it("popstate to an rsc url re-renders it, to a foreign url is a full load", async () => {
    await boot();
    await act(async () => { link("/b").click(); await tick(20); });
    history.replaceState({ k: 1, y: 40 }, "", "/a");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await tick(20); });
    expect(text()).toBe("page A");
    history.replaceState(null, "", "/not-rsc");
    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); await tick(5); });
    expect(assign).toHaveBeenCalledWith(expect.stringContaining("/not-rsc"));
  });

  it("server action callback: posts the form with the action id, applies the returned payload in place", async () => {
    await boot();
    const fd = new FormData(); fd.set("name", "x");
    fetchMock.mockResolvedValueOnce(flightRes("after action"));
    await act(async () => { await deps.cb!("a#go", [fd]); await tick(20); });
    const [u, init] = fetchMock.mock.calls[0]; expect(String(u)).toBe("/a"); expect(init.method).toBe("POST"); expect((init.body as FormData).has("$ACTION_ID_a#go")).toBe(true); expect((init.body as FormData).get("name")).toBe("x");
    expect(text()).toBe("after action");
  });

  it("server action callback: refuses programmatic calls, surfaces failures, follows x-cf-lite-redirect", async () => {
    await boot();
    await expect(deps.cb!("a#go", ["not a form"])).rejects.toThrow(/form-based/);
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 500, headers: { "content-type": "text/plain" } }));
    await expect(deps.cb!("a#go", [new FormData()])).rejects.toThrow(/failed \(500\)/);
    fetchMock.mockResolvedValueOnce(new Response(null, { headers: { "x-cf-lite-redirect": "/b" } }));
    await act(async () => { await deps.cb!("a#go", [new FormData()]); await tick(20); });
    expect(text()).toBe("page B");
    fetchMock.mockResolvedValueOnce(new Response(null, { headers: { "x-cf-lite-redirect": "/plain" } }));
    await act(async () => { await deps.cb!("a#go", [new FormData()]); await tick(5); });
    expect(assign).toHaveBeenCalledWith(expect.stringContaining("/plain"));
  });

  it("dev HMR: onUpdate re-fetches the current page in place and ignores non-payload answers", async () => {
    await boot();
    pages["/a"] = "page A v2";
    await act(async () => { deps.upd!(); await tick(20); });
    expect(text()).toBe("page A v2"); expect(location.pathname).toBe("/a");
    fetchMock.mockResolvedValueOnce(flightRes("<html>", "text/html"));
    await act(async () => { deps.upd!(); await tick(20); }); expect(text()).toBe("page A v2");
    pages["/a"] = "page A";
  });

  it("viewport prefetch: links marked data-prefetch=viewport are observed after a commit and fetched when visible", async () => {
    const seen: Element[] = []; let fire: ((es: unknown[]) => void) | undefined;
    vi.stubGlobal("IntersectionObserver", class { constructor(cb: (es: unknown[]) => void) { fire = cb; } observe(e: Element) { seen.push(e); } unobserve() {} });
    await boot();
    const a = link("/b", { "data-prefetch": "viewport" });
    await act(async () => { deps.upd!(); await tick(20); }); // any commit re-runs observeLinks()
    expect(seen).toContain(a);
    fire!([{ isIntersecting: false, target: a }, { isIntersecting: true, target: a }]); await tick(5);
    expect(fetchMock.mock.calls.some(([u]) => /\/b\?__rsc=1/.test(String(u)))).toBe(true);
  });
});
