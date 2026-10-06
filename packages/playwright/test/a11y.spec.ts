import { test, expect, checkA11y } from "../src/index.js";

// No app needed: these only use `page` (the `app` fixture is lazy) - but `baseURL` depends on it, so override.
test.use({ baseURL: undefined });

test("a11y fixture passes on a clean page", async ({ page, a11y }) => {
  await page.setContent(`<html lang="en"><head><title>ok</title></head><body><main><h1>Hi</h1><img src="data:," alt="logo"><button>Go</button></main></body></html>`);
  await a11y();
});

test("a11y fixture FAILS on a seeded violation (missing alt + unlabeled button + low contrast)", async ({ page, a11y }) => {
  await page.setContent(`<html lang="en"><head><title>bad</title></head><body><main><h1>Hi</h1>
    <img src="data:,"><button></button><p style="color:#bbb;background:#fff">low contrast text</p></main></body></html>`);
  await expect(a11y()).rejects.toThrow(/image-alt|button-name|color-contrast/);
});

test("failOn / disableRules scope the check", async ({ page }) => {
  await page.setContent(`<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1><img src="data:,"></main></body></html>`);
  await expect(checkA11y(page)).rejects.toThrow(/image-alt/);
  await checkA11y(page, { disableRules: ["image-alt"] });
  const all = await checkA11y(page, { failOn: "critical", disableRules: [] }).catch((e) => e);
  expect(String(all)).toMatch(/image-alt/); // image-alt is critical
});
