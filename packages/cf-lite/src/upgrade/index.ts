/** `cf-lite upgrade [--to x.y.z] [--dry-run] [--no-install]`: bump cf-lite packages, run the versioned codemods, print manual steps. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEMODS, cmpVersion, diskFs, plan, type CodemodResult } from "./codemods.js";

export interface UpgradeOptions { to: string; dryRun?: boolean; install?: boolean; log?: (m: string) => void }
export interface UpgradeResult { from: string | null; to: string; ran: string[]; changed: string[]; manual: string[] }

export function upgrade(dir: string, o: UpgradeOptions): UpgradeResult {
  const log = o.log ?? (() => {});
  const pjPath = join(dir, "package.json");
  if (!existsSync(pjPath)) throw new Error("cf-lite upgrade: no package.json here");
  const pj = JSON.parse(readFileSync(pjPath, "utf8"));
  const current: string | undefined = pj.dependencies?.["cf-lite"] ?? pj.devDependencies?.["cf-lite"];
  if (!current) throw new Error("cf-lite upgrade: cf-lite is not a dependency of this app");
  const codemods = plan(current, o.to);
  const res: UpgradeResult = { from: current, to: o.to, ran: [], changed: [], manual: [] };
  const written = new Map<string, string>();
  const fs = diskFs(dir, o.dryRun, written);
  for (const c of codemods) {
    const r: CodemodResult = c.run(fs);
    res.ran.push(c.id); res.changed.push(...r.changed); res.manual.push(...r.manual);
    log(`${o.dryRun ? "would run" : "ran"} ${c.id}: ${c.title}${r.changed.length ? ` (${r.changed.join(", ")})` : " (nothing to change)"}`);
  }
  // package bumps last, from the (possibly codemod-updated) package.json; never downgrade
  const after = JSON.parse(readFileSync(pjPath, "utf8"));
  let bumped = false;
  for (const f of ["dependencies", "devDependencies"]) for (const k of Object.keys(after[f] ?? {})) {
    if ((k === "cf-lite" || k.startsWith("@cf-lite/")) && /^[\^~]?\d/.test(after[f][k]) && cmpVersion(after[f][k], o.to) < 0) { after[f][k] = `^${o.to}`; bumped = true; }
  }
  if (bumped) {
    res.changed.push("package.json");
    if (!o.dryRun) writeFileSync(pjPath, JSON.stringify(after, null, 2) + "\n");
    log(`${o.dryRun ? "would bump" : "bumped"} cf-lite packages to ^${o.to}`);
    if (!o.dryRun && o.install !== false) {
      const pm = existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : existsSync(join(dir, "bun.lock")) ? "bun" : "npm";
      log(`${pm} install`);
      if (spawnSync(pm, ["install"], { cwd: dir, stdio: "inherit" }).status !== 0) throw new Error(`${pm} install failed`);
    }
  }
  res.changed = [...new Set(res.changed)];
  for (const m of res.manual) log(`manual: ${m}`);
  if (!res.ran.length && !bumped) log(`already up to date for ${o.to}`);
  return res;
}
export { CODEMODS };
