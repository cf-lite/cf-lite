import { test, expect, type Page } from "@playwright/test";

// Vue SSR islands (`*.island.vue`, docs/islands.md): static `/` with load / idle / visible / interaction islands, `/plain` without any, streamed SSR `/live`.
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
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errors.push(m.text()));
  await page.goto("/");
  // before any JS the server HTML is already there
  await expect(page.getByTestId("counter")).toHaveText("clicks: 2");
  // load: hydrated and interactive (props came from data-p)
  await expect(page.locator('cfl-island[data-i="app/islands/Counter"]')).toHaveAttribute("data-h", "");
  await page.getByTestId("counter").click();
  await expect(page.getByTestId("counter")).toHaveText("clicks: 3");
  // idle
  await expect(page.locator('cfl-island[data-i="app/islands/Idle"]')).toHaveAttribute("data-h", "", { timeout: 5000 });
  await page.getByTestId("idle").click();
  await expect(page.getByTestId("idle")).toHaveText("idle on");
  // visible: not hydrated and its chunk is not fetched until scrolled to
  expect(await hydrated(page, "Lazy")).toBe(false);
  expect(js.some((u) => /Lazy\.island/.test(u))).toBe(false);
  await page.getByTestId("visible-low").scrollIntoViewIfNeeded();
  await expect(page.locator('cfl-island[data-i="app/islands/Lazy"]')).toHaveAttribute("data-h", "");
  await page.getByTestId("visible-low").click();
  await expect(page.getByTestId("visible-low")).toHaveText("visible low: 1");
  // interaction: untouched = no chunk; the first click is replayed once hydrated
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(js.some((u) => /Menu\.island/.test(u))).toBe(false);
  await page.getByTestId("menu-btn").click();
  await expect(page.getByTestId("menu-list")).toBeVisible();
  expect(errors).toEqual([]); // no hydration mismatch warnings either
});

test("props are escaped (no markup injection)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('cfl-island[data-i="app/islands/Echo"]')).toHaveAttribute("data-h", "");
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator("img[src=x]").count()).toBe(0);
  await expect(page.getByTestId("echo")).toContainText('</script><img src=x onerror="window.__xss=1">&"<');
});

test("streamed SSR page: islands get loader props, hydrate, and loader text is escaped", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(String(e))); page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errors.push(m.text()));
  await page.goto("/live?name=" + encodeURIComponent("<i onclick=1>"));
  await expect(page.locator("h1")).toHaveText("Live <i onclick=1>");
  const c = page.locator('cfl-island[data-i="app/islands/Counter"]');
  await expect(c).toHaveAttribute("data-h", "", { timeout: 5000 });
  await expect(c.locator("button")).toHaveText("count: 5");
  await c.locator("button").click();
  await expect(c.locator("button")).toHaveText("count: 6");
  expect(await page.locator("i[onclick]").count()).toBe(0);
  expect(errors).toEqual([]);
});
