// Docs lint: every relative link in docs/*.md, README.md, CHANGELOG.md must resolve to a file, and every #anchor must
// match a heading in the target page. Run: bun scripts/docs-check.mjs   (bun run docs:check)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codeDrift } from "./llms-lib.mjs";
import { agentDocsProblems } from "./agent-docs-lib.mjs";
import { publicHygieneProblems, hygieneMode } from "./public-hygiene-lib.mjs";
import { checkRepoUrl } from "./set-repo-url.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`), "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md", ...readdirSync(join(root, "agents")).filter((f) => f.endsWith(".md")).map((f) => `agents/${f}`)];
const slug = (h) => h.toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/ /g, "-");
const anchors = (p) => new Set([...readFileSync(p, "utf8").replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));

const bad = [];
for (const f of files) {
  const text = readFileSync(join(root, f), "utf8").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^([a-z]+:|\/\/)/i.test(href)) continue;
    const [path, hash] = href.split("#");
    const target = path ? resolve(root, dirname(f), path) : join(root, f);
    if (path && !existsSync(target)) { bad.push(`${f}: missing file ${href}`); continue; }
    if (hash && target.endsWith(".md") && !anchors(target).has(hash)) bad.push(`${f}: missing anchor ${href}`);
  }
}
// CHANGELOG.md is history: a range there was true for its release
bad.push(...codeDrift(files.filter((f) => f !== "CHANGELOG.md").map((f) => [f, readFileSync(join(root, f), "utf8")])));
// Bun rewrites `npm run` inside scripts to `bun run`, which has no -w: the script would re-invoke itself forever (docs/bun-first.md)
for (const dir of ["", "packages", "examples"]) {
  const pkgs = dir ? readdirSync(join(root, dir)).map((d) => join(dir, d, "package.json")) : ["package.json", "site/package.json"];
  for (const f of pkgs) {
    if (!existsSync(join(root, f))) continue;
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(root, f), "utf8")).scripts ?? {})) if (/\bnpm (run|test)\b.* -w\b/.test(v)) bad.push(`${f}: script "${k}" uses \`npm run ... -w\` (fork bomb under Bun); use \`bun run --filter <pkg> <script>\``);
  }
}
bad.push(...agentDocsProblems());
// public-hygiene: no operating-setup or infrastructure terms anywhere tracked; set-repo-url --check: every repository link and package.json field agrees (scripts/set-repo-url.mjs)
bad.push(...publicHygieneProblems(), ...checkRepoUrl());
console.log(`docs-check: public-hygiene ran with ${hygieneMode()}`);
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log(`docs-check: ${files.length} files, all relative links and anchors resolve, CFL ranges match doctor.ts`);
