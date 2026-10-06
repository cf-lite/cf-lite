export const LOCALES = ["en", "vi"] as const;
export type Locale = (typeof LOCALES)[number];
export const isLocale = (s: string | undefined): s is Locale => !!s && (LOCALES as readonly string[]).includes(s);

/** `en/blog/first` -> { locale: "en", path: "/blog/first" }; `en` -> path "/"; unknown first segment -> locale undefined. */
export function splitRoute(splat: string): { locale: Locale | undefined; path: string } {
  const [first, ...rest] = splat.split("/").filter(Boolean);
  return { locale: isLocale(first) ? first : undefined, path: "/" + rest.join("/") };
}

/** Block value types: what the registry (app/blocks/registry.tsx) maps to components. `BlockRef` is resolved by the CMS into the referenced `block` entry. */
export type Block =
  | { __typename: "Hero"; heading: string; sub?: string }
  | { __typename: "RichText"; html: string }
  | { __typename: "Cta"; label: string; href: string }
  | { __typename: "Columns"; left: Block[]; right: Block[] }
  | { __typename: "ArticleList"; heading: string; limit?: number }
  | { __typename: "Banner"; text: string }
  | { __typename: "BlockRef"; ref: string };

export type EntryType = "page" | "article" | "block";
export interface Fields { title: string; blocks?: Block[]; excerpt?: string; body?: string; block?: Block }
export interface Version { n: number; at: string; fields: Fields }
export interface Entry {
  id: string; type: EntryType; locale: Locale;
  /** Site-relative route, "/" = the locale's home. Not set for `block` entries. */
  path?: string;
  /** What the live site serves. null = never published / unpublished. */
  published: Version | null;
  /** The working copy. Only readable with `preview: true`; `publish` promotes it. */
  draft: Version | null;
}
export interface WebhookEvent {
  /** Unique per delivery attempt group; the receiver dedupes on it. */
  id: string; event: "entry.publish" | "entry.unpublish"; entryId: string; type: EntryType; locale: Locale; path: string | null; version: number; at: string;
}
export interface Db { entries: Entry[]; seq: number; deliveries: { id: string; entryId: string; status: number | "error"; at: string }[] }

/** Resolved shapes the head app consumes (output of cms/client.ts). */
export interface PageDoc { __typename: "Page"; id: string; path: string; locale: Locale; version: number; title: string; blocks: Block[] }
export interface ArticleDoc { __typename: "Article"; id: string; path: string; locale: Locale; version: number; title: string; excerpt: string; body: string; blocks: Block[] }
export type RouteDoc = PageDoc | ArticleDoc;
export interface ArticleSummary { id: string; path: string; title: string; excerpt: string }
