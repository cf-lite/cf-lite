/**
 * `cf-lite seed`: load `seeds/*` into local D1/KV (or `--remote --yes`). Planning is pure (`planSeed`: files -> wrangler steps) so it is
 * unit-tested without spawning wrangler; `runSeed` executes the steps. Formats (docs/generators.md#seed):
 *   seeds/NAME.sql       -> `wrangler d1 execute <db> --file`
 *   seeds/NAME.d1.json   -> { "table", "rows": [{col: value}], "db"? } -> one `INSERT OR REPLACE` per row (re-runnable with a primary key)
 *   seeds/NAME.kv.json   -> { "binding", "entries": [{ "key", "value" (string or JSON), "expiration_ttl"? }] } -> `wrangler kv bulk put`
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, d1Config, parseFlags } from "./cli-db.js";

export interface SeedStep { file: string; kind: "d1-sql" | "d1-json" | "kv"; target: string; args: string[]; sql?: string; bulk?: string; rows: number }
export interface SeedPlan { ok: true; remote: boolean; steps: SeedStep[] }

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const sqlValue = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new CliError(`seed value ${v} is not a finite number`); return String(v); }
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${(typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/'/g, "''")}'`;
};

/** `{table, rows}` -> SQL. Column and table names are identifiers only (a seed file is data, never code). */
export function rowsToSql(table: string, rows: Record<string, unknown>[], file = "seed"): string {
  if (!IDENT.test(table)) throw new CliError(`${file}: table "${table}" is not a plain identifier`);
  return rows.map((r, i) => {
    const cols = Object.keys(r);
    if (!cols.length) throw new CliError(`${file}: row ${i} is empty`);
    for (const c of cols) if (!IDENT.test(c)) throw new CliError(`${file}: column "${c}" is not a plain identifier`);
    return `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => sqlValue(r[c])).join(", ")});`;
  }).join("\n") + "\n";
}

export function planSeed(dir: string, argv: string[]): SeedPlan {
  const f = parseFlags(argv);
  const only = f.positional[0];
  const sdir = join(dir, "seeds");
  if (!existsSync(sdir)) throw new CliError("no seeds/ folder here - add seeds/NAME.sql, NAME.d1.json or NAME.kv.json (or `cf-lite g api <name> --seed`)");
  if (f.remote && !f.yes) throw new CliError("refusing to seed the REMOTE database/KV without --yes.\n  Preview: cf-lite seed --remote --dry-run\n  Then:    cf-lite seed --remote --yes");
  const names = readdirSync(sdir).filter((n) => /\.(sql|json)$/.test(n) && (!only || n === only || n.replace(/\.(d1\.json|kv\.json|sql)$/, "") === only)).sort();
  if (!names.length) throw new CliError(only ? `no seed named "${only}" in seeds/` : "seeds/ has no *.sql, *.d1.json or *.kv.json");
  const scope = f.remote ? "--remote" : "--local";
  const steps: SeedStep[] = [];
  for (const n of names) {
    const rel = `seeds/${n}`;
    const text = readFileSync(join(sdir, n), "utf8");
    if (n.endsWith(".sql")) {
      const db = d1Config(dir, f).entry;
      steps.push({ file: rel, kind: "d1-sql", target: db.binding, args: ["d1", "execute", db.database_name ?? db.binding, scope, "--file", rel], rows: (text.match(/;/g) ?? []).length });
    } else if (n.endsWith(".d1.json")) {
      const j = parseSeedJson(text, rel);
      if (typeof j.table !== "string" || !Array.isArray(j.rows)) throw new CliError(`${rel}: expected { "table": "...", "rows": [ {...} ] }`);
      const db = d1Config(dir, { ...f, db: typeof j.db === "string" ? j.db : f.db }).entry;
      steps.push({ file: rel, kind: "d1-json", target: db.binding, args: ["d1", "execute", db.database_name ?? db.binding, scope, "--file", "<generated>"], sql: rowsToSql(j.table, j.rows as Record<string, unknown>[], rel), rows: j.rows.length });
    } else if (n.endsWith(".kv.json")) {
      const j = parseSeedJson(text, rel);
      if (typeof j.binding !== "string" || !Array.isArray(j.entries)) throw new CliError(`${rel}: expected { "binding": "KV", "entries": [ { "key", "value" } ] }`);
      const bulk = (j.entries as Record<string, unknown>[]).map((e, i) => {
        if (typeof e.key !== "string" || !e.key) throw new CliError(`${rel}: entry ${i} needs a string "key"`);
        return { ...e, value: typeof e.value === "string" ? e.value : JSON.stringify(e.value) };
      });
      steps.push({ file: rel, kind: "kv", target: j.binding, args: ["kv", "bulk", "put", "<generated>", "--binding", j.binding, scope], bulk: JSON.stringify(bulk), rows: bulk.length });
    } else throw new CliError(`${rel}: name it NAME.sql, NAME.d1.json or NAME.kv.json`);
  }
  if (f.env) for (const s of steps) s.args.push("--env", f.env);
  if (f.persistTo && !f.remote) for (const s of steps) s.args.push("--persist-to", f.persistTo);
  return { ok: true, remote: f.remote, steps };
}
function parseSeedJson(text: string, rel: string): Record<string, unknown> {
  try { const j = JSON.parse(text); if (j && typeof j === "object" && !Array.isArray(j)) return j; } catch (e) { throw new CliError(`${rel}: invalid JSON (${(e as Error).message})`); }
  throw new CliError(`${rel}: expected a JSON object`);
}

export const describeSeed = (p: SeedPlan): string[] => [
  ...(p.remote ? ["WARNING: REMOTE target"] : []),
  ...p.steps.map((s) => `${s.kind === "kv" ? "kv " : "d1 "} ${s.target}  <- ${s.file} (${s.rows} ${s.kind === "d1-sql" ? "statements" : s.kind === "kv" ? "entries" : "rows"})`),
];
export const seedJson = (p: SeedPlan, dryRun: boolean): string =>
  JSON.stringify({ ok: true, dryRun, remote: p.remote, steps: p.steps.map(({ file, kind, target, rows, sql, bulk }) => ({ file, kind, target, rows, ...(dryRun ? { sql, bulk: bulk ? JSON.parse(bulk) : undefined } : {}) })) }, null, 2);

/** Execute a plan; generated SQL/bulk files live in a temp dir that is always removed. Returns the first non-zero exit code. */
export function runSeed(plan: SeedPlan, spawnWrangler: (args: string[]) => number, log: (m: string) => void = console.log): number {
  const tmp = mkdtempSync(join(tmpdir(), "cfl-seed-"));
  try {
    mkdirSync(tmp, { recursive: true });
    for (const [i, s] of plan.steps.entries()) {
      const args = [...s.args];
      const gen = args.indexOf("<generated>");
      if (gen >= 0) { const p = join(tmp, `${i}-${s.kind === "kv" ? "bulk.json" : "seed.sql"}`); writeFileSync(p, s.kind === "kv" ? s.bulk! : s.sql!); args[gen] = p; }
      log(`seeding ${s.file} -> ${s.kind === "kv" ? "KV" : "D1"} ${s.target} (${plan.remote ? "REMOTE" : "local"})`);
      const code = spawnWrangler(args);
      if (code !== 0) return code;
    }
    return 0;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
