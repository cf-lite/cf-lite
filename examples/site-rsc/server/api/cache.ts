import { Hono } from "hono";
import { cachePurge } from "cf-lite/modules/cache";

export default new Hono<{ Bindings: Env }>().post("/purge", cachePurge());
