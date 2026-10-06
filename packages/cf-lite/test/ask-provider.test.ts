import { describe, expect, it } from "vitest";
import { buildRequest, describeRoute, errorText, normalizeReply, resolveRoute, type Route } from "../src/ask-provider.js";
import { ask, callModel, parseReply, type Fetch } from "../src/ask.js";
import { PROVIDERS, noticeText } from "../src/ask-consent.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolEnv } from "../src/tools.js";

const creds = { accountId: "acc1", token: "CFTOKEN-abc123" };
const KEY = "sk" + "-" + "test-SECRETKEY-1234567890"; // assembled at runtime: no scanner-shaped literal in source
const tools = [{ name: "doctor", description: "d", parameters: { type: "object", properties: {} } }];
const msgs = [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "check" }];

describe("ask providers: opt-in, BYO key, AI Gateway", () => {
  it("default is Workers AI; a key in the environment alone never switches provider", () => {
    expect(resolveRoute({}, { OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY }, creds)).toEqual({ provider: "workers-ai" });
    expect(resolveRoute({ provider: "openai" }, { OPENAI_API_KEY: KEY }, creds)).toMatchObject({ provider: "openai", key: KEY });
    expect(resolveRoute({}, { CFL_ASK_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY }, creds)).toMatchObject({ provider: "anthropic" });
  });
  it("refuses with a reason (no key value in it) when the key is missing or the input is bad", () => {
    const r = resolveRoute({ provider: "openai" }, {}, creds); expect(r).toMatch(/OPENAI_API_KEY/); expect(r).toMatch(/Nothing was sent/);
    expect(resolveRoute({ provider: "gemini" }, {}, creds)).toMatch(/unknown provider/);
    expect(resolveRoute({ gateway: "g", baseUrl: "https://x" }, {}, creds)).toMatch(/not both/);
    expect(resolveRoute({ baseUrl: "ftp://x" }, {}, creds)).toMatch(/http/);
    expect(resolveRoute({ gateway: "bad/../id" }, {}, creds)).toMatch(/gateway id/);
    expect(resolveRoute({ gateway: "g" }, {}, "no creds")).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
  });
  it("Workers AI: REST by default; the gateway changes only the URL and adds the gateway token", () => {
    const direct = buildRequest({ provider: "workers-ai" }, creds, "@cf/qwen/qwen3-30b-a3b-fp8", msgs, tools);
    expect(direct.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc1/ai/run/@cf/qwen/qwen3-30b-a3b-fp8");
    const via = buildRequest({ provider: "workers-ai", gateway: { id: "mygw", accountId: "acc1", token: "AIGTOKEN" } }, creds, "@cf/meta/llama-3.3-70b-instruct-fp8-fast", msgs, tools);
    expect(via.url).toBe("https://gateway.ai.cloudflare.com/v1/acc1/mygw/workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(via.headers["cf-aig-authorization"]).toBe("Bearer AIGTOKEN"); expect(via.headers.authorization).toBe("Bearer CFTOKEN-abc123");
    expect((via.body as { chat_template_kwargs?: unknown }).chat_template_kwargs).toBeUndefined(); // qwen-only switch
  });
  it("OpenAI and Anthropic: own key in the provider's header, gateway URL per provider, never in the body", () => {
    const o: Route = { provider: "openai", key: KEY, gateway: { id: "g", accountId: "acc1" } };
    const ob = buildRequest(o, creds, "gpt-x", msgs, tools);
    expect(ob.url).toBe("https://gateway.ai.cloudflare.com/v1/acc1/g/openai/chat/completions"); expect(ob.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(ob.body)).not.toContain(KEY); expect(ob.headers["cf-aig-authorization"]).toBeUndefined();
    expect(buildRequest({ provider: "openai", key: KEY }, undefined, "gpt-x", msgs, tools).url).toBe("https://api.openai.com/v1/chat/completions");
    const a: Route = { provider: "anthropic", key: KEY };
    const ab = buildRequest(a, undefined, "claude-x", msgs, tools);
    expect(ab.url).toBe("https://api.anthropic.com/v1/messages"); expect(ab.headers["x-api-key"]).toBe(KEY);
    expect(ab.body).toMatchObject({ system: "sys", messages: [{ role: "user", content: "check" }], tools: [{ name: "doctor", input_schema: { type: "object" } }] });
    expect(JSON.stringify(ab.body)).not.toContain(KEY);
    expect(buildRequest({ ...a, baseUrl: "http://127.0.0.1:18001" }, undefined, "m", msgs, tools).url).toBe("http://127.0.0.1:18001/v1/messages");
    expect(buildRequest({ provider: "anthropic", key: KEY, gateway: { id: "g", accountId: "acc1" } }, creds, "m", msgs, tools).url).toBe("https://gateway.ai.cloudflare.com/v1/acc1/g/anthropic/v1/messages");
  });
  it("replies from OpenAI and Anthropic parse to the same tool calls", () => {
    const oa = parseReply(normalizeReply({ provider: "openai" }, { choices: [{ message: { content: null, tool_calls: [{ function: { name: "doctor", arguments: "{}" } }] } }], usage: { prompt_tokens: 7, completion_tokens: 2 } }));
    expect(oa.calls).toEqual([{ name: "doctor", args: {} }]); expect(oa.promptTokens).toBe(7);
    const an = parseReply(normalizeReply({ provider: "anthropic" }, { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "generate_page", input: { name: "about" } }], usage: { input_tokens: 9, output_tokens: 3 } }));
    expect(an.calls).toEqual([{ name: "generate_page", args: { name: "about" } }]); expect(an.text).toBe("ok"); expect(an.completionTokens).toBe(3);
  });
  it("callModel through a route: the key reaches only the header; errors and describeRoute never contain it", async () => {
    const route: Route = { provider: "anthropic", key: KEY, gateway: { id: "g", accountId: "acc1" } };
    let seen: { url: string; headers: Record<string, string>; body: string } | undefined;
    const ok: Fetch = async (url, i) => { seen = { url, headers: i.headers, body: i.body }; return { ok: true, status: 200, json: async () => ({ content: [{ type: "tool_use", name: "doctor", input: {} }], usage: {} }) }; };
    const r = await callModel(creds, "claude-x", msgs, ok, route);
    expect(r.calls[0].name).toBe("doctor"); expect(seen!.url).toContain("/anthropic/v1/messages"); expect(seen!.body).not.toContain(KEY);
    // a provider that echoes the key back in its error: scrubbed
    const bad: Fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: `invalid x-api-key ${KEY}` } }) });
    const e = await callModel(creds, "claude-x", msgs, bad, route).catch((x) => x as Error);
    expect(e.message).not.toContain(KEY); expect(e.message).toContain("[REDACTED]");
    expect(errorText(route, { error: "boom" }, 500)).toBe("boom");
    expect(describeRoute(route, "claude-x")).not.toContain(KEY); expect(describeRoute(route, "claude-x")).toMatch(/via your AI Gateway "g"/);
    const unauth: Fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(callModel(creds, "m", msgs, unauth, route)).rejects.toMatchObject({ kind: "auth" });
  });
  it("no silent provider switch: a provider failure is reported and exactly one request is made", async () => {
    const d = mkdtempSync(join(tmpdir(), "cfl-prov-")); mkdirSync(join(d, "app/routes"), { recursive: true }); writeFileSync(join(d, "package.json"), "{}");
    const hosts: string[] = [], out: string[] = [];
    const f: Fetch = async (url) => { hosts.push(new URL(url).host); return { ok: false, status: 429, json: async () => ({}) }; };
    process.env.CFL_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cfl-cfg-"));
    const r = await ask({ text: "check my project", env: { dir: d } as ToolEnv, creds, acceptTerms: true, fetch: f, route: { provider: "openai", key: KEY }, model: "gpt-x", log: (m) => out.push(m) });
    expect(r.status).toBe("backend-error"); expect(hosts).toEqual(["api.openai.com"]);
    expect(out.join("\n")).toMatch(/no other provider was tried/); expect(out.join("\n")).not.toContain(KEY);
    delete process.env.CFL_CONFIG_DIR;
  });
  it("consent is per provider: a BYO provider asks again, and its notice names the key and the gateway", () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(["anthropic", "openai", "workers-ai"]);
    const n = noticeText("openai").join("\n"); expect(n).toMatch(/OPENAI_API_KEY/); expect(n).toContain(PROVIDERS.openai.termsUrl);
    expect(noticeText("workers-ai").join("\n")).toMatch(/CLOUDFLARE_API_TOKEN/);
  });
});
