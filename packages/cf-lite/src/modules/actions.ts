/**
 * Server actions (`cf-lite/modules/actions`): a route file exports `actions = { save: async (formData, c) => ... }`;
 * `<form method="post" action="?/save">` POSTs to the page URL and `ssr()` runs the action in the Worker (see docs/actions.md).
 *
 * Return contract (no-JS and JS share it):
 *   throw redirect("/x")      -> 303 to /x   (the default 307 is upgraded to 303: the browser must GET the target)
 *   return fail(422, {...})   -> page re-rendered with that status; the component sees `data.actionData`
 *   return { ok: true }       -> page re-rendered (200) with `data.actionData`
 *   return undefined          -> 303 back to the same page (Post/Redirect/Get; reload never re-submits)
 *   return new Response(...)  -> sent as-is
 * JS mode (`x-cf-lite-action: 1`, set by `enhance()`) gets the same outcome as JSON `{ type, status, data?, location? }` with HTTP 200
 * (303 would be followed by fetch before the client could look at it).
 */
import type { Context } from "hono";
import { csrfResponse, csrfVerdict, type CsrfOptions } from "./csrf.js";
import { isNavigationSignal, signalStatus } from "../navigation.js";
import { typeAllowed, uploadStream, UploadError, type UploadLimits, type UploadResult } from "./r2.js";

export const ACTION_HEADER = "x-cf-lite-action";
export const DEFAULT_MAX_BODY = 4 * 1024 * 1024;

export class ActionFailure<T = unknown> {
  constructor(public status: number, public data: T) {}
}
/** Validation/business failure: re-render the page with `status` and expose `data` as `actionData`. */
export const fail = <T>(status: number, data: T): ActionFailure<T> => new ActionFailure(status, data);
export function isActionFailure(x: unknown): x is ActionFailure {
  // duck-typed too: a duplicated copy of this module (bundler dedupe miss) must still be recognised
  return x instanceof ActionFailure || (!!x && typeof x === "object" && (x as object).constructor?.name === "ActionFailure" && "status" in x && "data" in x);
}

export type ActionFn = (form: FormData, c: Context) => unknown | Promise<unknown>;
export type ActionMap = Record<string, ActionFn>;
export interface ActionConfig extends CsrfOptions {
  /** Cap on the request body (`Content-Length` and, if absent, the parsed size). Default 4 MiB: `formData()` buffers; use `uploadStream` routes for big files. */
  maxBodyBytes?: number;
}
export interface ActionsModule { actions?: ActionMap; actionConfig?: ActionConfig }

/** `?/save` -> "save"; `?/` or no key -> "default". Only the first `/`-prefixed key counts. */
export function actionName(url: URL): string {
  for (const k of url.searchParams.keys()) if (k.startsWith("/")) return k.slice(1) || "default";
  return "default";
}

/** Hooks `ssr()` provides so an action outcome can re-render the page it belongs to. */
export interface ActionHooks {
  rerender(actionData: unknown, status: number): Promise<Response>;
  recover(e: unknown): Promise<Response>;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const text = (status: number, msg: string) => new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
/** The page URL without the `?/name` key (other query params survive). */
function pageUrl(url: URL): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (k.startsWith("/")) u.searchParams.delete(k);
  return u.pathname + u.search;
}

const DRAIN_CAP = 16 * 1024 * 1024, DRAIN_MS = 5000;
/**
 * Read (and discard) what the client is still sending before answering a refused request. Answering while the body is unread can make
 * workerd / the dev proxy drop the connection ("Network connection lost" -> 500 or ECONNRESET, ~1 in 40 for a 5 MiB POST) instead of
 * delivering the 4xx. Bounded by bytes and time so a refusal never turns into an unbounded read; nothing is buffered.
 */
async function drain(req: Request): Promise<void> {
  if (!req.body || req.bodyUsed) return;
  const reader = req.body.getReader();
  let n = 0;
  const timer = new Promise<void>((r) => setTimeout(r, DRAIN_MS));
  const pump = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) return; if ((n += value.byteLength) > DRAIN_CAP) return; } })().catch(() => {});
  await Promise.race([pump, timer]);
  reader.releaseLock?.();
}

class BodyTooLarge extends Error {}
/** `req.formData()` with a hard byte cap on the stream itself (errors the stream past `max`, so nothing is buffered beyond it). */
async function cappedFormData(req: Request, max: number): Promise<FormData> {
  if (!req.body) return req.formData();
  let n = 0;
  const body = req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) { if ((n += chunk.byteLength) > max) ctl.error(new BodyTooLarge()); else ctl.enqueue(chunk); },
  }));
  try { return await new Response(body, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData(); }
  catch (e) { throw n > max ? new BodyTooLarge() : e; }
}

/** Run the action a POST to an SSR page names. Returns a Response; never throws. */
export async function handleAction(c: Context, mod: ActionsModule, hooks: ActionHooks): Promise<Response> {
  const cfg = mod.actionConfig ?? {};
  const req = c.req.raw;
  const wantsJson = req.headers.get(ACTION_HEADER) !== null;
  const v = csrfVerdict(req, cfg);
  if (!v.ok) { console.warn(`[cf-lite] action blocked ${new URL(req.url).pathname}: ${v.reason}`); await drain(req); return csrfResponse(v); }
  const url = new URL(req.url);
  const name = actionName(url);
  const actions = mod.actions!;
  const fn = Object.hasOwn(actions, name) ? actions[name] : undefined;
  if (typeof fn !== "function") return text(404, `No action "${name}" on this route`);
  const max = cfg.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) { await drain(req); return text(413, "Request body too large"); }
  // Content-Length is advisory (absent on chunked uploads, NaN or understated when a client lies): count the bytes actually read.
  let form: FormData;
  try { form = await cappedFormData(req, max); } catch (e) { return e instanceof BodyTooLarge ? text(413, "Request body too large") : text(400, "Malformed form body"); }

  const redirectTo = (location: string, status: number) =>
    wantsJson ? json({ type: "redirect", status, location }) : new Response(null, { status, headers: { location } });
  let result: unknown;
  try { result = await fn(form, c); } catch (e) {
    if (isNavigationSignal(e)) {
      if (e.kind === "redirect") return redirectTo(e.url!, e.status === 307 || e.status === 302 || e.status === 301 ? 303 : e.status!);
      return wantsJson ? json({ type: "error", status: signalStatus(e.kind) }) : hooks.recover(e);
    }
    if (e instanceof UploadError) return wantsJson ? json({ type: "failure", status: e.status, data: { error: e.message } }) : hooks.rerender({ error: e.message }, e.status);
    if (wantsJson) { console.error(`[cf-lite] action "${name}" failed`, e); return json({ type: "error", status: 500 }); }
    return hooks.recover(e);
  }
  if (result instanceof Response) return result;
  if (result === undefined) return redirectTo(pageUrl(url), 303);
  const failure = isActionFailure(result) ? result : undefined;
  const failed = !!failure;
  const status = failure ? failure.status : 200;
  const data = failure ? failure.data : result;
  if (wantsJson) return json({ type: failed ? "failure" : "success", status, data });
  return hooks.rerender(data, status);
}

/** Merge action output into what the page receives as `data` (adapters pass `data` through unchanged, including hydration). */
export function withActionData(loaderData: unknown, actionData: unknown): Record<string, unknown> {
  const plain = loaderData && typeof loaderData === "object" && !Array.isArray(loaderData);
  return plain ? { ...(loaderData as object), actionData } : { ...(loaderData === undefined ? {} : { data: loaderData }), actionData };
}

// ---------------------------------------------------------------- validation hook (Standard Schema: zod >= 3.24, valibot, arktype)
interface StandardSchemaV1<I = unknown, O = unknown> {
  readonly "~standard": { validate(v: unknown): { value: O; issues?: undefined } | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> } | Promise<any> };
  readonly __in?: I;
}
/** What a function validator returns: annotate it (`(i): Validation<T> => ...`) so `defineAction` infers the handler's value type. */
export type Validation<O> = { value: O } | { errors: Record<string, string[] | string> };
export type Validator<O> = StandardSchemaV1<unknown, O> | ((input: Record<string, unknown>) => Validation<O> | Promise<Validation<O>>);
export type FieldErrors = Record<string, string[]>;

const SECRET_FIELD = /pass|secret|token|card|cvv|otp/i;
/** FormData -> plain object: repeated keys (or `name[]`) become arrays; Files are kept as `File`. */
export function formToObject(form: FormData): Record<string, unknown> {
  const o: Record<string, unknown> = Object.create(null);
  for (const [k0, v] of form.entries()) {
    const multi = k0.endsWith("[]"), k = multi ? k0.slice(0, -2) : k0;
    if (k === "__proto__") continue;
    if (k in o) o[k] = [...(Array.isArray(o[k]) ? (o[k] as unknown[]) : [o[k]]), v];
    else o[k] = multi ? [v] : v;
  }
  return o;
}
const pathKey = (p: ReadonlyArray<PropertyKey | { key: PropertyKey }> | undefined) => (p ?? []).map((s) => String(typeof s === "object" ? s.key : s)).join(".") || "_form";

/**
 * Validate then run: `save: defineAction(schema, async (value, c) => ...)`. Invalid input never reaches the handler; the page is re-rendered
 * with status 422 and `actionData = { errors: { field: ["msg"] }, values }` (values: what the user typed, minus files and secret-looking fields).
 */
export function defineAction<O>(validator: Validator<O>, handler: (value: O, c: Context, form: FormData) => unknown | Promise<unknown>, opts: { status?: number } = {}): ActionFn {
  return async (form, c) => {
    const input = formToObject(form);
    let errors: FieldErrors | undefined, value: O | undefined;
    if (typeof validator === "function") {
      const r = await validator(input);
      if ("errors" in r) errors = Object.fromEntries(Object.entries(r.errors).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
      else value = r.value;
    } else {
      const r = await validator["~standard"].validate(input);
      if (r.issues) { errors = {}; for (const i of r.issues) (errors[pathKey(i.path)] ??= []).push(i.message); }
      else value = r.value as O;
    }
    if (errors) {
      const values = Object.fromEntries(Object.entries(input).filter(([k, v]) => !SECRET_FIELD.test(k) && !(v instanceof File)));
      return fail(opts.status ?? 422, { errors, values });
    }
    return handler(value as O, c, form);
  };
}

// ---------------------------------------------------------------- file upload hand-off to R2
export interface SaveUploadOptions extends Partial<UploadLimits> { customMetadata?: Record<string, string> }
/**
 * Store one `File` from the form in R2 (size/type limits, optional magic-byte sniffing). Throws `UploadError`, which an action may let
 * escape: it is turned into a re-render with `actionData = { error }` and the matching status (413/415/400).
 * `formData()` has already buffered the file (bounded by `maxBodyBytes`); for large files use an `uploadStream` route instead.
 */
export async function saveUpload(bucket: R2Bucket, file: unknown, key: string, o: SaveUploadOptions = {}): Promise<UploadResult> {
  if (!(file instanceof File) || file.size === 0) throw new UploadError(400, "no file selected");
  if (!typeAllowed(file.type, o.allowTypes)) throw new UploadError(415, `content type ${file.type || "unknown"} not allowed`);
  const headers = new Headers({ "content-type": file.type || "application/octet-stream", "content-length": String(file.size) });
  return uploadStream(bucket, key, { body: file.stream(), headers }, { maxBytes: o.maxBytes ?? DEFAULT_MAX_BODY, allowTypes: o.allowTypes, sniff: o.sniff, customMetadata: { filename: file.name, ...o.customMetadata } });
}
