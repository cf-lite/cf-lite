import { hc } from "hono/client";
import type { ApiType } from "../.cf-lite/app";

export const api = hc<ApiType>("/api");
