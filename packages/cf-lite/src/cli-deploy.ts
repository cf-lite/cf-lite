/**
 * `cf-lite deploy [--env x] [--gradual 10,50,100] [--preview-alias pr-7] [--dry-run]`, `cf-lite secrets push`,
 * `cf-lite add placement`. Planning and the rollout state machine are pure/injectable (`Wrangler`, `fetch`, `sleep`),
 * so the dry-run plan, the health gate and the rollback path are unit-tested with a mocked wrangler.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, findWranglerConfig } from "./cli-db.js";
import { parseJsonc } from "./wrangler-edit.js";

export interface DeployFlags {
  env?: string;
  gradual?: number[];
  previewAlias?: string;
  dryRun: boolean;
  message?: string;
  healthUrl?: string;
  /** Seconds to watch each partial step before promoting (default 30). */
  soak: number;
  /** Probe interval in seconds (default 5). */
  interval: number;
  /** Max tolerated failing probes per step (default 0). */
  maxFailures: number;
  rest: string[];
}

export function parseDeployFlags(args: string[]): DeployFlags {
  const f: DeployFlags = { dryRun: false, soak: 30, interval: 5, maxFailures: 0, rest: [] };
  const val = (i: number, flag: string) => { const v = args[i + 1]; if (v === undefined || v.startsWith("--")) throw new CliError(`${flag} needs a value`); return v; };
  const num = (s: string, flag: string) => { const n = Number(s); if (!Number.isFinite(n) || n < 0) throw new CliError(`${flag} needs a non-negative number`); return n; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--env") f.env = val(i++, a);
    else if (a === "--gradual") f.gradual = parseSteps(val(i++, a));
    else if (a === "--preview-alias") f.previewAlias = val(i++, a);
    else if (a === "--dry-run") f.dryRun = true;
    else if (a === "--message") f.message = val(i++, a);
    else if (a === "--health-url") f.healthUrl = val(i++, a);
    else if (a === "--soak") f.soak = num(val(i++, a), a);
    else if (a === "--interval") f.interval = num(val(i++, a), a);
    else if (a === "--max-failures") f.maxFailures = num(val(i++, a), a);
    else f.rest.push(a);
  }
  if (f.gradual && f.previewAlias) throw new CliError("--gradual and --preview-alias are exclusive (a preview never takes production traffic)");
  if (f.previewAlias && !/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/.test(f.previewAlias)) throw new CliError("--preview-alias must be a lowercase DNS label, e.g. pr-12");
  return f;
}

/** "10,50,100" -> [10,50,100]; strictly ascending integers in 1..100; 100 is appended when missing. */
export function parseSteps(s: string): number[] {
  const steps = s.split(",").map((x) => Number(x.trim()));
  if (!steps.length || steps.some((n) => !Number.isInteger(n) || n < 1 || n > 100)) throw new CliError("--gradual takes integer percentages 1-100, e.g. 10,50,100");
  for (let i = 1; i < steps.length; i++) if (steps[i] <= steps[i - 1]) throw new CliError("--gradual percentages must be strictly ascending");
  if (steps[steps.length - 1] !== 100) steps.push(100);
  return steps;
}

// ---------- preview safety ----------

/** Binding keys whose resources must never be shared between production and a preview. */
const BINDING_KEYS: Record<string, string[]> = {
  d1_databases: ["database_id", "database_name"],
  kv_namespaces: ["id"],
  r2_buckets: ["bucket_name"],
  hyperdrive: ["id"],
  queues: ["queue"],
  vectorize: ["index_name"],
  services: ["service"],
  durable_objects: ["class_name"],
};

/**
 * Problems that would let the preview Worker reach production data. Wrangler does not inherit bindings into `env.*`, so
 * a preview env with no bindings is *isolated but probably broken* (warning); one that re-declares a production
 * resource id/name is a hard error. Also errors when the env block does not exist (a bare upload would target prod).
 */
export function checkPreviewConfig(cfg: any, env: string | undefined): { errors: string[]; warnings: string[] } {
  const errors: string[] = []; const warnings: string[] = [];
  if (!env) { errors.push("preview deploys need --env <name> (a preview must not use the top-level/production environment)"); return { errors, warnings }; }
  const scope = cfg?.env?.[env];
  if (!scope) { errors.push(`wrangler config has no env.${env} block - add one with its own (non-production) bindings`); return { errors, warnings }; }
  if (scope.name === undefined && cfg.name) warnings.push(`env.${env} has no "name"; wrangler will suffix the production name (${cfg.name}-${env})`);
  for (const [key, ids] of Object.entries(BINDING_KEYS)) {
    const prod: any[] = Array.isArray(cfg[key]) ? cfg[key] : [];
    const prev: any[] = Array.isArray(scope[key]) ? scope[key] : [];
    if (key === "durable_objects") continue; // class bindings are code-level, not data
    for (const p of prev) for (const idKey of ids) {
      if (p?.[idKey] !== undefined && prod.some((x) => x?.[idKey] === p[idKey])) errors.push(`env.${env}.${key}[${p.binding ?? p.queue ?? "?"}] reuses production ${idKey} - give the preview its own resource`);
    }
    if (prod.length && !prev.length) warnings.push(`env.${env} declares no ${key} (production has ${prod.length}); the preview runs without that binding`);
  }
  for (const k of ["routes", "route", "custom_domain"]) if (scope[k] !== undefined) errors.push(`env.${env}.${k}: a preview must not claim routes/domains`);
  if (scope.triggers?.crons?.length) warnings.push(`env.${env} has cron triggers; previews would run scheduled jobs - remove them`);
  return { errors, warnings };
}

// ---------- plan ----------

export interface Step { label: string; args: string[] }
export type DeployPlan =
  | { kind: "plain"; steps: Step[] }
  | { kind: "preview"; steps: Step[]; alias: string }
  | { kind: "gradual"; upload: Step; percentages: number[]; env?: string; message: string };

const envArgs = (env?: string) => (env ? ["--env", env] : []);

export function planDeploy(f: DeployFlags): DeployPlan {
  const message = f.message ?? "cf-lite gradual deploy";
  if (f.previewAlias) {
    return { kind: "preview", alias: f.previewAlias, steps: [{ label: `upload preview version as alias ${f.previewAlias}`, args: ["versions", "upload", ...envArgs(f.env), "--preview-alias", f.previewAlias, "--message", f.message ?? `preview ${f.previewAlias}`, ...f.rest] }] };
  }
  if (f.gradual) {
    return { kind: "gradual", env: f.env, message, percentages: f.gradual, upload: { label: "upload new version (0% traffic)", args: ["versions", "upload", ...envArgs(f.env), "--message", message, ...f.rest] } };
  }
  return { kind: "plain", steps: [{ label: "deploy", args: ["deploy", ...envArgs(f.env), ...(f.message ? ["--message", f.message] : []), ...f.rest] }] };
}

/** Human-readable plan (what `--dry-run` prints). Never contains secrets: only wrangler arguments. */
export function describePlan(p: DeployPlan, f: DeployFlags): string[] {
  const out: string[] = [];
  if (p.kind === "gradual") {
    out.push(`1. build (fresh, env=${f.env ?? "default"})`, `2. wrangler ${p.upload.args.join(" ")}`);
    let n = 3; let prev = "<current>";
    for (const pct of p.percentages) {
      out.push(pct === 100 ? `${n++}. wrangler versions deploy <new>@100 -y` : `${n++}. wrangler versions deploy ${prev}@${100 - pct} <new>@${pct} -y  then health gate ${f.healthUrl ? `GET ${f.healthUrl}` : "(none: pass --health-url)"} for ${f.soak}s`);
    }
    out.push(`rollback on failed gate: wrangler rollback <current> -y (new version ends at 0%)`);
  } else {
    out.push("1. build (fresh, env=" + (f.env ?? "default") + ")", ...p.steps.map((s, i) => `${i + 2}. wrangler ${s.args.join(" ")}`));
  }
  return out;
}

// ---------- rollout state machine ----------

export interface Wrangler { (args: string[], opts?: { capture?: boolean }): { code: number; out: string } }
export interface RolloutDeps {
  wrangler: Wrangler;
  fetch?: (url: string) => Promise<{ status: number }>;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}
export interface RolloutResult { ok: boolean; newVersion?: string; previous?: string; rolledBack: boolean; failedAt?: number; reason?: string }

const VERSION_ID = /Worker Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
export const parseVersionId = (out: string) => out.match(VERSION_ID)?.[1];

/** The version currently taking 100% (first entry of the latest deployment) from `wrangler deployments list --json`. */
export function parseCurrentVersion(json: string): string | undefined {
  try {
    const list = JSON.parse(json);
    const last = Array.isArray(list) ? list[list.length - 1] : undefined;
    const vs: { version_id: string; percentage: number }[] = last?.versions ?? [];
    return [...vs].sort((a, b) => b.percentage - a.percentage)[0]?.version_id;
  } catch { return undefined; }
}

async function healthGate(f: DeployFlags, deps: RolloutDeps): Promise<string | undefined> {
  if (!f.healthUrl) return undefined;
  const get = deps.fetch ?? ((u: string) => fetch(u, { redirect: "manual" }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const probes = Math.max(1, Math.floor(f.soak / Math.max(f.interval, 1)));
  let failures = 0;
  for (let i = 0; i < probes; i++) {
    try { const r = await get(f.healthUrl); if (r.status >= 500 || r.status === 0) failures++; } catch { failures++; }
    if (failures > f.maxFailures) return `health check failed (${failures} failing probe${failures > 1 ? "s" : ""} on ${f.healthUrl})`;
    if (i < probes - 1) await sleep(f.interval * 1000);
  }
  return undefined;
}

export async function runGradual(plan: Extract<DeployPlan, { kind: "gradual" }>, f: DeployFlags, deps: RolloutDeps): Promise<RolloutResult> {
  const log = deps.log ?? (() => {});
  const w = deps.wrangler;
  const cur = w(["deployments", "list", ...envArgs(plan.env), "--json"], { capture: true });
  const previous = cur.code === 0 ? parseCurrentVersion(cur.out) : undefined;
  const up = w(plan.upload.args, { capture: true });
  const newVersion = up.code === 0 ? parseVersionId(up.out) : undefined;
  if (!newVersion) return { ok: false, previous, rolledBack: false, reason: up.code === 0 ? "could not read the new Worker Version ID from wrangler output" : "wrangler versions upload failed" };
  log(`uploaded ${newVersion}; current ${previous ?? "(none - first deploy)"}`);
  const deploy = (spec: string[], msg: string) => w(["versions", "deploy", ...spec, ...envArgs(plan.env), "--message", msg, "-y"]);
  if (!previous) { // nothing to split traffic with
    const r = deploy([`${newVersion}@100`], plan.message);
    return { ok: r.code === 0, newVersion, rolledBack: false, reason: r.code === 0 ? undefined : "versions deploy failed" };
  }
  for (const pct of plan.percentages) {
    const spec = pct === 100 ? [`${newVersion}@100`] : [`${previous}@${100 - pct}`, `${newVersion}@${pct}`];
    log(`step ${pct}%`);
    const r = deploy(spec, plan.message);
    let reason = r.code === 0 ? undefined : `versions deploy failed at ${pct}%`;
    if (!reason && pct < 100) reason = await healthGate(f, deps);
    if (reason) {
      log(`rolling back to ${previous}: ${reason}`);
      const rb = w(["rollback", previous, ...envArgs(plan.env), "--message", `auto-rollback: ${reason}`.slice(0, 200), "-y"]);
      return { ok: false, newVersion, previous, rolledBack: rb.code === 0, failedAt: pct, reason: rb.code === 0 ? reason : `${reason}; ROLLBACK ALSO FAILED - run wrangler rollback ${previous} manually` };
    }
  }
  return { ok: true, newVersion, previous, rolledBack: false };
}

// ---------- secrets push ----------

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** dotenv subset: KEY=value, quotes stripped, `#` comments, `export ` prefix. Throws with line numbers only (never values). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const m = line.replace(/^export\s+/, "").match(/^([^=\s]+)\s*=\s*(.*)$/);
    if (!m) throw new CliError(`secrets file line ${i + 1}: expected KEY=value`);
    if (!NAME.test(m[1])) throw new CliError(`secrets file line ${i + 1}: invalid name "${m[1]}"`);
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  });
  return out;
}

const ignored = (dir: string, file: string) => {
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) return false;
  const base = file.split("/").pop()!;
  return readFileSync(gi, "utf8").split(/\r?\n/).map((l) => l.trim()).some((l) => l === file || l === "/" + file || l === base || l === ".env*" || l === ".dev.vars*" || l === "*.vars");
};

export interface SecretsOpts { file?: string; env?: string; dryRun: boolean; force: boolean; only?: string[] }
/** Returns the exit code. Prints secret *names* only; the values reach wrangler via a file, never argv/stdout. */
export function pushSecrets(dir: string, o: SecretsOpts, wrangler: Wrangler, log: (m: string) => void): number {
  const file = o.file ?? ".dev.vars";
  const path = join(dir, file);
  if (!existsSync(path)) throw new CliError(`${file} not found (pass --file <path>)`);
  if (!o.force && !ignored(dir, file)) throw new CliError(`${file} is not in .gitignore - refusing to push from a file that could be committed (--force to override)`);
  let vars = parseDotenv(readFileSync(path, "utf8"));
  if (o.only) { const miss = o.only.filter((k) => !(k in vars)); if (miss.length) throw new CliError(`not in ${file}: ${miss.join(", ")}`); vars = Object.fromEntries(o.only.map((k) => [k, vars[k]])); }
  const names = Object.keys(vars);
  if (!names.length) throw new CliError(`${file} has no variables`);
  const empty = names.filter((n) => vars[n] === "");
  if (empty.length) throw new CliError(`empty values (would be rejected by Cloudflare): ${empty.join(", ")}`);
  log(`${o.dryRun ? "would push" : "pushing"} ${names.length} secret(s)${o.env ? ` to env ${o.env}` : ""}: ${names.join(", ")}`);
  if (o.dryRun) return 0;
  const r = wrangler(["secret", "bulk", path, ...envArgs(o.env)], { capture: true });
  // wrangler prints names/counts only; forward nothing but the verdict so a future wrangler change cannot leak values.
  log(r.code === 0 ? "secrets pushed" : "wrangler secret bulk failed (exit " + r.code + "); its output is withheld - rerun `wrangler secret bulk` by hand to see it");
  return r.code;
}

// ---------- placement ----------

/** Insert `"placement": { "mode": "smart" }` into a wrangler jsonc text unless a placement key exists. Comments/format kept. */
export function addSmartPlacement(text: string): { text: string; changed: boolean } {
  const cfg = parseJsonc<any>(text);
  if (cfg.placement !== undefined) return { text, changed: false };
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  const close = text.lastIndexOf("}");
  let j = close - 1; while (j > 0 && /\s/.test(text[j])) j--;
  const comma = text[j] === "," || text[j] === "{" ? "" : ",";
  const next = text.slice(0, j + 1) + comma + `\n${indent}"placement": { "mode": "smart" }` + "\n" + text.slice(close);
  // a trailing comment after the last entry would have swallowed the comma: verify instead of guessing
  try { if (parseJsonc<any>(next).placement?.mode !== "smart") throw 0; } catch { throw new CliError('cannot edit this wrangler config safely; add  "placement": { "mode": "smart" }  by hand'); }
  return { text: next, changed: true };
}

export function addPlacement(dir: string, log: (m: string) => void): void {
  const file = findWranglerConfig(dir);
  if (!file) throw new CliError("no wrangler.jsonc/wrangler.json here - run it in your app directory");
  const text = readFileSync(file, "utf8");
  const cfg = parseJsonc<any>(text);
  const r = addSmartPlacement(text);
  if (!r.changed) { log(`placement already set (${JSON.stringify(cfg.placement)}) - left alone`); return; }
  writeFileSync(file, r.text);
  const db = (cfg.d1_databases?.length || cfg.hyperdrive?.length) ? "" : " (no D1/Hyperdrive binding found: Smart Placement only helps Workers that talk to a single backend)";
  log(`set placement.mode = "smart" in ${file.split("/").pop()}${db}. Static assets are unaffected; only Worker invocations are relocated.`);
}

// ---------- CI templates ----------

/** `cf-lite add ci`: copy the preview + production workflows into .github/workflows (never overwrites). */
export function addCi(dir: string, templateDir: string, log: (m: string) => void): void {
  const out = join(dir, ".github", "workflows");
  mkdirSync(out, { recursive: true });
  for (const f of ["preview.yml", "production.yml"]) {
    const dest = join(out, f.replace(/\.yml$/, "-cf-lite.yml"));
    if (existsSync(dest)) { log(`${dest.replace(dir + "/", "")} exists - left alone`); continue; }
    writeFileSync(dest, readFileSync(join(templateDir, f), "utf8"));
    log(`wrote ${dest.replace(dir + "/", "")}`);
  }
  log("Set repo secrets CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, a repo variable HEALTH_URL, and a required-reviewer Environment named \"production\".");
}
