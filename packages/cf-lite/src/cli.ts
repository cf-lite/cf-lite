#!/usr/bin/env bun
/** cf-lite dev|build|deploy — thin wrappers. `vite` and `wrangler` do the work; nothing custom at runtime. */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { prerender } from "./prerender.js";
import { addUi, KNOWN_UI } from "./add.js";
import { addAuth } from "./add-auth.js";
import { addAiChat } from "./add-ai.js";
import { addDo } from "./add-do.js";
import { addStorage, isStorageKind, parseFlags, runDb, STORAGE_KINDS, CliError, findWranglerConfig } from "./cli-db.js";
import { fileURLToPath } from "node:url";
import { addCi, addPlacement, checkPreviewConfig, describePlan, parseDeployFlags, planDeploy, pushSecrets, runGradual, type Wrangler } from "./cli-deploy.js";
import { parseJsonc } from "./wrangler-edit.js";
import { syncEnvTypes } from "./cli-types.js";
import { EXTRA_KINDS, addExtra, dryRun, isExtraKind } from "./add-extras.js";
import { analyze, formatReport } from "./analyze.js";
import { doctor, formatFindings } from "./doctor.js";
import { upgrade } from "./upgrade/index.js";
import { addJob, JOB_KINDS, type JobKind } from "./add-jobs.js";
import { addWebhook } from "./add-webhook.js";
import { addPatterns } from "./add-patterns.js";
import { runExport } from "./export.js";
import { addAgents } from "./ai-assets.js";
import { runInit } from "./init.js";
import { doctorFix } from "./doctor-fix.js";
import { applyPlan, errorJson, GENERATORS, isGenerator, planGenerate, reportDry, reportJson, GenError } from "./gen-app.js";
import { describeSeed, planSeed, runSeed, seedJson } from "./seed.js";
import { createInterface } from "node:readline/promises";
import { serveMcp } from "./mcp.js";
import { ask, DEFAULT_MODEL, resolveCreds } from "./ask.js";
import { resolveRoute } from "./ask-provider.js";
import { noticeText } from "./ask-consent.js";
import type { ToolEnv } from "./tools.js";

const require = createRequire(process.cwd() + "/");
/** Resolve a dependency's CLI entry from its package.json `bin` (packages don't export bin/ paths). */
const bin = (pkg: string) => {
  const pj = require.resolve(`${pkg}/package.json`);
  const b = JSON.parse(readFileSync(pj, "utf8")).bin;
  return join(dirname(pj), typeof b === "string" ? b : b[pkg]);
};
const run = (pkg: string, args: string[]) => {
  const r = spawnSync(process.execPath, [bin(pkg), ...args], { stdio: "inherit", cwd: process.cwd() });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const vite = (args: string[]) => run("vite", args);
const wranglerRunner: Wrangler = (args, o) => {
  const r = spawnSync(process.execPath, [bin("wrangler"), ...args], { cwd: process.cwd(), encoding: "utf8", stdio: o?.capture ? ["inherit", "pipe", "pipe"] : "inherit" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (o?.capture && args[0] !== "secret") process.stdout.write(out); // never forward `secret` output
  return { code: r.status ?? 1, out };
};

/** Name of the Worker the last build produced (from the redirect wrangler.json the Cloudflare plugin writes). */
function builtWorker(): string {
  try {
    const redirect = JSON.parse(readFileSync(join(process.cwd(), ".wrangler/deploy/config.json"), "utf8")).configPath as string;
    const cfg = JSON.parse(readFileSync(join(process.cwd(), ".wrangler/deploy", redirect), "utf8"));
    return `${cfg.name} (CLOUDFLARE_ENV=${process.env.CLOUDFLARE_ENV ?? "unset"})`;
  } catch { return "(unknown)"; }
}
/** `--env <name>` -> CLOUDFLARE_ENV for the build; otherwise the variable is cleared, so a deploy never inherits an environment from a previous shell/build. */
function takeEnv(args: string[]): string[] {
  const i = args.indexOf("--env");
  if (i >= 0) { process.env.CLOUDFLARE_ENV = args[i + 1]; args.splice(i, 2); }
  return args;
}

/** One `add` target. Errors are thrown (never process.exit) so `--dry-run` can clean up its scratch copy. */
async function doAdd(dir: string, rest: string[], log: (m: string) => void): Promise<void> {
  const ui = rest[0];
  const install = !rest.includes("--no-install");
  if (isStorageKind(ui)) { const f = parseFlags(rest.slice(1)); addStorage(dir, ui, { binding: f.binding, name: f.name, log }); return; }
  if (!existsSync(join(dir, "package.json"))) throw new CliError("run it in your app directory (no package.json here)");
  if (ui === "ci") { addCi(dir, join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "ci"), log); return; }
  if (ui === "placement") { addPlacement(dir, log); return; }
  if (ui === "auth") { addAuth(dir, log, { rateLimit: !rest.includes("--no-ratelimit"), turnstile: !rest.includes("--no-turnstile") }); return; }
  if (ui === "agents") { try { addAgents(dir, log); } catch (e) { throw new CliError((e as Error).message); } return; }
  if (ui === "ai-chat") { addAiChat(dir, log); return; }
  if (ui === "patterns") { try { addPatterns(dir, log); } catch (e) { throw new CliError((e as Error).message); } return; }
  if (isExtraKind(ui)) { addExtra(dir, ui, { install, log }); return; }
  if (ui === "webhook") {
    const pi = rest.indexOf("--provider");
    try { addWebhook(dir, log, { provider: pi >= 0 ? rest[pi + 1] : undefined }); } catch (e) { throw new CliError((e as Error).message); }
    return;
  }
  if (ui === "do") {
    if (!rest[1]) throw new CliError("usage: cf-lite add do <name>");
    try { addDo(dir, rest[1], log); } catch (e) { throw new CliError((e as Error).message); }
    return;
  }
  if ((JOB_KINDS as readonly string[]).includes(ui)) {
    if (!rest[1]) throw new CliError(`usage: cf-lite add ${ui} <name>${ui === "cron" ? " [\"<cron expression>\"]" : ""}`);
    addJob(dir, ui as JobKind, rest[1], log, { schedule: ui === "cron" ? rest[2] : undefined });
    return;
  }
  await addUi(dir, ui, { install, log });
}

/** The tool surface's host hooks (src/tools.ts): `add` never installs, wrangler output never reaches stdout in MCP mode. */
const toolEnv = (quiet: boolean): ToolEnv => ({
  dir: process.cwd(),
  add: (d, argv) => doAdd(d, argv, () => {}),
  wrangler: (args) => spawnSync(process.execPath, [bin("wrangler"), ...args], { cwd: process.cwd(), stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit" }).status ?? 1,
});

const [cmd, ...rest] = process.argv.slice(2);
// Miniflare (vite dev / cfl export) hangs under Bun (docs/bun-first.md: workers-sdk#15717, bun#42231), so these two hand off to Node when we are on Bun.
if ((cmd === "dev" || cmd === "export") && process.versions.bun && !process.env.CFL_NO_NODE_HANDOFF) {
  const r = spawnSync("node", [process.argv[1]!, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, CFL_NO_NODE_HANDOFF: "1" } });
  if (r.error) { console.error(`cfl ${cmd}: the dev server needs Node 22+ on PATH for now (Miniflare does not run under Bun yet; see docs/bun-first.md)`); process.exit(1); }
  process.exit(r.status ?? 1);
}
switch (cmd) {
  case "dev": { // --mock = MOCK=1 (docs/mocks.md); everything else goes to vite
    if (rest.includes("--mock")) { process.env.MOCK = "1"; rest.splice(rest.indexOf("--mock"), 1); }
    vite(["dev", ...rest]); break;
  }
  case "export": { // render every component state to HTML fragments (docs/export.md)
    const val = (k: string) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
    try {
      process.exit(await runExport({ root: process.cwd(), out: val("--out"), check: rest.includes("--check"), mock: rest.includes("--mock"), viteBin: bin("vite"), log: (m) => console.log(m) }));
    } catch (e) { console.error("cfl export: " + (e as Error).message); process.exit(1); }
  }
  case "prepare": case "types": { // loading the vite config runs cfLite(), which (re)writes .cf-lite/* (incl. typed-routes.d.ts); then `wrangler types` writes Env
    const { loadConfigFromFile } = await import("vite");
    const check = rest.includes("--check");
    const env = rest.includes("--env") ? rest[rest.indexOf("--env") + 1] : undefined;
    if (!check) await loadConfigFromFile({ command: "build", mode: "production" }, undefined, process.cwd());
    const code = syncEnvTypes(process.cwd(), wranglerRunner, (m) => console.log(m), { env, check });
    if (code !== 0) {
      if (cmd === "types") { console.error(check ? "cf-lite types: Env types are out of date - run `cf-lite types`" : "cf-lite types: `wrangler types` failed"); process.exit(code); }
      console.warn("cf-lite prepare: `wrangler types` failed - Env types not updated");
    }
    break;
  }
  case "build":
    takeEnv(rest);
    vite(["build", ...rest]);
    console.log("prerendered:", (await prerender()).map((f) => f.replace(process.cwd() + "/", "")).join(", ") || "(none)");
    console.log("built Worker:", builtWorker());
    break;
  case "deploy": {
    try {
      const f = parseDeployFlags(rest);
      const plan = planDeploy(f);
      if (plan.kind === "preview") {
        const file = findWranglerConfig(process.cwd());
        const chk = checkPreviewConfig(file ? parseJsonc(readFileSync(file, "utf8")) : {}, f.env);
        chk.warnings.forEach((w) => console.warn("warning:", w));
        if (chk.errors.length) throw new CliError("unsafe preview config:\n  - " + chk.errors.join("\n  - "));
      }
      if (f.dryRun) { describePlan(plan, f).forEach((l) => console.log(l)); break; }
      // Always a fresh build for the env named here (none = default env): the generated wrangler config is per-build-env,
      // so a bare `wrangler deploy` after a build for another env would ship that env's Worker.
      if (f.env) process.env.CLOUDFLARE_ENV = f.env; else delete process.env.CLOUDFLARE_ENV;
      vite(["build"]);
      await prerender();
      console.log("deploying Worker:", builtWorker());
      if (plan.kind === "gradual") {
        const res = await runGradual(plan, f, { wrangler: wranglerRunner, log: (m) => console.log(m) });
        if (!res.ok) { console.error(`deploy failed: ${res.reason}${res.rolledBack ? " (rolled back)" : ""}`); process.exit(1); }
        console.log(`promoted ${res.newVersion} to 100%`);
      } else {
        for (const st of plan.steps) { console.log(st.label); if (wranglerRunner(st.args).code !== 0) process.exit(1); }
      }
    } catch (e) { if (e instanceof CliError) { console.error("cf-lite deploy: " + e.message); process.exit(1); } throw e; }
    break;
  }
  case "secrets": {
    try {
      if (rest[0] !== "push") throw new CliError("usage: cf-lite secrets push [--file .dev.vars] [--env x] [--only A,B] [--dry-run] [--force]");
      const a = rest.slice(1); const val = (k: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
      process.exit(pushSecrets(process.cwd(), { file: val("--file"), env: val("--env"), dryRun: a.includes("--dry-run"), force: a.includes("--force"), only: val("--only")?.split(",") }, wranglerRunner, (m) => console.log(m)));
    } catch (e) { if (e instanceof CliError) { console.error("cf-lite secrets: " + e.message); process.exit(1); } throw e; }
  }
  case "add": {
    const dry = rest.includes("--dry-run");
    const args = rest.filter((a) => a !== "--dry-run");
    if (!args[0]) { console.log(`usage: cf-lite add <${KNOWN_UI.join("|")}|${STORAGE_KINDS.join("|")}|${EXTRA_KINDS.join("|")}|do|cron|queue|workflow|email|auth|ai-chat|agents|patterns|placement|ci|package> [--no-install] [--dry-run] (auth: [--no-ratelimit] [--no-turnstile])`); process.exit(1); }
    try {
      if (dry) { // runs the real code on a scratch copy and prints the diff; nothing in this directory changes
        (await dryRun(process.cwd(), (d) => doAdd(d, [...args, "--no-install"], () => {}))).forEach((l) => console.log(l));
      } else await doAdd(process.cwd(), args, (m) => console.log(m));
    } catch (e) { if (e instanceof CliError) { console.error("cf-lite add: " + e.message); process.exit(1); } throw e; }
    break;
  }
  case "g": case "generate": { // docs/generators.md; --json = one machine-readable object on stdout (also for errors), --dry-run writes nothing
    const json = rest.includes("--json"), dry = rest.includes("--dry-run");
    const val = (k: string) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
    const valued = new Set(["--ui", "--render", "--dir", "--kind"]);
    const pos = rest.filter((a, i) => !a.startsWith("--") && !valued.has(rest[i - 1]));
    try {
      if (!isGenerator(pos[0])) throw new GenError(`usage: cf-lite g <${GENERATORS.join("|")}> <name> [--dry-run] [--json] (page: --render static|ssr|spa --loader; api: --mock --seed; component: --island --folder --dir app/x; test: --kind page|api|component; all: --ui x)`);
      const plan = planGenerate(process.cwd(), pos[0], pos[1], { ui: val("--ui"), render: val("--render"), loader: rest.includes("--loader"), island: rest.includes("--island"), folder: rest.includes("--folder"), dir: val("--dir"), mock: rest.includes("--mock"), seed: rest.includes("--seed"), kind: val("--kind") });
      if (json) { if (!dry) applyPlan(process.cwd(), plan); console.log(reportJson(plan, dry)); }
      else if (dry) { reportDry(plan).forEach((l) => console.log(l)); }
      else { applyPlan(process.cwd(), plan, (m) => console.log(m)); plan.notes.forEach((n) => console.log("  note: " + n)); }
    } catch (e) {
      if (!(e instanceof GenError)) throw e;
      if (json) console.log(errorJson(e)); else console.error("cf-lite g: " + e.message);
      process.exit(1);
    }
    break;
  }
  case "seed": {
    const json = rest.includes("--json"), dry = rest.includes("--dry-run");
    try {
      const plan = planSeed(process.cwd(), rest.filter((a) => a !== "--json" && a !== "--dry-run"));
      if (dry) { if (json) console.log(seedJson(plan, true)); else describeSeed(plan).forEach((l) => console.log(l)); break; }
      if (plan.remote) console.log("WARNING: operating on REMOTE data");
      const code = runSeed(plan, (args) => spawnSync(process.execPath, [bin("wrangler"), ...args], { stdio: json ? ["inherit", "ignore", "inherit"] : "inherit", cwd: process.cwd() }).status ?? 1, (m) => { if (!json) console.log(m); });
      if (json) console.log(seedJson(plan, false));
      process.exit(code);
    } catch (e) {
      if (!(e instanceof CliError)) throw e;
      if (json) console.log(JSON.stringify({ ok: false, error: e.message }, null, 2)); else console.error("cf-lite seed: " + e.message);
      process.exit(1);
    }
    break;
  }
  case "doctor": {
    const opts = { budgetKiB: rest.includes("--budget") ? Number(rest[rest.indexOf("--budget") + 1]) : undefined };
    let findings = doctor(process.cwd(), opts);
    if (rest.includes("--fix")) { // safe subset only (src/doctor-fix.ts); --dry-run shows the diff and changes nothing
      const fix = (d: string, log: (m: string) => void) => doctorFix(d, doctor(d, opts), log);
      if (rest.includes("--dry-run")) (await dryRun(process.cwd(), (d) => { fix(d, () => {}); })).forEach((l) => console.log(l));
      else { const done = fix(process.cwd(), (m) => console.log(m)); if (!done.length) console.log("nothing to fix automatically"); findings = doctor(process.cwd(), opts); }
    }
    if (rest.includes("--json")) console.log(JSON.stringify(findings, null, 2)); else console.log(formatFindings(findings));
    process.exit(findings.some((f) => f.level === "error" || (rest.includes("--strict") && f.level === "warn")) ? 1 : 0);
  }
  case "init": {
    const val = (k: string) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
    const dry = rest.includes("--dry-run");
    const yes = rest.includes("--yes") || rest.includes("-y") || !process.stdin.isTTY;
    const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
    const go = (d: string, log: (m: string) => void) => runInit(d, {
      ui: val("--ui"), with: val("--with") !== undefined ? val("--with")!.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      agents: rest.includes("--no-agents") ? false : undefined, fix: !rest.includes("--no-fix"), yes, log,
      ask: rl ? (q) => rl.question(q) : undefined,
      add: (a) => doAdd(d, rest.includes("--no-install") || dry ? [...a, "--no-install"] : a, () => {}),
    });
    try {
      if (dry) (await dryRun(process.cwd(), (d) => { return go(d, () => {}).then(() => {}); })).forEach((l) => console.log(l));
      else await go(process.cwd(), (m) => console.log(m));
    } catch (e) { if (e instanceof CliError) { console.error("cf-lite init: " + e.message); process.exit(1); } throw e; }
    finally { rl?.close(); }
    process.exit(0);
  }
  case "mcp": { // MCP server over stdio (docs/llm.md); stdout is the protocol, so anything else a tool prints goes to stderr
    const own = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version as string;
    console.log = console.error;
    await serveMcp(toolEnv(true), own);
    process.exit(0);
  }
  case "ask": { // fallback natural-language mode (docs/llm.md): model picks allow-listed tools, plan + diff, confirm, apply
    const val = (k: string) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : undefined);
    const creds = resolveCreds(process.cwd());
    // provider/gateway are an explicit choice (flag or CFL_ASK_PROVIDER / CFL_AI_GATEWAY); a key in the environment alone never switches provider
    const route = resolveRoute({ provider: val("--provider"), gateway: val("--gateway"), baseUrl: val("--base-url") }, process.env, creds);
    if (typeof route === "string") { console.log(`cfl ask: ${route}`); process.exit(1); }
    if (rest.includes("--terms")) { noticeText(route.provider, !!route.gateway).forEach((l) => console.log(l)); break; }
    const text = rest.filter((a, i) => !a.startsWith("--") && !["--model", "--provider", "--gateway", "--base-url"].includes(rest[i - 1])).join(" ").trim();
    if (!text) { console.log(`usage: cfl ask "<what you want>" [--dry-run] [--yes] [--accept-terms] [--model ${DEFAULT_MODEL}] [--provider openai|anthropic] [--gateway <ai-gateway-id>] | cfl ask --terms`); process.exit(1); }
    const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    try {
      const r = await ask({ text, env: toolEnv(false), creds, route: route.provider === "workers-ai" && !route.gateway ? undefined : route, yes: rest.includes("--yes"), dryRun: rest.includes("--dry-run"), acceptTerms: rest.includes("--accept-terms"), model: val("--model") ?? process.env.CFL_ASK_MODEL, confirm: rl ? async (q) => /^y(es)?$/i.test((await rl.question(q)).trim()) : undefined, log: (m) => console.log(m) });
      process.exit(["applied", "planned", "clarify", "no-call"].includes(r.status) ? 0 : 1);
    } finally { rl?.close(); }
  }
  case "analyze": {
    const r = analyze(process.cwd());
    console.log(rest.includes("--json") ? JSON.stringify(r, null, 2) : formatReport(r));
    process.exit(r.worker ? 0 : 1);
  }
  case "upgrade": {
    try {
      const own = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version as string;
      const to = rest.includes("--to") ? rest[rest.indexOf("--to") + 1] : own;
      upgrade(process.cwd(), { to, dryRun: rest.includes("--dry-run"), install: !rest.includes("--no-install"), log: (m) => console.log(m) });
    } catch (e) { console.error((e as Error).message); process.exit(1); }
    break;
  }
  case "db": {
    try { process.exit(runDb(process.cwd(), rest, (args) => spawnSync(process.execPath, [bin("wrangler"), ...args], { stdio: "inherit", cwd: process.cwd() }).status ?? 1)); }
    catch (e) { if (e instanceof CliError) { console.error("cf-lite db: " + e.message); process.exit(1); } throw e; }
  }
  default:
    console.log("usage: cf-lite|cfl <dev [--mock]|export [--out dir] [--check] [--mock]|build|deploy [--env x] [--gradual 10,50,100] [--preview-alias pr-N] [--dry-run]|secrets push|prepare|types [--check] [--env x]|add <ui|d1|kv|r2|hyperdrive|tailwind|ai|images|turnstile|do|cron|queue|workflow|auth|placement|ci> [--dry-run]|db <new|apply|status>|init [--ui x] [--with a,b] [--yes] [--no-agents] [--no-fix] [--dry-run]|g <page|api|component|test> <name> [--dry-run] [--json]|seed [name] [--remote --yes] [--dry-run] [--json]|mcp|ask \"<text>\" [--dry-run] [--yes] [--accept-terms] [--terms] [--provider openai|anthropic] [--gateway id]|doctor [--strict] [--json] [--fix]|analyze [--json]|upgrade [--to x.y.z] [--dry-run]>");
    process.exit(cmd ? 1 : 0);
}
