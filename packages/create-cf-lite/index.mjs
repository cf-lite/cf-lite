#!/usr/bin/env bun
// bun create cf-lite my-app --  (or: npm create cf-lite@latest my-app --) [--template minimal|blog|saas|api|realtime|ai-chat|patterns] [--ui none|react|preact|vue|svelte|htmx] [--no-install]
// Copies the minimal template (renderer "none"), then runs the same code as `cf-lite add <ui>` - one implementation, tested once.
import { cpSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { addUi } from "cf-lite/add";
import { addAuth } from "cf-lite/add-auth";
import { addJob } from "cf-lite/add-jobs";
import { addPatterns } from "cf-lite/add-patterns";

const UIS = ["none", "react", "preact", "vue", "svelte", "htmx"];
export const TEMPLATES = ["minimal", "blog", "saas", "api", "realtime", "ai-chat", "patterns"];
/** Bun first: `bun create` / `bunx` / running under Bun -> bun; an explicit pnpm/yarn/npm launcher is respected. */
const packageManager = () => {
  const ua = process.env.npm_config_user_agent ?? "";
  if (process.versions.bun || ua.startsWith("bun")) return "bun";
  return ["pnpm", "yarn", "npm"].find((p) => ua.startsWith(p)) ?? "bun";
};
const here = new URL(".", import.meta.url).pathname;
const overlayDir = (t) => join(here, "templates", t);
const readMeta = (t) => JSON.parse(readFileSync(join(overlayDir(t), "template.json"), "utf8"));

/** Steps listed in a template's `add` array, run through the same code as the matching `cf-lite add` command. */
function runAdd(dest, step, log) {
  const [kind, name] = step.split(" ");
  if (kind === "auth") addAuth(dest, log);
  else if (kind === "patterns") addPatterns(dest, log);
  else if (["cron", "queue", "workflow", "email"].includes(kind)) addJob(dest, kind, name, log);
  else throw new Error(`template step "${step}" is not supported`);
}

export async function scaffold(target, { ui, install = false, template: tpl0, kind = "minimal", log = () => {} } = {}) {
  if (!TEMPLATES.includes(kind)) throw new Error(`unknown template "${kind}" (have: ${TEMPLATES.join(", ")})`);
  const meta = kind === "minimal" || kind === "realtime" ? { ui: "none", add: [] } : readMeta(kind);
  ui ??= meta.ui;
  const dest = resolve(target);
  if (existsSync(dest) && readdirSync(dest).length) throw new Error(`${dest} is not empty`);
  const copy = (from) => cpSync(from, dest, { recursive: true, force: true, filter: (p) => !/(^|[\\/])(node_modules|dist|\.cf-lite|\.wrangler)([\\/]|$)/.test(relative(from, p)) }); // relative to the source: an installed package itself lives under node_modules/
  let gitignore = "_gitignore";
  if (kind === "realtime") { // a complete standalone template that ships inside the cf-lite package (WP-REALTIME)
    copy(join(dirname(createRequire(import.meta.url).resolve("cf-lite/add")), "..", "templates", "realtime"));
  } else {
    copy(tpl0 ?? new URL("./template/", import.meta.url).pathname);
    if (kind !== "minimal") { copy(overlayDir(kind)); rmSync(join(dest, "template.json")); } // overlay wins over the base files
  }
  renameSync(join(dest, gitignore), join(dest, ".gitignore")); // npm strips a literal .gitignore from published packages, so templates ship it as _gitignore
  const name = basename(dest).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "cf-lite-app"; // wrangler: lowercase alphanumerics + dashes, no leading/trailing dash
  const edit = (f, fn) => writeFileSync(join(dest, f), fn(readFileSync(join(dest, f), "utf8")));
  edit("package.json", (s) => s.replace(/cf-lite-(app|realtime)/, name).replace(/"\*"/g, '"^0.4.0"'));
  edit("wrangler.jsonc", (s) => s.replace(/cf-lite-(app|realtime)/, name));
  if (ui !== "none") await addUi(dest, ui, { install, log });
  for (const step of meta.add) runAdd(dest, step, log);
  if (install && ui === "none") { // with a UI, addUi already installed (it needs the adapter package on disk)
    const { spawnSync } = await import("node:child_process");
    const pm = packageManager();
    if (spawnSync(pm, ["install"], { cwd: dest, stdio: "inherit" }).status !== 0) throw new Error(`${pm} install failed`);
  }
  return dest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); if (i < 0) return undefined; return args.splice(i, n === "--no-install" ? 1 : 2)[n === "--no-install" ? 0 : 1] ?? true; };
  const noInstall = flag("--no-install") !== undefined;
  const ui = flag("--ui");
  const kind = flag("--template") ?? "minimal";
  const target = args[0];
  if (!target || !TEMPLATES.includes(kind) || (ui !== undefined && !(UIS.includes(ui) || ui.includes("/")))) { console.error(`usage: bun create cf-lite <dir> -- [--template ${TEMPLATES.join("|")}] [--ui ${UIS.join("|")}] [--no-install]`); process.exit(1); }
  const d = await scaffold(target, { ui, kind, install: !noInstall, log: (m) => console.log(m) });
  console.log(`created ${d} (template: ${kind})\n  cd ${target} && ${packageManager()} run dev`);
}
