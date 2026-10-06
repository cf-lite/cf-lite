/**
 * `cf-lite init`: one pass over steps that already exist as `add` targets (UI adapter, bindings/features), then
 * `.dev.vars.example`, the agent files (`add agents`), and the post-init doctor with its safe autofixes.
 * Nothing here edits files itself except `.dev.vars.example`: each step is `add(<args>)`, so every guarantee of `add`
 * (idempotent, never overwrites, comments kept) holds, and `--dry-run` is the same scratch-copy diff.
 * Every prompt has a flag; `--yes` (or no TTY) takes the flags and the defaults and asks nothing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_UI } from "./add.js";
import { STORAGE_KINDS, CliError } from "./cli-db.js";
import { EXTRA_KINDS } from "./add-extras.js";
import { addAgents } from "./ai-assets.js";
import { doctor, formatFindings, type Finding } from "./doctor.js";
import { doctorFix } from "./doctor-fix.js";

/** `--with` items that need no name; `queue:<name>`, `cron:<name>`, `do:<Name>`, `workflow:<name>`, `email:<name>` carry one. */
export const WITH_PLAIN = [...STORAGE_KINDS, ...EXTRA_KINDS.filter((k) => k !== "rsc"), "auth", "ci", "patterns", "rsc"] as readonly string[];
export const WITH_NAMED = ["queue", "cron", "do", "workflow", "email"] as const;

export interface InitOptions {
  /** UI adapter to add, "none" to skip; undefined = ask (or skip under --yes). */
  ui?: string;
  /** Targets from `--with`; undefined = ask (or none under --yes). */
  with?: string[];
  /** Write the AI/agent files (default true; `--no-agents`). */
  agents?: boolean;
  /** Run doctor and apply its safe fixes at the end (default true; `--no-fix`). */
  fix?: boolean;
  yes?: boolean;
  log?: (m: string) => void;
  /** Question -> answer (empty = default). Injected by tests; the CLI wires readline. */
  ask?: (question: string) => Promise<string>;
  /** Runs `cf-lite add <args>` (same code path as the command). */
  add: (args: string[]) => Promise<void>;
}
export interface InitResult { steps: string[][]; agents: string[]; fixed: string[]; findings: Finding[] }

/** Validate `--with a,b,queue:emails` into add-argument lists. Throws CliError on an unknown item. */
export function parseWith(items: string[]): string[][] {
  return items.map((raw) => {
    const [kind, name] = raw.split(":");
    if ((WITH_NAMED as readonly string[]).includes(kind)) {
      if (!name) throw new CliError(`--with ${kind} needs a name: ${kind}:<name>`);
      return [kind, name];
    }
    if (!WITH_PLAIN.includes(raw)) throw new CliError(`--with: unknown item "${raw}" (known: ${[...WITH_PLAIN, ...WITH_NAMED.map((k) => `${k}:<name>`)].join(", ")})`);
    return [raw];
  });
}

const DEV_VARS = "# Local secrets and vars: cp .dev.vars.example .dev.vars (gitignored). List every secret NAME here, never a real value.\n";

export async function runInit(dir: string, o: InitOptions): Promise<InitResult> {
  const log = o.log ?? (() => {});
  const ask = o.yes || !o.ask ? undefined : o.ask;
  if (!existsSync(join(dir, "package.json"))) throw new CliError("run it in your app directory (no package.json here; `bun create cf-lite` makes one)");
  const res: InitResult = { steps: [], agents: [], fixed: [], findings: [] };

  // 1. UI adapter
  let ui = o.ui;
  if (ui === undefined && ask) {
    const a = (await ask(`UI adapter [${KNOWN_UI.join("/")}/none] (none): `)).trim();
    ui = a || "none";
  }
  if (ui && ui !== "none") {
    if (!(KNOWN_UI as readonly string[]).includes(ui) && !ui.startsWith("@")) throw new CliError(`--ui: unknown adapter "${ui}" (known: ${KNOWN_UI.join(", ")}, none)`);
    res.steps.push([ui]);
  }
  // 2. bindings / features
  let items = o.with;
  if (items === undefined && ask) {
    const a = (await ask(`Add (comma list; ${[...WITH_PLAIN, ...WITH_NAMED.map((k) => `${k}:<name>`)].join(", ")}) (none): `)).trim();
    items = a && a !== "none" ? a.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
  const withSteps = parseWith(items ?? []); // validated before anything is written
  // patterns/rsc need the UI adapter first: order = UI, then the rest as given
  res.steps.push(...withSteps);
  for (const args of res.steps) { log(`init: add ${args.join(" ")}`); await o.add(args); }

  // 3. .dev.vars.example (never overwritten)
  if (!existsSync(join(dir, ".dev.vars.example"))) { writeFileSync(join(dir, ".dev.vars.example"), DEV_VARS); log("init: create .dev.vars.example"); }

  // 4. AI assets, from the facts of the app as it is NOW (after the steps above)
  let agents = o.agents;
  if (agents === undefined && ask) agents = !/^n/i.test((await ask("Write AGENTS.md + Claude/Copilot files? [Y/n]: ")).trim());
  if (agents !== false) res.agents = addAgents(dir, (m) => log(`init:${m}`)).changed;

  // 5. post-init doctor, safe fixes only
  res.findings = doctor(dir);
  if (o.fix !== false) {
    res.fixed = doctorFix(dir, res.findings, (m) => log(`init:${m}`));
    if (res.fixed.length) res.findings = doctor(dir);
  }
  log(`init: doctor\n${formatFindings(res.findings)}`);
  return res;
}
