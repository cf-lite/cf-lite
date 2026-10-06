import type { MiddlewareHandler } from "hono";

// Runs only for these paths. Each entry also becomes an `assets.run_worker_first` glob (negatives as `!` globs), so every
// other path - `/`, `/admin/public/*`, hashed assets - is served by Cloudflare without invoking the Worker at all.
export const config = { matcher: ["/admin/:path*", "/api/private/:path*", "!/admin/public/:path*"] };

const gate: MiddlewareHandler = async (c, next) => {
  console.log("[mw]", c.req.path);
  if (!/(?:^|;\s*)sess=ok(?:;|$)/.test(c.req.header("cookie") ?? "")) return c.text("sign in first", 401);
  c.header("x-gated", "1");
  await next();
};
export default gate;
