import { expect, test } from "@playwright/test";

// The mock CMS editor iframing the head in preview: save a draft -> the framed page live-refreshes (postMessage content-saved listener), without publishing.
test("editor: pick -> preview iframe shows the draft -> save refreshes it live; public page stays published", async ({ page, request }) => {
  await request.post("/api/cms/admin/reset", { headers: { authorization: "Bearer demo-cms-token" } });
  await page.goto("/api/cms/editor");
  await page.locator("#tok").fill("demo-cms-token");
  await page.locator("#load").click();
  await page.locator('li[data-id="page-about-en"]').click();
  const frame = page.frameLocator("#pv");
  await expect(frame.getByTestId("preview-badge")).toBeVisible();
  await expect(frame.getByTestId("hero")).toHaveText("About");
  await page.locator("#title").fill("About, edited live");
  await page.locator("#save").click();
  await expect(page.locator("#msg")).toContainText("saved v2");
  // the doc title is what the edit changes: read it from the framed page, which must have reloaded itself
  await expect.poll(async () => (await page.frame({ url: /\/en\/about/ })?.title()) ?? "").toBe("About, edited live");
  const pub = await request.get("/en/about");
  expect(await pub.text()).not.toContain("About, edited live");
});
