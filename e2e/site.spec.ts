import { expect, test } from "@playwright/test";
import { checkA11y } from "../packages/playwright/src/index";

const desc = (page: import("@playwright/test").Page) => page.locator('meta[name="description"]').evaluateAll((e) => e.map((x) => x.getAttribute("content")));

test("static / is prerendered with zero JS and its own head", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", (r) => r.resourceType() === "script" && scripts.push(r.url()));
  await page.goto("/");
  await expect(page.getByTestId("h")).toHaveText("Home (static)");
  await expect(page).toHaveTitle("Home — site");
  expect(await desc(page)).toEqual(["static home"]);
  await expect(page.getByTestId("l-root")).toBeVisible();
  expect(scripts).toEqual([]);
});

test("SPA route under static /: direct load boots from its own shell, nested layouts + head, client-side nav", async ({ page }) => {
  await page.goto("/app/dashboard");
  await expect(page.getByTestId("h")).toHaveText("Dashboard (spa)");
  await expect(page.getByTestId("l-root").getByTestId("l-app")).toBeVisible();
  await expect(page).toHaveTitle("Dashboard — site");
  expect(await desc(page)).toEqual(["site default"]);
  await page.getByTestId("inc").click();
  await expect(page.getByTestId("inc")).toHaveText("clicked 1");
  await page.getByTestId("rpc").click(); // typed hc<ApiType> call to the Hono API
  await expect(page.getByTestId("rpc-out")).toHaveText("hello site");
  await page.evaluate(() => ((window as any).__m = 1));
  // layouts stay mounted across SPA navigations: same DOM element identity for the root + app layouts
  await page.evaluate(() => { for (const id of ["l-root", "l-app"]) ((document.querySelector(`[data-testid=${id}]`) as any).__keep = id); });
  await page.getByRole("link", { name: "settings" }).click();
  await expect(page).toHaveURL(/\/app\/settings$/);
  expect(await page.evaluate(() => ["l-root", "l-app"].map((id) => (document.querySelector(`[data-testid=${id}]`) as any).__keep))).toEqual(["l-root", "l-app"]);
  await expect(page.getByTestId("h")).toHaveText("Settings (spa)");
  await expect(page).toHaveTitle("Settings — site");
  expect(await desc(page)).toEqual(["settings"]);
  expect(await page.evaluate(() => (window as any).__m)).toBe(1); // no reload
  await page.goBack();
  await expect(page.getByTestId("h")).toHaveText("Dashboard (spa)");
  await expect(page).toHaveTitle("Dashboard — site");
  expect(await desc(page)).toEqual(["site default"]);
});

test("static / -> SPA link is a document navigation; unknown path is a real 404", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "dashboard" }).click(); // "/" is static: normal navigation, then the SPA boots
  await expect(page.getByTestId("h")).toHaveText("Dashboard (spa)");
  const r = await page.goto("/no/such/page");
  expect(r!.status()).toBe(404);
});

test("ssr + hydrate page: nested layouts, head, hydrates, SPA link back", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/blog/hello");
  await expect(page.getByTestId("l-root").getByTestId("l-blog").getByTestId("h")).toHaveText("Blog hello");
  await expect(page).toHaveTitle("hello — site blog");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://example.com/blog/hello");
  await page.waitForLoadState("networkidle"); // hydration bundle loaded and run
  await page.evaluate(() => ((window as any).__m = 1));
  await page.getByRole("link", { name: "settings" }).click(); // hydrated Link -> SPA navigation, no reload
  await expect(page.getByTestId("h")).toHaveText("Settings (spa)");
  expect(await page.evaluate(() => (window as any).__m)).toBe(1);
  expect(errors).toEqual([]); // no hydration mismatch
});

// 2.9 a11y: after a client-side navigation every adapter must announce the new page, move focus to the content and reset scroll.
// (Runs once per adapter app: site, site-preact, site-vue, site-svelte, site-solid. The router lives in cf-lite; the adapter owns the view swap.)
test("client navigation: route announcer, focus moves to main, scroll resets, keyboard + back work", async ({ page }) => {
  await page.goto("/app/dashboard");
  await expect(page.getByTestId("h")).toHaveText("Dashboard (spa)");
  const state = () => page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null, ann = document.querySelectorAll("#cf-lite-announcer");
    return { focus: a?.tagName, announcers: ann.length, text: ann[0]?.textContent, live: ann[0]?.getAttribute("aria-live"), title: document.title, y: scrollY };
  });
  // the announce/focus step runs in a macrotask after the adapter re-rendered: wait for it instead of racing the DOM update
  const settled = async (text: string) => { await expect.poll(async () => { const x = await state(); return x.focus === "MAIN" && x.text === text; }).toBe(true); return state(); };
  expect((await state()).announcers).toBe(0); // created lazily by the first client navigation

  await page.evaluate(() => { document.body.style.minHeight = "4000px"; scrollTo(0, 1500); });
  expect((await state()).y).toBeGreaterThan(1000);
  await page.getByRole("link", { name: "settings" }).click();
  await expect(page.getByTestId("h")).toHaveText("Settings (spa)");
  let s = await settled("Settings — site");
  expect(s).toMatchObject({ focus: "MAIN", announcers: 1, live: "polite", y: 0 });
  expect(s.text).toBe(s.title); expect(s.title).toBe("Settings — site");

  // keyboard-only: focus a link, press Enter -> same contract, still exactly one announcer (it is reused, not re-created)
  const link = page.getByRole("link", { name: "dashboard" });
  await link.focus(); await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("h")).toHaveText("Dashboard (spa)");
  s = await settled("Dashboard — site");
  expect(s).toMatchObject({ focus: "MAIN", announcers: 1 });

  // browser back is a navigation too
  await page.goBack();
  await expect(page.getByTestId("h")).toHaveText("Settings (spa)");
  s = await settled("Settings — site");
  expect(s).toMatchObject({ focus: "MAIN", announcers: 1 });
  await checkA11y(page); // the swapped view (and the injected announcer) must be axe clean in every adapter
});
