/**
 * OPTIONAL module: per-request client for external Postgres/MySQL through Hyperdrive.
 *
 * Hyperdrive pools connections at the edge, so the Worker opens one short-lived client per request and must close it.
 * Closing inline would add a round trip to the response; this helper closes in `ctx.waitUntil` instead, on success
 * AND on error, so a thrown query never leaks the connection. Bring your own driver (`postgres`, `pg`, `mysql2`):
 *
 *     const rows = await withHyperdrive(env.HYPERDRIVE, ctx, (url) => postgres(url, { max: 1 }), (sql) => sql`select 1`);
 */
export interface Closeable { end(): unknown | Promise<unknown> }
export interface HyperdriveLike { connectionString: string }
export interface WaitUntil { waitUntil(p: Promise<unknown>): void }

export async function withHyperdrive<C extends Closeable, R>(
  binding: HyperdriveLike,
  ctx: WaitUntil,
  connect: (connectionString: string) => C | Promise<C>,
  fn: (client: C) => R | Promise<R>,
): Promise<R> {
  if (!binding?.connectionString) throw new Error("hyperdrive: binding has no connectionString (local dev: set CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>)");
  const client = await connect(binding.connectionString);
  try {
    return await fn(client);
  } finally {
    // never let a failing close mask the result or the original error
    ctx.waitUntil(Promise.resolve().then(() => client.end()).catch(() => {}));
  }
}

/** Manual form for handlers that need the client across several steps: `const { client, close } = await hyperdrive(...)`. */
export async function hyperdrive<C extends Closeable>(binding: HyperdriveLike, ctx: WaitUntil, connect: (connectionString: string) => C | Promise<C>) {
  if (!binding?.connectionString) throw new Error("hyperdrive: binding has no connectionString");
  const client = await connect(binding.connectionString);
  let closed = false;
  return { client, close: () => { if (closed) return; closed = true; ctx.waitUntil(Promise.resolve().then(() => client.end()).catch(() => {})); } };
}
