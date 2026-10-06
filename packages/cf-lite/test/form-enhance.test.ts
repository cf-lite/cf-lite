import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionDataOf, enhance, onActionResult } from "../src/modules/form.js";

// Fake <form>: a real EventTarget plus the few DOM members enhance() touches.
class FakeForm extends EventTarget {
  method = "post"; action = "https://app.test/c?/save"; attrs = new Set<string>(); aria: Record<string, string> = {};
  buttons: any[] = [{ disabled: false, dataset: {} as Record<string, string> }, { disabled: true, dataset: {} as Record<string, string> }];
  reset = vi.fn(); requestSubmit = vi.fn();
  toggleAttribute(k: string, on: boolean) { on ? this.attrs.add(k) : this.attrs.delete(k); }
  setAttribute(k: string, v: string) { this.aria[k] = v; }
  querySelectorAll() { return this.buttons; }
}
const submit = (f: FakeForm, o: { submitter?: any; defaultPrevented?: boolean } = {}) => {
  const e: any = Object.assign(new Event("submit", { cancelable: true }), { submitter: o.submitter ?? null });
  if (o.defaultPrevented) e.preventDefault();
  f.dispatchEvent(e);
  return e as Event;
};
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const settle = () => new Promise((r) => setTimeout(r, 0));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => json({ type: "success", status: 200, data: { ok: 1 } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { href: "https://app.test/c", origin: "https://app.test", pathname: "/c", assign: vi.fn(), replace: vi.fn() });
  vi.stubGlobal("FormData", class extends Map<string, unknown> { constructor(..._ignored: unknown[]) { super(); } });
  vi.stubGlobal("window", { addEventListener() {}, dispatchEvent() {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("enhance()", () => {
  it("non-post forms and already-prevented submits are left alone", async () => {
    const f = new FakeForm(); f.method = "get"; enhance(f as any);
    expect(submit(f).defaultPrevented).toBe(false);
    const g = new FakeForm(); enhance(g as any);
    submit(g, { defaultPrevented: true }); await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("posts via fetch with the action header + same-origin credentials, resets on success, emits result event + onResult", async () => {
    const f = new FakeForm(); const onResult = vi.fn(); const seen = vi.fn();
    enhance(f as any, { onResult }); onActionResult(f, seen);
    expect(submit(f).defaultPrevented).toBe(true); await settle();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.test/c?/save");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(init.headers["x-cf-lite-action"]).toBe("1");
    expect(f.reset).toHaveBeenCalled(); expect(onResult).toHaveBeenCalled(); expect(seen.mock.calls[0][0]).toMatchObject({ type: "success" });
  });
  it("pending state: data-pending/aria-busy + submit controls disabled during the request and their prior disabled state restored; double submit guarded", async () => {
    const f = new FakeForm(); const pend: boolean[] = [];
    let release!: (r: Response) => void; fetchMock.mockImplementationOnce(() => new Promise((r) => (release = r)));
    enhance(f as any, { onPending: (p) => pend.push(p) });
    submit(f); await settle();
    expect(f.attrs.has("data-pending")).toBe(true); expect(f.aria["aria-busy"]).toBe("true"); expect(f.buttons.every((b) => b.disabled)).toBe(true);
    submit(f); await settle(); expect(fetchMock).toHaveBeenCalledTimes(1); // double-submit guard
    release(json({ type: "failure", status: 422, data: {} })); await settle();
    expect(f.attrs.has("data-pending")).toBe(false); expect(f.aria["aria-busy"]).toBe("false");
    expect(f.buttons.map((b) => b.disabled)).toEqual([false, true]); // the originally-disabled button stays disabled
    expect(pend).toEqual([true, false]); expect(f.reset).not.toHaveBeenCalled();
  });
  it("onSubmit returning false cancels; optimistic rollback runs on failure/error but not success", async () => {
    const f = new FakeForm(); enhance(f as any, { onSubmit: () => false }); submit(f); await settle(); expect(fetchMock).not.toHaveBeenCalled();
    const rb = vi.fn(); const g = new FakeForm(); enhance(g as any, { optimistic: () => rb });
    fetchMock.mockResolvedValueOnce(json({ type: "failure", status: 422, data: {} })); submit(g); await settle(); expect(rb).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(json({ type: "success", status: 200, data: {} })); submit(g); await settle(); expect(rb).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(json({ type: "error", status: 500 })); submit(g); await settle(); expect(rb).toHaveBeenCalledTimes(2);
  });
  it("redirect result navigates; onResult returning false suppresses the default handling; resetOnSuccess:false respected", async () => {
    const f = new FakeForm(); fetchMock.mockResolvedValueOnce(json({ type: "redirect", status: 303, location: "/done" }));
    enhance(f as any); submit(f); await settle();
    expect((globalThis as any).location.assign).toHaveBeenCalledWith("https://app.test/done");
    const g = new FakeForm(); fetchMock.mockResolvedValueOnce(json({ type: "redirect", status: 303, location: "/no" })); enhance(g as any, { onResult: () => false }); submit(g); await settle();
    expect((globalThis as any).location.assign).toHaveBeenCalledTimes(1);
    const h = new FakeForm(); enhance(h as any, { resetOnSuccess: false }); submit(h); await settle(); expect(h.reset).not.toHaveBeenCalled();
  });
  it("formaction on the submitter overrides the form action", async () => {
    const f = new FakeForm(); enhance(f as any);
    submit(f, { submitter: { getAttribute: (k: string) => (k === "formaction" ? "?/delete" : null) } }); await settle();
    expect(fetchMock.mock.calls[0][0]).toBe("https://app.test/c?/delete");
    const g = new FakeForm(); enhance(g as any);
    submit(g, { submitter: { getAttribute: (k: string) => (k === "formmethod" ? "get" : null) } }); await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1); // formmethod=get is not ours
  });
  it("non-JSON answer (CSRF 403 / 413 page) or network failure: rollback, pending cleared, falls back to a native submit exactly once", async () => {
    const f = new FakeForm(); const rb = vi.fn(); enhance(f as any, { optimistic: () => rb });
    fetchMock.mockResolvedValueOnce(new Response("Cross-site request blocked", { status: 403, headers: { "content-type": "text/plain" } }));
    submit(f); await settle();
    expect(rb).toHaveBeenCalled(); expect(f.requestSubmit).toHaveBeenCalledTimes(1); expect(f.attrs.has("data-pending")).toBe(false);
    submit(f); await settle(); expect(fetchMock).toHaveBeenCalledTimes(1); // listener removed: the native submit is not intercepted again
    const g = new FakeForm(); enhance(g as any); fetchMock.mockRejectedValueOnce(new TypeError("net")); submit(g); await settle(); expect(g.requestSubmit).toHaveBeenCalledTimes(1);
  });
  it("destroy() detaches; update() swaps options", async () => {
    const f = new FakeForm(); const a = vi.fn(), b = vi.fn(); const h = enhance(f as any, { onResult: a });
    h.update({ onResult: b }); submit(f); await settle(); expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalled();
    h.destroy(); expect(submit(f).defaultPrevented).toBe(false);
  });
  it("onActionResult unsubscribes; actionDataOf tolerates junk", () => {
    const t = new EventTarget(); const fn = vi.fn(); const off = onActionResult(t, fn);
    t.dispatchEvent(new CustomEvent("cf-lite:action", { detail: { type: "success" } })); off(); t.dispatchEvent(new CustomEvent("cf-lite:action", { detail: {} }));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(actionDataOf({ actionData: 1 })).toBe(1); expect(actionDataOf(null)).toBeUndefined(); expect(actionDataOf("x")).toBeUndefined(); expect(actionDataOf([1])).toBeUndefined();
  });
});
