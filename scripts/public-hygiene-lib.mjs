// Rule `public-hygiene` for scripts/docs-check.mjs, unit-tested (packages/cf-lite/test/public-hygiene.test.ts).
// Fails on infrastructure shapes (token/key shapes, home paths, internal hosts, private addresses, co-author trailers) and, when CF_HYGIENE_TERMS_FILE
// names an external list, on every term of that list, in everything tracked by git. Justified exceptions live in scripts/public-hygiene.allow.
// Allowlist line: `<path glob> | <rule id> | <reason>` (`*` within a segment, `**` any depth); `#` starts a comment; the reason is mandatory.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");

// Generic detection only: shapes that never belong in a public repository. Project- or host-specific words are NOT listed here; they come from
// an optional external list (see loadExternalTerms), so this file does not spell any of them.
export const RULES = [
  ["secret-shape", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{20,}|npm_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{24,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/, "token, key or JWT shape"],
  ["home-path", /\/home\/(?!user\b|dev\b|me\b|app\b|runner\b|node\b)[a-z][\w.-]*/i, "absolute home path"],
  ["local-host", /\b[a-z][\w-]*(?:-\d+)?\.(?:local|lan|corp|home\.arpa)\b/i, "internal host name (*.local and similar)"],
  ["local-email", /[\w.+-]+@[\w-]+\.(?:local|invalid|lan|corp)\b/i, "internal e-mail address"],
  ["private-network", /\b[\w-]+\.ts\.net\b|\btailnet\b|\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/i, "private-network name or address"],
  ["co-author", /^\s*Co-authored-by:/i, "co-author trailer"],
];

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Optional external term list: the file named by env CF_HYGIENE_TERMS_FILE (kept outside this repository). One term per line, `#` starts a
 * comment, a line `re:<pattern>` is a regular expression, anything else is a case-insensitive literal matched as a whole word.
 * Returns [] when the variable is unset, or the file cannot be read (callers print the mode, see hygieneMode).
 */
export function loadExternalTerms(env = process.env) {
  const path = env.CF_HYGIENE_TERMS_FILE;
  if (!path || !existsSync(path)) return [];
  return parseTerms(readFileSync(path, "utf8"));
}

export function parseTerms(text) {
  return text.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "").trim()).filter(Boolean).map((t) => {
    const re = t.startsWith("re:") ? new RegExp(t.slice(3), "i") : new RegExp(`(?<![\\w-])${escapeRe(t)}(?![\\w-])`, "i");
    return ["term", re, "term from the external hygiene list"];
  });
}

/** One line for docs:check output: which detection ran. */
export function hygieneMode(env = process.env) {
  const path = env.CF_HYGIENE_TERMS_FILE, n = loadExternalTerms(env).length;
  if (!path) return "generic detection only (CF_HYGIENE_TERMS_FILE not set: no external term list)";
  if (!existsSync(path)) return "generic detection only (CF_HYGIENE_TERMS_FILE is set but the file does not exist)";
  return `generic detection + external term list (${n} terms)`;
}

const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");

export function parseAllowlist(text) {
  const entries = [], bad = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    const [glob, rule, ...why] = line.split("|").map((s) => s.trim());
    if (!glob || !rule || !why.join("").trim()) bad.push(`scripts/public-hygiene.allow:${i + 1}: need "<path glob> | <rule id> | <reason>"`);
    else if (rule !== "*" && rule !== "term" && !RULES.some(([id]) => id === rule)) bad.push(`scripts/public-hygiene.allow:${i + 1}: unknown rule "${rule}"`);
    else entries.push({ re: globRe(glob), rule });
  });
  return { entries, bad };
}

// Scanning is skipped for this rule's own definition, its allowlist and its test.
const SELF = new Set(["scripts/public-hygiene-lib.mjs", "scripts/public-hygiene.allow", "packages/cf-lite/test/public-hygiene.test.ts", "bun.lock"]);

export function trackedFiles(root = here) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 1 << 28 }).toString().split("\0").filter(Boolean).filter((f) => !SELF.has(f) && existsSync(join(root, f)));
}

export function hygieneProblemsIn(file, text, allow = [], terms = []) {
  const bad = [];
  text.split("\n").forEach((line, i) => {
    for (const [id, re, what] of [...RULES, ...terms]) {
      if (!re.test(line) || allow.some((a) => (a.rule === "*" || a.rule === id) && a.re.test(file))) continue;
      bad.push(`${file}:${i + 1}: public-hygiene ${id}: ${what} (${re.exec(line)[0]})`);
    }
  });
  return bad;
}

export function publicHygieneProblems(root = here, terms = loadExternalTerms()) {
  const allowPath = join(root, "scripts/public-hygiene.allow");
  const { entries, bad } = parseAllowlist(existsSync(allowPath) ? readFileSync(allowPath, "utf8") : "");
  for (const f of trackedFiles(root)) {
    let buf;
    try { buf = readFileSync(join(root, f)); } catch { continue; }
    if (buf.length > 2e6 || buf.includes(0)) continue;
    bad.push(...hygieneProblemsIn(f, buf.toString("utf8"), entries, terms));
  }
  return bad;
}
