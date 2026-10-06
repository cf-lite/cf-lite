// Snippet typecheck: every ```ts check / ```tsx check fence in docs/*.md is extracted to a scratch dir inside the repo
// (so workspace packages resolve from node_modules) and compiled with real tsc. Needs `bun run build` first.
// Opt in per fence with the `check` info word; a snippet must be self-contained. Run: bun scripts/docs-snippets.mjs (bun run docs:snippets)
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, ".tmp-doc-snippets");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const snippets = [];
for (const f of readdirSync(join(root, "docs")).filter((x) => x.endsWith(".md"))) {
  const text = readFileSync(join(root, "docs", f), "utf8");
  for (const m of text.matchAll(/^```(tsx?) check[^\n]*\n([\s\S]*?)^```/gm)) {
    const line = text.slice(0, m.index).split("\n").length;
    const file = join(scratch, `${f.replace(/\.md$/, "")}-L${line}.${m[1]}`);
    // `export {}` makes each snippet a module so top-level names do not collide across files
    writeFileSync(file, `${m[2]}\nexport {};\n`);
    snippets.push({ file, label: `docs/${f}:${line}` });
  }
}

try {
  const program = ts.createProgram(snippets.map((s) => s.file), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true,
    skipLibCheck: true, jsx: ts.JsxEmit.ReactJSX, types: [],
  });
  const bad = [];
  for (const s of snippets) {
    for (const d of ts.getPreEmitDiagnostics(program, program.getSourceFile(s.file))) bad.push(`${s.label}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  }
  if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
  console.log(`docs-snippets: ${snippets.length} snippet(s) typecheck`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
