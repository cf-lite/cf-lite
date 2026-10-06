/**
 * Playwright fixtures for cf-lite apps.
 *
 *   import { test, expect } from "@cf-lite/playwright";
 *   test.use({ appOptions: { dir: "." } });                     // boots `wrangler dev` once per worker process
 *   test("static pages never run the Worker", async ({ page, app }) => {
 *     await page.goto("/about/");
 *     app.expectWorkerPaths([]);                            // which requests hit the Worker
 *   });
 *   test("a11y", async ({ page, a11y }) => { await page.goto("/"); await a11y(); });
 *
 * "Which requests hit the Worker" relies on one log line in your worker entry (the demo has it):
 *   console.log("[worker]", new URL(req.url).pathname)
 * The marker is configurable (`workerLogPattern`).
 */
import { test as base, expect as baseExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

export interface AppOptions {
  /** App directory (contains wrangler config + built output). Default ".". */
  dir?: string;
  /** Use an already running server instead of booting one. */
  baseURL?: string;
  /** Extra args for `wrangler dev`. */
  args?: string[];
  /** Regex with one capture group: the request path, from a log line your worker prints. Default `\[worker\] (\S+)`. */
  workerLogPattern?: RegExp;
  /** ms to wait for "Ready on". Default 90_000. */
  startTimeout?: number;
}

export interface App {
  baseURL: string;
  /** Paths that reached the Worker since the last `resetHits()` (from the worker log marker). */
  workerHits(): string[];
  resetHits(): void;
  /** Wait for the log to settle, then assert the exact list (order-insensitive) of Worker-invoking paths since the last reset. */
  expectWorkerPaths(paths: string[]): Promise<void>;
  /** Raw wrangler output (debugging). */
  log(): string;
  stop(): Promise<void>;
}

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer(); s.on("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

/** Boot `wrangler dev` for `dir` and track Worker invocations. Also usable outside Playwright fixtures (global setup, scripts). */
export async function startApp(opts: AppOptions = {}): Promise<App> {
  const pattern = new RegExp(opts.workerLogPattern ?? /\[worker\] (\S+)/, (opts.workerLogPattern?.flags ?? "").replace("g", "") + "g");
  let log = "", mark = 0;
  const hits = () => [...log.matchAll(pattern)].map((m) => m[1]);
  const base = () => hits().slice(mark);
  const settle = () => new Promise((r) => setTimeout(r, 300));
  if (opts.baseURL) return mk(opts.baseURL, async () => {});
  const dir = resolve(opts.dir ?? ".");
  const pj = createRequire(join(dir, "x.js")).resolve("wrangler/package.json");
  const bin = join(dirname(pj), (JSON.parse(readFileSync(pj, "utf8")) as { bin: { wrangler: string } }).bin.wrangler);
  const port = await freePort();
  const child = spawn(process.execPath, [bin, "dev", "--port", String(port), "--show-interactive-dev-session=false", ...(opts.args ?? [])], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  let exited = false; child.on("exit", () => (exited = true));
  const kill = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch {} };
  process.once("exit", kill);
  const deadline = Date.now() + (opts.startTimeout ?? 90_000);
  while (!log.includes("Ready on") && !exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  if (!log.includes("Ready on")) { kill(); throw new Error("wrangler dev did not start:\n" + log.slice(-2000)); }
  return mk(`http://localhost:${port}`, async () => { process.off("exit", kill); kill(); });

  function mk(baseURL: string, stop: () => Promise<void>): App {
    return {
      baseURL, workerHits: base, resetHits: () => { mark = hits().length; }, log: () => log, stop,
      async expectWorkerPaths(paths) { await settle(); baseExpect(base().sort()).toEqual([...paths].sort()); },
    };
  }
}

// ---- axe -------------------------------------------------------------------------------------------------------------

export type Impact = "minor" | "moderate" | "serious" | "critical";
export interface A11yOptions {
  /** Fail on violations at or above this impact. Default "serious" (serious + critical). */
  failOn?: Impact;
  /** CSS selectors to scope / exclude. */
  include?: string[]; exclude?: string[];
  /** axe rule ids to disable (document why at the call site). */
  disableRules?: string[];
  /** axe tags. Default WCAG 2.0/2.1/2.2 A + AA. */
  tags?: string[];
}
const ORDER: Impact[] = ["minor", "moderate", "serious", "critical"];

/** Run axe-core on the current page state; throws listing every violation at/above `failOn`. Returns all violations. */
export async function checkA11y(page: Page, opts: A11yOptions = {}) {
  let b = new AxeBuilder({ page }).withTags(opts.tags ?? ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  for (const s of opts.include ?? []) b = b.include(s);
  for (const s of opts.exclude ?? []) b = b.exclude(s);
  if (opts.disableRules?.length) b = b.disableRules(opts.disableRules);
  const { violations } = await b.analyze();
  const min = ORDER.indexOf(opts.failOn ?? "serious");
  const bad = violations.filter((v) => ORDER.indexOf((v.impact ?? "minor") as Impact) >= min);
  if (bad.length) {
    throw new Error(`${bad.length} accessibility violation(s) on ${page.url()}:\n` + bad.map((v) =>
      ` - [${v.impact}] ${v.id}: ${v.help} (${v.helpUrl})\n${v.nodes.slice(0, 3).map((n) => `     ${n.target.join(" ")}`).join("\n")}`).join("\n"));
  }
  return violations;
}

// ---- fixtures --------------------------------------------------------------------------------------------------------

export const test = base.extend<{ a11y: (opts?: A11yOptions) => Promise<void> }, { app: App; appOptions: AppOptions }>({
  appOptions: [{}, { option: true, scope: "worker" }],
  app: [async ({ appOptions }, use) => { const a = await startApp(appOptions); await use(a); await a.stop(); }, { scope: "worker", auto: false }],
  baseURL: async ({ app }, use) => use(app.baseURL),
  a11y: async ({ page }, use) => use(async (o) => { await checkA11y(page, o); }),
});
export const expect = baseExpect;
