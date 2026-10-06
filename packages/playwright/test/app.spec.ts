import { resolve } from "node:path";
import { test, expect } from "../src/index.js";

const demo = resolve(import.meta.dirname, "../../../examples/demo");
test.use({ appOptions: { dir: demo } });

test("Worker-invocation assertions: static never hits the Worker, API + SSR do", async ({ page, request, app }) => {
  await page.goto("/about/");
  await app.expectWorkerPaths([]);
  app.resetHits();
  const r = await request.get("/api/hello?name=pw");
  expect((await r.json()).message).toBe("hello pw");
  await page.goto("/posts/7");
  await app.expectWorkerPaths(["/api/hello", "/posts/7"]);
});

test("a wrong expectation fails", async ({ request, app }) => {
  app.resetHits();
  await request.get("/api/hello");
  await expect(app.expectWorkerPaths([])).rejects.toThrow();
});
