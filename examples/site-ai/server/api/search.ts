// RAG sketch: GET /api/search?q=...  -> embed the query with Workers AI, query Vectorize. Needs a VECTORS binding (optional; 503 without it).
// Index documents with:  PUT /api/search/:id  { text }   (chunk long texts with chunkText() first)
import { Hono } from "hono";
import { vectors } from "cf-lite/modules/vectors";
import { chunkText } from "cf-lite/modules/ai";

export default new Hono<{ Bindings: Env }>()
  .get("/", async (c) => {
    if (!c.env.VECTORS) return c.json({ error: "VECTORS binding not configured" }, 503);
    const q = c.req.query("q")?.slice(0, 500);
    if (!q) return c.json({ error: "q required" }, 400);
    const hits = await vectors(c.env.VECTORS, { ai: c.env }).queryText(q, { topK: 5, returnMetadata: "all" });
    return c.json(hits.map((h) => ({ id: h.id, score: h.score, text: h.metadata?.text })));
  })
  .put("/:id", async (c) => {
    if (!c.env.VECTORS) return c.json({ error: "VECTORS binding not configured" }, 503);
    const { text } = (await c.req.json().catch(() => ({}))) as { text?: string };
    if (!text || text.length > 100_000) return c.json({ error: "text required (<= 100000 chars)" }, 400);
    const id = c.req.param("id");
    const chunks = chunkText(text, { size: 800, overlap: 80 });
    const r = await vectors(c.env.VECTORS, { ai: c.env }).upsertTexts(chunks.map((ch) => ({ id: `${id}:${ch.index}`, text: ch.text, metadata: { doc: id, start: ch.start } })));
    return c.json({ chunks: r.count });
  });
