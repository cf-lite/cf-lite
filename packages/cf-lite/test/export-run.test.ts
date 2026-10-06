// runExport end to end against a fake "vite" CLI (a tiny HTTP server answering the /__preview endpoints): the real spawn, polling, fetching, planning and writing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport } from "../src/export.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "exprun-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

/** A script standing in for `vite dev --port N ...`: serves what the preview serves, driven by the MODE env var. */
function fakeVite(root: string): string {
  const f = join(root, "fake-vite.mjs");
  writeFileSync(f, `import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const mode = process.env.FAKE_MODE ?? "ok";
if (mode === "crash") { console.error("boom at startup"); process.exit(3); }
const items = mode === "nobind-empty" ? [] : [
  { id: "a/One", name: "One", group: "a", island: false, states: ["default", "two words"] },
  ...(mode === "broken" ? [{ id: "a/Bad", name: "Bad", group: "a", island: false, states: [], error: "a/Bad: no component" }] : []),
  ...(mode === "render-fail" ? [{ id: "a/Fail", name: "Fail", group: "a", island: false, states: ["x"] }] : []),
];
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/__preview/api/manifest") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ adapterBind: mode !== "nobind", items })); }
  if (u.pathname.startsWith("/__preview/frame/")) {
    if (u.pathname.endsWith("/a/Fail") ) { res.statusCode = 500; return res.end("preview render error: kaboom\\nstack"); }
    return res.end("<p>" + decodeURIComponent(u.pathname.slice(17)) + ":" + u.searchParams.get("s") + ":" + (process.env.MOCK ?? "") + "</p>\\r\\n");
  }
  res.statusCode = 404; res.end();
}).listen(port, "127.0.0.1");
`);
  return f;
}
const run = async (mode: string, o: Partial<Parameters<typeof runExport>[0]> = {}) => {
  const root = tmp();
  const log: string[] = [];
  process.env.FAKE_MODE = mode;
  const code = await runExport({ root, viteBin: fakeVite(root), log: (m) => log.push(m), timeoutMs: 15000, ...o });
  delete process.env.FAKE_MODE;
  return { root, code, log };
};

describe("runExport", () => {
  it("renders every state, writes the layout, second run changes nothing, --check agrees", async () => {
    const a = await run("ok");
    expect(a.code).toBe(0);
    const out = join(a.root, "patterns-export");
    expect(readFileSync(join(out, "a/One/default.html"), "utf8")).toBe("<p>a/One:default:</p>\n");
    expect(readFileSync(join(out, "a/One/two_words.html"), "utf8")).toBe("<p>a/One:two words:</p>\n"); // file-safe name, original state name in the request
    expect(a.log.join("\n")).toMatch(/exported 2 fragments from 1 components to patterns-export \(4 written, 0 removed\)/);
    expect(a.log.join("\n")).toMatch(/no dist\/client/);
    process.env.FAKE_MODE = "ok";
    const again: string[] = [];
    expect(await runExport({ root: a.root, viteBin: join(a.root, "fake-vite.mjs"), log: (m) => again.push(m) })).toBe(0);
    expect(again.join("\n")).toMatch(/0 written, 0 removed/);
    const chk: string[] = [];
    expect(await runExport({ root: a.root, viteBin: join(a.root, "fake-vite.mjs"), check: true, log: (m) => chk.push(m) })).toBe(0);
    expect(chk.join("\n")).toMatch(/up to date \(2 fragments\)/);
    writeFileSync(join(out, "a/One/default.html"), "changed");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runExport({ root: a.root, viteBin: join(a.root, "fake-vite.mjs"), check: true, log: () => {} })).toBe(1);
    expect(err.mock.calls.join("\n")).toMatch(/~ a\/One\/default\.html/);
    delete process.env.FAKE_MODE;
  });
  it("--mock sets MOCK=1 for the dev server; --out is honoured", async () => {
    const a = await run("ok", { mock: true, out: "frag" });
    expect(a.code).toBe(0);
    expect(readFileSync(join(a.root, "frag/a/One/default.html"), "utf8")).toBe("<p>a/One:default:1</p>\n");
  });
  it("fails without writing: a component error in the manifest, a failing render", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = await run("broken");
    expect(b.code).toBe(1); expect(existsSync(join(b.root, "patterns-export"))).toBe(false);
    expect(err.mock.calls.join("\n")).toContain("a/Bad: no component");
    const c = await run("render-fail");
    expect(c.code).toBe(1); expect(existsSync(join(c.root, "patterns-export"))).toBe(false);
    expect(err.mock.calls.join("\n")).toMatch(/a\/Fail\/x: preview render error: kaboom/);
  });
  it("clear errors: adapter without bind, no components, dev server that exits, dev server that never answers", async () => {
    await expect(run("nobind")).rejects.toThrow(/cannot render components/);
    await expect(run("nobind-empty")).rejects.toThrow(/no components found/);
    await expect(run("crash")).rejects.toThrow(/exited before it was ready[\s\S]*boom at startup/);
    const root = tmp(); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "silent.mjs"), "setInterval(() => {}, 1000);");
    await expect(runExport({ root, viteBin: join(root, "silent.mjs"), timeoutMs: 800 })).rejects.toThrow(/did not answer/);
  });
});
