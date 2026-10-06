import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SRC = readFileSync(new URL("../public/cms-saved-listener.js", import.meta.url), "utf8");
function load(meta?: string) {
  const hs = new Set<(e: unknown) => void>(), reload = vi.fn();
  const g: Record<string, unknown> = {
    addEventListener: (_: string, f: (e: unknown) => void) => hs.add(f), removeEventListener: (_: string, f: (e: unknown) => void) => hs.delete(f),
    location: { origin: "https://head.test", reload },
    document: { querySelector: () => (meta === undefined ? null : { content: meta }) },
  };
  g.window = g; runInNewContext(SRC, g);
  return { g, reload, count: () => hs.size, post: (data: unknown, origin = "https://head.test") => hs.forEach((f) => f({ data, origin })) };
}
const msg = { type: "cms:content-saved", id: "a" };
describe("public/cms-saved-listener.js", () => {
  it("auto-starts: same-origin save reloads; other origins and malformed messages are ignored", () => {
    const t = load();
    t.post(msg); expect(t.reload).toHaveBeenCalledTimes(1);
    t.post(msg, "https://evil.test");
    for (const bad of [null, "x", 1, {}, { type: "other", id: "a" }, { type: "cms:content-saved" }, { type: "cms:content-saved", id: 5 }]) t.post(bad);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });
  it("<meta name=cms-editor-origins> adds hosted CMS origins", () => {
    const t = load("https://cms.test, https://cms2.test");
    t.post(msg, "https://cms2.test"); expect(t.reload).toHaveBeenCalledTimes(1);
    t.post(msg, "https://cms3.test"); expect(t.reload).toHaveBeenCalledTimes(1);
  });
  it("createContentSavedListener: custom onSaved, id filter, unsubscribe", () => {
    const t = load(), on = vi.fn();
    const off = (t.g.createContentSavedListener as (o: object) => () => void)({ allowedOrigins: ["https://cms.test"], onSaved: on, ids: ["a"] });
    t.post({ ...msg, id: "b" }, "https://cms.test"); expect(on).not.toHaveBeenCalled();
    t.post({ ...msg, version: 3 }, "https://cms.test"); expect(on).toHaveBeenCalledWith({ ...msg, version: 3 });
    expect(t.count()).toBe(2); off(); expect(t.count()).toBe(1);
  });
});
