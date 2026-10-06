import { expect, test } from "@playwright/test";

// examples/site-security runs the strict CSP (no 'unsafe-inline' for scripts): static pages carry a hash policy from `_headers`,
// the SSR page a per-request nonce. Hydration and interaction must still work and the console must contain no CSP violation.

for (const path of ["/", "/about", "/ssr"]) {
  test(`no CSP violations on ${path}`, async ({ page }) => {
    const bad: string[] = [];
    page.on("console", (m) => { if (/content security policy|refused to (execute|apply|load)/i.test(m.text())) bad.push(m.text()); });
    page.on("pageerror", (e) => bad.push(String(e)));
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error("CSP violation: " + e.violatedDirective + " " + e.blockedURI)));
    const res = await page.goto(path);
    expect(res!.headers()["content-security-policy"]).toContain("script-src");
    if (path !== "/about") {
      await page.getByTestId("inc").click();
      await expect(page.getByTestId("inc")).toHaveText("count 1"); // hydrated under the policy
    }
    await page.waitForTimeout(300);
    expect(bad).toEqual([]);
  });
}

test("inline style attribute still applies (style-src-attr)", async ({ page }) => {
  await page.goto("/about");
  await expect(page.locator("p")).toHaveCSS("color", "rgb(102, 51, 153)");
});

test("an injected inline script is blocked", async ({ page }) => {
  const violations: string[] = [];
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => ((window as any).__v ??= []).push(e.violatedDirective)));
  await page.goto("/ssr");
  await page.evaluate(() => { const s = document.createElement("script"); s.textContent = "window.__pwned = 1"; document.body.append(s); });
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  violations.push(...((await page.evaluate(() => (window as any).__v)) ?? []));
  expect(violations.join()).toContain("script-src");
});
