/**
 * `cf-lite add cron|queue|workflow|email <name>`: scaffold `server/<kind>/<name>.ts` and add the wrangler entries the convention expects.
 * Idempotent and non-destructive: an existing file is never overwritten; wrangler.jsonc is edited at text level (comments kept) and
 * only when the target key is absent or a plain array - otherwise the exact snippet is printed to add by hand.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pascal, upperSnake } from "./conventions/jobs-util.js";

export const JOB_KINDS = ["cron", "queue", "workflow", "email"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

const DEFAULT_CRON = "*/15 * * * *";

export function template(kind: JobKind, name: string, opts: { schedule?: string } = {}): string {
  switch (kind) {
    case "cron":
      return `export const schedule = ${JSON.stringify(opts.schedule ?? DEFAULT_CRON)};\n\nexport default async (ev: ScheduledController, env: Env, ctx: ExecutionContext) => {\n  console.log("cron ${name}", ev.cron);\n};\n`;
    case "queue":
      return `import { defineQueue, backoff } from "cf-lite/modules/queue";\n\nexport type Message = { id: string };\n\nexport default defineQueue<Message>({\n  each: async (body, msg, env) => {\n    console.log("queue ${name}", body.id, "attempt", msg.attempts);\n  },\n  retryDelay: backoff({ base: 30 }),\n});\n`;
    case "workflow":
      return `import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";\n\nexport default class ${pascal(name)} extends WorkflowEntrypoint<Env, { id: string }> {\n  async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep) {\n    await step.do("first step", async () => ({ id: event.payload.id }));\n  }\n}\n`;
    case "email":
      return `export const match = "${name}@example.com";\n\nexport default async (message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) => {\n  console.log("email", message.from, "->", message.to);\n};\n`;
  }
}

const dirOf = (k: JobKind) => (k === "queue" ? "queues" : k === "workflow" ? "workflows" : k);

/** Index of the `]` closing the array opened just before `from` (strings and comments skipped); -1 when unbalanced. */
function closeOf(src: string, from: number): number {
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') { i++; while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1; }
    else if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; }
    else if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i + 2); if (i < 0) return -1; i++; }
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") { depth--; if (depth === 0) return ch === "]" ? i : -1; }
  }
  return -1;
}

/** Append `entry` to the JSONC array at `"key": [ ... ]`; null when the key is absent or unbalanced. Comments are kept. */
export function insertIntoArray(src: string, key: string, entry: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(src);
  if (!m) return null;
  const open = m.index + m[0].length;
  const close = closeOf(src, open);
  if (close < 0) return null;
  const inner = src.slice(open, close);
  if (inner.includes(entry)) return src;
  const body = inner.replace(/\s+$/, "");
  const code = body.replace(/\/\/[^\n]*/g, "").trim();
  return src.slice(0, open) + body + (code && !code.endsWith(",") ? "," : "") + ` ${entry}` + src.slice(close);
}
/** Insert a whole `"key": value,` property after the top-level `{`. */
function insertProp(src: string, prop: string): string | null {
  const open = src.indexOf("{");
  return open < 0 ? null : src.slice(0, open + 1) + `\n  ${prop},` + src.slice(open + 1);
}

export interface WranglerEdit { text: string; manual?: string }

export function editWrangler(src: string, kind: JobKind, name: string, opts: { schedule?: string; binding?: string } = {}): WranglerEdit {
  const fail = (manual: string): WranglerEdit => ({ text: src, manual });
  if (kind === "email") return { text: src, manual: "Email Routing: create a routing rule pointing at this Worker in the dashboard (needs a real domain)." };
  if (kind === "cron") {
    const s = JSON.stringify(opts.schedule ?? DEFAULT_CRON);
    if (src.includes(s) && /"crons"/.test(src)) return { text: src };
    if (/"triggers"\s*:/.test(src)) return insertIntoArray(src, "crons", s) ? { text: insertIntoArray(src, "crons", s)! } : fail(`"triggers": { "crons": [${s}] }`);
    const t = insertProp(src, `"triggers": { "crons": [${s}] }`);
    return t ? { text: t } : fail(`"triggers": { "crons": [${s}] }`);
  }
  if (kind === "workflow") {
    const entry = `{ "name": ${JSON.stringify(name)}, "binding": ${JSON.stringify(upperSnake(name) + "_WORKFLOW")}, "class_name": ${JSON.stringify(pascal(name))} }`;
    if (src.includes(`"${upperSnake(name)}_WORKFLOW"`)) return { text: src };
    const t = /"workflows"\s*:/.test(src) ? insertIntoArray(src, "workflows", entry) : insertProp(src, `"workflows": [${entry}]`);
    return t ? { text: t } : fail(`"workflows": [${entry}]`);
  }
  const bindingName = opts.binding ?? upperSnake(name) + "_QUEUE";
  const p = `{ "binding": ${JSON.stringify(bindingName)}, "queue": ${JSON.stringify(name)} }`;
  const c = `{ "queue": ${JSON.stringify(name)}, "max_batch_size": 10, "max_retries": 3, "dead_letter_queue": ${JSON.stringify(name + "-dlq")} }`;
  if (src.includes(`"${bindingName}"`)) return { text: src };
  if (!/"queues"\s*:/.test(src)) {
    const t = insertProp(src, `"queues": { "producers": [${p}], "consumers": [${c}] }`);
    return t ? { text: t } : fail(`"queues": { "producers": [${p}], "consumers": [${c}] }`);
  }
  const a = insertIntoArray(src, "producers", p);
  const b = a && insertIntoArray(a, "consumers", c);
  return b ? { text: b } : fail(`"queues": { "producers": [... ${p}], "consumers": [... ${c}] }`);
}

export function addJob(dir: string, kind: JobKind, name: string, log: (m: string) => void = () => {}, opts: { schedule?: string } = {}): { changed: string[] } {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new Error(`cf-lite add ${kind}: name must be letters, digits and dashes (got "${name}")`);
  const changed: string[] = [];
  const file = join(dir, "server", dirOf(kind), `${name}.ts`);
  if (existsSync(file)) log(`  keep   server/${dirOf(kind)}/${name}.ts (exists)`);
  else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, template(kind, name, opts)); changed.push(`server/${dirOf(kind)}/${name}.ts`); log(`  create server/${dirOf(kind)}/${name}.ts`); }
  const wr = ["wrangler.jsonc", "wrangler.json"].map((f) => join(dir, f)).find((p) => existsSync(p));
  if (!wr) log("  no wrangler.jsonc found - add the binding by hand (see docs/background-jobs.md)");
  else {
    const src = readFileSync(wr, "utf8");
    const r = editWrangler(src, kind, name, opts);
    if (r.text !== src) { writeFileSync(wr, r.text); changed.push(wr.slice(dir.length + 1)); log(`  edit   ${wr.slice(dir.length + 1)}`); }
    if (r.manual) log(`  add to ${wr.slice(dir.length + 1)} by hand: ${r.manual}`);
  }
  if (kind === "workflow") log(`  then add  export * from "../.cf-lite/workflow-classes";  to server/worker.ts`);
  if (kind !== "email") log(`  then spread the generated handlers in server/worker.ts: export default { fetch, ...handlers } (import { handlers } from "../.cf-lite/handlers")`);
  return { changed };
}
