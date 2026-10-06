import { createServer, type Server } from "node:http";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "vite";
import { fonts } from "../packages/cf-lite/src/vite-fonts.js";

// Lighthouse-style CLS check: the web font arrives late (artificial delay), text swaps from the fallback to the web font.
// With the generated size-adjust fallback the swap must shift (much) less than with an unadjusted system fallback.
const TEXT = "Sơn nội thất hiện đại cho căn hộ của bạn. ".repeat(6);
const TYPES: Record<string, string> = { ".html": "text/html", ".woff2": "font/woff2", ".js": "text/javascript", ".css": "text/css" };
let server: Server, base = "", dist = "";

test.beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "cf-cls-"));
  mkdirSync(join(root, "src"));
  cpSync(join(import.meta.dirname, "../packages/cf-lite/test/fixtures/be-vietnam-pro-400-latin.woff2"), join(root, "src/f.woff2"));
  const page = (body: string) => `<!doctype html><html><head><meta charset=utf-8><title>cls</title></head><body style="margin:0;font:18px/1.5 var(--font-be-vietnam-pro)"><div style="width:420px">${body}</div></body></html>`;
  writeFileSync(join(root, "index.html"), page(`<p>${TEXT}</p><p>second</p>`));
  await build({ root, logLevel: "silent", configFile: false, plugins: [fonts({ family: "Be Vietnam Pro", source: "local", files: [{ path: "src/f.woff2", weight: 400 }], preload: false })] });
  dist = join(root, "dist");
  // same page with the fallback face stripped (plain Arial-class fallback, no metric overrides)
  const html = readFileSync(join(dist, "index.html"), "utf8");
  writeFileSync(join(dist, "raw.html"), html.replace(/@font-face\{font-family:"Be Vietnam Pro Fallback"[^}]*\}/, "").replace(/"Be Vietnam Pro Fallback",/g, ""));
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const file = join(dist, path === "/" ? "index.html" : path);
    if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404).end(); return; }
    const send = () => { res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }); res.end(readFileSync(file)); };
    extname(file) === ".woff2" ? setTimeout(send, 600) : send();
  }).listen(0);
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});
test.afterAll(() => server.close());

const heights: Record<string, number[]> = {};
async function cls(page: import("@playwright/test").Page, path: string) {
  await page.addInitScript(() => {
    (window as any).__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(base + path, { waitUntil: "commit" });
  await page.waitForSelector("p");
  const before = await page.evaluate(() => document.querySelector("div")!.getBoundingClientRect().height);
  await page.waitForFunction(() => document.fonts.status === "loaded" && [...document.fonts].some((f) => f.family.includes("Be Vietnam") && f.status === "loaded"));
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.querySelector("div")!.getBoundingClientRect().height);
  heights[path] = [before, after];
  return page.evaluate(() => (window as any).__cls as number);
}

test("font swap with generated fallback metrics: CLS stays under 0.1 and below the unadjusted fallback", async ({ page, browser }) => {
  const adjusted = await cls(page, "/");
  const raw = await cls(await browser.newPage(), "/raw.html");
  console.log(`CLS adjusted=${adjusted.toFixed(4)} raw=${raw.toFixed(4)}`);
  expect(adjusted).toBeLessThan(0.1);
  expect(heights["/"][0]).toBe(heights["/"][1]); // no reflow at all with the adjusted fallback
  expect(heights["/raw.html"][0]).not.toBe(heights["/raw.html"][1]); // control: the unadjusted fallback does reflow
  expect(adjusted).toBeLessThan(raw);
});
