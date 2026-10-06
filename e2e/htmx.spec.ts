import { expect, test } from "@playwright/test";

// `cf-lite add htmx`: renderer "none", UI = server-rendered Hono fragments + hx-* attributes + Alpine. Runs against examples/site-htmx.

test("shell loads the first fragment from the Worker; no framework, no hydration", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const fragments: string[] = [];
  page.on("request", (r) => r.url().includes("/api/ui") && fragments.push(new URL(r.url()).pathname));
  await page.goto("/");
  await expect(page.getByTestId("l-root").getByTestId("h")).toHaveText("Home");
  expect(fragments).toEqual(["/api/ui"]);
  expect(errors).toEqual([]);
});

test("hx-get nav swaps fragments without a document navigation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("h")).toHaveText("Home");
  await page.evaluate(() => ((window as any).__m = 1));
  await page.getByTestId("nav-about").click();
  await expect(page.getByTestId("h")).toHaveText("About");
  await page.getByTestId("nav-blog").click();
  await expect(page.getByTestId("l-blog").getByTestId("h")).toHaveText("Blog hello");
  await expect(page.getByTestId("at")).toHaveText(/^\d{4}-\d\d-\d\dT/);
  expect(await page.evaluate(() => (window as any).__m)).toBe(1); // same document throughout
});

test("hx-post round trip keeps state in the request, Alpine toggles client-side", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-dashboard").click();
  await page.getByTestId("inc").click();
  await expect(page.getByTestId("inc")).toHaveText("clicked 1");
  await page.getByTestId("inc").click();
  await expect(page.getByTestId("inc")).toHaveText("clicked 2");
  await expect(page.getByTestId("alpine")).toBeHidden();
  await page.getByTestId("toggle").click(); // Alpine initialised on htmx-swapped content
  await expect(page.getByTestId("alpine")).toBeVisible();
  await page.getByTestId("rpc").click();
  await expect(page.getByTestId("rpc-out")).toHaveText("hello site");
});

test("fragments are escaped HTML from the Worker and unknown fragments 404", async ({ request }) => {
  const r = await request.get("/api/ui/page/blog/%3Cb%3Ex");
  expect(r.headers()["content-type"]).toContain("text/html");
  const t = await r.text();
  expect(t).toContain("Blog &lt;b&gt;x");
  expect(t).not.toContain("<b>x");
  expect((await request.get("/api/ui/page/nope")).status()).toBe(404);
  expect((await request.post("/api/ui/count", { form: { n: "41" } })).status()).toBe(200);
});
