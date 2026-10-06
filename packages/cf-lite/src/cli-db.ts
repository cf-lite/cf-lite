/**
 * `cf-lite db new|apply|status` (D1 migrations over `wrangler d1 migrations`) and `cf-lite add d1|kv|r2|hyperdrive`
 * (binding edits through the comment-preserving wrangler editor). Planning is pure (`planDb`) so it is unit-tested
 * without spawning wrangler.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addToArray, parseJsonc } from "./wrangler-edit.js";

export const STORAGE_KINDS = ["d1", "kv", "r2", "hyperdrive"] as const;
export type StorageKind = (typeof STORAGE_KINDS)[number];
export const isStorageKind = (s: string): s is StorageKind => (STORAGE_KINDS as readonly string[]).includes(s);

export class CliError extends Error {}

const CONFIG_FILES = ["wrangler.jsonc", "wrangler.json"];
export function findWranglerConfig(dir: string): string | null {
  return CONFIG_FILES.map((f) => join(dir, f)).find((f) => existsSync(f)) ?? null;
}

export interface Flags { positional: string[]; remote: boolean; yes: boolean; db?: string; env?: string; persistTo?: string; binding?: string; name?: string; rest: string[] }
export function parseFlags(args: string[]): Flags {
  const f: Flags = { positional: [], remote: false, yes: false, rest: [] };
  const val = (i: number, flag: string) => { const v = args[i + 1]; if (v === undefined || v.startsWith("--")) throw new CliError(`${flag} needs a value`); return v; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--remote") f.remote = true;
    else if (a === "--local") f.remote = false;
    else if (a === "--yes" || a === "-y") f.yes = true;
    else if (a === "--db") f.db = val(i++, a);
    else if (a === "--env") f.env = val(i++, a);
    else if (a === "--persist-to") f.persistTo = val(i++, a);
    else if (a === "--binding") f.binding = val(i++, a);
    else if (a === "--name") f.name = val(i++, a);
    else if (a.startsWith("--")) f.rest.push(a);
    else f.positional.push(a);
  }
  return f;
}

export interface DbPlan { action: "new"; file: string; content: string }
export interface DbRun { action: "wrangler"; args: string[]; remote: boolean }

interface D1Entry { binding: string; database_name?: string; migrations_dir?: string }
export function d1Config(dir: string, f: Flags) {
  const file = findWranglerConfig(dir);
  if (!file) throw new CliError("no wrangler.jsonc/wrangler.json here - run it in your app directory (wrangler.toml is not supported by `cf-lite db`)");
  const cfg = parseJsonc<any>(readFileSync(file, "utf8"));
  const scope = f.env && cfg.env?.[f.env] ? { ...cfg, ...cfg.env[f.env] } : cfg;
  const list: D1Entry[] = scope.d1_databases ?? [];
  if (!list.length) throw new CliError("no d1_databases in the wrangler config - `cf-lite add d1` adds one");
  const sel = f.db ? list.find((d) => d.binding === f.db || d.database_name === f.db) : list.length === 1 ? list[0] : undefined;
  if (!sel) throw new CliError(f.db ? `no D1 database "${f.db}" (have: ${list.map((d) => d.binding).join(", ")})` : `several D1 databases (${list.map((d) => d.binding).join(", ")}) - pass --db <binding>`);
  return { entry: sel, dirName: sel.migrations_dir ?? "migrations" };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Next migration number, from the highest `NNNN_` prefix on disk (gaps are fine, reuse never happens). */
export function nextMigrationNumber(files: string[]): string {
  const max = files.reduce((m, f) => Math.max(m, Number(/^(\d+)_/.exec(f)?.[1] ?? 0)), 0);
  return String(max + 1).padStart(4, "0");
}

/**
 * Turn `db <sub> ...` into either a file to create or a wrangler invocation. Throws `CliError` for refusals,
 * notably `apply --remote` without `--yes` (a remote migration changes live data and cannot be undone).
 */
export function planDb(dir: string, argv: string[]): DbPlan | DbRun {
  const [sub, ...rest] = argv;
  const f = parseFlags(rest);
  if (sub === "new") {
    const name = slug(f.positional.join("_"));
    if (!name) throw new CliError("usage: cf-lite db new <name>");
    const { dirName } = d1Config(dir, f);
    const mdir = join(dir, dirName);
    const n = nextMigrationNumber(existsSync(mdir) ? readdirSync(mdir) : []);
    return { action: "new", file: join(mdir, `${n}_${name}.sql`), content: `-- Migration ${n}: ${name.replace(/_/g, " ")}\n-- Applied once, in order, by \`cf-lite db apply\`. Never edit a migration that has shipped; add a new one.\n\n` };
  }
  if (sub === "apply" || sub === "status") {
    const { entry } = d1Config(dir, f);
    if (sub === "apply" && f.remote && !f.yes) {
      throw new CliError("refusing to apply migrations to the REMOTE database without --yes.\n  Review first: cf-lite db status --remote\n  Then:         cf-lite db apply --remote --yes");
    }
    const target = entry.database_name ?? entry.binding;
    const args = ["d1", "migrations", sub === "apply" ? "apply" : "list", target, f.remote ? "--remote" : "--local"];
    if (f.env) args.push("--env", f.env);
    if (f.persistTo && !f.remote) args.push("--persist-to", f.persistTo);
    // wrangler's own confirmation prompt is what `--yes` replaces: we have already gated on it above
    return { action: "wrangler", args, remote: f.remote };
  }
  throw new CliError("usage: cf-lite db <new <name>|apply [--remote --yes]|status [--remote]> [--db <binding>] [--env <name>]");
}

/** Execute a plan. `spawn` is injected by the caller (cli.ts owns wrangler resolution). Returns the exit code. */
export function runDb(dir: string, argv: string[], spawnWrangler: (args: string[]) => number, log: (m: string) => void = console.log): number {
  const plan = planDb(dir, argv);
  if (plan.action === "new") {
    mkdirSync(join(plan.file, ".."), { recursive: true });
    writeFileSync(plan.file, plan.content, { flag: "wx" });
    log(`created ${plan.file.replace(dir + "/", "")}`);
    return 0;
  }
  if (plan.remote) log("WARNING: operating on the REMOTE database");
  return spawnWrangler(plan.args);
}

// ---------------------------------------------------------------- cf-lite add d1|kv|r2|hyperdrive
const DEFAULTS: Record<StorageKind, { binding: string; key: string; idKey: string }> = {
  d1: { binding: "DB", key: "d1_databases", idKey: "binding" },
  kv: { binding: "KV", key: "kv_namespaces", idKey: "binding" },
  r2: { binding: "BUCKET", key: "r2_buckets", idKey: "binding" },
  hyperdrive: { binding: "HYPERDRIVE", key: "hyperdrive", idKey: "binding" },
};
export interface AddStorageOptions { binding?: string; name?: string; log?: (m: string) => void }

/** Add a binding to wrangler.jsonc (idempotent, comments preserved). IDs are left out: `wrangler deploy` provisions d1/kv/r2 on first deploy. */
export function addStorage(dir: string, kind: StorageKind, o: AddStorageOptions = {}): { changed: boolean; file: string } {
  const log = o.log ?? (() => {});
  const file = findWranglerConfig(dir);
  if (!file) throw new CliError(existsSync(join(dir, "wrangler.toml")) ? "wrangler.toml is not supported by `cf-lite add`; add the binding by hand (see docs/storage.md)" : "no wrangler.jsonc here - run it in your app directory");
  const d = DEFAULTS[kind];
  const binding = o.binding ?? d.binding;
  if (!/^[A-Z][A-Z0-9_]*$/.test(binding)) throw new CliError(`binding "${binding}" must be UPPER_SNAKE_CASE`);
  let appName = "app";
  const text = readFileSync(file, "utf8");
  try { appName = parseJsonc<any>(text).name ?? appName; } catch { /* reported by addToArray */ }
  const resource = o.name ?? `${appName}-${kind === "d1" ? "db" : kind === "kv" ? "kv" : "uploads"}`;
  const item: Record<string, unknown> =
    kind === "d1" ? { binding, database_name: resource }
    : kind === "kv" ? { binding }
    : kind === "r2" ? { binding, bucket_name: resource }
    : { binding, id: "REPLACE_WITH_HYPERDRIVE_CONFIG_ID" };
  const r = addToArray(text, d.key, item, d.idKey);
  if (r.changed) writeFileSync(file, r.text);
  log(r.changed ? `added ${kind} binding ${binding} to ${file.replace(dir + "/", "")}` : `${kind} binding ${binding} already present - nothing changed`);
  if (r.changed) {
    if (kind === "hyperdrive") log(`next: bunx wrangler hyperdrive create ${resource} --connection-string=<postgres url>, paste the id into the config; for dev set CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`);
    else if (kind === "d1") log("next: cf-lite db new init, write the SQL, cf-lite db apply (local). The database is created on first `cf-lite deploy`.");
    else log("the resource is created on first `cf-lite deploy` (wrangler auto-provisioning); local dev works immediately.");
  }
  return { changed: r.changed, file };
}
