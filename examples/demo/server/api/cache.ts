import { Hono } from "hono";
import { cachePurge } from "cf-lite/modules/cache";

// POST /api/cache/purge  { "tags": ["posts"], "paths": ["/cached/1"] }  with  Authorization: Bearer $CACHE_PURGE_TOKEN
// (set it with `wrangler secret put CACHE_PURGE_TOKEN`; without it the endpoint answers 503 and purges nothing).
// From your own API routes / webhooks call purgeTags(c.env, [...]) / purgePaths(c.env, [...]) instead - see docs/caching.md.
export default new Hono<{ Bindings: Env }>().post("/purge", cachePurge());
