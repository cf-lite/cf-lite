// Rewrite every absolute link to this repository (and the package.json repository / bugs / homepage fields) when the repository moves.
//   bun scripts/set-repo-url.mjs <https://github.com/owner/repo>     rewrite in place (tracked text files only)
//   bun scripts/set-repo-url.mjs --check [<url>]                      exit 1 when a tracked file links to a different URL of this repository
//                                                                     (no <url>: the canonical URL is packages/cf-lite/package.json repository.url)
//   bun scripts/set-repo-url.mjs <url> --dry-run                      list the files that would change
// Used by scripts/docs-check.mjs in --check mode; the publication checklist is kept outside this repository.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED = ["cf-lite", "create-cf-lite", "preact", "react", "solid", "svelte", "vue"];
const REPO_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;
const SKIP = new Set(["bun.lock", "scripts/set-repo-url.mjs", "packages/cf-lite/test/public-hygiene.test.ts"]);

const readJson = (root, p) => JSON.parse(readFileSync(join(root, p), "utf8"));

export function canonicalUrl(root = here) {
  const u = readJson(root, "packages/cf-lite/package.json").repository?.url ?? "";
  return u.replace(/^git\+/, "").replace(/\.git$/, "");
}

function textFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 1 << 28 }).toString().split("\0").filter((f) => f && !SKIP.has(f) && existsSync(join(root, f))).flatMap((f) => {
    const buf = readFileSync(join(root, f));
    return buf.length > 4e6 || buf.includes(0) ? [] : [[f, buf.toString("utf8")]];
  });
}

/** Every `https://github.com/<owner>/<repo-name>` link, where <repo-name> is this repository's name, whatever the owner. */
const linkRe = (name) => new RegExp(`https://github\\.com/[\\w.-]+/${name.replace(/[.+*?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");

export function checkRepoUrl(root = here, url = canonicalUrl(root)) {
  if (!REPO_RE.test(url)) return [`set-repo-url: "${url}" is not an https://github.com/<owner>/<repo> URL`];
  const bad = [], name = url.split("/").pop();
  for (const p of PUBLISHED) {
    const j = readJson(root, `packages/${p}/package.json`);
    const want = { "repository.url": `git+${url}.git`, "bugs.url": `${url}/issues`, homepage: `${url}#readme` };
    const got = { "repository.url": j.repository?.url, "bugs.url": j.bugs?.url, homepage: j.homepage };
    for (const k of Object.keys(want)) if (got[k] !== want[k]) bad.push(`packages/${p}/package.json: ${k} is ${JSON.stringify(got[k])}, expected ${JSON.stringify(want[k])}`);
  }
  for (const [f, text] of textFiles(root)) {
    text.split("\n").forEach((line, i) => { for (const m of line.matchAll(linkRe(name))) if (m[0] !== url) bad.push(`${f}:${i + 1}: link to ${m[0]}, expected ${url} (bun scripts/set-repo-url.mjs ${url})`); });
  }
  return bad;
}

export function setRepoUrl(root, url, { dryRun = false } = {}) {
  if (!REPO_RE.test(url)) throw new Error(`"${url}" is not an https://github.com/<owner>/<repo> URL`);
  const name = url.split("/").pop(), changed = [];
  for (const [f, text] of textFiles(root)) {
    const next = text.replace(linkRe(name), url);
    if (next !== text) { changed.push(f); if (!dryRun) writeFileSync(join(root, f), next); }
  }
  // package.json fields that are not written as a plain github.com URL are covered above (`git+https://...git`, `/issues`, `#readme` all contain it)
  return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), flag = (f) => args.includes(f), url = args.find((a) => !a.startsWith("--"));
  const root = here;
  if (flag("--check")) {
    const bad = checkRepoUrl(root, url);
    if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
    console.log(`set-repo-url --check: every link and package.json field points to ${url ?? canonicalUrl(root)}`);
  } else if (!url) {
    console.error("usage: bun scripts/set-repo-url.mjs <https://github.com/owner/repo> [--dry-run] | --check [<url>]"); process.exit(2);
  } else {
    const files = setRepoUrl(root, url, { dryRun: flag("--dry-run") });
    console.log(`${flag("--dry-run") ? "would change" : "changed"} ${files.length} file(s)${files.length ? ":\n" + files.map((f) => `  ${f}`).join("\n") : ""}`);
    if (!flag("--dry-run")) { const bad = checkRepoUrl(root, url); if (bad.length) { console.error(bad.join("\n")); process.exit(1); } console.log("check passed; now run: bun run llms:gen && bun run docs:check (llms.txt is generated from scripts/llms-lib.mjs)"); }
  }
}
