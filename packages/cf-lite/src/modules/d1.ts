/**
 * OPTIONAL module: ~15 lines of sugar over D1, plus the Sessions API helper for read replicas.
 * No ORM, no migrations runner here (use `cf-lite db new|apply|status`, which wraps `wrangler d1 migrations`).
 */
type Queryable = Pick<D1Database, "prepare" | "batch">;

export function d1(db: Queryable) {
  return {
    all: async <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).all<T>()).results,
    first: <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params).first<T>(),
    run: async (sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).run()).meta,
    batch: (stmts: [string, ...unknown[]][]) => db.batch(stmts.map(([s, ...p]) => db.prepare(s).bind(...p))),
  };
}

export const D1_BOOKMARK_COOKIE = "cfl-d1-bookmark";
const SAFE_BOOKMARK = /^[A-Za-z0-9._-]{1,256}$/;

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export interface D1SessionOptions {
  /** Cookie carrying the bookmark between requests (default `cfl-d1-bookmark`). */
  cookie?: string;
  /** First request of a visitor: `first-unconstrained` (nearest replica, default) or `first-primary` (strongest). */
  constraint?: "first-unconstrained" | "first-primary";
  /** Bookmark lifetime in seconds (default 3600). */
  maxAge?: number;
}

/**
 * D1 Sessions (sequential consistency over read replicas): reads in one visitor's requests never go back in time.
 * Start a session from the request's bookmark cookie, query via `session.db`, then `session.commit(response)` to
 * store the latest bookmark. Only call `commit` when the response is not cached publicly (it sets a cookie).
 *
 *     const s = d1Session(env.DB, request);
 *     const rows = await d1(s.db).all("select * from posts");
 *     return s.commit(Response.json(rows));
 */
export function d1Session(db: Pick<D1Database, "withSession">, request: Request, opts: D1SessionOptions = {}) {
  const name = opts.cookie ?? D1_BOOKMARK_COOKIE;
  const incoming = request.headers.get("x-d1-bookmark") ?? readCookie(request.headers.get("cookie"), name);
  const bookmark = incoming && SAFE_BOOKMARK.test(incoming) ? incoming : undefined; // never trust client bytes into a header
  const session = db.withSession(bookmark ?? opts.constraint ?? "first-unconstrained");
  return {
    db: session,
    bookmark,
    /** Returns a response carrying the session's latest bookmark (`Set-Cookie` + `x-d1-bookmark`). */
    commit(res: Response): Response {
      const next = session.getBookmark();
      if (!next || next === bookmark) return res;
      const out = new Response(res.body, res);
      out.headers.append("set-cookie", `${name}=${next}; Path=/; Max-Age=${opts.maxAge ?? 3600}; HttpOnly; Secure; SameSite=Lax`);
      out.headers.set("x-d1-bookmark", next);
      return out;
    },
  };
}
