import { afterEach, describe, expect, it, vi } from "vitest";
import { viewTransitions, VT_CSS } from "../src/vite-view-transitions.js";
import { withViewTransition } from "../src/view-transitions-client.js";
import { createRouter, setViewSwapHook } from "../src/client.js";

const tags = (opt: any) => (viewTransitions(opt).transformIndexHtml as any).handler() as { tag: string; attrs: Record<string, string>; children?: string }[];

describe("viewTransitions plugin", () => {
  it("true: one <style> with the reduced-motion-gated cross-document rule, no router meta", () => {
    const t = tags(true);
    expect(t).toHaveLength(1);
    expect(t[0].tag).toBe("style"); expect(t[0].children).toBe(VT_CSS);
    expect(VT_CSS).toContain("@view-transition{navigation:auto}"); expect(VT_CSS).toContain("prefers-reduced-motion: no-preference");
  });
  it("{ router: true } also injects the module that installs the router hook (bundled: order pre)", () => {
    const t = tags({ router: true });
    expect(t.map((x) => x.tag)).toEqual(["style", "script"]);
    expect(t[1].attrs).toEqual({ type: "module" }); expect(t[1].children).toBe('import "cf-lite/view-transitions-client";');
    expect((viewTransitions(true).transformIndexHtml as any).order).toBe("pre");
  });
  it("{} behaves like true", () => expect(tags({})).toHaveLength(1));
});

describe("withViewTransition (client router)", () => {
  afterEach(() => vi.useRealTimers());
  const mkDoc = (o: { svt?: boolean } = {}) => {
    const calls: string[] = [];
    let observer: (() => void) | undefined;
    const d: any = {
      getElementById: () => ({}), body: {},
      ...(o.svt === false ? {} : { startViewTransition: (cb: () => Promise<void>) => { calls.push("svt"); void cb(); } }),
    };
    const win: any = { matchMedia: () => ({ matches: false }), MutationObserver: class { constructor(f: () => void) { observer = f; } observe() {} disconnect() {} } };
    return { d, win, calls, mutate: () => observer?.() };
  };

  it("no browser support / reduced motion: plain update, no transition", async () => {
    for (const o of [{ svt: false }]) {
      const { d, win, calls } = mkDoc(o); const u = vi.fn();
      await withViewTransition(u, d, win);
      expect(u).toHaveBeenCalledTimes(1); expect(calls).toEqual([]);
    }
    const { d, win, calls } = mkDoc(); win.matchMedia = () => ({ matches: true }); const u = vi.fn();
    await withViewTransition(u, d, win);
    expect(u).toHaveBeenCalledTimes(1); expect(calls).toEqual([]);
  });
  it("opted in + supported: update runs inside startViewTransition; resolves after the DOM mutation", async () => {
    vi.useFakeTimers();
    const { d, win, calls, mutate } = mkDoc(); const u = vi.fn();
    let done = false;
    const p = withViewTransition(u, d, win).then(() => (done = true));
    expect(calls).toEqual(["svt"]); expect(u).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10); expect(done).toBe(false); // still waiting for the adapter to re-render
    mutate(); await vi.advanceTimersByTimeAsync(5); await p;
    expect(done).toBe(true);
  });
  it("nothing mutates (same view): the 100 ms timeout still releases the transition", async () => {
    vi.useFakeTimers();
    const { d, win } = mkDoc();
    const p = withViewTransition(vi.fn(), d, win);
    await vi.advanceTimersByTimeAsync(120); await p;
  });
});

