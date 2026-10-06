import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iconsPlugin } from "../src/conventions/metadata.js";

const app = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "icons-")); mkdirSync(join(root, "app"));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(root, "app", n), c);
  return root;
};
const hooks = (root: string, o: { command?: "build" | "serve"; base?: string } = {}) => {
  const p = iconsPlugin(root) as any;
  p.configResolved({ base: o.base ?? "/", command: o.command ?? "serve" });
  return p;
};

describe("iconsPlugin (app/icon.*, favicon.ico, apple-icon.*)", () => {
  it("dev: links point at /app/<file>, with the right rel and mime", () => {
    const tags = hooks(app({ "favicon.ico": "x", "icon.svg": "<svg/>", "apple-icon.png": "p", "readme.md": "no", "icon.webp": "no" })).transformIndexHtml();
    expect(tags.map((t: any) => [t.attrs.rel, t.attrs.type, t.attrs.href]).sort()).toEqual([
      ["apple-touch-icon", "image/png", "/app/apple-icon.png"], ["icon", "image/svg+xml", "/app/icon.svg"], ["icon", "image/x-icon", "/app/favicon.ico"],
    ]);
    expect(tags.every((t: any) => t.tag === "link" && t.injectTo === "head")).toBe(true);
  });
  it("no icons / no app dir -> nothing injected", () => {
    expect(hooks(app({})).transformIndexHtml()).toBeUndefined();
    expect(hooks(mkdtempSync(join(tmpdir(), "noapp-"))).transformIndexHtml()).toBeUndefined();
  });
  it("build (client env): emits content-hashed assets and links use base + emitted file name; other environments emit nothing", () => {
    const root = app({ "icon.png": "png-bytes" });
    const p = hooks(root, { command: "build", base: "/site/" });
    const emitted: any[] = [];
    const ctx = (env: string) => ({ environment: { name: env }, emitFile: (f: any) => (emitted.push(f), "ref1"), getFileName: () => "assets/icon-abc123.png" });
    p.buildStart.call(ctx("ssr")); expect(emitted).toHaveLength(0);
    p.buildStart.call(ctx("client"));
    expect(emitted).toHaveLength(1); expect(emitted[0]).toMatchObject({ type: "asset", name: "icon.png" }); expect(String(emitted[0].source)).toBe("png-bytes");
    expect(p.transformIndexHtml()[0].attrs.href).toBe("/site/assets/icon-abc123.png");
  });
  it("serve mode never emits files", () => {
    const p = hooks(app({ "icon.png": "x" })); const emit = () => { throw new Error("no"); };
    expect(() => p.buildStart.call({ environment: { name: "client" }, emitFile: emit })).not.toThrow();
  });
});
