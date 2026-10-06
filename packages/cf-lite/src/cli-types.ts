/** `cf-lite types` / `cf-lite prepare`: `Env` from the wrangler config (`wrangler types`) next to the generated route types (docs/typegen.md). */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { findWranglerConfig } from "./cli-db.js";
import type { Wrangler } from "./cli-deploy.js";

/** Where the generated `Env` lives: inside `.cf-lite/`, which every cf-lite tsconfig already includes. */
export const ENV_TYPES_FILE = ".cf-lite/worker-configuration.d.ts";

/** Arguments for `wrangler types`: bindings + vars only - runtime types stay with `@cloudflare/workers-types` (no duplicate-declaration clash). */
export function envTypesArgs(root: string, opts: { env?: string; check?: boolean } = {}): string[] | null {
  const cfg = findWranglerConfig(root);
  if (!cfg) return null;
  return ["types", ENV_TYPES_FILE, "--config", cfg, "--include-runtime=false", "--strict-vars=false", ...(opts.env ? ["--env", opts.env] : []), ...(opts.check ? ["--check"] : [])];
}

/** Generate (or with `check`, verify) the Env types. Returns the wrangler exit code; 0 and a note when the app has no wrangler config. */
export function syncEnvTypes(root: string, wrangler: Wrangler, log: (m: string) => void, opts: { env?: string; check?: boolean } = {}): number {
  const args = envTypesArgs(root, opts);
  if (!args) { log("no wrangler config here - skipping Env types"); return 0; }
  mkdirSync(join(root, ".cf-lite"), { recursive: true });
  const r = wrangler(args, { capture: true });
  if (r.code === 0 && !opts.check) log(`Env types -> ${join(".", ENV_TYPES_FILE)}`);
  return r.code;
}
