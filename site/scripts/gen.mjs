// Build-time content step: ../docs/*.md + README + CHANGELOG -> .content/<slug>.json (html, toc) + public/search-index.json.
// Markdown -> HTML and syntax highlighting (shiki) happen here, in Node, at build time. Nothing of this ships to the browser.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import MarkdownIt from "markdown-it";
import { createHighlighter } from "shiki";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "site", ".content");
mkdirSync(out, { recursive: true });
const read = (p) => readFileSync(join(root, p), "utf8");

// --- sources -> pages ---------------------------------------------------------------------------
const readme = read("README.md");
const sections = new Map();
{ // README split on "## " headings
  const parts = readme.split(/^## /m).slice(1);
  for (const p of parts) { const nl = p.indexOf("\n"); sections.set(p.slice(0, nl).trim(), p.slice(nl + 1)); }
}
const pick = (...names) => names.map((n) => {
  const k = [...sections.keys()].find((x) => x.startsWith(n));
  if (!k) throw new Error("README section missing: " + n);
  return `## ${k}\n${sections.get(k)}`;
}).join("\n");

const shift = (md) => md.replace(/^(#{2,5}) /gm, (_m, h) => h + "# "); // demote headings one level (used where two docs merge)
const stripH1 = (md) => { const m = md.match(/^# (.+)\n/); return { title: m ? m[1].replace(/`/g, "") : "", body: m ? md.slice(m[0].length) : md }; };

const PAGES = [
  { slug: "getting-started", group: "Start", title: "Getting started", desc: "Scaffold a cf-lite app, pick a UI adapter, and deploy to Cloudflare Workers.",
    md: pick("What cf-lite is", "60-second quickstart", "Adapters", "Repo layout", "Tests and contributing") },
  { slug: "migration-from-nextjs", group: "Start", ...(() => { const d = stripH1(read("docs/migration-from-nextjs.md")); return { title: d.title, md: d.body }; })(), desc: "Map Next.js App Router concepts onto cf-lite, what is not supported, and how to port a page." },
  { slug: "recipes", group: "Start", ...(() => { const d = stripH1(read("docs/recipes.md")); return { title: d.title, md: d.body }; })(), desc: "Short solutions to common tasks, each linked to its reference page." },
  { slug: "design", group: "Reference", ...(() => { const d = stripH1(read("docs/design.md")); return { title: "Design", md: d.body }; })(), desc: "How cf-lite is built: request flow, file conventions, render modes, head, layouts, and what it deliberately leaves out." },
  { slug: "adapters", group: "Reference", ...(() => { const d = stripH1(read("docs/adapters.md")); return { title: "Adapters", md: d.body }; })(), desc: "The UI adapter contract, the adapters that ship, and why cf-lite does not use Vike." },
  { slug: "benchmarks", group: "Evidence", title: "Benchmarks", desc: "Measured against Next + OpenNext and vinext on real workers.dev Workers, with the caveats up front.",
    md: pick("Benchmarks") },
  { slug: "field-notes", group: "Evidence", ...(() => { const d = stripH1(read("docs/field-notes.md")); return { title: "Field notes", md: d.body }; })(), desc: "Gaps and friction found by real use, and how each was resolved." },
  { slug: "upgrading", group: "Evidence", title: "Upgrading", desc: "Breaking changes between 0.x releases.", md: pick("Upgrading from 0.3", "Upgrading from 0.2") },
  { slug: "changelog", group: "Evidence", ...(() => { const d = stripH1(read("CHANGELOG.md")); return { title: "Changelog", md: d.body }; })(), desc: "Release history of cf-lite." },
];
// page-level intro tweaks
PAGES.find((p) => p.slug === "benchmarks").md = PAGES.find((p) => p.slug === "benchmarks").md.replace(/^## Benchmarks[^\n]*\n/, "");
PAGES.find((p) => p.slug === "upgrading").md = shift(PAGES.find((p) => p.slug === "upgrading").md).replace(/^### /gm, "## ");

// links between sources -> site routes; other repo paths are not public (private repo) so they degrade to plain code
const LINKS = { "docs/design.md": "/docs/design/", "design.md": "/docs/design/", "docs/adapters.md": "/docs/adapters/", "adapters.md": "/docs/adapters/",
  "docs/field-notes.md": "/docs/field-notes/", "field-notes.md": "/docs/field-notes/", "docs/migration-from-nextjs.md": "/docs/migration-from-nextjs/", "migration-from-nextjs.md": "/docs/migration-from-nextjs/", "docs/recipes.md": "/docs/recipes/", "recipes.md": "/docs/recipes/", "CHANGELOG.md": "/docs/changelog/" };
const SLUG = Object.fromEntries(PAGES.map((p) => [p.slug, p]));

// --- markdown-it + shiki -------------------------------------------------------------------------
const LANGS = ["bash", "ts", "tsx", "js", "json", "jsonc", "toml", "html", "css", "yaml", "diff", "vue", "svelte"];
const hl = await createHighlighter({ themes: ["github-light-high-contrast", "github-dark-high-contrast"], langs: LANGS });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const slugify = (s) => s.toLowerCase().replace(/<[^>]+>/g, "").replace(/[`'’"]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function render(md) {
  const toc = [];
  const used = new Set();
  const m = new MarkdownIt({ html: false, linkify: false, typographer: false });
  m.options.highlight = undefined;
  m.renderer.rules.fence = (tokens, i) => {
    const t = tokens[i];
    let lang = (t.info || "").trim().split(/\s+/)[0] || "text";
    if (lang === "sh" || lang === "shell") lang = "bash";
    const code = t.content.replace(/\n$/, "");
    if (!LANGS.includes(lang)) return `<pre class="shiki plain" tabindex="0"><code>${esc(code)}</code></pre>\n`;
    return hl.codeToHtml(code, { lang, themes: { light: "github-light-high-contrast", dark: "github-dark-high-contrast" }, defaultColor: false })
      .replace("<pre ", '<pre tabindex="0" ');
  };
  m.renderer.rules.table_open = () => '<div class="tbl" role="region" tabindex="0"><table>\n';
  m.renderer.rules.table_close = () => "</table></div>\n";
  m.renderer.rules.heading_open = (tokens, i) => {
    const t = tokens[i], text = tokens[i + 1].children.map((c) => c.content).join("");
    let id = slugify(text) || "section"; const base = id; let n = 2; while (used.has(id)) id = `${base}-${n++}`; used.add(id);
    const level = +t.tag.slice(1);
    if (level === 2 || level === 3) toc.push({ level, id, text });
    return `<${t.tag} id="${id}">`;
  };
  m.renderer.rules.heading_close = (tokens, i) => {
    // find the id of the matching open tag for the permalink
    let j = i; while (tokens[j].type !== "heading_open") j--;
    return `<a class="anchor" href="#${esc(tokens[j].attrGet("id") ?? "")}" aria-label="Link to this section">#</a></${tokens[i].tag}>`;
  };
  const defLink = m.renderer.rules.link_open;
  m.renderer.rules.link_open = (tokens, i, o, env, self) => {
    const t = tokens[i]; let href = t.attrGet("href") ?? "";
    if (!/^(https?:|mailto:|#|\/)/.test(href)) {
      const [file, hash] = href.replace(/^\.\//, "").split("#");
      const target = LINKS[file];
      if (target) href = target + (hash ? "#" + hash : "");
      else { // not published: render as a non-link, and close it in link_close
        t.meta = { dead: true };
        return '<span class="repo-path" title="Path in the (private) repo, not published here">';
      }
    } else if (/^https?:/.test(href)) { t.attrSet("rel", "noopener"); }
    t.attrSet("href", href);
    return defLink ? defLink(tokens, i, o, env, self) : self.renderToken(tokens, i, o);
  };
  m.renderer.rules.link_close = (tokens, i, o, env, self) => {
    let j = i; while (tokens[j].type !== "link_open") j--;
    return tokens[j].meta?.dead ? "</span>" : self.renderToken(tokens, i, o);
  };
  return { html: m.render(md).replace(/<th><\/th>/g, `<th><span class="sr">Item</span></th>`), toc };
}

// --- emit ---------------------------------------------------------------------------------------
const plain = (html) => html.replace(/<pre[\s\S]*?<\/pre>/g, " ").replace(/<a class="anchor"[\s\S]*?<\/a>/g, "").replace(/<\/?(code|em|strong|a|span)\b[^>]*>/g, "").replace(/<[^>]+>/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const index = [];
for (const p of PAGES) {
  const { html, toc } = render(p.md);
  writeFileSync(join(out, p.slug + ".json"), JSON.stringify({ slug: p.slug, title: p.title, desc: p.desc, html, toc }));
  // search index: one entry per h2/h3 section (first ~600 chars of text)
  const chunks = html.split(/(?=<h[23] id=)/);
  for (const c of chunks) {
    const id = c.match(/^<h[23] id="([^"]+)"/)?.[1];
    const head = id ? plain(c.match(/^<h[23][^>]*>([\s\S]*?)<\/h[23]>/)[1]) : p.title;
    const text = plain(c.replace(/^<h[23][^>]*>[\s\S]*?<\/h[23]>/, ""));
    if (!text && !id) continue;
    index.push({ u: `/docs/${p.slug}/` + (id ? "#" + id : ""), p: p.title, h: head, t: text.slice(0, 600) });
  }
}
mkdirSync(join(root, "site", "public"), { recursive: true });
writeFileSync(join(root, "site", "public", "search-index.json"), JSON.stringify(index));
writeFileSync(join(out, "nav.json"), JSON.stringify(PAGES.map((p) => ({ slug: p.slug, title: p.title, group: p.group }))));
console.log(`gen: ${PAGES.length} pages, ${index.length} search entries`);
