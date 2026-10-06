import { expect, test } from "@playwright/test";

test("SPA home calls the typed API and navigates client-side", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("api-msg")).toHaveText("hello cf-lite");
  await page.evaluate(() => ((window as any).__marker = 1));
  await page.getByRole("link", { name: /counter/ }).click();
  await expect(page).toHaveURL(/\/counter$/);
  await page.getByTestId("inc").click();
  await expect(page.getByTestId("inc")).toHaveText("clicked 1");
  expect(await page.evaluate(() => (window as any).__marker)).toBe(1); // no full reload
});

test("static page is prerendered, zero JS", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", (r) => r.resourceType() === "script" && scripts.push(r.url()));
  await page.goto("/about/");
  await expect(page.locator("h1")).toHaveText("About");
  expect(scripts).toEqual([]);
});

test("ssr page renders per request with loader data", async ({ page }) => {
  await page.goto("/posts/99");
  await expect(page.getByTestId("post-id")).toHaveText("Post 99");
  await expect(page.getByTestId("rendered-at")).toContainText("Rendered at 20");
});

test("durable object websocket echo from the browser", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /join room/ }).click();
  await expect(page.getByTestId("ws-log")).toContainText("echo: hello from the browser");
});

test("static redirect", async ({ request }) => {
  const r = await request.get("/go/example", { maxRedirects: 0 });
  expect(r.status()).toBe(302);
});

test("nested layouts: root wraps every page, posts layout only its subtree (spa, static, ssr)", async ({ page }) => {
  await page.goto("/counter");
  await expect(page.getByTestId("layout-root")).toBeVisible();
  await expect(page.getByTestId("layout-posts")).toHaveCount(0);
  await page.goto("/about/");
  await expect(page.getByTestId("layout-root")).toBeVisible();
  await page.goto("/posts/5");
  await expect(page.getByTestId("layout-root")).toBeVisible();
  await expect(page.getByTestId("layout-posts").getByTestId("post-id")).toHaveText("Post 5");
});

test("head: title/meta/link per route, updated on SPA navigation and restored", async ({ page }) => {
  const desc = () => page.locator('meta[name="description"]').evaluateAll((e) => e.map((x) => x.getAttribute("content")));
  await page.goto("/");
  await expect(page).toHaveTitle("cf-lite demo");
  expect(await desc()).toEqual(["cf-lite demo"]); // root layout head
  await page.evaluate(() => ((window as any).__m = 1));
  await page.getByRole("link", { name: /counter/ }).click();
  await expect(page).toHaveTitle("Counter — cf-lite");
  expect(await desc()).toEqual(["SPA counter"]); // route overrides layout, no duplicate
  await page.getByRole("link", { name: "home" }).click();
  await expect(page).toHaveTitle("cf-lite demo"); // restored
  expect(await desc()).toEqual(["cf-lite demo"]);
  expect(await page.evaluate(() => (window as any).__m)).toBe(1);
});

test("head in ssr + static documents (no JS needed)", async ({ page }) => {
  await page.goto("/posts/7");
  await expect(page).toHaveTitle("Post 7 — cf-lite");
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Post 7");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/posts\/7$/);
  await page.goto("/about/");
  await expect(page).toHaveTitle("About — cf-lite");
});
