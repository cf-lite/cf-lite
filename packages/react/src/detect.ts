/**
 * Auto-islands, React side: classify the components a module exports by what they use (this uses Vite's parser, so the
 * adapter needs nothing extra):
 *   static  no hooks, no handlers, no browser globals
 *   ssr     only server-safe hooks (useContext, use, useId, useMemo, ...)
 *   island  state, effects, refs, handlers, browser globals, custom hooks, a "use client" directive
 * Only `island` verdicts are reported with a strategy; an island that takes `children` is reported with `skip` (children cannot cross into the browser).
 */
import { parseAst } from "vite";
import type { IslandCandidate } from "cf-lite/islands";

export const SERVER_HOOKS = ["use", "useContext", "useId", "useMemo", "useCallback", "useDebugValue"];
export const CLIENT_HOOKS = ["useState", "useReducer", "useEffect", "useLayoutEffect", "useInsertionEffect", "useRef", "useImperativeHandle", "useSyncExternalStore", "useTransition", "useDeferredValue", "useOptimistic", "useActionState", "useFormStatus"];
const BROWSER_GLOBALS = new Set(["window", "document", "localStorage", "sessionStorage", "navigator", "location", "IntersectionObserver", "matchMedia", "requestAnimationFrame"]);

export interface DetectOptions { /** hooks that are safe on the server in addition to React's (e.g. a CMS kit's `useContent`) */ serverHooks?: string[]; /** extra browser-only hooks */ clientHooks?: string[] }
export type Verdict = { name: string; kind: "static" | "ssr" | "island"; reasons: string[]; line: number; children: boolean; exported: string | null };

type N = any;
const isFn = (n: N) => n && (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression" || n.type === "FunctionDeclaration");

/** Every capitalised top-level function component of `source` with its verdict and (when exported) the export name. Pure; exported for tests and for tooling that wants the reasons. */
export function classifyModule(source: string, file = "x.tsx", o: DetectOptions = {}): Verdict[] {
  const server = new Set([...SERVER_HOOKS, ...(o.serverHooks ?? [])]), client = new Set([...CLIENT_HOOKS, ...(o.clientHooks ?? [])]);
  const ast = parseAst(source, { lang: file.endsWith(".tsx") ? "tsx" : file.endsWith(".ts") ? "ts" : "jsx" }) as N;
  const lineAt = (pos: number) => { let l = 1; for (let i = 0; i < pos; i++) if (source.charCodeAt(i) === 10) l++; return l; };
  const useClient = ast.body.some((s: N) => s.type === "ExpressionStatement" && s.expression?.type === "Literal" && s.expression.value === "use client");

  // top-level components: name -> function node
  const comps = new Map<string, N>();
  const exports = new Map<string, string>(); // local name -> export name
  let anonDefault: N = null;
  for (const s of ast.body as N[]) {
    let d = s;
    if (s.type === "ExportNamedDeclaration" && s.declaration) d = s.declaration;
    else if (s.type === "ExportDefaultDeclaration") d = s.declaration;
    if (d.type === "FunctionDeclaration" && d.id && /^[A-Z]/.test(d.id.name)) {
      comps.set(d.id.name, d);
      if (s.type === "ExportNamedDeclaration") exports.set(d.id.name, d.id.name); else if (s.type === "ExportDefaultDeclaration") exports.set(d.id.name, "default");
    } else if (d.type === "VariableDeclaration") {
      for (const v of d.declarations) if (v.id.type === "Identifier" && /^[A-Z]/.test(v.id.name) && isFn(v.init)) { comps.set(v.id.name, v.init); if (s.type === "ExportNamedDeclaration") exports.set(v.id.name, v.id.name); }
    } else if (s.type === "ExportDefaultDeclaration" && (d.type === "Identifier")) exports.set(d.name, "default");
    else if (s.type === "ExportDefaultDeclaration" && isFn(d) && !d.id) anonDefault = d;
    if (s.type === "ExportNamedDeclaration" && !s.declaration && !s.source) for (const sp of s.specifiers) exports.set(sp.local.name ?? sp.local.value, sp.exported.name ?? sp.exported.value);
  }

  const verdict = (name: string, fn: N): Verdict => {
    const reasons: string[] = []; let rank = 0;
    const note = (r: number, why: string) => { rank = Math.max(rank, r); reasons.push(why); };
    if (useClient) note(2, '"use client" directive');
    const own = new Set<string>();
    const bind = (b: N): void => {
      if (!b) return;
      if (b.type === "Identifier") own.add(b.name);
      else if (b.type === "ObjectPattern") b.properties.forEach((p: N) => bind(p.type === "RestElement" ? p.argument : p.value));
      else if (b.type === "ArrayPattern") b.elements.forEach(bind);
      else if (b.type === "AssignmentPattern") bind(b.left);
      else if (b.type === "RestElement") bind(b.argument);
    };
    fn.params.forEach(bind);
    let children = false;
    const p0 = fn.params[0];
    const propsName = p0?.type === "Identifier" ? p0.name : p0?.type === "AssignmentPattern" && p0.left.type === "Identifier" ? p0.left.name : null;
    if (p0?.type === "ObjectPattern" && p0.properties.some((p: N) => p.type === "Property" && (p.key?.name ?? p.key?.value) === "children")) children = true;
    const collect = (n: N): void => { if (!n || typeof n.type !== "string") return; if (n.type === "VariableDeclarator") bind(n.id); for (const k in n) { const c = n[k]; if (Array.isArray(c)) c.forEach(collect); else if (c && typeof c.type === "string") collect(c); } };
    collect(fn.body);
    const visit = (n: N, parent: N, key: string): void => {
      if (!n || typeof n.type !== "string") return;
      if (n.type.startsWith("TS")) return; // types only
      if (n.type === "CallExpression" && n.callee.type === "Identifier" && /^use([A-Z]|$)/.test(n.callee.name)) {
        const h = n.callee.name, at = `at line ${lineAt(n.start)}`;
        if (client.has(h)) note(2, `${h}() ${at}`);
        else if (server.has(h)) note(1, `${h}() ${at}`);
        else note(2, `custom hook ${h}() ${at} (assumed client-side; list it in serverHooks if it is not)`);
      }
      if (n.type === "JSXAttribute" && n.name.type === "JSXIdentifier" && /^on[A-Z]/.test(n.name.name)) note(2, `${n.name.name} handler at line ${lineAt(n.start)}`);
      if (n.type === "MemberExpression" && propsName && n.object.type === "Identifier" && n.object.name === propsName && !n.computed && n.property.name === "children") children = true;
      if (n.type === "Identifier" && BROWSER_GLOBALS.has(n.name) && !own.has(n.name)
        && !(parent?.type === "MemberExpression" && key === "property" && !parent.computed)
        && !(parent?.type === "Property" && key === "key" && !parent.shorthand && !parent.computed)) note(2, `browser global ${n.name} at line ${lineAt(n.start)}`);
      for (const k in n) { if (k === "type" || k === "start" || k === "end") continue; const c = n[k]; if (Array.isArray(c)) c.forEach((x) => visit(x, n, k)); else if (c && typeof c.type === "string") visit(c, n, k); }
    };
    visit(fn.body, fn, "body");
    return { name, kind: (["static", "ssr", "island"] as const)[rank]!, reasons, line: lineAt(fn.start), children, exported: exports.get(name) ?? null };
  };
  const out = [...comps].map(([name, fn]) => verdict(name, fn));
  if (anonDefault && JSON.stringify(anonDefault.body).includes('"JSXElement"')) out.push({ ...verdict("default", anonDefault), exported: "default" });
  return out;
}

/** `UiAdapter.islands.detect` for React: one candidate per exported component classified `island`. `null` when nothing in the module is a component. */
export function detectIslands(source: string, file: string, o: DetectOptions = {}): IslandCandidate[] | null {
  if (!/\b(use[A-Z]\w*\(|\bon[A-Z]\w*=|window|document|localStorage|sessionStorage|navigator|location|IntersectionObserver|matchMedia|requestAnimationFrame|use client)/.test(source)) return null; // cheap pre-filter: nothing interactive in the text at all
  const rows = classifyModule(source, file, o).filter((v) => v.kind === "island" && v.exported);
  if (!rows.length) return null;
  return rows.map((v) => v.children
    ? { export: v.exported!, skip: `takes \`children\` (${v.reasons[0]}); island props must be plain JSON, so it renders without hydrating. Pass data as props or split the interactive part` }
    : { export: v.exported!, strategy: "visible" as const });
}
