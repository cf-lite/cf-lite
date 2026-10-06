import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceNavigation, createRouter, handleLinkClick, navigate, prefetch, refresh, setViewSwapHook, visit } from "../src/client.js";

// minimal browser fakes: enough of location/history/window/document for the router, no DOM library needed
let href = "https://app.test/";
const loc = {
  get href() { return href; }, get origin() { return new URL(href).origin; }, get pathname() { return new URL(href).pathname; }, get hash() { return new URL(href).hash; },
  assign: vi.fn(), replace: vi.fn(),
};
const listeners: Record<string, (() => unknown)[]> = {};
const hist = { pushState: vi.fn((_s: unknown, _t: string, u: string) => { href = new URL(u, href).href; }), replaceState: vi.fn((_s: unknown, _t: string, u: string) => { href = new URL(u, href).href; }) };
class PopStateEvent { constructor(public type: string) {} }
const win: any = { location: loc, addEventListener: (t: string, f: () => unknown) => (listeners[t] ??= []).push(f), dispatchEvent: (e: PopStateEvent) => Promise.all((listeners[e.type] ?? []).map((f) => f())), scrollTo: vi.fn(), __CF_LITE_DATA__: undefined };
const mkEl = () => { const attrs: Record<string, string> = {}; return { id: "", textContent: "", attrs, setAttribute: (k: string, v: string) => (attrs[k] = v), hasAttribute: (k: string) => k in attrs, focus: vi.fn(), scrollIntoView: vi.fn(), appendChild: vi.fn() }; };
const doc = (o: { title?: string; h1?: string; main?: boolean; byId?: Record<string, any> } = {}) => {
  const created: any[] = []; const main = o.main ? mkEl() : null; const h1 = o.h1 ? { ...mkEl(), textContent: ` ${o.h1} ` } : null;
  const d: any = { title: o.title ?? "", body: { appendChild: (e: any) => created.push(e) }, created, main, h1,
    getElementById: (id: string) => created.find((e) => e.id === id) ?? o.byId?.[id] ?? null, createElement: () => mkEl(),
    querySelector: (s: string) => (s === "main" ? main : s === "h1" ? h1 : null), head: { querySelectorAll: () => [], appendChild() {} }, documentElement: { setAttribute() {}, getAttribute: () => null, removeAttribute() {} } };
  return d;
};
const route = (path: string, o: Partial<any> = {}) => ({ path, render: "spa", load: vi.fn(async () => ({ default: path })), ...o }) as any;

beforeEach(() => {
  vi.useFakeTimers(); href = "https://app.test/"; vi.stubGlobal("location", loc); vi.stubGlobal("history", hist); vi.stubGlobal("window", win); vi.stubGlobal("PopStateEvent", PopStateEvent); vi.stubGlobal("document", doc());
  for (const k of Object.keys(listeners)) delete listeners[k]; vi.clearAllMocks();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("handleLinkClick / visit / navigate", () => {
  const click = (o: Partial<any> = {}) => ({ defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, preventDefault: vi.fn(), ...o });
  it("only plain left-clicks on SPA routes are hijacked; modified/middle/target/defaultPrevented/non-SPA/unknown are left to the browser", async () => {
    await createRouter([route("/spa"), route("/ssr", { render: "ssr" })]);
    const ok = click(); expect(handleLinkClick(ok, "/spa")).toBe(true); expect(ok.preventDefault).toHaveBeenCalled(); expect(hist.pushState).toHaveBeenCalledTimes(1);
    for (const e of [click({ metaKey: true }), click({ ctrlKey: true }), click({ shiftKey: true }), click({ button: 1 }), click({ defaultPrevented: true })]) expect(handleLinkClick(e, "/spa")).toBe(false);
    expect(handleLinkClick(click(), "/spa", "_blank")).toBe(false);
    const ssr = click(); expect(handleLinkClick(ssr, "/ssr")).toBe(false); expect(ssr.preventDefault).not.toHaveBeenCalled();
    expect(handleLinkClick(click(), "/nope")).toBe(false);
    expect(hist.pushState).toHaveBeenCalledTimes(1);
  });
  it("visit: SPA route -> pushState (replace variant); cross-origin / ssr / unknown -> real document navigation", async () => {
    await createRouter([route("/spa"), route("/nf", { isNotFound: true })]);
    visit("/spa?x=1#h"); expect(hist.pushState).toHaveBeenCalledWith(null, "", "/spa?x=1#h");
    visit("/spa", true); expect(hist.replaceState).toHaveBeenCalled();
    visit("https://evil.test/spa"); expect(loc.assign).toHaveBeenCalledWith("https://evil.test/spa");
    visit("/other"); expect(loc.assign).toHaveBeenCalledWith("https://app.test/other");
    visit("/nf"); expect(loc.assign).toHaveBeenCalledWith("https://app.test/nf"); // notFound route is never client-navigated
    visit("/zzz", true); expect(loc.replace).toHaveBeenCalledWith("https://app.test/zzz");
  });
  it("navigate fires popstate", () => { const f = vi.fn(); win.addEventListener("popstate", f); navigate("/x"); expect(f).toHaveBeenCalled(); });
});

describe("prefetch", () => {
  it("loads page + layouts + boundaries for a known route; ignores unknown/notFound; never throws", async () => {
    const layout = vi.fn(async () => ({})), loading = vi.fn(async () => ({})), error = vi.fn(async () => ({}));
    const r = route("/p", { layouts: [layout], loading, error });
    await createRouter([r, route("/nf", { isNotFound: true })]);
    r.load.mockClear();
    prefetch("/p"); expect(r.load).toHaveBeenCalled(); expect(layout).toHaveBeenCalled(); expect(loading).toHaveBeenCalled(); expect(error).toHaveBeenCalled();
    expect(() => prefetch("/unknown")).not.toThrow(); expect(() => prefetch("/nf")).not.toThrow();
    r.load.mockRejectedValueOnce(new Error("x")); expect(() => prefetch("/p")).not.toThrow();
    expect(() => prefetch("http://[bad")).not.toThrow();
  });
});

describe("announceNavigation", () => {
  it("creates one polite announcer, reads title > h1 > pathname, focuses main (tabindex -1), scrolls to top", () => {
    const d = doc({ title: "T", main: true });
    announceNavigation(d, win, true);
    announceNavigation(d, win, true);
    expect(d.created).toHaveLength(1);
    expect(d.created[0].textContent).toBe("T"); expect(d.created[0].attrs["aria-live"]).toBe("polite");
    expect(d.main.attrs.tabindex).toBe("-1"); expect(d.main.focus).toHaveBeenCalledWith({ preventScroll: true }); expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    win.scrollTo.mockClear();
    const d2 = doc({ h1: "Heading" }); announceNavigation(d2, win, false);
    expect(d2.created[0].textContent).toBe("Heading"); expect(d2.h1.focus).toHaveBeenCalled(); expect(win.scrollTo).not.toHaveBeenCalled(); // scroll=false (back/forward): the browser restores it
    const d3 = doc(); href = "https://app.test/deep"; announceNavigation(d3, win); expect(d3.created[0].textContent).toBe("/deep");
  });
  it("hash target scrolls into view instead of to top; existing tabindex is kept", () => {
    const target = mkEl(); href = "https://app.test/a#sec%201";
    const d = doc({ main: true, byId: { "sec 1": target } }); d.main.setAttribute("tabindex", "0");
    announceNavigation(d, win);
    expect(target.scrollIntoView).toHaveBeenCalled(); expect(win.scrollTo).not.toHaveBeenCalled(); expect(d.main.attrs.tabindex).toBe("0");
  });
});

describe("view swap hook + refresh()", () => {
  it("a swap hook (installed by cf-lite/view-transitions-client) wraps set(); subscribers are told from inside it, and the view only changes when it runs", async () => {
    const r = await createRouter([route("/"), route("/b")]);
    const seen: string[] = []; r.subscribe((v) => seen.push(v.path));
    let run!: () => void; const hook = vi.fn((u: () => void) => new Promise<void>((res) => { run = () => { u(); res(); }; }));
    setViewSwapHook(hook);
    try {
      href = "https://app.test/b"; const p = Promise.all(listeners.popstate.map((f) => f()));
      await vi.advanceTimersByTimeAsync(0);
      expect(hook).toHaveBeenCalledTimes(1); expect(seen).toEqual([]); expect(r.current.path).toBe("/");
      run(); await p;
      expect(seen).toEqual(["/b"]); expect(r.current.path).toBe("/b");
    } finally { setViewSwapHook(undefined); }
  });
  it("refresh(): SPA route = no-op; other documents reload unless a router claims the event", async () => {
    await createRouter([route("/"), route("/doc", { render: "ssr" })]);
    const reload = vi.fn(); const w: any = { location: { pathname: "/", reload }, dispatchEvent: vi.fn(() => true) };
    refresh(w); expect(reload).not.toHaveBeenCalled(); expect(w.dispatchEvent).not.toHaveBeenCalled();
    w.location.pathname = "/doc"; refresh(w); expect(reload).toHaveBeenCalledTimes(1);
    w.dispatchEvent = vi.fn(() => false); refresh(w); expect(reload).toHaveBeenCalledTimes(1); // claimed (rsc router)
  });
});

describe("createRouter", () => {
  it("initial view uses server data; unknown path -> Page null (adapter 404)", async () => {
    win.__CF_LITE_DATA__ = { a: 1 }; href = "https://app.test/p";
    const r = await createRouter([route("/p")]);
    expect(r.current).toMatchObject({ path: "/p", Page: "/p", data: { a: 1 } });
    win.__CF_LITE_DATA__ = undefined; href = "https://app.test/missing";
    expect((await createRouter([route("/p")])).current.Page).toBeNull();
  });
  it("popstate swaps the view, notifies subscribers, unsubscribe works, same path is ignored; last navigation wins when an earlier load resolves later", async () => {
    let release!: () => void; const slow = new Promise<void>((r) => (release = r));
    const routes = [route("/"), route("/slow", { load: vi.fn(async () => { await slow; return { default: "slow" }; }) }), route("/fast")];
    const r = await createRouter(routes);
    const seen: string[] = []; const off = r.subscribe((v) => seen.push(v.path));
    const fire = () => Promise.all(listeners.popstate.map((f) => f()));
    href = "https://app.test/"; await fire(); expect(seen).toEqual([]); // same path
    href = "https://app.test/slow"; const p1 = fire();
    href = "https://app.test/fast"; await fire();
    release(); await p1;
    expect(seen).toEqual(["/fast"]); expect(r.current.path).toBe("/fast"); // stale /slow result discarded
    off(); href = "https://app.test/"; await fire(); expect(seen).toEqual(["/fast"]);
    href = "https://app.test/nowhere"; await fire(); expect(r.current.Page).toBeNull();
    vi.runAllTimers();
  });
});
