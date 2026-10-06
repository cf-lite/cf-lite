/**
 * Where `cfl ask` sends the request (roadmap-dx 5.3 items 3-4, docs/llm.md): Workers AI (default), or a provider the user chose
 * explicitly with their OWN key, optionally routed through the user's Cloudflare AI Gateway.
 *
 * Rules (tested in test/llm.test.ts):
 *  - Opt-in only: a provider other than Workers AI needs `--provider` / `CFL_ASK_PROVIDER`. A key in the environment alone never
 *    changes where a request goes, and a failure never falls back to another provider.
 *  - Keys are read from the environment, held only in the request headers, and never appear in a log line, error message or body.
 *  - The gateway only changes the URL (and adds the gateway token header); the provider and the key stay the ones the user chose.
 */
import type { Creds } from "./ask.js";
import type { ProviderId } from "./ask-consent.js";

export const ENV_KEYS: Record<Exclude<ProviderId, "workers-ai">, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
export const PROVIDER_DEFAULT_MODEL: Record<Exclude<ProviderId, "workers-ai">, string> = { openai: "gpt-4.1-mini", anthropic: "claude-haiku-4-5" };

/** Everything needed to address one request. `key` is never printed: use `describe()` for anything user-visible. */
export interface Route {
  provider: ProviderId;
  /** Provider API key (BYO providers only); the Workers AI token travels in `Creds`. */
  key?: string;
  /** Override of the provider's API origin (self-hosted or compatible endpoint). Not combinable with a gateway. */
  baseUrl?: string;
  gateway?: { id: string; accountId: string; token?: string };
}

export interface RouteInput { provider?: string; gateway?: string; baseUrl?: string }

/** Resolve flags + env into a Route, or a one-line reason. Explicit opt-in is enforced here. */
export function resolveRoute(input: RouteInput, env: Record<string, string | undefined>, creds: Creds | string): Route | string {
  const wanted = input.provider ?? env.CFL_ASK_PROVIDER ?? "workers-ai";
  if (wanted !== "workers-ai" && wanted !== "openai" && wanted !== "anthropic") return `unknown provider "${wanted}" (use workers-ai, openai or anthropic)`;
  const gatewayId = input.gateway ?? env.CFL_AI_GATEWAY;
  const baseUrl = input.baseUrl ?? env.CFL_ASK_BASE_URL;
  if (gatewayId && baseUrl) return "use either a gateway or a base URL, not both";
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) return "the base URL must start with http:// or https://";
  if (gatewayId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(gatewayId)) return "the gateway id may only contain letters, digits, - and _";
  const route: Route = { provider: wanted };
  if (wanted !== "workers-ai") {
    const name = ENV_KEYS[wanted];
    const key = env.CFL_ASK_API_KEY ?? env[name];
    if (!key) return `provider ${wanted} needs your own API key in ${name} (or CFL_ASK_API_KEY) in the environment. Nothing was sent.`;
    route.key = key;
  }
  if (baseUrl) route.baseUrl = baseUrl.replace(/\/+$/, "");
  if (gatewayId) {
    if (typeof creds === "string") return "an AI Gateway lives in your Cloudflare account: set CLOUDFLARE_ACCOUNT_ID too (the gateway id alone is not enough)";
    route.gateway = { id: gatewayId, accountId: creds.accountId, token: env.CF_AIG_TOKEN };
  }
  return route;
}

/** One user-visible line saying where the request goes. Never contains a key. */
export function describeRoute(r: Route, model: string): string {
  const where = r.baseUrl ? ` at ${r.baseUrl}` : "";
  return `${r.provider}${where} model ${model}${r.gateway ? ` via your AI Gateway "${r.gateway.id}"` : ""}`;
}

export interface Built { url: string; headers: Record<string, string>; body: unknown }
export interface ToolSpec { name: string; description: string; parameters: unknown }
export interface WireMsg { role: "system" | "user" | "assistant"; content: string }

const GATEWAY = "https://gateway.ai.cloudflare.com/v1";

/** Build the HTTP request for one model turn. Pure: no network, no env. */
export function buildRequest(route: Route, creds: Creds | undefined, model: string, messages: WireMsg[], tools: ToolSpec[], maxTokens = 700): Built {
  const gw = route.gateway;
  const gwHeaders: Record<string, string> = gw?.token ? { "cf-aig-authorization": `Bearer ${gw.token}` } : {};
  const openaiTools = tools.map((t) => ({ type: "function", function: t }));
  if (route.provider === "workers-ai") {
    if (!creds) throw new Error("Workers AI needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
    const url = gw ? `${GATEWAY}/${gw.accountId}/${gw.id}/workers-ai/${model}` : `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/ai/run/${model}`;
    return { url, headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json", ...gwHeaders }, body: { messages, tools: openaiTools, max_tokens: maxTokens, temperature: 0, ...(/qwen/i.test(model) ? { chat_template_kwargs: { enable_thinking: false } } : {}) } };
  }
  if (route.provider === "openai") {
    const base = route.baseUrl ?? (gw ? `${GATEWAY}/${gw.accountId}/${gw.id}/openai` : "https://api.openai.com/v1");
    return { url: `${base}/chat/completions`, headers: { authorization: `Bearer ${route.key}`, "content-type": "application/json", ...gwHeaders }, body: { model, messages, tools: openaiTools, max_tokens: maxTokens, temperature: 0 } };
  }
  // anthropic Messages API: system is a top-level field, tools use input_schema
  const base = route.baseUrl ?? (gw ? `${GATEWAY}/${gw.accountId}/${gw.id}/anthropic` : "https://api.anthropic.com");
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  return {
    url: `${base}/v1/messages`,
    headers: { "x-api-key": route.key!, "anthropic-version": "2023-06-01", "content-type": "application/json", ...gwHeaders },
    body: { model, system, messages: messages.filter((m) => m.role !== "system"), tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })), max_tokens: maxTokens, temperature: 0 },
  };
}

/** Normalise a provider response to the shape `parseReply` reads (`{ result: { choices|tool_calls, usage } }`). */
export function normalizeReply(route: Route, json: unknown): unknown {
  const j = json as Record<string, any>;
  if (route.provider === "workers-ai") return json;
  if (route.provider === "openai") return { success: true, result: { choices: j?.choices ?? [], usage: j?.usage } };
  const blocks: any[] = Array.isArray(j?.content) ? j.content : [];
  return {
    success: true,
    result: {
      choices: [{ message: { content: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"), tool_calls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ function: { name: b.name, arguments: b.input ?? {} } })) } }],
      usage: { prompt_tokens: j?.usage?.input_tokens, completion_tokens: j?.usage?.output_tokens },
    },
  };
}

/** Error text from a provider failure body, with the key scrubbed in case a provider echoes it back. */
export function errorText(route: Route, json: unknown, status: number): string {
  const j = json as Record<string, any>;
  let m = String(j?.errors?.[0]?.message ?? j?.error?.message ?? (typeof j?.error === "string" ? j.error : "") ?? "") || `HTTP ${status}`;
  if (route.key) m = m.split(route.key).join("[REDACTED]");
  return m.slice(0, 300);
}
