/**
 * `cf-lite doctor --fix`: the SAFE subset of findings, applied as plain file edits (never installs, never calls wrangler,
 * never touches a value you set). Everything else stays a finding with its `fix:` text.
 *   CFL003  compatibility_date missing  -> today's date
 *   CFL006  Env members with no declaration -> listed (empty) in .dev.vars.example
 *   CFL011  D1 binding without migrations dir -> migrations/0001_init.sql (an empty, commented migration)
 *   CFL012  draft on, DRAFT_SECRET undeclared -> DRAFT_SECRET= in .dev.vars.example
 * Idempotent: a second run changes nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { declaredBindings, envTypeKeys, type Finding } from "./doctor.js";
import { nextMigrationNumber } from "./cli-db.js";
import { parseJsonc, setIfMissing } from "./wrangler-edit.js";

export const FIXABLE = ["CFL003", "CFL006", "CFL011", "CFL012"] as const;

export function doctorFix(dir: string, findings: Finding[], log: (m: string) => void = () => {}, now = new Date()): string[] {
  const done: string[] = [];
  const codes = new Set(findings.map((f) => f.code));
  const wp = ["wrangler.jsonc", "wrangler.json"].map((f) => join(dir, f)).find(existsSync);
  if (!wp) return done;
  const text = readFileSync(wp, "utf8");
  const cfg = parseJsonc<any>(text);
  const example = join(dir, ".dev.vars.example");
  const addVars = (names: string[], note: string) => {
    const cur = existsSync(example) ? readFileSync(example, "utf8") : "";
    const fresh = names.filter((n) => !new RegExp(`^\\s*${n}\\s*=`, "m").test(cur));
    if (!fresh.length) return;
    writeFileSync(example, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + `# ${note}\n` + fresh.map((n) => `${n}=\n`).join(""));
    done.push(`.dev.vars.example: + ${fresh.join(", ")}`);
  };

  if (codes.has("CFL003") && cfg.compatibility_date === undefined) {
    const r = setIfMissing(text, "compatibility_date", now.toISOString().slice(0, 10));
    if (r.changed) { writeFileSync(wp, r.text); done.push(`${wp.slice(dir.length + 1)}: + compatibility_date`); }
  }
  if (codes.has("CFL006")) {
    const declared = declaredBindings(cfg);
    const extra = [...envTypeKeys(dir).keys].filter((k) => !declared.has(k) && !/^[a-z]/.test(k));
    if (extra.length) addVars(extra, "secrets used by the Worker: set locally in .dev.vars, push with `cfl secrets push`");
  }
  if (codes.has("CFL011")) {
    for (const d of (cfg.d1_databases ?? []) as Array<{ binding: string; migrations_dir?: string }>) {
      const rel = d.migrations_dir ?? "migrations";
      if (existsSync(join(dir, rel))) continue;
      mkdirSync(join(dir, rel), { recursive: true });
      const file = `${rel}/${nextMigrationNumber([])}_init.sql`;
      writeFileSync(join(dir, file), `-- ${d.binding}: initial migration. Add CREATE TABLE statements, then \`cfl db apply\`.\n`);
      done.push(`${file}: created`);
    }
  }
  if (codes.has("CFL012")) addVars(["DRAFT_SECRET"], "draft mode: `openssl rand -base64 32` (>= 32 chars); `cfl secrets push` for production");
  done.forEach((d) => log(`  fixed  ${d}`));
  return done;
}
