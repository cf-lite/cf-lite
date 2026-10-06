import { checkA11y } from "../packages/playwright/src/index";
import { expect, test } from "@playwright/test";

// Axe gate on the docs site `site/` (WCAG 2.0-2.2 A/AA, fails on serious+), every page reachable from the home page + sidebar, light and dark.
for (const scheme of ["light", "dark"] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme });
    test("every docs page is axe clean", async ({ page }) => {
      await page.goto("/");
      const links = await page.locator("a[href^='/']").evaluateAll((a) => [...new Set(a.map((x) => (x as HTMLAnchorElement).pathname))]);
      const paths = [...new Set(["/", "/search/", ...links])].filter((p) => !/\.\w+$/.test(p));
      expect(paths.length).toBeGreaterThan(5);
      for (const p of paths) { await page.goto(p); await page.waitForLoadState("networkidle"); await checkA11y(page); }
    });
  });
}
