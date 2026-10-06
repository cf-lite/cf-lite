/**
 * Node-side vitest config preset for cf-lite apps (runs in vitest.config.ts, NOT inside workerd).
 *
 *   // vitest.config.ts
 *   import { cfLiteTest } from "@cf-lite/testing/config";
 *   export default cfLiteTest({ migrations: "./migrations" });
 *
 * It reads the same wrangler config your app deploys with (bindings, DOs, crons all come from it), runs the tests inside
 * workerd via @cloudflare/vitest-pool-workers, exposes your D1 migrations to `applyMigrations()`, and registers the
 * per-test storage reset from `@cf-lite/testing/setup`.
 *
 * Needs `cf-lite prepare` to have generated `.cf-lite/app` (your worker imports it) - wire it as `"pretest"`.
 */
import { defineConfig, type ViteUserConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

/** Nearest `node_modules/<name>` dir above `from` (exports maps can block resolving package.json, so walk the tree). */
function findPkg(name: string, from: string): string | undefined {
  for (let d = dirname(from); ; d = dirname(d)) {
    const p = join(d, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return p;
    if (dirname(d) === d) return undefined;
  }
}
/** `workerd` version the pool's miniflare will actually run, as a compat date ("2026-08-15"), or undefined if unknown. */
function workerdDate(): string | undefined {
  try {
    const pool = fileURLToPath(import.meta.resolve("@cloudflare/vitest-pool-workers"));
    const mf = findPkg("miniflare", pool), wd = mf && findPkg("workerd", join(mf, "x"));
    if (!wd) return undefined;
    const d = (JSON.parse(readFileSync(join(wd, "package.json"), "utf8")) as { version: string }).version.split(".")[1];
    return d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : undefined;
  } catch { return undefined; }
}
/** compatibility_date from a wrangler.jsonc/json (comments tolerated); undefined for toml/unreadable. */
function configDate(path: string): string | undefined {
  if (!existsSync(path) || /\.toml$/.test(path)) return undefined;
  const txt = readFileSync(path, "utf8").replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, str) => str ?? "");
  return /"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(txt)?.[1];
}

export interface CfLiteTestOptions {
  /** Path to the wrangler config. Default "./wrangler.jsonc". */
  wrangler?: string;
  /** Wrangler environment to load (`--env`). */
  environment?: string;
  /** D1 migrations directory (relative to cwd). When set, `TEST_MIGRATIONS` is bound and `applyMigrations()` works. */
  migrations?: string;
  /** Extra plain-text bindings (vars/secrets) for tests only, e.g. `{ E2E_LOGIN_SECRET: "test" }`. */
  bindings?: Record<string, string>;
  /** Force the test runtime's compatibility date (default: the wrangler one, clamped to what the pool's workerd supports). */
  compatibilityDate?: string;
  /** Test file globs. Default `["test/**\/*.test.ts"]`. */
  include?: string[];
  /** Reset KV/R2/D1/DO state before every test (default true). Set false to keep state across a file. */
  isolateStorage?: boolean;
  /** Escape hatch: merged over the vitest config. */
  vitest?: ViteUserConfig;
}

export async function cfLiteTest(opts: CfLiteTestOptions = {}): Promise<ViteUserConfig> {
  const migrations = opts.migrations ? await readD1Migrations(resolve(opts.migrations)) : [];
  const setup = fileURLToPath(import.meta.resolve("@cf-lite/testing/setup"));
  // The pool ships its own (often older) workerd: clamp a newer compatibility_date instead of failing to boot.
  const wranglerPath = resolve(opts.wrangler ?? "./wrangler.jsonc");
  const have = workerdDate(), want = configDate(wranglerPath);
  const compatibilityDate = opts.compatibilityDate ?? (have && want && want > have ? have : undefined);
  if (compatibilityDate && want && compatibilityDate < want)
    console.warn(`[cf-lite/testing] wrangler compatibility_date ${want} is newer than the test runtime's workerd (${have}); testing with ${compatibilityDate}.`);
  const bindings = { ...opts.bindings, TEST_MIGRATIONS: migrations as unknown as string, CF_LITE_TEST_ISOLATE: String(opts.isolateStorage ?? true) };
  return defineConfig({
    ...opts.vitest,
    plugins: [
      cloudflareTest({
        wrangler: { configPath: opts.wrangler ?? "./wrangler.jsonc", environment: opts.environment },
        miniflare: { bindings, ...(compatibilityDate ? { compatibilityDate } : {}) },
      }),
      ...((opts.vitest?.plugins as never[]) ?? []),
    ],
    test: { include: opts.include ?? ["test/**/*.test.ts"], setupFiles: [setup], ...opts.vitest?.test },
  }) as ViteUserConfig;
}
