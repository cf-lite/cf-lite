import { Hono } from "hono";
import { rateLimit } from "cf-lite/modules/ratelimit";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** POST /api/chat { messages: [{role, content}] } -> text/event-stream straight from Workers AI. */
export default new Hono<{ Bindings: Env }>().post("/", rateLimit({ limit: 10, period: 60 }), async (c) => {
  const body = await c.req.json<{ messages?: Array<{ role: string; content: string }> }>().catch(() => ({ messages: undefined }));
  const messages = body.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > 40 || messages.some((m) => typeof m?.content !== "string" || m.content.length > 4000)) return c.json({ error: "messages required" }, 400);
  const stream = await c.env.AI.run(MODEL, { messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })), stream: true });
  return new Response(stream as unknown as ReadableStream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
});
