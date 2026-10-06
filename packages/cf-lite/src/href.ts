/**
 * Typed routes: `href()`, `LinkTo`, `InferData`, `PageProps`. Runtime is a few lines of string building; everything else is types.
 * `cf-lite prepare|dev|build` writes `.cf-lite/typed-routes.d.ts`, which augments `Register` below with the app's real route table. Without that
 * file (no routes yet) everything degrades to plain `string`, so the helpers are safe to import anywhere.
 */
import type { ActionFailure } from "./modules/actions.js";

/** Augmented by the generated `.cf-lite/typed-routes.d.ts`: `{ routes: { "/blog/:slug": { slug: string } }, modules: {...}, linkTo: ... }`. */
export interface Register {}

type Loose = Record<string, Record<string, string | undefined>>;
/** route pattern -> params object. `:name` -> `name: string`; `*` / `*?` (catch-all) -> `"*"` (required / optional). */
export type RouteParams = Register extends { routes: infer R } ? R : Loose;
export type RoutePattern = keyof RouteParams & string;
export type Params<P extends RoutePattern> = RouteParams[P];

/** What `href()` returns: a string that `<Link to>` accepts even when `to` is restricted to known routes. */
export type Href = string & { readonly __cfLiteHref: true };
/** `<Link to>`: a known internal route (any concrete path matching a pattern, optional `?query` / `#hash`), an external URL, `#hash`, `?query`, or an `href()` result. `string` when no route table was generated. */
export type LinkTo = Register extends { linkTo: infer T } ? T | Href : string;

/** `useParams` of the react / preact adapters: `useParams("/blog/:slug")` -> `{ slug: string }` (the pattern is only a type witness); no argument = untyped `Record<string, string>`. */
export interface UseParams {
  (): Record<string, string>;
  <P extends RoutePattern>(pattern: P): Params<P>;
}
/** `navigate` of the react / preact adapters: `to` must be a known route (concrete path, `?query`, `#hash`), an external URL or an `href()` result. */
export type Navigate = (to: LinkTo, replace?: boolean) => void;

type QueryValue = string | number | boolean | null | undefined;
export interface HrefOptions {
  query?: Record<string, QueryValue | QueryValue[]> | URLSearchParams;
  hash?: string;
}
type HrefArgs<P extends RoutePattern> = {} extends RouteParams[P] ? [params?: RouteParams[P], options?: HrefOptions] : [params: RouteParams[P], options?: HrefOptions];

/**
 * Build a URL from a route pattern: `href("/blog/:slug", { slug: "hi there" })` -> `/blog/hi%20there`. A wrong pattern or a missing/unknown
 * param is a compile error once `.cf-lite/typed-routes.d.ts` exists; at runtime a missing required param throws.
 */
export function href<P extends RoutePattern>(pattern: P, ...args: HrefArgs<P>): Href {
  const [params, opts] = args as [Record<string, string | undefined>?, HrefOptions?];
  const out: string[] = [];
  for (const seg of pattern.split("/").filter(Boolean)) {
    if (seg === "*" || seg === "*?") {
      const v = params?.["*"];
      if (v === undefined || v === "") {
        if (seg === "*") throw new Error(`cf-lite href(${JSON.stringify(pattern)}): missing param "*"`);
        continue;
      }
      out.push(...v.split("/").filter(Boolean).map(encodeURIComponent));
    } else if (seg.startsWith(":")) {
      const v = params?.[seg.slice(1)];
      if (v === undefined || v === "") throw new Error(`cf-lite href(${JSON.stringify(pattern)}): missing param "${seg.slice(1)}"`);
      out.push(encodeURIComponent(v));
    } else out.push(seg);
  }
  let url = "/" + out.join("/");
  const q = opts?.query;
  if (q) {
    const sp = q instanceof URLSearchParams ? q : new URLSearchParams();
    if (!(q instanceof URLSearchParams)) for (const [k, v] of Object.entries(q)) for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined && x !== null) sp.append(k, String(x));
    const s = sp.toString();
    if (s) url += "?" + s;
  }
  if (opts?.hash) url += "#" + opts.hash.replace(/^#/, "");
  return url as Href;
}

/** `InferData<typeof import("./app/routes/x")>`: what the page's `loader` resolves to (`undefined` when it has none). */
export type InferData<M> = M extends { loader: (...a: never[]) => infer R } ? Awaited<R> : undefined;

type ActionOutcome<R> = R extends ActionFailure<infer D> ? D : R extends Response ? never : R;
/** What the page sees as `actionData` after a POST: the union of every action's return (`fail(status, data)` -> `data`). `undefined` when none. */
export type InferActionData<M> = M extends { actions: infer A }
  ? { [K in keyof A]: A[K] extends (...a: never[]) => infer R ? ActionOutcome<Awaited<R>> : never }[keyof A]
  : undefined;

/** The module type behind a route pattern (`typeof import(...)`), from the generated table. */
export type RouteModule<P extends RoutePattern> = Register extends { modules: infer M } ? (P extends keyof M ? M[P] : unknown) : unknown;
/** Props of a page component for route `P`: `params` and `data` (loader result, plus `actionData` after a POST). */
export interface PageProps<P extends RoutePattern> {
  params: Params<P>;
  /** A plain-object loader result is spread into `data` (with `actionData` alongside); any other result is `data.data`. */
  data: PageData<RouteModule<P>>;
}
export type PageData<M> = InferData<M> extends infer L ? ([L] extends [object] ? ([L] extends [unknown[]] ? { data: L; actionData?: InferActionData<M> } : L & { actionData?: InferActionData<M> }) : { data?: L; actionData?: InferActionData<M> }) : never;
