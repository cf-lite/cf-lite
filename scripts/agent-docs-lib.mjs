// Agent-docs rules for scripts/docs-check.mjs, unit-tested (packages/cf-lite/test/agent-docs.test.ts):
//   decisions    docs/DECISIONS.md entries have every field, a valid date, a role as decider, a known status, existing evidence paths,
//                a superseding entry that exists, and an `active` entry re-checked within STALE_DAYS
//   entry-page   AGENTS.md, CLAUDE.md (exactly `@AGENTS.md`), .github/copilot-instructions.md, agents/README.md, agents/_TEMPLATE.md exist and AGENTS.md leads to agents/README.md
//   agent-briefs every agents/*.md has valid front matter, is listed in agents/README.md, a brief's `verifiedOn` is not older than STALE_DAYS
//   denylist     agent files and the decisions log carry no hosts, IPs, home paths, query-string URLs and none of the terms of the optional external list
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExternalTerms } from "./public-hygiene-lib.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STALE_DAYS = 90;
const FIELDS = ["date", "decided by", "source", "decision", "why", "scope", "evidence", "status", "lastChecked"];
const ROLES = new Set(["owner", "maintainer", "product owner"]);
const STATUS = /^(active|unverified|revoked|superseded by D-\d{3})$/;
const SCOPES = new Set(["core", "reference", "agents", "history"]);
const EVIDENCE = new Set(["verified", "observed-by-human", "guessed", "manual", "estimate", "unverified", "n/a"]);
const DENY = [
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, "IP address"],
  [/\/home\/[a-z]/i, "absolute home path"],
  [/\btailnet\b/i, "private-network name"],
  [/https?:\/\/\S+\?\S+/, "URL with a query string"],
  [/\b[\w-]+\.(?:dpdns\.org|workers\.dev|ts\.net)\b/i, "hostname"],
];
const days = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 864e5);
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  return Object.fromEntries(m[1].split("\n").map((l) => l.match(/^(\w+):\s*(.*?)\s*(?:#.*)?$/)).filter(Boolean).map((x) => [x[1], x[2]]));
}

export function parseDecisions(text) {
  return [...text.matchAll(/^### (D-\d{3}) (.+)\n\|[^\n]*\n\|[^\n]*\n((?:\|.*\n?)+)/gm)].map((m) => ({
    id: m[1], title: m[2],
    fields: Object.fromEntries([...m[3].matchAll(/^\| ([^|]+?) \| (.*) \|$/gm)].map((r) => [r[1], r[2]])),
  }));
}

export function decisionsProblems(text, { exists = (p) => existsSync(join(here, p)), today = Date.now() } = {}) {
  const bad = [], entries = parseDecisions(text), ids = new Set(entries.map((e) => e.id));
  const headings = [...text.matchAll(/^### (D-\d{3}) /gm)].map((m) => m[1]);
  if (headings.length !== entries.length) bad.push(`docs/DECISIONS.md: ${headings.length - entries.length} entry heading(s) not followed by a field table`);
  if (new Set(headings).size !== headings.length) bad.push("docs/DECISIONS.md: duplicate decision id");
  for (const e of entries) {
    const f = e.fields, at = `docs/DECISIONS.md ${e.id}`;
    for (const k of FIELDS) if (!f[k]) bad.push(`${at}: missing field "${k}"`);
    if (f.date && !validDate(f.date)) bad.push(`${at}: date "${f.date}" is not YYYY-MM-DD`);
    if (f["decided by"] && !ROLES.has(f["decided by"])) bad.push(`${at}: "decided by" must be a role (${[...ROLES].join(", ")}), got "${f["decided by"]}"`);
    if (f.status && !STATUS.test(f.status)) bad.push(`${at}: status "${f.status}" is not active|unverified|revoked|superseded by D-nnn`);
    const sup = f.status?.match(/superseded by (D-\d{3})/)?.[1];
    if (sup && !ids.has(sup)) bad.push(`${at}: superseded by ${sup}, which does not exist`);
    if (f.evidence && !/^none\b/.test(f.evidence)) {
      for (const p of [...f.evidence.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((p) => /^[\w.@-]+\/[\w./@-]*$|^[\w-]+\.(md|json|mjs|ts|yml)$/.test(p))) if (!exists(p)) bad.push(`${at}: evidence path "${p}" does not exist`);
    }
    const checked = f.lastChecked?.match(/^(\d{4}-\d{2}-\d{2}) by \S/);
    if (f.lastChecked && !checked) bad.push(`${at}: lastChecked must be "YYYY-MM-DD by <role>"`);
    else if (checked && f.status === "active" && Math.floor((today - Date.parse(checked[1])) / 864e5) > STALE_DAYS) bad.push(`${at}: active but lastChecked ${checked[1]} is older than ${STALE_DAYS} days`);
  }
  return bad;
}

export function briefProblems(name, text, listed, today = Date.now()) {
  const bad = [], fm = frontMatter(text), at = `agents/${name}`;
  if (!fm) return [`${at}: missing front matter`];
  for (const k of ["version", "scope", "evidence", "verifiedOn", "owner"]) if (!fm[k]) bad.push(`${at}: front matter lacks "${k}"`);
  if (fm.scope && fm.scope !== "agents") bad.push(`${at}: scope must be "agents"`);
  if (fm.evidence && !EVIDENCE.has(fm.evidence)) bad.push(`${at}: evidence "${fm.evidence}" is not a known label`);
  if (fm.verifiedOn && !validDate(fm.verifiedOn)) bad.push(`${at}: verifiedOn is not YYYY-MM-DD`);
  else if (fm.verifiedOn && Math.floor((today - Date.parse(fm.verifiedOn)) / 864e5) > STALE_DAYS) bad.push(`${at}: verifiedOn ${fm.verifiedOn} is older than ${STALE_DAYS} days`);
  if (fm.owner && ROLES.has(fm.owner) === false) bad.push(`${at}: owner must be a role, got "${fm.owner}"`);
  if (!["README.md", "_TEMPLATE.md"].includes(name) && !listed.has(name)) bad.push(`${at}: not listed in agents/README.md`);
  return bad;
}

/** `terms`: the optional external list (CF_HYGIENE_TERMS_FILE, see public-hygiene-lib.mjs); each entry is [id, regex, what]. */
export function denyProblems(file, text, terms = loadExternalTerms()) {
  const body = text.replace(/```[\s\S]*?```/g, (b) => (file.endsWith("_TEMPLATE.md") ? "" : b));
  return [...DENY, ...terms.map(([, re, what]) => [re, what])].flatMap(([re, what]) => (re.test(body) ? [`${file}: ${what} in an agent-facing file`] : []));
}

export function agentDocsProblems(root = here) {
  const bad = [], rd = (p) => readFileSync(join(root, p), "utf8");
  for (const f of ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", "agents/README.md", "agents/_TEMPLATE.md", "docs/DECISIONS.md"]) if (!existsSync(join(root, f))) bad.push(`${f}: required file missing`);
  if (bad.length) return bad;
  if (rd("CLAUDE.md").trim() !== "@AGENTS.md") bad.push("CLAUDE.md: must be exactly the line `@AGENTS.md`");
  if (!/agents\/README\.md/.test(rd("AGENTS.md"))) bad.push("AGENTS.md: does not lead to agents/README.md");
  if (!/AGENTS\.md/.test(rd(".github/copilot-instructions.md"))) bad.push(".github/copilot-instructions.md: does not point to AGENTS.md");
  const readme = rd("agents/README.md"), listed = new Set([...readme.matchAll(/\]\(([\w-]+\.md)\)/g)].map((m) => m[1]));
  for (const f of readdirSync(join(root, "agents")).filter((f) => f.endsWith(".md"))) bad.push(...briefProblems(f, rd(`agents/${f}`), listed), ...denyProblems(`agents/${f}`, rd(`agents/${f}`)));
  bad.push(...decisionsProblems(rd("docs/DECISIONS.md")), ...denyProblems("docs/DECISIONS.md", rd("docs/DECISIONS.md")), ...denyProblems("AGENTS.md", rd("AGENTS.md")));
  return bad;
}
