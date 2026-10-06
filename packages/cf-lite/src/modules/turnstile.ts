/**
 * OPTIONAL module. Cloudflare Turnstile server-side verification. Fails CLOSED: missing secret, missing token, network
 * error, bad JSON, or `success:false` all reject.
 *
 *   app.post("/signup", turnstile(), handler);            // reads `cf-turnstile-response` from form/json/header; env TURNSTILE_SECRET
 *   const ok = await verifyTurnstile(token, { secret, ip })
 *
 * Dev/test: Cloudflare's dummy keys (TURNSTILE_TEST). Site key `1x00000000000000000000AA` + secret `1x0000000000000000000000000000000AA` always pass;
 * `2x...` always fail. Real keys come from the Cloudflare dashboard - not created by cf-lite.
 */
import type { MiddlewareHandler } from "hono";

export const TURNSTILE_TEST = {
  siteKeyPass: "1x00000000000000000000AA", siteKeyFail: "2x00000000000000000000AB",
  secretPass: "1x0000000000000000000000000000000AA", secretFail: "2x0000000000000000000000000000000AA",
} as const;
const ENDPOINT = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult { success: boolean; "error-codes"?: string[]; hostname?: string; action?: string; cdata?: string; challenge_ts?: string }
export interface VerifyOptions { secret?: string; ip?: string; idempotencyKey?: string; expectedAction?: string; expectedHostname?: string; fetch?: typeof fetch; endpoint?: string; timeoutMs?: number }

export async function verifyTurnstile(token: string | null | undefined, o: VerifyOptions): Promise<{ ok: boolean; reason?: string; result?: TurnstileResult }> {
  if (!o.secret) return { ok: false, reason: "secret-not-configured" };
  if (!token || typeof token !== "string" || token.length > 2048) return { ok: false, reason: "missing-token" };
  const body = new FormData();
  body.set("secret", o.secret); body.set("response", token);
  if (o.ip) body.set("remoteip", o.ip);
  if (o.idempotencyKey) body.set("idempotency_key", o.idempotencyKey);
  try {
    const r = await (o.fetch ?? fetch)(o.endpoint ?? ENDPOINT, { method: "POST", body, signal: AbortSignal.timeout(o.timeoutMs ?? 5000) });
    if (!r.ok) return { ok: false, reason: `siteverify-${r.status}` };
    const j = (await r.json()) as TurnstileResult;
    if (j?.success !== true) return { ok: false, reason: (j?.["error-codes"] ?? ["rejected"]).join(","), result: j };
    if (o.expectedAction && j.action !== o.expectedAction) return { ok: false, reason: "action-mismatch", result: j };
    if (o.expectedHostname && j.hostname !== o.expectedHostname) return { ok: false, reason: "hostname-mismatch", result: j };
    return { ok: true, result: j };
  } catch { return { ok: false, reason: "siteverify-unreachable" }; }
}

export interface TurnstileMiddlewareOptions extends Omit<VerifyOptions, "secret" | "ip"> { field?: string; header?: string }
/** Hono middleware: 403 JSON unless the widget token verifies (503 when the secret is not configured - never silently skipped). */
export const turnstile = (o: TurnstileMiddlewareOptions = {}): MiddlewareHandler<{ Bindings: { TURNSTILE_SECRET?: string } }> => async (c, next) => {
  const secret = c.env?.TURNSTILE_SECRET;
  if (!secret) return c.json({ error: "turnstile not configured" }, 503);
  let token = c.req.header(o.header ?? "cf-turnstile-response");
  if (!token) {
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("json")) token = ((await c.req.raw.clone().json().catch(() => ({}))) as Record<string, unknown>)[o.field ?? "cf-turnstile-response"] as string | undefined;
    else if (ct.includes("form")) token = String((await c.req.raw.clone().formData().catch(() => new FormData())).get(o.field ?? "cf-turnstile-response") ?? "") || undefined;
  }
  const v = await verifyTurnstile(token, { ...o, secret, ip: c.req.header("cf-connecting-ip") });
  if (!v.ok) return c.json({ error: "turnstile failed", reason: v.reason }, 403);
  await next();
};

const esc = (s: string) => s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!);
/** HTML for the client widget (script + container). Put it inside the `<form>`; the widget adds the hidden `cf-turnstile-response` input. */
export function turnstileWidget(siteKey: string, o: { action?: string; theme?: "auto" | "light" | "dark" } = {}): string {
  return `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><div class="cf-turnstile" data-sitekey="${esc(siteKey)}"${o.action ? ` data-action="${esc(o.action)}"` : ""} data-theme="${o.theme ?? "auto"}"></div>`;
}
