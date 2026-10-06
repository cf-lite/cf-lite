import { hc } from "hono/client";
import type { ApiType } from "../.cf-lite/app";

/** End-to-end typed client: no codegen step, the types come from the generated (real .ts) app. */
export const api = hc<ApiType>("/api");
