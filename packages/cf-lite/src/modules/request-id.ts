/** Request id shared by logging, errors and SSR digests (kept tiny: `ssr()` imports it). */
import type { Context } from "hono";

const ID_OK = /^[A-Za-z0-9._:-]{8,64}$/;
/** Request id: a well-formed inbound `x-request-id`, else `cf-ray`, else a UUID. Stable for the request once `logging()` ran. */
export function requestId(c: Context | Request): string {
  const held = (c as Context).get?.("requestId") as string | undefined;
  if (held) return held;
  const h = ((c as Context).req?.raw ?? (c as Request)).headers;
  const inbound = h.get("x-request-id");
  if (inbound && ID_OK.test(inbound)) return inbound;
  return h.get("cf-ray") || crypto.randomUUID();
}
