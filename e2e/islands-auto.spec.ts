import { test, expect, type Page } from "@playwright/test";

// Auto-islands (docs/islands.md#auto-islands): no `*.island.tsx` in the app; `islands: { auto: true }` wraps the interactive components of app/components.
const jsRequests = (page: Page) => { const urls: string[] = []; page.on("request", (r) => { if (/\.js(\?|$)/.test(r.url())) urls.push(new URL(r.url()).pathname); }); return urls; };
const errorsOf = (page: Page) => { const e: string[] = []; page.on("pageerror", (x) => e.push(String(x))); page.on("console", (m) => m.type() === "error" && e.push(m.text())); return e; };

test("a page whose components are all static ships zero JS", async ({ page }) => {
  const js = jsRequests(page);
  await page.goto("/plain");
  await page.waitForLoadState("networkidle");
  expect(js).toEqual([]);
  expect(await page.locator("cfl-island").count()).toBe(0);
});

test("interactive components are islands with no marker: default + named exports, strategy per module", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto("/");
  await expect(page.locator('cfl-island[data-i="app/components/Counter"]')).toHaveCount(1);
  await expect(page.locator('cfl-island[data-i="app/components/Widgets#Like"]')).toHaveCount(2);
  await expect(page.getByTestId("badge").locator("xpath=ancestor::cfl-island")).toHaveCount(0); // static: not an island
  // Counter: default strategy for auto islands is `visible`; it is on screen so it hydrates and works
  await expect(page.locator('cfl-island[data-i="app/components/Counter"]')).toHaveAttribute("data-h", "");
  await page.getByTestId("counter").click();
  await expect(page.getByTestId("counter")).toHaveText("clicks: 3");
  // Widgets declares `client = "idle"` for its whole module
  await expect(page.locator('cfl-island[data-i="app/components/Widgets#Like"]').first()).toHaveAttribute("data-w", "idle");
  await expect(page.locator('cfl-island[data-i="app/components/Widgets#Like"]').first()).toHaveAttribute("data-h", "", { timeout: 5000 });
  await page.getByTestId("like-a").click();
  await expect(page.getByTestId("like-a")).toHaveText("liked a");
  await expect(page.getByTestId("like-b")).toHaveText("like b");
  expect(errors).toEqual([]);
});

test("children and function props never throw: the component renders plainly / inside its parent island", async ({ page }) => {
  const errors = errorsOf(page);
  await page.goto("/");
  // Panel takes children: no island wrapper, server HTML only (handlers are dead without hydration)
  await expect(page.getByTestId("panel-body")).toBeVisible();
  await expect(page.getByTestId("panel").locator("xpath=ancestor::cfl-island")).toHaveCount(0);
  // Picker is an island; its Row children get function props -> plain components inside Picker's tree, so the click reaches Picker's state
  await expect(page.locator('cfl-island[data-i="app/components/Widgets#Picker"]')).toHaveAttribute("data-h", "", { timeout: 5000 });
  await expect(page.locator('cfl-island[data-i="app/components/Widgets#Row"]')).toHaveCount(0);
  await page.getByTestId("row-y").click();
  await expect(page.getByTestId("picked")).toHaveText("picked: y");
  expect(errors).toEqual([]);
});

test("`export const island = false` opts a module out", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("optout").locator("xpath=ancestor::cfl-island")).toHaveCount(0);
  await page.getByTestId("optout").click(); // no hydration: nothing happens
  await expect(page.getByTestId("optout")).toHaveText("optout 0");
});

test("SSR page: auto island hydrates too", async ({ page }) => {
  await page.goto("/live");
  await expect(page.locator('cfl-island[data-i="app/components/Counter"]')).toHaveAttribute("data-h", "");
  await page.getByTestId("counter").click();
  await expect(page.getByTestId("counter")).toHaveText("clicks: 6");
});
