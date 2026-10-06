import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConventions } from "../src/generate.js";
import { builtinConventions } from "../src/conventions/index.js";
import { scanPages } from "../src/scan.js";

const ui = { id: "preact", extensions: [".tsx"], server: "@cf-lite/preact/server" } as never;
function project(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cflite-isrc-"));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), c); }
  return root;
}
const PAGE = `export const render = "ssr"; export const isr = { maxAge: 60 }; export default () => null;`;

describe("export const isr", () => {
  it("wraps the GET handler, adds origin middleware, revalidate endpoint and the generated consumer", () => {
    const g = runConventions(project({ "app/routes/p/[id].tsx": PAGE }), ui, builtinConventions);
    const app = g.files["app.ts"];
    expect(app).toContain(`import { isrRoute } from "cf-lite/modules/isr";`);
    expect(app).toMatch(/\.get\("\/p\/:id", isrRoute\(s0 as never, ssr\(s0/);
    expect(app).toContain(".use(isrOrigin())");
    expect(app).toContain(`.post("/_isr/revalidate", isrRevalidate())`);
    const h = g.files["handlers.ts"];
    expect(h).toContain(`"isr": isrConsumer({ render: (req, e, x) => app.fetch(req, e, x) })`);
    expect(h).toContain(`import app from "./app";`);
  });
  it("stacks inside cacheRoute when the page also exports cache", () => {
    const g = runConventions(project({ "app/routes/p.tsx": PAGE + ` export const cache = { maxAge: 5 };` }), ui, builtinConventions);
    expect(g.files["app.ts"]).toMatch(/cacheRoute\(s0 as never, isrRoute\(s0 as never, ssr\(/);
  });
  it("keeps a hand-written server/queues/isr.ts instead of generating a consumer", () => {
    const g = runConventions(project({ "app/routes/p.tsx": PAGE, "server/queues/isr.ts": `export default async () => {};` }), ui, builtinConventions);
    expect(g.files["handlers.ts"]).not.toContain("isrConsumer");
    expect(g.files["handlers.ts"]).toContain("dispatchQueue");
  });
  it("merges with other queue files", () => {
    const g = runConventions(project({ "app/routes/p.tsx": PAGE, "server/queues/mail.ts": `export default async () => {};` }), ui, builtinConventions);
    expect(g.files["handlers.ts"]).toMatch(/"mail": q0, "isr": isrConsumer/);
  });
  it("emits nothing ISR-related without the export", () => {
    const g = runConventions(project({ "app/routes/p.tsx": `export const render = "ssr"; export default () => null;` }), ui, builtinConventions);
    expect(g.files["app.ts"]).not.toMatch(/isr/i);
    expect(g.files["handlers.ts"]).toBeUndefined();
  });
  it("only ssr pages may export isr", () => {
    const root = project({ "app/routes/p.tsx": `export const render = "static"; export const isr = { maxAge: 1 }; export default () => null;` });
    expect(() => scanPages(root, "app/routes", [".tsx"])).toThrow(/only applies to render="ssr"/);
  });
  it("wrangler checks flag a missing bucket, producer and consumer", () => {
    const g = runConventions(project({ "app/routes/p.tsx": PAGE }), ui, builtinConventions);
    const msgs = g.checks.flatMap((c) => c({}));
    expect(msgs.join("\n")).toMatch(/ISR_BUCKET/);
    expect(msgs.join("\n")).toMatch(/ISR_QUEUE/);
    expect(msgs.join("\n")).toMatch(/queues.consumers/);
    const ok = { r2_buckets: [{ binding: "ISR_BUCKET" }], queues: { producers: [{ binding: "ISR_QUEUE", queue: "isr" }], consumers: [{ queue: "isr" }] } };
    expect(g.checks.flatMap((c) => c(ok))).toEqual([]);
  });
});
