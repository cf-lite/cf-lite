import { beforeEach, describe, expect, it } from "vitest";
import { createCmsClient } from "../cms/client";
import { createMockCms, memoryStore } from "../cms/mock";
import { DEFAULT_VERIFY, contentTags, eventTags, trackContent, verifyWebhook } from "cf-lite/modules/webhook";
import { splitRoute } from "../cms/types";

const env = { CMS_TOKEN: "tok-tok-tok", CMS_WEBHOOK_SECRET: "s".repeat(32) } as unknown as Env;
let hooks: { req: Request; body: string }[], status: number, store: ReturnType<typeof memoryStore>, cms: ReturnType<typeof createMockCms>, client: ReturnType<typeof createCmsClient>, admin: ReturnType<typeof createCmsClient>;
const f = (token?: string) => createCmsClient((req) => Promise.resolve(cms.fetch(new Request(new URL("/graphql", req.url), req), env)), token);
const mutate = async (query: string, variables: object, token: string | null = env.CMS_TOKEN) =>
  (await cms.request("/graphql", { method: "POST", body: JSON.stringify({ query, variables }), headers: token ? { authorization: `Bearer ${token}` } : {} }, env)).json() as Promise<{ data: Record<string, unknown>; errors?: { message: string }[] }>;

beforeEach(() => {
  hooks = []; status = 200; store = memoryStore();
  cms = createMockCms({ store: () => store, deliver: async (req) => { hooks.push({ req, body: await req.clone().text() }); return new Response(null, { status }); }, now: () => new Date("2026-10-01T10:00:00Z") });
  client = f(); admin = f(env.CMS_TOKEN);
});

describe("mock CMS reads", () => {
  it("routes by path + locale and resolves BlockRef into the shared block", async () => {
    const home = await client.route("/", "en");
    expect(home?.__typename).toBe("Page");
    expect(home?.blocks[0]).toEqual({ __typename: "Banner", text: "Welcome to the cf-lite CMS demo" });
    expect((await client.route("/", "vi"))?.blocks[0]).toMatchObject({ __typename: "Banner", text: expect.stringContaining("Chào") });
    const art = await client.route("/blog/first", "en");
    expect(art).toMatchObject({ __typename: "Article", title: "First post", body: expect.stringContaining("Hello") });
  });
  it("returns null for unknown routes; shared block entries are not routable", async () => {
    expect(await client.route("/nope", "en")).toBeNull();
    expect(await client.route("/", "vi")).not.toBeNull();
  });
  it("rejects unknown locales, bad JSON, bad queries", async () => {
    await expect(client.route("/", "fr" as never)).rejects.toThrow(/unknown locale/);
    expect((await cms.request("/graphql", { method: "POST", body: "{" }, env)).status).toBe(400);
    expect((await cms.request("/graphql", { method: "POST", body: JSON.stringify({ query: "{ a " }) }, env)).status).toBe(400);
  });
  it("lists articles sorted and limited, per locale", async () => {
    expect((await client.articles("en")).map((a) => a.title)).toEqual(["First post", "Second post"]);
    expect(await client.articles("vi", 1)).toHaveLength(1);
  });
});

describe("published vs draft", () => {
  it("drafts are invisible without a token and unpublished until publish", async () => {
    await mutate("mutation($id: String!, $fields: JSON) { saveDraft(id: $id, fields: $fields) { id version } }", { id: "page-about-en", fields: { title: "v2" } });
    expect((await client.route("/about", "en"))?.title).toBe("About");
    await expect(client.route("/about", "en", true)).rejects.toThrow(/unauthorized/);
    expect((await admin.route("/about", "en", true))?.title).toBe("v2");
    expect(hooks).toHaveLength(0);
    const r = await mutate("mutation($id: String!) { publish(id: $id) { id version } }", { id: "page-about-en" });
    expect(r.data.publish).toEqual({ id: "page-about-en", version: 2 });
    expect((await client.route("/about", "en"))?.title).toBe("v2");
  });
  it("mutations need the token; publish needs a draft; unknown ids error", async () => {
    expect((await mutate("mutation { publish(id: \"page-about-en\") { id } }", {}, null)).errors?.[0].message).toBe("unauthorized");
    expect((await mutate("mutation { publish(id: \"page-about-en\") { id } }", {})).errors?.[0].message).toMatch(/no draft/);
    expect((await mutate("mutation { publish(id: \"zzz\") { id } }", {})).errors?.[0].message).toMatch(/no entry/);
  });
  it("draft-only entries appear in preview article lists, not in the live list", async () => {
    await mutate("mutation($id: String!) { unpublish(id: $id) { id } }", { id: "article-2-en" });
    expect((await client.articles("en")).map((a) => a.id)).toEqual(["article-1-en"]);
    expect((await admin.articles("en", 5, true)).map((a) => a.id)).toEqual(["article-1-en", "article-2-en"]);
    expect(await client.route("/blog/second", "en")).toBeNull();
    expect((await admin.route("/blog/second", "en", true))?.title).toBe("Second post");
  });
});

describe("publish webhook", () => {
  it("fires once per publish/unpublish with a verifiable signature and logs the delivery", async () => {
    await mutate("mutation($id: String!, $fields: JSON) { saveDraft(id: $id, fields: $fields) { id } }", { id: "article-1-vi", fields: { title: "mới" } });
    await mutate("mutation($id: String!) { publish(id: $id) { id } }", { id: "article-1-vi" });
    expect(hooks).toHaveLength(1);
    const body = JSON.parse(hooks[0].body) as { id: string; events: Record<string, unknown>[] };
    expect(body.events).toEqual([{ action: "publish", type: "article", id: "article-1-vi", locale: "vi", paths: ["/vi/blog/first"], version: 2 }]);
    expect(await verifyWebhook(hooks[0].req, hooks[0].body, env.CMS_WEBHOOK_SECRET, DEFAULT_VERIFY, Date.parse("2026-10-01T10:00:00Z"))).toEqual({ ok: true });
    expect(hooks[0].req.headers.get("x-cms-delivery")).toBe(body.id);
    await mutate("mutation($id: String!) { unpublish(id: $id) { id } }", { id: "article-1-vi" });
    expect(JSON.parse(hooks[1].body).events[0]).toMatchObject({ action: "unpublish", version: 2 });
    const log = await (await cms.request("/admin/deliveries", { headers: { authorization: `Bearer ${env.CMS_TOKEN}` } }, env)).json() as { status: number }[];
    expect(log.map((d) => d.status)).toEqual([200, 200]);
  });
  it("a failing receiver never fails the publish; the log shows the status", async () => {
    status = 503;
    await mutate("mutation($id: String!, $fields: JSON) { saveDraft(id: $id, fields: $fields) { id } }", { id: "page-about-en", fields: { title: "x" } });
    expect((await mutate("mutation { publish(id: \"page-about-en\") { version } }", {})).data.publish).toEqual({ version: 2 });
    expect((await store.load()).deliveries[0].status).toBe(503);
  });
  it("a throwing receiver is logged as error", async () => {
    cms = createMockCms({ store: () => store, deliver: async () => { throw new Error("down"); } });
    await mutate("mutation($id: String!, $fields: JSON) { saveDraft(id: $id, fields: $fields) { id } }", { id: "page-about-en", fields: {} });
    await mutate("mutation { publish(id: \"page-about-en\") { version } }", {});
    expect((await store.load()).deliveries[0].status).toBe("error");
  });
  it("admin endpoints are token-gated; reset restores the seed", async () => {
    expect((await cms.request("/admin/deliveries", {}, env)).status).toBe(401);
    expect((await cms.request("/admin/reset", { method: "POST" }, env)).status).toBe(401);
    await mutate("mutation($id: String!, $fields: JSON) { saveDraft(id: $id, fields: $fields) { id } }", { id: "page-about-en", fields: { title: "x" } });
    await mutate("mutation { publish(id: \"page-about-en\") { version } }", {});
    expect((await cms.request("/admin/reset", { method: "POST", headers: { authorization: `Bearer ${env.CMS_TOKEN}` } }, env)).status).toBe(200);
    expect((await client.route("/about", "en"))?.title).toBe("About");
  });
});

describe("editor endpoints", () => {
  const auth = { authorization: `Bearer ${env.CMS_TOKEN}` };
  it("serves the editor page without secrets and gates the admin routes", async () => {
    const page = await cms.request("/editor", {}, env);
    expect(page.status).toBe(200); expect(await page.text()).toContain("cms:content-saved");
    expect((await cms.request("/admin/entries", {}, env)).status).toBe(401);
    expect((await cms.request("/admin/preview-url?id=page-about-en", {}, env)).status).toBe(401);
  });
  it("lists entries with draft/published versions", async () => {
    await mutate("mutation($id: String!, $fields: JSON) { saveDraft(id: $id, fields: $fields) { id } }", { id: "page-about-en", fields: { title: "d" } });
    const list = await (await cms.request("/admin/entries", { headers: auth }, env)).json() as { id: string; title: string; published: number | null; draft: number | null }[];
    expect(list.find((e) => e.id === "page-about-en")).toMatchObject({ title: "d", published: 1, draft: 2 });
  });
  it("preview-url: 404 without a previewUrl hook / unknown id, url when the hook returns one", async () => {
    expect((await cms.request("/admin/preview-url?id=page-about-en", { headers: auth }, env)).status).toBe(404);
    cms = createMockCms({ store: () => store, deliver: async () => new Response(), previewUrl: (_e, e) => (e.path ? `/p${e.path}` : null) });
    expect(await (await cms.request("/admin/preview-url?id=page-about-en", { headers: auth }, env)).json()).toEqual({ url: "/p/about" });
    expect((await cms.request("/admin/preview-url?id=block-banner", { headers: auth }, env)).status).toBe(404);
    expect((await cms.request("/admin/preview-url?id=nope", { headers: auth }, env)).status).toBe(404);
  });
});

describe("tags + routing", () => {
  it("what the route loader tracks is what a publish event purges (contract with cf-lite/modules/webhook)", () => {
    const req = new Request("http://x/en");
    trackContent(req, "page", "page-home-en"); trackContent(req, "block", "*"); trackContent(req, "article", "*");
    const page = contentTags(req);
    const hit = (ev: Parameters<typeof eventTags>[0]) => eventTags(ev).some((t) => page.includes(t));
    expect(hit({ action: "publish", type: "page", id: "page-home-en" })).toBe(true);
    expect(hit({ action: "publish", type: "page", id: "page-about-en" })).toBe(false);
    expect(hit({ action: "publish", type: "article", id: "article-2-en" })).toBe(true); // list on the page
    expect(hit({ action: "unpublish", type: "block", id: "block-banner" })).toBe(true);
  });
  it("splitRoute", () => {
    expect(splitRoute("en")).toEqual({ locale: "en", path: "/" });
    expect(splitRoute("vi/blog/first/")).toEqual({ locale: "vi", path: "/blog/first" });
    expect(splitRoute("fr/x").locale).toBeUndefined();
    expect(splitRoute("")).toEqual({ locale: undefined, path: "/" });
  });
});
