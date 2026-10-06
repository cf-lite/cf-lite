#!/usr/bin/env node
// Worker size budget gate (docs/rc-status.md gate 2.3).
//   node scripts/size-budget.mjs            # check against bench/module-sizes.json; exit 1 on regression
//   node scripts/size-budget.mjs --update   # re-measure and rewrite the baseline (review the diff!)
//   node scripts/size-budget.mjs --modules-only   # skip the example builds (fast)
// Measures gzip bytes: (a) each cf-lite/modules/* entry bundled alone, (b) the built Worker of each example app
// (same numbers as `cf-lite analyze`). Budget = baseline * (1 + slackPct/100) + slackBytes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { moduleNames, moduleBytes, baselineBytes } from "./size-budget-lib.mjs";

const root = new URL("../", import.meta.url).pathname;
const file = root + "bench/module-sizes.json";
const update = process.argv.includes("--update"), modulesOnly = process.argv.includes("--modules-only");
const SLACK = { pct: 5, bytes: 256 };
const cli = root + "packages/cf-lite/dist/cli.js";

async function exampleWorkerGzip(dir) {
  const cwd = root + "examples/" + dir;
  if (!existsSync(cwd + "/wrangler.jsonc")) return null;
  if (!JSON.parse(readFileSync(cwd + "/package.json", "utf8")).dependencies?.["cf-lite"]) return null; // not a cf-lite app (e.g. the standalone site-rsc spike)
  const b = spawnSync(process.execPath, [cli, "build"], { cwd, encoding: "utf8" });
  if (b.status !== 0) throw new Error(`build failed: ${dir}\n${b.stdout}${b.stderr}`);
  const { analyze } = await import(root + "packages/cf-lite/dist/analyze.js");
  return analyze(cwd).worker?.gzipTotal ?? null;
}

const measured = { base: await baselineBytes(), modules: {}, examples: {} };
for (const m of moduleNames()) measured.modules[m] = await moduleBytes(m);
if (!modulesOnly) {
  const { readdirSync } = await import("node:fs");
  for (const d of readdirSync(root + "examples").sort()) { const g = await exampleWorkerGzip(d); if (g != null) measured.examples[d] = g; }
}

if (update) {
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const out = { _doc: "gzip bytes; regenerate with `node scripts/size-budget.mjs --update`. Gate fails when measured > baseline*(1+slack.pct/100)+slack.bytes (docs/performance-budgets.md)", slack: SLACK, base: measured.base, modules: measured.modules, examples: modulesOnly ? prev.examples ?? {} : measured.examples };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log("wrote", file); process.exit(0);
}

const bl = JSON.parse(readFileSync(file, "utf8"));
const limit = (b) => Math.ceil(b * (1 + bl.slack.pct / 100) + bl.slack.bytes);
const fails = [];
const row = (kind, name, got, base) => {
  const lim = base == null ? null : limit(base);
  const bad = base == null ? true : got > lim;
  console.log(`${bad ? "FAIL" : "ok  "} ${kind.padEnd(7)} ${name.padEnd(18)} ${String(got).padStart(7)} B  (baseline ${base ?? "MISSING"}, limit ${lim ?? "-"})`);
  if (bad) fails.push(`${kind} ${name}: ${got} > ${lim ?? "no baseline (run --update)"}`);
};
row("base", "empty-worker", measured.base, bl.base);
for (const [m, g] of Object.entries(measured.modules)) row("module", m, g, bl.modules[m]);
for (const [d, g] of Object.entries(measured.examples)) row("example", d, g, bl.examples[d]);
if (fails.length) { console.error("\nSize budget exceeded:\n" + fails.map((f) => "  " + f).join("\n") + "\nIf intentional, run `node scripts/size-budget.mjs --update` and justify in the PR."); process.exit(1); }
console.log("\nsize budget ok");
