/** vitest setup file (registered by `cfLiteTest()`): clean storage + re-apply migrations before each test. */
import { beforeEach } from "vitest";
import { env, reset } from "cloudflare:test";
import { applyMigrations } from "./index.js";

const e = env as unknown as Record<string, unknown>;
if (e.CF_LITE_TEST_ISOLATE !== "false") {
  beforeEach(async () => {
    await reset();
    await applyMigrations();
  });
}
