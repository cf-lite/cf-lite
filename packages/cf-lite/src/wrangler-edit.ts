/**
 * Comment-preserving edits of wrangler.jsonc/.json. Text-level on purpose (no AST dependency): a scanner finds the
 * span of a top-level key, then we splice. Everything that touches wrangler config goes through here, so a future
 * config layer change is one adapter. Shared with WP-DX.
 */

interface Span { start: number; end: number }

/** Walk `text`, calling `visit(i, ch, depth)` for every code character (not inside strings/comments). */
function scan(text: string, visit: (i: number, ch: string, depth: number) => void | "stop") {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { i = endOfString(text, i); continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (ch === "{" || ch === "[") { if (visit(i, ch, depth) === "stop") return; depth++; continue; }
    if (ch === "}" || ch === "]") { depth--; if (visit(i, ch, depth) === "stop") return; continue; }
    if (visit(i, ch, depth) === "stop") return;
  }
}
function endOfString(text: string, i: number) {
  for (i++; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === '"') return i; }
  return text.length;
}
const skipWs = (text: string, i: number) => {
  for (; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    if (text[i] === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; i--; continue; }
    if (text[i] === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 1; continue; }
    break;
  }
  return i;
};

/** Parse JSONC (comments + trailing commas). */
export function parseJsonc<T = any>(text: string): T {
  let out = ""; let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { out += ch; if (ch === "\\") out += text[++i]; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (ch === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 1; continue; }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Find the value span of top-level `key`. */
function findTopLevel(text: string, key: string): (Span & { keyStart: number }) | null {
  let found: (Span & { keyStart: number }) | null = null;
  // scan() skips strings, so walk them ourselves at depth 1
  let depth = 0;
  for (let i = 0; i < text.length && !found; i++) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (ch === '"') {
      const e = endOfString(text, i);
      if (depth === 1 && text.slice(i + 1, e) === key) {
        const colon = skipWs(text, e + 1);
        if (text[colon] === ":") {
          const vs = skipWs(text, colon + 1);
          found = { keyStart: i, start: vs, end: valueEnd(text, vs) };
        }
      }
      i = e; continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return found;
}
function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return endOfString(text, start) + 1;
  if (text[start] === "{" || text[start] === "[") {
    let end = text.length; let base = -1;
    scan(text.slice(start), (i, ch, depth) => { if (base < 0) base = 0; if ((ch === "}" || ch === "]") && depth === 0) { end = start + i + 1; return "stop"; } });
    return end;
  }
  let i = start; while (i < text.length && !/[,}\]\s]/.test(text[i])) i++; return i;
}

function indentOf(text: string, at: number) {
  const ls = text.lastIndexOf("\n", at) + 1;
  return /^[ \t]*/.exec(text.slice(ls))![0];
}
const indentUnit = (text: string) => { const m = /\n([ \t]+)"/.exec(text); return m ? m[1] : "  "; };
const pretty = (v: unknown, pad: string, unit: string): string => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const e = Object.entries(v as object);
    if (!e.length) return "{}";
    return "{\n" + e.map(([k, x]) => `${pad}${unit}${JSON.stringify(k)}: ${pretty(x, pad + unit, unit)}`).join(",\n") + `\n${pad}}`;
  }
  return JSON.stringify(v);
};

export interface EditResult { text: string; changed: boolean }

/**
 * Append `item` to the top-level array `key` (created when missing) unless an element with the same `idKey` value
 * exists. Comments and formatting elsewhere in the file are untouched.
 */
export function addToArray(text: string, key: string, item: Record<string, unknown>, idKey: string): EditResult {
  const cfg = parseJsonc<any>(text);
  if (Array.isArray(cfg[key]) && cfg[key].some((x: any) => x?.[idKey] === item[idKey])) return { text, changed: false };
  const unit = indentUnit(text);
  const span = findTopLevel(text, key);
  if (span) {
    if (text[span.start] !== "[") throw new Error(`wrangler config: "${key}" is not an array`);
    const close = span.end - 1;
    const pad = indentOf(text, span.keyStart) + unit;
    const body = pretty(item, pad, unit);
    // last non-space, non-comment char before `]`
    let j = close - 1; while (j > span.start && /\s/.test(text[j])) j--;
    const empty = j === span.start;
    const hasComma = text[j] === ",";
    const closeIndent = indentOf(text, span.keyStart);
    const head = text.slice(0, j + 1) + (empty || hasComma ? "" : ",") + `\n${pad}${body}`;
    return { text: head + (empty ? `\n${closeIndent}` : "") + text.slice(j + 1), changed: true };
  }
  // key missing: insert before the closing brace of the top-level object
  let open = -1; let close = -1;
  scan(text, (i, ch, depth) => { if (ch === "{" && depth === 0 && open < 0) open = i; if (ch === "}" && depth === 0) { close = i; return "stop"; } });
  if (open < 0 || close < 0) throw new Error("wrangler config: no top-level object");
  let j = close - 1; while (j > open && /\s/.test(text[j])) j--;
  const empty = j === open; const hasComma = text[j] === ",";
  const pad = unit;
  const entry = `${pad}${JSON.stringify(key)}: [\n${pad}${unit}${pretty(item, pad + unit, unit)}\n${pad}]`;
  return { text: text.slice(0, j + 1) + (empty || hasComma ? "" : ",") + `\n${entry}` + "\n" + text.slice(close), changed: true };
}

/** Set a top-level scalar key only when it is absent. */
export function setIfMissing(text: string, key: string, value: string | number | boolean): EditResult {
  if (parseJsonc<any>(text)[key] !== undefined) return { text, changed: false };
  const unit = indentUnit(text);
  let open = -1; let close = -1;
  scan(text, (i, ch, depth) => { if (ch === "{" && depth === 0 && open < 0) open = i; if (ch === "}" && depth === 0) { close = i; return "stop"; } });
  let j = close - 1; while (j > open && /\s/.test(text[j])) j--;
  const empty = j === open; const hasComma = text[j] === ",";
  return { text: text.slice(0, j + 1) + (empty || hasComma ? "" : ",") + `\n${unit}${JSON.stringify(key)}: ${JSON.stringify(value)}` + "\n" + text.slice(close), changed: true };
}
