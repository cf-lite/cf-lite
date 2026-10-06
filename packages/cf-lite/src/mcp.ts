/**
 * `cfl mcp`: a Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0) that exposes the tool surface
 * (src/tools.ts, docs/llm.md). Local only, no network, no dependency: the three methods an agent needs are
 * initialize, tools/list and tools/call. The agent's harness owns confirmation; every tool also takes `dryRun`.
 * Scope is the directory the server was started in; there is no argument that can point elsewhere.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { TOOLS, runTool, type ToolEnv } from "./tools.js";

interface Rpc { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
type Reply = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } } | null;

export const MCP_VERSION = "2025-06-18";

export async function handleMcp(env: ToolEnv, msg: Rpc, version: string): Promise<Reply> {
  const id = msg.id ?? null;
  const ok = (result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (msg.id === undefined) return null; // notification (initialized, cancelled, ...): no reply
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : MCP_VERSION, capabilities: { tools: {} }, serverInfo: { name: "cf-lite", version } });
    case "ping": return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !t.mutating, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });
    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string") return err(-32602, "params.name is required");
      const r = await runTool(env, name, msg.params?.arguments ?? {});
      return ok({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: !r.ok });
    }
    default: return err(-32601, `method not found: ${msg.method}`);
  }
}

/** Serve until the input closes. Malformed lines get a parse error; a handler crash becomes an internal error, never a dead server. */
export function serveMcp(env: ToolEnv, version: string, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const rl = createInterface({ input });
  const pending: Promise<void>[] = [];
  const send = (r: Reply) => { if (r) output.write(JSON.stringify(r) + "\n"); };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
    pending.push(handleMcp(env, msg, version).then(send, (e) => send({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message: (e as Error).message } })));
  });
  return new Promise((res) => rl.on("close", () => { void Promise.all(pending).then(() => res()); }));
}
