import { test, expect, type Page } from "@playwright/test";
import { gzipSync } from "node:zlib";

// SSR islands (docs/islands.md): static `/` with six island kinds, `/plain` without any, SSR `/live` (streamed) and `/hyd` (whole-page hydration).
const jsRequests = (page: Page) => { const urls: string[] = []; page.on("request", (r) => { if (/\.js(\?|$)/.test(r.url())) urls.push(new URL(r.url()).pathname); }); return urls; };
const hydrated = (page: Page, id: string) => page.locator(`cfl-island[data-i="app/islands/${id}"]`).first().evaluate((e) => e.hasAttribute("data-h"));

test("a page without islands ships zero JS and no script tags", async ({ page }) => {
  const js = jsRequests(page);
  await page.goto("/plain");
  await page.waitForLoadState("networkidle");
  expect(js).toEqual([]);
  expect(await page.locator("script").count()).toBe(0);
  expect(await page.locator("cfl-island").count()).toBe(0);
});

test("static page: load island hydrates, strategies wait for their trigger", async ({ page }) => {
  const js = jsRequests(page);
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/");
  // load: hydrated and interactive
  await expect(page.locator('cfl-island[data-i="app/islands/Counter"]')).toHaveAttribute("data-h", "");
  await page.getByTestId("counter").click();
  await expect(page.getByTestId("counter")).toHaveText("clicks: 3");
  // idle: hydrates by itself shortly after load
  await expect(page.locator('cfl-island[data-i="app/islands/Idle"]')).toHaveAttribute("data-h", "", { timeout: 5000 });
  await page.getByTestId("idle").click();
  await expect(page.getByTestId("idle")).toHaveText("idle on");
  // visible: below the fold, not hydrated and its chunk is not fetched until scrolled to
  expect(await hydrated(page, "Lazy")).toBe(false);
  expect(js.some((u) => /Lazy\.island/.test(u))).toBe(false);
  await page.getByTestId("visible-low").scrollIntoViewIfNeeded();
  await expect(page.locator('cfl-island[data-i="app/islands/Lazy"]')).toHaveAttribute("data-h", "");
  await page.getByTestId("visible-low").click();
  await expect(page.getByTestId("visible-low")).toHaveText("visible low: 1");
  // interaction: untouched = not hydrated, no chunk; the first click is replayed once hydrated
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(js.some((u) => /Menu\.island/.test(u))).toBe(false);
  await page.getByTestId("menu-btn").click();
  await expect(page.getByTestId("menu-list")).toBeVisible();
  expect(errors).toEqual([]);
});

test("props are escaped (no markup injection), several islands share one runtime", async ({ page }) => {
  const js = jsRequests(page);
  await page.goto("/");
  await expect(page.getByTestId("echo")).toHaveAttribute("data-ready", "true"); // hydrated: useEffect ran
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator("img[src=x]").count()).toBe(0);
  await expect(page.getByTestId("echo")).toContainText('</script><img src=x onerror="window.__xss=1">&"<');
  // two Shared islands, independent state, one chunk fetch for the component
  const [a, b] = await page.getByTestId("shared").all();
  await a!.click(); await b!.click(); await b!.click();
  await expect(a!).toHaveText("shared 1");
  await expect(b!).toHaveText("shared 20");
  expect(js.filter((u) => /Shared\.island/.test(u)).length).toBe(1);
  expect(js.filter((u) => /islands-[\w-]+\.js/.test(u)).length).toBeGreaterThanOrEqual(1);
  const rt = js.filter((u) => /preload-helper|react/.test(u));
  expect(new Set(rt).size).toBe(rt.length); // the shared runtime chunk is fetched once
});

test("streamed SSR page: late Suspense island hydrates; loader props are escaped", async ({ page }) => {
  await page.goto("/live?name=" + encodeURIComponent("<i onclick=1>"));
  await expect(page.locator("h1")).toHaveText("Live <i onclick=1>");
  const late = page.locator('cfl-island[data-i="app/islands/Counter"]').nth(1);
  await expect(late).toHaveAttribute("data-h", "", { timeout: 5000 });
  await late.locator("button").click();
  await expect(late.locator("button")).toHaveText("late: 8");
});

test("hydrate=true page hydrates as a whole: no island runtime", async ({ page }) => {
  const js = jsRequests(page);
  const rt = ((await (await page.request.get("/_islands.json")).json()) as { runtime: string }).runtime;
  await page.goto("/hyd");
  await page.getByTestId("counter").click();
  await expect(page.getByTestId("counter")).toHaveText("count: 2");
  expect(js.includes(rt)).toBe(false);
  expect(await page.locator("cfl-island[data-h]").count()).toBe(0);
});

// strict CSP is on (static: hashes, SSR: nonce): the runtime <script>/<style> must be allowed, nothing may be blocked
for (const path of ["/", "/ssr", "/hyd", "/plain"]) {
  test(`no CSP violations on ${path} (islands hydrate under a strict policy)`, async ({ page }) => {
    const v: string[] = [];
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error("CSP violation: " + e.violatedDirective + " " + e.blockedURI)));
    page.on("console", (m) => m.type() === "error" && v.push(m.text()));
    page.on("pageerror", (e) => v.push(String(e)));
    const res = await page.goto(path);
    expect(res!.headers()["content-security-policy"]).toBeTruthy();
    await page.waitForLoadState("networkidle");
    if (path === "/ssr") await expect(page.locator("cfl-island[data-h]")).toHaveCount(2, { timeout: 5000 });
    if (path === "/") await expect(page.locator("cfl-island[data-h]")).toHaveCount(5, { timeout: 5000 }); // load: Counter, Echo, Shared x2, plus idle
    expect(v).toEqual([]);
  });
}

test("size gate: the island runtime entry stays tiny (framework chunk is shared and separate)", async ({ page }) => {
  const rt = ((await (await page.request.get("/_islands.json")).json()) as { runtime: string }).runtime;
  const body = await (await page.request.get(rt)).body();
  expect(gzipSync(body, { level: 9 }).length).toBeLessThan(1600); // measured ~1.1 KB gz (scheduler + loader map); bump deliberately
});

test("modulepreload: runtime closure + load islands are hinted (static and SSR), lazy islands are not", async ({ page }) => {
  for (const path of ["/", "/ssr"]) {
    await page.goto(path);
    const hints = await page.locator('link[rel="modulepreload"]').evaluateAll((l) => l.map((x) => new URL((x as HTMLLinkElement).href).pathname));
    const mf = (await (await page.request.get("/_islands.json")).json()) as { runtime: string; preload: string[]; islands: Record<string, { w: string; deps: string[] }> };
    expect(hints.length).toBeGreaterThan(0);
    for (const h of mf.preload) expect(hints).toContain(h);
    for (const [id, i] of Object.entries(mf.islands)) {
      const onPage = (await page.locator(`cfl-island[data-i="${id}"]`).count()) > 0;
      if (onPage && i.w === "load") for (const d of i.deps) expect(hints, `${path}: ${id}`).toContain(d);
      if (i.w === "visible" || i.w === "interaction") for (const d of i.deps.slice(0, 1)) expect(hints, `${path}: ${id} must not be preloaded`).not.toContain(d);
    }
    expect(hints).not.toContain(mf.runtime); // the runtime itself is the <script>
  }
});
