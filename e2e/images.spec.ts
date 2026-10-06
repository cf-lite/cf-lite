import { expect, test } from "@playwright/test";

// WP-IMAGES: no layout shift. Dimensions are in the markup, so the box is reserved before any byte of the image arrives.

test("space is reserved before the image loads (images blocked) and nothing shifts when they do", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
  });
  await page.setViewportSize({ width: 800, height: 600 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/_img**", async (route) => { await gate; await route.continue(); });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const hero = page.getByTestId("hero");
  const before = await hero.boundingBox();
  expect(before!.height).toBeCloseTo(before!.width / 2, 0); // 2:1 from the width/height attrs, image not loaded yet
  release();
  await expect.poll(() => hero.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  const after = await hero.boundingBox();
  expect(after).toEqual(before);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__cls)).toBe(0);
});

test("responsive srcset picks a whitelisted width; below-the-fold image is lazy", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 600 });
  await page.goto("/");
  const cur = await page.getByTestId("hero").evaluate((i: HTMLImageElement) => i.currentSrc);
  // Desktop Safari emulates DPR 2: a 400px viewport then wants 800w, so the whitelisted pick depends on the device pixel ratio
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  expect(cur).toMatch(dpr >= 2 ? /\/_img\?src=%2Fimg%2Fhero\.png&w=(640|800)&q=75/ : /\/_img\?src=%2Fimg%2Fhero\.png&w=(320|640)&q=75/);
  expect(await page.getByTestId("lazy").getAttribute("loading")).toBe("lazy");
  expect(await page.getByTestId("hero").getAttribute("fetchpriority")).toBe("high");
});
