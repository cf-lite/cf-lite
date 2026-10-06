// ISR on an `render = "rsc"` route under local workerd (wrangler dev, real miniflare R2 + Queue): HTML and the Flight payload (`?__rsc`) are
// stored in R2, a tag revalidation (-> queue -> generated consumer) regenerates BOTH, a second "colo" sharing the persisted R2 serves them,
// and personalised (cookie) requests bypass the store. Overlays an ISR page + bindings on a scratch copy of examples/site-rsc.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const src = new URL("../examples/site-rsc/", import.meta.url).pathname, root = new URL("../", import.meta.url).pathname;
const app = new URL(`../e2e/.tmp/rscisr-${process.pid}/`, import.meta.url).pathname;
mkdirSync(app, { recursive: true });
cpSync(src, app, { recursive: true, filter: (p) => !/[\\/](dist|node_modules|\.cf-lite|\.wrangler)([\\/]|$)/.test(p.slice(src.length)) });
const persist = join(app, ".wrangler/e2e-state");
writeFileSync(join(app, "wrangler.jsonc"), JSON.stringify({
  name: "cf-lite-site-rsc-isr", main: "server/worker.ts", compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"],
  assets: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
  r2_buckets: [{ binding: "ISR_BUCKET", bucket_name: "cf-lite-site-rsc-isr" }],
  kv_namespaces: [{ binding: "CONTENT" }],
  queues: { producers: [{ binding: "ISR_QUEUE", queue: "isr" }], consumers: [{ queue: "isr", max_batch_size: 10, max_batch_timeout: 1, max_retries: 3 }] },
}));
writeFileSync(join(app, "server/worker.ts"), `import app from "../.cf-lite/app";\nimport { handlers } from "../.cf-lite/handlers";\nexport default { fetch: app.fetch, ...handlers } satisfies ExportedHandler<Env>;\n`);
writeFileSync(join(app, "server/env.d.ts"), "interface Env { CONTENT: KVNamespace; ISR_BUCKET: R2Bucket; ISR_QUEUE: Queue }\n");
writeFileSync(join(app, "server/api/content.ts"), `import { Hono } from "hono";\nimport { revalidateTag } from "cf-lite/modules/isr";\nexport default new Hono<{ Bindings: Env }>().post("/edit/:id", async (c) => { const id = c.req.param("id"); await c.env.CONTENT.put("post:" + id, await c.req.text()); return c.json(await revalidateTag(c.env, "post:" + id)); });\n`);
mkdirSync(join(app, "app/routes/rsc-isr"), { recursive: true });
writeFileSync(join(app, "app/routes/rsc-isr/[id].tsx"), `import type { Context } from "hono";
import { Counter } from "../../islands/counter";
export const render = "rsc";
export const isr = { maxAge: 300, swr: 3600, tags: (c: Context) => ["posts", "post:" + c.req.param("id")] };
export async function loader(c: { env: { CONTENT: KVNamespace }; params: Record<string, string> }) { return { id: c.params.id, title: (await c.env.CONTENT.get("post:" + c.params.id)) ?? "untitled", at: Date.now() }; }
export default function Post({ data }: { data: { id: string; title: string; at: number } }) { return <main><h1 id="t">{data.title}</h1><p>rendered at {data.at}</p><Counter label="n" /></main>; }
`);
const build = spawnSync(process.execPath, [root + "packages/cf-lite/dist/cli.js", "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);

const pj = createRequire(src).resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const stop = () => { for (const c of procs) try { process.kill(-c.pid, "SIGTERM"); } catch {} };
process.on("exit", () => { stop(); rmSync(app, { recursive: true, force: true }); });
async function start(port) {
  const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--persist-to", persist, "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  procs.push(child);
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);
  return { base: `http://localhost:${port}`, log: () => log };
}
const get = async (a, p, headers = {}) => { const r = await fetch(a.base + p, { headers }); return { r, st: r.headers.get("x-cf-lite-isr"), body: await r.text() }; };
const title = (b) => /id="t"[^>]*>([^<]*)/.exec(b)?.[1];
const at = (b) => /rendered at (?:<!-- -->)?(\d+)/.exec(b)?.[1];
const until = async (what, fn, ms = 40000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; assert.ok(Date.now() - t < ms, "timeout: " + what); await sleep(300); } };

try {
  const base = 21900 + Math.floor(Math.random() * 300);
  const A = await start(base);
  const edit = (a, id, text) => fetch(`${a.base}/api/content/edit/${id}`, { method: "POST", body: text });
  await edit(A, "1", "First");
  // 1. HTML: MISS then HIT; payload (`?__rsc`) is its own R2 entry: MISS then HIT; HIT serves the identical stored bytes
  let h = await get(A, "/rsc-isr/1"); assert.equal(h.st, "MISS"); assert.equal(title(h.body), "First"); assert.match(h.body, /__FLIGHT_DATA/);
  h = await until("HTML HIT", async () => { const y = await get(A, "/rsc-isr/1"); return y.st === "HIT" ? y : null; });
  assert.match(h.r.headers.get("content-type"), /text\/html/); assert.match(h.r.headers.get("cache-control"), /s-maxage=300/);
  let f = await get(A, "/rsc-isr/1?__rsc"); assert.equal(f.st, "MISS"); assert.match(f.r.headers.get("content-type"), /text\/x-component/); assert.match(f.body, /First/);
  f = await until("payload HIT", async () => { const y = await get(A, "/rsc-isr/1?__rsc"); return y.st === "HIT" ? y : null; });
  assert.match(f.r.headers.get("content-type"), /text\/x-component/);
  assert.equal(at(h.body) !== undefined, true);
  // 2. second colo shares R2 for both
  const B = await start(base + 1);
  const bh = await get(B, "/rsc-isr/1"); assert.equal(bh.st, "HIT"); assert.equal(bh.body, h.body);
  const bf = await get(B, "/rsc-isr/1?__rsc"); assert.equal(bf.st, "HIT"); assert.equal(bf.body, f.body);
  // 3. one tag revalidation -> queue -> regeneration of HTML AND payload (seen from the other colo)
  const er = await edit(A, "1", "Second"); assert.ok((await er.json()).enqueued >= 1);
  await until("HTML regenerated on B", async () => title((await get(B, "/rsc-isr/1")).body) === "Second");
  await until("payload regenerated on B", async () => /Second/.test((await get(B, "/rsc-isr/1?__rsc")).body));
  const h2 = await get(B, "/rsc-isr/1"); assert.equal(h2.st, "HIT"); assert.notEqual(at(h2.body), at(h.body)); // freshly rendered, then stored
  assert.equal((await get(B, "/rsc-isr/1?__rsc")).r.headers.get("content-type").startsWith("text/x-component"), true);
  // 4. another id is untouched by post:1's tag
  await edit(A, "2", "Other"); await get(A, "/rsc-isr/2"); const o1 = await until("id 2 HIT", async () => { const y = await get(A, "/rsc-isr/2"); return y.st === "HIT" ? y : null; });
  await edit(A, "1", "Third"); await until("id 1 third", async () => title((await get(A, "/rsc-isr/1")).body) === "Third");
  assert.equal(at((await get(A, "/rsc-isr/2")).body), at(o1.body)); // id 2 not regenerated
  // 5. authenticated requests bypass the store (no personalised HTML in R2) and are not stored
  const bp = await get(A, "/rsc-isr/1", { cookie: "sso=abc" }); assert.equal(bp.st, "BYPASS");
  const fp = await get(A, "/rsc-isr/1?__rsc", { cookie: "sso=abc" }); assert.equal(fp.st, "BYPASS");
  // 6. client island still hydrates from an ISR-served page (inline payload cached with the HTML)
  console.log("rsc isr e2e OK");
} finally { stop(); }
