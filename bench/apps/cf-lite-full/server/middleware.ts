import type { MiddlewareHandler } from "hono";

// Only /api reaches the Worker anyway (redirect + static pages stay on the assets layer). /api/private/* is gated, /api/hello is public.
export const config = { matcher: ["/api/:path*"] };

const gate: MiddlewareHandler = async (c, next) => {
  if (c.req.path.startsWith("/api/private/") && !/(?:^|;\s*)(?:__Host-)?session=/.test(c.req.header("cookie") ?? "")) return c.text("sign in first", 401);
  c.header("x-gated", "1");
  await next();
};
export default gate;
