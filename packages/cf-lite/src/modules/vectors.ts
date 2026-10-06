/**
 * OPTIONAL module (EXPERIMENTAL at 1.0; only bundled when imported): Vectorize helper with batching and text-in convenience.
 *
 *   import { vectors } from "cf-lite/modules/vectors";
 *   const docs = vectors(env.VECTORS, { ai: env });              // `ai` only needed for the *Text methods
 *   await docs.upsertTexts([{ id: "a", text: "...", metadata: { url } }]);
 *   const hits = await docs.queryText("how do I deploy?", { topK: 5 });
 *
 * Limits are enforced client-side with a clear error instead of a Vectorize 400 (numbers marked *(verify)* in docs/ai.md:
 * ids <= 64 bytes, metadata <= 10 KiB per vector, upsert batch 1000 via the Workers binding, topK <= 100).
 */
import { createAI, type AiEnv, type EmbedOptions } from "./ai.js";

export interface VectorizeVector { id: string; values: ArrayLike<number>; namespace?: string; metadata?: Record<string, unknown> }
export interface VectorizeMatch { id: string; score: number; values?: ArrayLike<number>; namespace?: string; metadata?: Record<string, unknown> }
/** Slice of the `VectorizeIndex` binding used here (the real binding is assignable; so is a fake). */
export interface VectorizeLike {
  upsert(v: VectorizeVector[]): Promise<{ mutationId?: string; ids?: string[]; count?: number }>;
  query(vector: number[] | Float32Array, o?: Record<string, unknown>): Promise<{ matches: VectorizeMatch[]; count?: number }>;
  deleteByIds(ids: string[]): Promise<{ mutationId?: string; ids?: string[]; count?: number }>;
  getByIds(ids: string[]): Promise<VectorizeVector[]>;
}

export const LIMITS = { upsertBatch: 1000, idBytes: 64, metadataBytes: 10 * 1024, topK: 100, deleteBatch: 1000, getBatch: 20 } as const;

export interface VectorsOptions {
  namespace?: string;
  /** Env holding the `AI` binding; enables `upsertTexts` / `queryText`. */
  ai?: AiEnv;
  embed?: EmbedOptions;
  /** Override the upsert batch size (<= LIMITS.upsertBatch). */
  batchSize?: number;
}
export interface QueryOptions { topK?: number; namespace?: string; filter?: Record<string, unknown>; returnValues?: boolean; returnMetadata?: "none" | "indexed" | "all" | boolean }
export interface UpsertResult { count: number; batches: number; mutationIds: string[] }

const bytes = (s: string) => new TextEncoder().encode(s).length;

export class VectorsError extends Error { constructor(message: string) { super(message); this.name = "VectorsError"; } }

function validate(items: VectorizeVector[], dim?: number): number {
  let d = dim ?? -1;
  const seen = new Set<string>();
  for (const v of items) {
    if (!v.id || bytes(v.id) > LIMITS.idBytes) throw new VectorsError(`vector id must be 1-${LIMITS.idBytes} bytes (got ${v.id ? bytes(v.id) : 0})`);
    if (seen.has(v.id)) throw new VectorsError(`duplicate id "${v.id}" in one upsert`);
    seen.add(v.id);
    if (d < 0) d = v.values.length;
    if (v.values.length !== d || d === 0) throw new VectorsError(`vector "${v.id}" has ${v.values.length} dimensions, expected ${d}`);
    if (v.metadata && bytes(JSON.stringify(v.metadata)) > LIMITS.metadataBytes) throw new VectorsError(`metadata of "${v.id}" exceeds ${LIMITS.metadataBytes} bytes`);
  }
  return d;
}

export function vectors(index: VectorizeLike, opts: VectorsOptions = {}) {
  const batchSize = Math.min(opts.batchSize ?? LIMITS.upsertBatch, LIMITS.upsertBatch);
  const ai = () => { if (!opts.ai) throw new VectorsError("vectors(): pass { ai: env } to use the text methods"); return createAI(opts.ai); };

  async function upsert(items: VectorizeVector[]): Promise<UpsertResult> {
    validate(items); // whole input first: a bad vector must not leave half a corpus written
    const mutationIds: string[] = []; let batches = 0;
    for (let i = 0; i < items.length; i += batchSize) {
      const r = await index.upsert(items.slice(i, i + batchSize).map((v) => ({ ...v, namespace: v.namespace ?? opts.namespace })));
      if (r.mutationId) mutationIds.push(r.mutationId);
      batches++;
    }
    return { count: items.length, batches, mutationIds };
  }
  async function query(vector: number[] | Float32Array, q: QueryOptions = {}): Promise<VectorizeMatch[]> {
    const topK = q.topK ?? 10;
    if (!Number.isInteger(topK) || topK < 1 || topK > LIMITS.topK) throw new VectorsError(`topK must be an integer 1-${LIMITS.topK}`);
    const meta = q.returnMetadata === true ? "all" : q.returnMetadata === false || q.returnMetadata === undefined ? "none" : q.returnMetadata;
    const r = await index.query(vector, { topK, namespace: q.namespace ?? opts.namespace, filter: q.filter, returnValues: q.returnValues ?? false, returnMetadata: meta });
    return r.matches;
  }
  return {
    upsert,
    query,
    /** Embed `text` of each item (batched) and upsert; metadata gets `text` unless `storeText: false`. */
    async upsertTexts(items: { id: string; text: string; metadata?: Record<string, unknown> }[], o: { storeText?: boolean } = {}): Promise<UpsertResult> {
      const vecs = await ai().embed(items.map((i) => i.text), opts.embed);
      return upsert(items.map((it, n) => ({ id: it.id, values: vecs[n], metadata: o.storeText === false ? it.metadata : { ...it.metadata, text: it.text } })));
    },
    async queryText(text: string, q: QueryOptions = {}): Promise<VectorizeMatch[]> {
      const [v] = await ai().embed([text], opts.embed);
      return query(v, q);
    },
    async deleteByIds(ids: string[]): Promise<number> {
      for (let i = 0; i < ids.length; i += LIMITS.deleteBatch) await index.deleteByIds(ids.slice(i, i + LIMITS.deleteBatch));
      return ids.length;
    },
    async getByIds(ids: string[]): Promise<VectorizeVector[]> {
      const out: VectorizeVector[] = [];
      for (let i = 0; i < ids.length; i += LIMITS.getBatch) out.push(...(await index.getByIds(ids.slice(i, i + LIMITS.getBatch))));
      return out;
    },
  };
}
