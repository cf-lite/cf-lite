/**
 * `updateTag(tags)` for server actions of `render = "rsc"` routes (docs/caching.md "Read-your-writes"): purge the cache tags (like `purgeTags`) and
 * queue the read-your-writes cookie onto the action's response. Its own module so RSC apps that never call it do not carry the cache module.
 *
 *   "use server";
 *   import { updateTag } from "cf-lite/modules/rsc-update";
 *   export async function save(form: FormData) { await write(form); await updateTag(["posts"]); }
 */
import { getRequest } from "./rsc-server.js";
import { purgeTags, updateCookieHeader } from "./cache.js";

export async function updateTag(tags: string | string[]): Promise<void> {
  const r = getRequest();
  const out = await purgeTags(r.env as never, tags);
  r.cookies?.push(updateCookieHeader(r.req.url, out.purgedAt));
}
