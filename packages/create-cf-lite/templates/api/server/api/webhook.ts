import { Hono } from "hono";

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const eq = (a: string, b: string) => { // constant-time compare
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/**
 * POST /api/webhook with `x-signature: hex(HMAC-SHA256(WEBHOOK_SECRET, rawBody))`. Verify -> do little -> 200, so the sender never waits
 * (enqueue real work with `cf-lite add queue <name>`). Fails closed while WEBHOOK_SECRET is unset.
 */
export default new Hono<{ Bindings: Env }>().post("/", async (c) => {
  const secret = c.env.WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "webhook not configured" }, 503);
  const raw = await c.req.text();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  if (!eq(sig, c.req.header("x-signature") ?? "")) return c.json({ error: "bad signature" }, 401);
  return c.json({ ok: true });
});
