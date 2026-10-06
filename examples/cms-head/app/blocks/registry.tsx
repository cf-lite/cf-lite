import type { ReactNode } from "react";
import type { ArticleDoc, ArticleSummary, Block, PageDoc } from "../../cms/types";

/** Everything a block may need beyond its own fields. Fetched by the route loader (blocks stay sync, no data fetching in components). */
export interface BlockCtx { locale: string; articles: ArticleSummary[] }
type Of<K extends Block["__typename"]> = Extract<Block, { __typename: K }>;
type Renderer<K extends Block["__typename"]> = (p: { block: Of<K>; ctx: BlockCtx }) => ReactNode;

/** content-type -> component. One entry per block type the CMS can send. Unknown types render nothing (and a dev comment). */
export type Registry = { [K in Exclude<Block["__typename"], "BlockRef">]: Renderer<K> };

export const Hero: Renderer<"Hero"> = ({ block }) => <section data-block="Hero"><h1 data-testid="hero">{block.heading}</h1>{block.sub && <p>{block.sub}</p>}</section>;
export const RichText: Renderer<"RichText"> = ({ block }) => <div data-block="RichText" dangerouslySetInnerHTML={{ __html: block.html }} />; // CMS-authored HTML: sanitise at the CMS or here before shipping for real
export const Cta: Renderer<"Cta"> = ({ block }) => <a data-block="Cta" className="cta" href={block.href}>{block.label}</a>;
export const Banner: Renderer<"Banner"> = ({ block }) => <aside data-block="Banner" data-testid="banner">{block.text}</aside>;
export const ArticleList: Renderer<"ArticleList"> = ({ block, ctx }) => (
  <section data-block="ArticleList"><h2>{block.heading}</h2><ul>{ctx.articles.map((a) => <li key={a.id}><a href={`/${ctx.locale}${a.path}`}>{a.title}</a> <small>{a.excerpt}</small></li>)}</ul></section>
);
export const Columns: Renderer<"Columns"> = ({ block, ctx }) => (
  <div data-block="Columns" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}><div><Blocks blocks={block.left} ctx={ctx} /></div><div><Blocks blocks={block.right} ctx={ctx} /></div></div>
);

export const registry: Registry = { Hero, RichText, Cta, Banner, ArticleList, Columns };

/** Composition: a block list is rendered by looking each `__typename` up in the registry; Columns recurse through the same function. */
export function Blocks({ blocks, ctx, registry: reg = registry }: { blocks: Block[]; ctx: BlockCtx; registry?: Registry }): ReactNode {
  return <>{blocks.map((b, i) => {
    const R = (reg as unknown as Record<string, Renderer<never> | undefined>)[b.__typename];
    return R ? <R key={i} block={b as never} ctx={ctx} /> : <span key={i} data-unknown-block={b.__typename} hidden />;
  })}</>;
}

/** Block types that need loader data -> used by the route to decide what to fetch (a registry-adjacent declaration, not a runtime fetch). */
export function needsArticles(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.__typename === "ArticleList") n = Math.max(n, b.limit ?? 5);
    else if (b.__typename === "Columns") n = Math.max(n, needsArticles(b.left), needsArticles(b.right));
  }
  return n;
}

/** CMS document type -> view. Page and Article share the block area; Article adds its own fields. */
export const views = {
  Page: ({ doc, ctx }: { doc: PageDoc; ctx: BlockCtx }) => <main data-view="Page"><Blocks blocks={doc.blocks} ctx={ctx} /></main>,
  Article: ({ doc, ctx }: { doc: ArticleDoc; ctx: BlockCtx }) => (
    <main data-view="Article"><article><h1 data-testid="title">{doc.title}</h1><div dangerouslySetInnerHTML={{ __html: doc.body }} /></article><Blocks blocks={doc.blocks} ctx={ctx} /></main>
  ),
};
