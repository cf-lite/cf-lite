/**
 * `cf-lite add ai-chat`: copies the ai-chat template (streaming chat route + minimal client) into an app and adds the Workers AI
 * binding to wrangler.jsonc. Idempotent and non-destructive: existing files are never overwritten; the wrangler edit is a text-level
 * insert (comments preserved) that only happens when an `"ai"` key is absent.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const templateDir = () => join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "ai-chat");

function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) yield* walk(p); else yield p; }
}

/** Insert `"ai": { "binding": "AI" }` after the top-level `{`; unchanged when an `"ai"` key exists, null when there is no `{`. */
export function patchWranglerAi(src: string): string | null {
  if (/["']ai["']\s*:/.test(src)) return src;
  const open = src.indexOf("{");
  if (open < 0) return null;
  return src.slice(0, open + 1) + `\n  // cf-lite add ai-chat: Workers AI (always runs on Cloudflare, even in dev - needs \`wrangler login\`; bills per use)\n  "ai": { "binding": "AI" },` + src.slice(open + 1);
}

export function addAiChat(dir: string, log: (m: string) => void = () => {}): { changed: string[] } {
  const changed: string[] = [];
  const root = templateDir();
  for (const f of walk(root)) {
    const rel = relative(root, f);
    const dest = join(dir, rel);
    if (existsSync(dest)) { log(`  keep   ${rel} (exists)`); continue; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(f));
    changed.push(rel); log(`  write  ${rel}`);
  }
  const wr = ["wrangler.jsonc", "wrangler.json"].map((f) => join(dir, f)).find((p) => existsSync(p));
  if (!wr) log('  no wrangler.jsonc found - add  "ai": { "binding": "AI" }  by hand');
  else {
    const src = readFileSync(wr, "utf8");
    const out = patchWranglerAi(src);
    if (out === null) log('  add  "ai": { "binding": "AI" }  to wrangler.jsonc by hand');
    else if (out !== src) { writeFileSync(wr, out); changed.push(wr.slice(dir.length + 1)); log(`  edit   ${wr.slice(dir.length + 1)} (+ ai binding)`); }
  }
  if (changed.length) log(`\nNext: declare  AI: Ai; AI_GATEWAY_ID?: string  in server/env.d.ts; import { mountChat } from "./chat-client" in your app entry (route /api/chat is picked up by the api convention).`);
  return { changed };
}
