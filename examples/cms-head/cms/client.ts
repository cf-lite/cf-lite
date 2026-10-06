/**
 * Typed GraphQL client for the head. `fetcher` is the seam: the in-process mock (`mock.fetch`), a service binding (`env.CMS.fetch`) or
 * the real CMS (`fetch(env.CMS_URL, ...)`). Every document stays inside the subset the mock executes (cms/graphql.ts).
 */
import type { ArticleSummary, Locale, RouteDoc } from "./types";

export type Fetcher = (req: Request) => Promise<Response>;
export class CmsError extends Error { constructor(msg: string, readonly status = 502) { super(msg); } }

const BLOCK_LEAVES = `... on Hero { heading sub } ... on RichText { html } ... on Cta { label href } ... on Banner { text } ... on ArticleList { heading limit }`;
// Blocks nest through Columns; GraphQL has no recursion, so the document spells two levels (enough for the registry; deeper = ask the CMS to flatten).
const L2 = `__typename ${BLOCK_LEAVES}`;
const L1 = `__typename ${BLOCK_LEAVES} ... on Columns { left { ${L2} } right { ${L2} } }`;

export const ROUTE_QUERY = `query Route($path: String!, $locale: Locale!, $preview: Boolean) {
  route(path: $path, locale: $locale, preview: $preview) {
    __typename
    ... on Page { id path locale version title blocks { ${L1} } }
    ... on Article { id path locale version title excerpt body blocks { ${L1} } }
  }
}`;
export const ARTICLES_QUERY = `query Articles($locale: Locale!, $limit: Int, $preview: Boolean) {
  articles(locale: $locale, limit: $limit, preview: $preview) { id path title excerpt }
}`;

export function createCmsClient(fetcher: Fetcher, token?: string) {
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetcher(new Request("http://cms.internal/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, variables }),
    }));
    if (!res.ok) throw new CmsError(`CMS answered ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new CmsError(json.errors.map((e) => e.message).join("; "));
    return json.data as T;
  }
  return {
    /** `null` = no such published route (the loader turns it into notFound()). `preview` reads the draft version when there is one. */
    async route(path: string, locale: Locale, preview = false): Promise<RouteDoc | null> {
      return (await gql<{ route: RouteDoc | null }>(ROUTE_QUERY, { path, locale, preview })).route;
    },
    async articles(locale: Locale, limit = 5, preview = false): Promise<ArticleSummary[]> {
      return (await gql<{ articles: ArticleSummary[] }>(ARTICLES_QUERY, { locale, limit, preview })).articles;
    },
  };
}
export type CmsClient = ReturnType<typeof createCmsClient>;
