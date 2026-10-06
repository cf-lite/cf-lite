import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prerender } from "../src/prerender.js";

function app(routes: Record<string, string>) {
  // inside the repo (not os.tmpdir) so `@cf-lite/react` resolves through the workspace links, like in a real app
  const root = mkdtempSync(join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-pre-"));
  mkdirSync(join(root, ".cf-lite"), { recursive: true });
  writeFileSync(join(root, ".cf-lite/meta.json"), JSON.stringify({ adapter: "@cf-lite/react" }));
  mkdirSync(join(root, "dist/client"), { recursive: true });
  writeFileSync(join(root, "dist/client/index.html"), "<html><body><div id=\"root\"></div></body></html>");
  for (const [f, src] of Object.entries(routes)) { mkdirSync(join(root, "app/routes"), { recursive: true }); writeFileSync(join(root, "app/routes", f), src); }
  return root;
}

describe("prerender: _shell.tpl", () => {
  it("is not emitted when there is no ssr route (no dead copy of the shell in the deployed assets)", async () => {
    const root = app({});
    await prerender({ root });
    expect(existsSync(join(root, "dist/client/_shell.tpl"))).toBe(false);
  });
  it("is emitted when an ssr route exists", async () => {
    const root = app({ "p.tsx": `export const render = "ssr"; export default () => null;` });
    await prerender({ root });
    expect(existsSync(join(root, "dist/client/_shell.tpl"))).toBe(true);
  });
});

describe("prerender: renderer none", () => {
  it("does nothing (no adapter, no pages)", async () => {
    const root = app({});
    writeFileSync(join(root, ".cf-lite/meta.json"), JSON.stringify({ adapter: null }));
    expect(await prerender({ root })).toEqual([]);
  });
});
