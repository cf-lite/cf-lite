/**
 * Test-only login bypass for Playwright/e2e runs. **Inert unless `env.E2E_LOGIN_SECRET` is set** (a Worker secret
 * you only ever set on a preview/test deployment): with no secret the route is a plain 404, so shipping it is safe.
 *
 *   app.route("/__e2e", e2eLogin({ issue: (c, who) => setSessionCookie(c, who) }));
 *   // e2e:  POST /__e2e/login   header x-e2e-secret: <secret>   body {"user":"qa"}
 *
 * `issue` is yours (session cookie, SSO token, ...): it gets the Hono context + the requested user and returns a Response
 * (or nothing, for a plain 204). Comparison is constant-time.
 */
import { Hono, type Context } from "hono";

export interface E2eLoginOptions {
  issue(c: Context, who: { user: string }): Response | void | Promise<Response | void>;
  /** Default: "x-e2e-secret". */
  header?: string;
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder(), x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

export function e2eLogin(opts: E2eLoginOptions) {
  return new Hono<{ Bindings: { E2E_LOGIN_SECRET?: string } }>().post("/login", async (c) => {
    const secret = c.env?.E2E_LOGIN_SECRET;
    if (!secret) return c.notFound(); // module off
    if (!safeEqual(c.req.header(opts.header ?? "x-e2e-secret") ?? "", secret)) return c.json({ error: "forbidden" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { user?: string };
    const res = await opts.issue(c, { user: body.user ?? "e2e" });
    return res ?? c.body(null, 204);
  });
}
