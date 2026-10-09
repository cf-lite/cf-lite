/**
 * The tool surface (docs/llm.md, roadmap-dx 5.1): every capability the LLM layer may use is one typed tool with a JSON Schema.
 * `cfl mcp`, `cfl ask` and the plain CLI are three front doors to these same functions; no behavior lives in a front door.
 * Allow-list by construction: a name that is not in TOOLS cannot be run. Nothing here executes a shell, touches the network or
 * writes outside `dir`; remote-side commands (`deploy`, `seed --remote`, `secrets push`) and `init`/`upgrade` are not tools.
 */
import { applyPlan, planGenerate, GenError, type GenOptions, type Generator } from "./gen-app.js";
import { describeSeed, planSeed, runSeed } from "./seed.js";
import { dryRun } from "./add-extras.js";
import { doctor } from "./doctor.js";
import { analyze, formatReport } from "./analyze.js";
import { CliError } from "./cli-db.js";

export interface Schema {
  type?: "object" | "string" | "boolean";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Schema & { type: "object"; properties: Record<string, Schema> };
  /** false = reads only (doctor, analyze); true = may write files on apply. */
  mutating: boolean;
}

const DRY: Schema = { type: "boolean", description: "Preview only: return the files/diff, write nothing (default false)." };
const UI: Schema = { type: "string", enum: ["react", "preact", "vue", "svelte"], description: "UI adapter. Only when the user names a framework; otherwise leave out (auto-detected from vite.config)." };
const obj = (properties: Record<string, Schema>, required: string[] = []): ToolDef["inputSchema"] =>
  ({ type: "object", properties: { ...properties, dryRun: DRY }, required, additionalProperties: false });

export const ADD_TARGETS = ["d1", "kv", "r2", "hyperdrive", "tailwind", "ai", "images", "turnstile", "auth", "ci", "patterns", "agents", "cron", "queue", "workflow", "email", "do"] as const;
const NAMED_ADD = new Set(["cron", "queue", "workflow", "email", "do"]);
const STORAGE = new Set(["d1", "kv", "r2", "hyperdrive"]);

export const TOOLS: ToolDef[] = [
  {
    name: "generate_page", mutating: true,
    description: "Create a route page file (app/routes/<name>.tsx or .vue/.svelte). Only when the user gave the page's name or route (about, pricing, posts/[id]); never call it with a placeholder such as 'page', 'index' or 'new'.",
    inputSchema: obj({
      name: { type: "string", pattern: "^(?!/)(?!(.*/)?\\.\\.?(/|$))[A-Za-z0-9_\\[\\]().\\-/]+$", maxLength: 100, description: "The route the user said, without extension, e.g. about or posts/[id]. Never invented." },
      render: { type: "string", enum: ["static", "ssr", "spa"], description: "Only when the user asked: ssr = server-rendered ('on the server', 'ssr', 'dynamic'), spa = client-only, static is the default and is left out." },
      loader: { type: "boolean", description: "True only when the user asks for a loader / data fetching." }, ui: UI,
    }, ["name"]),
  },
  {
    name: "generate_api", mutating: true,
    description: "Create an API route server/api/<name>.ts (Hono: list, get, validated create), optionally with a MOCK=1 fixture and a D1 seed file. Only when the user gave the resource's name (products, blog-posts).",
    inputSchema: obj({
      name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", maxLength: 60, description: "The resource name the user said, lowercase with dashes, e.g. blog-posts. Never a placeholder like 'api' or 'items'." },
      mock: { type: "boolean", description: "True only when the user asks for a mock." }, seed: { type: "boolean", description: "True only when the user asks for seed data." },
    }, ["name"]),
  },
  {
    name: "generate_component", mutating: true,
    description: "Create a UI component with a states file that /__preview and `cfl export` render. Only when the user gave the component's name; never a placeholder such as 'Component'.",
    inputSchema: obj({
      name: { type: "string", pattern: "^[A-Z][A-Za-z0-9]*$", maxLength: 60, description: "The component name the user said, PascalCase, e.g. ProductCard." },
      island: { type: "boolean", description: "True only when the user says island / hydrated / interactive." }, folder: { type: "boolean", description: "True only when the user asks for its own folder." },
      dir: { type: "string", pattern: "^app/[A-Za-z0-9_/-]+$", maxLength: 80, description: "Only if the user named a folder under app/ (e.g. app/patterns/atoms); otherwise omit. Anything outside app/ is not allowed." }, ui: UI,
    }, ["name"]),
  },
  {
    name: "generate_test", mutating: true,
    description: "Create a test file for ONE existing page, API or component the user named. Never call it without that name (a bare 'add a test' needs a question first).",
    inputSchema: obj({
      name: { type: "string", pattern: "^(?!/)(?!(.*/)?\\.\\.?(/|$))[A-Za-z0-9_\\[\\]().\\-/]+$", maxLength: 100, description: "The exact page, api or component name the user said; never 'test', 'index' or a guess." },
      kind: { type: "string", enum: ["page", "api", "component"], description: "Only when the user said which kind (page, api, component); otherwise omit." },
    }, ["name"]),
  },
  {
    name: "add", mutating: true,
    description: "Add one capability to the app (wrangler binding + files; dependencies are NOT installed, run your package manager afterwards). Targets: d1 (SQL database), kv (key-value), r2 (object/file bucket), hyperdrive (external Postgres/MySQL) - the user must pick one of these by name or clearly by kind; a bare 'database' or 'storage' is ambiguous: ask which. tailwind, ai, images, turnstile, auth, ci, patterns, agents (AGENTS.md / CLAUDE.md for coding assistants). cron/queue/workflow/email/do (Durable Object) are jobs and REQUIRE a name the user chose; 'add a queue' without a name is incomplete: ask for the name.",
    inputSchema: obj({
      target: { type: "string", enum: [...ADD_TARGETS], description: "What to add. Never guess between d1/kv/r2/hyperdrive." },
      name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 60, description: "Job or Durable Object name (cron, queue, workflow, email, do), exactly as the user said it; never the target word itself ('queue', 'durable-object', 'job') and never made up. Leave out for every other target." },
      binding: { type: "string", pattern: "^[A-Z][A-Z0-9_]*$", maxLength: 40, description: "Binding name for d1/kv/r2/hyperdrive. Leave out unless the user gave one." },
      schedule: { type: "string", pattern: "^[0-9*/,\\- ]+$", maxLength: 40, description: "cron only: cron expression, e.g. '0 * * * *'." },
    }, ["target"]),
  },
  {
    name: "seed", mutating: true,
    description: "Load seeds/*.sql|*.d1.json|*.kv.json into the LOCAL database/KV only. Never for production or remote data: there is no tool for that (refuse).",
    inputSchema: obj({ name: { type: "string", pattern: "^[A-Za-z0-9._-]+$", maxLength: 80, description: "Only if the user named a specific seed file; otherwise omit (loads all seeds)." } }),
  },
  { name: "doctor", mutating: false, description: "Check the project for misconfiguration (CFLxxx findings). Read-only. Only when the user asks to check/diagnose the project's setup.", inputSchema: obj({}) },
  { name: "analyze", mutating: false, description: "Report built Worker and per-page JS sizes. Read-only. Only when the user asks how big the build/bundle/worker is; it does NOT make anything faster.", inputSchema: obj({}) },
];

export const toolByName = (n: string): ToolDef | undefined => TOOLS.find((t) => t.name === n);

/** Minimal JSON-Schema check for the subset above. Returns error strings; invalid calls are rejected, never repaired. */
export function validateArgs(schema: Schema, value: unknown, path = "arguments"): string[] {
  const errs: string[] = [];
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
    const v = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (v[r] === undefined) errs.push(`${path}.${r} is required`);
    for (const [k, x] of Object.entries(v)) {
      const sub = schema.properties?.[k];
      if (!sub) { if (schema.additionalProperties === false) errs.push(`${path}.${k} is not allowed`); continue; }
      errs.push(...validateArgs(sub, x, `${path}.${k}`));
    }
    return errs;
  }
  if (schema.type === "boolean") return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
  if (schema.type === "string") {
    if (typeof value !== "string") return [`${path} must be a string`];
    if (schema.enum && !schema.enum.includes(value)) errs.push(`${path} must be one of ${schema.enum.join(", ")}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path} has an invalid format`);
  }
  return errs;
}

export interface ToolEnv {
  dir: string;
  /** `add` executor (cli.ts doAdd). Called with `--no-install` always: tools never run a package manager. */
  add?: (dir: string, argv: string[]) => Promise<void>;
  /** Runs `wrangler <args>` (local seed only); returns the exit code. */
  wrangler?: (args: string[]) => number;
}
export interface ToolResult {
  ok: boolean; tool: string; dryRun: boolean;
  /** Human-readable plan/result: `+ path` new file, `~ path` edited (with +/- lines), or findings. */
  lines: string[];
  files?: { path: string; action: "create" | "keep"; content: string }[];
  notes?: string[]; error?: string;
}

const fail = (tool: string, dry: boolean, error: string): ToolResult => ({ ok: false, tool, dryRun: dry, lines: [], error });

/** argv for `add` from validated arguments, or an error message. */
export function addArgv(a: Record<string, unknown>): string[] | string {
  const t = a.target as string;
  if (NAMED_ADD.has(t)) {
    if (!a.name) return `add ${t} needs a name`;
    return [t, a.name as string, ...(t === "cron" && a.schedule ? [a.schedule as string] : [])];
  }
  if (STORAGE.has(t)) return [t, ...(a.binding ? ["--binding", a.binding as string] : []), ...(a.name ? ["--name", a.name as string] : [])];
  if (a.name || a.binding || a.schedule) return `add ${t} takes no name/binding/schedule`;
  return [t];
}

/** The equivalent manual command: shown in the plan and used as the fallback when the model cannot produce a valid call. */
export function toCommand(tool: string, a: Record<string, unknown>): string {
  const flag = (k: string, f = `--${k}`) => (a[k] === true ? [f] : a[k] ? [f, String(a[k])] : []);
  let parts: string[];
  if (tool.startsWith("generate_")) {
    parts = ["cfl", "g", tool.slice(9), String(a.name), ...flag("render"), ...flag("loader"), ...flag("mock"), ...flag("seed"), ...flag("island"), ...flag("folder"), ...flag("dir"), ...flag("kind"), ...flag("ui")];
  } else if (tool === "add") {
    const v = addArgv(a);
    parts = ["cfl", "add", ...(Array.isArray(v) ? v : [String(a.target)])];
  } else if (tool === "seed") parts = ["cfl", "seed", ...(a.name ? [String(a.name)] : [])];
  else parts = ["cfl", tool];
  return parts.join(" ");
}

function genOptions(a: Record<string, unknown>): GenOptions {
  return { ui: a.ui as string | undefined, render: a.render as string | undefined, loader: a.loader === true, island: a.island === true, folder: a.folder === true, dir: a.dir as string | undefined, mock: a.mock === true, seed: a.seed === true, kind: a.kind as string | undefined };
}

/** Validate and run one tool. Never throws for bad input: returns `{ ok: false, error }`. `dryRun` writes nothing. */
export async function runTool(env: ToolEnv, name: string, args: unknown): Promise<ToolResult> {
  const def = toolByName(name);
  const a = (args ?? {}) as Record<string, unknown>;
  const dry = a.dryRun === true;
  if (!def) return fail(name, dry, `unknown tool "${name}" (allowed: ${TOOLS.map((t) => t.name).join(", ")})`);
  const errs = validateArgs(def.inputSchema, a);
  if (errs.length) return fail(name, dry, errs.join("; "));
  try {
    if (name.startsWith("generate_")) {
      const plan = planGenerate(env.dir, name.slice(9) as Generator, a.name as string, genOptions(a));
      if (!dry) applyPlan(env.dir, plan);
      return { ok: true, tool: name, dryRun: dry, lines: plan.files.map((f) => (f.action === "create" ? `+ ${f.path}` : `= ${f.path} (exists, kept)`)), files: plan.files, notes: plan.notes };
    }
    if (name === "add") {
      const argv = addArgv(a);
      if (typeof argv === "string") return fail(name, dry, argv);
      if (!env.add) return fail(name, dry, "add is not available in this context");
      const run = (d: string) => env.add!(d, [...argv, "--no-install"]);
      const lines = await dryRun(env.dir, run);
      if (!dry) await run(env.dir);
      return { ok: true, tool: name, dryRun: dry, lines, notes: ["dependencies are not installed: run your package manager's install afterwards"] };
    }
    if (name === "seed") {
      const plan = planSeed(env.dir, a.name ? [a.name as string] : []);
      const lines = describeSeed(plan);
      if (dry) return { ok: true, tool: name, dryRun: true, lines };
      if (!env.wrangler) return fail(name, dry, "seed is not available in this context");
      const code = runSeed(plan, env.wrangler, () => {});
      return code === 0 ? { ok: true, tool: name, dryRun: false, lines } : fail(name, dry, `wrangler exited with code ${code}`);
    }
    if (name === "doctor") {
      const f = doctor(env.dir, {});
      return { ok: !f.some((x) => x.level === "error"), tool: name, dryRun: dry, lines: f.map((x) => `${x.code} ${x.level}: ${x.message}${x.fix ? ` (fix: ${x.fix})` : ""}`) };
    }
    const r = analyze(env.dir);
    return { ok: !!r.worker, tool: name, dryRun: dry, lines: formatReport(r).split("\n") };
  } catch (e) {
    if (e instanceof GenError || e instanceof CliError) return fail(name, dry, e.message);
    throw e;
  }
}
