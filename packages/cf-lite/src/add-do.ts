/**
 * `cf-lite add do <name>`: scaffold `server/do/<name>.ts` (a `HibernatingRoom`) and the wrangler `durable_objects` binding + a
 * SQLite-backed `migrations` entry. Same contract as add-jobs: never overwrites, text-level JSONC edits (comments kept), prints the
 * snippet when the existing config can't be edited safely.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { insertIntoArray } from "./add-jobs.js";
import { pascal, upperSnake } from "./conventions/jobs-util.js";

export function doTemplate(name: string): string {
  return `import { HibernatingRoom } from "cf-lite/modules/realtime";\n\n/** WebSocket room "${name}": connect through \`durableObjects.${name}.fetch(roomName, request)\` (.cf-lite/do). */\nexport default class ${pascal(name)} extends HibernatingRoom<Env, { name: string }, { chat: { text: string } }> {\n  authorize(req: Request) {\n    return { meta: { name: new URL(req.url).searchParams.get("name") ?? "anon" } };\n  }\n  messages = {\n    chat: (conn: { id: string; meta: { name: string } }, d: { text: string }) => this.broadcast("chat", { name: conn.meta.name, text: String(d.text).slice(0, 500) }, { from: conn.id }),\n  };\n}\n`;
}

export interface WranglerEdit { text: string; manual?: string }

export function editWrangler(src: string, name: string): WranglerEdit {
  const binding = upperSnake(name), cls = pascal(name);
  const b = `{ "name": ${JSON.stringify(binding)}, "class_name": ${JSON.stringify(cls)} }`;
  let text = src;
  const manual: string[] = [];
  const top = (prop: string) => { const o = text.indexOf("{"); return o < 0 ? null : text.slice(0, o + 1) + `\n  ${prop},` + text.slice(o + 1); };
  if (!new RegExp(`"name"\\s*:\\s*"${binding}"`).test(text)) {
    if (!/"durable_objects"\s*:/.test(text)) { const t = top(`"durable_objects": { "bindings": [${b}] }`); if (t) text = t; else manual.push(`"durable_objects": { "bindings": [${b}] }`); }
    else { const t = insertIntoArray(text, "bindings", b); if (t) text = t; else manual.push(`durable_objects.bindings += ${b}`); }
  }
  if (!new RegExp(`"new_sqlite_classes"\\s*:\\s*\\[[^\\]]*"${cls}"`).test(text)) {
    const tags = [...text.matchAll(/"tag"\s*:\s*"v(\d+)"/g)].map((m) => Number(m[1]));
    const entry = `{ "tag": "v${Math.max(0, ...tags) + 1}", "new_sqlite_classes": [${JSON.stringify(cls)}] }`;
    if (!/"migrations"\s*:/.test(text)) { const t = top(`"migrations": [${entry}]`); if (t) text = t; else manual.push(`"migrations": [${entry}]`); }
    else { const t = insertIntoArray(text, "migrations", entry); if (t) text = t; else manual.push(`migrations += ${entry}`); }
  }
  return { text, manual: manual.length ? manual.join("\n") : undefined };
}

export function addDo(dir: string, name: string, log: (m: string) => void = () => {}): { changed: string[] } {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error(`cf-lite add do: name must be letters, digits and dashes (got "${name}")`);
  const changed: string[] = [];
  const file = join(dir, "server", "do", `${name}.ts`);
  if (existsSync(file)) log(`  keep   server/do/${name}.ts (exists)`);
  else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, doTemplate(name)); changed.push(`server/do/${name}.ts`); log(`  create server/do/${name}.ts`); }
  const wr = ["wrangler.jsonc", "wrangler.json"].map((f) => join(dir, f)).find((p) => existsSync(p));
  if (!wr) log("  no wrangler.jsonc found - add the durable_objects binding + migration by hand (see docs/realtime.md)");
  else {
    const src = readFileSync(wr, "utf8");
    const r = editWrangler(src, name);
    const rel = wr.slice(dir.length + 1);
    if (r.text !== src) { writeFileSync(wr, r.text); changed.push(rel); log(`  edit   ${rel}`); }
    if (r.manual) log(`  add to ${rel} by hand: ${r.manual}`);
  }
  log(`  then add  export * from "../.cf-lite/do-classes";  to server/worker.ts`);
  return { changed };
}
