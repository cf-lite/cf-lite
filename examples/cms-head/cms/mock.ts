/**
 * Mock headless CMS: a Hono app speaking the GraphQL subset of cms/graphql.ts. Content types page / article / block, published vs draft
 * versions, locales en / vi. `publish` / `unpublish` fire a signed webhook through the injected `deliver`.
 * Mount it in the head's own Worker (default, zero setup) or run it as its own tiny Worker: it only needs `deliver` + a Store.
 *
 *   query Route($path: String!, $locale: Locale!, $preview: Boolean) { route(path: $path, locale: $locale, preview: $preview) { ...
 *   mutation($id: String!, $fields: JSON) { saveDraft(id: $id, fields: $fields) { id version } }      (Bearer CMS_TOKEN)
 *   mutation($id: String!) { publish(id: $id) { id version } }                                          (fires the webhook)
 */
import { Hono } from "hono";
import { GqlError, execute, parse, type Json, type Resolver } from "./graphql";
import { signWebhook } from "cf-lite/modules/webhook";
import { safeEqual } from "./seams";
import { EDITOR_HTML } from "./editor";
import { seed } from "./seed";
import { isLocale, type Block, type Db, type Entry, type Fields, type Locale, type Version, type WebhookEvent } from "./types";

export interface Store { load(): Promise<Db>; save(db: Db): Promise<void> }
export const memoryStore = (): Store => { let db: Db | undefined; return { load: async () => (db ??= seed()), save: async (d) => { db = d; } }; };
export const kvStore = (kv: KVNamespace, key = "cms:db"): Store => ({
  load: async () => (await kv.get<Db>(key, "json")) ?? seed(),
  save: (db) => kv.put(key, JSON.stringify(db)),
});

export interface MockOptions { store: (env: Env) => Store; deliver: (req: Request, env: Env) => Promise<Response>; now?: () => Date;
  /** URL (relative to the head) that enables preview for an entry and lands on it; the editor iframes it. Omit = no preview button. */
  previewUrl?: (env: Env, e: Entry) => string | null }

const view = (e: Entry, preview: boolean): Version | null => (preview ? e.draft ?? e.published : e.published);

function resolveBlocks(db: Db, blocks: Block[] | undefined, preview: boolean): Json[] {
  const out: Json[] = [];
  for (const b of blocks ?? []) {
    if (b.__typename === "BlockRef") {
      const target = db.entries.find((e) => e.id === b.ref && e.type === "block");
      const inner = target && view(target, preview)?.fields.block;
      if (inner) out.push(...resolveBlocks(db, [inner], preview));
    } else if (b.__typename === "Columns") out.push({ ...b, left: resolveBlocks(db, b.left, preview), right: resolveBlocks(db, b.right, preview) } as unknown as Json);
    else out.push(b as unknown as Json);
  }
  return out;
}

export function createMockCms(opts: MockOptions) {
  const now = opts.now ?? (() => new Date());
  const app = new Hono<{ Bindings: Env }>();
  const authed = (c: { req: { header(n: string): string | undefined }; env: Env }) => {
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    return !!m && !!c.env.CMS_TOKEN && safeEqual(m[1], c.env.CMS_TOKEN);
  };

  async function fire(env: Env, db: Db, e: Entry, event: WebhookEvent["event"], version: number) {
    const ev: WebhookEvent = { id: `dl-${++db.seq}-${e.id}-${version}`, event, entryId: e.id, type: e.type, locale: e.locale, path: e.path ?? null, version, at: now().toISOString() };
    // wire format = cf-lite/modules/webhook's generic payload: { id, events: [{ action, type, id, locale, paths }] }
    const body = JSON.stringify({ id: ev.id, events: [{ action: event === "entry.publish" ? "publish" : "unpublish", type: e.type, id: e.id, locale: e.locale, ...(e.path ? { paths: [`/${e.locale}${e.path === "/" ? "" : e.path}`] } : {}), version }] });
    let status: number | "error" = "error";
    try {
      const res = await opts.deliver(new Request("http://cms.mock/webhook", { method: "POST", body, headers: { "content-type": "application/json", ...(await signWebhook(body, env.CMS_WEBHOOK_SECRET, now().getTime(), ev.id)) } }), env);
      status = res.status;
    } catch { /* a failing receiver never fails the publish; the delivery log shows it */ }
    db.deliveries.push({ id: ev.id, entryId: e.id, status, at: ev.at });
    db.deliveries.splice(0, Math.max(0, db.deliveries.length - 50));
    return ev;
  }

  app.post("/graphql", async (c) => {
    let payload: { query?: string; variables?: Record<string, Json> };
    try { payload = await c.req.json(); } catch { return c.json({ errors: [{ message: "invalid JSON body" }] }, 400); }
    let doc;
    try { doc = parse(String(payload.query ?? "")); } catch (e) { return c.json({ errors: [{ message: (e as Error).message }] }, 400); }
    const store = opts.store(c.env), db = await store.load(), variables = payload.variables ?? {};
    const needAuth = (args: Record<string, Json>) => { if (!authed(c)) throw new GqlError("unauthorized"); void args; };
    const loc = (a: Json): Locale => { if (typeof a !== "string" || !isLocale(a)) throw new GqlError(`unknown locale ${JSON.stringify(a)}`); return a; };
    const find = (id: Json) => { const e = db.entries.find((x) => x.id === id); if (!e) throw new GqlError(`no entry ${JSON.stringify(id)}`); return e; };
    let mutated = false;
    const summary = (e: Entry, v: Version) => ({ id: e.id, type: e.type, locale: e.locale, path: e.path ?? null, version: v.n });

    const query: Record<string, Resolver> = {
      route(args) {
        const preview = args.preview === true;
        if (preview) needAuth(args);
        const l = loc(args.locale);
        const e = db.entries.find((x) => x.type !== "block" && x.locale === l && x.path === args.path);
        const v = e && view(e, preview);
        if (!e || !v) return null;
        const common = { id: e.id, path: e.path!, locale: e.locale, version: v.n, title: v.fields.title, blocks: resolveBlocks(db, v.fields.blocks, preview) };
        return (e.type === "page" ? { __typename: "Page", ...common } : { __typename: "Article", ...common, excerpt: v.fields.excerpt ?? "", body: v.fields.body ?? "" }) as unknown as Json;
      },
      articles(args) {
        const preview = args.preview === true;
        if (preview) needAuth(args);
        const l = loc(args.locale), limit = typeof args.limit === "number" ? args.limit : 50;
        return db.entries
          .filter((e) => e.type === "article" && e.locale === l && view(e, preview))
          .sort((a, b) => a.path!.localeCompare(b.path!))
          .slice(0, limit)
          .map((e) => ({ id: e.id, path: e.path!, title: view(e, preview)!.fields.title, excerpt: view(e, preview)!.fields.excerpt ?? "" })) as Json;
      },
    };
    const mutation: Record<string, Resolver> = {
      saveDraft(args) {
        needAuth(args);
        const e = find(args.id), base: Fields = (e.draft ?? e.published)?.fields ?? { title: "" };
        const patch = (args.fields ?? {}) as Partial<Fields>;
        e.draft = { n: (e.published?.n ?? 0) + 1, at: now().toISOString(), fields: { ...base, ...patch } };
        mutated = true;
        return summary(e, e.draft);
      },
      async publish(args) {
        needAuth(args);
        const e = find(args.id);
        if (!e.draft) throw new GqlError("nothing to publish (no draft)");
        e.published = e.draft; e.draft = null; mutated = true;
        await fire(c.env, db, e, "entry.publish", e.published.n);
        return summary(e, e.published);
      },
      async unpublish(args) {
        needAuth(args);
        const e = find(args.id);
        if (!e.published) throw new GqlError("not published");
        const n = e.published.n;
        e.draft ??= e.published; e.published = null; mutated = true;
        await fire(c.env, db, e, "entry.unpublish", n);
        return summary(e, e.draft);
      },
    };
    const result = await execute(doc, doc.kind === "mutation" ? mutation : query, variables);
    if (mutated) await store.save(db);
    return c.json(result);
  });

  // Editor: static page + entry list + "preview button" URL (Bearer CMS_TOKEN). The page itself holds no secret.
  app.get("/editor", (c) => c.html(EDITOR_HTML, 200, { "cache-control": "no-store" }));
  app.get("/admin/entries", async (c) => !authed(c) ? c.json({ error: "unauthorized" }, 401) : c.json((await opts.store(c.env).load()).entries.map((e) => ({ id: e.id, type: e.type, locale: e.locale, path: e.path ?? null, title: (e.draft ?? e.published)?.fields.title ?? "", published: e.published?.n ?? null, draft: e.draft?.n ?? null }))));
  app.get("/admin/preview-url", async (c) => {
    if (!authed(c)) return c.json({ error: "unauthorized" }, 401);
    const e = (await opts.store(c.env).load()).entries.find((x) => x.id === c.req.query("id"));
    const url = e && opts.previewUrl?.(c.env, e);
    return url ? c.json({ url }) : c.json({ error: "no preview" }, 404);
  });

  // Debug/inspection for tests and the README walkthrough (Bearer CMS_TOKEN).
  app.get("/admin/deliveries", async (c) => (authed(c) ? c.json((await opts.store(c.env).load()).deliveries) : c.json({ error: "unauthorized" }, 401)));
  app.post("/admin/reset", async (c) => { if (!authed(c)) return c.json({ error: "unauthorized" }, 401); await opts.store(c.env).save(seed()); return c.json({ ok: true }); });
  return app;
}
