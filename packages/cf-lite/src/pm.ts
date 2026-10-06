import { existsSync } from "node:fs";
import { join } from "node:path";

/** Package manager for `cfl add` / `cfl init` installs: the app's lockfile wins, then whatever is running us (Bun first), then npm. */
export function detectPm(dir: string): "bun" | "pnpm" | "yarn" | "npm" {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  const ua = process.env.npm_config_user_agent ?? "";
  if (process.versions.bun || ua.startsWith("bun")) return "bun";
  return ua.startsWith("pnpm") ? "pnpm" : ua.startsWith("yarn") ? "yarn" : "npm";
}
