import { Hono } from "hono";

// server/routes/** = non-API handlers mounted at their own URL (Worker-first, not under /api).
export default new Hono().get("/", (c) => c.body(`<?xml version="1.0"?><rss version="2.0"><channel><title>routes</title></channel></rss>`, 200, { "content-type": "application/rss+xml" }));
