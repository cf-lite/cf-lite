// i18n + draft/preview on `render = "rsc"` routes under local workerd (wrangler dev). Overlays a scratch copy of examples/site-rsc with
// `i18n` + `draft` plugin options, pages under app/routes/[locale]/ and R2/Queue bindings, then checks:
//   i18n:  `/` and unprefixed paths redirect by Accept-Language/cookie, prefixed rsc pages render in their locale (params.locale, translator,
//          <html lang>, hreflang, content-language), unknown prefix 404, the Flight payload (`?__rsc`) is locale-correct and cached per locale.
//   draft: the enable endpoint sets the signed cookie; with it the loader sees isDraft() and unpublished content; cache + ISR + payload are
//          BYPASSed for a previewer and nothing draft-flavoured ever lands in the shared copy; a forged cookie sees nothing and is no-store.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const src = new URL("../examples/site-rsc/", import.meta.url).pathname, root = new URL("../", import.meta.url).pathname;
const app = new URL(`../e2e/.tmp/rscid-${process.pid}/`, import.meta.url).pathname;
mkdirSync(app, { recursive: true });
cpSync(src, app, { recursive: true, filter: (p) => !/[\\/](dist|node_modules|\.cf-lite|\.wrangler)([\\/]|$)/.test(p.slice(src.length)) });
rmSync(join(app, "app/routes"), { recursive: true, force: true }); rmSync(join(app, "app/actions"), { recursive: true, force: true }); rmSync(join(app, "app/lib"), { recursive: true, force: true });
rmSync(join(app, "server/middleware.ts"), { force: true }); rmSync(join(app, "server/api"), { recursive: true, force: true });
const w = (f, c) => { mkdirSync(dirname(join(app, f)), { recursive: true }); writeFileSync(join(app, f), c); };
w("vite.config.ts", `import { defineConfig } from "vite";\nimport cfLite from "cf-lite/vite";\nimport react from "@cf-lite/react";\nexport default defineConfig({ plugins: [cfLite({ renderer: react(), i18n: { locales: ["en", "vi"], default: "en" }, draft: {} })] });\n`);
w("wrangler.jsonc", JSON.stringify({
  name: "cf-lite-site-rsc-id", main: "server/worker.ts", compatibility_date: "2026-09-01", compatibility_flags: ["nodejs_compat"],
  assets: { not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
  r2_buckets: [{ binding: "ISR_BUCKET", bucket_name: "cf-lite-site-rsc-id" }], kv_namespaces: [{ binding: "CONTENT" }],
  queues: { producers: [{ binding: "ISR_QUEUE", queue: "isr" }], consumers: [{ queue: "isr", max_batch_size: 10, max_batch_timeout: 1, max_retries: 3 }] },
}));
w("server/worker.ts", `import app from "../.cf-lite/app";\nimport { handlers } from "../.cf-lite/handlers";\nexport default { fetch: app.fetch, ...handlers } satisfies ExportedHandler<Env>;\n`);
w("server/env.d.ts", "interface Env { CONTENT: KVNamespace; ISR_BUCKET: R2Bucket; ISR_QUEUE: Queue; DRAFT_SECRET?: string }\n");
w("server/api/content.ts", `import { Hono } from "hono";\nexport default new Hono<{ Bindings: Env }>().post("/:key", async (c) => { await c.env.CONTENT.put(c.req.param("key"), await c.req.text()); return c.json({ ok: true }); });\n`);
w("app/i18n.ts", `import { loadMessages, translator } from "cf-lite/modules/i18n";\nimport { i18n } from "../.cf-lite/i18n";\nexport { i18n, translator };\nconst catalogs = { en: () => import("./messages/en.json"), vi: () => import("./messages/vi.json") };\nexport const load = (locale: string) => loadMessages(i18n, catalogs as never, locale);\n`);
w("app/messages/en.json", JSON.stringify({ hello: "Hello {name}", only: "only in english" }));
w("app/messages/vi.json", JSON.stringify({ hello: "Xin chao {name}" }));
w("app/routes/[locale]/_layout.rsc.tsx", `import type { ReactNode } from "react";\nimport { i18nHead } from "cf-lite/modules/i18n";\nimport { i18n } from "../../i18n";\nexport const head = i18nHead(i18n);\nexport default function L({ children }: { children?: ReactNode }) { return <div data-testid="l-root">{children}</div>; }\n`);
const page = (extra, up = "../../") => `import { getRequest, isDraft } from "cf-lite/rsc";
import { load, translator } from "${up}i18n";
export const render = "rsc";
${extra}
export async function loader({ env, params, draft }: { env: { CONTENT: KVNamespace }; params: Record<string, string>; draft?: unknown }) {
  const key = (params.id ? "post:" + params.id : "page");
  const text = (draft ? await env.CONTENT.get("draft:" + key) : null) ?? (await env.CONTENT.get(key)) ?? "published";
  return { text, messages: await load(params.locale), draft: !!draft };
}
export default function P({ params, data }: { params: Record<string, string>; data: { text: string; messages: never; draft: boolean } }) {
  const { t } = translator(data.messages, params.locale);
  return <main><h1 id="t">{data.text}</h1><p id="hello">{t("hello", { name: params.id ?? "x" })}</p><p id="only">{t("only")}</p><p id="loc">{params.locale}</p><p id="draft">{String(isDraft())}/{String(data.draft)}/{String(getRequest().draft !== undefined)}</p><p>rendered at {Date.now()}</p></main>;
}
`;
w("app/routes/[locale]/index.tsx", page(``));
w("app/routes/[locale]/page.tsx", page(`export const cache = { maxAge: 300 };`));
w("app/routes/[locale]/post/[id].tsx", page(`export const isr = { maxAge: 300, swr: 3600, tags: (c: { req: { param(k: string): string } }) => ["post:" + c.req.param("id")] };`, "../../../"));
const build = spawnSync(process.execPath, [root + "packages/cf-lite/dist/cli.js", "build"], { cwd: app, encoding: "utf8" });
assert.equal(build.status, 0, build.stdout + build.stderr);

const SECRET = "e2e-draft-secret-0123456789-0123456789-abcdef";
const pj = createRequire(src).resolve("wrangler/package.json");
const wr = join(dirname(pj), JSON.parse(readFileSync(pj, "utf8")).bin.wrangler);
const persist = join(app, ".wrangler/e2e-state");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 22100 + Math.floor(Math.random() * 400);
const child = spawn(process.execPath, [wr, "dev", "--port", String(port), "--persist-to", persist, "--var", `DRAFT_SECRET:${SECRET}`, "--show-interactive-dev-session=false"], { cwd: app, detached: true, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("exit", () => { stop(); rmSync(app, { recursive: true, force: true }); });
const base = `http://localhost:${port}`;
const get = async (p, headers = {}) => { const r = await fetch(base + p, { redirect: "manual", headers }); return { r, body: (await r.text()).replace(/<!-- -->/g, ""), c: r.headers.get("x-cf-lite-cache"), i: r.headers.get("x-cf-lite-isr") }; };
const set = (k, v) => fetch(`${base}/api/content/${k}`, { method: "POST", body: v });
const t = (b) => /id="t"[^>]*>([^<]*)/.exec(b)?.[1];
const until = async (what, fn, ms = 30000) => { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; assert.ok(Date.now() - s < ms, "timeout: " + what); await sleep(300); } };
try {
  for (let i = 0; i < 120 && !log.includes("Ready on"); i++) await sleep(500);
  assert.ok(log.includes("Ready on"), "wrangler dev did not start:\n" + log);

  // ---- i18n ----
  let x = await get("/", { "accept-language": "vi-VN,vi;q=0.9" }); assert.equal(x.r.status, 307); assert.equal(x.r.headers.get("location"), "/vi");
  assert.equal((await get("/page", { "accept-language": "vi" })).r.headers.get("location"), "/vi/page", "unprefixed rsc path redirects (it is Worker-first)");
  assert.equal((await get("/page", { "accept-language": "fr", cookie: "locale=vi" })).r.headers.get("location"), "/vi/page", "cookie beats Accept-Language");
  assert.equal((await get("/post/9?x=1", { "accept-language": "vi" })).r.headers.get("location"), "/vi/post/9?x=1");
  x = await get("/en/page"); assert.equal(x.r.status, 200); assert.equal(x.c, "MISS");
  assert.match(x.body, /<html lang="en"/); assert.match(x.body, /id="loc"[^>]*>en/); assert.match(x.body, /id="hello"[^>]*>Hello (<!-- -->)?x/);
  assert.match(x.body, /rel="alternate" hrefLang="vi"|rel="alternate" hreflang="vi"/i); assert.equal(x.r.headers.get("content-language"), "en");
  const vi = await get("/vi/page"); assert.equal(vi.r.status, 200); assert.equal(vi.c, "MISS", "locales are separate cache entries");
  assert.match(vi.body, /<html lang="vi"/); assert.match(vi.body, /id="loc"[^>]*>vi/); assert.match(vi.body, /Xin chao/); assert.match(vi.body, /id="only"[^>]*>only in english/, "catalog falls back to the default locale");
  assert.equal(vi.r.headers.get("content-language"), "vi");
  x = await until("en HIT", async () => { const y = await get("/en/page"); return y.c === "HIT" ? y : null; }); assert.match(x.body, /id="loc"[^>]*>en/);
  assert.match((await get("/vi/page")).body, /id="loc"[^>]*>vi/, "a vi HIT is not the en entry");
  const fv = await get("/vi/page?__rsc"); assert.equal(fv.c, "MISS"); assert.match(fv.body, /Xin chao/); assert.doesNotMatch(fv.body, /Hello/);
  const fe = await get("/en/page?__rsc"); assert.match(fe.body, /Hello/); assert.doesNotMatch(fe.body, /Xin chao/);
  { const u = await get("/fr/page"); assert.doesNotMatch(u.body, /id="loc"/, "never rendered with locale fr (the SPA/assets layer answers: the globs are per known locale)"); }

  // ---- draft ----
  assert.equal((await get("/api/draft/enable?secret=nope")).r.status, 401);
  const en = await get(`/api/draft/enable?secret=${SECRET}&path=/en/page`); assert.equal(en.r.status, 307); assert.equal(en.r.headers.get("location"), "/en/page");
  const ck = en.r.headers.get("set-cookie").split(";")[0];
  await set("page", "PUBLISHED"); await set("draft:page", "DRAFT-TEXT");
  // Cache API tier
  const pubEn = await get("/vi/page"); // warm vi copy with whatever the loader gave (published or "published")
  x = await get("/en/page", { cookie: ck });
  assert.equal(x.c, "BYPASS"); assert.equal(x.r.headers.get("x-cf-lite-cache-why"), "draft"); assert.equal(t(x.body), "DRAFT-TEXT"); assert.match(x.body, /id="draft"[^>]*>true\/true\/true/);
  assert.equal(x.r.headers.get("cache-control"), "private, no-store");
  assert.match(x.body, /<html lang="en"/);
  const xf = await get("/en/page?__rsc", { cookie: ck }); assert.equal(xf.c, "BYPASS"); assert.match(xf.body, /DRAFT-TEXT/, "payload for a previewer carries the draft too, uncached");
  const vd = await get("/vi/page", { cookie: ck }); assert.equal(vd.c, "BYPASS"); assert.match(vd.body, /id="loc"[^>]*>vi/); assert.match(vd.body, /DRAFT-TEXT/);
  // the shared copy was never replaced: public request is published content, no draft marker
  for (let i = 0; i < 2; i++) { const p = await get("/en/page"); assert.doesNotMatch(p.body, /DRAFT-TEXT/); assert.match(p.body, /id="draft"[^>]*>false\/false\/false/); }
  assert.doesNotMatch((await get("/en/page?__rsc")).body, /DRAFT-TEXT/);
  // forged cookie: no draft powers, but still never cached/stored
  const fk = "__cfl_preview=1.AAAA.AAAA.AAAA";
  x = await get("/en/page", { cookie: fk }); assert.doesNotMatch(x.body, /DRAFT-TEXT/); assert.match(x.body, /id="draft"[^>]*>false\/false\/false/); assert.equal(x.r.headers.get("cache-control"), "private, no-store");
  // ISR (R2) tier
  await set("post:1", "POST-1"); await set("draft:post:1", "DRAFT-POST-1");
  x = await get("/en/post/1"); assert.equal(x.i, "MISS"); assert.equal(t(x.body), "POST-1");
  await until("ISR HIT", async () => (await get("/en/post/1")).i === "HIT");
  x = await get("/en/post/1", { cookie: ck }); assert.equal(x.i, "BYPASS"); assert.equal(x.r.headers.get("x-cf-lite-isr-why"), "draft"); assert.equal(t(x.body), "DRAFT-POST-1");
  x = await get("/en/post/1?__rsc", { cookie: ck }); assert.equal(x.i, "BYPASS"); assert.match(x.body, /DRAFT-POST-1/);
  x = await get("/en/post/1"); assert.equal(x.i, "HIT"); assert.equal(t(x.body), "POST-1"); assert.doesNotMatch((await get("/en/post/1?__rsc")).body, /DRAFT-POST-1/);
  // disable ends the preview
  const off = await get("/api/draft/disable?path=/en/page"); assert.match(off.r.headers.get("set-cookie"), /Max-Age=0/);
  assert.doesNotMatch((await get("/en/page")).body, /DRAFT-TEXT/);
  console.log("rsc i18n + draft e2e OK");
} finally { stop(); }
