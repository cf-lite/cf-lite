import type { Context } from "hono";
import { notFound, redirect } from "cf-lite/navigation";
import { Blocks, needsArticles, views, type BlockCtx } from "../blocks/registry";
import { createCmsClient, type Fetcher } from "../../cms/client";
import { mockCms } from "../../server/api/cms";
import { isDraft } from "cf-lite/modules/draft";
import { contentTags, trackContent } from "cf-lite/modules/webhook";
import { splitRoute as split } from "../../cms/types";
import type { RouteDoc } from "../../cms/types";

export const render = "ssr";
// Durable static: the rendered page lives in R2 and is purged by tag when the CMS webhook fires (server/api/webhook.ts). Previews carry
// the draft cookie, which isr() bypasses on (never stores, never serves a stored copy to a previewer).
export const isr = {
  maxAge: 3600, swr: 86400,
  // what the loader tracked: this document, shared blocks (any), and article lists (any article). A publish of that content purges the page.
  tags: (c: Context) => contentTags(c),
};

const splatOf = (c: Context) => c.req.param("*") ?? "";

// The seam to the CMS: in-process mock by default, `CMS_URL` = a real GraphQL endpoint.
const fetcherFor = (env: Env): Fetcher => env.CMS_URL ? (req) => fetch(env.CMS_URL!, req) : (req) => Promise.resolve(mockCms.fetch(new Request(new URL("/graphql", req.url), req), env));

export async function loader(c: Context<{ Bindings: Env }>) {
  const splat = splatOf(c);
  const { locale, path } = split(splat);
  if (!splat) redirect("/en", 302);
  if (!locale) notFound();
  const preview = isDraft(c);
  const cms = createCmsClient(fetcherFor(c.env), c.env.CMS_TOKEN);
  const doc = await cms.route(path, locale, preview);
  if (!doc) notFound();
  trackContent(c, doc.__typename === "Page" ? "page" : "article", doc.id);
  trackContent(c, "block", "*"); // BlockRef targets are resolved CMS-side and not identifiable here: any shared-block publish purges CMS pages
  // blocks are sync components: whatever they need is fetched here, once
  const limit = needsArticles(doc.blocks);
  const articles = limit ? await cms.articles(locale, limit, preview) : [];
  if (limit) trackContent(c, "article", "*");
  return { doc, locale, articles, preview };
}

export const head = ({ data }: { data?: unknown }) => {
  const d = data as { doc: RouteDoc; preview: boolean } | undefined;
  return { title: d?.doc.title ?? "Not found", ...(d?.preview ? { meta: [{ name: "robots", content: "noindex, nofollow" }], script: [{ src: "/cms-saved-listener.js" }] } : {}) };
};

export default function CmsRoute({ data }: { data: { doc: RouteDoc; locale: string; articles: BlockCtx["articles"]; preview: boolean } }) {
  const ctx: BlockCtx = { locale: data.locale, articles: data.articles };
  const View = views[data.doc.__typename] as (p: { doc: RouteDoc; ctx: BlockCtx }) => ReturnType<typeof Blocks>;
  return <div lang={data.locale} data-locale={data.locale}>{data.preview && <p data-testid="preview-badge">PREVIEW (draft)</p>}<nav><a href="/en">en</a> | <a href="/vi">vi</a></nav><View doc={data.doc} ctx={ctx} /></div>;
}
