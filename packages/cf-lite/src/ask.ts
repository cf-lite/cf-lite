/**
 * `cfl ask "<text>"`: fallback natural-language mode (roadmap-dx 5.3, docs/llm.md).
 * text -> model returns tool calls (function calling) -> each call checked against the allow-list + JSON Schema ->
 * plan + dry-run diff printed -> applied only after confirmation. The model never writes code or runs anything; it picks
 * from src/tools.ts. Backend: Workers AI REST on the user's own account; credentials come from the environment and are never stored.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { TOOLS, runTool, toCommand, toolByName, validateArgs, type ToolEnv, type ToolResult } from "./tools.js";
import { ensureConsent } from "./ask-consent.js";
import { PROVIDER_DEFAULT_MODEL, buildRequest, describeRoute, errorText, normalizeReply, type Route } from "./ask-provider.js";
import { detectUi } from "./gen-app.js";
import { parseJsonc } from "./wrangler-edit.js";
import { findWranglerConfig } from "./cli-db.js";

export const DEFAULT_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export const defaultModel = (r?: Route): string => (r && r.provider !== "workers-ai" ? PROVIDER_DEFAULT_MODEL[r.provider] : DEFAULT_MODEL);
export const MAX_CALLS = 5;
export const MAX_ATTEMPTS = 2;

// ---- privacy: what may be sent --------------------------------------------------------------------------------------------

/** Files whose NAMES are not sent either (the list itself must not hint at secrets). */
export const DENY = /(^|\/)(\.dev\.vars[^/]*|\.env[^/]*|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore)|[^/]*secrets?[^/]*|\.git|node_modules|dist|\.wrangler|\.cf-lite|\.claude)(\/|$)/i;
const SKIP_DIRS = /^(node_modules|\.git|dist|\.wrangler|\.cf-lite|\.claude|coverage|\.next|\.turbo)$/;

/** Replace anything that looks like a credential. Applied to the user's sentence before it leaves the machine. */
export function redact(s: string): string {
  return s
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/\b(?:cfut|cfat|ghp|gho|ghs|github_pat|xox[abp]|AKIA|fvg)_?[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/\b(bearer|token|api[_-]?key|secret|password|passwd)\b(\s*[:=]\s*|\s+)["']?[^\s"']{8,}/gi, "$1$2[REDACTED]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED]");
}

export interface AskContext { ui: string | null; files: string[] }
/** Minimal context: project file names (no contents), deny-listed names dropped, capped. */
export function buildContext(dir: string, cap = 150): AskContext {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      if (files.length >= cap) return;
      const p = join(d, n); const rel = relative(dir, p);
      if (SKIP_DIRS.test(n) || DENY.test(rel)) continue;
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p); else files.push(rel);
    }
  };
  walk(dir);
  return { ui: detectUi(dir), files };
}

// ---- backend ---------------------------------------------------------------------------------------------------------------

export class BackendError extends Error { constructor(public kind: "auth" | "quota" | "unreachable" | "bad-response", message: string) { super(message); } }
export interface Creds { accountId: string; token: string }
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export interface Msg { role: "system" | "user" | "assistant"; content: string }
export interface RawCall { name: string; args: unknown; parseError?: string }
export interface ModelReply { text: string; calls: RawCall[]; promptTokens?: number; completionTokens?: number; latencyMs: number }

/** Account id: env, else `account_id` in wrangler config (not a secret). Token: env only. */
export function resolveCreds(dir: string, env: Record<string, string | undefined> = process.env): Creds | string {
  let accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) { try { const f = findWranglerConfig(dir); if (f) accountId = parseJsonc(readFileSync(f, "utf8")).account_id as string | undefined; } catch { /* none */ } }
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token || !accountId) return "cfl ask needs CLOUDFLARE_API_TOKEN (Workers AI Read + Edit) and CLOUDFLARE_ACCOUNT_ID in the environment (or account_id in wrangler.jsonc). Nothing was sent. Plain commands work without them: cfl g --help";
  return { accountId, token };
}

const asArgs = (a: unknown): { args: unknown; parseError?: string } => {
  if (typeof a !== "string") return { args: a ?? {} };
  try { return { args: JSON.parse(a || "{}") }; } catch { return { args: {}, parseError: "arguments are not valid JSON" }; }
};
/** Both response shapes Workers AI returns: OpenAI-style `choices[0].message.tool_calls` and the native `tool_calls`. */
export function parseReply(body: unknown): { text: string; calls: RawCall[]; promptTokens?: number; completionTokens?: number } {
  const r = ((body as { result?: Record<string, unknown> })?.result ?? {}) as Record<string, any>;
  const msg = r.choices?.[0]?.message ?? r;
  const raw: any[] = msg.tool_calls ?? r.tool_calls ?? [];
  const calls: RawCall[] = raw.map((c) => ({ name: String(c.function?.name ?? c.name ?? ""), ...asArgs(c.function?.arguments ?? c.arguments) }));
  let text = String(msg.content ?? r.response ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Qwen3 with thinking off sometimes emits the call as `<tool_call>{json}</tool_call>` text (observed in `reasoning` or `content`) instead of structured tool_calls: same gate applies afterwards.
  if (!calls.length) {
    for (const src of [text, String(msg.reasoning_content ?? msg.reasoning ?? "")]) {
      for (const m of src.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
        try { const j = JSON.parse(m[1]); calls.push({ name: String(j.name ?? ""), ...asArgs(j.arguments ?? j.parameters) }); } catch { calls.push({ name: "(unparsable tool_call)", args: {}, parseError: "tool call is not valid JSON" }); }
      }
      if (calls.length) break;
    }
    text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
  }
  return { text, calls, promptTokens: r.usage?.prompt_tokens, completionTokens: r.usage?.completion_tokens };
}

/** Arguments the model never sees: dry-run is ours to decide. */
const MODEL_HIDDEN = new Set(["dryRun"]);

/** A gateway 401/403 has two possible causes (gateway token vs provider credential); say which tokens to check. */
const gatewayAuthHint = (r: Route): string | undefined => r.gateway ? `AI Gateway "${r.gateway.id}" or the ${r.provider === "workers-ai" ? "Workers AI token" : "provider key"} was rejected: an authenticated gateway needs CF_AIG_TOKEN (a token with AI Gateway Run${r.gateway.token ? "; the one set was not accepted" : "; none is set"})${r.provider === "workers-ai" ? ", and CLOUDFLARE_API_TOKEN needs Workers AI Read + Edit" : ""}` : undefined;

export async function callModel(c: Creds, model: string, messages: Msg[], fetchFn: Fetch = fetch as unknown as Fetch, route: Route = { provider: "workers-ai" }): Promise<ModelReply> {
  const t0 = Date.now();
  // OpenAI-style `{type:"function", function}` tools: every function-calling model in the catalog accepts it; the bare `{name, parameters}` shape is rejected by gpt-oss, Mistral, Nemotron, GLM, Granite ("Invalid input").
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: { ...t.inputSchema, properties: Object.fromEntries(Object.entries(t.inputSchema.properties).filter(([k]) => !MODEL_HIDDEN.has(k))) } }));
  const who = route.provider === "workers-ai" ? "Workers AI" : route.provider;
  const req = buildRequest(route, c, model, messages, tools);
  let res;
  try { res = await fetchFn(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) }); }
  catch (e) { throw new BackendError("unreachable", `could not reach ${who} (${(e as Error).message.split(route.key ?? "\0").join("[REDACTED]")})`); }
  if (res.status === 401 || res.status === 403) throw new BackendError("auth", gatewayAuthHint(route) ?? (route.provider === "workers-ai" ? "Workers AI rejected the token (needs Workers AI Read + Edit on this account)" : `${who} rejected the API key`));
  if (res.status === 429) throw new BackendError("quota", route.provider === "workers-ai" ? "Workers AI rate limit or daily free allocation reached" : `${who} rate limit or quota reached`);
  let body: any;
  try { body = await res.json(); } catch { throw new BackendError("bad-response", `${who} returned a non-JSON response (HTTP ${res.status})`); }
  if (!res.ok || body?.success === false) {
    const m = errorText(route, body, res.status);
    throw new BackendError(/capacity|quota|limit|neurons/i.test(m) ? "quota" : "bad-response", `${who} error: ${m}`);
  }
  return { ...parseReply(normalizeReply(route, body)), latencyMs: Date.now() - t0 };
}

// ---- request guard and grounding (deterministic, runs outside the model) ---------------------------------------------------

/**
 * Requests that no tool can serve, recognised without a model call (cheaper, and not persuadable by the prompt).
 * Returns the refusal sentence, or null to let the model look at it. Deliberately narrow: shell commands, secrets, deploy/remote,
 * paths outside the project, delete/drop, account actions. Everything else is the model's call.
 */
export function guardRequest(text: string): string | null {
  const t = text.toLowerCase();
  if (/\.\.\/|(^|[\s"'`])(~\/|\/(etc|usr|var|root|home|bin|tmp|opt)\b)/.test(t)) return "I only work inside the project (app/, server/, ...): paths outside it are not allowed.";
  if (/(^|[\s`;|&])(sudo|rm\s+-|chmod|chown|curl|wget|apt(-get)?\s|bash|sh\s+-c)\b|\|\s*sh\b|\b(git\s+(push|reset|checkout|clean|commit)|(npm|npx|pnpm|yarn|bun|pip|wrangler)\s+\w+)|\brun\s+(rm|npm|npx|pnpm|yarn|bun|wrangler|git|sudo|sh|bash|curl|wget)\b/.test(t)) return "I cannot run shell commands or install packages; I only call the cfl tools (generate_*, add, seed, doctor, analyze).";
  if (/\.dev\.vars|(^|[\s/])\.env\b|\bapi[ _-]?(key|token)s?\b|\b(secrets?|passwords?|credentials?|tokens?|private key|id_rsa)\b|\.ssh\b|\bsk-[a-z0-9]/.test(t)) return "I never read, write, print or rotate secrets, keys or env files; use your secret tooling for that.";
  if (/\b(deploy|publish|ship|release|go live|push)\b[^.]*\b(prod|production|live|remote|now|site|app|worker)\b|\b(production|prod|remote)\b|^\W*(please )?deploy\b/.test(t)) return "I do not deploy, publish or touch production/remote data; run `cfl deploy` yourself when you are ready.";
  if (/\b(delete|remove|destroy|wipe|rename)\b|\bdrop (the |my |a )?(\w+ )?(table|database|column|index)\b/.test(t)) return "No tool deletes or renames things; do that yourself, then I can generate what you need.";
  if (/\b(log|sign) ?in to\b|\bcreate (a |an |my )?(new )?(cloudflare |github )?account\b/.test(t)) return "I cannot log in or create accounts.";
  return null;
}

const keyNorm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Words that name the KIND of thing, never the thing: a name made of these was not chosen by the user. */
const GENERIC_NAMES = new Set(["page", "pages", "component", "components", "test", "tests", "api", "apis", "name", "queue", "job", "jobs", "cron", "cronjob", "durableobject", "do", "workflow", "worker", "handler", "task", "thing", "something", "scheduled", "scheduler", "binding", "database", "db", "storage", "store", "bucket"]);
const NAMED = /(?:called|named|name(?:d)?(?: it| is)?|call it|titled)\s*[:=]?\s*["'`]?([A-Za-z0-9][A-Za-z0-9_\-./\[\]]*)/gi;
const STORAGE_WORDS: Record<string, RegExp> = { d1: /\bd1\b|\bsql(ite)?\b/, kv: /\bkv\b|key[- ]?value/, r2: /\br2\b|\bbucket\b|object storage/, hyperdrive: /hyperdrive|postgres|mysql/ };
const TOOL_WORDS: Record<string, RegExp> = {
  analyze: /\b(size|sizes|big|bigger|bundle|weigh|weight|analy[sz]e|kb|bytes|heavy|large)\b/,
  doctor: /\b(doctor|check|diagnos\w*|misconfig\w*|health|validate|audit|verify|problems?|issues?|wrong|broken|lint)\b/,
};
const FLAG_WORDS: Record<string, RegExp> = { mock: /\bmocks?\b|fixture/, seed: /\bseed|sample data|fixture/, loader: /\bloader|fetch|\bdata\b/, island: /island|hydrat|interactive/, folder: /\bfolder|director/ };
const JOB_TARGETS = new Set(["cron", "queue", "workflow", "email", "do"]);

export interface Grounded { args: Record<string, unknown>; dropped: string[]; ask?: string }

/**
 * Check a schema-valid call against the user's actual words. Narrowing only, never inventing: an OPTIONAL option the user did not
 * ask for is dropped (and reported in the plan); a REQUIRED value they did not give turns the whole request into one question.
 */
export function ground(tool: string, input: Record<string, unknown>, text: string): Grounded {
  const t = text.toLowerCase(), tn = keyNorm(text), args = { ...input }, dropped: string[] = [];
  const drop = (k: string) => { if (args[k] !== undefined) { delete args[k]; dropped.push(k); } };
  const nameGiven = (v: unknown, cue: boolean): boolean => {
    const n = keyNorm(String(v ?? ""));
    if (!n || GENERIC_NAMES.has(n) || !tn.includes(n)) return false;
    return !cue || [...text.matchAll(NAMED)].some((m) => keyNorm(m[1]) === n);
  };
  if (tool === "generate_page" || tool === "generate_api" || tool === "generate_component" || tool === "generate_test") {
    if (!nameGiven(args.name, false)) return { args, dropped, ask: `What should the ${tool.replace("generate_", "")} be called (name${tool === "generate_page" ? " or route" : ""})?${tool === "generate_test" ? " Which page, api or component is it for?" : ""}` };
  }
  if (tool === "generate_page") {
    if (args.render === "ssr" && !/\bssr\b|server|dynamic/.test(t)) drop("render");
    if (args.render === "spa" && !/\bspa\b|single[- ]page|client|browser/.test(t)) drop("render");
  }
  if (tool === "generate_page" || tool === "generate_component") {
    if (args.ui !== undefined && !new RegExp(`\\b${String(args.ui)}\\b`).test(t)) drop("ui");
  }
  if (tool === "generate_component") {
    if (args.dir !== undefined && !t.includes(String(args.dir).toLowerCase())) drop("dir");
  }
  if (tool === "generate_test" && args.kind !== undefined && !new RegExp(`\\b${String(args.kind)}\\b`).test(t)) drop("kind");
  for (const k of Object.keys(FLAG_WORDS)) if (args[k] === true && !FLAG_WORDS[k].test(t) && (k !== "seed" || tool === "generate_api")) drop(k);
  if (tool === "seed" && args.name !== undefined && !tn.includes(keyNorm(String(args.name)))) drop("name");
  if (tool === "add") {
    const target = String(args.target);
    if (STORAGE_WORDS[target] && !STORAGE_WORDS[target].test(t)) return { args, dropped, ask: "Which one do you want: d1 (SQL database), kv (key-value), r2 (file/object bucket) or hyperdrive (external Postgres/MySQL)?" };
    if (JOB_TARGETS.has(target) && !nameGiven(args.name, true)) return { args, dropped, ask: `What name should the ${target === "do" ? "durable object" : target} have (say "called <name>")?` };
    if (!JOB_TARGETS.has(target)) drop("name");
    if (args.binding !== undefined && !(/\b(binding|bound|bind)\b/.test(t) && tn.includes(keyNorm(String(args.binding))))) drop("binding");
    if (args.schedule !== undefined && !/\b(every|hourly|daily|nightly|weekly|monthly|cron|at \d|\d+ ?(am|pm|min|hour)|\*)/.test(t)) drop("schedule");
  }
  if ((tool === "analyze" || tool === "doctor") && !TOOL_WORDS[tool].test(t)) return { args, dropped, ask: tool === "analyze" ? "I can report the built Worker and page sizes (analyze); I cannot make anything faster. Is that what you want?" : "What should I check? I can run doctor (config problems) or analyze (build sizes); say which." };
  return { args, dropped };
}

// ---- proposing and validating calls -------------------------------------------------------------------------------------

export const SYSTEM_PROMPT = [
  "You are the natural-language front end of the cf-lite CLI (cfl). You can only act by calling the provided tools, and you never write code or commands in your reply.",
  "Decide in this order, and stop at the first rule that applies:",
  "1. REFUSE (one short sentence, no tool call) if the user asks for anything no tool does: shell commands or installing packages, deploying/publishing, deleting or renaming, reading/printing/writing/rotating secrets, tokens, keys or env files, remote or production data, editing arbitrary files, paths outside the project, logging in or creating accounts, or a tool name that is not in the list.",
  "2. ASK (one short question, no tool call) if a REQUIRED value is not literally in the user's words: a page/api/component/job name, which of d1/kv/r2/hyperdrive, which kind of thing ('something for orders' could be a page, an api or a component), or what 'faster', 'better', 'fix', 'the usual stuff' should mean. Never guess, invent or default a name; the words 'page', 'component', 'test', 'queue', 'job', 'durable object' are not names.",
  "3. Otherwise CALL the tool(s). Use only the options the user asked for: leave out ui (the adapter is auto-detected; pass it only when the user names react, preact, vue or svelte), render, dir, binding, schedule, folder, island, mock, seed, loader and kind unless the user said so. One call per thing requested, at most 5.",
  "Examples: \"new team page\" -> generate_page {name:\"team\"}; \"make a page\" -> ask which route. \"add a kv store\" -> add {target:\"kv\"}; \"add a database\" (kind not chosen) -> ask which of d1/kv/r2/hyperdrive. A job (cron, queue, workflow, email, durable object) without a name the user chose -> ask for the name. A vague wish ('faster', 'nicer') -> ask what to improve; analyze only reports sizes and improves nothing.",
].join("\n");

export const userMessage = (text: string, ctx: AskContext): string =>
  `${redact(text)}\n\n[project files] ${ctx.files.join(", ") || "(none)"}`;

export interface Proposal {
  calls: { tool: string; args: Record<string, unknown>; dropped?: string[] }[];
  invalid: { name: string; reasons: string[]; args: unknown }[];
  text: string; attempts: number; promptTokens: number; completionTokens: number; latencyMs: number;
}

/** Strip the model's `dryRun` (we decide that), then allow-list + schema check. Returns reasons when rejected. */
export function checkCall(c: RawCall, text?: string): { tool: string; args: Record<string, unknown>; dropped?: string[] } | { reasons: string[]; ask?: string } {
  if (c.parseError) return { reasons: [c.parseError] };
  const def = toolByName(c.name);
  if (!def) return { reasons: [`"${c.name}" is not an allowed tool`] };
  if (!c.args || typeof c.args !== "object" || Array.isArray(c.args)) return { reasons: ["arguments must be an object"] };
  const args = { ...(c.args as Record<string, unknown>) }; delete args.dryRun;
  const reasons = validateArgs(def.inputSchema, args);
  if (reasons.length) return { reasons };
  if (text === undefined) return { tool: c.name, args };
  const g = ground(c.name, args, text);
  return g.ask ? { reasons: [`not grounded in the request: ${g.ask}`], ask: g.ask } : { tool: c.name, args: g.args, ...(g.dropped.length ? { dropped: g.dropped } : {}) };
}

/** Ask the model; on schema-invalid calls feed the errors back once. Never loops past `maxAttempts`; never repairs. */
export async function propose(text: string, ctx: AskContext, o: { creds: Creds; model?: string; fetch?: Fetch; maxAttempts?: number; guard?: boolean; ground?: boolean; route?: Route }): Promise<Proposal> {
  const messages: Msg[] = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userMessage(text, ctx) }];
  const p: Proposal = { calls: [], invalid: [], text: "", attempts: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  const refusal = o.guard === false ? null : guardRequest(text);
  if (refusal) { p.text = refusal; return p; }
  for (let i = 0; i < (o.maxAttempts ?? MAX_ATTEMPTS); i++) {
    const r = await callModel(o.creds, o.model ?? defaultModel(o.route), messages, o.fetch, o.route);
    p.attempts++; p.text = r.text; p.latencyMs += r.latencyMs; p.promptTokens += r.promptTokens ?? 0; p.completionTokens += r.completionTokens ?? 0;
    p.calls = []; p.invalid = [];
    const asks: string[] = [];
    for (const c of r.calls.slice(0, MAX_CALLS)) {
      const v = checkCall(c, o.ground === false ? undefined : text);
      if ("reasons" in v) { if (v.ask) asks.push(v.ask); else p.invalid.push({ name: c.name, reasons: v.reasons, args: c.args }); } else p.calls.push(v);
    }
    // a required value the user never gave: no plan at all, one question (the model guessed; we do not let a guess through)
    if (asks.length) { p.calls = []; p.invalid = []; p.text = asks[0]; return p; }
    if (r.calls.length > MAX_CALLS) p.invalid.push({ name: "(too many)", reasons: [`more than ${MAX_CALLS} tool calls in one request`], args: null });
    if (!p.invalid.length) return p;
    messages.push({ role: "assistant", content: JSON.stringify(r.calls.map((c) => ({ name: c.name, arguments: c.args }))) });
    messages.push({ role: "user", content: `Those tool calls were rejected: ${p.invalid.map((x) => `${x.name}: ${x.reasons.join("; ")}`).join(" | ")}. Call only the allowed tools with valid arguments, or ask one clarifying question.` });
  }
  return p;
}

// ---- the command ---------------------------------------------------------------------------------------------------------

export interface AskOptions {
  text: string; env: ToolEnv; creds: Creds | string;
  yes?: boolean; dryRun?: boolean; acceptTerms?: boolean; model?: string; fetch?: Fetch;
  /** Explicit provider/gateway choice (see ask-provider.ts); absent = Workers AI on the user's account. */
  route?: Route;
  /** y/N prompt; absent = non-interactive (consent and apply both refuse without the flags). */
  confirm?: (q: string) => Promise<boolean>;
  log: (m: string) => void;
}
export type AskStatus = "applied" | "planned" | "declined" | "no-consent" | "no-credentials" | "clarify" | "no-call" | "invalid" | "plan-failed" | "backend-error";
export interface AskOutcome { status: AskStatus; calls: { tool: string; args: Record<string, unknown>; command: string; result?: ToolResult }[] }

export async function ask(o: AskOptions): Promise<AskOutcome> {
  const out = (status: AskStatus, calls: AskOutcome["calls"] = []): AskOutcome => ({ status, calls });
  const route = o.route ?? { provider: "workers-ai" as const };
  if (!(await ensureConsent({ provider: route.provider, gateway: !!route.gateway, accept: o.acceptTerms, confirm: o.confirm, log: o.log }))) return out("no-consent");
  if (typeof o.creds === "string" && route.provider === "workers-ai") { o.log(o.creds); return out("no-credentials"); }
  const creds: Creds = typeof o.creds === "string" ? { accountId: "", token: "" } : o.creds; // BYO provider: the key lives in the route, no Cloudflare credentials involved
  let p: Proposal;
  try { if (o.route) o.log(`cfl ask: sending to ${describeRoute(route, o.model ?? defaultModel(route))}`);
    p = await propose(o.text, buildContext(o.env.dir), { creds, model: o.model, fetch: o.fetch, route: o.route }); }
  catch (e) {
    if (!(e instanceof BackendError)) throw e;
    o.log(`cfl ask: ${e.message}. Nothing was changed, and no other provider was tried. Use the plain commands (cfl g ..., cfl add ...) meanwhile.`);
    return out("backend-error");
  }
  if (p.invalid.length) {
    o.log(`cfl ask: the model did not produce a valid call after ${p.attempts} attempt(s); nothing was changed.`);
    for (const x of p.invalid) o.log(`  rejected ${x.name}: ${x.reasons.join("; ")}`);
    const close = p.invalid.find((x) => toolByName(x.name) && x.args && typeof x.args === "object");
    if (close) o.log(`  closest manual command (check it first): ${toCommand(close.name, close.args as Record<string, unknown>)} --dry-run`);
    return out("invalid");
  }
  if (!p.calls.length) {
    o.log(p.text ? `cfl ask: ${p.text}` : "cfl ask: the model made no call and gave no answer. Try the plain commands: cfl g page|api|component|test <name>, cfl add <target>.");
    return out(p.text.trim().endsWith("?") ? "clarify" : "no-call");
  }
  const planned: AskOutcome["calls"] = [];
  o.log("Plan:");
  for (const c of p.calls) {
    const result = await runTool(o.env, c.tool, { ...c.args, dryRun: true });
    const entry = { ...c, command: toCommand(c.tool, c.args), result };
    planned.push(entry);
    o.log(`  ${entry.command}`);
    if (c.dropped?.length) o.log(`    left out (not in your request): ${c.dropped.join(", ")}`);
    if (!result.ok) { o.log(`    cannot apply: ${result.error}`); }
    else for (const l of result.lines) o.log(`    ${l}`);
  }
  if (planned.some((c) => !c.result!.ok)) { o.log("Nothing was changed (a step in the plan failed its dry run)."); return out("plan-failed", planned); }
  if (o.dryRun) return out("planned", planned);
  if (!o.yes) {
    if (!o.confirm || !(await o.confirm("Apply this plan? [y/N] "))) { o.log(o.confirm ? "Not applied." : "Not applied (no terminal to confirm; re-run with --yes, or --dry-run to only preview)."); return out("declined", planned); }
  }
  for (const c of planned) {
    const r = await runTool(o.env, c.tool, c.args);
    c.result = r;
    if (!r.ok) { o.log(`cfl ask: ${c.command} failed: ${r.error}; stopped.`); return out("plan-failed", planned); }
    o.log(`done: ${c.command}`);
    r.notes?.forEach((n) => o.log(`  note: ${n}`));
  }
  return out("applied", planned);
}
