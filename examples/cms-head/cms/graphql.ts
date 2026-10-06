/**
 * A deliberately tiny GraphQL subset for the mock CMS: one operation, top-level fields with literal/variable arguments, nested selection
 * sets, inline fragments (`... on Page { }`), `__typename`. No schema validation, directives, named fragments or aliases: the mock
 * resolvers own the data, this file only parses the document and projects the selected fields from what the resolver returned.
 * (A real CMS speaks full GraphQL; the head only ever sends documents inside this subset, see cms/client.ts.)
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export interface Sel { name: string; args: Record<string, Arg>; sel: Sel[]; on?: string }
type Arg = { v: Json } | { $: string };
export interface Doc { kind: "query" | "mutation"; name?: string; vars: string[]; sel: Sel[] }

const TOKEN = /\s*(?:#[^\n]*\n)*\s*(\.\.\.|[{}()\[\]:!=,$@]|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*)/y;

function tokens(src: string): string[] {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src); // a failed sticky match resets lastIndex to 0, so the position is tracked by hand
    if (!m) break;
    pos = TOKEN.lastIndex;
    if (m[1] !== ",") out.push(m[1]);
  }
  if (src.slice(pos).trim()) throw new GqlError(`unexpected character at ${pos}`);
  return out;
}
export class GqlError extends Error {}

export function parse(src: string): Doc {
  const t = tokens(src);
  let i = 0;
  const peek = () => t[i], next = () => t[i++];
  const expect = (x: string) => { if (next() !== x) throw new GqlError(`expected ${x}`); };
  const name = () => { const n = next(); if (!n || !/^[A-Za-z_]/.test(n)) throw new GqlError(`expected a name, got ${n}`); return n; };

  const value = (): Arg => {
    const n = next();
    if (n === "$") return { $: name() };
    if (n === "true" || n === "false") return { v: n === "true" };
    if (n === "null") return { v: null };
    if (n?.startsWith('"')) return { v: JSON.parse(n) };
    if (n && /^-?\d/.test(n)) return { v: Number(n) };
    if (n && /^[A-Za-z_]/.test(n)) return { v: n }; // enum literal (locale: en)
    throw new GqlError(`bad value ${n}`);
  };
  const selection = (): Sel[] => {
    expect("{");
    const out: Sel[] = [];
    while (peek() !== "}") {
      if (peek() === undefined) throw new GqlError("unterminated selection");
      if (peek() === "...") {
        next(); if (next() !== "on") throw new GqlError("only inline fragments (`... on Type`) are supported");
        const on = name();
        out.push({ name: "...", on, args: {}, sel: selection() });
        continue;
      }
      const n = name();
      if (peek() === ":") throw new GqlError("aliases are not supported");
      const args: Record<string, Arg> = {};
      if (peek() === "(") {
        next();
        while (peek() !== ")") { const k = name(); expect(":"); args[k] = value(); }
        next();
      }
      out.push({ name: n, args, sel: peek() === "{" ? selection() : [] });
    }
    next();
    return out;
  };

  let kind: Doc["kind"] = "query", opName: string | undefined;
  const vars: string[] = [];
  if (peek() === "query" || peek() === "mutation") {
    kind = next() as Doc["kind"];
    if (peek() && peek() !== "(" && peek() !== "{") opName = name();
    if (peek() === "(") {
      next();
      while (peek() !== ")") {
        expect("$"); vars.push(name()); expect(":");
        while (peek() !== undefined && peek() !== "$" && peek() !== ")") next(); // type + default are ignored
      }
      next();
    }
  }
  const sel = selection();
  if (i !== t.length) throw new GqlError("trailing tokens after the operation");
  return { kind, name: opName, vars, sel };
}

export const argValue = (a: Arg, variables: Record<string, Json>): Json => ("v" in a ? a.v : variables[a.$] ?? null);
export const argsOf = (s: Sel, variables: Record<string, Json>): Record<string, Json> =>
  Object.fromEntries(Object.entries(s.args).map(([k, a]) => [k, argValue(a, variables)]));

/** Keep only the selected fields. `__typename` on the object decides which inline fragments apply. */
export function project(value: Json, sel: Sel[]): Json {
  if (Array.isArray(value)) return value.map((v) => project(v, sel));
  if (value === null || typeof value !== "object") return value;
  if (!sel.length) return value;
  const out: Record<string, Json> = {};
  const apply = (list: Sel[]) => {
    for (const s of list) {
      if (s.name === "...") { if (s.on === value.__typename) apply(s.sel); continue; }
      if (s.name === "__typename") { out.__typename = value.__typename ?? null; continue; }
      out[s.name] = project(value[s.name] ?? null, s.sel);
    }
  };
  apply(sel);
  return out;
}

export type Resolver = (args: Record<string, Json>, ctx: { variables: Record<string, Json> }) => Json | Promise<Json>;
/** Execute against `{ field: resolver }` maps. A resolver throwing `GqlError` becomes a per-field `errors[]` entry (data null for it). */
export async function execute(doc: Doc, root: Record<string, Resolver>, variables: Record<string, Json> = {}) {
  const data: Record<string, Json> = {}, errors: { message: string; path: string[] }[] = [];
  for (const s of doc.sel) {
    const r = root[s.name];
    try {
      if (!r) throw new GqlError(`Cannot query field "${s.name}"`);
      data[s.name] = project(await r(argsOf(s, variables), { variables }), s.sel);
    } catch (e) {
      if (!(e instanceof GqlError)) throw e;
      data[s.name] = null; errors.push({ message: e.message, path: [s.name] });
    }
  }
  return errors.length ? { data, errors } : { data };
}
