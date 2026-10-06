/**
 * Versioned codemods for breaking changes. Text-level (regex on the exact shapes cf-lite documented) rather than ts-morph:
 * no heavy dependency in the CLI, and when a file is shaped unusually the codemod reports a manual step instead of guessing.
 * Every codemod is idempotent (run twice = no diff) and pure over a `Fs` so fixtures test before/after.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Fs { read(rel: string): string | null; write(rel: string, body: string): void; list(rel: string, re: RegExp): string[] }
export interface CodemodResult { changed: string[]; manual: string[] }
export interface Codemod {
  id: string;
  /** Applies to apps on a cf-lite version >= from and < to. */
  from: string;
  to: string;
  title: string;
  run(fs: Fs): CodemodResult;
}

export function diskFs(dir: string, dryRun = false, written: Map<string, string> = new Map()): Fs {
  return {
    read: (rel) => written.get(rel) ?? (existsSync(join(dir, rel)) ? readFileSync(join(dir, rel), "utf8") : null),
    write: (rel, body) => { written.set(rel, body); if (!dryRun) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); } },
    list: (rel, re) => {
      const out: string[] = [];
      const walk = (r: string) => { const d = join(dir, r); if (!existsSync(d)) return; for (const n of readdirSync(d)) { if (n === "node_modules" || n.startsWith(".")) continue; const p = join(r, n); if (statSync(join(dir, p)).isDirectory()) walk(p); else if (re.test(p)) out.push(p); } };
      walk(rel);
      return out;
    },
  };
}

const UIS = ["react", "preact", "vue", "svelte", "solid"];
const addImport = (src: string, line: string) => {
  if (src.includes(line)) return src;
  const lines = src.split("\n"); let last = -1;
  lines.forEach((l, i) => { if (/^import\s/.test(l)) last = i; });
  lines.splice(last + 1, 0, line);
  return lines.join("\n");
};

/** 0.2 -> 0.3: `cfLite({ renderer: "react" })` -> `cfLite({ renderer: react() })`; `cf-lite/client` Link/mount -> `@cf-lite/<ui>/client`. */
export const rendererCodemod: Codemod = {
  id: "0.3-renderer", from: "0.0.0", to: "0.3.0", title: 'renderer: "react" -> renderer: react() and client imports moved to @cf-lite/<ui>/client',
  run(fs) {
    const res: CodemodResult = { changed: [], manual: [] };
    let ui: string | undefined;
    for (const f of ["vite.config.ts", "vite.config.mts", "vite.config.js"]) {
      const src = fs.read(f); if (src === null) continue;
      const m = /renderer:\s*["'](react|preact|vue|svelte|solid)["']/.exec(src);
      if (!m) { if (/renderer:\s*["']\w+["']/.test(src) && !/renderer:\s*["']none["']/.test(src)) res.manual.push(`${f}: unknown renderer string - see docs/adapters.md`); continue; }
      ui = m[1];
      const out = addImport(src.replace(m[0], `renderer: ${ui}()`), `import ${ui} from "@cf-lite/${ui}";`);
      fs.write(f, out); res.changed.push(f);
      res.manual.push(`add "@cf-lite/${ui}" to package.json dependencies (cf-lite upgrade does it for you unless --no-install)`);
    }
    if (ui) for (const f of fs.list("app", /\.(tsx?|jsx?|vue|svelte)$/)) {
      const src = fs.read(f)!;
      const out = src.replace(/import\s*\{([^}]*)\}\s*from\s*["']cf-lite\/client["']/g, (whole, names: string) => {
        const moved = names.split(",").map((s) => s.trim()).filter((n) => /^(Link|mount)(\s+as\s+\w+)?$/.test(n));
        const keep = names.split(",").map((s) => s.trim()).filter((n) => n && !moved.includes(n));
        if (!moved.length) return whole;
        return [keep.length ? `import { ${keep.join(", ")} } from "cf-lite/client";` : "", `import { ${moved.join(", ")} } from "@cf-lite/${ui}/client"`].filter(Boolean).join("\n"); // the original `;` still follows the match
      });
      if (out !== src) { fs.write(f, out); res.changed.push(f); }
    }
    return res;
  },
};

/** 0.3 -> 0.4: `modules/sso` lost its built-in issuer/cookie/audience; configuration is now env. Adds the vars to .dev.vars.example and flags what to set. */
export const ssoEnvCodemod: Codemod = {
  id: "0.4-sso-env", from: "0.0.0", to: "0.4.0", title: "modules/sso: configure SSO_ISSUER / SSO_PUBLIC_KEYS (fail closed without them)",
  run(fs) {
    const res: CodemodResult = { changed: [], manual: [] };
    const uses = [...fs.list("server", /\.(ts|tsx|js)$/), ...fs.list("app", /\.(ts|tsx|js)$/)].some((f) => /cf-lite\/modules\/sso/.test(fs.read(f)!));
    if (!uses) return res;
    const ex = fs.read(".dev.vars.example") ?? "";
    const missing = ["SSO_ISSUER", "SSO_PUBLIC_KEYS"].filter((k) => !new RegExp(`^${k}=`, "m").test(ex));
    if (missing.length) {
      const add = `${ex && !ex.endsWith("\n") ? "\n" : ""}# cf-lite 0.4: modules/sso has no built-in issuer/keys any more; a missing value fails closed (401)\n${missing.map((k) => `${k}=`).join("\n")}\n# optional: SSO_AUDIENCE, SSO_COOKIE_NAME, SSO_AUTH_ORIGIN, SSO_REFRESH_AFTER_S\n`;
      fs.write(".dev.vars.example", ex + add); res.changed.push(".dev.vars.example");
    }
    res.manual.push("modules/sso: set SSO_ISSUER and SSO_PUBLIC_KEYS (JWKS or kid map) as secrets/vars in every environment, then `cf-lite secrets push` - no automated path for the values themselves");
    return res;
  },
};

export const CODEMODS: Codemod[] = [rendererCodemod, ssoEnvCodemod];

/** Breaking changes with no codemod: documented on purpose (rule: every breaking change ships a codemod or an explicit "no automated path"). */
export const NO_AUTOMATED_PATH: Array<{ version: string; note: string }> = [];

const parse = (v: string) => v.replace(/^[\^~>=<\s]+/, "").split("-")[0].split(".").map((n) => Number(n) || 0);
export const cmpVersion = (a: string, b: string) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };

/** Codemods to run when moving an app from `current` (its declared cf-lite range) to `target`. */
export const plan = (current: string, target: string) => CODEMODS.filter((c) => cmpVersion(current, c.to) < 0 && cmpVersion(c.to, target) <= 0);
