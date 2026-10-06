// Writes llms.txt at the repo root from docs/*.md. `--check` (CI) fails when the committed file is stale. bun run llms:gen | llms:check
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildLlms, root } from "./llms-lib.mjs";

const target = join(root, "llms.txt"), next = buildLlms();
if (process.argv.includes("--check")) {
  if (!existsSync(target) || readFileSync(target, "utf8") !== next) { console.error("llms.txt is stale: run `bun run llms:gen` and commit it"); process.exit(1); }
  console.log("llms-check: llms.txt is up to date");
} else { writeFileSync(target, next); console.log(`llms.txt written (${next.split("\n").length} lines)`); }
