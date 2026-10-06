/**
 * SSR islands (docs/islands.md, docs/design/islands.md): `*.island.tsx` components render on the server inside a
 * `<cfl-island>` element and hydrate in the browser on their own, by strategy. This module is runtime-neutral: the adapters'
 * wrapper imports `encodeProps`, the generated Worker app imports `islandsRoute`. The browser side is `cf-lite/islands-client`.
 */

export const STRATEGIES = ["load", "idle", "visible", "interaction"] as const;
export type Strategy = (typeof STRATEGIES)[number];
export const ISLAND_TAG = "cfl-island";
/** What an adapter's `islands.detect` reports for one source module: one row per exported component it understood. `strategy` set = wrap it as an island; `skip` = interactive but cannot be one (the reason is logged at build). */
export interface IslandCandidate { export: string; strategy?: Strategy; skip?: string }
/** `cfLite({ islands: { auto } })`: components the adapter's `detect` finds interactive become islands without a `*.island.tsx` name. JSON-serialisable (prerender re-reads it from `.cf-lite/meta.json`). */
export interface IslandsAuto {
  /** Strategy for auto islands when the module has no `export const client` (default `visible`). */
  client?: Strategy;
  /** Extra path prefixes (relative to the project root) never scanned, on top of routes, tests, build output and `node_modules`. */
  exclude?: string[];
}
/** Props above this are rejected at render time (they travel in the HTML); above WARN_PROPS_BYTES dev logs a warning, and `cf-lite doctor` flags built pages (CFL017). */
export const MAX_PROPS_BYTES = 65_536;
export const WARN_PROPS_BYTES = 8_192;

const plain = (v: unknown) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };

/** Throws a message naming the island and the offending path when `v` is not plain JSON data (functions, elements, Date, Map, class instances, NaN...). */
function check(id: string, v: unknown, path: string): void {
  const t = typeof v;
  if (v === null || t === "string" || t === "boolean" || v === undefined) return;
  if (t === "number") { if (!Number.isFinite(v)) throw new Error(`cf-lite island "${id}": prop ${path} is ${v}, which JSON cannot carry`); return; }
  const bad = (what: string) => new Error(`cf-lite island "${id}": prop ${path} is ${what}; island props must be plain JSON (string, number, boolean, null, arrays, plain objects). Pass an id/URL and fetch or compute on the client instead.`);
  if (t === "function") throw bad("a function");
  if (t === "bigint" || t === "symbol") throw bad(`a ${t}`);
  if (Array.isArray(v)) { v.forEach((x, i) => check(id, x, `${path}[${i}]`)); return; }
  if ((v as { $$typeof?: unknown }).$$typeof) throw bad("a React element (islands cannot take children; render them inside the island or split it)");
  if (!plain(v)) throw bad(`a ${(v as object).constructor?.name ?? "non-plain"} object`);
  for (const [k, x] of Object.entries(v as object)) check(id, x, `${path}.${k}`);
}

/** `data-p` attribute value for an island's props; undefined when there are none (attribute omitted). Escaping is the renderer's job (React/Preact escape attribute values). */
export function encodeProps(id: string, props: Record<string, unknown>): string | undefined {
  const { children, ...rest } = props;
  if (children !== undefined) throw new Error(`cf-lite island "${id}": islands cannot take \`children\` (they cannot cross into the browser as JSON). Render them inside the island or split it.`);
  check(id, rest, "props");
  const s = JSON.stringify(rest);
  if (s === "{}") return undefined;
  if (s.length > MAX_PROPS_BYTES) throw new Error(`cf-lite island "${id}": props are ${s.length} bytes (limit ${MAX_PROPS_BYTES}); they ship in the HTML. Send an id and fetch the data from the client instead.`);
  if (s.length > WARN_PROPS_BYTES && (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV) console.warn(`[cf-lite] island "${id}": props are ${s.length} bytes (warn above ${WARN_PROPS_BYTES}); consider fetching on the client`);
  return s;
}
