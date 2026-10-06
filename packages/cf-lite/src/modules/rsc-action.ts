/**
 * Server-action request hardening for `render = "rsc"` routes (docs/design/rsc.md section 11). Pure functions on a Request, no React and no
 * Flight: v1 only supports FORM-based actions (`<form action={serverFn}>`), and cf-lite never calls `decodeReply` / `decodeAction` - the
 * entire surface behind the React2Shell / DoS advisories. We read a bounded body as FormData, extract exactly one `$ACTION_ID_<id>` field
 * ourselves, and the rsc environment only runs the id if it resolves to a registered server reference (`app/actions/**`, `*.actions.ts`).
 */
import { csrfVerdict, type CsrfOptions } from "./csrf.js";

export const DEFAULT_ACTION_MAX_BYTES = 1024 * 1024;
const MAX_FIELDS = 200;
const ID = /^[A-Za-z0-9_.\-/@$:]{1,300}#[A-Za-z_$][A-Za-z0-9_$]{0,99}$/;
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"]);

export type ActionRequest =
  | { ok: true; id: string; form: FormData }
  | { ok: false; status: 400 | 403 | 405 | 413 | 415; reason: string };

const fail = (status: 400 | 403 | 405 | 413 | 415, reason: string): ActionRequest => ({ ok: false, status, reason });

/** Reads at most `max` bytes; null when exceeded (the stream is cancelled, never buffered past the limit). */
export async function readLimited(req: Pick<Request, "headers" | "body">, max: number): Promise<Uint8Array | null> {
  const len = req.headers.get("content-length");
  if (len !== null && (!/^\d+$/.test(len) || Number(len) > max)) return null;
  if (!req.body) return new Uint8Array(0);
  const rd = req.body.getReader(), chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { rd.releaseLock(); return null; } // stop reading; the rest of the body is never buffered
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

export interface ActionOptions extends CsrfOptions { maxBytes?: number }

/** Origin/CSRF + content type + size limit + parse + single well-formed action id. Never throws. */
export async function parseActionRequest(req: Request, o: ActionOptions = {}): Promise<ActionRequest> {
  if (req.method !== "POST") return fail(405, "method");
  const v = csrfVerdict(req, o);
  if (!v.ok) return fail(v.status, v.reason);
  const body = await readLimited(req, o.maxBytes ?? DEFAULT_ACTION_MAX_BYTES);
  if (!body) return fail(413, "body too large");
  let form: FormData;
  try { form = await new Response(body as BodyInit, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData(); }
  catch { return fail(400, "unparseable body"); }
  let id: string | undefined, fields = 0;
  const rest = new FormData();
  for (const [k, val] of form) {
    if (++fields > MAX_FIELDS) return fail(413, "too many fields");
    if (k.startsWith("$ACTION_ID_")) {
      if (id !== undefined) return fail(400, "multiple action ids");
      id = k.slice("$ACTION_ID_".length);
    } else if (k.startsWith("$ACTION") || k.startsWith("$$")) return fail(400, "bound/encoded actions are not supported"); // $ACTION_REF_/$ACTION_KEY: bound args need decodeReply
    else rest.append(k, val);
  }
  if (id === undefined) return fail(400, "no action id");
  if (!ID.test(id) || FORBIDDEN_NAMES.has(id.slice(id.lastIndexOf("#") + 1))) return fail(400, "malformed action id");
  return { ok: true, id, form: rest };
}

/**
 * The HTML page and its `?__rsc` Flight payload share a path, so `__rsc` must always stay in the cache key: an app's `keepParams` allowlist
 * is extended with it and any `ignoreParams` entry that would drop it is removed (otherwise one representation could fill the other's entry).
 */
export function keepRscParam<T>(o: T): T {
  if (!o || typeof o !== "object") return o;
  const k = o as { keepParams?: string[]; ignoreParams?: string[] };
  if (!k.keepParams && !k.ignoreParams) return o;
  const out = { ...k };
  if (k.keepParams) out.keepParams = [...k.keepParams, "__rsc"];
  if (k.ignoreParams) out.ignoreParams = k.ignoreParams.filter((p) => { const l = p.toLowerCase(); return !(l.endsWith("*") ? "__rsc".startsWith(l.slice(0, -1)) : l === "__rsc"); });
  return out as T;
}
