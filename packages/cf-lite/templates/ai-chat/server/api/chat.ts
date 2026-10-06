// Added by `cf-lite add ai-chat`. POST /api/chat  { messages: [{ role, content }] }  ->  text/event-stream (see cf-lite/modules/ai).
// Set AI_GATEWAY_ID (wrangler var) to route through AI Gateway: caching, rate limits, logs, fallbacks.
import { Hono } from "hono";
import { csrf } from "cf-lite/modules/csrf";
import { AiError, createAI, sseResponse, type ChatMessage } from "cf-lite/modules/ai";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const SYSTEM: ChatMessage = { role: "system", content: "You are a concise, helpful assistant." };
const MAX_MESSAGES = 20, MAX_CHARS = 4000;

export default new Hono<{ Bindings: Env }>()
  .use("*", csrf({ contentTypes: ["application/json"] }))
  .post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { messages?: ChatMessage[] } | null;
    const messages = body?.messages;
    const valid = Array.isArray(messages) && messages.length > 0 && messages.length <= MAX_MESSAGES
      && messages.every((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.length <= MAX_CHARS);
    if (!valid) return c.json({ error: "messages: 1-" + MAX_MESSAGES + " of { role: user|assistant, content: string <= " + MAX_CHARS + " chars }" }, 400);
    try {
      // Add a userId (from your session) to give each user their own gateway cache entries: createAI(c.env, { userId })
      const stream = await createAI(c.env).stream(MODEL, [SYSTEM, ...messages]);
      return sseResponse(stream);
    } catch (e) {
      if (e instanceof AiError && e.code === "no-binding") return c.json({ error: "AI binding not configured" }, 503);
      console.error("[ai-chat]", e);
      return c.json({ error: "model unavailable" }, 502);
    }
  });
