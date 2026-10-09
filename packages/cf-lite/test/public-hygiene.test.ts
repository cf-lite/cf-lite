import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs helpers shared with scripts/docs-check.mjs
import { hygieneMode, hygieneProblemsIn, loadExternalTerms, parseAllowlist, parseTerms, publicHygieneProblems } from "../../../scripts/public-hygiene-lib.mjs";
// @ts-expect-error plain .mjs helper shared with scripts/docs-check.mjs
import { canonicalUrl, checkRepoUrl, setRepoUrl } from "../../../scripts/set-repo-url.mjs";

const repo = join(__dirname, "../../..");
const OLD = "https://github.com/old-owner/cf-lite", NEW = "https://github.com/dummy-org/cf-lite";

describe("public-hygiene rule", () => {
  const hit = (s: string, terms: unknown[] = []) => hygieneProblemsIn("docs/x.md", s, [], terms).join("\n");
  it("the repository itself has 0 findings (generic detection, plus the external list when CF_HYGIENE_TERMS_FILE is set)", () => {
    expect(publicHygieneProblems(repo)).toEqual([]);
  });
  it("flags generic infrastructure shapes", () => {
    expect(hit("cd /home/alice/projects")).toMatch(/home-path/);
    expect(hit("a@build-box.local")).toMatch(/local-email/);
    expect(hit("ssh build-box.local")).toMatch(/local-host/);
    expect(hit("host 100.101.2.3")).toMatch(/private-network/);
    expect(hit("host 192.168.1.20")).toMatch(/private-network/);
    expect(hit("https://box.tail1234.ts.net/x")).toMatch(/private-network/);
    expect(hit("Co-authored-by: Someone <s@example.com>")).toMatch(/co-author/);
    expect(hit("token " + "ghp_" + "a".repeat(36))).toMatch(/secret-shape/);
    expect(hit("key " + "AKIA" + "A".repeat(16))).toMatch(/secret-shape/);
    expect(hit("-----BEGIN " + "RSA PRIVATE KEY-----")).toMatch(/secret-shape/);
  });
  it("leaves ordinary text alone", () => {
    expect(hit("A lane of traffic; 100.0.0.1 is public; the *.local mDNS suffix is refused; /home/user/app; orchestration of builds; sk-learn")).toBe("");
  });
  it("applies the optional external term list: synthetic terms, whole words, regex lines, comments", () => {
    const terms = parseTerms("# comment\nzorblax\nre:\\bquux-\\d+\n");
    expect(terms).toHaveLength(2);
    expect(hit("see Zorblax now", terms)).toMatch(/term/);
    expect(hit("quux-42", terms)).toMatch(/term/);
    expect(hit("zorblaxes and quux-x", terms)).toBe("");
    expect(hit("see Zorblax now")).toBe("");
  });
  it("loads the list from CF_HYGIENE_TERMS_FILE and reports the mode", () => {
    const d = mkdtempSync(join(tmpdir(), "terms-"));
    try {
      const f = join(d, "terms.txt");
      writeFileSync(f, "zorblax\nquux\n");
      expect(loadExternalTerms({ CF_HYGIENE_TERMS_FILE: f })).toHaveLength(2);
      expect(hygieneMode({ CF_HYGIENE_TERMS_FILE: f })).toMatch(/external term list \(2 terms\)/);
      expect(hygieneMode({})).toMatch(/generic detection only/);
      expect(loadExternalTerms({ CF_HYGIENE_TERMS_FILE: join(d, "missing") })).toEqual([]);
      expect(hygieneMode({ CF_HYGIENE_TERMS_FILE: join(d, "missing") })).toMatch(/does not exist/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("honours the allowlist, and requires a reason and a known rule", () => {
    const { entries, bad } = parseAllowlist("# c\n.github/workflows/*.yml | term | runner label\npackages/*/LICENSE | term\nx | nonsense | why\n");
    expect(bad).toHaveLength(2);
    const terms = parseTerms("zorblax");
    expect(hygieneProblemsIn(".github/workflows/ci.yml", "runs-on: zorblax", entries, terms)).toEqual([]);
    expect(hygieneProblemsIn("docs/ci.md", "runs-on: zorblax", entries, terms)).toHaveLength(1);
  });
});

describe("set-repo-url", () => {
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), "setrepo-"));
    mkdirSync(join(d, "packages/cf-lite"), { recursive: true });
    const files: Record<string, string> = {
      "README.md": `see ${OLD}/blob/main/docs/x.md and ${OLD}-other/x and https://github.com/old-owner/cf-lite-docs\n`,
      "llms.txt": `- [A](${OLD}/blob/main/a.md)\n`,
    };
    for (const p of ["cf-lite", "create-cf-lite", "preact", "react", "svelte", "vue"]) {
      mkdirSync(join(d, "packages", p), { recursive: true });
      files[`packages/${p}/package.json`] = JSON.stringify({ name: p, homepage: `${OLD}#readme`, bugs: { url: `${OLD}/issues` }, repository: { type: "git", url: `git+${OLD}.git` } }, null, 2) + "\n";
    }
    for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
    execFileSync("git", ["init", "-q"], { cwd: d });
    execFileSync("git", ["add", "-A"], { cwd: d });
    return d;
  };
  it("--check passes on a consistent tree and fails after a partial move", () => {
    const d = mk();
    try {
      expect(canonicalUrl(d)).toBe(OLD);
      expect(checkRepoUrl(d)).toEqual([]);
      writeFileSync(join(d, "README.md"), `${NEW}/x\n`);
      expect(checkRepoUrl(d).join("\n")).toMatch(/README\.md:1: link to .*dummy-org/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("rewrites package.json fields and links, leaves look-alike names alone, and is idempotent", () => {
    const d = mk();
    try {
      expect(setRepoUrl(d, NEW, { dryRun: true }).length).toBe(8);
      expect(readFileSync(join(d, "README.md"), "utf8")).toContain(OLD);
      expect(setRepoUrl(d, NEW).length).toBe(8);
      expect(checkRepoUrl(d, NEW)).toEqual([]);
      const j = JSON.parse(readFileSync(join(d, "packages/vue/package.json"), "utf8"));
      expect([j.homepage, j.bugs.url, j.repository.url]).toEqual([`${NEW}#readme`, `${NEW}/issues`, `git+${NEW}.git`]);
      expect(readFileSync(join(d, "README.md"), "utf8")).toContain(`${OLD}-other/x`);
      expect(setRepoUrl(d, NEW)).toEqual([]);
      expect(() => setRepoUrl(d, "http://example.com/x")).toThrow(/not an https/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("the repository itself is consistent", () => {
    expect(checkRepoUrl(repo)).toEqual([]);
  });
});
