/**
 * Queues helpers (docs/background-jobs.md): `defineQueue` (per-message retry/backoff/dead handling), `dispatchQueue` (the generated
 * multiplexer) and `queueProducer` (behind the generated typed `queues.<name>`). Nothing here imports `cloudflare:workers`.
 */
export type QueueBatchHandler<B = unknown> = (batch: MessageBatch<B>, env: any, ctx: ExecutionContext) => void | Promise<void>;

/** Anything with `.parse()` (zod, valibot's `parse` wrapper, ...): validated on `send`, and its output type types the producer. */
export interface SchemaLike<T = unknown> { parse(input: unknown): T; _output?: T }
export type SchemaOutput<S> = S extends { parse(input: unknown): infer T } ? T : unknown;

export interface RetryOptions { base?: number; factor?: number; max?: number }
/** Exponential retry delay in seconds for `msg.attempts` (1-based): `base * factor^(attempts-1)`, capped at `max` (default 30, 2, 3600). */
export const backoff = ({ base = 30, factor = 2, max = 3600 }: RetryOptions = {}) => (attempts: number) => Math.min(max, Math.round(base * factor ** Math.max(0, attempts - 1)));

export interface DefineQueue<B> {
  /** Handle one message; throw to retry it (others in the batch are unaffected). */
  each?(body: B, msg: Message<B>, env: any, ctx: ExecutionContext): void | Promise<void>;
  /** Handle the whole batch yourself (use instead of `each`). Thrown error = Cloudflare retries the entire batch. */
  batch?: QueueBatchHandler<B>;
  /** Seconds to wait before a failed message is redelivered; a function of `msg.attempts`. Default: Cloudflare's own (immediate). */
  retryDelay?: number | ((attempts: number) => number);
  /** After this many attempts stop retrying: call `onDead`, then ack (so Cloudflare's `max_retries`/DLQ never sees it). Default: never (let the consumer's `max_retries` + `dead_letter_queue` decide). */
  maxAttempts?: number;
  onDead?(body: B, msg: Message<B>, error: unknown, env: any, ctx: ExecutionContext): void | Promise<void>;
}

export function defineQueue<B = unknown>(opts: DefineQueue<B>): QueueBatchHandler<B> {
  if (!opts.each && !opts.batch) throw new Error("defineQueue: give `each` or `batch`");
  return async (batch, env, ctx) => {
    if (opts.batch) return opts.batch(batch, env, ctx);
    for (const msg of batch.messages) {
      try {
        await opts.each!(msg.body, msg, env, ctx);
        msg.ack();
      } catch (error) {
        if (opts.maxAttempts !== undefined && msg.attempts >= opts.maxAttempts) {
          try { await opts.onDead?.(msg.body, msg, error, env, ctx); } catch (e) { console.error(`[cf-lite] queue "${batch.queue}" onDead failed:`, e); }
          msg.ack();
          continue;
        }
        console.error(`[cf-lite] queue "${batch.queue}" message ${msg.id} failed (attempt ${msg.attempts}):`, error);
        const d = typeof opts.retryDelay === "function" ? opts.retryDelay(msg.attempts) : opts.retryDelay;
        msg.retry(d === undefined ? undefined : { delaySeconds: d });
      }
    }
  };
}

/** The generated `queue()` handler: pick the consumer by `batch.queue`. An unknown queue throws (Cloudflare retries/dead-letters). */
export async function dispatchQueue(table: Record<string, QueueBatchHandler<any>>, batch: MessageBatch<any>, env: unknown, ctx: ExecutionContext): Promise<void> {
  const h = table[batch.queue];
  if (!h) throw new Error(`[cf-lite] no server/queues file handles queue "${batch.queue}" (known: ${Object.keys(table).join(", ") || "none"})`);
  await h(batch, env, ctx);
}

export interface QueueProducer<B> {
  send(body: B, opts?: { delaySeconds?: number; contentType?: QueuesContentType }): Promise<void>;
  sendBatch(bodies: Iterable<B>, opts?: { delaySeconds?: number }): Promise<void>;
}
type QueuesContentType = "text" | "bytes" | "json" | "v8";

/** Max messages per `sendBatch` call (Cloudflare limit, *verify*); larger iterables are chunked. */
export const SEND_BATCH_LIMIT = 100;

export function queueProducer<B = unknown>(get: () => Queue<any> | undefined, schema?: SchemaLike<B>): QueueProducer<B> {
  const q = () => {
    const v = get();
    if (!v) throw new Error("[cf-lite] queue producer binding is missing - add it to wrangler `queues.producers` (cf-lite add queue <name>)");
    return v;
  };
  const check = (b: B) => (schema ? schema.parse(b) : b);
  return {
    async send(body, opts) { await q().send(check(body), opts); },
    async sendBatch(bodies, opts) {
      const all = [...bodies].map((b) => ({ body: check(b) }));
      for (let i = 0; i < all.length; i += SEND_BATCH_LIMIT) await q().sendBatch(all.slice(i, i + SEND_BATCH_LIMIT), opts);
    },
  };
}
