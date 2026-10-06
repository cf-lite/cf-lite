// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../src/client-islands.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let mount: ReturnType<typeof vi.fn>;
const loaders = () => ({
  "i/A": vi.fn(async () => ({ default: { inner: "InnerA" } })),
  "i/B": vi.fn(async () => ({ default: { inner: "InnerB" } })),
  "i/Raw": vi.fn(async () => ({ default: {} })),
});
const island = (attrs: string, inner = "<button>b</button>") => `<cfl-island ${attrs}>${inner}</cfl-island>`;
const el = (i: number) => document.querySelectorAll("cfl-island")[i] as HTMLElement;

beforeEach(() => { mount = vi.fn(); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; delete (window as any).requestIdleCallback; delete (window as any).IntersectionObserver; });

describe("client islands", () => {
  it("load (default): hydrates at once with parsed props, marks data-h, mounts the raw inner component", async () => {
    document.body.innerHTML = island('data-i="i/A" data-p="{&quot;n&quot;:1}"') + island('data-i="i/B"');
    const l = loaders(); start(l, mount); await tick();
    expect(mount).toHaveBeenCalledWith(el(0), "InnerA", { n: 1 }, false);
    expect(mount).toHaveBeenCalledWith(el(1), "InnerB", {}, false);
    expect(el(0).hasAttribute("data-h")).toBe(true);
    start(l, mount); await tick(); expect(mount).toHaveBeenCalledTimes(2); // idempotent
  });
  it("an island without .inner (not wrapped) mounts its default export", async () => {
    document.body.innerHTML = island('data-i="i/Raw"');
    const l = loaders(); start(l, mount); await tick();
    expect(mount.mock.calls[0]![1]).toEqual({});
  });
  it("only outermost islands hydrate by themselves", async () => {
    document.body.innerHTML = island('data-i="i/A"', island('data-i="i/B"'));
    start(loaders(), mount); await tick();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[0]![1]).toBe("InnerA");
  });
  it("a failing loader is logged and does not stop the other islands", async () => {
    document.body.innerHTML = island('data-i="i/Bad"') + island('data-i="i/A"');
    start({ ...loaders(), "i/Bad": async () => { throw new Error("chunk 404"); } }, mount); await tick();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('island "i/Bad"'), expect.any(Error));
  });
  it("idle: requestIdleCallback when present, else a short timeout", async () => {
    document.body.innerHTML = island('data-i="i/A" data-w="idle"');
    const ric = vi.fn((cb: () => void) => cb()); (window as any).requestIdleCallback = ric;
    start(loaders(), mount); await tick();
    expect(ric).toHaveBeenCalled(); expect(mount).toHaveBeenCalledTimes(1);
    delete (window as any).requestIdleCallback; mount.mockClear(); document.body.innerHTML = island('data-i="i/A" data-w="idle"');
    vi.useFakeTimers(); start(loaders(), mount); expect(mount).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(250); vi.useRealTimers();
    expect(mount).toHaveBeenCalledTimes(1);
  });
  it("visible: observes the children (display:contents has no box); hydrates on intersect only", async () => {
    document.body.innerHTML = island('data-i="i/A" data-w="visible"', "<p>x</p><p>y</p>");
    let cb!: (e: { isIntersecting: boolean }[]) => void; const observed: Element[] = []; const disconnect = vi.fn();
    (window as any).IntersectionObserver = class { constructor(c: typeof cb, public o: unknown) { cb = c; } observe(e: Element) { observed.push(e); } disconnect = disconnect; };
    start(loaders(), mount); await tick();
    expect(observed.length).toBe(2); expect(mount).not.toHaveBeenCalled();
    cb([{ isIntersecting: false }]); await tick(); expect(mount).not.toHaveBeenCalled();
    cb([{ isIntersecting: true }]); await tick(); expect(mount).toHaveBeenCalledTimes(1); expect(disconnect).toHaveBeenCalled();
  });
  it("visible without IntersectionObserver or children falls back to load", async () => {
    document.body.innerHTML = island('data-i="i/A" data-w="visible"') + island('data-i="i/B" data-w="visible"', "");
    start(loaders(), mount); await tick();
    expect(mount).toHaveBeenCalledTimes(2);
  });
  it("interaction: waits for the first event, hydrates synchronously, replays a click target", async () => {
    document.body.innerHTML = island('data-i="i/A" data-w="interaction"', '<button id="b">b</button>');
    start(loaders(), mount); await tick();
    expect(mount).not.toHaveBeenCalled();
    const clicks = vi.fn(); document.getElementById("b")!.addEventListener("click", clicks);
    document.getElementById("b")!.dispatchEvent(new Event("pointerover", { bubbles: true })); // the trigger
    clicks.mockClear();
    document.getElementById("b")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); // lands before hydration finished
    clicks.mockClear();
    await tick(5);
    expect(mount).toHaveBeenCalledWith(el(0), "InnerA", {}, true);
    expect(clicks).toHaveBeenCalledTimes(1); // the replay
  });
  it("interaction triggered by the click itself replays it; other triggers do not", async () => {
    document.body.innerHTML = island('data-i="i/A" data-w="interaction"', '<button id="b">b</button>') + island('data-i="i/B" data-w="interaction"', '<button id="c">c</button>');
    start(loaders(), mount); await tick();
    const b = document.getElementById("b")!; const clicked = vi.fn(); b.addEventListener("click", clicked);
    b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).toHaveBeenCalledTimes(1);
    await tick(5);
    expect(clicked).toHaveBeenCalledTimes(2);
    const c = document.getElementById("c")!; const cc = vi.fn(); c.addEventListener("click", cc);
    c.dispatchEvent(new Event("focusin", { bubbles: true })); await tick(5);
    expect(mount).toHaveBeenCalledWith(el(1), "InnerB", {}, true);
    expect(cc).not.toHaveBeenCalled();
  });
});
