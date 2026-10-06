import { expect, test } from "@playwright/test";

// Server actions against examples/site-forms. `/contact` is a plain (non-hydrated) page: everything there must work with JavaScript OFF.
// `/enhanced` is hydrated and uses `<Form>` from @cf-lite/react/form (fetch + pending state + client redirects).

test.describe("no JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("validation errors re-render the page with 422 and keep typed values", async ({ page }) => {
    await page.goto("/contact");
    await page.fill("input[name=name]", "Bob");
    await page.fill("input[name=email]", "not-an-email");
    await page.fill("textarea", "hi");
    const [res] = await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), page.getByRole("button", { name: "Send" }).click()]);
    expect(res.status()).toBe(422);
    await expect(page.getByTestId("err-email")).toHaveText("Enter a valid email");
    await expect(page.getByTestId("err-message")).toBeVisible();
    await expect(page.locator("input[name=name]")).toHaveValue("Bob");
    expect(page.url()).toContain("?/send");
  });

  test("valid submit re-renders with actionData; redirect action lands on /thanks via 303", async ({ page }) => {
    await page.goto("/contact");
    await page.fill("input[name=name]", "Eve");
    await page.fill("input[name=email]", "eve@example.com");
    await page.fill("textarea", "hello world");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("ok")).toHaveText("Thanks Eve");
    await page.getByRole("button", { name: "Go" }).click(); // formaction="?/go" -> throw redirect("/thanks")
    await expect(page.getByTestId("thanks")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/thanks");
  });

  test("PRG: an action that returns nothing 303s back to the page, reload does not re-submit", async ({ page }) => {
    await page.goto("/contact");
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByTestId("count")).toContainText("messages:");
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe("/contact");
  });

  test("file upload to R2 through a no-JS multipart form", async ({ page }) => {
    await page.goto("/contact");
    await page.setInputFiles("input[type=file]", { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("hello r2") });
    await page.getByRole("button", { name: "Upload" }).click();
    await expect(page.getByTestId("uploaded")).toContainText("8");
  });
});

test.describe("JavaScript enhanced", () => {
  test("pending state, double-submit guard and inline result without a document navigation", async ({ page }) => {
    const posts: string[] = [];
    page.on("request", (r) => r.method() === "POST" && posts.push(r.url()));
    await page.goto("/enhanced");
    await page.evaluate(() => ((window as any).__m = 1));
    await page.fill("input[name=name]", "Zed");
    await page.fill("input[name=email]", "zed@example.com");
    await page.fill("input[name=message]", "hello there");
    const btn = page.getByTestId("submit");
    await btn.click();
    await expect(btn).toHaveText("Sending…");
    await expect(btn).toBeDisabled();
    await page.locator("form").evaluate((f: HTMLFormElement) => f.requestSubmit()); // second submit while pending is ignored
    await expect(page.getByTestId("js-ok")).toHaveText("Thanks Zed");
    expect(posts.length).toBe(1);
    expect(await page.evaluate(() => (window as any).__m)).toBe(1); // same document: fetch, not navigation
    await expect(btn).toHaveText("Send");
  });

  test("failure shows field errors from the JSON result; redirect is followed", async ({ page }) => {
    await page.goto("/enhanced");
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("js-errors")).toContainText("Name is required");
    await page.getByTestId("go").click();
    await expect(page).toHaveURL(/\/thanks$/);
  });

  test("a cross-site forged POST from the page context is refused", async ({ page, baseURL }) => {
    await page.goto("/enhanced");
    const status = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/enhanced?/send`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=x", referrer: "" });
      return r.status;
    }, baseURL);
    expect(status).toBe(422); // same-origin fetch reaches validation...
    const res = await page.request.post(`${baseURL}/enhanced?/send`, { form: { name: "x" }, headers: { origin: "https://evil.example" } });
    expect(res.status()).toBe(403); // ...a foreign Origin does not
  });
});
